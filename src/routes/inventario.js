const express = require('express');
const { pool } = require('../db');
const { sucursalesPermitidas, puedeSucursal } = require('../auth');

const r = express.Router();

// Matriz producto × sucursal con totales
r.get('/consolidado', async (req, res) => {
  const permit = sucursalesPermitidas(req.user);
  let ids = req.query.sucursales ? String(req.query.sucursales).split(',').map(Number).filter(Boolean) : null;
  if (permit) ids = ids ? ids.filter(i => permit.includes(i)) : permit;

  const { rows: sucs } = await pool.query(`
    SELECT id, nombre, ultimo_sync, ultimo_error FROM sucursales
    WHERE activa AND ($1::int[] IS NULL OR id = ANY($1)) ORDER BY nombre`, [ids]);
  const sucIds = sucs.map(s => s.id);

  const q = String(req.query.q || '').trim();
  const dep = String(req.query.departamento || '').trim();
  const { rows } = await pool.query(`
    SELECT codigo, sucursal_id, nombre, unidad, departamento, existencia, costo
    FROM inventario
    WHERE sucursal_id = ANY($1)
      AND ($2 = '' OR codigo ILIKE '%'||$2||'%' OR nombre ILIKE '%'||$2||'%')
      AND ($3 = '' OR departamento = $3)`, [sucIds, q, dep]);

  const { rows: pend } = await pool.query(`
    SELECT sucursal_id, codigo, SUM(diferencia) AS dif FROM ajustes
    WHERE estado='pendiente' AND sucursal_id = ANY($1) GROUP BY 1,2`, [sucIds]);
  const { rows: transito } = await pool.query(`
    SELECT o.sucursal_id, l.codigo, SUM(GREATEST(l.cantidad - l.cantidad_recibida, 0)) AS cant
    FROM oc_lineas l JOIN ordenes_compra o ON o.id=l.oc_id
    WHERE o.estado IN ('enviada','recibida_parcial') AND o.sucursal_id = ANY($1) GROUP BY 1,2`, [sucIds]);

  const prods = new Map();
  for (const f of rows) {
    let p = prods.get(f.codigo);
    if (!p) {
      p = { codigo: f.codigo, nombre: f.nombre, unidad: f.unidad, departamento: f.departamento, costo: null, total: 0, valor: 0, por: {}, ajuste: {}, transito: {} };
      prods.set(f.codigo, p);
    }
    const ex = Number(f.existencia);
    p.por[f.sucursal_id] = ex;
    p.total += ex;
    if (f.costo != null) { p.costo = Number(f.costo); p.valor += ex * Number(f.costo); }
  }
  for (const a of pend) { const p = prods.get(a.codigo); if (p) p.ajuste[a.sucursal_id] = Number(a.dif); }
  for (const t of transito) { const p = prods.get(t.codigo); if (p) p.transito[t.sucursal_id] = Number(t.cant); }

  const { rows: deps } = await pool.query(`
    SELECT DISTINCT departamento FROM inventario WHERE departamento IS NOT NULL AND departamento<>'' AND sucursal_id = ANY($1) ORDER BY 1`, [sucIds]);

  res.json({
    sucursales: sucs,
    departamentos: deps.map(d => d.departamento),
    productos: [...prods.values()].sort((a, b) => String(a.nombre || a.codigo).localeCompare(String(b.nombre || b.codigo), 'es')),
  });
});

// Buscador de productos (para órdenes y ajustes)
r.get('/productos', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const suc = req.query.sucursal_id ? Number(req.query.sucursal_id) : null;
  if (suc && !puedeSucursal(req.user, suc)) return res.status(403).json({ error: 'No tienes acceso a esta sucursal' });
  const { rows } = await pool.query(`
    SELECT i.codigo,
           MAX(i.nombre) AS nombre, MAX(i.unidad) AS unidad, MAX(i.departamento) AS departamento,
           MAX(i.costo) AS costo,
           SUM(i.existencia) AS total,
           SUM(CASE WHEN i.sucursal_id = $2 THEN i.existencia END) AS existencia_sucursal
    FROM inventario i
    WHERE ($1 = '' OR i.codigo ILIKE '%'||$1||'%' OR i.nombre ILIKE '%'||$1||'%')
      AND ($3::int[] IS NULL OR i.sucursal_id = ANY($3))
    GROUP BY i.codigo
    ORDER BY MAX(i.nombre) NULLS LAST
    LIMIT 40`, [q, suc, sucursalesPermitidas(req.user)]);
  res.json(rows);
});

module.exports = r;
