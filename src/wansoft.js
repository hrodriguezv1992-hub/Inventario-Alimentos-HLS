// Cliente del WebService de Wansoft (SOAP, IntegrationService.asmx).
// La API devuelve un "string" con XML/JSON adentro cuyo formato exacto no viene
// en la documentación, así que el lector es genérico y los nombres de columna
// se detectan solos (y se pueden corregir desde la pantalla de Diagnóstico).
const { XMLParser } = require('fast-xml-parser');
const { decrypt } = require('./crypto');
const { getConfig } = require('./db');

const URL = () => process.env.WANSOFT_URL || 'https://www.wansoft.net/wansoft.web/API/IntegrationService.asmx';
const TIMEOUT_MS = Number(process.env.WANSOFT_TIMEOUT_MS || 60000);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,   // dejamos todo como texto y convertimos nosotros
  trimValues: true,
});

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fecha(d) {
  if (!d) return new Date().toISOString().slice(0, 10);
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

class WansoftError extends Error {}

async function call(method, params) {
  const body = Object.entries(params).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('');
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><${method} xmlns="http://tempuri.org/">${body}</${method}></soap:Body>
</soap:Envelope>`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res, text;
  try {
    res = await fetch(URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"http://tempuri.org/${method}"` },
      body: envelope,
      signal: ctrl.signal,
    });
    text = await res.text();
  } catch (e) {
    throw new WansoftError(e.name === 'AbortError' ? 'Wansoft tardó demasiado en responder' : `No se pudo conectar con Wansoft: ${e.message}`);
  } finally {
    clearTimeout(t);
  }

  const doc = parser.parse(text);
  const bodyNode = doc?.Envelope?.Body;
  if (!bodyNode) throw new WansoftError(`Respuesta inesperada de Wansoft (HTTP ${res.status})`);
  if (bodyNode.Fault) {
    const f = bodyNode.Fault;
    throw new WansoftError(`Wansoft respondió con error: ${f.faultstring || f.Reason?.Text || JSON.stringify(f)}`);
  }
  const resp = bodyNode[`${method}Response`] || Object.values(bodyNode)[0];
  const result = resp?.[`${method}Result`] ?? (resp && Object.values(resp)[0]);
  return typeof result === 'string' ? result : (result == null ? '' : result);
}

// Convierte el contenido del "Result" en una lista de registros planos
function aRegistros(result) {
  let data = result;
  if (typeof result === 'string') {
    const s = result.trim();
    if (!s) return [];
    if (s.startsWith('<')) data = parser.parse(s);
    else if (s.startsWith('[') || s.startsWith('{')) {
      try { data = JSON.parse(s); } catch { throw new WansoftError(`Wansoft devolvió un texto que no se pudo leer: ${s.slice(0, 200)}`); }
    } else {
      throw new WansoftError(`Wansoft respondió: ${s.slice(0, 300)}`);
    }
  }

  const candidatas = [];
  const esPrim = v => v === null || typeof v !== 'object';
  (function walk(n, depth) {
    if (depth > 12 || n == null || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      const objs = n.filter(x => x && typeof x === 'object' && !Array.isArray(x));
      if (objs.length) candidatas.push(objs);
      n.forEach(x => walk(x, depth + 1));
      return;
    }
    for (const v of Object.values(n)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).some(esPrim) && Object.keys(v).length > 1) {
        candidatas.push([v]);
      }
      walk(v, depth + 1);
    }
  })(data, 0);

  if (!candidatas.length) return [];
  candidatas.sort((a, b) => (b.length - a.length) || (Object.keys(b[0]).length - Object.keys(a[0]).length));
  return candidatas[0].map(o => aplanar(o));
}

function aplanar(o, pref = '', out = {}) {
  for (const [k0, v] of Object.entries(o)) {
    const k = pref + k0.replace(/^@_/, '');
    if (v == null || typeof v !== 'object') out[k] = v;
    else if (!Array.isArray(v)) {
      if ('#text' in v) out[k] = v['#text'];
      else aplanar(v, k + '.', out);
    }
  }
  return out;
}

