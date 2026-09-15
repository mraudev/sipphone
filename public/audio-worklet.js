// Brücke zwischen Browser-Audio (z.B. 48 kHz Float) und Telefon-Audio (8 kHz, 16 Bit).
// Eingang: Mikrofon -> Tiefpass -> auf 8 kHz heruntergerechnet -> in 20-ms-Blöcken gepostet.
// Ausgang: 8-kHz-Samples vom Server -> Jitterpuffer -> hochgerechnet auf die Kontext-Rate.
const RATE = 8000;
const FRAME = 160;
const PREBUFFER = 480; // 60 ms
const MAX_LATENCY = 2400; // 300 ms
const TARGET_LATENCY = 800; // 100 ms

// Tiefpass vor dem Herunterrechnen: Telefonie überträgt nur bis 4 kHz. Alles darüber (z.B. Zischlaute)
// muss vorher weg, sonst klappt es beim Herunterrechnen in den Sprachbereich zurück (Aliasing) und die
// Stimme klingt beim Gegenüber kratzig. Kaiser-gefensterter Sinc: Durchlass bis 3,4 kHz, gesperrt ab
// 4,6 kHz (was dazwischen liegt, landet oberhalb von 3,4 kHz und damit außerhalb des Sprachbands).
const PASS = 3400;
const STOP = 4600;
const ATTEN = 70; // dB Sperrdämpfung
const PHASES = 64; // Zwischenpositionen, falls die Kontext-Rate kein Vielfaches von 8 kHz ist (44,1 kHz)

function besselI0(x) {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 50 && term > 1e-12 * sum; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
  }
  return sum;
}

// kernel[p][j] gewichtet das Eingangssample i0 - half + 1 + j für die Ausgabe an Position i0 + p/phases.
function designDecimator(rate) {
  const fc = (PASS + STOP) / 2 / rate;
  const width = (STOP - PASS) / rate;
  const beta = 0.1102 * (ATTEN - 8.7);
  const half = Math.ceil((ATTEN - 8) / (2.285 * 2 * Math.PI * width) / 2) + 1;
  const taps = 2 * half;
  const phases = Number.isInteger(rate / RATE) ? 1 : PHASES;
  const norm = besselI0(beta);
  const kernel = [];
  for (let p = 0; p < phases; p++) {
    const k = new Float32Array(taps);
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const x = p / phases + half - 1 - j; // Abstand Ausgabe - Eingang in Samples
      const r = x / half;
      const window = Math.abs(r) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / norm;
      const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
      k[j] = sinc * window;
      sum += k[j];
    }
    for (let j = 0; j < taps; j++) k[j] /= sum; // Lautstärke unverändert
    kernel.push(k);
  }
  return { half, taps, phases, kernel };
}

class PhoneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(RATE);
    this.r = 0;
    this.w = 0;
    this.frac = 0;
    this.playing = false;
    this.step = RATE / sampleRate;
    this.dec = designDecimator(sampleRate);
    this.ratio = sampleRate / RATE;
    this.hist = new Float32Array(2 * this.dec.taps); // Ringpuffer, doppelt beschrieben -> Fenster am Stück
    this.histPos = 0;
    this.inCount = 0; // bisher gelesene Eingangssamples
    this.outInt = 0; // Position der nächsten Ausgabe im Eingangsstrom (ganzzahliger Teil ...
    this.outFrac = 0; // ... und Bruchteil)
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
    const { half, taps, phases, kernel } = this.dec;
    const hist = this.hist;
    for (let i = 0; i < input.length; i++) {
      hist[this.histPos] = hist[this.histPos + taps] = input[i];
      this.histPos = this.histPos + 1 === taps ? 0 : this.histPos + 1;
      this.inCount++;
      // Die nächste Ausgabe braucht Eingang bis outInt + half; dann liegt ihr Fenster ab histPos am Stück.
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
