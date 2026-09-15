'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, ipcMain, protocol, net, session, nativeTheme, Menu, Tray, Notification, safeStorage, dialog, powerMonitor, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const logger = require('./logger');
const { loadConfig, saveConfig, normalizeConfig, ACCOUNT_DEFAULTS } = require('./config');
const { Phone } = require('./phone');
const { CallHistory } = require('./history');
const { Contacts, normalizeNumber } = require('./contacts');
const { importOutlookContacts } = require('./outlook');
const { readContactsCsv } = require('./csvimport');

const PUBLIC = path.join(__dirname, '..', 'public');
const APP_ORIGIN = 'app://phone';
const ICON = path.join(__dirname, '..', 'assets', 'icon.ico');
const ICON_PNG = path.join(__dirname, '..', 'assets', 'icon.png');
const REG_TEXT = { registered: 'Verbunden', registering: 'Verbinde …', unregistering: 'Melde ab …', unregistered: 'Abgemeldet', failed: 'Nicht verbunden', locked: 'Abgemeldet (PC gesperrt)', elsewhere: 'An anderem Gerät angemeldet' };

// Eigenes Schema statt file://, damit AudioWorklet & Co. in einem sicheren Kontext laufen.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
// Gleiche ID wie build.appId in package.json -> Windows ordnet Fenster, Taskleiste und Benachrichtigungen
// der Startmenü-Verknüpfung zu. Entwicklungsstarts bekommen eine eigene ID, sonst "kapert" electron.exe
// die installierte App (falscher Name/Icon im Startmenü).
app.setAppUserModelId(app.isPackaged ? 'de.rau.sipphone' : 'de.rau.sipphone.dev');

let win = null;
let tray = null;
let cfg = null;
let phone = null; // alle Konten (src/phone.js)
let history = null;
let contacts = null;
let flashing = false;
let quitting = false;
let stopped = false;
let trayHintShown = false;
let callToast = null;
let updateReady = null; // Version eines heruntergeladenen Updates
let updateNotes = ''; // Beschreibung des Updates (GitHub-Release-Text)
let logFile = null;
let screenLocked = false;

const UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000;

function createWindow() {
  win = new BrowserWindow({
    width: 400,
    height: 800,
    minWidth: 360,
    minHeight: 740,
    title: 'SIP Phone',
    icon: ICON,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.loadURL('app://phone/index.html');
  // Das Fenster zeigt nur die eigene Oberfläche: keine neuen Fenster, keine Navigation woandershin.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_ORIGIN)) e.preventDefault();
  });
  // Minimieren und Schließen legen die App ins Tray – sie bleibt erreichbar. Beenden über das Tray-Menü.
  win.on('minimize', hideToTray);
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    hideToTray();
  });
  win.on('closed', () => (win = null));
}

function createTray() {
  tray = new Tray(ICON);
  tray.setToolTip('SIP Phone');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Öffnen', click: showWindow },
    { type: 'separator' },
    { label: 'Beenden', click: () => app.quit() },
  ]));
  tray.on('click', showWindow);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function hideToTray() {
  win.hide();
  if (trayHintShown) return;
  trayHintShown = true;
  tray.displayBalloon({ icon: ICON_PNG, title: 'SIP Phone läuft weiter', content: 'Du bleibst erreichbar. Beenden über das Tray-Symbol.' });
}

function connectionSummary(accounts) {
  if (!accounts.length) return 'Kein Konto';
  const registered = accounts.filter((a) => a.state === 'registered').length;
  if (registered === accounts.length) return 'Verbunden';
  if (registered) return `${registered} von ${accounts.length} verbunden`;
  return accounts.length === 1 ? REG_TEXT[accounts[0].state] || accounts[0].state : 'Nicht verbunden';
}

function updateTray(s) {
  if (!tray) return;
  tray.setToolTip(`SIP Phone – ${s.call ? 'Im Gespräch' : connectionSummary(s.accounts)}`);
}

// Bei mehreren Konten steht in Benachrichtigungen, welches Konto gemeint ist.
function accountHint(label) {
  return phone.lines.length > 1 && label ? `\nfür ${label}` : '';
}

