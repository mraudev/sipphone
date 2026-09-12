'use strict';
const dgram = require('dgram');
const dns = require('dns').promises;
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { RtpSession } = require('./rtp');
const sdp = require('./sdp');

const T1 = 500;
const T2 = 4000;
const TX_TIMEOUT = 64 * T1;
const KEEPALIVE_MS = 25000;
const USER_AGENT = 'sipphone/0.1';
const ALLOW = 'INVITE, ACK, CANCEL, BYE, OPTIONS, NOTIFY, UPDATE';
const TRACE = process.env.SIP_TRACE === '1';

const COMPACT = { v: 'via', f: 'from', t: 'to', i: 'call-id', m: 'contact', l: 'content-length', c: 'content-type', k: 'supported' };
const LIST_HEADERS = new Set(['via', 'route', 'record-route', 'contact', 'p-asserted-identity', 'remote-party-id']);

const rand = (bytes = 8) => crypto.randomBytes(bytes).toString('hex');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

// --- Parser / Serializer ---

// Trennt an Kommas außerhalb von "..." und <...>.
function splitList(value) {
  const out = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') angle = true;
    else if (!quoted && ch === '>') angle = false;
    if (ch === ',' && !quoted && !angle) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// SIP ist UTF-8, manche Anlagen schicken Namen aber in Windows-1252/Latin-1 (z.B. "ö" als Byte 0xF6).
// Gültiges UTF-8 bleibt UTF-8, alles andere wird als Windows-1252 gelesen statt zu "�" zu werden.
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const WINDOWS_1252 = new TextDecoder('windows-1252');

function decodeText(buf) {
  try {
    return UTF8.decode(buf);
  } catch {
    return WINDOWS_1252.decode(buf);
  }
}

function parseMessage(buf) {
  const text = decodeText(buf);
  const sep = text.indexOf('\r\n\r\n');
  if (sep < 0) return null;
  const lines = [];
  for (const line of text.slice(0, sep).split('\r\n')) {
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += ' ' + line.trim();
    else lines.push(line);
  }
  const first = lines.shift();
  const msg = { headers: {}, body: text.slice(sep + 4) };
  let m;
  if ((m = /^SIP\/2\.0 (\d{3})\s*(.*)$/.exec(first))) {
    msg.status = Number(m[1]);
    msg.reason = m[2];
  } else if ((m = /^([A-Z]+) (\S+) SIP\/2\.0$/.exec(first))) {
    msg.method = m[1];
    msg.uri = m[2];
  } else {
    return null;
  }
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    let name = line.slice(0, i).trim().toLowerCase();
    name = COMPACT[name] || name;
    const value = line.slice(i + 1).trim();
    (msg.headers[name] ||= []).push(...(LIST_HEADERS.has(name) ? splitList(value) : [value]));
  }
  const len = parseInt(header(msg, 'content-length'), 10);
  if (len >= 0) msg.body = msg.body.slice(0, len);
  return msg;
}

function header(msg, name) {
  return (msg.headers[name] || [])[0] || '';
}

function serialize(startLine, headers, body = '', contentType) {
  const lines = [startLine, ...headers.map(([n, v]) => `${n}: ${v}`)];
  if (body) lines.push(`Content-Type: ${contentType}`);
  lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  return Buffer.from(lines.join('\r\n') + '\r\n\r\n' + body);
}

function parseParams(s) {
  const params = {};
  for (const part of s.split(';')) {
    const [k, v] = part.split('=');
    if (k.trim()) params[k.trim().toLowerCase()] = v === undefined ? true : v.trim();
  }
  return params;
}

