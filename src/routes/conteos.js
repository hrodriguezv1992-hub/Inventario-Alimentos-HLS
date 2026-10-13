// Conteos físicos desde el teléfono (a ciegas) y su revisión por el supervisor
const express = require('express');
const { pool, tx, log } = require('../db');
const { requireRol, sucursalesPermitidas, puedeSucursal } = require('../auth');
const { syncSucursal } = require('../sync');

const r = express.Router();
const err = (status, msg) => Object.assign(new Error(msg), { status });
const REVISORES = ['admin', 'supervisor'];
const esEmpleado = u => u.rol === 'empleado';
const prods = n => `${n} producto${n === 1 ? '' : 's'}`;

async function evento(c, conteoId, tipo, detalle, userId) {
  await c.query('INSERT INTO conteo_eventos (conteo_id,tipo,detalle,usuario_id) VALUES ($1,$2,$3,$4)', [conteoId, tipo, detalle, userId]);
}

// El empleado nunca recibe la existencia de Wansoft ni las diferencias
function ocultarSistema(conteo) {
  for (const l of conteo.lineas || []) { delete l.existencia_sistema; delete l.costo; }
  delete conteo.impacto; delete conteo.con_diferencia;
  return conteo;
}

// Antes de comparar, intenta traer el inventario más reciente de Wansoft (máx. 20 s)
async function refrescarSucursal(sucursalId) {
  const { rows } = await pool.query('SELECT * FROM sucursales WHERE id=$1', [sucursalId]);
  if (!rows[0]?.wansoft_id || !rows[0]?.wansoft_pwd_enc) return;
  await Promise.race([syncSucursal(rows[0]), new Promise(res => setTimeout(res, 20000))]).catch(() => {});
}

// Toma la existencia y el costo actuales para las líneas indicadas
async function fotoSistema(c, conteoId, sucursalId, soloCodigos = null) {
  await c.query(`
    UPDATE conteo_lineas l SET existencia_sistema = COALESCE(i.existencia, 0),
      costo = COALESCE(NULLIF(i.costo,0), NULLIF(cat.costo_ideal,0))
    FROM conteo_lineas l2
    LEFT JOIN inventario i ON i.sucursal_id = $2 AND i.codigo = l2.codigo
    LEFT JOIN catalogo cat ON cat.codigo = l2.codigo
    WHERE l.id = l2.id AND l.conteo_id = $1 AND ($3::text[] IS NULL OR l.codigo = ANY($3))`,
    [conteoId, sucursalId, soloCodigos]);
  const { rows } = await c.query('SELECT MIN(sincronizado_en) AS t FROM inventario WHERE sucursal_id=$1', [sucursalId]);
  await c.query('UPDATE conteos SET sistema_en=$1 WHERE id=$2', [rows[0].t, conteoId]);
}

function validarLineas(lineas) {
  if (!Array.isArray(lineas) || !lineas.length) throw err(400, 'Captura al menos un producto');
  const vistos = new Set();
  return lineas.filter(l => l && l.codigo != null && l.cantidad !== '' && l.cantidad != null).map(l => {
    const cantidad = Number(l.cantidad);
    if (!Number.isFinite(cantidad) || cantidad < 0) throw err(400, `Revisa la cantidad de ${l.nombre || l.codigo}`);
    const codigo = String(l.codigo);
    if (vistos.has(codigo)) throw err(400, `${l.nombre || codigo} está repetido`);
    vistos.add(codigo);
    return { codigo, cantidad };
  });
}

// ── Productos a contar (sin existencias) ─────────────────────────
r.get('/productos/:sucursal_id', async (req, res) => {
  const suc = Number(req.params.sucursal_id);
  if (!puedeSucursal(req.user, suc)) throw err(403, 'No tienes acceso a esta sucursal');
  const { rows } = await pool.query(`
    WITH cods AS (SELECT codigo FROM catalogo UNION SELECT codigo FROM inventario WHERE sucursal_id=$1)
    SELECT k.codigo, COALESCE(i.nombre, c.nombre) AS nombre, COALESCE(i.unidad, c.unidad) AS unidad,
           COALESCE(i.departamento, c.departamento, 'Sin departamento') AS departamento
    FROM cods k
    LEFT JOIN catalogo c ON c.codigo = k.codigo
    LEFT JOIN inventario i ON i.codigo = k.codigo AND i.sucursal_id = $1
    ORDER BY 4, 2 NULLS LAST`, [suc]);
  res.json(rows);
});

r.get('/departamentos', async (req, res) => {
  const { rows } = await pool.query(`SELECT DISTINCT departamento FROM (
    SELECT departamento FROM catalogo UNION SELECT departamento FROM inventario) d
    WHERE departamento IS NOT NULL AND departamento <> '' ORDER BY 1`);
  res.json(rows.map(r => r.departamento));
});

