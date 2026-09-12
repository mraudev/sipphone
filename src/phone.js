'use strict';
const { EventEmitter } = require('events');
const { SipUA } = require('./sip');

// Mehrere SIP-Konten gleichzeitig: je Konto eine eigene SIP-Verbindung (eigener Port, eigene Anmeldung,
// eigener Server-Filter). Es gibt immer höchstens ein Gespräch – ein Anruf auf einem anderen Konto
// bekommt dann "besetzt", genau wie ein zweiter Anruf auf demselben Konto.
class Phone extends EventEmitter {
  constructor(accounts) {
    super();
    this.lines = [];
    for (const account of accounts) this.createLine(account);
  }

  createLine(account) {
    const ua = new SipUA(account, { isBusy: () => !!this.call });
    ua.on('state', () => this.emitState());
    ua.on('audio', (pcm) => this.emit('audio', pcm));
    ua.on('ended', (reason, call) => this.emit('ended', reason, { ...call, accountId: account.id, accountLabel: account.label }));
    const line = { account, ua };
    this.lines.push(line);
    return line;
  }

  line(id) {
    return this.lines.find((l) => l.account.id === id) || null;
  }

  // Die Verbindung mit dem laufenden Gespräch
  get active() {
    return this.lines.find((l) => l.ua.call) || null;
  }

  get call() {
    const active = this.active;
    return active ? active.ua.call : null;
  }

  snapshot() {
    const active = this.active;
    return {
      accounts: this.lines.map(({ account, ua }) => ({
        id: account.id,
        label: account.label,
        aor: ua.aor,
        server: `${account.proxy}:${account.proxyPort}`,
        state: ua.reg.state,
        reason: ua.reg.reason,
      })),
      call: active ? { ...active.ua.snapshot().call, accountId: active.account.id, accountLabel: active.account.label } : null,
    };
  }

  emitState() {
    this.emit('state', this.snapshot());
  }

  async start() {
    await Promise.all(this.lines.map((l) => l.ua.start()));
  }

  async stop() {
    await Promise.all(this.lines.map((l) => l.ua.stop()));
  }

  // "Neu anmelden" / "Übernehmen": alle Konten anmelden, auch ruhende.
  register() {
    for (const l of this.lines) l.ua.resume();
  }

  // PC gesperrt: alle Konten abmelden; beim Entsperren wieder anmelden.
  async lock() {
    await Promise.all(this.lines.map((l) => l.ua.standby('locked')));
  }

  unlock() {
    for (const l of this.lines) if (l.ua.standbyReason === 'locked') l.ua.resume();
  }

  // Ohne (gültige) Kontoangabe: das erste angemeldete Konto.
  async dial(target, accountId) {
    if (this.call) throw new Error('Es läuft bereits ein Gespräch');
    const line = this.line(accountId) || this.lines.find((l) => l.ua.reg.state === 'registered') || this.lines[0];
    if (!line) throw new Error('Kein Konto eingerichtet');
    await line.ua.dial(target);
  }

  answer() {
    if (this.active) this.active.ua.answer();
  }

  reject() {
    if (this.active) this.active.ua.reject();
  }

  hangup() {
    if (this.active) this.active.ua.hangup();
  }

  sendDtmf(digit) {
    if (this.active) this.active.ua.sendDtmf(digit);
  }

  pushAudio(pcm) {
    if (this.active) this.active.ua.pushAudio(pcm);
  }

  async addAccount(account) {
    const line = this.createLine(account);
    await line.ua.start();
    this.emitState();
  }

  // Ändert das Konto-Objekt selbst (Object.assign in reconfigure) und meldet neu an.
  async updateAccount(id, changes) {
    const line = this.line(id);
    if (line) await line.ua.reconfigure(changes);
  }

  async removeAccount(id) {
    const line = this.line(id);
    if (!line) return;
    this.lines = this.lines.filter((l) => l !== line);
    await line.ua.stop(); // meldet ab
    this.emitState();
  }
}

module.exports = { Phone };
