// Archivo de "Carga de inventario físico" para subir a Wansoft.
// Wansoft no recibe ajustes por su API, pero sí acepta este .xls desde
// "Inventario físico contra sistema". El archivo es un inventario COMPLETO:
// lo que se deje en 0 queda en 0. Por eso se llena así:
//   · Productos con ajuste pendiente → existencia actual de Wansoft + diferencia del conteo
//   · Productos sin ajuste          → existencia actual de Wansoft (no cambian)
//   · Presentaciones que no son la base (cajas, sacos…) → 0, como pide Wansoft
const express = require('express');
const XLSX = require('@e965/xlsx');
const { pool, tx, log } = require('../db');
const { requireRol, puedeSucursal } = require('../auth');
const { syncSucursal } = require('../sync');

const r = express.Router();
const err = (status, msg) => Object.assign(new Error(msg), { status });
const HOJA = 'InventarioFisico';
const MAX_BYTES = 5 * 1024 * 1024;

r.use(requireRol('admin', 'compras', 'supervisor'));

function sucursalPermitida(req) {
  const id = Number(req.params.sucursal_id);
  if (!id || !puedeSucursal(req.user, id)) throw err(403, 'No tienes acceso a esta sucursal');
  return id;
}

// Lee la plantilla y valida que sea la de Wansoft
function leerPlantilla(buf) {
  let wb;
  try { wb = XLSX.read(buf, { type: 'buffer', cellStyles: true }); }
  catch { throw err(400, 'No se pudo leer el archivo. Sube el .xls tal como lo descargas de Wansoft.'); }
  const ws = wb.Sheets[HOJA];
  if (!ws) throw err(400, `El archivo no tiene la hoja "${HOJA}". Descárgalo de Wansoft en "Inventario físico contra sistema".`);
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const cab = (filas[0] || []).map(v => String(v ?? '').trim().toLowerCase());
  const col = {
    clave: cab.findIndex(c => c.startsWith('clave')),
    producto: cab.findIndex(c => c === 'producto'),
    presentacion: cab.findIndex(c => c.startsWith('presentaci')),
    cantidad: cab.findIndex(c => c === 'cantidad'),
  };
  if (Object.values(col).some(i => i < 0)) {
    throw err(400, 'El archivo no tiene las columnas esperadas (Clave producto, Producto, Presentación, Cantidad).');
  }
  const datos = [];
  for (let i = 1; i < filas.length; i++) {
    const f = filas[i];
    const clave = String(f[col.clave] ?? '').trim();
    if (!clave) continue;
    datos.push({
      fila: i, clave, producto: f[col.producto], presentacion: String(f[col.presentacion] ?? ''),
      // Columna B oculta: id de presentación; 0 = unidad base (la misma en la que Wansoft reporta existencia)
      base: col.clave >= 2 ? Number(f[1]) === 0 : null,
    });
  }
  if (!datos.length) throw err(400, 'La plantilla no tiene productos.');
  return { wb, ws, col, datos };
}

// ── Plantilla por sucursal ─────────────────────────────────────────
r.get('/plantilla/:sucursal_id', async (req, res) => {
  const suc = sucursalPermitida(req);
  const { rows } = await pool.query(`SELECT p.nombre, p.productos, p.subido_en, u.nombre AS subido_por
    FROM wansoft_plantillas p LEFT JOIN usuarios u ON u.id=p.subido_por WHERE sucursal_id=$1`, [suc]);
  res.json(rows[0] || null);
});

r.post('/plantilla/:sucursal_id', async (req, res) => {
  const suc = sucursalPermitida(req);
  const { nombre, base64 } = req.body || {};
  if (!base64) throw err(400, 'Selecciona el archivo de Wansoft');
  const buf = Buffer.from(String(base64), 'base64');
  if (buf.length > MAX_BYTES) throw err(400, 'El archivo es demasiado grande');
  const { datos } = leerPlantilla(buf);
  const productos = new Set(datos.map(d => d.clave)).size;
  await pool.query(`INSERT INTO wansoft_plantillas (sucursal_id,nombre,archivo,productos,subido_por) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (sucursal_id) DO UPDATE SET nombre=EXCLUDED.nombre, archivo=EXCLUDED.archivo, productos=EXCLUDED.productos,
      subido_por=EXCLUDED.subido_por, subido_en=NOW()`, [suc, String(nombre || 'plantilla.xls').slice(0, 200), buf, productos, req.user.id]);
  await log(req.user.id, 'plantilla_wansoft', { sucursal_id: suc, productos });
  res.json({ ok: true, productos, filas: datos.length });
});

