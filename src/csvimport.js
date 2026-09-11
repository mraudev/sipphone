'use strict';
const fs = require('fs');

// Kontakte aus einer CSV-Datei, wie sie Outlook (klassisch, neu, Outlook.com) exportiert.
// Spaltennamen deutsch oder englisch; unbekannte Telefon-Spalten werden mit ihrem Namen übernommen.
const PHONE_LABELS = {
  'business phone': 'Geschäftlich', 'telefon geschäftlich': 'Geschäftlich',
  'business phone 2': 'Geschäftlich 2', 'telefon geschäftlich 2': 'Geschäftlich 2',
  'company main phone': 'Firma', 'telefon firma': 'Firma',
  'mobile phone': 'Mobil', 'mobiltelefon': 'Mobil',
  'home phone': 'Privat', 'telefon privat': 'Privat',
  'home phone 2': 'Privat 2', 'telefon privat 2': 'Privat 2',
  'primary phone': 'Haupt', 'haupttelefon': 'Haupt',
  'other phone': 'Weitere', 'weiteres telefon': 'Weitere',
  'car phone': 'Auto', 'autotelefon': 'Auto',
  "assistant's phone": 'Assistenz', 'telefon assistent': 'Assistenz',
};
const NAME = ['name', 'full name', 'display name', 'anzeigename'];
const FIRST = ['first name', 'vorname'];
const MIDDLE = ['middle name', 'weitere vornamen'];
const LAST = ['last name', 'nachname'];
const COMPANY = ['company', 'firma'];

// Klassisches Outlook exportiert ANSI (Windows-1252), neuere Exporte UTF-8.
function decode(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

// RFC 4180: Felder in "..." dürfen Trennzeichen, Zeilenumbrüche (Notizen!) und "" enthalten.
function parseCsv(text, sep) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function readContactsCsv(file) {
  const text = decode(fs.readFileSync(file));
  const nl = text.search(/\r?\n/);
  const head = nl < 0 ? text : text.slice(0, nl);
  const sep = [',', ';', '\t'].reduce((best, s) => (head.split(s).length > head.split(best).length ? s : best), ',');
  const [header, ...rows] = parseCsv(text, sep);
  if (!header) return [];
  const cols = header.map((h) => h.trim().toLowerCase());
  const find = (names) => cols.findIndex((c) => names.includes(c));
  const [iName, iFirst, iMiddle, iLast, iCompany] = [NAME, FIRST, MIDDLE, LAST, COMPANY].map(find);
  const phones = cols
    .map((c, i) => ({ i, label: PHONE_LABELS[c] || (/phone|telefon|mobil|handy/.test(c) && !/fax/.test(c) ? header[i].trim() : null) }))
    .filter((p) => p.label);
  if (!phones.length) throw new Error('Die Datei enthält keine Telefon-Spalten (z. B. „Mobile Phone“ oder „Mobiltelefon“).');
  const get = (row, i) => (i >= 0 && row[i] ? row[i].trim() : '');
  return rows
    .map((row) => {
      const company = get(row, iCompany);
      const name = get(row, iName) || [iFirst, iMiddle, iLast].map((i) => get(row, i)).filter(Boolean).join(' ') || company;
      const numbers = phones.map((p) => ({ label: p.label, number: get(row, p.i) })).filter((n) => n.number);
      return { name, company, numbers };
    })
    .filter((c) => c.name && c.numbers.length);
}

module.exports = { readContactsCsv, parseCsv };