// ── Lo que le toca contar hoy al usuario ─────────────────────────
r.get('/hoy', async (req, res) => {
  const permit = sucursalesPermitidas(req.user);
  // Día de la semana en hora de México
  const corto = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Mexico_City', weekday: 'short' }).format(new Date());
  const dia = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[corto];
  const { rows: sucs } = await pool.query(
    `SELECT id, nombre FROM sucursales WHERE activa AND ($1::int[] IS NULL OR id = ANY($1)) ORDER BY nombre`, [permit]);
  const { rows: progs } = await pool.query(`
    SELECT * FROM conteo_programas WHERE activo AND (cardinality(dias)=0 OR $1 = ANY(dias)) ORDER BY nombre`, [dia]);
  const { rows: hechos } = await pool.query(`
    SELECT sucursal_id, programa_id FROM conteos
    WHERE programa_id IS NOT NULL AND estado <> 'cancelado'
      AND (enviado_en AT TIME ZONE 'America/Mexico_City')::date = (NOW() AT TIME ZONE 'America/Mexico_City')::date`);
  const hecho = new Set(hechos.map(h => `${h.sucursal_id}|${h.programa_id}`));
  const tareas = [];
  for (const p of progs) for (const s of sucs) {
    if (p.sucursales.length && !p.sucursales.includes(s.id)) continue;
    tareas.push({ programa_id: p.id, nombre: p.nombre, departamentos: p.departamentos, sucursal_id: s.id, sucursal: s.nombre, hecho: hecho.has(`${s.id}|${p.id}`) });
  }
  res.json({ sucursales: sucs, tareas });
});

// ── Programas de conteo cíclico ──────────────────────────────────
r.get('/programas', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM conteo_programas ORDER BY activo DESC, nombre');
  res.json(rows);
});
r.post('/programas', requireRol(...REVISORES), async (req, res) => {
  const { nombre, departamentos = [], dias = [], sucursales = [] } = req.body || {};
  if (!String(nombre || '').trim()) throw err(400, 'Escribe el nombre del conteo');
  const { rows } = await pool.query(
    'INSERT INTO conteo_programas (nombre,departamentos,dias,sucursales) VALUES ($1,$2,$3,$4) RETURNING *',
    [nombre.trim(), departamentos, dias.map(Number), sucursales.map(Number)]);
  await log(req.user.id, 'programa_crear', { nombre });
  res.json(rows[0]);
});
r.put('/programas/:id', requireRol(...REVISORES), async (req, res) => {
  const { nombre, departamentos, dias, sucursales, activo } = req.body || {};
  await pool.query(`UPDATE conteo_programas SET nombre=COALESCE($1,nombre), departamentos=COALESCE($2,departamentos),
      dias=COALESCE($3,dias), sucursales=COALESCE($4,sucursales), activo=COALESCE($5,activo) WHERE id=$6`,
    [nombre?.trim() || null, departamentos || null, dias ? dias.map(Number) : null, sucursales ? sucursales.map(Number) : null, activo ?? null, req.params.id]);
  res.json({ ok: true });
});

// ── Lista y detalle ──────────────────────────────────────────────
r.get('/', async (req, res) => {
  const permit = sucursalesPermitidas(req.user);
  const estado = req.query.estado || null;
  const { rows } = await pool.query(`
    SELECT c.id, c.folio, c.nombre, c.estado, c.enviado_en, c.revisado_en, c.comentario, c.sucursal_id,
           s.nombre AS sucursal, u.nombre AS creado_por_nombre, ur.nombre AS revisado_por_nombre,
           COUNT(l.id)::int AS productos,
           COUNT(l.id) FILTER (WHERE l.recontar)::int AS por_recontar,
           COUNT(l.id) FILTER (WHERE abs(l.cantidad - COALESCE(l.existencia_sistema,0)) > 0.0001)::int AS con_diferencia,
           COALESCE(SUM((l.cantidad - COALESCE(l.existencia_sistema,0)) * COALESCE(l.costo,0)),0) AS impacto
    FROM conteos c
    JOIN sucursales s ON s.id = c.sucursal_id
    LEFT JOIN usuarios u ON u.id = c.creado_por
    LEFT JOIN usuarios ur ON ur.id = c.revisado_por
    LEFT JOIN conteo_lineas l ON l.conteo_id = c.id
    WHERE ($1::text IS NULL OR c.estado = $1)
      AND ($2::int[] IS NULL OR c.sucursal_id = ANY($2))
      AND ($3::int IS NULL OR c.creado_por = $3)
    GROUP BY c.id, s.nombre, u.nombre, ur.nombre
    ORDER BY c.enviado_en DESC LIMIT 200`,
    [estado, permit, esEmpleado(req.user) ? req.user.id : null]);
  res.json(esEmpleado(req.user) ? rows.map(c => ocultarSistema(c)) : rows);
});

