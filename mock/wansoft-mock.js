// Simulador de Wansoft para pruebas locales (no se usa en producción).
// Uso: node mock/wansoft-mock.js  → WANSOFT_URL=http://localhost:4100/API/IntegrationService.asmx
const http = require('http');

const PRODUCTOS = [
  ['MOZ-001', 'Queso mozzarella rallado 2kg', 'BOLSA', 'Lácteos', 389.5],
  ['MOZ-002', 'Salsa de tomate pizza 3.8L', 'GALÓN', 'Abarrotes', 142],
  ['MOZ-003', 'Harina para pizza 25kg', 'BULTO', 'Abarrotes', 610],
  ['MOZ-004', 'Pepperoni rebanado 1kg', 'KG', 'Carnes frías', 238.9],
  ['MOZ-005', 'Jamón de pavo 1kg', 'KG', 'Carnes frías', 156],
  ['MOZ-006', 'Caja pizza grande', 'PZA', 'Empaque', 7.4],
  ['MOZ-007', 'Caja pizza mediana', 'PZA', 'Empaque', 6.1],
  ['MOZ-008', 'Refresco 2L', 'PZA', 'Bebidas', 28.5],
  ['MOZ-009', 'Champiñón rebanado lata 2.8kg', 'LATA', 'Abarrotes', 175],
  ['MOZ-010', 'Aceite vegetal 20L', 'BIDÓN', 'Abarrotes', 720],
];

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const seed = (a, b) => Math.abs(Math.sin(a * 97 + b * 13) * 1000) % 1;

function inventario(id) {
  let rows = '';
  PRODUCTOS.forEach(([c, n, u, d, cost], i) => {
    if (seed(id, i) < 0.08) return; // algunas sucursales no manejan todos
    for (const alm of ['General', 'Cocina']) { void alm;
      const ex = Math.round(seed(id, i + (alm === 'Cocina' ? 50 : 0)) * 40 * 100) / 100;
      // Mismo formato que devuelve Wansoft real: sin costo unitario, con Monto total
      rows += `<Table><CodigoProducto>${c}</CodigoProducto><Producto>${esc(n)}</Producto><UnidadDeMedida>${u}</UnidadDeMedida><Departamento>${esc(d)}</Departamento><Existencia>${ex.toFixed(4)}</Existencia><Monto>${(ex * cost).toFixed(4)}</Monto></Table>`;
    }
  });
  return `<NewDataSet>${rows}</NewDataSet>`;
}

function entradas(id, fecha) {
  const day = Number(fecha.slice(8, 10));
  let rows = '';
  PRODUCTOS.slice(0, 4).forEach(([c, n], i) => {
    rows += `<Table><IdEntrada>${id * 1000 + day * 10 + i}</IdEntrada><Codigo>${c}</Codigo><Descripcion>${esc(n)}</Descripcion><Cantidad>${5 + i}</Cantidad><TipoEntrada>${i === 3 ? 7 : 13}</TipoEntrada><Proveedor>Distribuidora Norte</Proveedor><Fecha>${fecha}</Fecha></Table>`;
  });
  return `<NewDataSet>${rows}</NewDataSet>`;
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', d => (body += d));
  req.on('end', () => {
    const method = (req.headers.soapaction || '').replace(/"/g, '').split('/').pop();
    const g = t => (body.match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1];
    const id = Number(g('subsidiaryId'));
    const ok = g('pwdWebService') === `demo${id}`;
    let result;
    if (!ok) result = 'Credenciales incorrectas';
    else if (method === 'GetInventory_Xml') result = inventario(id);
    else if (method === 'GetInputInventory_Xml') result = entradas(id, g('operationdate'));
    else result = '<NewDataSet></NewDataSet>';
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
    res.end(`<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method}Response xmlns="http://tempuri.org/"><${method}Result>${esc(result)}</${method}Result></${method}Response></soap:Body></soap:Envelope>`);
  });
}).listen(4100, () => console.log('Wansoft simulado en :4100'));
