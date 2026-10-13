const express = require('express');
const { pool } = require('../db');
const { sucursalesPermitidas, puedeSucursal } = require('../auth');

const r = express.Router();

// Búsqueda sin importar acentos ni mayúsculas
const sinAcentos = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const norm = col => `translate(lower(coalesce(${col},'')), 'áéíóúüñàèìòù', 'aeiouunaeiou')`;
const coincide = (cod, nom, p) => `(${p} = '' OR ${norm(cod)} LIKE '%'||${p}||'%' OR ${norm(nom)} LIKE '%'||${p}||'%')`;

// Matriz producto × sucursal con totales
r.get('/consolidado', async (req, res) => {
  const permit = sucursalesPermitidas(req.user);
  let ids = req.query.sucursales ? String(req.query.sucursales).split(',').map(Number).filter(Boolean) : null;
  if (permit) ids = ids ? ids.filter(i => permit.includes(i)) : permit;

  const { rows: sucs } = await pool.query(`
    SELECT id, nombre, ultimo_sync, ultimo_error FROM sucursales
    WHERE activa AND ($1::int[] IS NULL OR id = ANY($1)) ORDER BY nombre`, [ids]);
  const sucIds = sucs.map(s => s.id);

  const q = sinAcentos(req.query.q);
  const dep = String(req.query.departamento || '').trim();
  const { rows } = await pool.query(`
    SELECT codigo, sucursal_id, nombre, unidad, departamento, existencia, costo
    FROM inventario
    WHERE sucursal_id = ANY($1)
      AND ${coincide('codigo', 'nombre', '$2')}
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

// Lista completa de productos de una sucursal para armar un pedido:
// catálogo + inventario, con existencia (0 si está agotado) y lo que ya viene en camino
r.get('/sucursal/:id/productos', async (req, res) => {
  const suc = Number(req.params.id);
  if (!puedeSucursal(req.user, suc)) return res.status(403).json({ error: 'No tienes acceso a esta sucursal' });
  const { rows } = await pool.query(`
    WITH cods AS (
      SELECT codigo FROM catalogo
      UNION SELECT codigo FROM inventario WHERE sucursal_id = $1
    ),
    transito AS (
      SELECT l.codigo, SUM(GREATEST(l.cantidad - l.cantidad_recibida, 0)) AS cant
      FROM oc_lineas l JOIN ordenes_compra o ON o.id = l.oc_id
      WHERE o.sucursal_id = $1 AND o.estado IN ('enviada','recibida_parcial') GROUP BY l.codigo
    )
    SELECT k.codigo,
           COALESCE(i.nombre, c.nombre) AS nombre,
           COALESCE(i.unidad, c.unidad) AS unidad,
           COALESCE(i.departamento, c.departamento) AS departamento,
           c.tipo,
           COALESCE(NULLIF(i.costo,0), NULLIF(c.costo_ideal,0),
                    (SELECT NULLIF(MAX(x.costo),0) FROM inventario x WHERE x.codigo = k.codigo)) AS costo,
           COALESCE(i.existencia, 0) AS existencia,
           COALESCE(t.cant, 0) AS en_camino
    FROM cods k
    LEFT JOIN catalogo c ON c.codigo = k.codigo
    LEFT JOIN inventario i ON i.codigo = k.codigo AND i.sucursal_id = $1
    LEFT JOIN transito t ON t.codigo = k.codigo
    ORDER BY (COALESCE(i.existencia,0) <= 0) DESC, 4 NULLS LAST, 2 NULLS LAST`, [suc]);
  res.json(rows);
});

// Buscador de productos (para órdenes y ajustes)
r.get('/productos', async (req, res) => {
  const q = sinAcentos(req.query.q);
  const suc = req.query.sucursal_id ? Number(req.query.sucursal_id) : null;
  if (suc && !puedeSucursal(req.user, suc)) return res.status(403).json({ error: 'No tienes acceso a esta sucursal' });
  // Catálogo completo + inventario: así aparecen también los productos agotados
  const { rows } = await pool.query(`
    WITH cods AS (
      SELECT codigo FROM catalogo WHERE ${coincide('codigo', 'nombre', '$1')}
      UNION
      SELECT codigo FROM inventario WHERE ${coincide('codigo', 'nombre', '$1')}
        AND ($3::int[] IS NULL OR sucursal_id = ANY($3))
    )
    SELECT k.codigo,
           COALESCE(MAX(i.nombre), MAX(c.nombre)) AS nombre,
           COALESCE(MAX(i.unidad), MAX(c.unidad)) AS unidad,
           COALESCE(MAX(i.departamento), MAX(c.departamento)) AS departamento,
           MAX(c.tipo) AS tipo,
           COALESCE(NULLIF(MAX(i.costo),0), NULLIF(MAX(c.costo_ideal),0)) AS costo,
           COALESCE(SUM(i.existencia),0) AS total,
           COALESCE(SUM(CASE WHEN i.sucursal_id = $2 THEN i.existencia END),0) AS existencia_sucursal
    FROM cods k
    LEFT JOIN catalogo c ON c.codigo = k.codigo
    LEFT JOIN inventario i ON i.codigo = k.codigo AND ($3::int[] IS NULL OR i.sucursal_id = ANY($3))
    GROUP BY k.codigo
    ORDER BY 2 NULLS LAST
    LIMIT 40`, [q, suc, sucursalesPermitidas(req.user)]);
  res.json(rows);
});

module.exports = r;