// Gesperrter PC = nicht am Platz: abmelden, damit ein vergessenes SIP Phone (z. B. im Büro) nicht die
// Anmeldung eines anderen Geräts (Homeoffice) zurückholt. Ein laufendes Gespräch geht vor.
function applyScreenLock() {
  if (screenLocked && cfg.lockUnregister && !phone.call) phone.lock();
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

// --- Telefonbuch: Namen aus dem Telefonbuch haben Vorrang vor dem Namen, den die Anlage schickt ---

function withContactName(state) {
  return state.call ? { ...state, call: { ...state.call, contactName: contacts.lookup(state.call.remoteUri) } } : state;
}

function historyView() {
  return history.entries.map((e) => ({ ...e, contactName: contacts.lookup(e.remoteUri) }));
}

function contactsView() {
  return contacts.entries.map((c) => ({ ...c, numbers: c.numbers.map((n) => ({ ...n, dial: normalizeNumber(n.number) })) }));
}

function contactsChanged() {
  send('phone:contactsChanged', contactsView());
  send('phone:historyChanged', historyView());
  if (phone.call) phone.emitState();
}

function mergeImported(found, source) {
  const result = contacts.merge(found, source);
  contactsChanged();
  return { ...result, found: found.length };
}

async function importOutlook() {
  try {
    const found = await importOutlookContacts();
    if (!found.length) {
      return { error: 'Im klassischen Outlook wurden keine Kontakte mit Telefonnummer gefunden. Liegen sie im neuen Outlook oder bei Outlook.com, dort als CSV exportieren und die Datei importieren.' };
    }
    return mergeImported(found, 'outlook');
  } catch (err) {
    return { error: err.message };
  }
}

async function importCsv() {
  const res = await dialog.showOpenDialog(win, {
    title: 'Kontakte-CSV wählen',
    filters: [{ name: 'CSV-Dateien', extensions: ['csv', 'txt'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  try {
    const found = readContactsCsv(res.filePaths[0]);
    if (!found.length) return { error: 'In der Datei wurden keine Kontakte mit Telefonnummer gefunden.' };
    return mergeImported(found, 'csv');
  } catch (err) {
    return { error: err.message };
  }
}

// Bei eingehendem Anruf Fenster hervorholen (auch aus dem Tray) und in der Taskleiste blinken lassen.
function attention(call) {
  if (!win) return;
  const ringing = !!call && call.state === 'incoming';
  if (ringing && !flashing) {
    // Option: sonst reicht die Windows-Meldung mit Annehmen/Ablehnen, das Fenster bleibt, wo es ist
    if (cfg.showOnCall) {
      if (win.isMinimized()) win.restore();
      win.showInactive();
    }
    win.flashFrame(true);
    showCallToast(call);
  } else if (!ringing && flashing) {
    win.flashFrame(false);
    closeCallToast();
  }
  flashing = ringing;
}

// Windows-Benachrichtigung mit Annehmen/Ablehnen; bleibt stehen, bis der Anruf angenommen oder beendet ist.
function showCallToast(call) {
  if (!Notification.isSupported()) return;
  const number = call.remoteUri.replace(/^(sips?|tel):/i, '').split('@')[0];
  const name = call.contactName || call.remoteName;
  callToast = new Notification({
    title: 'Eingehender Anruf',
    body: (name ? `${name} (${number})` : number) + accountHint(call.accountLabel),
    icon: ICON_PNG,
    silent: true, // Klingelton spielt die App selbst auf dem gewählten Klingelgerät
    timeoutType: 'never',
    urgency: 'critical',
    actions: [{ type: 'button', text: 'Annehmen' }, { type: 'button', text: 'Ablehnen' }],
  });
  callToast.on('action', (details, index) => {
    const action = details && details.actionIndex !== undefined ? details.actionIndex : index;
    if (action === 0) {
      phone.answer();
      if (cfg.showOnCall) showWindow(); // sonst bleibt das Fenster, wo es ist (Klick auf die Meldung öffnet es)
    } else if (action === 1) {
      phone.reject();
    }
  });
  callToast.on('click', showWindow);
  callToast.show();
}

function closeCallToast() {
  if (!callToast) return;
  callToast.close();
  callToast = null;
}

function notifyMissed(entry) {
  if (!Notification.isSupported() || (win && win.isVisible() && win.isFocused())) return;
  const body = contacts.lookup(entry.remoteUri) || entry.remoteName || entry.remoteUri.replace(/^(sips?|tel):/i, '').split('@')[0];
  const n = new Notification({ title: 'Verpasster Anruf', body: body + accountHint(entry.accountLabel), icon: ICON_PNG });
  n.on('click', () => {
    showWindow();
    send('phone:showHistory');
  });
  n.show();
}

// Zugangsdaten: Passwort und HA1-Hash (aus Linphone) gelten beide als Passwort fürs SIP-Konto.
const SECRET_FIELDS = ['password', 'ha1'];

function encryptAccount(account) {
  const stored = { ...account };
  for (const field of SECRET_FIELDS) {
    delete stored[`${field}Enc`];
    if (!account[field]) continue;
    stored[`${field}Enc`] = safeStorage.encryptString(account[field]).toString('base64');
    stored[field] = '';
  }
  return stored;
}

// config.json schreiben; Zugangsdaten aller Konten nur verschlüsselt (Windows DPAPI), nie im Klartext.
function persist() {
  const stored = { ...cfg };
  if (safeStorage.isEncryptionAvailable()) stored.accounts = cfg.accounts.map(encryptAccount);
  saveConfig(stored);
}

// Verschlüsselte Zugangsdaten entschlüsseln; noch im Klartext gespeicherte (ältere Versionen,
// frischer Linphone-Import) sofort verschlüsselt neu speichern.
function loadSecrets() {
  if (!safeStorage.isEncryptionAvailable()) return;
  let plaintext = false;
  for (const account of cfg.accounts) {
    for (const field of SECRET_FIELDS) {
      const encrypted = account[`${field}Enc`];
      if (encrypted) {
        try {
          account[field] = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
        } catch (err) {
          console.error(`${account.label}: ${field} konnte nicht entschlüsselt werden:`, err.message);
        }
      } else if (account[field]) {
        plaintext = true;
      }
    }
  }
  if (plaintext) persist();
}

// Konten fürs Fenster – ohne Zugangsdaten.
function accountsView() {
  return cfg.accounts.map((a) => ({
    id: a.id,
    label: a.label,
    displayName: a.displayName,
    username: a.username,
    domain: a.domain,
    authUsername: a.authUsername,
    proxy: a.proxy,
    proxyPort: a.proxyPort,
    hasCredentials: !!(a.password || a.ha1),
  }));
}

// Legt ein Konto an (ohne id) oder ändert ein bestehendes.
async function saveAccount(data) {
  const field = (name) => String(data[name] || '').trim();
  const username = field('username');
  const domain = field('domain');
  if (!username || !domain) return { error: 'Benutzername und Server sind Pflichtfelder.' };
  if (phone.call) return { error: 'Während eines Gesprächs nicht möglich.' };
  const existing = cfg.accounts.find((a) => a.id === data.id);
  const authUsername = field('authUsername');
  const changes = {
    label: field('label') || domain,
    displayName: field('displayName'),
    username,
    domain,
    authUsername,
    proxy: field('proxy') || domain,
    proxyPort: Number(field('proxyPort')) || 5060,
  };
  const password = String(data.password || '');
  if (password) {
    Object.assign(changes, { password, ha1: '', realm: '' });
  } else {
    // Ohne neues Passwort nur, wenn es beim selben Benutzer bleibt und schon Zugangsdaten da sind.
    const sameUser = existing && (authUsername || username) === (existing.authUsername || existing.username);
    if (!sameUser || !(existing.password || existing.ha1)) return { error: 'Bitte das Passwort eingeben.' };
  }
  if (existing) {
    await phone.updateAccount(existing.id, changes);
  } else {
    const account = { ...ACCOUNT_DEFAULTS, ...changes, id: crypto.randomUUID() };
    cfg.accounts.push(account);
    await phone.addAccount(account);
  }
  persist();
  return { accounts: accountsView() };
}

async function deleteAccount(id) {
  if (phone.call) return { error: 'Während eines Gesprächs nicht möglich.' };
  await phone.removeAccount(id); // meldet vorher ab
  cfg.accounts = cfg.accounts.filter((a) => a.id !== id);
  persist();
  return { accounts: accountsView() };
}

// Eigener Klingelton: wird in den App-Ordner kopiert, damit er auch nach Verschieben des Originals klingelt.
const RINGTONE_TYPES = ['wav', 'mp3', 'ogg', 'm4a', 'flac'];
const RINGTONE_MAX_BYTES = 10 * 1024 * 1024;

function ringtonePath() {
  return cfg.ringtone ? path.join(app.getPath('userData'), cfg.ringtone.file) : null;
}

function resetRingtone() {
  if (cfg.ringtone) fs.rmSync(ringtonePath(), { force: true });
  cfg.ringtone = null;
  persist();
}

async function chooseRingtone() {
  const res = await dialog.showOpenDialog(win, {
    title: 'Klingelton wählen',
    filters: [{ name: 'Audiodateien', extensions: RINGTONE_TYPES }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const src = res.filePaths[0];
  if (fs.statSync(src).size > RINGTONE_MAX_BYTES) return { error: 'Die Datei ist zu groß (max. 10 MB).' };
  const file = `ringtone${path.extname(src).toLowerCase()}`;
  const data = fs.readFileSync(src);
  if (cfg.ringtone) fs.rmSync(ringtonePath(), { force: true });
  fs.writeFileSync(path.join(app.getPath('userData'), file), data);
  cfg.ringtone = { file, name: path.basename(src) };
  persist();
  return { name: cfg.ringtone.name };
}

function ringtoneData() {
  if (!cfg.ringtone) return null;
  try {
    return { name: cfg.ringtone.name, data: fs.readFileSync(ringtonePath()) };
  } catch {
    return null;
  }
}

// Updates kommen aus den GitHub-Releases (build.publish in package.json). Nur in der installierten App.
function setupUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) => console.log(`Update ${info.version} verfügbar, lade herunter …`));
  autoUpdater.on('update-not-available', () => console.log('Kein Update verfügbar'));
  autoUpdater.on('update-downloaded', async (info) => {
    updateReady = info.version;
    updateNotes = await fetchReleaseNotes(info.version).catch(() => '');
    console.log(`Update ${info.version} bereit`);
    send('phone:update', { version: updateReady, notes: updateNotes });
  });
  autoUpdater.on('error', (err) => console.error('Update-Fehler:', err.message));
  const check = () => autoUpdater.checkForUpdates().catch(() => {}); // Fehler meldet das 'error'-Event
  check();
  setInterval(check, UPDATE_INTERVAL_MS);
}

// Beschreibung des Releases (der „Body“ auf der GitHub-Release-Seite) für die aufklappbaren Details.
function fetchReleaseNotes(version) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url: `https://api.github.com/repos/mraudev/sipphone/releases/tags/v${version}`, headers: { 'User-Agent': 'sipphone', Accept: 'application/vnd.github+json' } });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(String(JSON.parse(body).body || '').trim());
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function installUpdate() {
  if (!updateReady) return null;
  if (phone.call) return { error: 'Bitte erst das Gespräch beenden.' };
  quitting = true;
  await phone.stop(); // sauber abmelden, bevor der Installer die App beendet
  stopped = true;
  autoUpdater.quitAndInstall(true, true); // still installieren, danach neu starten
  return null;
}

async function runCommand(msg) {
  try {
    if (msg.type === 'dial') await phone.dial(String(msg.target || ''), msg.accountId);
    else if (msg.type === 'answer') phone.answer();
    else if (msg.type === 'hangup') phone.hangup();
    else if (msg.type === 'dtmf') phone.sendDtmf(String(msg.digit || ''));
    else if (msg.type === 'register') await phone.register();
    return null;
  } catch (err) {
    return { error: err.message };
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    logFile = logger.setup(app.getPath('userData'));
    console.log(`SIP Phone ${app.getVersion()} gestartet`);
    nativeTheme.themeSource = 'dark';
    Menu.setApplicationMenu(null);
    protocol.handle('app', (req) => {
      const file = path.join(PUBLIC, path.normalize(decodeURIComponent(new URL(req.url).pathname)));
      if (!file.startsWith(PUBLIC + path.sep)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    });
    // Mikrofon nur für die eigene Oberfläche, alle anderen Berechtigungen nie.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
      cb(permission === 'media' && String(details && details.requestingUrl).startsWith(APP_ORIGIN));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permission === 'media' && String(origin).startsWith(APP_ORIGIN));

    cfg = normalizeConfig(loadConfig(app.getPath('userData')));
    loadSecrets();
    history = new CallHistory(app.getPath('userData'));
    contacts = new Contacts(app.getPath('userData'));
    phone = new Phone(cfg.accounts);
    phone.setHdVoice(cfg.hdVoice);
    phone.on('format', (fmt) => send('phone:audioFormat', fmt));
    phone.on('state', (raw) => {
      const s = withContactName(raw);
      send('phone:state', s);
      attention(s.call);
      updateTray(s);
    });
    phone.on('ended', (reason, call) => {
      send('phone:ended', reason);
      const entry = history.add(reason, call);
      send('phone:historyChanged', historyView());
      if (entry.status === 'missed') notifyMissed(entry);
      applyScreenLock();
    });
    powerMonitor.on('lock-screen', () => {
      screenLocked = true;
      applyScreenLock();
    });
    powerMonitor.on('unlock-screen', () => {
      screenLocked = false;
      phone.unlock();
    });
    phone.on('audio', (pcm) => send('phone:audio', pcm));

    ipcMain.handle('phone:state', () => withContactName(phone.snapshot()));
    ipcMain.handle('phone:command', (_e, msg) => runCommand(msg));
    ipcMain.on('phone:audio', (_e, pcm) => phone.pushAudio(pcm));
    ipcMain.handle('phone:getAudio', () => cfg.audio);
    ipcMain.handle('phone:setAudio', (_e, audio) => {
      cfg.audio = { ...cfg.audio, ...audio };
      persist();
    });
    ipcMain.handle('phone:getOptions', () => ({ lockUnregister: cfg.lockUnregister, showOnCall: cfg.showOnCall, micProcessing: cfg.micProcessing, hdVoice: cfg.hdVoice }));
    ipcMain.handle('phone:setOptions', (_e, options) => {
      for (const key of ['lockUnregister', 'showOnCall', 'micProcessing', 'hdVoice']) {
        if (typeof options[key] === 'boolean') cfg[key] = options[key];
      }
      if (typeof options.hdVoice === 'boolean') phone.setHdVoice(options.hdVoice);
      persist();
    });
    ipcMain.handle('phone:accounts', () => accountsView());
    ipcMain.handle('phone:saveAccount', (_e, data) => saveAccount(data));
    ipcMain.handle('phone:deleteAccount', (_e, id) => deleteAccount(id));
    ipcMain.handle('phone:getRingtone', () => ringtoneData());
    ipcMain.handle('phone:chooseRingtone', () => chooseRingtone());
    ipcMain.handle('phone:resetRingtone', () => resetRingtone());
    ipcMain.handle('phone:version', () => app.getVersion());
    ipcMain.handle('phone:openLog', () => shell.showItemInFolder(logFile));
    ipcMain.handle('phone:getUpdate', () => (updateReady ? { version: updateReady, notes: updateNotes } : null));
    ipcMain.handle('phone:installUpdate', () => installUpdate());
    ipcMain.handle('phone:history', () => historyView());
    ipcMain.handle('phone:clearHistory', () => {
      history.clear();
      send('phone:historyChanged', historyView());
    });
    ipcMain.handle('phone:contacts', () => contactsView());
    ipcMain.handle('phone:saveContact', (_e, data) => {
      try {
        contacts.upsert(data);
        contactsChanged();
        return null;
      } catch (err) {
        return { error: err.message };
      }
    });
    ipcMain.handle('phone:deleteContact', (_e, id) => {
      contacts.remove(id);
      contactsChanged();
    });
    ipcMain.handle('phone:importOutlook', () => importOutlook());
    ipcMain.handle('phone:importCsv', () => importCsv());

    createTray();
    createWindow();
    await phone.start();
    setupUpdater();
  });

  // Vor dem Beenden sauber beim Server abmelden.
  app.on('before-quit', (e) => {
    quitting = true;
    if (stopped || !phone) return;
    e.preventDefault();
    phone.stop().finally(() => {
      stopped = true;
      app.quit();
    });
  });
  app.on('window-all-closed', () => app.quit());
  process.on('SIGINT', () => app.quit());
}
