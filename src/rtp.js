'use strict';
const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { G722Encoder, G722Decoder } = require('./g722');

const FRAME = 160; // Payload-Bytes und RTP-Zeitmarke je 20 ms (bei allen Codecs, auch G.722)
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

function bindSocket(sock, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      sock.removeListener('error', onError);
      reject(err);
    };
    sock.once('error', onError);
    sock.bind(port, () => {
      sock.removeListener('error', onError);
      resolve();
    });
  });
}

class RtpSession extends EventEmitter {
  constructor() {
    super();
    this.ssrc = crypto.randomBytes(4).readUInt32BE(0);
    this.seq = crypto.randomBytes(2).readUInt16BE(0);
    this.ts = crypto.randomBytes(4).readUInt32BE(0);
    this.mic = new Int16Array(320); // angefangener 20-ms-Block (max. 320 Samples für G.722)
    this.micLen = 0;
    this.frameSamples = FRAME; // PCM-Samples je 20 ms (160 bei G.711, 320 bei G.722)
    this.g722enc = null;
    this.g722dec = null;
    this.lastMicAt = -Infinity;
    this.stats = { voice: 0, silence: 0, maxGap: 0 };
    // Empfangsstatistik (Gegenrichtung) und was die Anlage per RTCP über UNSEREN Strom zurückmeldet.
    this.rx = { received: 0, lost: 0, expected: 0, lastSeq: 0, lastArrival: null, lastTs: 0, jitter: 0, maxJitter: 0 };
    this.report = { count: 0, lost: 0, fraction: 0, maxJitterMs: 0 };
    this.rtcp = null;
    this.rtcpTimer = null;
    this.remoteSsrc = null; // SSRC der Gegenstelle (aus empfangenem RTP), für eigene RTCP-Berichte
    this.sdpPort = null; // RTP-Port der Gegenstelle laut SDP (RTCP dorthin auf Port+1)
    this.rtcpSeen = false;
    this.marker = true;
    this.remote = null;
    this.codec = null;
    this.timer = null;
    this.closed = false;
    this.dtmfQueue = [];
    this.dtmf = null;
    this.dtmfGap = 0;
  }

