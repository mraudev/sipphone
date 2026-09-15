'use strict';
const fs = require('fs');
const path = require('path');

// Schreibt alle Konsolenausgaben zusätzlich in eine Datei, damit ein Nutzer sie bei Problemen weitergeben
// kann (die installierte App hat keine sichtbare Konsole). Klein gehalten: bei 512 KB wird einmal rotiert.
const MAX_BYTES = 512 * 1024;

function timestamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function setup(dir) {
  const file = path.join(dir, 'sipphone.log');
  let size = 0;
  try {
    size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  } catch {}
  const write = (level, args) => {
    const line = `${timestamp()} ${level} ${args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(' ')}\n`;
    const buf = Buffer.from(line);
    try {
      fs.appendFileSync(file, buf);
      size += buf.length;
      if (size > MAX_BYTES) {
        fs.rmSync(`${file}.1`, { force: true });
        fs.renameSync(file, `${file}.1`); // aktuelle Datei wird zur Sicherung, neue beginnt beim nächsten Schreiben
        size = 0;
      }
    } catch {}
  };
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      write(level.toUpperCase(), args);
    };
  }
  return file;
}

module.exports = { setup };