async function cargar(id, user) {
  const { rows } = await pool.query(`
    SELECT c.*, s.nombre AS sucursal, u.nombre AS creado_por_nombre, ur.nombre AS revisado_por_nombre
    FROM conteos c JOIN sucursales s ON s.id=c.sucursal_id
    LEFT JOIN usuarios u ON u.id=c.creado_por LEFT JOIN usuarios ur ON ur.id=c.revisado_por
    WHERE c.id=$1`, [id]);
  const c = rows[0];
  if (!c) throw err(404, 'Conteo no encontrado');
  if (!puedeSucursal(user, c.sucursal_id)) throw err(403, 'No tienes acceso a este conteo');
  if (esEmpleado(user) && c.creado_por !== user.id) throw err(403, 'Este conteo lo capturó otra persona');
  return c;
}

r.get('/:id', async (req, res) => {
  const c = await cargar(req.params.id, req.user);
  const [{ rows: lineas }, { rows: eventos }] = await Promise.all([
    pool.query('SELECT * FROM conteo_lineas WHERE conteo_id=$1 ORDER BY departamento NULLS LAST, nombre', [c.id]),
    pool.query(`SELECT e.*, u.nombre AS usuario FROM conteo_eventos e LEFT JOIN usuarios u ON u.id=e.usuario_id
      WHERE conteo_id=$1 ORDER BY e.creado_en, e.id`, [c.id]),
  ]);
  const out = { ...c, lineas, eventos };
  res.json(esEmpleado(req.user) ? ocultarSistema(out) : out);
});

// ── Enviar un conteo desde el teléfono ───────────────────────────
r.post('/', async (req, res) => {
  const { sucursal_id, programa_id, nombre, cliente_id, contado_en } = req.body || {};
  if (!sucursal_id || !puedeSucursal(req.user, sucursal_id)) throw err(403, 'Elige una sucursal a la que tengas acceso');
  if (!['empleado', 'sucursal', 'supervisor', 'admin'].includes(req.user.rol)) throw err(403, 'Tu usuario no puede capturar conteos');
  const lineas = validarLineas(req.body.lineas);
  if (!lineas.length) throw err(400, 'Captura al menos un producto');

  // Reintento del teléfono: regresar el que ya existe
  if (cliente_id) {
    const { rows } = await pool.query('SELECT id, folio FROM conteos WHERE cliente_id=$1', [cliente_id]);
    if (rows[0]) return res.json({ ...rows[0], repetido: true });
  }

  await refrescarSucursal(sucursal_id);
  const out = await tx(async c => {
    const { rows } = await c.query(`
      INSERT INTO conteos (folio, cliente_id, sucursal_id, programa_id, nombre, creado_por, contado_en)
      VALUES ('CT-'||LPAD(nextval('seq_folio_ct')::text,5,'0'), $1,$2,$3,$4,$5,$6) RETURNING id, folio`,
      [cliente_id || null, sucursal_id, programa_id || null, nombre || 'Conteo', req.user.id, contado_en || null]);
    const id = rows[0].id;
    for (const l of lineas) {
      await c.query(`
        INSERT INTO conteo_lineas (conteo_id, codigo, nombre, unidad, departamento, cantidad)
        SELECT $1, $2,
          COALESCE((SELECT nombre FROM inventario WHERE sucursal_id=$4 AND codigo=$2),(SELECT nombre FROM catalogo WHERE codigo=$2)),
          COALESCE((SELECT unidad FROM inventario WHERE sucursal_id=$4 AND codigo=$2),(SELECT unidad FROM catalogo WHERE codigo=$2)),
          COALESCE((SELECT departamento FROM inventario WHERE sucursal_id=$4 AND codigo=$2),(SELECT departamento FROM catalogo WHERE codigo=$2)),
          $3`, [id, l.codigo, l.cantidad, sucursal_id]);
    }
    await fotoSistema(c, id, sucursal_id);
    await evento(c, id, 'enviado', `${prods(lineas.length)} contado${lineas.length === 1 ? '' : 's'}`, req.user.id);
    return rows[0];
  });
  await log(req.user.id, 'conteo_enviar', { folio: out.folio });
  res.json(out);
});

