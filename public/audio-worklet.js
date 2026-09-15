// Brücke zwischen Browser-Audio (z.B. 48 kHz Float) und Telefon-Audio.
// Eingang: Mikrofon -> Tiefpass -> auf die Codec-Rate heruntergerechnet -> in Blöcken gepostet.
// Ausgang: Samples vom Server -> Jitterpuffer -> hochgerechnet auf die Kontext-Rate.
// Die Codec-Rate ist 8 kHz (G.711) oder 16 kHz (G.722) und wird per {type:'config', rate} umgeschaltet.
const FRAME = 160; // Samples je gepostetem Block
const DEFAULT_RATE = 8000;
const ATTEN = 70; // dB Sperrdämpfung des Tiefpasses
const PHASES = 64; // Zwischenpositionen, falls die Kontext-Rate kein Vielfaches der Codec-Rate ist (44,1 kHz)

function besselI0(x) {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 50 && term > 1e-12 * sum; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
  }
  return sum;
}

// Tiefpass vor dem Herunterrechnen: alles oberhalb des Telefonbands muss weg, sonst klappt es beim
// Herunterrechnen in den hörbaren Bereich zurück (Aliasing) und die Stimme klingt kratzig. Kaiser-Sinc.
// kernel[p][j] gewichtet das Eingangssample für die Ausgabe an Zwischenposition p/phases.
function designDecimator(contextRate, targetRate, passHz, stopHz) {
  const fc = (passHz + stopHz) / 2 / contextRate;
  const width = (stopHz - passHz) / contextRate;
  const beta = 0.1102 * (ATTEN - 8.7);
  const half = Math.ceil((ATTEN - 8) / (2.285 * 2 * Math.PI * width) / 2) + 1;
  const taps = 2 * half;
  const phases = Number.isInteger(contextRate / targetRate) ? 1 : PHASES;
  const norm = besselI0(beta);
  const kernel = [];
  for (let p = 0; p < phases; p++) {
    const k = new Float32Array(taps);
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const x = p / phases + half - 1 - j;
      const r = x / half;
      const window = Math.abs(r) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / norm;
      const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
      k[j] = sinc * window;
      sum += k[j];
    }
    for (let j = 0; j < taps; j++) k[j] /= sum;
    kernel.push(k);
  }
  return { half, taps, phases, kernel };
}

class PhoneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = new Int16Array(FRAME);
    this.capLen = 0;
    this.configure(DEFAULT_RATE);
    this.port.onmessage = (e) => {
      if (e.data === 'reset') {
        this.r = this.w = 0;
        this.playing = false;
      } else if (e.data && e.data.type === 'config') {
        this.configure(e.data.rate);
      } else {
        this.enqueue(new Int16Array(e.data));
      }
    };
  }

  configure(rate) {
    this.rate = rate;
    this.buf = new Float32Array(rate); // Jitterpuffer, ~1 s
    this.r = 0;
    this.w = 0;
    this.frac = 0;
    this.playing = false;
    this.step = rate / sampleRate;
    this.prebuffer = Math.round(rate * 0.06); // 60 ms
    this.maxLatency = Math.round(rate * 0.3); // 300 ms
    this.targetLatency = Math.round(rate * 0.1); // 100 ms
    // Telefonband bis knapp unter die halbe Codec-Rate: 3,4/4,6 kHz bei 8 kHz, 7,0/7,8 kHz bei 16 kHz.
    const pass = rate >= 16000 ? 7000 : 3400;
    const stop = rate >= 16000 ? 7800 : 4600;
    this.dec = designDecimator(sampleRate, rate, pass, stop);
    this.ratio = sampleRate / rate;
    this.hist = new Float32Array(2 * this.dec.taps);
    this.histPos = 0;
    this.inCount = 0;
    this.outInt = 0;
    this.outFrac = 0;
    this.capLen = 0;
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
    if (this.available() > this.maxLatency) this.r = (this.w - this.targetLatency + len) % len;
  }

  capture(input) {
    const { half, taps, phases, kernel } = this.dec;
    const hist = this.hist;
    for (let i = 0; i < input.length; i++) {
      hist[this.histPos] = hist[this.histPos + taps] = input[i];
      this.histPos = this.histPos + 1 === taps ? 0 : this.histPos + 1;
      this.inCount++;
      if (this.inCount - 1 < this.outInt + half) continue;
      const k = kernel[Math.floor(this.outFrac * phases)];
      let acc = 0;
      for (let j = 0, s = this.histPos; j < taps; j++, s++) acc += hist[s] * k[j];
      this.cap[this.capLen++] = Math.max(-1, Math.min(1, acc)) * 32767;
      if (this.capLen === FRAME) {
        this.port.postMessage(this.cap.buffer, [this.cap.buffer]);
        this.cap = new Int16Array(FRAME);
        this.capLen = 0;
      }
      this.outFrac += this.ratio;
      const whole = Math.floor(this.outFrac);
      this.outInt += whole;
      this.outFrac -= whole;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    if (input) this.capture(input);

    const out = outputs[0];
    const ch = out[0];
    const len = this.buf.length;
    for (let i = 0; i < ch.length; i++) {
      if (!this.playing && this.available() >= this.prebuffer) this.playing = true;
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
