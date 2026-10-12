// Cifra las contraseñas de Wansoft antes de guardarlas en la base de datos.
const crypto = require('crypto');

function key() {
  const k = process.env.ENCRYPTION_KEY;
  if (!k || k.length < 16) throw new Error('Falta ENCRYPTION_KEY (mínimo 16 caracteres)');
  return crypto.createHash('sha256').update(k).digest();
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}

function decrypt(payload) {
  if (!payload) return null;
  const [iv, tag, enc] = payload.split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
