const express = require('express');
const { pool, tx, log } = require('../db');
const { requireRol, sucursalesPermitidas, puedeSucursal } = require('../auth');

const r = express.Router();

const MOTIVOS = ['Conteo físico', 'Merma', 'Caducidad', 'Producto dañado', 'Error de captura', 'Robo o faltante', 'Consumo interno', 'Otro'];

r.get('/motivos', (req, res) => res.json(MOTIVOS));

r.get('/', async (req, res) => {
  const permit = sucursalesPermitidas(req.user);
  const estado = req.query.estado || null;
  const suc = req.query.sucursal_id ? Number(req.query.sucursal_id) : null;
  const { rows } = await pool.query(`
    SELECT a.*, s.nombre AS sucursal, u.nombre AS creado_por_nombre, ur.nombre AS resuelto_por_nombre,
           i.existencia AS existencia_wansoft_actual
    FROM ajustes a
    JOIN sucursales s ON s.id=a.sucursal_id
    LEFT JOIN usuarios u ON u.id=a.creado_por
    LEFT JOIN usuarios ur ON ur.id=a.resuelto_por
    LEFT JOIN inventario i ON i.sucursal_id=a.sucursal_id AND i.codigo=a.codigo
    WHERE ($1::text IS NULL OR a.estado=$1)
      AND ($2::int IS NULL OR a.sucursal_id=$2)
      AND ($3::int[] IS NULL OR a.sucursal_id = ANY($3))
    ORDER BY a.creado_en DESC LIMIT 500`, [estado, suc, permit]);
  // "Ya coincide": Wansoft ya refleja la cantidad física contada
  for (const a of rows) {
    a.coincide_wansoft = a.estado === 'pendiente' && a.existencia_wansoft_actual != null &&
      Math.abs(Number(a.existencia_wansoft_actual) - Number(a.existencia_fisica)) < 0.0001;
  }
  res.json(rows);
});

// Crea uno o varios ajustes (un conteo completo de una sucursal)
r.post('/', async (req, res) => {
  const { sucursal_id, motivo, comentario } = req.body || {};
  const items = Array.isArray(req.body.items) ? req.body.items : [req.body];
  if (!sucursal_id || !puedeSucursal(req.user, sucursal_id)) return res.status(403).json({ error: 'Elige una sucursal a la que tengas acceso' });
  if (!motivo) return res.status(400).json({ error: 'Elige el motivo del ajuste' });

  const creados = await tx(async c => {
    const out = [];
    for (const it of items) {
      if (!it.codigo || it.existencia_fisica === '' || it.existencia_fisica == null) continue;
      const fisica = Number(it.existencia_fisica);
      if (!Number.isFinite(fisica) || fisica < 0) throw Object.assign(new Error(`Cantidad no válida para ${it.codigo}`), { status: 400 });
      const { rows: inv } = await c.query(`SELECT i.*, c.nombre AS c_nombre, c.unidad AS c_unidad, c.costo_ideal
        FROM (SELECT $2::text AS codigo) k
        LEFT JOIN inventario i ON i.sucursal_id=$1 AND i.codigo=k.codigo
        LEFT JOIN catalogo c ON c.codigo=k.codigo`, [sucursal_id, it.codigo]);
      // Producto sin existencia en Wansoft: el sistema lo tiene en 0
      if (inv[0] && inv[0].sucursal_id == null) inv[0] = { existencia: 0, nombre: inv[0].c_nombre, unidad: inv[0].c_unidad, costo: inv[0].costo_ideal };
      const sistema = inv[0] ? Number(inv[0].existencia) : 0;
      const dif = fisica - sistema;
      if (Math.abs(dif) < 0.0001) continue;
      const { rows } = await c.query(`
        INSERT INTO ajustes (folio, sucursal_id, codigo, nombre, unidad, existencia_sistema, existencia_fisica, diferencia, costo, motivo, comentario, creado_por)
        VALUES ('AJ-'||LPAD(nextval('seq_folio_aj')::text,5,'0'), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, folio`,
        [sucursal_id, it.codigo, inv[0]?.nombre || it.nombre || null, inv[0]?.unidad || null, sistema, fisica, dif,
         inv[0]?.costo ?? null, it.motivo || motivo, it.comentario || comentario || null, req.user.id]);
      out.push(rows[0]);
    }
    return out;
  });
  await log(req.user.id, 'ajuste_crear', { sucursal_id, folios: creados.map(c => c.folio) });
  res.json({ creados, sin_diferencia: items.length - creados.length });
});

// Marcar como capturado en Wansoft o cancelar
r.patch('/:id', requireRol('admin', 'compras', 'supervisor'), async (req, res) => {
  const estado = req.body.estado;
  if (!['capturado', 'cancelado', 'pendiente'].includes(estado)) return res.status(400).json({ error: 'Estado no válido' });
  const { rowCount } = await pool.query(`
    UPDATE ajustes SET estado=$1,
      resuelto_por = CASE WHEN $1='pendiente' THEN NULL ELSE $2::int END,
      resuelto_en  = CASE WHEN $1='pendiente' THEN NULL ELSE NOW() END
    WHERE id=$3`, [estado, req.user.id, req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Ajuste no encontrado' });
  await log(req.user.id, 'ajuste_estado', { id: Number(req.params.id), estado });
  res.json({ ok: true });
});

module.exports = r;
