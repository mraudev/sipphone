'use strict';
const net = require('net');
const { EventEmitter } = require('events');

// Anbindung an den CTI-Server der Telefonanlage (optional je Konto): "Nicht stören", "Abwesend",
// Status der anderen Telefone und Teilnehmer von Konferenzen. Protokoll: TCP, je Nachricht
// "<Typname>-<JSON>" + "\0". Client -> Server: Actions, Server -> Client: Events.
const CLIENT_VERSION = '2.0.0.0'; // muss exakt der Protokollversion des Servers entsprechen
const MAX_FRAME = 1024 * 1024; // Schutz: so lange Nachrichten schickt der Server nie
const CONNECT_TIMEOUT_MS = 10000;
const SILENCE_MS = 65000; // Server schickt etwa alle 20 s ein HeartbeatEvent – sonst ist die Verbindung tot
// Server erlaubt höchstens 6 neue Verbindungen je IP in 5 Minuten -> mit Abstand darunter bleiben.
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX = 5;
const BACKOFF_MS = [5000, 15000, 30000, 60000, 120000, 300000];
const STABLE_MS = 60000; // so lange angemeldet = Verbindung galt als stabil, Wartezeit wieder von vorn

const REFUSED = {
  0: 'Anmeldung abgelehnt (unbekannt/Protokollversion)',
  1: 'Anmeldung abgelehnt: kein Benutzer angegeben',
  2: 'Anmeldung abgelehnt: zum Benutzer ist kein Telefon hinterlegt',
  3: 'Anmeldung abgelehnt: Benutzer nicht gefunden',
};
const NET_ERRORS = {
  ECONNREFUSED: 'CTI-Server lehnt die Verbindung ab',
  ENOTFOUND: 'CTI-Server-Name nicht gefunden',
  ETIMEDOUT: 'CTI-Server nicht erreichbar',
  EHOSTUNREACH: 'CTI-Server nicht erreichbar',
  ENETUNREACH: 'CTI-Server nicht erreichbar (kein Netz/VPN?)',
  ECONNRESET: 'Verbindung vom CTI-Server getrennt',
};
const PHONE_STATES = { 0: 'unknown', 1: 'idle', 2: 'busy', 3: 'ringing', 4: 'offline' };

function frame(type, data) {
  return `${type}-${JSON.stringify(data)}\0`;
}

// Nur die Felder, die die App braucht (Umleitungen o. ä. bleiben außen vor).
function phoneInfo(p) {
  const name = [p.Vorname, p.Nachname].map((s) => String(s || '').trim()).filter(Boolean).join(' ');
  return {
    id: String(p.UniqueId || ''),
    number: String(p.Num || ''),
    name,
    state: PHONE_STATES[p.State] || 'unknown',
    dnd: !!p.Dnd,
    away: !!p.Abwesend,
  };
}

function channelInfo(c) {
  return { id: String(c.UniqueId || ''), number: String(c.Number || ''), invited: c.Type === 1 };
}

// Neuer Teilnehmer oder geänderter Status; fehlt die Nummer in der Änderung, bleibt die bekannte.
function upsertChannel(channels, c) {
  const old = channels.get(c.id);
  channels.set(c.id, { ...c, number: c.number || (old ? old.number : '') });
}

class CtiClient extends EventEmitter {
  // options.label: Kontoname fürs Protokoll
  constructor({ host, port, user }, options = {}) {
    super();
    this.host = host;
    this.port = Number(port) || 1337;
    this.user = user;
    this.label = options.label || host;
    this.status = 'offline'; // 'connecting' | 'connected' | 'offline' | 'refused'
    this.reason = '';
    this.socket = null;
    this.buffer = '';
    this.ownId = null;
    this.phones = new Map(); // UniqueId -> phoneInfo
    this.conferences = new Map(); // Konferenz-ID -> { id, ownerDevice, name, pin, channels: Map }
    this.attempts = []; // Zeitpunkte der Verbindungsversuche (Begrenzung des Servers)
    this.backoff = 0;
    this.signedInAt = 0;
    this.lastData = 0;
    this.retryTimer = null;
    this.watchdog = null;
    this.stopped = true;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.drop();
  }

  // "Neu verbinden": sofort versuchen, aber nur wenn nicht verbunden und die Begrenzung es zulässt.
  retry() {
    if (this.stopped || this.socket || this.waitForRate() > 0) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connect();
  }

  get own() {
    return (this.ownId && this.phones.get(this.ownId)) || null;
  }

  setDnd(on) {
    return this.action('SetDNDAction', { Value: !!on });
  }

  setAway(on) {
    return this.action('SetAbwesendAction', { Value: !!on });
  }

  action(type, data) {
    if (this.status !== 'connected') return false;
    this.socket.write(frame(type, data));
    return true;
  }

  // Wartezeit, bis ein neuer Verbindungsversuch die Begrenzung (RATE_MAX in RATE_WINDOW_MS) einhält.
  waitForRate(now = Date.now()) {
    this.attempts = this.attempts.filter((t) => now - t < RATE_WINDOW_MS);
    return this.attempts.length < RATE_MAX ? 0 : this.attempts[0] + RATE_WINDOW_MS - now + 1000;
  }

