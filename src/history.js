'use strict';
const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 200;

// Gesprächsverlauf, neueste Einträge zuerst, gespeichert in <dir>/history.json.
class CallHistory {
  constructor(dir) {
    this.file = path.join(dir, 'history.json');
    try {
      this.entries = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.entries = [];
    }
  }

  add(reason, call) {
    let status = 'answered';
    if (!call.startedAt) {
      if (call.direction === 'in') status = call.rejected ? 'rejected' : 'missed';
      else status = 'unanswered';
    }
    // Ausgehende Anrufe kennen keinen Namen -> aus früheren Einträgen derselben Nummer übernehmen.
    const known = this.entries.find((e) => e.remoteUri === call.remoteUri && e.remoteName);
    const entry = {
      direction: call.direction,
      remoteUri: call.remoteUri,
      remoteName: call.remoteName || (known ? known.remoteName : ''),
      at: call.createdAt,
      duration: call.startedAt ? Math.round((Date.now() - call.startedAt) / 1000) : null,
      status,
      reason,
      accountId: call.accountId || null,
      accountLabel: call.accountLabel || '',
    };
    this.entries.unshift(entry);
    this.entries.length = Math.min(this.entries.length, MAX_ENTRIES);
    this.save();
    return entry;
  }

  clear() {
    this.entries = [];
    this.save();
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.entries, null, 1));
  }
}

module.exports = { CallHistory };