// ── Vista previa y generación del archivo ──────────────────────────
async function calcular(suc) {
  const { rows: pl } = await pool.query('SELECT archivo FROM wansoft_plantillas WHERE sucursal_id=$1', [suc]);
  if (!pl[0]) throw err(400, 'Primero sube la plantilla de Wansoft de esta sucursal');
  const plantilla = leerPlantilla(pl[0].archivo);

  const { rows: inv } = await pool.query('SELECT codigo, existencia, nombre FROM inventario WHERE sucursal_id=$1', [suc]);
  const existencia = new Map(inv.map(i => [i.codigo, Number(i.existencia)]));
  // Ajustes pendientes: el más reciente por producto manda; los anteriores quedan reemplazados
  const { rows: aj } = await pool.query(`SELECT * FROM ajustes WHERE sucursal_id=$1 AND estado='pendiente' ORDER BY creado_en DESC, id DESC`, [suc]);
  const ultimo = new Map(), idsPorCodigo = new Map();
  for (const a of aj) {
    if (!ultimo.has(a.codigo)) ultimo.set(a.codigo, a);
    idsPorCodigo.set(a.codigo, [...(idsPorCodigo.get(a.codigo) || []), a.id]);
  }

  const enPlantilla = new Set(plantilla.datos.map(d => d.clave));
  const tieneBase = new Set(plantilla.datos.filter(d => d.base !== false).map(d => d.clave));
  const valores = new Map();   // clave → cantidad a cargar en la presentación base
  const cambios = [];
  for (const clave of enPlantilla) {
    const actual = existencia.get(clave) ?? 0;
    const a = ultimo.get(clave);
    if (a) {
      const dif = Number(a.diferencia);
      let cargar = actual + dif;
      const ajustadoACero = cargar < 0;
      if (ajustadoACero) cargar = 0;
      cargar = Math.round(cargar * 10000) / 10000;
      valores.set(clave, cargar);
      cambios.push({ codigo: clave, nombre: a.nombre, unidad: a.unidad, actual, diferencia: dif, cargar, contado: Number(a.existencia_fisica),
        folio: a.folio, ajustadoACero, sinBase: !tieneBase.has(clave) });
    } else {
      valores.set(clave, Math.max(0, Math.round(actual * 10000) / 10000));
    }
  }
  const fuera = [...ultimo.values()].filter(a => !enPlantilla.has(a.codigo))
    .map(a => ({ codigo: a.codigo, nombre: a.nombre, folio: a.folio }));
  const ajustesIncluidos = cambios.flatMap(c => idsPorCodigo.get(c.codigo) || []);
  const negativos = [...enPlantilla].filter(c => (existencia.get(c) ?? 0) < 0 && !ultimo.has(c));
  return { plantilla, valores, cambios, fuera, ajustesIncluidos, negativos,
    productos: enPlantilla.size, sinExistencia: [...enPlantilla].filter(c => !existencia.has(c)).length };
}

async function refrescar(suc) {
  const { rows } = await pool.query('SELECT * FROM sucursales WHERE id=$1', [suc]);
  if (!rows[0]?.wansoft_id || !rows[0]?.wansoft_pwd_enc) return null;
  const r = await Promise.race([syncSucursal(rows[0]), new Promise(res => setTimeout(() => res({ ok: false, error: 'Wansoft tardó demasiado' }), 25000))]);
  const { rows: s } = await pool.query('SELECT ultimo_sync FROM sucursales WHERE id=$1', [suc]);
  return { ok: r.ok, error: r.error, ultimo_sync: s[0].ultimo_sync };
}

r.get('/preparar/:sucursal_id', async (req, res) => {
  const suc = sucursalPermitida(req);
  const sync = await refrescar(suc);
  const c = await calcular(suc);
  res.json({ sync, productos: c.productos, cambios: c.cambios, fuera: c.fuera, negativos: c.negativos,
    sinExistencia: c.sinExistencia, ajustes: c.ajustesIncluidos.length });
});

