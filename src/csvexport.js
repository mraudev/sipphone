'use strict';

// Kontakte als CSV. Die Spaltennamen sind so gewählt, dass unser eigener Import
// (csvimport.js) und das klassische Outlook (deutsche Bezeichnungen) sie wieder
// einlesen können. Trennzeichen ';' (deutsches Excel öffnet damit direkt in Spalten).
const LABEL_HEADERS = {
  'Geschäftlich': 'Telefon geschäftlich',
  Mobil: 'Mobiltelefon',
  Privat: 'Telefon privat',
  Firma: 'Telefon Firma',
  Weitere: 'Weiteres Telefon',
};
const STANDARD = ['Geschäftlich', 'Mobil', 'Privat', 'Firma', 'Weitere'].map((l) => LABEL_HEADERS[l]);

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
      const base = LABEL_HEADERS[n.label] || n.label || 'Telefon';
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
