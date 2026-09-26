'use strict';
const crypto = require('crypto');

// Verschlüsselte Sicherung aller Daten (Konten samt Zugangsdaten, Kontakte, Kurzwahl, Verlauf,
// Einstellungen), um sie auf einem anderen SIP Phone wieder einzuspielen. Schlüssel per scrypt aus
// einem frei gewählten Passwort, Inhalt mit AES-256-GCM (erkennt auch jede Veränderung der Datei).
const FORMAT = 'sipphone-backup';
const VERSION = 1;
const KDF = { N: 2 ** 16, r: 8, p: 1 };
const MIN_PASSWORD = 8;
const MAX_FILE = 64 * 1024 * 1024;

function deriveKey(password, salt, { N, r, p }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 32, { N, r, p, maxmem: 256 * N * r }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// Kopfdaten gehen als AAD in die Verschlüsselung ein – verändern macht die Datei unlesbar.
function header(kdf, salt, iv) {
  return { format: FORMAT, version: VERSION, kdf: { name: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, salt: salt.toString('base64') }, iv: iv.toString('base64') };
}

async function encryptBackup(payload, password) {
  if (String(password || '').length < MIN_PASSWORD) throw new Error(`Das Passwort braucht mindestens ${MIN_PASSWORD} Zeichen.`);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const head = header(KDF, salt, iv);
  const key = await deriveKey(password, salt, KDF);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(head)));
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.from(JSON.stringify({ ...head, tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), 'utf8');
}

async function decryptBackup(buffer, password) {
  if (buffer.length > MAX_FILE) throw new Error('Die Datei ist zu groß für eine SIP-Phone-Sicherung.');
  let file;
  try {
    file = JSON.parse(buffer.toString('utf8'));
  } catch {
    file = null;
  }
  if (!file || file.format !== FORMAT) throw new Error('Das ist keine SIP-Phone-Sicherung.');
  if (file.version !== VERSION) throw new Error('Diese Sicherung stammt von einer neueren SIP-Phone-Version – bitte erst aktualisieren.');
  const kdf = file.kdf || {};
  // Nur plausible scrypt-Werte zulassen, sonst könnte eine präparierte Datei Speicher/Zeit ausreizen.
  if (kdf.name !== 'scrypt' || ![2 ** 14, 2 ** 15, 2 ** 16, 2 ** 17].includes(kdf.N) || kdf.r !== 8 || kdf.p !== 1) {
    throw new Error('Die Sicherung ist beschädigt (unbekannte Verschlüsselungsparameter).');
  }
  const salt = Buffer.from(String(kdf.salt || ''), 'base64');
  const iv = Buffer.from(String(file.iv || ''), 'base64');
  const tag = Buffer.from(String(file.tag || ''), 'base64');
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new Error('Die Sicherung ist beschädigt.');
  const key = await deriveKey(password, salt, kdf);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(JSON.stringify(header(kdf, salt, iv))));
  decipher.setAuthTag(tag);
  let text;
  try {
    text = Buffer.concat([decipher.update(Buffer.from(String(file.data || ''), 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Falsches Passwort oder die Datei wurde verändert.');
  }
  return JSON.parse(text);
}

module.exports = { encryptBackup, decryptBackup, MIN_PASSWORD };
