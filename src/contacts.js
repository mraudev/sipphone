'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Rufnummer vergleichbar/wählbar machen: "+49 (30) 123-45" -> "03012345", "+43 1 234" -> "00431234".
function normalizeNumber(value) {
  let n = String(value || '').replace(/^(sips?|tel):/i, '').split('@')[0].replace(/[^\d+*#]/g, '');
  if (n.startsWith('+49')) n = '0' + n.slice(3);
  else if (n.startsWith('0049')) n = '0' + n.slice(4);
  else if (n.startsWith('+')) n = '00' + n.slice(1);
  return n;
}

// Gleich, oder bei längeren Nummern gleiche Endung: Anlagen setzen oft eine Amtsholung (0) davor
// oder liefern die Nummer ohne führende 0.
function numbersMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const core = short.replace(/^0+/, '');
  return core.length >= 7 && long.endsWith(core);
}

// Telefonbuch in <dir>/contacts.json: [{ id, name, company, numbers: [{ label, number }], source }]
class Contacts {
  constructor(dir) {
    this.file = path.join(dir, 'contacts.json');
    try {
      this.entries = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.entries = [];
    }
    this.reindex();
  }

  reindex() {
    this.entries.sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
    this.index = [];
    for (const c of this.entries) {
      for (const n of c.numbers) this.index.push({ norm: normalizeNumber(n.number), name: c.name });
    }
  }

  save() {
    this.reindex();
    fs.writeFileSync(this.file, JSON.stringify(this.entries, null, 1));
  }

  // Name zu einer SIP-Adresse oder Nummer, sonst null.
  lookup(uriOrNumber) {
    const norm = normalizeNumber(uriOrNumber);
    if (!norm) return null;
    const hit = this.index.find((e) => e.norm === norm) || this.index.find((e) => numbersMatch(e.norm, norm));
    return hit ? hit.name : null;
  }

  upsert(data) {
    const name = String(data.name || '').trim();
    const numbers = (data.numbers || [])
      .map((n) => ({ label: String(n.label || '').trim(), number: String(n.number || '').trim() }))
      .filter((n) => normalizeNumber(n.number));
    if (!name) throw new Error('Bitte einen Namen eingeben.');
    if (!numbers.length) throw new Error('Bitte mindestens eine Telefonnummer eingeben.');
    const existing = data.id && this.entries.find((c) => c.id === data.id);
    const contact = { id: existing ? existing.id : crypto.randomUUID(), name, company: String(data.company || '').trim(), numbers, source: existing ? existing.source : 'manuell' };
    if (existing) this.entries[this.entries.indexOf(existing)] = contact;
    else this.entries.push(contact);
    this.save();
    return contact;
  }

  remove(id) {
    this.entries = this.entries.filter((c) => c.id !== id);
    this.save();
  }

  // Import: neue Kontakte anlegen, bei gleichem Namen fehlende Nummern ergänzen. Nichts wird gelöscht,
  // mehrfaches Importieren erzeugt keine Duplikate.
  merge(imported, source) {
    let added = 0;
    let updated = 0;
    for (const item of imported) {
      const name = String(item.name || '').trim();
      const numbers = (item.numbers || []).filter((n) => normalizeNumber(n.number));
      if (!name || !numbers.length) continue;
      const existing = this.entries.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (!existing) {
        this.entries.push({ id: crypto.randomUUID(), name, company: item.company || '', numbers, source });
        added++;
        continue;
      }
      const known = new Set(existing.numbers.map((n) => normalizeNumber(n.number)));
      const fresh = numbers.filter((n) => !known.has(normalizeNumber(n.number)));
      if (fresh.length) {
        existing.numbers.push(...fresh);
        updated++;
      }
    }
    this.save();
    return { added, updated, total: this.entries.length };
  }
}

module.exports = { Contacts, normalizeNumber, numbersMatch };
