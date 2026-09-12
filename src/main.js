'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, ipcMain, protocol, net, session, nativeTheme, Menu, Tray, Notification, safeStorage, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const { loadConfig, saveConfig } = require('./config');
const { SipUA } = require('./sip');
const { CallHistory } = require('./history');
const { Contacts, normalizeNumber } = require('./contacts');
const { importOutlookContacts } = require('./outlook');
const { readContactsCsv } = require('./csvimport');

const PUBLIC = path.join(__dirname, '..', 'public');
const APP_ORIGIN = 'app://phone';
const ICON = path.join(__dirname, '..', 'assets', 'icon.ico');
const ICON_PNG = path.join(__dirname, '..', 'assets', 'icon.png');
const REG_TEXT = { registered: 'Verbunden', registering: 'Verbinde …', unregistering: 'Melde ab …', unregistered: 'Abgemeldet', failed: 'Nicht verbunden' };

// Eigenes Schema statt file://, damit AudioWorklet & Co. in einem sicheren Kontext laufen.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
// Gleiche ID wie build.appId in package.json -> Windows ordnet Fenster, Taskleiste und Benachrichtigungen
// der Startmenü-Verknüpfung zu. Entwicklungsstarts bekommen eine eigene ID, sonst "kapert" electron.exe
// die installierte App (falscher Name/Icon im Startmenü).
app.setAppUserModelId(app.isPackaged ? 'de.rau.sipphone' : 'de.rau.sipphone.dev');

let win = null;
let tray = null;
let cfg = null;
let ua = null;
let history = null;
let contacts = null;
let flashing = false;
let quitting = false;
let stopped = false;
let trayHintShown = false;
let callToast = null;
let updateReady = null; // Version eines heruntergeladenen Updates

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

function updateTray(s) {
  if (!tray) return;
  const text = s.call ? 'Im Gespräch' : REG_TEXT[s.registration.state] || s.registration.state;
  tray.setToolTip(`SIP Phone – ${text}`);
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
  if (ua.call) ua.emitState();
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
    if (win.isMinimized()) win.restore();
    win.showInactive();
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
    body: name ? `${name} (${number})` : number,
    icon: ICON_PNG,
    silent: true, // Klingelton spielt die App selbst auf dem gewählten Klingelgerät
    timeoutType: 'never',
    urgency: 'critical',
    actions: [{ type: 'button', text: 'Annehmen' }, { type: 'button', text: 'Ablehnen' }],
  });
  callToast.on('action', (details, index) => {
    const action = details && details.actionIndex !== undefined ? details.actionIndex : index;
    if (action === 0) {
      ua.answer();
      showWindow();
    } else if (action === 1) {
      ua.reject();
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
  const n = new Notification({ title: 'Verpasster Anruf', body, icon: ICON_PNG });
  n.on('click', () => {
    showWindow();
    send('phone:showHistory');
  });
  n.show();
}

// Zugangsdaten: Passwort und HA1-Hash (aus Linphone) gelten beide als Passwort fürs SIP-Konto.
const SECRET_FIELDS = ['password', 'ha1'];

// config.json schreiben; Zugangsdaten nur verschlüsselt (Windows DPAPI), nie im Klartext.
function persist() {
  const stored = { ...cfg };
  if (safeStorage.isEncryptionAvailable()) {
    for (const field of SECRET_FIELDS) {
      delete stored[`${field}Enc`];
      if (!cfg[field]) continue;
      stored[`${field}Enc`] = safeStorage.encryptString(cfg[field]).toString('base64');
      stored[field] = '';
    }
  }
  saveConfig(stored);
}

// Verschlüsselte Zugangsdaten entschlüsseln; noch im Klartext gespeicherte (ältere Versionen,
// frischer Linphone-Import) sofort verschlüsselt neu speichern.
function loadSecrets() {
  if (!safeStorage.isEncryptionAvailable()) return;
  let plaintext = false;
  for (const field of SECRET_FIELDS) {
    const encrypted = cfg[`${field}Enc`];
    if (encrypted) {
      try {
        cfg[field] = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      } catch (err) {
        console.error(`${field} konnte nicht entschlüsselt werden:`, err.message);
      }
    } else if (cfg[field]) {
      plaintext = true;
    }
  }
  if (plaintext) persist();
}

function accountInfo() {
  return {
    displayName: cfg.displayName,
    username: cfg.username,
    domain: cfg.domain,
    authUsername: cfg.authUsername,
    proxy: cfg.proxy,
    proxyPort: cfg.proxyPort,
    hasCredentials: !!(cfg.password || cfg.ha1),
  };
}

async function saveAccount(data) {
  const field = (name) => String(data[name] || '').trim();
  const username = field('username');
  const domain = field('domain');
  if (!username || !domain) return { error: 'Benutzername und Server sind Pflichtfelder.' };
  if (ua.call) return { error: 'Während eines Gesprächs nicht möglich.' };
  const authUsername = field('authUsername');
  const changes = {
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
    const sameUser = (authUsername || username) === (cfg.authUsername || cfg.username);
    if (!sameUser || !(cfg.password || cfg.ha1)) return { error: 'Bitte das Passwort eingeben.' };
  }
  await ua.reconfigure(changes);
  persist();
  return { account: accountInfo() };
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
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = info.version;
    console.log(`Update ${info.version} bereit`);
    send('phone:update', updateReady);
  });
  autoUpdater.on('error', (err) => console.error('Update-Fehler:', err.message));
  const check = () => autoUpdater.checkForUpdates().catch(() => {}); // Fehler meldet das 'error'-Event
  check();
  setInterval(check, UPDATE_INTERVAL_MS);
}

