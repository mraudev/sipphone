'use strict';

// Kontakte als CSV. Die Spaltennamen sind so gewählt, dass unser eigener Import
// (csvimport.js) und das klassische Outlook (deutsche Bezeichnungen) sie wieder
// einlesen können. Trennzeichen ';' (deutsches Excel öffnet damit direkt in Spalten).
// Interne Bezeichnung -> Spaltenname, den unser Import (csvimport.js) wieder als Telefonnummer erkennt
// (die Namen entsprechen den deutschen Outlook-Spalten, die csvimport.js kennt).
const LABEL_HEADERS = {
  'Geschäftlich': 'Telefon geschäftlich',
  'Geschäftlich 2': 'Telefon geschäftlich 2',
  Mobil: 'Mobiltelefon',
  Privat: 'Telefon privat',
  'Privat 2': 'Telefon privat 2',
  Firma: 'Telefon Firma',
  Weitere: 'Weiteres Telefon',
  Haupt: 'Haupttelefon',
  Auto: 'Autotelefon',
  Assistenz: 'Telefon Assistent',
};
const STANDARD = ['Geschäftlich', 'Mobil', 'Privat', 'Firma', 'Weitere'].map((l) => LABEL_HEADERS[l]);

// Spaltenname zu einer Bezeichnung, so dass csvimport.js sie als Telefonnummer erkennt: bekannte
// Bezeichnung -> fester Name; sonst der Name selbst, falls er schon ein Telefon-Stichwort enthält,
// andernfalls mit „Telefon “ davor (sonst würde die Spalte beim Wiederimport verloren gehen).
function headerFor(label) {
  if (LABEL_HEADERS[label]) return LABEL_HEADERS[label];
  if (!label) return 'Telefon';
  return /phone|telefon|mobil|handy/i.test(label) ? label : `Telefon ${label}`;
}

// RFC 4180: Felder mit Trennzeichen, Anführungszeichen oder Zeilenumbruch einklammern.
function quote(value) {
  const s = String(value == null ? '' : value);
  return /[";,\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function contactsToCsv(entries) {
  const rows = entries.map((c) => {
    const seen = new Map();
    const phones = new Map();
    for (const n of c.numbers) {
      if (!n.number) continue;
      const base = headerFor(n.label);
      const k = (seen.get(base) || 0) + 1; // gleiche Bezeichnung mehrfach -> " 2", " 3"
      seen.set(base, k);
      phones.set(k > 1 ? `${base} ${k}` : base, n.number);
    }
    return { name: c.name, company: c.company || '', phones };
  });
  // Spalten: benutzte Standardspalten in fester Reihenfolge, dann übrige nach Auftreten.
  const columns = [];
  const add = (h) => { if (!columns.includes(h)) columns.push(h); };
  for (const h of STANDARD) if (rows.some((r) => r.phones.has(h))) add(h);
  for (const r of rows) for (const h of r.phones.keys()) add(h);
  const lines = [['Name', 'Firma', ...columns]];
  for (const r of rows) lines.push([r.name, r.company, ...columns.map((h) => r.phones.get(h) || '')]);
  return lines.map((row) => row.map(quote).join(';')).join('\r\n') + '\r\n';
}

module.exports = { contactsToCsv };
