const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, log } = require('./db');

const SECRET = () => {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 24) throw new Error('Falta JWT_SECRET (mínimo 24 caracteres)');
  return s;
};

// Límite simple de intentos de login por IP+usuario
const intentos = new Map();
function bloqueado(k) {
  const r = intentos.get(k);
  return r && r.n >= 8 && Date.now() - r.t < 15 * 60 * 1000;
}
function fallo(k) {
  const r = intentos.get(k);
  if (!r || Date.now() - r.t > 15 * 60 * 1000) intentos.set(k, { n: 1, t: Date.now() });
  else r.n++;
}

function publico(u) {
  return { id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol, sucursales: u.sucursales || [], activo: u.activo };
}

async function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Inicia sesión para continuar' });
  try {
    const p = jwt.verify(token, SECRET());
    const { rows } = await pool.query('SELECT * FROM usuarios WHERE id=$1 AND activo', [p.id]);
    if (!rows[0]) return res.status(401).json({ error: 'Tu usuario está desactivado' });
    req.user = publico(rows[0]);
    next();
  } catch {
    res.status(401).json({ error: 'Tu sesión expiró, vuelve a iniciar sesión' });
  }
}

const requireRol = (...roles) => (req, res, next) =>
  roles.includes(req.user.rol) ? next() : res.status(403).json({ error: 'No tienes permiso para esta acción' });

// ¿Puede el usuario ver/operar esta sucursal?
const ROLES_ACOTADOS = ['sucursal', 'supervisor', 'empleado'];
function puedeSucursal(user, sucursalId) {
  if (!ROLES_ACOTADOS.includes(user.rol)) return true;
  return (user.sucursales || []).includes(Number(sucursalId));
}
// Filtro SQL para listar solo sus sucursales: devuelve null si ve todas
function sucursalesPermitidas(user) {
  return ROLES_ACOTADOS.includes(user.rol) ? (user.sucursales || []) : null;
}

const router = express.Router();

router.post('/login', async (req, res) => {
  const { usuario, password } = req.body || {};
  const k = `${req.ip}|${String(usuario || '').toLowerCase()}`;
  if (bloqueado(k)) return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
  const { rows } = await pool.query('SELECT * FROM usuarios WHERE lower(usuario)=lower($1)', [usuario || '']);
  const u = rows[0];
  if (!u || !u.activo || !(await bcrypt.compare(password || '', u.password_hash))) {
    fallo(k);
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  intentos.delete(k);
  const token = jwt.sign({ id: u.id }, SECRET(), { expiresIn: '10h' });
  await log(u.id, 'login', null);
  res.json({ token, user: publico(u) });
});

router.get('/me', requireAuth, (req, res) => res.json(req.user));

router.post('/cambiar-password', requireAuth, async (req, res) => {
  const { actual, nueva } = req.body || {};
  if (!nueva || nueva.length < 8) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
  const { rows } = await pool.query('SELECT password_hash FROM usuarios WHERE id=$1', [req.user.id]);
  if (!(await bcrypt.compare(actual || '', rows[0].password_hash))) return res.status(400).json({ error: 'La contraseña actual no es correcta' });
  await pool.query('UPDATE usuarios SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(nueva, 10), req.user.id]);
  await log(req.user.id, 'cambiar_password', null);
  res.json({ ok: true });
});

// Crea el primer administrador si la tabla está vacía
async function asegurarAdmin() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM usuarios');
  if (rows[0].n > 0) {
    // Si el admin se creó antes de configurar ADMIN_PASSWORD y nunca ha entrado,
    // se le asigna la contraseña de la variable.
    if (process.env.ADMIN_PASSWORD) {
      const r = await pool.query(`
        UPDATE usuarios SET password_hash=$1
        WHERE usuario='admin' AND NOT EXISTS (
          SELECT 1 FROM bitacora b WHERE b.usuario_id=usuarios.id AND b.accion='login')
        RETURNING id`, [await bcrypt.hash(process.env.ADMIN_PASSWORD, 10)]);
      if (r.rowCount) console.log('Contraseña de admin tomada de ADMIN_PASSWORD');
    }
    return;
  }
  let pwd = process.env.ADMIN_PASSWORD;
  if (!pwd) {
    pwd = require('crypto').randomBytes(9).toString('base64url');
    console.log(`\n*** Usuario inicial: admin / ${pwd}  (cámbiala al entrar) ***\n`);
  }
  await pool.query(
    `INSERT INTO usuarios (nombre, usuario, password_hash, rol) VALUES ('Administrador','admin',$1,'admin')`,
    [await bcrypt.hash(pwd, 10)]);
}

module.exports = { router, requireAuth, requireRol, puedeSucursal, sucursalesPermitidas, asegurarAdmin, publico };