async function installUpdate() {
  if (!updateReady) return null;
  if (ua.call) return { error: 'Bitte erst das Gespräch beenden.' };
  quitting = true;
  await ua.stop(); // sauber abmelden, bevor der Installer die App beendet
  stopped = true;
  autoUpdater.quitAndInstall(true, true); // still installieren, danach neu starten
  return null;
}

async function runCommand(msg) {
  try {
    if (msg.type === 'dial') await ua.dial(String(msg.target || ''));
    else if (msg.type === 'answer') ua.answer();
    else if (msg.type === 'hangup') ua.hangup();
    else if (msg.type === 'dtmf') ua.sendDtmf(String(msg.digit || ''));
    else if (msg.type === 'register') await ua.register();
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

    cfg = loadConfig(app.getPath('userData'));
    loadSecrets();
    history = new CallHistory(app.getPath('userData'));
    contacts = new Contacts(app.getPath('userData'));
    ua = new SipUA(cfg);
    ua.on('state', (raw) => {
      const s = withContactName(raw);
      send('phone:state', s);
      attention(s.call);
      updateTray(s);
    });
    ua.on('ended', (reason, call) => {
      send('phone:ended', reason);
      const entry = history.add(reason, call);
      send('phone:historyChanged', historyView());
      if (entry.status === 'missed') notifyMissed(entry);
    });
    ua.on('audio', (pcm) => send('phone:audio', pcm));

    ipcMain.handle('phone:state', () => withContactName(ua.snapshot()));
    ipcMain.handle('phone:command', (_e, msg) => runCommand(msg));
    ipcMain.on('phone:audio', (_e, pcm) => ua.pushAudio(pcm));
    ipcMain.handle('phone:getAudio', () => cfg.audio);
    ipcMain.handle('phone:setAudio', (_e, audio) => {
      cfg.audio = { ...cfg.audio, ...audio };
      persist();
    });
    ipcMain.handle('phone:getAccount', () => accountInfo());
    ipcMain.handle('phone:saveAccount', (_e, data) => saveAccount(data));
    ipcMain.handle('phone:getRingtone', () => ringtoneData());
    ipcMain.handle('phone:chooseRingtone', () => chooseRingtone());
    ipcMain.handle('phone:resetRingtone', () => resetRingtone());
    ipcMain.handle('phone:version', () => app.getVersion());
    ipcMain.handle('phone:getUpdate', () => updateReady);
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
    await ua.start();
    setupUpdater();
  });

  // Vor dem Beenden sauber beim Server abmelden.
  app.on('before-quit', (e) => {
    quitting = true;
    if (stopped || !ua) return;
    e.preventDefault();
    ua.stop().finally(() => {
      stopped = true;
      app.quit();
    });
  });
  app.on('window-all-closed', () => app.quit());
  process.on('SIGINT', () => app.quit());
}