// ── Detección de columnas ───────────────────────────────────────────────
const PATRONES = {
  codigo:       [/^(codigo|code|productcode|clave|sku|cveproducto|codigoproducto|product_code)$/i, /c[oó]d|clave|sku/i],
  nombre:       [/^(nombre|name|descripcion|description|producto|productname|nombreproducto)$/i, /nombre|descrip|name/i],
  existencia:   [/^(existencia|existencias|stock|cantidad|qty|quantity|inventario|saldo|existenciaactual)$/i, /existen|stock|cantidad|qty|quantity|saldo/i],
  unidad:       [/^(unidad|unit|um|uom|unidadmedida|unitofmeasure)$/i, /unidad|unit|uom|medida/i],
  departamento: [/^(departamento|department|grupo|categoria|familia)$/i, /depart|grupo|categ|famil/i],
  costo:        [/^(costo|cost|costounitario|unitcost|costopromedio|precio|price)$/i, /costo|cost|precio|price/i],
  valor:        [/^(monto|importe|valor|valortotal|total|montototal)$/i, /monto|importe|valor/i],
  tipo:         [/^(tipo|tipoentrada|type|entrytype|idtipoentrada|tipodeentrada|tipoproducto)$/i, /tipo|type/i],
  referencia:   [/^(id|folio|documentid|iddocumento|referencia|documento|numero)$/i, /folio|docum|refer|^id/i],
  fecha:        [/^(fecha|date|operationdate|fechaoperacion)$/i, /fecha|date/i],
  proveedor:    [/^(proveedor|supplier|vendor|nombreproveedor)$/i, /provee|supplier|vendor/i],
};

// Columnas tipo "IdUnidadMedida" son llaves internas: no se usan para nombres o unidades
const esLlaveId = col => /^Id[A-Z_]/.test(col.split('.').pop());

function detectar(columnas, campos) {
  const usado = new Set();
  const m = {};
  for (const campo of campos) {
    for (const [i, re] of PATRONES[campo].entries()) {
      const c = columnas.find(col => !usado.has(col) && re.test(col.split('.').pop()) &&
        (i === 0 || campo === 'referencia' || campo === 'tipo' || !esLlaveId(col)));
      if (c) { m[campo] = c; usado.add(c); break; }
    }
  }
  return m;
}

