// Brücke zwischen Browser-Audio (z.B. 48 kHz Float) und Telefon-Audio (8 kHz, 16 Bit).
// Eingang: Mikrofon -> wird auf 8 kHz heruntergerechnet und in 20-ms-Blöcken gepostet.
// Ausgang: 8-kHz-Samples vom Server -> Jitterpuffer -> hochgerechnet auf die Kontext-Rate.
const RATE = 8000;
const FRAME = 160;
const PREBUFFER = 480; // 60 ms
const MAX_LATENCY = 2400; // 300 ms
const TARGET_LATENCY = 800; // 100 ms

class PhoneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(RATE);
    this.r = 0;
    this.w = 0;
    this.frac = 0;
    this.playing = false;
    this.step = RATE / sampleRate;
    this.capSum = 0;
    this.capN = 0;
    this.capPhase = 0;
    this.cap = new Int16Array(FRAME);
    this.capLen = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'reset') {
        this.r = this.w = 0;
        this.playing = false;
        return;
      }
      this.enqueue(new Int16Array(e.data));
    };
  }

  available() {
    return (this.w - this.r + this.buf.length) % this.buf.length;
  }

  enqueue(pcm) {
    const len = this.buf.length;
    for (let i = 0; i < pcm.length; i++) {
      this.buf[this.w] = pcm[i] / 32768;
      this.w = (this.w + 1) % len;
      if (this.w === this.r) this.r = (this.r + 1) % len;
    }
    if (this.available() > MAX_LATENCY) this.r = (this.w - TARGET_LATENCY + len) % len;
  }

  capture(input) {
    for (let i = 0; i < input.length; i++) {
      this.capSum += input[i];
      this.capN++;
      this.capPhase += RATE;
      if (this.capPhase >= sampleRate) {
        this.capPhase -= sampleRate;
        const v = Math.max(-1, Math.min(1, this.capSum / this.capN));
        this.cap[this.capLen++] = v * 32767;
        this.capSum = 0;
        this.capN = 0;
        if (this.capLen === FRAME) {
          this.port.postMessage(this.cap.buffer, [this.cap.buffer]);
          this.cap = new Int16Array(FRAME);
          this.capLen = 0;
        }
      }
    }
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    if (input) this.capture(input);

    const out = outputs[0];
    const ch = out[0];
    const len = this.buf.length;
    for (let i = 0; i < ch.length; i++) {
      if (!this.playing && this.available() >= PREBUFFER) this.playing = true;
      if (!this.playing || this.available() < 2) {
        this.playing = false;
        ch[i] = 0;
        continue;
      }
      const a = this.buf[this.r];
      const b = this.buf[(this.r + 1) % len];
      ch[i] = a + (b - a) * this.frac;
      this.frac += this.step;
      while (this.frac >= 1) {
        this.frac -= 1;
        this.r = (this.r + 1) % len;
      }
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch);
    return true;
  }
}

registerProcessor('phone', PhoneProcessor);
