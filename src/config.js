'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Hier wird beim ersten Start nach Linphone-Einstellungen gesucht (installiertes Linphone zuerst).
const LINPHONE_FILES = [
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'linphone', 'linphonerc'),
  process.env.APPDATA && path.join(process.env.APPDATA, 'linphone', 'linphonerc'),
  path.join(ROOT, 'settings_lp'),
].filter(Boolean);

let configFile = null;

// Ein SIP-Konto; es kann mehrere geben (cfg.accounts), alle sind gleichzeitig angemeldet.
const ACCOUNT_DEFAULTS = {
  id: '',
  label: '', // frei wählbar, z. B. "Firma" oder "Privat"
  displayName: '',
  username: '',
  domain: '',
  authUsername: '',
  realm: '',
  ha1: '',
  password: '',
  proxy: '',
  proxyPort: 5060,
  expires: 600,
};
const ACCOUNT_KEYS = [...Object.keys(ACCOUNT_DEFAULTS), 'passwordEnc', 'ha1Enc', 'sipPort'];

const DEFAULTS = {
  accounts: [],
  // Gerätenamen wie Windows sie anzeigt; leer = Systemstandard. spk* = Freisprech-Profil, volume = Hörlautstärke.
  audio: { microphone: '', speaker: '', ringer: '', spkMicrophone: '', spkSpeaker: '', volume: 1 },
  ringtone: null, // { file, name } – eigener Klingelton im App-Ordner, null = Standard
  lockUnregister: true, // solange der PC gesperrt ist, bei allen Konten abmelden
  showOnCall: true, // bei eingehendem Anruf das Fenster in den Vordergrund holen (sonst nur Windows-Meldung)
  micProcessing: true, // Rausch-/Echounterdrückung und Pegelautomatik von Windows/Chromium fürs Mikrofon
  hdVoice: true, // G.722 (Breitband) bevorzugt anbieten; fällt automatisch auf G.711 zurück
  theme: 'system', // Darstellung: 'system' | 'light' | 'dark'
  favorites: [], // Kurzwahl: [{ name, number }] – Status per Besetztlampenfeld (BLF), sofern die Anlage es liefert
};

// Bis Version 1.1.3 stand genau ein Konto direkt in der Konfiguration -> wird das erste Konto.
function normalizeConfig(raw) {
  const cfg = { ...DEFAULTS, ...raw, audio: { ...DEFAULTS.audio, ...raw.audio } };
  if (!Array.isArray(raw.accounts)) {
    const legacy = {};
    for (const key of ACCOUNT_KEYS) if (raw[key] !== undefined) legacy[key] = raw[key];
    cfg.accounts = raw.username ? [legacy] : [];
  }
  for (const key of ACCOUNT_KEYS) delete cfg[key];
  cfg.accounts = cfg.accounts.map((a, i) => ({
    ...ACCOUNT_DEFAULTS,
    ...a,
    id: a.id || `konto-${i + 1}`,
    label: a.label || a.domain || `Konto ${i + 1}`,
  }));
  cfg.favorites = Array.isArray(raw.favorites)
    ? raw.favorites.map((f) => ({ name: String(f.name || '').trim(), number: String(f.number || '').trim() })).filter((f) => f.number)
    : [];
  return cfg;
}

// 'WASAPI: Speakers (2- Jabra Link 390) [Unknown]' -> 'Speakers (2- Jabra Link 390)'
function linphoneDevice(id) {
  return (id || '').replace(/^\w+:\s*/, '').replace(/\s*\[[^\]]*\]$/, '');
}

function parseIni(text) {
  const sections = {};
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      current = sections[section[1]] = {};
      continue;
    }
    const i = line.indexOf('=');
    if (current && i > 0) current[line.slice(0, i)] = line.slice(i + 1);
  }
  return sections;
}

function importLinphone(file) {
  const ini = parseIni(fs.readFileSync(file, 'utf8'));
  const proxy = ini.proxy_0 || {};
  const auth = ini.auth_info_0 || {};
  const sound = ini.sound || {};
  const identity = /<sip:([^@>]+)@([^>;]+)>\s*$/.exec(proxy.reg_identity || '');
  const display = /\\"([^\\]+)\\"/.exec(proxy.reg_identity || '');
  const regProxy = /sip:([^;>:]+)(?::(\d+))?/.exec(proxy.reg_proxy || '');
  const domain = identity ? identity[2] : auth.domain;
  return {
    ...DEFAULTS,
    accounts: [{
      ...ACCOUNT_DEFAULTS,
      id: 'konto-1',
      label: domain || 'Konto 1',
      displayName: display ? display[1] : '',
      username: identity ? identity[1] : auth.username,
      domain,
      authUsername: auth.username || '',
      realm: auth.realm || '',
      ha1: auth.ha1 || '',
      proxy: regProxy ? regProxy[1] : auth.domain,
      proxyPort: regProxy && regProxy[2] ? Number(regProxy[2]) : 5060,
      expires: Number(proxy.reg_expires) || ACCOUNT_DEFAULTS.expires,
    }],
    audio: {
      microphone: linphoneDevice(sound.capture_dev_id),
      speaker: linphoneDevice(sound.playback_dev_id),
      ringer: linphoneDevice(sound.ringer_dev_id),
    },
  };
}

// PhonerLite-Konto aus sipper.ini lesen (ohne Passwort – das ist an die AppGUID gebunden verschlüsselt).
// Aktives Konto steht in [Profile] Profile=<Name>, die Daten im gleichnamigen Abschnitt.
function parsePhonerLite(text) {
  const ini = parseIni(text);
  const lower = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const profile = lower(ini.Profile).profile;
  const sectionName = profile && ini[profile] ? profile : Object.keys(ini).find((k) => k.toLowerCase() !== 'profile');
  const acc = lower(ini[sectionName]);
  if (!acc || !acc.username) return null;
  const [username, authUsername] = String(acc.username).split('|');
  const display = /^\s*"([^"]*)"/.exec(acc.displayname || '');
  const gateway = (acc.gateway || '').trim();
  return {
    label: gateway || sectionName || 'PhonerLite',
    displayName: display ? display[1] : '',
    username: (username || '').trim(),
    authUsername: (authUsername || username || '').trim(),
    domain: gateway,
  };
}

// Liest <dir>/config.json; beim ersten Start wird sie aus Linphone importiert (oder leer angelegt).
function loadConfig(dir) {
  configFile = path.join(dir, 'config.json');
  if (fs.existsSync(configFile)) {
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const cfg = normalizeConfig(raw);
    if (!Array.isArray(raw.accounts)) saveConfig(cfg); // altes Einzelkonto-Format umgestellt
    return cfg;
  }
  const linphone = LINPHONE_FILES.find((f) => fs.existsSync(f));
  const cfg = linphone ? importLinphone(linphone) : { ...DEFAULTS };
  fs.mkdirSync(dir, { recursive: true });
  saveConfig(cfg);
  console.log(linphone ? `Konto aus ${linphone} importiert -> ${configFile}` : `Leere Konfiguration angelegt: ${configFile}`);
  return cfg;
}

function saveConfig(cfg) {
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2) + '\n');
}

module.exports = { loadConfig, saveConfig, normalizeConfig, ACCOUNT_DEFAULTS, parsePhonerLite };
