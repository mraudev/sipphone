'use strict';
const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const FRAME = 160; // 20 ms @ 8 kHz
// So lange ohne Mikrofon-Block -> der 20-ms-Takt sendet Stille. Deutlich länger als übliche Ruckler
// zwischen Fenster und Hauptprozess, sonst käme nach verspäteten Blöcken zusätzliche Verzögerung dazu.
const MIC_STALE_MS = 200;

// Tastentöne nach RFC 4733 (telephone-event)
const DTMF_EVENTS = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, '*': 10, '#': 11, A: 12, B: 13, C: 14, D: 15 };
const DTMF_DURATION = FRAME * 5; // 100 ms
const DTMF_END_PACKETS = 3; // Endpaket wird dreifach gesendet (UDP kann verlieren)
const DTMF_GAP_FRAMES = 3; // 60 ms Pause zwischen zwei Tönen
const DTMF_VOLUME = 10; // -10 dBm0

// --- G.711 (nach der Referenzimplementierung von Sun) ---
const SEG_AEND = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];
const SEG_UEND = [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff];
const BIAS = 0x84;
const CLIP = 8159;

function segment(value, table) {
  for (let i = 0; i < table.length; i++) if (value <= table[i]) return i;
  return table.length;
}

function linearToAlaw(pcm) {
  let value = pcm >> 3;
  let mask = 0xd5;
  if (value < 0) {
    mask = 0x55;
    value = -value - 1;
  }
  const seg = segment(value, SEG_AEND);
  if (seg >= 8) return 0x7f ^ mask;
  let aval = seg << 4;
  aval |= seg < 2 ? (value >> 1) & 0x0f : (value >> seg) & 0x0f;
  return aval ^ mask;
}

function alawToLinear(aval) {
  aval ^= 0x55;
  let t = (aval & 0x0f) << 4;
  const seg = (aval & 0x70) >> 4;
  if (seg === 0) t += 8;
  else if (seg === 1) t += 0x108;
  else t = (t + 0x108) << (seg - 1);
  return aval & 0x80 ? t : -t;
}

function linearToUlaw(pcm) {
  let value = pcm >> 2;
  let mask = 0xff;
  if (value < 0) {
    value = -value;
    mask = 0x7f;
  }
  if (value > CLIP) value = CLIP;
  value += BIAS >> 2;
  const seg = segment(value, SEG_UEND);
  if (seg >= 8) return 0x7f ^ mask;
  return ((seg << 4) | ((value >> (seg + 1)) & 0x0f)) ^ mask;
}

function ulawToLinear(uval) {
  uval = ~uval & 0xff;
  let t = ((uval & 0x0f) << 3) + BIAS;
  t <<= (uval & 0x70) >> 4;
  return uval & 0x80 ? BIAS - t : t - BIAS;
}

const ALAW_TABLE = Int16Array.from({ length: 256 }, (_, i) => alawToLinear(i));
const ULAW_TABLE = Int16Array.from({ length: 256 }, (_, i) => ulawToLinear(i));

class RtpSession extends EventEmitter {
  constructor() {
    super();
    this.ssrc = crypto.randomBytes(4).readUInt32BE(0);
    this.seq = crypto.randomBytes(2).readUInt16BE(0);
    this.ts = crypto.randomBytes(4).readUInt32BE(0);
    this.mic = new Int16Array(FRAME); // angefangener 20-ms-Block
    this.micLen = 0;
    this.lastMicAt = -Infinity;
    this.stats = { voice: 0, silence: 0, maxGap: 0 };
    this.marker = true;
    this.remote = null;
    this.codec = null;
    this.timer = null;
    this.closed = false;
    this.dtmfQueue = [];
    this.dtmf = null;
    this.dtmfGap = 0;
  }

