'use strict';
const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const FRAME = 160; // 20 ms @ 8 kHz
const MIC_BUFFER = FRAME * 10; // max. 200 ms Mikrofon-Puffer

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
    this.mic = new Int16Array(MIC_BUFFER);
    this.micLen = 0;
    this.micReady = false;
    this.marker = true;
    this.remote = null;
    this.codec = null;
    this.timer = null;
    this.closed = false;
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
    this.remote = port && ip && ip !== '0.0.0.0' ? { ip, port } : null;
  }

  // Sendetakt läuft auf dem Server (alle 20 ms), unabhängig davon, wie das Mikrofon liefert.
  start() {
    if (this.timer || this.closed) return;
    let next = performance.now();
    const tick = () => {
      const now = performance.now();
      if (now - next > 200) next = now;
      while (next <= now) {
        this.sendFrame();
        next += 20;
      }
      this.timer = setTimeout(tick, Math.max(1, next - performance.now()));
    };
    tick();
  }

  pushMic(samples) {
    if (samples.length > MIC_BUFFER) samples = samples.subarray(samples.length - MIC_BUFFER);
    const overflow = this.micLen + samples.length - MIC_BUFFER;
    if (overflow > 0) {
      this.mic.copyWithin(0, overflow, this.micLen);
      this.micLen -= overflow;
    }
    this.mic.set(samples, this.micLen);
    this.micLen += samples.length;
  }

  takeFrame() {
    const frame = new Int16Array(FRAME);
    // Kleiner Vorlauf nach einem Leerlauf, damit Netzwerk-Jitter nicht ständig Lücken erzeugt.
    if (!this.micReady && this.micLen >= FRAME * 2) this.micReady = true;
    if (!this.micReady || this.micLen < FRAME) {
      this.micReady = false;
      return frame;
    }
    frame.set(this.mic.subarray(0, FRAME));
    this.mic.copyWithin(0, FRAME, this.micLen);
    this.micLen -= FRAME;
    return frame;
  }

  sendFrame() {
    const frame = this.takeFrame();
    if (this.remote && this.codec) {
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

  onPacket(buf, rinfo) {
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
    // Symmetrisches RTP: dorthin senden, woher die Gegenstelle sendet (hilft bei NAT).
    this.remote = { ip: rinfo.address, port: rinfo.port };
    const table = this.codec.name === 'PCMU' ? ULAW_TABLE : ALAW_TABLE;
    const pcm = new Int16Array(end - offset);
    for (let i = 0; i < pcm.length; i++) pcm[i] = table[buf[offset + i]];
    this.emit('audio', pcm);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.removeAllListeners();
    if (this.socket) this.socket.close();
  }
}

module.exports = { RtpSession, linearToAlaw, alawToLinear, linearToUlaw, ulawToLinear };