r.post('/generar/:sucursal_id', async (req, res) => {
  const suc = sucursalPermitida(req);
  // Sin un inventario fresco de Wansoft, lo no contado saldría en 0 y borraría existencias al cargarlo
  const { rows: sr } = await pool.query('SELECT ultimo_sync, ultimo_error FROM sucursales WHERE id=$1', [suc]);
  const minutos = sr[0]?.ultimo_sync ? (Date.now() - new Date(sr[0].ultimo_sync)) / 60000 : Infinity;
  if (sr[0]?.ultimo_error || minutos > 30) {
    throw err(400, 'El inventario de esta sucursal no está actualizado desde Wansoft. Da clic en "Revisar cambios" para actualizarlo y vuelve a intentar.');
  }
  const c = await calcular(suc);
  if (!c.cambios.length) throw err(400, 'No hay ajustes pendientes de esta sucursal que estén en la plantilla');
  const { ws, col, datos } = c.plantilla;
  const ref = XLSX.utils.decode_range(ws['!ref']);
  // La cantidad va en la presentación base (id 0). Si un producto no la tiene, va en su primera fila.
  const filaDestino = new Map();
  for (const d of datos) {
    if (d.base === true || d.base === null) { if (!filaDestino.has(d.clave) || d.base === true) filaDestino.set(d.clave, d.fila); }
  }
  for (const d of datos) if (!filaDestino.has(d.clave)) filaDestino.set(d.clave, d.fila);
  for (const d of datos) {
    const v = filaDestino.get(d.clave) === d.fila ? (c.valores.get(d.clave) ?? 0) : 0;
    ws[XLSX.utils.encode_cell({ r: d.fila, c: col.cantidad })] = { t: 'n', v };
  }
  ref.e.c = Math.max(ref.e.c, col.cantidad);
  ws['!ref'] = XLSX.utils.encode_range(ref);
  const buf = XLSX.write(c.plantilla.wb, { type: 'buffer', bookType: 'biff8', cellStyles: true });

  const resumen = { productos: c.productos, cambios: c.cambios, fuera: c.fuera };
  const lote = await tx(async cx => {
    const { rows } = await cx.query(`INSERT INTO cargas_wansoft (folio, sucursal_id, ajustes, resumen, archivo, creado_por)
      VALUES ('CW-'||LPAD(nextval('seq_folio_cw')::text,5,'0'), $1,$2,$3,$4,$5) RETURNING id, folio, creado_en`,
      [suc, c.ajustesIncluidos, JSON.stringify(resumen), buf, req.user.id]);
    return rows[0];
  });
  await log(req.user.id, 'carga_wansoft_generar', { folio: lote.folio, sucursal_id: suc, ajustes: c.ajustesIncluidos.length });
  res.json({ ...lote, ajustes: c.ajustesIncluidos.length });
});

// ── Historial, descarga y confirmación ─────────────────────────────
r.get('/lotes', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT c.id, c.folio, c.sucursal_id, s.nombre AS sucursal, c.estado, cardinality(c.ajustes) AS ajustes,
           jsonb_array_length(COALESCE(c.resumen->'cambios','[]'::jsonb)) AS productos_ajustados,
           c.creado_en, u.nombre AS creado_por, c.confirmado_en, uc.nombre AS confirmado_por
    FROM cargas_wansoft c JOIN sucursales s ON s.id=c.sucursal_id
    LEFT JOIN usuarios u ON u.id=c.creado_por LEFT JOIN usuarios uc ON uc.id=c.confirmado_por
    WHERE ($1::int IS NULL OR c.sucursal_id=$1) ORDER BY c.creado_en DESC LIMIT 50`,
    [req.query.sucursal_id ? Number(req.query.sucursal_id) : null]);
  res.json(rows.filter(l => puedeSucursal(req.user, l.sucursal_id)));
});

async function cargarLote(id, user) {
  const { rows } = await pool.query(`SELECT c.*, s.nombre AS sucursal FROM cargas_wansoft c JOIN sucursales s ON s.id=c.sucursal_id WHERE c.id=$1`, [id]);
  if (!rows[0]) throw err(404, 'Archivo no encontrado');
  if (!puedeSucursal(user, rows[0].sucursal_id)) throw err(403, 'No tienes acceso a esta sucursal');
  return rows[0];
}

r.get('/lotes/:id/archivo', async (req, res) => {
  const l = await cargarLote(req.params.id, req.user);
  const fecha = new Date(l.creado_en).toISOString().slice(0, 10).replace(/-/g, '');
  const suc = l.sucursal.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '');
  res.json({ nombre: `CargaDeInventarioFisico_${suc}_${fecha}_${l.folio}.xls`, base64: l.archivo.toString('base64') });
});

// "Ya lo cargué en Wansoft": los ajustes incluidos pasan a capturados
r.post('/lotes/:id/confirmar', async (req, res) => {
  const l = await cargarLote(req.params.id, req.user);
  if (l.estado !== 'generado') throw err(400, 'Este archivo ya se confirmó o se descartó');
  const n = await tx(async cx => {
    const { rowCount } = await cx.query(`UPDATE ajustes SET estado='capturado', resuelto_por=$1, resuelto_en=NOW()
      WHERE id = ANY($2) AND estado='pendiente'`, [req.user.id, l.ajustes]);
    await cx.query(`UPDATE cargas_wansoft SET estado='cargado', confirmado_por=$1, confirmado_en=NOW() WHERE id=$2`, [req.user.id, l.id]);
    // Otros archivos generados antes para esta sucursal quedan obsoletos
    await cx.query(`UPDATE cargas_wansoft SET estado='descartado' WHERE sucursal_id=$1 AND estado='generado' AND id<>$2`, [l.sucursal_id, l.id]);
    return rowCount;
  });
  await log(req.user.id, 'carga_wansoft_confirmar', { folio: l.folio, ajustes: n });
  res.json({ ok: true, ajustes: n });
});

r.post('/lotes/:id/descartar', async (req, res) => {
  const l = await cargarLote(req.params.id, req.user);
  if (l.estado !== 'generado') throw err(400, 'Este archivo ya se confirmó o se descartó');
  await pool.query(`UPDATE cargas_wansoft SET estado='descartado' WHERE id=$1`, [l.id]);
  res.json({ ok: true });
});

module.exports = r;