  open() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');
      this.socket.on('message', (buf, rinfo) => this.onPacket(buf, rinfo));
      this.socket.once('error', reject);
      this.socket.bind(0, () => {
        this.port = this.socket.address().port;
        resolve();
      });
    });
  }

  setRemote(ip, port, codec) {
    this.codec = codec;
    this.sdpIp = ip; // nur von dieser Adresse (laut Server-SDP) werden Sprachpakete angenommen
    this.remote = port && ip && ip !== '0.0.0.0' ? { ip, port } : null;
  }

  // Gesendet wird im Takt des Mikrofons: jeder volle 20-ms-Block geht sofort raus. So entstehen keine
  // Lücken, wenn Blöcke verspätet oder gebündelt ankommen, und nichts driftet, weil Soundkarte und
  // PC-Uhr nie exakt gleich schnell laufen. Liefert das Mikrofon nichts (noch nicht bereit, Fehler),
  // hält ein 20-ms-Takt den Strom mit Stille am Laufen.
  start() {
    if (this.timer || this.closed) return;
    let next = performance.now();
    const tick = () => {
      const now = performance.now();
      if (now - this.lastMicAt < MIC_STALE_MS) {
        next = now + 20;
      } else {
        if (now - next > 200) next = now;
        while (next <= now) {
          this.sendFrame(new Int16Array(FRAME));
          this.stats.silence++;
          next += 20;
        }
      }
      this.timer = setTimeout(tick, Math.max(1, next - performance.now()));
    };
    tick();
  }

  pushMic(samples) {
    if (!this.timer) return; // vor Gesprächsbeginn nichts puffern (käme sonst als Verzögerung dazu)
    const now = performance.now();
    if (this.lastMicAt > -Infinity) this.stats.maxGap = Math.max(this.stats.maxGap, now - this.lastMicAt);
    this.lastMicAt = now;
    for (let offset = 0; offset < samples.length;) {
      const n = Math.min(FRAME - this.micLen, samples.length - offset);
      this.mic.set(samples.subarray(offset, offset + n), this.micLen);
      this.micLen += n;
      offset += n;
      if (this.micLen === FRAME) {
        this.sendFrame(this.mic);
        this.stats.voice++;
        this.micLen = 0;
      }
    }
  }

  sendDtmf(digit, pt) {
    const event = DTMF_EVENTS[digit];
    if (event !== undefined) this.dtmfQueue.push({ event, pt });
  }

  sendFrame(frame) {
    if (this.dtmfGap > 0) this.dtmfGap--;
    else if (!this.dtmf && this.dtmfQueue.length) {
      this.dtmf = { ...this.dtmfQueue.shift(), ts: this.ts, duration: 0, ends: 0, first: true };
    }
    // Während eines Tastentons ersetzt das telephone-event-Paket das Sprachpaket.
    if (this.dtmf) this.sendDtmfPacket();
    else if (this.remote && this.codec) {
      const packet = Buffer.alloc(12 + FRAME);
      packet[0] = 0x80;
      packet[1] = (this.marker ? 0x80 : 0) | this.codec.pt;
      packet.writeUInt16BE(this.seq, 2);
      packet.writeUInt32BE(this.ts, 4);
      packet.writeUInt32BE(this.ssrc, 8);
      const encode = this.codec.name === 'PCMU' ? linearToUlaw : linearToAlaw;
      for (let i = 0; i < FRAME; i++) packet[12 + i] = encode(frame[i]);
      this.socket.send(packet, this.remote.port, this.remote.ip);
      this.marker = false;
    }
    this.seq = (this.seq + 1) & 0xffff;
    this.ts = (this.ts + FRAME) >>> 0;
  }

  // RFC 4733: ein Ereignis behält seine Zeitmarke, die Dauer wächst je Paket, am Ende E-Bit.
  sendDtmfPacket() {
    const d = this.dtmf;
    const end = d.duration >= DTMF_DURATION;
    if (end) d.ends++;
    else d.duration += FRAME;
    if (this.remote) {
      const packet = Buffer.alloc(16);
      packet[0] = 0x80;
      packet[1] = (d.first ? 0x80 : 0) | d.pt;
      packet.writeUInt16BE(this.seq, 2);
      packet.writeUInt32BE(d.ts, 4);
      packet.writeUInt32BE(this.ssrc, 8);
      packet[12] = d.event;
      packet[13] = (end ? 0x80 : 0) | DTMF_VOLUME;
      packet.writeUInt16BE(d.duration, 14);
      this.socket.send(packet, this.remote.port, this.remote.ip);
    }
    d.first = false;
    if (end && d.ends >= DTMF_END_PACKETS) {
      this.dtmf = null;
      this.dtmfGap = DTMF_GAP_FRAMES;
    }
  }

  onPacket(buf, rinfo) {
    // Nur die Adresse, die der Server in der SDP genannt hat (Server selbst, bei Direktverbindung das
    // andere Telefon). Sonst könnte jeder, der den Port errät, den Sprachstrom auf sich umlenken.
    if (!this.sdpIp || rinfo.address !== this.sdpIp) return;
    if (!this.codec || buf.length < 12 || buf[0] >> 6 !== 2) return;
    if ((buf[1] & 0x7f) !== this.codec.pt) return;
    let offset = 12 + (buf[0] & 0x0f) * 4;
    if (buf[0] & 0x10) {
      if (buf.length < offset + 4) return;
      offset += 4 + buf.readUInt16BE(offset + 2) * 4;
    }
    let end = buf.length;
    if (buf[0] & 0x20) end -= buf[end - 1];
    if (end <= offset) return;
    // Symmetrisches RTP: an den Port zurücksenden, von dem die Gegenstelle sendet (hilft bei NAT).
    this.remote = { ip: rinfo.address, port: rinfo.port };
    const table = this.codec.name === 'PCMU' ? ULAW_TABLE : ALAW_TABLE;
    const pcm = new Int16Array(end - offset);
    for (let i = 0; i < pcm.length; i++) pcm[i] = table[buf[offset + i]];
    this.emit('audio', pcm);
  }

  close() {
    if (this.timer && !this.closed) {
      const s = this.stats;
      console.log(`RTP gesendet: ${s.voice} Sprach-, ${s.silence} Stillepakete, längste Mikrofonpause ${Math.round(s.maxGap)} ms`);
    }
    this.closed = true;
    clearTimeout(this.timer);
    this.removeAllListeners();
    if (this.socket) this.socket.close();
  }
}

module.exports = { RtpSession, linearToAlaw, alawToLinear, linearToUlaw, ulawToLinear };
