'use strict';
// G.722 (64 kbit/s) – Breitband-Sprachcodec, 16 kHz Audio, im RTP mit 8-kHz-Zeitmarke (RFC 3551).
// Portierung der ITU-Referenz (Sub-Band-ADPCM mit QMF-Filterbank). Ein 20-ms-Block sind 320 Samples
// (16 kHz) und ergibt 160 Byte. Codec-Zustand (Prädiktor) läuft über die Blöcke hinweg, darum je Gespräch
// eine eigene Encoder-/Decoder-Instanz.

const QMF = [3, -11, 12, 32, -210, 951, 3876, -805, 362, -156, 53, -11];

const WL = [-60, -30, 58, 172, 334, 538, 1198, 3042];
const RL42 = [0, 7, 6, 5, 4, 3, 2, 1, 7, 6, 5, 4, 3, 2, 1, 0];
const ILB = [2048, 2093, 2139, 2186, 2233, 2282, 2332, 2383, 2435, 2489, 2543, 2599, 2656, 2714, 2774, 2834,
  2896, 2960, 3025, 3091, 3158, 3228, 3298, 3371, 3444, 3520, 3597, 3676, 3756, 3838, 3922, 4008];
const WH = [0, -214, 798];
const RH2 = [2, 1, 2, 1];
const QM2 = [-7408, -1616, 7408, 1616];
const QM4 = [0, -20456, -12896, -8968, -6288, -4240, -2584, -1200, 20456, 12896, 8968, 6288, 4240, 2584, 1200, 0];
const QM6 = [-136, -136, -136, -136, -24808, -21904, -19008, -16704, -14984, -13512, -12280, -11192, -10232, -9360, -8576, -7856,
  -7192, -6576, -6000, -5456, -4944, -4464, -4008, -3576, -3168, -2776, -2400, -2032, -1688, -1360, -1040, -728,
  24808, 21904, 19008, 16704, 14984, 13512, 12280, 11192, 10232, 9360, 8576, 7856, 7192, 6576, 6000, 5456,
  4944, 4464, 4008, 3576, 3168, 2776, 2400, 2032, 1688, 1360, 1040, 728, 432, 136, -432, -136];
const Q6 = [0, 35, 72, 110, 150, 190, 233, 276, 323, 370, 422, 473, 530, 587, 650, 714,
  786, 858, 940, 1023, 1121, 1219, 1339, 1458, 1612, 1765, 1980, 2195, 2557, 2919, 0, 0];
const ILN = [0, 63, 62, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 0];
const ILP = [0, 61, 60, 59, 58, 57, 56, 55, 54, 53, 52, 51, 50, 49, 48, 47, 46, 45, 44, 43, 42, 41, 40, 39, 38, 37, 36, 35, 34, 33, 32, 0];
const IHN = [0, 1, 0];
const IHP = [0, 3, 2];
const DEC_SHIFT = 11; // Ausgangsskalierung der Synthese-QMF (per Round-Trip auf Einheitsverstärkung geprüft)

const sat = (x) => (x > 32767 ? 32767 : x < -32768 ? -32768 : x);

function newBand() {
  return { s: 0, sp: 0, sz: 0, r: [0, 0, 0], a: [0, 0, 0], ap: [0, 0, 0], p: [0, 0, 0], d: [0, 0, 0, 0, 0, 0, 0], b: [0, 0, 0, 0, 0, 0, 0], bp: [0, 0, 0, 0, 0, 0, 0], sg: [0, 0, 0, 0, 0, 0, 0], nb: 0, det: 32 };
}

