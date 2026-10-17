// Proveedores, usuarios y bitácora
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, log, tx, setConfig } = require('../db');
const { requireRol, publico } = require('../auth');

const r = express.Router();

// ── Proveedores ─────────────────────────────────────────────
r.get('/proveedores', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM proveedores ORDER BY activo DESC, nombre');
  res.json(rows);
});
r.post('/proveedores', requireRol('admin', 'compras'), async (req, res) => {
  const { nombre, contacto, telefono, email } = req.body || {};
  if (!String(nombre || '').trim()) return res.status(400).json({ error: 'Escribe el nombre del proveedor' });
  const { rows } = await pool.query(
    'INSERT INTO proveedores (nombre,contacto,telefono,email) VALUES ($1,$2,$3,$4) RETURNING *',
    [nombre.trim(), contacto || null, telefono || null, email || null]);
  await log(req.user.id, 'proveedor_crear', { nombre });
  res.json(rows[0]);
});
r.put('/proveedores/:id', requireRol('admin', 'compras'), async (req, res) => {
  const { nombre, contacto, telefono, email, activo } = req.body || {};
  await pool.query(`UPDATE proveedores SET nombre=COALESCE($1,nombre), contacto=$2, telefono=$3, email=$4, activo=COALESCE($5,activo) WHERE id=$6`,
    [nombre?.trim() || null, contacto || null, telefono || null, email || null, activo ?? null, req.params.id]);
  res.json({ ok: true });
});

// ── Usuarios ────────────────────────────────────────────────
r.get('/usuarios', requireRol('admin'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM usuarios ORDER BY activo DESC, nombre');
  res.json(rows.map(publico));
});
r.post('/usuarios', requireRol('admin'), async (req, res) => {
  const { nombre, usuario, password, rol, sucursales } = req.body || {};
  if (!nombre || !usuario) return res.status(400).json({ error: 'Escribe nombre y usuario' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO usuarios (nombre,usuario,password_hash,rol,sucursales) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [nombre.trim(), usuario.trim(), await bcrypt.hash(password, 10), rol || 'sucursal', (sucursales || []).map(Number)]);
    await log(req.user.id, 'usuario_crear', { usuario });
    res.json(publico(rows[0]));
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ese nombre de usuario ya existe' });
    throw e;
  }
});
r.put('/usuarios/:id', requireRol('admin'), async (req, res) => {
  const { nombre, rol, sucursales, activo, password } = req.body || {};
  if (Number(req.params.id) === req.user.id && (activo === false || (rol && rol !== 'admin'))) {
    return res.status(400).json({ error: 'No puedes quitarte el acceso de administrador a ti mismo' });
  }
  if (password && password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  await pool.query(`UPDATE usuarios SET nombre=COALESCE($1,nombre), rol=COALESCE($2,rol),
      sucursales=COALESCE($3,sucursales), activo=COALESCE($4,activo),
      password_hash=COALESCE($5,password_hash) WHERE id=$6`,
    [nombre || null, rol || null, sucursales ? sucursales.map(Number) : null, activo ?? null,
     password ? await bcrypt.hash(password, 10) : null, req.params.id]);
  await log(req.user.id, 'usuario_editar', { id: Number(req.params.id), rol, activo, cambio_password: !!password });
  res.json({ ok: true });
});

// ── Grupos de sucursales ────────────────────────────────────
// Recibe la lista completa [{ nombre, anterior }]: renombra, reordena y quita
r.put('/grupos', requireRol('admin'), async (req, res) => {
  const lista = (req.body?.grupos || []).map(g => ({ nombre: String(g.nombre || '').trim(), anterior: g.anterior || null })).filter(g => g.nombre);
  const nombres = lista.map(g => g.nombre.toLowerCase());
  if (new Set(nombres).size !== nombres.length) return res.status(400).json({ error: 'Hay dos grupos con el mismo nombre' });
  if (nombres.includes('sin grupo')) return res.status(400).json({ error: '"Sin grupo" es un nombre reservado' });
  await tx(async c => {
    // Primero a nombres temporales para permitir intercambios (A→B, B→A)
    for (const [i, g] of lista.entries()) if (g.anterior && g.anterior !== g.nombre) await c.query('UPDATE sucursales SET grupo=$1 WHERE grupo=$2', [`__tmp${i}`, g.anterior]);
    for (const [i, g] of lista.entries()) if (g.anterior && g.anterior !== g.nombre) await c.query('UPDATE sucursales SET grupo=$1 WHERE grupo=$2', [g.nombre, `__tmp${i}`]);
    await c.query('UPDATE sucursales SET grupo=NULL WHERE grupo IS NOT NULL AND NOT (grupo = ANY($1))', [lista.map(g => g.nombre)]);
    await c.query(`INSERT INTO ajustes_config (clave, valor) VALUES ('grupos',$1) ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor`, [JSON.stringify(lista.map(g => g.nombre))]);
  });
  await log(req.user.id, 'grupos_editar', { grupos: lista.map(g => g.nombre) });
  res.json({ ok: true });
});

// ── Bitácora ────────────────────────────────────────────────
r.get('/bitacora', requireRol('admin'), async (req, res) => {
  const { rows } = await pool.query(`SELECT b.*, u.nombre AS usuario FROM bitacora b
    LEFT JOIN usuarios u ON u.id=b.usuario_id ORDER BY b.creado_en DESC LIMIT 300`);
  res.json(rows);
});

module.exports = r;
