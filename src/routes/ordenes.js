const express = require('express');
const { pool, tx, log } = require('../db');
const { requireRol, sucursalesPermitidas, puedeSucursal } = require('../auth');
const wansoft = require('../wansoft');

const r = express.Router();

const err = (status, msg) => Object.assign(new Error(msg), { status });

async function cargar(id, user) {
  const { rows } = await pool.query(`
    SELECT o.*, s.nombre AS sucursal, p.nombre AS proveedor, u.nombre AS creado_por_nombre,
           (SELECT COALESCE(SUM(cantidad*costo_unitario),0) FROM oc_lineas WHERE oc_id=o.id) AS total
    FROM ordenes_compra o
    JOIN sucursales s ON s.id=o.sucursal_id
    LEFT JOIN proveedores p ON p.id=o.proveedor_id
    LEFT JOIN usuarios u ON u.id=o.creado_por
    WHERE o.id=$1`, [id]);
  const oc = rows[0];
  if (!oc) throw err(404, 'Orden no encontrada');
  if (!puedeSucursal(user, oc.sucursal_id)) throw err(403, 'No tienes acceso a esta orden');
  return oc;
}

async function evento(c, ocId, tipo, detalle, userId) {
  await c.query('INSERT INTO oc_eventos (oc_id,tipo,detalle,usuario_id) VALUES ($1,$2,$3,$4)', [ocId, tipo, detalle, userId]);
}

// Recalcula el estado según lo recibido
async function recalcular(c, ocId) {
  const { rows } = await c.query(`
    SELECT COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE cantidad_recibida >= cantidad)::int AS completas,
           COUNT(*) FILTER (WHERE cantidad_recibida > 0)::int AS con_algo
    FROM oc_lineas WHERE oc_id=$1`, [ocId]);
  const { n, completas, con_algo } = rows[0];
  const nuevo = n > 0 && completas === n ? 'recibida' : con_algo > 0 ? 'recibida_parcial' : 'enviada';
  const { rows: cur } = await c.query('SELECT estado FROM ordenes_compra WHERE id=$1', [ocId]);
  if (cur[0].estado !== nuevo) {
    await c.query(`UPDATE ordenes_compra SET estado=$1, cerrada_en = CASE WHEN $1='recibida' THEN NOW() ELSE NULL END WHERE id=$2`, [nuevo, ocId]);
    await evento(c, ocId, 'estado', nuevo === 'recibida' ? 'Orden recibida completa' : nuevo === 'recibida_parcial' ? 'Recepción parcial' : 'Sin recepciones', null);
  }
  return nuevo;
}

function validarLineas(lineas) {
  if (!Array.isArray(lineas) || !lineas.length) throw err(400, 'Agrega al menos un producto a la orden');
  return lineas.map(l => {
    const cantidad = Number(l.cantidad);
    if (!l.codigo || !Number.isFinite(cantidad) || cantidad <= 0) throw err(400, `Revisa la cantidad de ${l.nombre || l.codigo || 'un producto'}`);
    return { codigo: String(l.codigo), nombre: l.nombre || null, unidad: l.unidad || null, cantidad, costo_unitario: Number(l.costo_unitario) || 0 };
  });
}

async function guardarLineas(c, ocId, lineas) {
  await c.query('DELETE FROM oc_lineas WHERE oc_id=$1', [ocId]);
  for (const l of lineas) {
    // Si no viene nombre/unidad, se toman del inventario de Wansoft
    await c.query(`INSERT INTO oc_lineas (oc_id,codigo,nombre,unidad,cantidad,costo_unitario)
      SELECT $1,$2,
        COALESCE($3,(SELECT nombre FROM inventario WHERE codigo=$2 AND nombre IS NOT NULL LIMIT 1)),
        COALESCE($4,(SELECT unidad FROM inventario WHERE codigo=$2 AND unidad IS NOT NULL LIMIT 1)),
        $5,$6`,
      [ocId, l.codigo, l.nombre, l.unidad, l.cantidad, l.costo_unitario]);
  }
}

