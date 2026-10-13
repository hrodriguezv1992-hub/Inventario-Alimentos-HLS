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

// El empleado solo captura conteos a ciegas: no ve inventario, órdenes ni ajustes
const noEmpleado = (req, res, next) => req.user.rol === 'empleado'
  ? res.status(403).json({ error: 'Tu usuario solo puede capturar conteos' }) : next();

app.use('/api/auth', auth.router);
app.use('/api/conteos', auth.requireAuth, require('./routes/conteos'));
app.use('/api/sucursales', auth.requireAuth, noEmpleado, require('./routes/sucursales'));
app.use('/api/inventario', auth.requireAuth, noEmpleado, require('./routes/inventario'));
app.use('/api/ajustes', auth.requireAuth, noEmpleado, require('./routes/ajustes'));
app.use('/api/ordenes', auth.requireAuth, noEmpleado, require('./routes/ordenes'));
app.use('/api', auth.requireAuth, noEmpleado, require('./routes/admin'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

app.use(express.static(path.join(__dirname, '..', 'public'), {
  index: 'index.html', maxAge: '1h',
  // La página y el service worker siempre se revisan, para que las actualizaciones lleguen al instante
  setHeaders: (res, file) => { if (/\.(html|webmanifest)$|sw\.js$/.test(file)) res.setHeader('Cache-Control', 'no-cache'); },
}));

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