// '"Name" <sip:user@host>;tag=x' -> { display, uri, params }
function parseAddr(value) {
  const m = /^\s*(?:"((?:[^"\\]|\\.)*)"|([^<"]*?))\s*<([^>]*)>(.*)$/.exec(value);
  if (m) {
    return { display: (m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1').trim(), uri: m[3], params: parseParams(m[4]) };
  }
  const i = value.indexOf(';');
  return { display: '', uri: (i < 0 ? value : value.slice(0, i)).trim(), params: parseParams(i < 0 ? '' : value.slice(i)) };
}

function parseVia(value) {
  const i = value.indexOf(';');
  return { sentBy: (i < 0 ? value : value.slice(0, i)).trim(), params: parseParams(i < 0 ? '' : value.slice(i)) };
}

// Gegenstelle einer Nachricht: P-Asserted-Identity / Remote-Party-ID (so meldet Asterisk die
// verbundene Gegenstelle nach, z.B. bei Click-to-Dial oder Weiterleitung), sonst der Fallback-Header.
function remoteIdentity(msg, fallbackHeader) {
  const value = header(msg, 'p-asserted-identity') || header(msg, 'remote-party-id') || (fallbackHeader ? header(msg, fallbackHeader) : '');
  if (!value) return null;
  const addr = parseAddr(value);
  return addr.uri ? { uri: addr.uri, name: addr.display } : null;
}

function getHeader(req, name) {
  const h = req.headers.find(([n]) => n === name);
  return h ? h[1] : '';
}

function localIpFor(address, port) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.connect(port, address, (err) => {
      if (err) {
        s.close();
        reject(err);
        return;
      }
      const ip = s.address().address;
      s.close();
      resolve(ip);
    });
  });
}

const FAILURE_TEXT = {
  404: 'Nummer nicht gefunden',
  408: 'Zeitüberschreitung',
  480: 'Nicht erreichbar',
  486: 'Besetzt',
  487: 'Abgebrochen',
  488: 'Kein gemeinsamer Codec',
  503: 'Dienst nicht verfügbar',
  600: 'Besetzt',
  603: 'Abgelehnt',
};

// --- User Agent ---

class SipUA extends EventEmitter {
  // options.isBusy: Rückfrage, ob gerade ein anderes Konto telefoniert (dann gibt es "besetzt").
  constructor(cfg, options = {}) {
    super();
    this.cfg = cfg;
    this.isBusy = options.isBusy || (() => false);
    this.tx = new Map(); // Client-Transaktionen
    this.stx = new Map(); // Server-Transaktionen (für Retransmits)
    this.reg = { state: 'idle', reason: '' };
    this.call = null;
    this.regCallId = `${rand(12)}@sipphone`;
    this.regTag = rand(6);
    this.regCseq = 0;
    this.proxyAddr = null;
    this.localIp = null;
  }

  get aor() {
    return `sip:${this.cfg.username}@${this.cfg.domain}`;
  }