r.get('/', async (req, res) => {
  const permit = sucursalesPermitidas(req.user);
  const estado = req.query.estado || null;
  const suc = req.query.sucursal_id ? Number(req.query.sucursal_id) : null;
  const q = String(req.query.q || '').trim();
  const { rows } = await pool.query(`
    SELECT o.id, o.folio, o.estado, o.fecha_entrega, o.creado_en, o.enviada_en, o.cerrada_en,
           s.nombre AS sucursal, p.nombre AS proveedor, u.nombre AS creado_por_nombre,
           COALESCE(SUM(l.cantidad*l.costo_unitario),0) AS total,
           COALESCE(SUM(l.cantidad),0) AS piezas, COALESCE(SUM(LEAST(l.cantidad_recibida,l.cantidad)),0) AS recibidas,
           COUNT(l.id)::int AS lineas
    FROM ordenes_compra o
    JOIN sucursales s ON s.id=o.sucursal_id
    LEFT JOIN proveedores p ON p.id=o.proveedor_id
    LEFT JOIN usuarios u ON u.id=o.creado_por
    LEFT JOIN oc_lineas l ON l.oc_id=o.id
    WHERE ($1::text IS NULL OR o.estado=$1)
      AND ($2::int IS NULL OR o.sucursal_id=$2)
      AND ($3::int[] IS NULL OR o.sucursal_id = ANY($3))
      AND ($4 = '' OR o.folio ILIKE '%'||$4||'%' OR p.nombre ILIKE '%'||$4||'%' OR s.nombre ILIKE '%'||$4||'%')
    GROUP BY o.id, s.nombre, p.nombre, u.nombre
    ORDER BY o.creado_en DESC LIMIT 300`, [estado, suc, permit, q]);
  res.json(rows);
});

r.get('/:id', async (req, res) => {
  const oc = await cargar(req.params.id, req.user);
  const [{ rows: lineas }, { rows: eventos }, { rows: recepciones }] = await Promise.all([
    pool.query(`SELECT l.*, i.existencia AS existencia_actual FROM oc_lineas l
      JOIN ordenes_compra o ON o.id=l.oc_id
      LEFT JOIN inventario i ON i.sucursal_id=o.sucursal_id AND i.codigo=l.codigo
      WHERE l.oc_id=$1 ORDER BY l.id`, [oc.id]),
    pool.query(`SELECT e.*, u.nombre AS usuario FROM oc_eventos e LEFT JOIN usuarios u ON u.id=e.usuario_id
      WHERE e.oc_id=$1 ORDER BY e.creado_en, e.id`, [oc.id]),
    pool.query(`SELECT r.*, l.codigo, l.nombre, u.nombre AS usuario FROM recepciones r
      JOIN oc_lineas l ON l.id=r.linea_id LEFT JOIN usuarios u ON u.id=r.usuario_id
      WHERE r.oc_id=$1 ORDER BY r.creado_en`, [oc.id]),
  ]);
  res.json({ ...oc, lineas, eventos, recepciones });
});

r.post('/', async (req, res) => {
  const { sucursal_id, proveedor_id, fecha_entrega, notas, lineas, enviar } = req.body || {};
  if (!sucursal_id || !puedeSucursal(req.user, sucursal_id)) throw err(403, 'Elige una sucursal a la que tengas acceso');
  const ls = validarLineas(lineas);
  const oc = await tx(async c => {
    const { rows } = await c.query(`
      INSERT INTO ordenes_compra (folio, sucursal_id, proveedor_id, fecha_entrega, notas, creado_por)
      VALUES ('OC-'||LPAD(nextval('seq_folio_oc')::text,5,'0'), $1,$2,$3,$4,$5) RETURNING id, folio`,
      [sucursal_id, proveedor_id || null, fecha_entrega || null, notas || null, req.user.id]);
    await guardarLineas(c, rows[0].id, ls);
    await evento(c, rows[0].id, 'creada', `${ls.length} productos`, req.user.id);
    if (enviar) {
      await c.query(`UPDATE ordenes_compra SET estado='enviada', enviada_en=NOW() WHERE id=$1`, [rows[0].id]);
      await evento(c, rows[0].id, 'enviada', null, req.user.id);
    }
    return rows[0];
  });
  await log(req.user.id, 'oc_crear', { folio: oc.folio });
  res.json(oc);
});

