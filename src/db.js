const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Acepta DATABASE_URL o SUPABASE_URL (Session pooler de Supabase, puerto 5432)
const connectionString = process.env.SUPABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Falta la variable SUPABASE_URL (o DATABASE_URL) con la conexión a Supabase');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
  max: 10,
});

const SUCURSALES_INICIALES = [
  'Agujita', 'Castaños', 'CEDIS - Mozarella', 'Frontera Centro', 'Frontera Occidental',
  'Hipódromo', 'Juárez', 'Mon Centro', 'Monkeys', 'Mozarella Pizza - HEB',
  'Mozarella Pizza - Palau', 'Mozarellas Pizza - Obregón', 'Muzquiz', 'Nueva Rosita',
  'PTG - Arteaga', 'PTG - Bellavista', 'PTG - CEDIS SALTILLO', 'PTG - Guayulera',
  'PTG - Lourdes', 'PTG - Manantiales', 'PTG - Mi Plaza', 'PTG - Sendero Sur',
  'Rosita 2', 'Sabinas', 'Sabinas Burger - Centro', 'San Buena',
];

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM sucursales');
  if (rows[0].n === 0) {
    for (const nombre of SUCURSALES_INICIALES) {
      await pool.query('INSERT INTO sucursales (nombre) VALUES ($1) ON CONFLICT DO NOTHING', [nombre]);
    }
  }
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function log(usuarioId, accion, detalle) {
  await pool.query('INSERT INTO bitacora (usuario_id, accion, detalle) VALUES ($1,$2,$3)',
    [usuarioId || null, accion, detalle ? JSON.stringify(detalle) : null]);
}

async function getConfig(clave, def = null) {
  const { rows } = await pool.query('SELECT valor FROM ajustes_config WHERE clave=$1', [clave]);
  return rows[0] ? rows[0].valor : def;
}
async function setConfig(clave, valor) {
  await pool.query(`INSERT INTO ajustes_config (clave, valor) VALUES ($1,$2)
    ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor`, [clave, JSON.stringify(valor)]);
}

module.exports = { pool, migrate, tx, log, getConfig, setConfig };