  async start() {
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (buf, rinfo) => this.onMessage(buf, rinfo));
    this.socket.on('error', (err) => console.error('SIP-Socket:', err.message));
    await new Promise((resolve) => this.socket.bind(this.cfg.sipPort || 0, resolve));
    this.localPort = this.socket.address().port;
    console.log(`SIP lauscht auf UDP-Port ${this.localPort}`);
    // CRLF-Keepalive hält NAT/Firewall-Pinholes offen, damit eingehende Anrufe ankommen.
    this.keepalive = setInterval(() => {
      if (this.reg.state === 'registered') this.transmit(Buffer.from('\r\n\r\n'));
    }, KEEPALIVE_MS);
    this.register();
  }

  async stop() {
    if (this.call) this.hangup();
    clearInterval(this.keepalive);
    clearTimeout(this.regTimer);
    if (this.reg.state === 'registered') {
      await Promise.race([this.register(0), new Promise((r) => setTimeout(r, 2000))]);
    }
    this.socket.close();
  }

  snapshot() {
    const c = this.call;
    return {
      registration: { ...this.reg, aor: this.aor, server: `${this.cfg.proxy}:${this.cfg.proxyPort}` },
      call: c && {
        direction: c.direction,
        state: c.state,
        remoteUri: c.remoteUri,
        remoteName: c.remoteName,
        startedAt: c.startedAt,
        earlyMedia: !!c.earlyMedia,
        codec: c.codec ? c.codec.name : null,
      },
    };
  }

  emitState() {
    this.emit('state', this.snapshot());
  }

  // --- Transport ---

  transmit(data, address = this.proxyAddr, port = this.cfg.proxyPort) {
    if (!address) return;
    if (TRACE) console.log(`\n>>> an ${address}:${port}\n${data.toString()}`);
    this.socket.send(data, port, address);
  }

  onMessage(buf, rinfo) {
    // Nur der eigene Server spricht mit uns – auch externe Anrufe laufen über ihn. Pakete von anderen
    // Adressen (SIP-Scanner, gefälschte Anrufe) werden verworfen.
    if (rinfo.address !== this.proxyAddr) {
      if (TRACE) console.log(`\n--- verworfen: SIP von fremder Adresse ${rinfo.address}:${rinfo.port}`);
      return;
    }
    const msg = parseMessage(buf);
    if (!msg) return;
    if (TRACE) console.log(`\n<<< von ${rinfo.address}:${rinfo.port}\n${buf.toString()}`);
    try {
      if (msg.method) this.onRequest(msg, rinfo);
      else this.onResponse(msg);
    } catch (err) {
      // Ein kaputtes Paket darf den Stack nicht aus dem Tritt bringen.
      console.error('SIP-Nachricht nicht verarbeitbar:', err.message);
    }
  }

  fromHeader() {
    const name = this.cfg.displayName ? `"${this.cfg.displayName}" ` : '';
    return `${name}<${this.aor}>`;
  }

  contactHeader() {
    return `<sip:${this.cfg.username}@${this.localIp}:${this.localPort};transport=udp>`;
  }

  buildRequest(method, uri, o) {
    const branch = o.branch || `z9hG4bK${rand()}`;
    const headers = [
      ['Via', `SIP/2.0/UDP ${this.localIp}:${this.localPort};branch=${branch};rport`],
      ['Max-Forwards', '70'],
      ...(o.route || []).map((r) => ['Route', r]),
      ['From', o.from],
      ['To', o.to],
      ['Call-ID', o.callId],
      ['CSeq', `${o.cseq} ${method}`],
    ];
    if (o.contact) headers.push(['Contact', this.contactHeader()]);
    headers.push(['User-Agent', USER_AGENT]);
    if (method === 'INVITE' || method === 'REGISTER') headers.push(['Allow', ALLOW]);
    headers.push(...(o.extra || []));
    return { method, uri, branch, headers, body: o.body || '', contentType: o.contentType };
  }

  // Client-Transaktion mit UDP-Retransmits (RFC 3261 Timer A/E).
  sendRequest(req, cb) {
    const data = serialize(`${req.method} ${req.uri} SIP/2.0`, req.headers, req.body, req.contentType);
    const key = `${req.branch}:${req.method}`;
    const tx = { req, cb, interval: T1 };
    const retransmit = () => {
      this.transmit(data);
      tx.timer = setTimeout(retransmit, tx.interval);
      tx.interval = req.method === 'INVITE' ? tx.interval * 2 : Math.min(tx.interval * 2, T2);
    };
    tx.deadline = setTimeout(() => {
      this.finishTx(key);
      cb({ status: 408, reason: 'Request Timeout', headers: {}, body: '' });
    }, TX_TIMEOUT);
    this.tx.set(key, tx);
    retransmit();
  }

  finishTx(key) {
    const tx = this.tx.get(key);
    if (!tx) return;
    clearTimeout(tx.timer);
    clearTimeout(tx.deadline);
    this.tx.delete(key);
  }

  onResponse(res) {
    const branch = parseVia(header(res, 'via')).params.branch;
    const method = header(res, 'cseq').split(/\s+/)[1];
    const key = `${branch}:${method}`;
    const tx = this.tx.get(key);
    if (!tx) {
      // Wiederholtes 200 OK auf INVITE -> ACK erneut senden
      if (method === 'INVITE' && res.status < 300 && this.lastAck && header(res, 'call-id') === this.lastAck.callId) {
        this.transmit(this.lastAck.data);
      }
      return;
    }
    if (res.status < 200) {
      clearTimeout(tx.timer);
      if (method === 'INVITE') clearTimeout(tx.deadline);
      tx.cb(res);
      return;
    }
    this.finishTx(key);
    if (method === 'INVITE' && res.status >= 300) this.ackNon2xx(tx.req, res);
    tx.cb(res);
  }

  ackNon2xx(req, res) {
    const headers = [
      ['Via', getHeader(req, 'Via')],
      ['Max-Forwards', '70'],
      ...req.headers.filter(([n]) => n === 'Route'),
      ['From', getHeader(req, 'From')],
      ['To', header(res, 'to')],
      ['Call-ID', getHeader(req, 'Call-ID')],
      ['CSeq', `${getHeader(req, 'CSeq').split(' ')[0]} ACK`],
    ];
    this.transmit(serialize(`ACK ${req.uri} SIP/2.0`, headers));
  }

  // Digest-Authentifizierung; funktioniert mit Klartext-Passwort oder dem HA1-Hash aus Linphone.
  authorize(req, res) {
    const proxy = res.status === 407;
    const challenge = header(res, proxy ? 'proxy-authenticate' : 'www-authenticate');
    if (!/^digest/i.test(challenge)) return null;
    const p = {};
    for (const m of challenge.slice(6).matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g)) {
      p[m[1].toLowerCase()] = m[2] ?? m[3];
    }
    if (p.algorithm && !/^md5$/i.test(p.algorithm)) {
      console.warn(`Nicht unterstützter Digest-Algorithmus: ${p.algorithm}`);
      return null;
    }
    const { cfg } = this;
    const user = cfg.authUsername || cfg.username;
    if (!cfg.password && cfg.realm && p.realm !== cfg.realm) {
      console.warn(`Server-Realm "${p.realm}" passt nicht zum HA1 (Realm "${cfg.realm}") - bitte "password" in config.json setzen`);
    }
    const ha1 = cfg.password ? md5(`${user}:${p.realm}:${cfg.password}`) : cfg.ha1;
    if (!ha1) return null;
    const ha2 = md5(`${req.method}:${req.uri}`);
    const qop = p.qop && p.qop.split(',').map((s) => s.trim()).includes('auth') ? 'auth' : null;
    const nc = '00000001';
    const cnonce = rand(8);
    const response = qop ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
    let value = `Digest username="${user}", realm="${p.realm}", nonce="${p.nonce}", uri="${req.uri}", response="${response}", algorithm=MD5`;
    if (p.opaque !== undefined) value += `, opaque="${p.opaque}"`;
    if (qop) value += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
    return [proxy ? 'Proxy-Authorization' : 'Authorization', value];
  }

  // --- Registrierung ---

  async resolveNetwork() {
    const { address } = await dns.lookup(this.cfg.proxy, { family: 4 });
    this.proxyAddr = address;
    this.localIp = await localIpFor(address, this.cfg.proxyPort);
  }

  setReg(state, reason = '') {
    this.reg = { state, reason };
    console.log(`Registrierung: ${state}${reason ? ` (${reason})` : ''}`);
    this.emitState();
  }

  scheduleRegister(seconds) {
    clearTimeout(this.regTimer);
    this.regTimer = setTimeout(() => this.register(), seconds * 1000);
  }

  async register(expires = this.cfg.expires) {
    clearTimeout(this.regTimer);
    if (!this.cfg.proxy || !this.cfg.username) {
      this.setReg('failed', 'Kein Konto eingerichtet');
      return;
    }
    try {
      await this.resolveNetwork();
    } catch (err) {
      this.setReg('failed', `Server ${this.cfg.proxy} nicht erreichbar (${err.code || err.message})`);
      if (expires) this.scheduleRegister(30);
      return;
    }
    this.setReg(expires ? 'registering' : 'unregistering');
    return new Promise((resolve) => {
      const send = (auth) => {
        const req = this.buildRequest('REGISTER', `sip:${this.cfg.domain}`, {
          callId: this.regCallId,
          from: `${this.fromHeader()};tag=${this.regTag}`,
          to: `<${this.aor}>`,
          cseq: ++this.regCseq,
          contact: true,
          extra: [['Expires', String(expires)], ...(auth ? [auth] : [])],
        });
        this.sendRequest(req, (res) => {
          if (res.status < 200) return;
          if ((res.status === 401 || res.status === 407) && !auth) {
            const a = this.authorize(req, res);
            if (a) return send(a);
          }
          if (res.status < 300) {
            if (expires) {
              this.setReg('registered');
              this.scheduleRegister(Math.max(10, this.grantedExpires(res, expires) * 0.9));
            } else {
              this.setReg('unregistered');
            }
          } else {
            const reason = res.status === 401 || res.status === 403 ? `${res.status} Zugangsdaten abgelehnt` : `${res.status} ${res.reason}`;
            this.setReg('failed', reason);
            if (expires) this.scheduleRegister(60);
          }
          resolve();
        });
      };
      send();
    });
  }

  // Neues Konto/Server übernehmen: altes Konto abmelden, Änderungen in cfg übernehmen, neu registrieren.
  async reconfigure(changes) {
    clearTimeout(this.regTimer);
    if (this.reg.state === 'registered') {
      await Promise.race([this.register(0), new Promise((r) => setTimeout(r, 2000))]);
    }
    Object.assign(this.cfg, changes);
    this.regCallId = `${rand(12)}@sipphone`;
    this.regTag = rand(6);
    this.regCseq = 0;
    this.proxyAddr = null;
    this.register();
  }

  grantedExpires(res, requested) {
    const own = `${this.localIp}:${this.localPort}`;
    const contact = (res.headers.contact || []).find((c) => c.includes(own));
    const fromContact = contact && parseAddr(contact).params.expires;
    return Number(fromContact || header(res, 'expires') || requested);
  }

  // --- Anrufe ---

  targetUri(target) {
    const t = target.trim().replace(/^tel:/i, '');
    if (/^sips?:/i.test(t)) return t;
    if (t.includes('@')) return `sip:${t}`;
    return `sip:${t.replace(/[\s()/-]/g, '')}@${this.cfg.domain}`;
  }

  newCall(direction, remoteUri, remoteName) {
    const call = {
      direction,
      state: direction === 'out' ? 'calling' : 'incoming',
      remoteUri,
      remoteName,
      rtp: new RtpSession(),
      cseq: 0,
      routeSet: [],
      createdAt: Date.now(),
      startedAt: null,
      sdpId: Date.now(),
      sdpVersion: 0,
    };
    call.rtp.on('audio', (pcm) => this.emit('audio', pcm));
    this.call = call;
    return call;
  }

  localSdp(call) {
    return sdp.build({
      ip: this.localIp,
      port: call.rtp.port,
      sessionId: call.sdpId,
      version: ++call.sdpVersion,
      codec: call.codec,
      dtmfPt: call.dtmfPt,
      direction: call.localDirection,
    });
  }

  // Übernimmt eine nachgemeldete Gegenstelle; true, wenn sich etwas geändert hat.
  updateRemoteParty(call, msg, fallbackHeader) {
    const id = remoteIdentity(msg, fallbackHeader);
    if (!id || (id.uri === call.remoteUri && (!id.name || id.name === call.remoteName))) return false;
    call.remoteName = id.name || (id.uri === call.remoteUri ? call.remoteName : '');
    call.remoteUri = id.uri;
    console.log(`Gegenstelle: ${call.remoteName} <${call.remoteUri}>`);
    return true;
  }

  applyRemoteSdp(call, body) {
    const remote = sdp.parse(body);
    if (!remote) return;
    const codec = sdp.chooseCodec(remote);
    if (!codec) return;
    call.codec = codec;
    call.dtmfPt = remote.dtmfPt;
    call.localDirection = { sendonly: 'recvonly', recvonly: 'sendonly', inactive: 'inactive' }[remote.direction] || 'sendrecv';
    call.rtp.setRemote(remote.ip, remote.port, codec);
  }

  async dial(target) {
    if (this.call) throw new Error('Es läuft bereits ein Gespräch');
    if (!this.proxyAddr) throw new Error('Keine Verbindung zum SIP-Server');
    if (!target.trim()) throw new Error('Keine Nummer angegeben');
    const uri = this.targetUri(target);
    const call = this.newCall('out', uri, '');
    call.callId = `${rand(12)}@${this.localIp}`;
    call.local = `${this.fromHeader()};tag=${rand(6)}`;
    call.remote = `<${uri}>`;
    call.remoteTarget = uri;
    this.emitState();
    await call.rtp.open();
    if (call.ended) return;
    this.sendInvite(call);
  }

  sendInvite(call, auth) {
    const req = this.buildRequest('INVITE', call.remoteTarget, {
      callId: call.callId,
      from: call.local,
      to: call.remote,
      cseq: ++call.cseq,
      contact: true,
      extra: auth ? [auth] : [],
      body: this.localSdp(call),
      contentType: 'application/sdp',
    });
    call.invite = req;
    call.provisional = false;
    this.sendRequest(req, (res) => this.onInviteResponse(call, req, res, !!auth));
  }

  onInviteResponse(call, req, res, authed) {
    const ended = call !== this.call;
    if (res.status < 200) {
      call.provisional = true;
      if (ended) {
        if (call.cancelPending) this.sendCancel(call);
        return;
      }
      if (res.status === 100) return;
      this.updateRemoteParty(call, res);
      call.state = 'ringing';
      if (res.body) {
        this.applyRemoteSdp(call, res.body);
        call.earlyMedia = !!call.rtp.remote;
        if (call.earlyMedia) call.rtp.start();
      }
      this.emitState();
      return;
    }
    if (res.status < 300) {
      this.confirmOutgoing(call, res);
      if (ended) {
        this.sendBye(call);
        return;
      }
      if (res.body) this.applyRemoteSdp(call, res.body);
      this.updateRemoteParty(call, res);
      call.rtp.start();
      call.state = 'active';
      call.startedAt = Date.now();
      this.emitState();
      return;
    }
    if (ended) return;
    if ((res.status === 401 || res.status === 407) && !authed) {
      const a = this.authorize(req, res);
      if (a) return this.sendInvite(call, a);
    }
    this.endCall(call, FAILURE_TEXT[res.status] || `${res.status} ${res.reason}`);
  }

  confirmOutgoing(call, res) {
    call.remote = header(res, 'to');
    const contact = header(res, 'contact');
    if (contact) call.remoteTarget = parseAddr(contact).uri;
    call.routeSet = (res.headers['record-route'] || []).slice().reverse();
    const ack = this.buildRequest('ACK', call.remoteTarget, {
      callId: call.callId,
      from: call.local,
      to: call.remote,
      cseq: call.cseq,
      route: call.routeSet,
    });
    const data = serialize(`ACK ${ack.uri} SIP/2.0`, ack.headers);
    this.lastAck = { callId: call.callId, data };
    this.transmit(data);
  }

  sendCancel(call) {
    const inv = call.invite;
    call.cancelPending = false;
    this.sendRequest({
      method: 'CANCEL',
      uri: inv.uri,
      branch: inv.branch,
      headers: [
        ['Via', getHeader(inv, 'Via')],
        ['Max-Forwards', '70'],
        ...inv.headers.filter(([n]) => n === 'Route'),
        ['From', getHeader(inv, 'From')],
        ['To', getHeader(inv, 'To')],
        ['Call-ID', getHeader(inv, 'Call-ID')],
        ['CSeq', `${call.cseq} CANCEL`],
        ['User-Agent', USER_AGENT],
      ],
      body: '',
    }, () => {});
  }

  sendBye(call) {
    const req = this.buildRequest('BYE', call.remoteTarget, {
      callId: call.callId,
      from: call.local,
      to: call.remote,
      cseq: ++call.cseq,
      route: call.routeSet,
    });
    this.sendRequest(req, () => {});
  }

  hangup() {
    const call = this.call;
    if (!call) return;
    if (call.state === 'incoming') {
      this.reject();
      return;
    }
    if (call.state === 'active') this.sendBye(call);
    else if (call.provisional) this.sendCancel(call);
    else call.cancelPending = true;
    this.endCall(call, 'Aufgelegt');
  }

  answer() {
    const call = this.call;
    if (!call || call.state !== 'incoming') return;
    const data = this.respond(call.invite, call.rinfo, 200, 'OK', {
      toTag: call.localTag,
      contact: true,
      body: this.localSdp(call),
      contentType: 'application/sdp',
      extra: [['Allow', ALLOW]],
    });
    call.awaitingAck = true;
    this.retransmitUntilAck(call, data);
    call.rtp.start();
    call.state = 'active';
    call.startedAt = Date.now();
    this.emitState();
  }

  reject() {
    const call = this.call;
    if (!call || call.state !== 'incoming') return;
    this.respond(call.invite, call.rinfo, 486, 'Busy Here', { toTag: call.localTag });
    call.rejected = true;
    this.endCall(call, 'Abgelehnt');
  }

  retransmitUntilAck(call, data) {
    clearTimeout(call.okTimer);
    const started = Date.now();
    let interval = T1;
    const tick = () => {
      if (Date.now() - started >= TX_TIMEOUT) {
        if (this.call === call) {
          this.sendBye(call);
          this.endCall(call, 'Keine Bestätigung (ACK) vom Server');
        }
        return;
      }
      this.transmit(data, call.rinfo.address, call.rinfo.port);
      interval = Math.min(interval * 2, T2);
      call.okTimer = setTimeout(tick, interval);
    };
    call.okTimer = setTimeout(tick, interval);
  }

  endCall(call, reason) {
    if (call.ended) return;
    call.ended = true;
    clearTimeout(call.okTimer);
    call.rtp.close();
    if (this.call === call) this.call = null;
    console.log(`Gespräch beendet: ${reason}`);
    this.emit('ended', reason, {
      direction: call.direction,
      remoteUri: call.remoteUri,
      remoteName: call.remoteName,
      createdAt: call.createdAt,
      startedAt: call.startedAt,
      rejected: !!call.rejected,
    });
    this.emitState();
  }

  pushAudio(pcm) {
    if (this.call) this.call.rtp.pushMic(pcm);
  }

  // Tastentöne: RFC 4733 im RTP-Strom, wenn telephone-event ausgehandelt ist, sonst SIP INFO.
  sendDtmf(digit) {
    const call = this.call;
    if (!call || call.state !== 'active' || !/^[0-9*#A-D]$/.test(digit)) return;
    if (call.dtmfPt !== undefined && call.dtmfPt !== null) {
      call.rtp.sendDtmf(digit, call.dtmfPt);
      return;
    }
    const req = this.buildRequest('INFO', call.remoteTarget, {
      callId: call.callId,
      from: call.local,
      to: call.remote,
      cseq: ++call.cseq,
      route: call.routeSet,
      body: `Signal=${digit}\r\nDuration=100\r\n`,
      contentType: 'application/dtmf-relay',
    });
    this.sendRequest(req, () => {});
  }

  // --- Eingehende Requests ---

  respond(req, rinfo, status, reason, { toTag, contact, body, contentType, extra = [] } = {}) {
    let to = header(req, 'to');
    const tag = toTag || (status > 100 ? rand(4) : null);
    if (tag && !parseAddr(to).params.tag) to += `;tag=${tag}`;
    const headers = [
      ...(req.headers.via || []).map((v) => ['Via', v]),
      ...(contact ? (req.headers['record-route'] || []).map((r) => ['Record-Route', r]) : []),
      ['From', header(req, 'from')],
      ['To', to],
      ['Call-ID', header(req, 'call-id')],
      ['CSeq', header(req, 'cseq')],
    ];
    if (contact) headers.push(['Contact', this.contactHeader()]);
    headers.push(['User-Agent', USER_AGENT], ...extra);
    const data = serialize(`SIP/2.0 ${status} ${reason}`, headers, body, contentType);
    this.transmit(data, rinfo.address, rinfo.port);
    const st = this.stx.get(this.stxKey(req));
    if (st) st.data = data;
    return data;
  }

  stxKey(req) {
    return `${parseVia(header(req, 'via')).params.branch}:${req.method}`;
  }

  findCall(req) {
    return this.call && this.call.callId === header(req, 'call-id') ? this.call : null;
  }

  onRequest(req, rinfo) {
    // Ohne diese Header lässt sich weder antworten noch zuordnen.
    if (!['via', 'from', 'to', 'call-id', 'cseq'].every((name) => header(req, name))) return;
    if (req.method !== 'ACK') {
      const key = this.stxKey(req);
      const st = this.stx.get(key);
      if (st) {
        if (st.data) this.transmit(st.data, rinfo.address, rinfo.port);
        return;
      }
      this.stx.set(key, { data: null });
      setTimeout(() => this.stx.delete(key), TX_TIMEOUT);
    }
    switch (req.method) {
      case 'INVITE':
        if (parseAddr(header(req, 'to')).params.tag) this.onReInvite(req, rinfo);
        else this.onInvite(req, rinfo).catch((err) => console.error('INVITE nicht verarbeitbar:', err.message));
        break;
      case 'ACK':
        this.onAck(req);
        break;
      case 'BYE':
        this.onBye(req, rinfo);
        break;
      case 'CANCEL':
        this.onCancel(req, rinfo);
        break;
      case 'UPDATE':
        this.onUpdate(req, rinfo);
        break;
      case 'OPTIONS':
        this.respond(req, rinfo, 200, 'OK', { extra: [['Allow', ALLOW], ['Accept', 'application/sdp']] });
        break;
      case 'NOTIFY':
        this.respond(req, rinfo, 200, 'OK');
        break;
      default:
        this.respond(req, rinfo, 501, 'Not Implemented', { extra: [['Allow', ALLOW]] });
    }
  }

  async onInvite(req, rinfo) {
    if (this.call || this.isBusy()) {
      this.respond(req, rinfo, 486, 'Busy Here');
      return;
    }
    const from = remoteIdentity(req, 'from');
    if (!from) {
      this.respond(req, rinfo, 400, 'Bad Request');
      return;
    }
    this.respond(req, rinfo, 100, 'Trying');
    const call = this.newCall('in', from.uri, from.name);
    call.callId = header(req, 'call-id');
    call.localTag = rand(6);
    call.local = `${header(req, 'to')};tag=${call.localTag}`;
    call.remote = header(req, 'from');
    call.remoteTarget = parseAddr(header(req, 'contact')).uri || from.uri;
    call.routeSet = req.headers['record-route'] || [];
    call.cseq = Math.floor(Math.random() * 1000);
    call.invite = req;
    call.rinfo = rinfo;
    await call.rtp.open();
    if (call.ended) return;
    if (req.body) {
      this.applyRemoteSdp(call, req.body);
      if (!call.codec) {
        this.respond(req, rinfo, 488, 'Not Acceptable Here', { toTag: call.localTag });
        this.endCall(call, 'Kein gemeinsamer Codec');
        return;
      }
    } else {
      call.awaitingOffer = true; // Angebot kommt erst mit dem ACK
    }
    this.respond(req, rinfo, 180, 'Ringing', { toTag: call.localTag, contact: true });
    console.log(`Eingehender Anruf von ${from.name || ''} <${from.uri}>`);
    this.emitState();
  }

  onReInvite(req, rinfo) {
    const call = this.findCall(req);
    if (!call) {
      this.respond(req, rinfo, 481, 'Call/Transaction Does Not Exist');
      return;
    }
    if (req.body) this.applyRemoteSdp(call, req.body);
    else call.awaitingOffer = true;
    call.rinfo = rinfo;
    // Nur PAI/RPID: der From-Header bleibt im Dialog unverändert (bei Click-to-Dial = man selbst).
    if (this.updateRemoteParty(call, req)) this.emitState();
    const data = this.respond(req, rinfo, 200, 'OK', {
      contact: true,
      body: this.localSdp(call),
      contentType: 'application/sdp',
      extra: [['Allow', ALLOW]],
    });
    this.retransmitUntilAck(call, data);
  }

  onAck(req) {
    const call = this.findCall(req);
    if (!call) return;
    clearTimeout(call.okTimer);
    if (call.awaitingOffer && req.body) this.applyRemoteSdp(call, req.body);
    call.awaitingOffer = false;
  }

  onBye(req, rinfo) {
    const call = this.findCall(req);
    if (!call) {
      this.respond(req, rinfo, 481, 'Call/Transaction Does Not Exist');
      return;
    }
    this.respond(req, rinfo, 200, 'OK');
    this.endCall(call, call.state === 'incoming' ? 'Anruf verpasst' : 'Gegenstelle hat aufgelegt');
  }

  onCancel(req, rinfo) {
    const call = this.findCall(req);
    if (!call) {
      this.respond(req, rinfo, 481, 'Call/Transaction Does Not Exist');
      return;
    }
    this.respond(req, rinfo, 200, 'OK');
    if (call.state === 'incoming') {
      this.respond(call.invite, call.rinfo, 487, 'Request Terminated', { toTag: call.localTag });
      this.endCall(call, 'Anruf verpasst');
    }
  }

  onUpdate(req, rinfo) {
    const call = this.findCall(req);
    if (!call) {
      this.respond(req, rinfo, 481, 'Call/Transaction Does Not Exist');
      return;
    }
    if (this.updateRemoteParty(call, req)) this.emitState();
    if (!req.body) {
      this.respond(req, rinfo, 200, 'OK', { contact: true });
      return;
    }
    this.applyRemoteSdp(call, req.body);
    this.respond(req, rinfo, 200, 'OK', { contact: true, body: this.localSdp(call), contentType: 'application/sdp' });
  }
}

module.exports = { SipUA, parseMessage, parseAddr };