r.put('/:id', async (req, res) => {
  const oc = await cargar(req.params.id, req.user);
  if (oc.estado !== 'borrador') throw err(400, 'Solo se pueden editar órdenes en borrador');
  const { sucursal_id, proveedor_id, fecha_entrega, notas, lineas } = req.body || {};
  if (sucursal_id && !puedeSucursal(req.user, sucursal_id)) throw err(403, 'No tienes acceso a esa sucursal');
  const ls = validarLineas(lineas);
  await tx(async c => {
    await c.query(`UPDATE ordenes_compra SET sucursal_id=COALESCE($1,sucursal_id), proveedor_id=$2, fecha_entrega=$3, notas=$4 WHERE id=$5`,
      [sucursal_id || null, proveedor_id || null, fecha_entrega || null, notas || null, oc.id]);
    await guardarLineas(c, oc.id, ls);
    await evento(c, oc.id, 'editada', `${ls.length} productos`, req.user.id);
  });
  res.json({ ok: true });
});

r.post('/:id/enviar', async (req, res) => {
  const oc = await cargar(req.params.id, req.user);
  if (oc.estado !== 'borrador') throw err(400, 'Esta orden ya fue enviada');
  await tx(async c => {
    await c.query(`UPDATE ordenes_compra SET estado='enviada', enviada_en=NOW() WHERE id=$1`, [oc.id]);
    await evento(c, oc.id, 'enviada', null, req.user.id);
  });
  await log(req.user.id, 'oc_enviar', { folio: oc.folio });
  res.json({ ok: true });
});

r.post('/:id/cancelar', async (req, res) => {
  const oc = await cargar(req.params.id, req.user);
  if (['recibida', 'cancelada'].includes(oc.estado)) throw err(400, 'Esta orden ya está cerrada');
  if (oc.estado !== 'borrador' && req.user.rol === 'sucursal') throw err(403, 'Solo compras puede cancelar una orden enviada');
  await tx(async c => {
    await c.query(`UPDATE ordenes_compra SET estado='cancelada', cerrada_en=NOW() WHERE id=$1`, [oc.id]);
    await evento(c, oc.id, 'cancelada', req.body.motivo || null, req.user.id);
  });
  await log(req.user.id, 'oc_cancelar', { folio: oc.folio });
  res.json({ ok: true });
});

// Cerrar con faltantes: el proveedor ya no surtirá el resto
r.post('/:id/cerrar', requireRol('admin', 'compras'), async (req, res) => {
  const oc = await cargar(req.params.id, req.user);
  if (oc.estado !== 'recibida_parcial') throw err(400, 'Solo se cierran órdenes con recepción parcial');
  await tx(async c => {
    await c.query(`UPDATE ordenes_compra SET estado='recibida', cerrada_en=NOW() WHERE id=$1`, [oc.id]);
    await evento(c, oc.id, 'cerrada', req.body.motivo || 'Cerrada con faltantes', req.user.id);
  });
  res.json({ ok: true });
});

async function aplicarRecepciones(ocId, items, fuente, userId) {
  return tx(async c => {
    let n = 0;
    for (const it of items) {
      const cant = Number(it.cantidad);
      if (!Number.isFinite(cant) || cant <= 0) continue;
      const { rows } = await c.query('SELECT * FROM oc_lineas WHERE id=$1 AND oc_id=$2 FOR UPDATE', [it.linea_id, ocId]);
      if (!rows[0]) continue;
      if (it.referencia) {
        const dup = await c.query('SELECT 1 FROM recepciones WHERE referencia=$1 AND linea_id=$2', [it.referencia, it.linea_id]);
        if (dup.rowCount) continue;
      }
      await c.query('INSERT INTO recepciones (oc_id,linea_id,cantidad,fuente,referencia,usuario_id) VALUES ($1,$2,$3,$4,$5,$6)',
        [ocId, it.linea_id, cant, fuente, it.referencia || null, userId]);
      await c.query('UPDATE oc_lineas SET cantidad_recibida=cantidad_recibida+$1 WHERE id=$2', [cant, it.linea_id]);
      await evento(c, ocId, 'recepcion', `${rows[0].nombre || rows[0].codigo}: ${cant}${fuente === 'wansoft' ? ' (confirmado en Wansoft)' : ''}`, userId);
      n++;
    }
    const estado = await recalcular(c, ocId);
    return { aplicadas: n, estado };
  });
}