  connect() {
    this.attempts.push(Date.now());
    this.setStatus('connecting', '');
    const socket = net.connect({ host: this.host, port: this.port });
    this.socket = socket;
    this.buffer = '';
    socket.setEncoding('utf8'); // setzt auch über Paketgrenzen geteilte Umlaute richtig zusammen
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.on('timeout', () => this.fail('Keine Antwort vom CTI-Server'));
    socket.on('connect', () => {
      socket.setTimeout(0);
      // Anmeldung muss spätestens 3 s nach dem Verbindungsaufbau kommen.
      socket.write(frame('SignInAction', { User: this.user, ClientVersion: CLIENT_VERSION }));
      this.lastData = Date.now();
      this.watchdog = setInterval(() => {
        if (Date.now() - this.lastData > SILENCE_MS) this.fail('Verbindung zum CTI-Server abgerissen');
      }, 10000);
    });
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err) => this.fail(NET_ERRORS[err.code] || err.message));
    socket.on('close', () => this.fail(this.status === 'refused' ? this.reason : 'Verbindung vom CTI-Server getrennt'));
  }

  onData(chunk) {
    this.lastData = Date.now();
    this.buffer += chunk;
    let end;
    while ((end = this.buffer.indexOf('\0')) >= 0) {
      const text = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (text) this.onFrame(text);
      if (!this.socket) return; // Nachricht hat die Verbindung beendet
    }
    if (this.buffer.length > MAX_FRAME) this.fail('Ungültige Daten vom CTI-Server');
  }

  onFrame(text) {
    const dash = text.indexOf('-');
    if (dash <= 0) return;
    const type = text.slice(0, dash);
    let data;
    try {
      data = JSON.parse(text.slice(dash + 1));
    } catch {
      return;
    }
    if (!data || typeof data !== 'object') return;
    this.onEvent(type, data);
  }

  onEvent(type, data) {
    switch (type) {
      case 'SignInSuccessEvent':
        this.signedInAt = Date.now();
        console.log(`CTI ${this.label}: angemeldet als ${this.user} (${this.host}:${this.port})`);
        this.setStatus('connected', '');
        return;
      case 'SignInRefusedEvent':
        this.setStatus('refused', REFUSED[data.Reason] || REFUSED[0]);
        console.warn(`CTI ${this.label}: ${this.reason}`);
        return; // der Server trennt danach selbst
      case 'HeartbeatEvent':
        return;
      case 'OwnPhoneEvent':
        this.ownId = String(data.UniqueId || '');
        this.phones.set(this.ownId, phoneInfo(data));
        break;
      case 'NewPhoneEvent':
      case 'PhoneChangedEvent':
        this.phones.set(String(data.UniqueId || ''), phoneInfo(data));
        break;
      case 'PhoneRemovedEvent':
        this.phones.delete(String(data.UniqueId || ''));
        break;
      case 'NewConferenceEvent': // vollständige Teilnehmerliste -> neu aufbauen
        this.conferences.delete(String(data.UniqueId || ''));
        this.updateConference(data, upsertChannel);
        break;
      case 'ConferenceChannelAddEvent':
      case 'ConferenceChannelChangedEvent':
        this.updateConference(data, upsertChannel);
        break;
      case 'ConferenceChannelRemovedEvent':
        this.updateConference(data, (channels, c) => channels.delete(c.id));
        break;
      case 'ConferenceRemovedEvent':
        this.conferences.delete(String(data.UniqueId || ''));
        break;
      default:
        return; // z. B. Kanäle aktiver Gespräche – braucht die App nicht
    }
    this.emit('change');
  }

  // Legt die Konferenz bei Bedarf an (auch wenn ein Add vor dem NewConferenceEvent käme).
  updateConference(data, apply) {
    const id = String(data.UniqueId || '');
    if (!id) return;
    let conf = this.conferences.get(id);
    if (!conf) {
      conf = { id, ownerDevice: '', name: '', pin: '', channels: new Map() };
      this.conferences.set(id, conf);
    }
    if (data.OwnerDevice) conf.ownerDevice = String(data.OwnerDevice);
    if (data.Name) conf.name = String(data.Name);
    if (data.Pin) conf.pin = String(data.Pin);
    for (const c of Array.isArray(data.Channels) ? data.Channels : []) {
      const info = channelInfo(c || {});
      if (info.id) apply(conf.channels, info);
    }
  }

  setStatus(status, reason) {
    this.status = status;
    this.reason = reason;
    this.emit('change');
  }

  // Verbindung schließen, Stand verwerfen (er ist ohne Verbindung nicht mehr aktuell).
  drop() {
    clearInterval(this.watchdog);
    this.watchdog = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.destroy();
    }
    this.ownId = null;
    this.phones.clear();
    this.conferences.clear();
  }

  fail(reason) {
    if (!this.socket) return;
    const refused = this.status === 'refused';
    const wasSignedIn = this.status === 'connected';
    this.drop();
    if (this.stopped) return;
    if (!refused) console.warn(`CTI ${this.label}: ${reason}`);
    if (wasSignedIn && Date.now() - this.signedInAt >= STABLE_MS) this.backoff = 0;
    let delay = refused ? BACKOFF_MS[BACKOFF_MS.length - 1] : BACKOFF_MS[Math.min(this.backoff, BACKOFF_MS.length - 1)];
    this.backoff++;
    delay = Math.max(delay, this.waitForRate());
    this.setStatus(refused ? 'refused' : 'offline', refused ? this.reason : reason);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }
}

module.exports = { CtiClient, frame, CLIENT_VERSION };