// Adaptiver Prädiktor (gemeinsam für Encoder und Decoder), aktualisiert die Band-Filter mit dem Fehler dx.
function block4(b, dx) {
  let i;
  b.d[0] = dx;
  b.r[0] = sat(b.s + dx);
  b.p[0] = sat(b.sz + dx);
  // UPPOL2
  for (i = 0; i < 3; i++) b.sg[i] = b.p[i] >> 15;
  let wd1 = sat(b.a[1] << 2);
  let wd2 = b.sg[0] === b.sg[1] ? -wd1 : wd1;
  if (wd2 > 32767) wd2 = 32767;
  let wd3 = (b.sg[0] === b.sg[2] ? 128 : -128) + (wd2 >> 7) + ((b.a[2] * 32512) >> 15);
  if (wd3 > 12288) wd3 = 12288; else if (wd3 < -12288) wd3 = -12288;
  b.ap[2] = wd3;
  // UPPOL1
  b.sg[0] = b.p[0] >> 15;
  b.sg[1] = b.p[1] >> 15;
  wd1 = b.sg[0] === b.sg[1] ? 192 : -192;
  wd2 = (b.a[1] * 32640) >> 15;
  b.ap[1] = sat(wd1 + wd2);
  wd3 = sat(15360 - b.ap[2]);
  if (b.ap[1] > wd3) b.ap[1] = wd3; else if (b.ap[1] < -wd3) b.ap[1] = -wd3;
  // UPZERO
  wd1 = dx === 0 ? 0 : 128;
  b.sg[0] = dx >> 15;
  for (i = 1; i < 7; i++) {
    b.sg[i] = b.d[i] >> 15;
    wd2 = b.sg[i] === b.sg[0] ? wd1 : -wd1;
    wd3 = (b.b[i] * 32640) >> 15;
    b.bp[i] = sat(wd2 + wd3);
  }
  // DELAYA
  for (i = 6; i > 0; i--) {
    b.d[i] = b.d[i - 1];
    b.b[i] = b.bp[i];
  }
  for (i = 2; i > 0; i--) {
    b.r[i] = b.r[i - 1];
    b.p[i] = b.p[i - 1];
    b.a[i] = b.ap[i];
  }
  // FILTEP
  wd1 = sat(b.r[1] + b.r[1]);
  wd1 = (b.a[1] * wd1) >> 15;
  wd2 = sat(b.r[2] + b.r[2]);
  wd2 = (b.a[2] * wd2) >> 15;
  b.sp = sat(wd1 + wd2);
  // FILTEZ
  b.sz = 0;
  for (i = 6; i > 0; i--) {
    wd1 = sat(b.d[i] + b.d[i]);
    b.sz += (b.b[i] * wd1) >> 15;
  }
  b.sz = sat(b.sz);
  // PREDIC
  b.s = sat(b.sp + b.sz);
}

class G722Encoder {
  constructor() {
    this.low = newBand();
    this.high = newBand();
    this.x = new Int32Array(24);
  }

  // amp: Int16Array mit gerader Länge (16 kHz). Rückgabe: Uint8Array halber Länge.
  encode(amp) {
    const out = new Uint8Array(amp.length >> 1);
    let o = 0;
    for (let j = 0; j < amp.length; ) {
      for (let i = 0; i < 22; i++) this.x[i] = this.x[i + 2];
      this.x[22] = amp[j++];
      this.x[23] = amp[j++];
      let sumeven = 0;
      let sumodd = 0;
      for (let i = 0; i < 12; i++) {
        sumodd += this.x[2 * i] * QMF[i];
        sumeven += this.x[2 * i + 1] * QMF[11 - i];
      }
      const xlow = (sumeven + sumodd) >> 14;
      const xhigh = (sumeven - sumodd) >> 14;

      // Tiefband: 6-Bit-Quantisierer
      const lo = this.low;
      const el = sat(xlow - lo.s);
      let wd = el >= 0 ? el : -(el + 1);
      let mil = 1;
      for (; mil < 30; mil++) {
        if (wd < ((Q6[mil] * lo.det) >> 12)) break;
      }
      const ilow = el < 0 ? ILN[mil] : ILP[mil];
      const ril = ilow >> 2;
      const dlow = (lo.det * QM4[ril]) >> 15;
      let nb = ((lo.nb * 127) >> 7) + WL[RL42[ril]];
      if (nb < 0) nb = 0; else if (nb > 18432) nb = 18432;
      lo.nb = nb;
      let wd1 = (nb >> 6) & 31;
      let wd2 = 8 - (nb >> 11);
      lo.det = (wd2 < 0 ? ILB[wd1] << -wd2 : ILB[wd1] >> wd2) << 2;
      block4(lo, dlow);

      // Hochband: 2-Bit-Quantisierer
      const hi = this.high;
      const eh = sat(xhigh - hi.s);
      wd = eh >= 0 ? eh : -(eh + 1);
      const mih = wd >= ((564 * hi.det) >> 12) ? 2 : 1;
      const ihigh = eh < 0 ? IHN[mih] : IHP[mih];
      const dhigh = (hi.det * QM2[ihigh]) >> 15;
      nb = ((hi.nb * 127) >> 7) + WH[RH2[ihigh]];
      if (nb < 0) nb = 0; else if (nb > 22528) nb = 22528;
      hi.nb = nb;
      wd1 = (nb >> 6) & 31;
      wd2 = 10 - (nb >> 11);
      hi.det = (wd2 < 0 ? ILB[wd1] << -wd2 : ILB[wd1] >> wd2) << 2;
      block4(hi, dhigh);

      out[o++] = (ihigh << 6) | ilow;
    }
    return out;
  }
}

