const path = require('path');
const express = require('express');
const { migrate, pool } = require('./db');
const auth = require('./auth');
const { programar } = require('./sync');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

app.get('/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.use('/api/auth', auth.router);
app.use('/api/sucursales', auth.requireAuth, require('./routes/sucursales'));
app.use('/api/inventario', auth.requireAuth, require('./routes/inventario'));
app.use('/api/ajustes', auth.requireAuth, require('./routes/ajustes'));
app.use('/api/ordenes', auth.requireAuth, require('./routes/ordenes'));
app.use('/api', auth.requireAuth, require('./routes/admin'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: '5m' }));

// Errores: mensajes claros para el usuario, detalle en el log
app.use((e, req, res, next) => {
  if (!e.status) console.error(e);
  res.status(e.status || 500).json({ error: e.status ? e.message : 'Ocurrió un error en el servidor. Intenta de nuevo.' });
});

const PORT = process.env.PORT || 3000;
(async () => {
  await migrate();
  await auth.asegurarAdmin();
  programar();
  app.listen(PORT, () => console.log(`Pedidos Mozzarella Express en puerto ${PORT}`));
})().catch(e => { console.error(e); process.exit(1); });