// Recepción capturada a mano
r.post('/:id/recepcion', async (req, res) => {
  const oc = await cargar(req.params.id, req.user);
  if (!['enviada', 'recibida_parcial'].includes(oc.estado)) throw err(400, 'Solo se reciben órdenes enviadas');
  const out = await aplicarRecepciones(oc.id, req.body.items || [], 'manual', req.user.id);
  await log(req.user.id, 'oc_recepcion', { folio: oc.folio, ...out });
  res.json(out);
});

// Busca en Wansoft las entradas de compra desde que se envió la orden
r.get('/:id/wansoft', async (req, res) => {
  const oc = await cargar(req.params.id, req.user);
  if (!['enviada', 'recibida_parcial'].includes(oc.estado)) return res.json({ sugerencias: [], dias: 0 });
  const { rows: sr } = await pool.query('SELECT * FROM sucursales WHERE id=$1', [oc.sucursal_id]);
  const { rows: lineas } = await pool.query('SELECT * FROM oc_lineas WHERE oc_id=$1', [oc.id]);
  const { rows: usadas } = await pool.query(`SELECT r.referencia, SUM(r.cantidad) AS cant FROM recepciones r
    JOIN ordenes_compra o ON o.id=r.oc_id WHERE o.sucursal_id=$1 AND r.referencia IS NOT NULL GROUP BY 1`, [oc.sucursal_id]);
  const usado = new Map(usadas.map(u => [u.referencia, Number(u.cant)]));

  const desde = new Date(oc.enviada_en || oc.creado_en);
  desde.setUTCHours(0, 0, 0, 0);
  const hoy = new Date();
  const dias = [];
  for (let d = new Date(desde); d <= hoy && dias.length < 31; d.setUTCDate(d.getUTCDate() + 1)) dias.push(wansoft.fecha(d));

  const sugerencias = [];
  const errores = [];
  const pendiente = new Map(lineas.map(l => [l.id, Math.max(0, Number(l.cantidad) - Number(l.cantidad_recibida))]));
  for (const dia of dias) {
    let ents;
    try { ents = await wansoft.entradas(sr[0], dia); } catch (e) { errores.push(`${dia}: ${e.message}`); if (/claves|columnas/.test(e.message)) break; continue; }
    for (const e of ents) {
      if (!(await wansoft.esEntradaDeCompra(e.tipo))) continue;
      const disponible = e.cantidad - (usado.get(e.referencia) || 0);
      if (disponible <= 0) continue;
      const linea = lineas.find(l => l.codigo === e.codigo && pendiente.get(l.id) > 0);
      if (!linea) continue;
      const cant = Math.min(disponible, pendiente.get(linea.id));
      pendiente.set(linea.id, pendiente.get(linea.id) - cant);
      sugerencias.push({ linea_id: linea.id, codigo: e.codigo, nombre: linea.nombre || e.nombre, cantidad: cant, referencia: e.referencia, fecha: e.fecha, tipo: e.tipo, proveedor: e.proveedor });
    }
  }
  res.json({ sugerencias, dias: dias.length, errores });
});

r.post('/:id/wansoft/aplicar', async (req, res) => {
  const oc = await cargar(req.params.id, req.user);
  if (!['enviada', 'recibida_parcial'].includes(oc.estado)) throw err(400, 'Solo se reciben órdenes enviadas');
  const out = await aplicarRecepciones(oc.id, req.body.items || [], 'wansoft', req.user.id);
  await log(req.user.id, 'oc_recepcion_wansoft', { folio: oc.folio, ...out });
  res.json(out);
});

module.exports = r;