class G722Decoder {
  constructor() {
    this.low = newBand();
    this.high = newBand();
    this.x = new Int32Array(24);
  }

  // g722: Uint8Array/Buffer. Rückgabe: Int16Array doppelter Länge (16 kHz).
  decode(g722) {
    const out = new Int16Array(g722.length * 2);
    let o = 0;
    for (let j = 0; j < g722.length; j++) {
      const code = g722[j];
      const ilow = code & 0x3f;
      const ihigh = (code >> 6) & 0x03;

      const lo = this.low;
      const ril = ilow >> 2;
      let dlowt = (lo.det * QM6[ilow]) >> 15;
      const rlow = sat(lo.s + dlowt) < -16384 ? -16384 : sat(lo.s + dlowt) > 16383 ? 16383 : sat(lo.s + dlowt);
      const dpred = (lo.det * QM4[ril]) >> 15; // Prädiktor läuft mit dem groben 4-Bit-Wert (wie der Encoder)
      let nb = ((lo.nb * 127) >> 7) + WL[RL42[ril]];
      if (nb < 0) nb = 0; else if (nb > 18432) nb = 18432;
      lo.nb = nb;
      let wd1 = (nb >> 6) & 31;
      let wd2 = 8 - (nb >> 11);
      lo.det = (wd2 < 0 ? ILB[wd1] << -wd2 : ILB[wd1] >> wd2) << 2;
      block4(lo, dpred);

      const hi = this.high;
      const dhigh = (hi.det * QM2[ihigh]) >> 15;
      let rhigh = sat(hi.s + dhigh);
      rhigh = rhigh < -16384 ? -16384 : rhigh > 16383 ? 16383 : rhigh;
      nb = ((hi.nb * 127) >> 7) + WH[RH2[ihigh]];
      if (nb < 0) nb = 0; else if (nb > 22528) nb = 22528;
      hi.nb = nb;
      wd1 = (nb >> 6) & 31;
      wd2 = 10 - (nb >> 11);
      hi.det = (wd2 < 0 ? ILB[wd1] << -wd2 : ILB[wd1] >> wd2) << 2;
      block4(hi, dhigh);

      for (let i = 0; i < 22; i++) this.x[i] = this.x[i + 2];
      this.x[22] = rlow + rhigh;
      this.x[23] = rlow - rhigh;
      let sumeven = 0;
      let sumodd = 0;
      for (let i = 0; i < 12; i++) {
        sumodd += this.x[2 * i] * QMF[i];
        sumeven += this.x[2 * i + 1] * QMF[11 - i];
      }
      out[o++] = sat(sumeven >> DEC_SHIFT);
      out[o++] = sat(sumodd >> DEC_SHIFT);
    }
    return out;
  }
}

module.exports = { G722Encoder, G722Decoder };
