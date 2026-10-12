const { pool, tx, log } = require('./db');
const wansoft = require('./wansoft');

let corriendo = null;

async function syncSucursal(suc, usuarioId) {
  try {
    const filas = await wansoft.inventario(suc);
    await tx(async c => {
      await c.query('DELETE FROM inventario WHERE sucursal_id=$1', [suc.id]);
      // Inserción por lotes
      for (let i = 0; i < filas.length; i += 500) {
        const lote = filas.slice(i, i + 500);
        const vals = [];
        const ph = lote.map((f, j) => {
          vals.push(suc.id, f.codigo, f.nombre, f.unidad, f.departamento, f.existencia, f.costo);
          const b = j * 7;
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
        });
        await c.query(`INSERT INTO inventario (sucursal_id,codigo,nombre,unidad,departamento,existencia,costo)
          VALUES ${ph.join(',')} ON CONFLICT (sucursal_id,codigo) DO UPDATE SET existencia=inventario.existencia+EXCLUDED.existencia`, vals);
      }
      await c.query('UPDATE sucursales SET ultimo_sync=NOW(), ultimo_error=NULL WHERE id=$1', [suc.id]);
    });
    return { sucursal: suc.nombre, ok: true, productos: filas.length };
  } catch (e) {
    await pool.query('UPDATE sucursales SET ultimo_error=$1 WHERE id=$2', [e.message.slice(0, 500), suc.id]);
    if (!(e instanceof wansoft.WansoftError)) console.error('Sync', suc.nombre, e);
    return { sucursal: suc.nombre, ok: false, error: e.message };
  } finally {
    if (usuarioId !== undefined) await log(usuarioId, 'sync_sucursal', { sucursal: suc.nombre });
  }
}

// Sincroniza todas las sucursales con claves, 4 a la vez
async function syncTodas(usuarioId = null) {
  if (corriendo) return corriendo;
  corriendo = (async () => {
    const { rows } = await pool.query(
      `SELECT * FROM sucursales WHERE activa AND wansoft_id IS NOT NULL AND wansoft_pwd_enc IS NOT NULL ORDER BY nombre`);
    const resultados = [];
    let i = 0;
    const worker = async () => {
      while (i < rows.length) {
        const suc = rows[i++];
        resultados.push(await syncSucursal(suc));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
    await log(usuarioId, 'sync_todas', { ok: resultados.filter(r => r.ok).length, error: resultados.filter(r => !r.ok).length });
    return resultados;
  })();
  try { return await corriendo; } finally { corriendo = null; }
}

function estaCorriendo() { return !!corriendo; }

function programar() {
  const min = Number(process.env.SYNC_MINUTES || 60);
  if (!min || min < 5) return;
  setInterval(() => syncTodas().catch(e => console.error('Sync programado', e)), min * 60 * 1000);
  console.log(`Sincronización automática cada ${min} minutos`);
}

module.exports = { syncSucursal, syncTodas, programar, estaCorriendo };