  // RTP auf einem geraden Port, RTCP auf Port+1 (so erwartet es Asterisk). Klappt Port+1 nicht, wird
  // ohne RTCP weitergemacht – dann fehlt nur die Rückmeldung der Anlage, das Gespräch läuft normal.
  async open() {
    for (let attempt = 0; attempt < 8; attempt++) {
      const rtp = dgram.createSocket('udp4');
      try {
        await bindSocket(rtp, 0);
      } catch {
        continue;
      }
      const port = rtp.address().port;
      if (port % 2 !== 0) {
        rtp.close();
        continue;
      }
      const rtcp = dgram.createSocket('udp4');
      try {
        await bindSocket(rtcp, port + 1);
      } catch {
        rtp.close();
        rtcp.close();
        continue;
      }
      this.socket = rtp;
      this.port = port;
      this.rtcp = rtcp;
      this.socket.on('message', (buf, rinfo) => this.onPacket(buf, rinfo));
      this.rtcp.on('message', (buf, rinfo) => this.onRtcp(buf, rinfo));
      this.socket.on('error', () => {});
      this.rtcp.on('error', () => {});
      console.log(`RTP-Ports: ${this.port} (RTP) / ${this.port + 1} (RTCP)`);
      return;
    }
    // Kein Paar frei bekommen: RTP allein, ohne RTCP-Auswertung.
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (buf, rinfo) => this.onPacket(buf, rinfo));
    await bindSocket(this.socket, 0);
    this.port = this.socket.address().port;
    console.log(`RTP-Port: ${this.port} (kein RTCP-Port verfügbar)`);
  }

  setRemote(ip, port, codec) {
    this.codec = codec;
    this.frameSamples = codec.frame || FRAME;
    if (codec.name === 'G722' && !this.g722enc) {
      this.g722enc = new G722Encoder();
      this.g722dec = new G722Decoder();
    }
    this.sdpIp = ip; // nur von dieser Adresse (laut Server-SDP) werden Sprachpakete angenommen
    this.sdpPort = port || null;
    this.remote = port && ip && ip !== '0.0.0.0' ? { ip, port } : null;
    // Renderer über die Audioabtastrate informieren (8 kHz bei G.711, 16 kHz bei G.722).
    this.emit('format', { rate: codec.rate || 8000 });
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
          this.sendFrame(new Int16Array(this.frameSamples));
          this.stats.silence++;
          next += 20;
        }
      }
      this.timer = setTimeout(tick, Math.max(1, next - performance.now()));
    };
    tick();
    if (this.rtcp) this.rtcpTimer = setInterval(() => this.sendReceiverReport(), 5000);
  }

  pushMic(samples) {
    if (!this.timer) return; // vor Gesprächsbeginn nichts puffern (käme sonst als Verzögerung dazu)
    const now = performance.now();
    if (this.lastMicAt > -Infinity) this.stats.maxGap = Math.max(this.stats.maxGap, now - this.lastMicAt);
    this.lastMicAt = now;
    for (let offset = 0; offset < samples.length;) {
      const n = Math.min(this.frameSamples - this.micLen, samples.length - offset);
      this.mic.set(samples.subarray(offset, offset + n), this.micLen);
      this.micLen += n;
      offset += n;
      if (this.micLen === this.frameSamples) {
        this.sendFrame(this.mic.subarray(0, this.frameSamples));
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
      if (this.codec.name === 'G722') {
        packet.set(this.g722enc.encode(frame), 12); // 320 Samples -> 160 Byte
      } else {
        const encode = this.codec.name === 'PCMU' ? linearToUlaw : linearToAlaw;
        for (let i = 0; i < FRAME; i++) packet[12 + i] = encode(frame[i]);
      }
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
    this.remoteSsrc = buf.readUInt32BE(8);
    this.countReceived(buf.readUInt16BE(2), buf.readUInt32BE(4), (buf[1] & 0x80) !== 0);
    let pcm;
    if (this.codec.name === 'G722') {
      pcm = this.g722dec.decode(buf.subarray(offset, end)); // 160 Byte -> 320 Samples
    } else {
      const table = this.codec.name === 'PCMU' ? ULAW_TABLE : ALAW_TABLE;
      pcm = new Int16Array(end - offset);
      for (let i = 0; i < pcm.length; i++) pcm[i] = table[buf[offset + i]];
    }
    this.emit('audio', pcm);
  }

  // Empfangene Pakete zählen und den Jitter der Gegenrichtung schätzen (RFC 3550). Verluste ergeben sich
  // aus Lücken in den Sequenznummern; verspätet/doppelt eintreffende Pakete werden dabei übergangen.
  countReceived(seq, ts, marker) {
    this.rx.received++;
    this.rx.lastSeq = seq;
    if (this.rx.received === 1) {
      this.rx.expected = (seq + 1) & 0xffff;
    } else {
      const gap = (seq - this.rx.expected) & 0xffff;
      if (gap < 0x8000) {
        this.rx.lost += gap;
        this.rx.expected = (seq + 1) & 0xffff;
      }
    }
    // Jitter aus der Abweichung zwischen Ankunftsabstand und Zeitstempelabstand. Die Zeitstempeldifferenz
    // wird als 32-Bit-Wert gelesen (Überlauf), und der erste Block einer Sprechpause (Marker) sowie große
    // Sprünge werden übergangen – sonst käme durch den Zeitstempelsprung ein unsinnig hoher Wert heraus.
    const now = performance.now();
    if (this.rx.lastArrival !== null && !marker) {
      let dts = (ts - this.rx.lastTs) & 0xffffffff;
      if (dts >= 0x80000000) dts -= 0x100000000;
      const d = Math.abs((now - this.rx.lastArrival) * 8 - dts);
      if (d < 8000) {
        this.rx.jitter += (d - this.rx.jitter) / 16;
        if (this.rx.jitter > this.rx.maxJitter) this.rx.maxJitter = this.rx.jitter;
      }
    }
    this.rx.lastArrival = now;
    this.rx.lastTs = ts;
  }

  // Kleiner eigener Empfangsbericht (RR) an die Gegenstelle. Das bringt Asterisk dazu, seinerseits
  // Berichte zu schicken, und öffnet die Firewall/NAT für eingehendes RTCP.
  sendReceiverReport() {
    const dest = this.remote && this.sdpPort ? { ip: this.remote.ip, port: this.sdpPort + 1 } : null;
    if (!this.rtcp || !dest || this.remoteSsrc === null) return;
    const p = Buffer.alloc(32);
    p[0] = 0x81; // Version 2, 1 Block
    p[1] = 201; // RR
    p.writeUInt16BE(32 / 4 - 1, 2);
    p.writeUInt32BE(this.ssrc, 4);
    p.writeUInt32BE(this.remoteSsrc, 8);
    p.writeUInt8(0, 12); // Verlustanteil vereinfachend 0
    p.writeUIntBE(Math.min(Math.max(this.rx.lost, 0), 0xffffff), 13, 3);
    p.writeUInt32BE(this.rx.lastSeq >>> 0, 16);
    p.writeUInt32BE(Math.round(this.rx.jitter) >>> 0, 20);
    try {
      this.rtcp.send(p, dest.port, dest.ip);
    } catch {}
  }

  // RTCP von der Anlage: aus den Empfangsberichten (SR/RR) lesen, was die Anlage über UNSEREN Strom
  // meldet – verlorene Pakete und Jitter der Sendestrecke. Das zeigt, ob Aussetzer auf dem Weg entstehen.
  onRtcp(buf, rinfo) {
    if (!this.rtcpSeen) {
      this.rtcpSeen = true;
      console.log(`Erstes RTCP von ${rinfo.address}:${rinfo.port}${rinfo.address === this.sdpIp ? '' : ` (erwartet ${this.sdpIp}, wird verworfen)`}`);
    }
    if (!this.sdpIp || rinfo.address !== this.sdpIp) return;
    let off = 0;
    while (off + 4 <= buf.length) {
      if (buf[off] >> 6 !== 2) break;
      const pt = buf[off + 1];
      const len = (buf.readUInt16BE(off + 2) + 1) * 4;
      if (off + len > buf.length) break;
      if (pt === 200 || pt === 201) {
        const count = buf[off] & 0x1f;
        let rb = off + (pt === 200 ? 28 : 8); // SR trägt vor den Blöcken 20 Byte Absender-Info
        for (let i = 0; i < count && rb + 24 <= off + len; i++, rb += 24) {
          if (buf.readUInt32BE(rb) !== this.ssrc) continue; // nur Berichte über unseren Strom
          const fraction = buf[rb + 4] / 256;
          const lost = (buf.readUInt32BE(rb + 4) << 8) >> 8; // 24-Bit-Wert (vorzeichenbehaftet)
          const jitterMs = buf.readUInt32BE(rb + 12) / 8;
          this.report.count++;
          this.report.fraction = fraction;
          this.report.lost = lost;
          if (jitterMs > this.report.maxJitterMs) this.report.maxJitterMs = jitterMs;
        }
      }
      off += len;
    }
  }

  logStats() {
    const s = this.stats;
    const rx = this.rx;
    const r = this.report;
    const codec = this.codec ? this.codec.name : '?';
    console.log(`RTP-Statistik (Codec ${codec}):`);
    console.log(`  gesendet: ${s.voice} Sprach-, ${s.silence} Stillepakete, längste Mikrofonpause ${Math.round(s.maxGap)} ms`);
    console.log(`  empfangen: ${rx.received} Pakete, ${rx.lost} Lücken (geschätzt), Jitter max ${(rx.maxJitter / 8).toFixed(1)} ms`);
    if (r.count) {
      console.log(`  Anlage meldet über unseren Sendestrom: ${r.count} Berichte, ${r.lost} Pakete verloren (zuletzt ${(r.fraction * 100).toFixed(1)} %), Jitter max ${r.maxJitterMs.toFixed(1)} ms`);
    } else {
      console.log('  Anlage meldet über unseren Sendestrom: keine RTCP-Berichte empfangen');
    }
  }

  close() {
    if (this.timer && !this.closed) this.logStats();
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.rtcpTimer);
    this.removeAllListeners();
    if (this.socket) this.socket.close();
    if (this.rtcp) this.rtcp.close();
  }
}

module.exports = { RtpSession, linearToAlaw, alawToLinear, linearToUlaw, ulawToLinear };
