const express = require('express');
const { pool, log, setConfig } = require('../db');
const { requireRol, sucursalesPermitidas, puedeSucursal } = require('../auth');
const { encrypt } = require('../crypto');
const { syncSucursal, syncTodas, estaCorriendo } = require('../sync');
const wansoft = require('../wansoft');

const r = express.Router();

r.get('/', async (req, res) => {
  const permit = sucursalesPermitidas(req.user);
  const { rows } = await pool.query(`
    SELECT s.id, s.nombre, s.wansoft_id, s.activa, s.ultimo_sync, s.ultimo_error,
           (s.wansoft_pwd_enc IS NOT NULL) AS tiene_password,
           (SELECT COUNT(*)::int FROM inventario i WHERE i.sucursal_id=s.id) AS productos
    FROM sucursales s
    WHERE ($1::int[] IS NULL OR s.id = ANY($1))
    ORDER BY s.nombre`, [permit]);
  res.json({ sucursales: rows, sincronizando: estaCorriendo() });
});

r.post('/', requireRol('admin'), async (req, res) => {
  const nombre = String(req.body.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'Escribe el nombre de la sucursal' });
  const { rows } = await pool.query('INSERT INTO sucursales (nombre) VALUES ($1) RETURNING id', [nombre]);
  await log(req.user.id, 'sucursal_crear', { nombre });
  res.json({ id: rows[0].id });
});

r.put('/:id', requireRol('admin'), async (req, res) => {
  const { nombre, wansoft_id, password, activa } = req.body || {};
  const sets = [], vals = [];
  const add = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
  if (nombre !== undefined) add('nombre', String(nombre).trim());
  if (wansoft_id !== undefined) add('wansoft_id', wansoft_id === '' || wansoft_id === null ? null : Number(wansoft_id));
  if (password) add('wansoft_pwd_enc', encrypt(String(password).trim()));
  if (activa !== undefined) add('activa', !!activa);
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id);
  await pool.query(`UPDATE sucursales SET ${sets.join(',')} WHERE id=$${vals.length}`, vals);
  await log(req.user.id, 'sucursal_editar', { id: Number(req.params.id), nombre, wansoft_id, cambio_password: !!password, activa });
  res.json({ ok: true });
});

r.post('/sync', requireRol('admin', 'compras'), async (req, res) => {
  const resultados = await syncTodas(req.user.id);
  res.json({ resultados });
});

r.post('/:id/sync', async (req, res) => {
  if (!puedeSucursal(req.user, req.params.id)) return res.status(403).json({ error: 'No tienes acceso a esta sucursal' });
  const { rows } = await pool.query('SELECT * FROM sucursales WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Sucursal no encontrada' });
  res.json(await syncSucursal(rows[0], req.user.id));
});

r.post('/:id/diagnostico', requireRol('admin'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM sucursales WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Sucursal no encontrada' });
  try {
    res.json(await wansoft.diagnostico(rows[0], req.body.metodo || 'GetInventory_Xml', req.body.fecha));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Guarda qué columna de Wansoft corresponde a cada dato
r.put('/config/mapeo/:clave', requireRol('admin'), async (req, res) => {
  if (!['inventario', 'entradas', 'productos'].includes(req.params.clave)) return res.status(400).json({ error: 'Mapeo desconocido' });
  const limpio = {};
  for (const [k, v] of Object.entries(req.body || {})) if (typeof v === 'string' && v) limpio[k] = v;
  await setConfig(`mapeo:${req.params.clave}`, limpio);
  await log(req.user.id, 'mapeo_guardar', { clave: req.params.clave, mapeo: limpio });
  res.json({ ok: true });
});

module.exports = r;