const num = v => {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

async function credenciales(suc) {
  if (!suc.wansoft_id || !suc.wansoft_pwd_enc) throw new WansoftError(`La sucursal ${suc.nombre} no tiene claves de Wansoft`);
  return { subsidiaryId: suc.wansoft_id, pwdWebService: decrypt(suc.wansoft_pwd_enc) };
}

const CAMPOS_INV = ['codigo', 'nombre', 'existencia', 'unidad', 'departamento', 'costo', 'valor'];
const CAMPOS_ENT = ['codigo', 'nombre', 'existencia', 'tipo', 'referencia', 'fecha', 'proveedor', 'unidad', 'costo'];
const CAMPOS_PROD = ['codigo', 'nombre', 'unidad', 'departamento', 'tipo', 'costo'];

async function mapeo(clave, campos, columnas) {
  const guardado = (await getConfig(`mapeo:${clave}`)) || {};
  const auto = detectar(columnas, campos);
  const m = { ...auto };
  for (const [k, v] of Object.entries(guardado)) if (v && columnas.includes(v)) m[k] = v;
  return m;
}

// Inventario actual de una sucursal, normalizado y sumado por código
async function inventario(suc) {
  const regs = aRegistros(await call('GetInventory_Xml', await credenciales(suc)));
  if (!regs.length) return [];
  const cols = Object.keys(regs[0]);
  const m = await mapeo('inventario', CAMPOS_INV, cols);
  if (!m.codigo || !m.existencia) {
    throw new WansoftError(`No se reconocieron las columnas de código/existencia (columnas: ${cols.join(', ')}). Configúralas en Diagnóstico.`);
  }
  const porCodigo = new Map();
  for (const r of regs) {
    const codigo = String(r[m.codigo] ?? '').trim();
    if (!codigo) continue;
    const prev = porCodigo.get(codigo);
    const fila = prev || {
      codigo,
      nombre: m.nombre ? String(r[m.nombre] ?? '').trim() : null,
      unidad: m.unidad ? String(r[m.unidad] ?? '').trim() : null,
      departamento: m.departamento ? String(r[m.departamento] ?? '').trim() : null,
      costo: m.costo ? num(r[m.costo]) : null,
      existencia: 0,
      valor: 0,
    };
    fila.existencia += num(r[m.existencia]);
    if (m.valor) fila.valor += num(r[m.valor]);
    porCodigo.set(codigo, fila);
  }
  // Si Wansoft manda el valor total (Monto) y no el costo, costo = valor / existencia
  for (const f of porCodigo.values()) {
    f.existencia = Math.round(f.existencia * 10000) / 10000;
    if ((f.costo == null || f.costo === 0) && m.valor && f.existencia > 0) {
      f.costo = Math.round((f.valor / f.existencia) * 10000) / 10000;
    }
    delete f.valor;
  }
  return [...porCodigo.values()];
}

// Catálogo completo de productos (incluye los que no tienen existencia)
async function productos(suc) {
  const regs = aRegistros(await call('GetProducts_Xml', await credenciales(suc)));
  if (!regs.length) return [];
  const cols = Object.keys(regs[0]);
  const m = await mapeo('productos', CAMPOS_PROD, cols);
  if (!m.codigo) throw new WansoftError(`No se reconoció la columna de código del catálogo (columnas: ${cols.join(', ')})`);
  const txt = (r, k) => (m[k] ? String(r[m[k]] ?? '').trim() || null : null);
  return regs.map(r => ({
    codigo: String(r[m.codigo] ?? '').trim(),
    nombre: txt(r, 'nombre'), unidad: txt(r, 'unidad'), departamento: txt(r, 'departamento'), tipo: txt(r, 'tipo'),
    costo: m.costo ? num(r[m.costo]) : null,
  })).filter((p, i, arr) => p.codigo && arr.findIndex(x => x.codigo === p.codigo) === i);
}

// Entradas de inventario de un día (para confirmar recepciones de órdenes)
async function entradas(suc, dia) {
  const regs = aRegistros(await call('GetInputInventory_Xml', { ...(await credenciales(suc)), operationdate: fecha(dia) }));
  if (!regs.length) return [];
  const cols = Object.keys(regs[0]);
  const m = await mapeo('entradas', CAMPOS_ENT, cols);
  if (!m.codigo || !m.existencia) {
    throw new WansoftError(`No se reconocieron las columnas de las entradas (columnas: ${cols.join(', ')}). Configúralas en Diagnóstico.`);
  }
  return regs.map((r, i) => ({
    codigo: String(r[m.codigo] ?? '').trim(),
    nombre: m.nombre ? String(r[m.nombre] ?? '') : null,
    cantidad: num(r[m.existencia]),
    tipo: m.tipo ? String(r[m.tipo] ?? '').trim() : null,
    referencia: `${fecha(dia)}:${m.referencia ? String(r[m.referencia] ?? i) : i}:${String(r[m.codigo] ?? '').trim()}`,
    proveedor: m.proveedor ? String(r[m.proveedor] ?? '') : null,
    fecha: m.fecha ? String(r[m.fecha] ?? '') : fecha(dia),
  })).filter(e => e.codigo && e.cantidad > 0);
}

// Tipos de entrada que cuentan como recepción de compra (ver anexo del PDF)
const TIPOS_COMPRA_DEFAULT = ['1', '13', 'factura', 'orden de compra a proveedor'];
async function esEntradaDeCompra(tipo) {
  if (tipo == null || tipo === '') return true; // si Wansoft no manda el tipo, no filtramos
  const permitidos = ((await getConfig('tipos_entrada_compra')) || TIPOS_COMPRA_DEFAULT).map(s => String(s).toLowerCase());
  const t = String(tipo).toLowerCase().trim();
  return permitidos.some(p => t === p || (p.length > 3 && t.includes(p)));
}

// Para la pantalla de diagnóstico: llama un método y muestra qué devolvió
const METODOS_DIAG = {
  GetInventory_Xml: false,
  GetInputInventory_Xml: true,
  GetProducts_Xml: false,
  GetWarehouses_Xml: false,
  GetPendingPurchaseOrders_Xml: false,
  GetOutgoingInventory_Xml: true,
  GetStockInventory_Xml: true,
};
async function diagnostico(suc, metodo, dia) {
  if (!(metodo in METODOS_DIAG)) throw new WansoftError('Método no permitido en diagnóstico');
  const params = await credenciales(suc);
  if (METODOS_DIAG[metodo]) params.operationdate = fecha(dia);
  const t0 = Date.now();
  const raw = await call(metodo, params);
  const regs = aRegistros(raw);
  const cols = regs.length ? Object.keys(regs[0]) : [];
  const clave = { GetInputInventory_Xml: 'entradas', GetInventory_Xml: 'inventario', GetProducts_Xml: 'productos' }[metodo];
  const campos = { entradas: CAMPOS_ENT, inventario: CAMPOS_INV, productos: CAMPOS_PROD }[clave];
  return {
    metodo, ms: Date.now() - t0, total: regs.length, columnas: cols,
    mapeo: cols.length && clave ? await mapeo(clave, campos, cols) : {},
    muestra: regs.slice(0, 15),
    crudo: typeof raw === 'string' ? raw.slice(0, 3000) : JSON.stringify(raw).slice(0, 3000),
  };
}

module.exports = {
  call, aRegistros, detectar, inventario, productos, entradas, esEntradaDeCompra, diagnostico,
  WansoftError, CAMPOS_INV, CAMPOS_ENT, METODOS_DIAG, fecha,
};