// ── El empleado recuenta lo que le devolvieron ───────────────────
r.post('/:id/recontar', async (req, res) => {
  const c = await cargar(req.params.id, req.user);
  if (c.estado !== 'devuelto') throw err(400, 'Este conteo no está devuelto para recontar');
  const lineas = validarLineas(req.body.lineas);
  await refrescarSucursal(c.sucursal_id);
  await tx(async cx => {
    for (const l of lineas) {
      await cx.query('UPDATE conteo_lineas SET cantidad=$1, recontar=FALSE WHERE conteo_id=$2 AND codigo=$3', [l.cantidad, c.id, l.codigo]);
    }
    await fotoSistema(cx, c.id, c.sucursal_id, lineas.map(l => l.codigo));
    await cx.query(`UPDATE conteos SET estado='enviado', enviado_en=NOW() WHERE id=$1`, [c.id]);
    await evento(cx, c.id, 'recontado', `${prods(lineas.length)} recontado${lineas.length === 1 ? '' : 's'}`, req.user.id);
  });
  await log(req.user.id, 'conteo_recontar', { folio: c.folio });
  res.json({ ok: true });
});

// ── Revisión del supervisor ──────────────────────────────────────
r.post('/:id/aprobar', requireRol(...REVISORES), async (req, res) => {
  const c = await cargar(req.params.id, req.user);
  if (c.estado !== 'enviado') throw err(400, 'Solo se aprueban conteos enviados');
  const out = await tx(async cx => {
    const { rows: ls } = await cx.query(`SELECT * FROM conteo_lineas WHERE conteo_id=$1
      AND abs(cantidad - COALESCE(existencia_sistema,0)) > 0.0001`, [c.id]);
    const folios = [];
    for (const l of ls) {
      const sistema = Number(l.existencia_sistema || 0);
      const { rows } = await cx.query(`
        INSERT INTO ajustes (folio, sucursal_id, codigo, nombre, unidad, existencia_sistema, existencia_fisica, diferencia, costo, motivo, comentario, creado_por, conteo_id)
        VALUES ('AJ-'||LPAD(nextval('seq_folio_aj')::text,5,'0'), $1,$2,$3,$4,$5,$6,$7,$8,'Conteo físico',$9,$10,$11) RETURNING folio`,
        [c.sucursal_id, l.codigo, l.nombre, l.unidad, sistema, l.cantidad, Number(l.cantidad) - sistema, l.costo,
         `${c.folio} · contó ${c.creado_por_nombre || ''}`.trim(), c.creado_por, c.id]);
      folios.push(rows[0].folio);
    }
    await cx.query(`UPDATE conteos SET estado='aprobado', revisado_por=$1, revisado_en=NOW(), comentario=$2 WHERE id=$3`,
      [req.user.id, req.body.comentario || null, c.id]);
    await evento(cx, c.id, 'aprobado', folios.length ? `${folios.length} ajuste${folios.length === 1 ? '' : 's'} generado${folios.length === 1 ? '' : 's'}` : 'Sin diferencias', req.user.id);
    return { ajustes: folios };
  });
  await log(req.user.id, 'conteo_aprobar', { folio: c.folio, folios: out.ajustes });
  res.json(out);
});

r.post('/:id/devolver', requireRol(...REVISORES), async (req, res) => {
  const c = await cargar(req.params.id, req.user);
  if (c.estado !== 'enviado') throw err(400, 'Solo se devuelven conteos enviados');
  const codigos = (req.body.codigos || []).map(String);
  if (!codigos.length) throw err(400, 'Marca los productos que deben recontar');
  await tx(async cx => {
    await cx.query('UPDATE conteo_lineas SET recontar = (codigo = ANY($2)) WHERE conteo_id=$1', [c.id, codigos]);
    await cx.query(`UPDATE conteos SET estado='devuelto', revisado_por=$1, revisado_en=NOW(), comentario=$2 WHERE id=$3`,
      [req.user.id, req.body.comentario || null, c.id]);
    await evento(cx, c.id, 'devuelto', `${prods(codigos.length)} por recontar${req.body.comentario ? ': ' + req.body.comentario : ''}`, req.user.id);
  });
  await log(req.user.id, 'conteo_devolver', { folio: c.folio });
  res.json({ ok: true });
});

r.post('/:id/cancelar', requireRol(...REVISORES), async (req, res) => {
  const c = await cargar(req.params.id, req.user);
  if (['aprobado', 'cancelado'].includes(c.estado)) throw err(400, 'Este conteo ya está cerrado');
  await tx(async cx => {
    await cx.query(`UPDATE conteos SET estado='cancelado', revisado_por=$1, revisado_en=NOW(), comentario=$2 WHERE id=$3`,
      [req.user.id, req.body.comentario || null, c.id]);
    await evento(cx, c.id, 'cancelado', req.body.comentario || null, req.user.id);
  });
  res.json({ ok: true });
});

module.exports = r;
