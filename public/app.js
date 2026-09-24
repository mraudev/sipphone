'use strict';

const $ = (id) => document.getElementById(id);
const IS_WIN = window.phone.platform === 'win32';

const REG_LABELS = {
  idle: 'Starte …',
  registering: 'Verbinde …',
  registered: 'Verbunden',
  unregistering: 'Melde ab …',
  unregistered: 'Abgemeldet',
  failed: 'Nicht verbunden',
  locked: 'Abgemeldet – PC gesperrt',
  elsewhere: 'An anderem Gerät',
};

let state = { accounts: [], call: null }; // accounts: Anmeldestatus je Konto (id, label, aor, state, reason)
let audio = null; // { ctx, node, ringCtx }
let mic = null; // null | 'pending' | { stream, source }
let muted = false;
let audioCfg = { microphone: '', speaker: '', ringer: '' }; // Gerätenamen aus config.json
let devices = [];
let history = [];
let contacts = []; // Telefonbuch; jede Nummer hat zusätzlich "dial" (wählbare Form)
let activeTab = 'dialer';
let editingContactId = null;
let ringtone = null; // { name, buffer } – eigener Klingelton, null = eingebaute Melodie
let accounts = []; // Kontodaten fürs Formular (ohne Zugangsdaten)
let editingAccount = false;
let editingAccountId = null;
let update = null; // heruntergeladenes Update, wartet auf Neustart: { version, notes }
let micProcessing = true; // Rausch-/Echounterdrückung fürs Mikrofon (aus config.json)
let ringOnHeadset = false; // Klingelton zusätzlich auf dem Gesprächsgerät (Headset)
let headsetAnswer = false; // Anruf per Mute-Knopf am Headset annehmen (WebHID)
let hidDevice = null; // verbundenes Headset (HID)
let hidArmedAt = 0; // ab diesem Zeitpunkt zählt ein Headset-Druck als Rufannahme
let hidWasIncoming = false; // Zustandswechsel erkennen (klingelt -> ...)
let hidAnswered = false; // aktuellen Anruf schon per Headset angenommen
let hidHook = undefined; // zuletzt gemeldeter Hook-Switch-Zustand (1 = off-hook / Knopf gedrückt)
let hidHookLoc = null; // Fundstelle des Hook-Switch-Bits im Input-Report
let hidCallKeys = []; // Fundstellen des Anruf-Knopfs im Media-Modus (Consumer Play/Pause) – Fallback
let hidRingLoc = null; // Fundstelle des Ring-Bits im Output-Report
let hidOffHookLoc = null; // Fundstelle des Off-Hook-Bits im Output-Report
const hidOut = new Map(); // reportId -> Uint8Array: gepufferte Ausgabe (LEDs/Signale)
let callRate = 8000; // Audioabtastrate des aktuellen Gesprächs (8 kHz G.711 / 16 kHz G.722)
let transferOpen = false; // Weiterleiten-Leiste im Gespräch sichtbar
let speakerMode = false; // Freisprech-Profil aktiv (eigenes Ein-/Ausgabegerät)
let favorites = []; // Kurzwahl: [{ name, number }]
let presence = {}; // Kurzwahl-Status je Nummer (BLF): 'idle' | 'ringing' | 'busy' | 'unknown'
let editingFavorite = null; // Nummer des gerade bearbeiteten Favoriten, null = neu

// --- Verbindung zum SIP-Stack im Electron-Hauptprozess ---

async function send(msg) {
  const res = await window.phone.command(msg);
  if (res && res.error) toast(res.error, true);
}

// --- Oberfläche ---

// Statuszeile: ein Konto wie gehabt, mehrere zusammengefasst ("1 von 2 verbunden").
function renderStatus() {
  const list = state.accounts || [];
  const registered = list.filter((a) => a.state === 'registered').length;
  let key;
  let text;
  let detail;
  if (!list.length) {
    [key, text, detail] = ['idle', 'Kein Konto', ''];
  } else if (list.length === 1) {
    key = list[0].state;
    text = REG_LABELS[key] || key;
    detail = list[0].aor.replace(/^sip:/, '');
  } else {
    if (registered === list.length) key = 'registered';
    else if (registered) key = 'partial';
    else if (list.some((a) => a.state === 'registering')) key = 'registering';
    else key = list.every((a) => a.state === list[0].state) ? list[0].state : 'failed';
    text = registered === list.length ? 'Verbunden' : registered ? `${registered} von ${list.length} verbunden` : REG_LABELS[key];
    detail = list.map((a) => a.label).join(' · ');
  }
  const status = $('regStatus');
  status.dataset.state = key;
  status.querySelector('.status-text').textContent = text;
  status.querySelector('.status-aor').textContent = detail;
  const problems = list.filter((a) => a.state === 'failed' && a.reason).map((a) => (list.length > 1 ? `${a.label}: ${a.reason}` : a.reason));
  $('regReason').hidden = !problems.length;
  $('regReason').textContent = problems.join('\n');
  // Ein anderes Gerät hat die Anmeldung übernommen – zurückholen nur auf Knopfdruck.
  const elsewhere = list.filter((a) => a.state === 'elsewhere');
  const takeover = $('takeoverBtn');
  takeover.hidden = !elsewhere.length;
  status.querySelector('.status-aor').hidden = !!elsewhere.length;
  status.style.paddingRight = elsewhere.length ? `${takeover.offsetWidth + 16}px` : '';
  takeover.title = list.length > 1
    ? `${elsewhere.map((a) => a.label).join(', ')} ${elsewhere.length > 1 ? 'sind' : 'ist'} an einem anderen Gerät angemeldet – hierher holen`
    : 'Das Konto ist an einem anderen Gerät angemeldet – hierher holen';
  renderAccountList();
  renderLineSelect();
}

function multipleAccounts() {
  return (state.accounts || []).length > 1;
}

// Konto für ausgehende Anrufe: gemerkte Auswahl, sonst das erste angemeldete.
function selectedLine() {
  const list = state.accounts || [];
  let saved = null;
  try {
    saved = localStorage.getItem('sipphone.line');
  } catch {}
  const line = list.find((a) => a.id === saved) || list.find((a) => a.state === 'registered') || list[0];
  return line ? line.id : null;
}

function renderLineSelect() {
  const list = state.accounts || [];
  $('lineRow').hidden = list.length < 2;
  $('dialer').classList.toggle('with-line', list.length >= 2);
  const current = selectedLine();
  $('lineSelect').replaceChildren(...list.map((a) => new Option(a.state === 'registered' ? a.label : `${a.label} (nicht verbunden)`, a.id)));
  $('lineSelect').value = current || '';
}

function render() {
  renderStatus();

  const call = state.call;
  $('updateBar').hidden = !update || !!call; // nie mitten im Gespräch
  if (update) {
    $('updateVersion').textContent = update.version;
    const notes = (update.notes || '').trim();
    $('updateNotesToggle').hidden = !notes;
    $('updateNotes').textContent = notes;
  }
  const setup = !call && (!accountConfigured() || editingAccount);
  $('accountView').hidden = !setup;
  $('tabs').hidden = !!call || setup;
  $('dialer').hidden = !!call || setup || activeTab !== 'dialer';
  $('history').hidden = !!call || setup || activeTab !== 'history';
  $('contacts').hidden = !!call || setup || activeTab !== 'contacts';
  $('speeddial').hidden = !!call || setup || activeTab !== 'speeddial';
  $('callView').hidden = !call;
  const line = (state.accounts || []).find((a) => a.id === selectedLine());
  $('callBtn').disabled = !line || line.state !== 'registered';

  if (call) {
    const consult = call.consult; // Rückfragegespräch (Weiterleiten mit Rückfrage)
    const disp = consult || call; // angezeigte Gegenstelle
    const user = disp.remoteUri.replace(/^(sips?|tel):/i, '').split('@')[0];
    const name = (consult ? consult.remoteName : call.contactName || call.remoteName) || user;
    $('callName').textContent = name;
    $('callUri').textContent = disp.remoteUri.replace(/^(sips?|tel):/i, '');
    const lineText = !consult && multipleAccounts() && call.accountLabel ? `${call.direction === 'in' ? 'Anruf für' : 'über'} ${call.accountLabel}` : '';
    $('callLine').textContent = lineText;
    $('callLine').hidden = !lineText;
    $('initials').textContent = initials(name);
    $('avatar').classList.toggle('ringing', ['incoming', 'ringing', 'calling'].includes(disp.state));
    const active = call.state === 'active';
    if (!active) transferOpen = false;
    const heldName = consult ? call.contactName || call.remoteName || call.remoteUri.replace(/^(sips?|tel):/i, '').split('@')[0] : '';
    $('consultHeld').hidden = !consult;
    $('consultHeld').textContent = consult ? `Gehalten: ${heldName}` : '';
    $('consultBar').hidden = !consult;
    $('consultJoin').disabled = !(consult && consult.state === 'active');
    $('answerBtn').hidden = call.state !== 'incoming';
    $('hangupBtn').hidden = !!consult;
    $('callControls').hidden = !!consult || !active || transferOpen;
    $('transferBar').hidden = !!consult || !(active && transferOpen);
    $('speakerBtn').classList.toggle('active', speakerMode);
    $('speakerBtn').title = speakerMode ? 'Freisprechen aus (zurück aufs Headset)' : 'Freisprechen (Lautsprecher-Profil)';
    $('volumeRow').hidden = !!consult; // Lautstärke im Gespräch immer sichtbar (außer während der Rückfrage)
    $('holdBtn').classList.toggle('active', !!call.held);
    $('holdBtn').title = call.held ? 'Gespräch zurückholen' : 'Halten';
    if (call.state !== 'active' && dtmfOpen) setDtmfOpen(false);
    document.title = call.state === 'incoming' ? `📞 ${name} ruft an` : 'SIP Phone';
  } else {
    document.title = 'SIP Phone';
    if (muted) setMuted(false); // nächstes Gespräch beginnt nicht stumm
    transferOpen = false;
    if (speakerMode) { // nächstes Gespräch beginnt wieder auf dem normalen Gerät
      speakerMode = false;
      applySinks();
    }
    if (dtmfOpen) setDtmfOpen(false);
    $('dtmfDigits').textContent = '';
    $('dtmfDigits').hidden = true;
  }
  updateCallStatus();
  updateAudio();
}

function initials(name) {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (/^\d/.test(words[0])) return '#';
  return (words[0][0] + (words[1] ? words[1][0] : '')).toUpperCase();
}

function updateCallStatus() {
  const call = state.call;
  if (!call) return;
  const consult = call.consult;
  const c = consult || call;
  let text;
  if (c.state === 'calling') text = consult ? 'Rückfrage – wählt …' : 'Wählt …';
  else if (c.state === 'ringing') text = consult ? 'Rückfrage – klingelt …' : 'Klingelt …';
  else if (c.state === 'incoming') text = 'Eingehender Anruf';
  else {
    const s = Math.max(0, Math.floor((Date.now() - c.startedAt) / 1000));
    text = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    if (consult) text = `Rückfrage · ${text}`;
    if (!consult && call.held) text += '  ·  Gehalten';
    if (!consult && call.codec) text += `  ·  ${call.codec}`;
    if (muted) text += '  ·  Stumm';
  }
  $('callStatus').textContent = text;
}

let toastTimer;
function toast(text, error = false) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('error', error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

function buildKeypad(container, onDigit) {
  const keys = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
    ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];
  for (const [digit, letters] of keys) {
    const b = document.createElement('button');
    b.className = 'key';
    b.innerHTML = `<b>${digit}</b><small>${letters}</small>`;
    b.onclick = () => onDigit(digit);
    container.append(b);
  }
}

// --- Tastentöne im Gespräch ---

const DTMF_FREQ = {
  1: [697, 1209], 2: [697, 1336], 3: [697, 1477],
  4: [770, 1209], 5: [770, 1336], 6: [770, 1477],
  7: [852, 1209], 8: [852, 1336], 9: [852, 1477],
  '*': [941, 1209], 0: [941, 1336], '#': [941, 1477],
};
let dtmfOpen = false;

function setDtmfOpen(open) {
  dtmfOpen = open;
  $('callKeypad').hidden = !open;
  $('callView').classList.toggle('dtmf-open', open);
  $('keypadBtn').classList.toggle('active', open);
  $('keypadBtn').setAttribute('aria-pressed', String(open));
}

// Kurzer Bestätigungston im Headset (die Gegenstelle bekommt das Signal über SIP/RTP).
function playDtmfTone(digit) {
  if (!audio || !DTMF_FREQ[digit]) return;
  const ctx = audio.ctx;
  const t = ctx.currentTime;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.08, t);
  gain.gain.setValueAtTime(0, t + 0.12);
  gain.connect(ctx.destination);
  for (const freq of DTMF_FREQ[digit]) {
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + 0.13);
  }
}

function sendDtmf(digit) {
  if (!state.call || state.call.state !== 'active') return;
  send({ type: 'dtmf', digit });
  playDtmfTone(digit);
  const shown = $('dtmfDigits');
  shown.textContent = (shown.textContent + digit).slice(-20);
  shown.hidden = false;
}

function dial() {
  const target = $('number').value.trim();
  if (!target) return;
  hideSuggest();
  send({ type: 'dial', target, accountId: selectedLine() });
}

// --- Vorschläge beim Tippen: Abgleich mit Telefonbuch und Verlauf ---

// Liefert bis zu 6 Treffer für die Eingabe. Buchstaben -> Namenssuche, Ziffern -> Nummernsuche.
function numberSuggestions(input) {
  const q = input.trim().toLowerCase();
  if (!q) return [];
  const digits = input.replace(/\D/g, '');
  const hasLetters = /[a-zA-Z]/.test(input);
  const out = [];
  const seen = new Set();
  const add = (name, sub, number, target, accountId) => {
    const nd = number.replace(/\D/g, '');
    const key = nd.length >= 4 ? nd.slice(-9) : (target || number).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, sub, number, target, accountId });
  };
  for (const c of contacts) {
    const nameHit = hasLetters && (c.name.toLowerCase().includes(q) || (c.company || '').toLowerCase().includes(q));
    for (const n of c.numbers) {
      if (nameHit || (digits.length >= 2 && n.dial.includes(digits))) add(c.name, n.label || 'Telefon', n.number, n.dial);
    }
  }
  for (const e of history) { // history ist bereits neueste zuerst
    const name = e.contactName || e.remoteName || '';
    const num = shortUri(e.remoteUri);
    const nameHit = hasLetters && name.toLowerCase().includes(q);
    if (nameHit || (digits.length >= 2 && num.replace(/\D/g, '').includes(digits))) add(name || num, 'Verlauf', num, e.remoteUri, e.accountId);
    if (out.length >= 6) break;
  }
  return out.slice(0, 6);
}

function hideSuggestBox(box) {
  box.hidden = true;
  box.replaceChildren();
}

// Vorschläge in eine beliebige Liste rendern (Wählfeld und Weiterleiten-Feld teilen sich die Logik).
function renderSuggestBox(inputEl, box, allow, onPick) {
  const list = allow ? numberSuggestions(inputEl.value) : [];
  if (!list.length) {
    hideSuggestBox(box);
    return;
  }
  box.replaceChildren(...list.map((s) => {
    const item = el('button', 'suggest-item');
    item.type = 'button';
    item.append(el('span', 'contact-avatar', initials(s.name)));
    const text = el('div', 's-text');
    text.append(el('span', 's-name', s.name), el('span', 's-sub', `${s.sub} · ${s.number}`));
    item.append(text, svgIcon(ICON_PATHS.phone));
    // Klick würde sonst das Feld unscharf schalten, bevor er ankommt -> auf mousedown auslösen.
    item.onmousedown = (e) => {
      e.preventDefault();
      onPick(s);
    };
    return item;
  }));
  box.hidden = false;
}

function hideSuggest() {
  hideSuggestBox($('numberSuggest'));
}

function renderSuggest() {
  renderSuggestBox($('number'), $('numberSuggest'), !state.call, (s) => {
    const known = (state.accounts || []).some((a) => a.id === s.accountId);
    $('number').value = s.number;
    hideSuggest();
    send({ type: 'dial', target: s.target, accountId: known ? s.accountId : selectedLine() });
  });
}

// --- Halten und Weiterleiten ---

function toggleHold() {
  if (state.call && state.call.state === 'active') send({ type: 'hold', on: !state.call.held });
}

function openTransfer() {
  if (!state.call || state.call.state !== 'active') return;
  if (dtmfOpen) setDtmfOpen(false);
  transferOpen = true;
  render();
  $('transferInput').value = '';
  hideSuggestBox($('transferSuggest'));
  $('transferInput').focus();
}

function closeTransfer() {
  transferOpen = false;
  hideSuggestBox($('transferSuggest'));
  render();
}

function renderTransferSuggest() {
  // Auswahl füllt nur das Feld; danach entscheidet der Nutzer: direkt oder mit Rückfrage.
  renderSuggestBox($('transferInput'), $('transferSuggest'), true, (s) => {
    $('transferInput').value = s.number;
    hideSuggestBox($('transferSuggest'));
    $('transferInput').focus();
  });
}

function doTransfer(target) {
  const value = (target || '').trim();
  if (!value) return;
  send({ type: 'transfer', target: value });
  closeTransfer();
}

function doAttendedTransfer(target) {
  const value = (target || '').trim();
  if (!value) return;
  send({ type: 'attendedTransfer', target: value });
  closeTransfer();
}

// --- Freisprechen (Profil mit eigenem Ein-/Ausgabegerät) und Lautstärke im Gespräch ---

// Ein Tipp: auf das Freisprech-Profil umstellen und zurück. Ausgabe sofort, Mikrofon neu aufnehmen.
function toggleSpeaker() {
  if (!state.call) return;
  speakerMode = !speakerMode;
  applySinks();
  if (mic) {
    stopMic();
    updateAudio();
  }
  render();
}

function setVolume(v) {
  const value = Math.max(0, Math.min(1.5, v));
  if (audio) audio.gain.gain.value = value;
  audioCfg = { ...audioCfg, volume: value };
  window.phone.setAudio({ volume: value });
}

// --- Konten ---

function accountConfigured() {
  return accounts.length > 0;
}

// Ohne Konto: neues Konto anlegen (beim ersten Start "SIP-Konto einrichten").
function showAccountForm(account = null) {
  const form = $('accountForm');
  editingAccountId = account ? account.id : null;
  for (const name of ['label', 'displayName', 'username', 'domain', 'authUsername', 'proxy']) {
    form.elements[name].value = (account && account[name]) || '';
  }
  // Proxy nur anzeigen, wenn er vom Server abweicht
  if (account && account.proxy === account.domain) form.elements.proxy.value = '';
  form.elements.proxyPort.value = account && account.proxyPort !== 5060 ? account.proxyPort : '';
  form.elements.password.value = '';
  form.elements.password.placeholder = account && account.hasCredentials ? 'unverändert lassen' : '';
  $('accountTitle').textContent = account ? 'Konto bearbeiten' : accountConfigured() ? 'Konto hinzufügen' : 'SIP-Konto einrichten';
  $('accountCancel').hidden = !accountConfigured();
  $('accountDelete').hidden = !account;
  $('accountError').hidden = true;
  editingAccount = accountConfigured();
  render();
}

function closeAccountForm() {
  editingAccount = false;
  editingAccountId = null;
  if (accountConfigured()) render();
  else showAccountForm();
}

function showAccountError(text) {
  $('accountError').textContent = text;
  $('accountError').hidden = false;
}

async function saveAccount(e) {
  e.preventDefault();
  $('accountSave').disabled = true;
  try {
    const res = await window.phone.saveAccount({ ...Object.fromEntries(new FormData($('accountForm'))), id: editingAccountId });
    if (res.error) {
      showAccountError(res.error);
      return;
    }
    accounts = res.accounts;
    closeAccountForm();
  } finally {
    $('accountSave').disabled = false;
  }
}

async function deleteAccount() {
  const account = accounts.find((a) => a.id === editingAccountId);
  if (!account || !confirm(`Konto „${account.label}“ wirklich löschen?`)) return;
  const res = await window.phone.deleteAccount(account.id);
  if (res.error) {
    showAccountError(res.error);
    return;
  }
  accounts = res.accounts;
  closeAccountForm();
}

// Kontoliste in den Einstellungen, mit Anmeldestatus je Konto.
function renderAccountList() {
  const status = new Map((state.accounts || []).map((a) => [a.id, a]));
  $('accountList').replaceChildren(...accounts.map((a) => {
    const s = status.get(a.id);
    const item = el('div', 'account-item');
    item.dataset.state = s ? s.state : 'idle';
    const text = el('div', 'account-item-text');
    let problem = '';
    if (s && s.state === 'failed' && s.reason) problem = s.reason;
    else if (s && (s.state === 'elsewhere' || s.state === 'locked')) problem = REG_LABELS[s.state];
    text.append(el('b', '', a.label), el('small', 'muted', `${a.username}@${a.domain}`));
    if (problem) text.append(el('small', 'muted account-problem', problem)); // eigene Zeile, bricht um
    const edit = el('button', 'icon-btn subtle');
    edit.type = 'button';
    edit.title = `${a.label} bearbeiten`;
    edit.append(svgIcon(ICON_PATHS.edit));
    edit.onclick = () => {
      $('settings').close();
      showAccountForm(a);
    };
    item.append(el('span', 'dot'), text, edit);
    return item;
  }));
}

// --- Blättern statt Scrollen ---

// Zeigt eine Liste seitenweise: pro Seite so viele Einträge, wie in den Platz passen (Einträge dürfen
// unterschiedlich hoch sein). Das Mausrad blättert, bei Größenänderung wird neu aufgeteilt.
class Pager {
  constructor(list, bar) {
    this.list = list;
    this.bar = bar;
    this.label = bar.querySelector('.pager-label');
    this.prev = bar.querySelector('[data-dir="-1"]');
    this.next = bar.querySelector('[data-dir="1"]');
    this.page = 0;
    this.pages = [];
    this.wheelSum = 0;
    this.wheelAt = 0;
    this.prev.onclick = () => this.go(-1);
    this.next.onclick = () => this.go(1);
    list.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    new ResizeObserver(() => this.layout()).observe(list);
  }

  show(items) {
    this.list.replaceChildren(...items);
    this.list.hidden = !items.length;
    this.page = 0;
    if (!items.length) {
      // Ausgeblendete Liste hat keine Höhe, layout() würde abbrechen -> Seitenleiste hier verstecken
      this.pages = [];
      this.bar.style.visibility = 'hidden';
      return;
    }
    this.layout();
  }

  layout() {
    const space = this.list.clientHeight;
    if (!space) return; // Reiter gerade nicht sichtbar – ResizeObserver meldet sich beim Einblenden
    const items = [...this.list.children];
    for (const item of items) item.hidden = false;
    this.pages = [];
    let page = [];
    let used = 0;
    for (const item of items) {
      const height = item.offsetHeight;
      if (page.length && used + height > space) {
        this.pages.push(page);
        page = [];
        used = 0;
      }
      page.push(item);
      used += height;
    }
    this.pages.push(page);
    this.page = Math.min(this.page, this.pages.length - 1);
    this.apply();
  }

  apply() {
    this.pages.forEach((items, i) => items.forEach((item) => (item.hidden = i !== this.page)));
    const count = this.pages.length;
    this.bar.style.visibility = count > 1 && !this.list.hidden ? 'visible' : 'hidden'; // Platz bleibt reserviert
    this.label.textContent = `Seite ${this.page + 1} von ${count}`;
    this.prev.disabled = this.page === 0;
    this.next.disabled = this.page === count - 1;
  }

  go(delta) {
    const target = Math.max(0, Math.min(this.pages.length - 1, this.page + delta));
    if (target === this.page) return;
    this.page = target;
    this.apply();
  }

  // Ein Radschritt = eine Seite. Touchpads liefern viele kleine Schritte: sammeln und kurz sperren.
  onWheel(e) {
    e.preventDefault();
    const now = Date.now();
    if (now - this.wheelAt < 250) return;
    this.wheelSum += e.deltaY;
    if (Math.abs(this.wheelSum) < 40) return;
    this.go(Math.sign(this.wheelSum));
    this.wheelSum = 0;
    this.wheelAt = now;
  }
}

const historyPager = new Pager($('historyList'), $('historyPager'));
const contactPager = new Pager($('contactList'), $('contactPager'));
const favoritePager = new Pager($('favoriteList'), $('favoritePager'));

// --- Verlauf ---

const ICON_PATHS = {
  out: 'M9 5v2h6.59L4 18.59 5.41 20 17 8.41V15h2V5z',
  in: 'M20 5.41 18.59 4 7 15.59V9H5v10h10v-2H8.41z',
  missed: 'M19.59 7 12 14.59 6.41 9H11V7H3v8h2v-4.59l7 7 9-9z',
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  phone: 'M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1z',
  personAdd: 'M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
  star: 'M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
  starOutline: 'M22 9.24l-7.19-.62L12 2 9.19 8.62 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.04L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28z',
};

function svgIcon(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

// Texte aus dem Netz (Anrufername) nur per textContent einsetzen.
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function setTab(tab) {
  activeTab = tab;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === tab);
  if (tab === 'history') markHistorySeen();
  render();
  // Gleich aufteilen: der ResizeObserver meldet sich erst beim nächsten Zeichnen – und gar nicht,
  // solange Windows das Fenster für verdeckt hält.
  if (tab === 'history') historyPager.layout();
  else if (tab === 'contacts') contactPager.layout();
  else if (tab === 'speeddial') favoritePager.layout();
}

function historySeen() {
  try {
    return Number(localStorage.getItem('sipphone.historySeen')) || 0;
  } catch {
    return 0;
  }
}

function markHistorySeen() {
  try {
    localStorage.setItem('sipphone.historySeen', String(Date.now()));
  } catch {}
  renderBadge();
}

function renderBadge() {
  const seen = historySeen();
  const missed = history.filter((e) => e.status === 'missed' && e.at > seen).length;
  $('missedBadge').hidden = !missed;
  $('missedBadge').textContent = missed;
}

// Nummer ohne eigene Domain anzeigen, fremde SIP-Adressen vollständig.
function shortUri(uri) {
  const user = uri.replace(/^(sips?|tel):/i, '');
  const at = user.lastIndexOf('@');
  const ownDomains = (state.accounts || []).map((a) => a.aor.split('@')[1]);
  return at > 0 && ownDomains.includes(user.slice(at + 1)) ? user.slice(0, at) : user;
}

function formatWhen(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const today = new Date().setHours(0, 0, 0, 0);
  const days = Math.round((today - new Date(ts).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return time;
  if (days === 1) return `Gestern ${time}`;
  return `${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} ${time}`;
}

function describe(entry) {
  if (entry.status === 'answered') return `${Math.floor(entry.duration / 60)}:${String(entry.duration % 60).padStart(2, '0')}`;
  if (entry.status === 'missed') return 'Verpasst';
  if (entry.status === 'rejected') return 'Abgelehnt';
  return entry.reason === 'Aufgelegt' ? 'Abgebrochen' : entry.reason;
}

function renderHistory() {
  historyPager.show(history.map((entry) => {
    const failed = entry.status === 'missed' || entry.status === 'rejected';
    const li = el('li', `entry ${entry.direction}${failed ? ' failed' : ''}`);
    const dir = el('span', 'entry-dir');
    dir.append(svgIcon(entry.direction === 'out' ? ICON_PATHS.out : failed ? ICON_PATHS.missed : ICON_PATHS.in));
    const number = shortUri(entry.remoteUri);
    const name = entry.contactName || entry.remoteName;
    const who = el('div', 'entry-who');
    const sub = [name ? number : '', multipleAccounts() ? entry.accountLabel : ''].filter(Boolean).join(' · ');
    who.append(el('b', '', name || number), el('small', 'muted', sub));
    const meta = el('div', 'entry-meta');
    meta.append(el('small', 'muted', formatWhen(entry.at)), el('small', 'entry-status', describe(entry)));
    const callBack = el('button', 'icon-btn entry-call');
    callBack.title = 'Zurückrufen';
    callBack.append(svgIcon(ICON_PATHS.phone));
    // Rückruf über das Konto, auf dem das Gespräch lief (falls es das noch gibt)
    const known = (state.accounts || []).some((a) => a.id === entry.accountId);
    callBack.onclick = () => send({ type: 'dial', target: entry.remoteUri, accountId: known ? entry.accountId : selectedLine() });
    li.append(dir, who, meta);
    // Nur anbieten, wenn die Nummer noch nicht im Telefonbuch steht
    if (!entry.contactName) {
      const add = el('button', 'icon-btn subtle entry-add');
      add.title = 'Als Kontakt speichern';
      add.append(svgIcon(ICON_PATHS.personAdd));
      add.onclick = () => openContactDialog(null, { name: entry.remoteName || '', number: entry.remoteUri.replace(/^(sips?|tel):/i, '').split('@')[0] });
      li.append(add);
    }
    li.append(callBack);
    return li;
  }));
  $('historyEmpty').hidden = history.length > 0;
  $('clearHistory').hidden = history.length === 0;
  renderBadge();
}

// --- Telefonbuch ---

const NUMBER_LABELS = ['Geschäftlich', 'Mobil', 'Privat', 'Firma', 'Weitere'];

function renderContacts() {
  const query = $('contactSearch').value.trim().toLowerCase();
  const digits = query.replace(/\D/g, '');
  const matches = contacts.filter((c) => !query
    || c.name.toLowerCase().includes(query)
    || (c.company || '').toLowerCase().includes(query)
    || (digits.length >= 3 && c.numbers.some((n) => n.dial.includes(digits))));
  contactPager.show(matches.map((c) => {
    const li = el('li', 'contact');
    const head = el('div', 'contact-head');
    const who = el('div', 'entry-who');
    who.append(el('b', '', c.name), el('small', 'muted', c.company || ''));
    const edit = el('button', 'icon-btn subtle');
    edit.title = 'Bearbeiten';
    edit.append(svgIcon(ICON_PATHS.edit));
    edit.onclick = () => openContactDialog(c);
    head.append(el('span', 'contact-avatar', initials(c.name)), who, edit);
    const numbers = el('div', 'contact-numbers');
    for (const n of c.numbers) {
      const dial = el('button', 'contact-number');
      dial.title = `${n.number} anrufen`;
      dial.append(el('small', 'muted', n.label || 'Telefon'), el('span', '', n.number), svgIcon(ICON_PATHS.phone));
      dial.onclick = () => send({ type: 'dial', target: n.dial, accountId: selectedLine() });
      const onFav = favorites.some((f) => f.number === n.dial);
      const star = el('button', `icon-btn subtle contact-fav${onFav ? ' on' : ''}`);
      star.title = onFav ? 'Von Kurzwahl entfernen' : 'Auf Kurzwahl legen';
      star.append(svgIcon(onFav ? ICON_PATHS.star : ICON_PATHS.starOutline));
      star.onclick = () => toggleFavorite(c.name, n.dial);
      const row = el('div', 'contact-number-row');
      row.append(dial, star);
      numbers.append(row);
    }
    li.append(head, numbers);
    return li;
  }));
  $('contactsEmpty').hidden = matches.length > 0;
  $('contactsEmpty').textContent = contacts.length
    ? 'Keine Treffer'
    : IS_WIN
      ? 'Noch keine Kontakte. Mit „Outlook“ importieren oder mit + anlegen.'
      : 'Noch keine Kontakte. Mit „Import“ als CSV übernehmen oder mit + anlegen.';
}

// --- Kurzwahl (Besetztlampenfeld) ---

const PRESENCE_LABELS = { idle: 'frei', ringing: 'klingelt', busy: 'besetzt', unknown: 'kein Status' };

function renderFavorites() {
  favoritePager.show(favorites.map((f) => {
    const state = presence[f.number] || 'unknown';
    const li = el('li', 'favorite');
    li.dataset.state = state;
    const dot = el('span', 'fav-dot');
    dot.title = PRESENCE_LABELS[state];
    const who = el('div', 'fav-who');
    who.title = `${f.number} anrufen`;
    who.append(el('b', '', f.name || f.number), el('small', '', `${f.name ? f.number + ' · ' : ''}${PRESENCE_LABELS[state]}`));
    who.onclick = () => send({ type: 'dial', target: f.number, accountId: selectedLine() });
    const edit = el('button', 'icon-btn subtle');
    edit.title = 'Bearbeiten';
    edit.append(svgIcon(ICON_PATHS.edit));
    edit.onclick = () => openFavoriteDialog(f);
    const call = el('button', 'icon-btn fav-call');
    call.title = 'Anrufen';
    call.append(svgIcon(ICON_PATHS.phone));
    call.onclick = () => send({ type: 'dial', target: f.number, accountId: selectedLine() });
    li.append(dot, who, edit, call);
    return li;
  }));
  $('favoritesEmpty').hidden = favorites.length > 0;
}

// Nummer eines Kontakts auf die Kurzwahl legen bzw. wieder entfernen (Stern im Telefonbuch).
async function toggleFavorite(name, number) {
  const exists = favorites.some((f) => f.number === number);
  const next = exists ? favorites.filter((f) => f.number !== number) : [...favorites, { name, number }];
  const res = await window.phone.saveFavorites(next);
  favorites = res.list;
  renderFavorites();
  renderContacts(); // Sterne im Telefonbuch aktualisieren
  toast(exists ? 'Von Kurzwahl entfernt' : 'Auf Kurzwahl gelegt');
}

function openFavoriteDialog(fav = null) {
  const form = $('favForm');
  editingFavorite = fav ? fav.number : null;
  form.elements.namedItem('name').value = fav ? fav.name || '' : '';
  form.elements.namedItem('number').value = fav ? fav.number : '';
  $('favTitle').textContent = fav ? 'Kurzwahl bearbeiten' : 'Neue Kurzwahl';
  $('favDelete').hidden = !fav;
  $('favError').hidden = true;
  $('favDialog').showModal();
}

async function saveFavorite(e) {
  e.preventDefault();
  const form = $('favForm');
  const name = form.elements.namedItem('name').value.trim();
  const number = form.elements.namedItem('number').value.trim();
  if (!number) return;
  const next = favorites.filter((f) => f.number !== editingFavorite);
  if (next.some((f) => f.number === number)) {
    $('favError').textContent = 'Diese Nummer ist schon in der Kurzwahl.';
    $('favError').hidden = false;
    return;
  }
  next.push({ name, number });
  const res = await window.phone.saveFavorites(next);
  favorites = res.list;
  renderFavorites();
  renderContacts();
  $('favDialog').close();
}

async function deleteFavorite() {
  if (!editingFavorite) return;
  const res = await window.phone.saveFavorites(favorites.filter((f) => f.number !== editingFavorite));
  favorites = res.list;
  renderFavorites();
  renderContacts();
  $('favDialog').close();
}

function addNumberRow(label = NUMBER_LABELS[0], number = '') {
  const row = el('div', 'number-edit');
  const select = document.createElement('select');
  for (const l of NUMBER_LABELS.includes(label) ? NUMBER_LABELS : [...NUMBER_LABELS, label]) select.append(new Option(l, l));
  select.value = label;
  const input = document.createElement('input');
  input.type = 'tel';
  input.placeholder = 'Nummer';
  input.value = number;
  const remove = el('button', 'icon-btn subtle');
  remove.type = 'button';
  remove.title = 'Nummer entfernen';
  remove.append(svgIcon(ICON_PATHS.close));
  remove.onclick = () => row.remove();
  row.append(select, input, remove);
  $('numberRows').append(row);
}

function openContactDialog(contact = null, prefill = null) {
  const form = $('contactForm');
  editingContactId = contact ? contact.id : null;
  form.elements.namedItem('name').value = contact ? contact.name : (prefill && prefill.name) || '';
  form.elements.namedItem('company').value = contact ? contact.company || '' : '';
  $('numberRows').replaceChildren();
  if (contact) contact.numbers.forEach((n) => addNumberRow(n.label, n.number));
  else addNumberRow(NUMBER_LABELS[0], (prefill && prefill.number) || '');
  $('contactTitle').textContent = contact ? 'Kontakt bearbeiten' : 'Neuer Kontakt';
  $('contactDelete').hidden = !contact;
  $('contactError').hidden = true;
  $('contactDialog').showModal();
}

async function saveContact(e) {
  e.preventDefault();
  const form = $('contactForm');
  const numbers = [...$('numberRows').children].map((row) => ({
    label: row.querySelector('select').value,
    number: row.querySelector('input').value,
  }));
  const res = await window.phone.saveContact({
    id: editingContactId,
    name: form.elements.namedItem('name').value,
    company: form.elements.namedItem('company').value,
    numbers,
  });
  if (res && res.error) {
    $('contactError').textContent = res.error;
    $('contactError').hidden = false;
    return;
  }
  $('contactDialog').close();
}

async function deleteContact() {
  if (!editingContactId || !confirm('Kontakt wirklich löschen?')) return;
  await window.phone.deleteContact(editingContactId);
  $('contactDialog').close();
}

function openImportDialog() {
  $('importError').hidden = true;
  $('importDialog').showModal();
}

async function runImport(kind) {
  const buttons = [$('importOutlook'), $('importCsv')];
  buttons.forEach((b) => (b.disabled = true));
  $('importError').hidden = true;
  try {
    const res = kind === 'outlook' ? await window.phone.importOutlook() : await window.phone.importCsv();
    if (!res) return; // Dateiauswahl abgebrochen
    if (res.error) {
      $('importError').textContent = res.error; // im Dialog, ein Toast läge hinter dem Dialog
      $('importError').hidden = false;
      return;
    }
    $('importDialog').close();
    toast(`${res.found} Kontakte gelesen – ${res.added} neu, ${res.updated} ergänzt`);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

async function exportCsv() {
  const btn = $('exportCsv');
  btn.disabled = true;
  $('importError').hidden = true;
  try {
    const res = await window.phone.exportCsv();
    if (!res) return; // Speicherort-Auswahl abgebrochen
    if (res.error) {
      $('importError').textContent = res.error;
      $('importError').hidden = false;
      return;
    }
    $('importDialog').close();
    toast(`${res.count} Kontakte exportiert`);
  } finally {
    btn.disabled = false;
  }
}

// --- Audio ---

async function initAudio() {
  // 48 kHz erzwingen: dann sind alle Codec-Raten (8/16/48 kHz) ganzzahlige Teiler und Opus läuft direkt.
  const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
  await ctx.audioWorklet.addModule('audio-worklet.js');
  const node = new AudioWorkletNode(ctx, 'phone', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  const gain = ctx.createGain(); // Hörlautstärke des Gesprächs
  gain.gain.value = typeof audioCfg.volume === 'number' ? audioCfg.volume : 1;
  node.connect(gain).connect(ctx.destination);
  node.port.onmessage = (e) => window.phone.sendAudio(new Int16Array(e.data));
  audio = { ctx, node, gain, ringCtx: new AudioContext() };
  await applySinks();
  $('audioGate').hidden = ctx.state === 'running';
}

async function unlockAudio() {
  await Promise.all([audio.ctx.resume(), audio.ringCtx.resume()]);
  try {
    // Einmalig Mikrofonfreigabe holen, damit Gerätenamen sichtbar sind und später keine Abfrage im Gespräch kommt.
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch (err) {
    toast(`Mikrofon nicht freigegeben: ${err.message}`, true);
  }
  $('audioGate').hidden = true;
  updateAudio();
}

// Aktive Geräte: im Freisprech-Modus das Profil (leer = Systemstandard), sonst die normale Auswahl.
function activeMic() {
  return speakerMode ? audioCfg.spkMicrophone : audioCfg.microphone;
}
function activeSpeaker() {
  return speakerMode ? audioCfg.spkSpeaker : audioCfg.speaker;
}

async function applySinks() {
  if (!audio) return;
  const sinks = [[audio.ctx, activeSpeaker()], [audio.ringCtx, audioCfg.ringer]];
  for (const [ctx, name] of sinks) {
    const id = deviceId('audiooutput', name);
    if (!ctx.setSinkId) continue;
    try {
      await ctx.setSinkId(id || '');
    } catch (err) {
      console.warn('setSinkId', err);
    }
  }
}

async function startMic() {
  if (mic || !audio) return;
  mic = 'pending';
  try {
    audio.node.port.postMessage({ type: 'config', rate: callRate }); // Mikrofon in der Codec-Rate aufnehmen
    const id = deviceId('audioinput', activeMic());
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: id ? { exact: id } : undefined,
        echoCancellation: micProcessing,
        noiseSuppression: micProcessing,
        autoGainControl: micProcessing,
        channelCount: 1,
      },
    });
    if (mic !== 'pending') {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    for (const track of stream.getAudioTracks()) track.enabled = !muted;
    const source = audio.ctx.createMediaStreamSource(stream);
    source.connect(audio.node);
    mic = { stream, source };
  } catch (err) {
    mic = null;
    toast(`Mikrofon: ${err.message}`, true);
  }
}

// Stumm = Mikrofonspur deaktivieren; die Gegenstelle bekommt Stille, das Gespräch läuft weiter.
function setMuted(value) {
  muted = value;
  if (mic && mic !== 'pending') {
    for (const track of mic.stream.getAudioTracks()) track.enabled = !muted;
  }
  const button = $('muteBtn');
  button.classList.toggle('active', muted);
  button.setAttribute('aria-pressed', String(muted));
  button.title = muted ? 'Stummschaltung aufheben' : 'Stummschalten';
  button.setAttribute('aria-label', button.title);
  updateCallStatus();
}

function stopMic() {
  if (mic && mic !== 'pending') {
    mic.source.disconnect();
    mic.stream.getTracks().forEach((t) => t.stop());
  }
  mic = null;
}

// Töne: Klingelton (eingehend) auf dem Klingel-Gerät, Freizeichen (ausgehend) im Headset.
const TONES = {
  ring: { ctx: 'ringCtx', period: 2.4, gain: 0.25, notes: [[784, 0, 0.14], [988, 0.16, 0.14], [1175, 0.32, 0.22], [784, 0.8, 0.14], [988, 0.96, 0.14], [1175, 1.12, 0.22]] },
  ringback: { ctx: 'ctx', period: 5, gain: 0.12, notes: [[425, 0, 1]] },
};
let tone = null; // { kind, timer, oscillators }

// Klingelton (eingehend) wahlweise gleichzeitig auf Klingel-Gerät und Gesprächsgerät (Headset).
function toneContexts(kind) {
  if (kind !== 'ring') return [audio[TONES[kind].ctx]];
  return ringOnHeadset && audio.ctx !== audio.ringCtx ? [audio.ringCtx, audio.ctx] : [audio.ringCtx];
}

function playTone(kind) {
  if (tone && tone.kind === kind) return;
  stopTone();
  if (!audio) return;
  const spec = TONES[kind];
  tone = { kind, oscillators: [], timers: [] };
  for (const ctx of toneContexts(kind)) {
    if (kind === 'ring' && ringtone) {
      const source = ctx.createBufferSource();
      source.buffer = ringtone.buffer;
      source.loop = true;
      source.connect(ctx.destination);
      source.start();
      tone.oscillators.push(source);
      continue;
    }
    const burst = () => {
      const t0 = ctx.currentTime + 0.05;
      for (const [freq, start, dur] of spec.notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const at = t0 + start;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(spec.gain, at + 0.015);
        gain.gain.setValueAtTime(spec.gain, at + dur - 0.03);
        gain.gain.linearRampToValueAtTime(0, at + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(at);
        osc.stop(at + dur + 0.02);
        tone.oscillators.push(osc);
        osc.onended = () => tone && (tone.oscillators = tone.oscillators.filter((o) => o !== osc));
      }
    };
    burst();
    tone.timers.push(setInterval(burst, spec.period * 1000));
  }
}

function stopTone() {
  if (!tone) return;
  for (const timer of tone.timers) clearInterval(timer);
  for (const osc of tone.oscillators) {
    try {
      osc.stop();
    } catch {}
  }
  tone = null;
}

function updateAudio() {
  const call = state.call;
  const consult = call && call.consult;
  // Bei Rückfrage zählt das zweite Gespräch; bei Halten (ohne Rückfrage) kein Mikrofon (Wartemusik).
  const media = consult
    ? consult.state === 'active'
    : call && !call.held && (call.state === 'active' || (call.state === 'ringing' && call.earlyMedia));
  if (media) startMic();
  else stopMic();

  if (call && call.state === 'incoming') playTone('ring');
  else if (consult && consult.state === 'ringing' && !consult.earlyMedia) playTone('ringback');
  else if (!consult && call && call.state === 'ringing' && !call.earlyMedia) playTone('ringback');
  else stopTone();

  if (!call && audio) audio.node.port.postMessage('reset');

  // Beginnt es zu klingeln: Headset-Annahme scharf schalten (kurze Sperre gegen Echo-Reports beim Start).
  const incoming = !!call && call.state === 'incoming';
  if (incoming && !hidWasIncoming) {
    hidArmedAt = Date.now() + 300;
    hidAnswered = false;
  }
  hidWasIncoming = incoming;
  updateHeadsetCall(); // Ring/Off-Hook am Headset an den Anrufzustand angleichen
}

// --- Rufannahme per Headset (WebHID, z. B. Jabra) ---
// Während es klingelt, zählt der erste Tastendruck am Headset (Mute-Knopf sendet einen Input-Report)
// als Rufannahme. Bewusst tastenunabhängig gehalten, damit es über verschiedene Headset-Modelle greift.

function headsetLog(text) {
  try { window.phone.logHeadset(text); } catch {}
}

// HID-Usages der Anrufsteuerung. Eingaben liegen auf der Telephony-Page (0x0B),
// die Signal-Ausgaben (Ring/Off-Hook) auf der LED-Page (0x08).
const HOOK_SWITCH = (0x0b << 16) | 0x20; // Input: Rufannahme-/Gesprächsknopf (1 = off-hook)
const RING = (0x08 << 16) | 0x18; // Output: eingehenden Anruf am Headset signalisieren
const OFF_HOOK = (0x08 << 16) | 0x17; // Output: „im Gespräch“
// Manche Headsets (z. B. Jabra Evolve2) senden den Anruf-/Multifunktionsknopf im Ruhezustand als
// Consumer-Medientaste statt als Hook Switch – als Fallback beim Klingeln ebenfalls als „annehmen“ werten.
const CALL_KEYS = [(0x0c << 16) | 0xcd, (0x0c << 16) | 0xb0]; // Play/Pause, Play

// Alle Reports einer Art (inputReports/outputReports) über verschachtelte Collections einsammeln.
function allReports(dev, kind) {
  const out = [];
  const walk = (col) => { for (const r of col[kind] || []) out.push(r); for (const ch of col.children || []) walk(ch); };
  for (const col of dev.collections || []) walk(col);
  return out;
}

// Bit-Position und Report-Länge einer Usage suchen: { reportId, bit, byteLength } oder null.
function findReportBit(reports, usage) {
  for (const report of reports) {
    let bit = 0;
    let found = -1;
    for (const item of report.items || []) {
      const size = item.reportSize || 0;
      if (found < 0) {
        if (item.isRange) { if (item.usageMinimum <= usage && usage <= item.usageMaximum) found = bit + (usage - item.usageMinimum) * size; }
        else if (item.usages) { const i = item.usages.indexOf(usage); if (i >= 0) found = bit + i * size; }
      }
      bit += size * (item.reportCount || 0);
    }
    if (found >= 0) return { reportId: report.reportId, bit: found, byteLength: Math.max(1, Math.ceil(bit / 8)) };
  }
  return null;
}

function readBit(view, bit) {
  const byte = bit >> 3;
  return byte < view.byteLength ? (view.getUint8(byte) >> (bit & 7)) & 1 : null;
}

// Ein Ausgabe-Bit (Ring/Off-Hook) am Headset setzen; Bits je Report werden gepuffert.
async function setOutput(loc, on) {
  if (!loc || !hidDevice) return;
  let buf = hidOut.get(loc.reportId);
  if (!buf) { buf = new Uint8Array(loc.byteLength); hidOut.set(loc.reportId, buf); }
  const byte = loc.bit >> 3;
  const mask = 1 << (loc.bit & 7);
  const next = on ? buf[byte] | mask : buf[byte] & ~mask;
  if (next === buf[byte]) return;
  buf[byte] = next;
  try { await hidDevice.sendReport(loc.reportId, buf); } catch (err) { headsetLog('sendReport: ' + err.message); }
}

// Headset-Signale an den Anrufzustand angleichen: Ring bei eingehendem Anruf, Off-Hook im Gespräch.
function updateHeadsetCall() {
  if (!hidDevice) return;
  const call = headsetAnswer ? state.call : null;
  setOutput(hidRingLoc, !!call && call.state === 'incoming');
  setOutput(hidOffHookLoc, !!call && call.state !== 'incoming');
}

function answerFromHeadset() {
  if (hidAnswered || Date.now() < hidArmedAt) return;
  hidAnswered = true;
  send({ type: 'answer' });
}

// Headset-Knopf: annehmen beim Klingeln, auflegen im Gespräch. Zwei Wege je nach Headset-Modus:
// (1) Hook Switch (Standard-Anrufsteuerung), (2) Anruf-Knopf als Consumer-Medientaste (Fallback).
function onHidInput(e) {
  if (!headsetAnswer) return;
  const call = state.call;
  // (1) Hook Switch
  if (hidHookLoc && hidHookLoc.reportId === e.reportId) {
    const hook = readBit(e.data, hidHookLoc.bit);
    if (hook !== null) {
      const prev = hidHook;
      hidHook = hook;
      if (call && call.state === 'incoming' && prev === 0 && hook === 1) { answerFromHeadset(); return; }
      if (call && call.state !== 'incoming' && prev === 1 && hook === 0) { send({ type: 'hangup' }); return; }
    }
  }
  // (2) Fallback: Anruf-Knopf im Media-Modus, nur beim Klingeln als „annehmen“ werten
  if (call && call.state === 'incoming' && hidCallKeys.some((l) => l.reportId === e.reportId && readBit(e.data, l.bit) === 1)) {
    answerFromHeadset();
  }
}

async function useHeadset(dev) {
  try {
    if (hidDevice && hidDevice !== dev) hidDevice.oninputreport = null; // altes Headset nicht mehr auswerten
    if (!dev.opened) await dev.open();
    dev.oninputreport = onHidInput;
    hidDevice = dev;
    hidHook = undefined;
    hidOut.clear();
    const inR = allReports(dev, 'inputReports');
    const outR = allReports(dev, 'outputReports');
    hidHookLoc = findReportBit(inR, HOOK_SWITCH);
    hidRingLoc = findReportBit(outR, RING);
    hidOffHookLoc = findReportBit(outR, OFF_HOOK);
    hidCallKeys = CALL_KEYS.map((u) => findReportBit(inR, u)).filter(Boolean);
    updateHeadsetCall(); // falls schon ein Anruf läuft, Signale gleich setzen
  } catch (err) {
    headsetLog('open: ' + err.message);
  }
}

const JABRA_VID = 0x0b0e; // Hersteller-ID von GN/Jabra

// USB-Kennung (VID:PID) des Gesprächs-Ausgabegeräts – Chrome hängt "(vvvv:pppp)" an den Gerätenamen.
function speakerVidPid() {
  const name = activeSpeaker() || '';
  const dev = devices.find((d) => d.kind === 'audiooutput' && (d.label === name || d.label.startsWith(name)));
  const m = /\(([0-9a-f]{4}):([0-9a-f]{4})\)/i.exec((dev && dev.label) || name);
  return m ? { vid: parseInt(m[1], 16), pid: parseInt(m[2], 16) } : null;
}

// Aus einer HID-Liste das Gerät zur USB-Kennung t={vid,pid} wählen (das des Gesprächs-Geräts).
// Bei mehreren Jabras lieber nichts nehmen als das falsche.
function matchHeadset(devs, t) {
  const isTel = (d) => d.collections.some((c) => c.usagePage === 0x0b);
  if (!t) return devs.find(isTel) || null;
  const exact = devs.find((d) => d.vendorId === t.vid && d.productId === t.pid);
  if (exact) return exact;
  const sameVidTel = devs.filter((d) => d.vendorId === t.vid && isTel(d));
  return sameVidTel.length === 1 ? sameVidTel[0] : null;
}

function pickHeadset(devs) {
  return matchHeadset(devs, speakerVidPid());
}

// Passendes Headset anbinden (ohne Auswahldialog). Aufruf bei Aktivierung, Start, Geräteänderung
// und beim Öffnen der Einstellungen.
async function syncHeadset() {
  if (!navigator.hid || !headsetAnswer) return;
  try {
    const dev = pickHeadset(await navigator.hid.getDevices());
    if (dev && dev !== hidDevice) await useHeadset(dev);
  } catch (err) {
    headsetLog('getDevices: ' + err.message);
  }
  updateHeadsetStatus();
}

// Manuelles Verbinden (Nutzer-Geste): Auswahl erlauben, dann das zum Gesprächs-Gerät passende nehmen.
async function connectHeadset() {
  if (!navigator.hid) {
    toast('Dieses System unterstützt kein WebHID.', true);
    return;
  }
  try {
    const chosen = await navigator.hid.requestDevice({ filters: [{ vendorId: JABRA_VID }, { usagePage: 0x0b }] });
    const dev = pickHeadset(await navigator.hid.getDevices()) || pickHeadset(chosen) || chosen[0];
    if (!dev) {
      toast('Kein zum Gesprächs-Gerät passendes Headset gefunden.', true);
      updateHeadsetStatus();
      return;
    }
    await useHeadset(dev);
    if (hidDevice) toast(`Headset verbunden: ${hidDevice.productName || 'Headset'}`);
  } catch (err) {
    headsetLog('requestDevice: ' + err.message);
    toast('Headset konnte nicht verbunden werden.', true);
  }
  updateHeadsetStatus();
}

function updateHeadsetStatus() {
  $('headsetRow').hidden = !headsetAnswer;
  $('headsetStatus').textContent = hidDevice ? `Verbunden: ${hidDevice.productName || 'Headset'}` : 'Kein Headset verbunden';
}

function initHeadset() {
  if (!navigator.hid) return;
  navigator.hid.addEventListener('disconnect', (e) => {
    if (e.device === hidDevice) { hidDevice = null; updateHeadsetStatus(); }
  });
  navigator.hid.addEventListener('connect', () => { if (headsetAnswer) syncHeadset(); });
  if (headsetAnswer) syncHeadset();
}

// --- Geräte (Namen stehen in config.json, Vorbelegung aus Linphone) ---

async function refreshDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  devices = all.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications');
}

// Linphone-Namen haben keinen "(vid:pid)"-Zusatz, daher auch Treffer über den Namensanfang.
function findDevice(kind, name) {
  if (!name) return null;
  const list = devices.filter((d) => d.kind === kind);
  return list.find((d) => d.label === name) || list.find((d) => d.label.startsWith(name)) || null;
}

function deviceId(kind, name) {
  const d = findDevice(kind, name);
  return d ? d.deviceId : '';
}

async function openSettings() {
  await refreshDevices();
  const fill = (select, kind, name) => {
    select.innerHTML = '';
    select.append(new Option('Systemstandard', ''));
    for (const d of devices.filter((x) => x.kind === kind)) select.append(new Option(d.label, d.label));
    const current = findDevice(kind, name);
    if (name && !current) select.append(new Option(`${name} (nicht angeschlossen)`, name));
    select.value = current ? current.label : name;
  };
  fill($('micSelect'), 'audioinput', audioCfg.microphone);
  fill($('speakerSelect'), 'audiooutput', audioCfg.speaker);
  fill($('ringerSelect'), 'audiooutput', audioCfg.ringer);
  fill($('spkMicSelect'), 'audioinput', audioCfg.spkMicrophone);
  fill($('spkSpeakerSelect'), 'audiooutput', audioCfg.spkSpeaker);
  syncHeadset(); // Gerätelabels sind jetzt frisch -> passendes Headset (VID:PID) anbinden
  updateHeadsetStatus();
  $('settings').showModal();
  startMeter();
}

function onDeviceChange() {
  audioCfg = {
    ...audioCfg,
    microphone: $('micSelect').value,
    speaker: $('speakerSelect').value,
    ringer: $('ringerSelect').value,
    spkMicrophone: $('spkMicSelect').value,
    spkSpeaker: $('spkSpeakerSelect').value,
  };
  window.phone.setAudio(audioCfg);
  applySinks();
  startMeter();
  if (headsetAnswer) syncHeadset(); // Gesprächs-Gerät geändert -> passendes Headset neu wählen
  if (mic) {
    stopMic();
    updateAudio();
  }
}

async function loadRingtone() {
  const r = await window.phone.getRingtone();
  ringtone = null;
  if (r && audio) {
    try {
      ringtone = { name: r.name, buffer: await audio.ringCtx.decodeAudioData(r.data.slice().buffer) };
    } catch {
      toast(`Klingelton „${r.name}“ kann nicht abgespielt werden`, true);
    }
  }
  $('ringtoneName').textContent = ringtone ? ringtone.name : 'Standard';
  $('ringtoneReset').hidden = !ringtone;
}

async function chooseRingtone() {
  const res = await window.phone.chooseRingtone();
  if (!res) return;
  if (res.error) {
    toast(res.error, true);
    return;
  }
  await loadRingtone();
  if (!ringtone) {
    // Format nicht abspielbar -> zurück auf Standard
    await window.phone.resetRingtone();
    await loadRingtone();
    return;
  }
  if (tone && tone.kind === 'ring') stopTone();
  testTone('ring');
}

async function resetRingtone() {
  await window.phone.resetRingtone();
  await loadRingtone();
}

let testTimer;
function testTone(kind) {
  if (state.call) return;
  playTone(kind);
  clearTimeout(testTimer);
  testTimer = setTimeout(() => !state.call && stopTone(), 2500);
}

// Pegelanzeige für das gewählte Mikrofon, solange die Einstellungen offen sind.
let meter = null;
async function startMeter() {
  stopMeter();
  if (!audio) return;
  const token = {};
  meter = token;
  try {
    const id = deviceId('audioinput', audioCfg.microphone);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id ? { exact: id } : undefined } });
    if (meter !== token) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const source = audio.ctx.createMediaStreamSource(stream);
    const analyser = audio.ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    Object.assign(token, { stream, source });
    const data = new Float32Array(analyser.fftSize);
    const draw = () => {
      if (meter !== token) return;
      analyser.getFloatTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v));
      $('micLevel').style.width = `${Math.min(100, peak * 150)}%`;
      requestAnimationFrame(draw);
    };
    draw();
  } catch (err) {
    toast(`Mikrofon: ${err.message}`, true);
  }
}

function stopMeter() {
  if (meter && meter.stream) {
    meter.source.disconnect();
    meter.stream.getTracks().forEach((t) => t.stop());
  }
  meter = null;
  $('micLevel').style.width = '0';
}

// --- Start ---

buildKeypad($('keypad'), (digit) => {
  $('number').value += digit;
  $('number').focus();
  renderSuggest();
});
buildKeypad($('callKeypad'), sendDtmf);
$('keypadBtn').onclick = () => setDtmfOpen(!dtmfOpen);
// Ziffern, * und # über die Tastatur (auch Ziffernblock) während des Gesprächs
document.addEventListener('keydown', (e) => {
  if (!state.call || state.call.state !== 'active' || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (/^[0-9*#]$/.test(e.key)) {
    e.preventDefault();
    sendDtmf(e.key);
  }
});
$('callBtn').onclick = dial;
$('number').addEventListener('keydown', (e) => e.key === 'Enter' && dial());
$('number').addEventListener('input', renderSuggest);
$('number').addEventListener('focus', renderSuggest);
$('number').addEventListener('blur', hideSuggest);
$('backspace').onclick = () => {
  $('number').value = $('number').value.slice(0, -1);
  renderSuggest();
};
$('answerBtn').onclick = () => send({ type: 'answer' });
$('hangupBtn').onclick = () => send({ type: 'hangup' });
$('muteBtn').onclick = () => setMuted(!muted);
$('holdBtn').onclick = toggleHold;
$('transferBtn').onclick = openTransfer;
$('transferCancel').onclick = closeTransfer;
$('transferGo').onclick = () => doTransfer($('transferInput').value);
$('transferConsult').onclick = () => doAttendedTransfer($('transferInput').value);
$('consultJoin').onclick = () => send({ type: 'completeTransfer' });
$('consultBack').onclick = () => send({ type: 'cancelConsult' });
$('speakerBtn').onclick = toggleSpeaker;
$('volume').oninput = () => setVolume(Number($('volume').value));
$('transferInput').addEventListener('input', renderTransferSuggest);
$('transferInput').addEventListener('blur', () => hideSuggestBox($('transferSuggest')));
$('transferInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doTransfer($('transferInput').value);
  else if (e.key === 'Escape') closeTransfer();
});
$('updateBtn').onclick = async () => {
  const res = await window.phone.installUpdate();
  if (res && res.error) toast(res.error, true);
};
$('updateNotesToggle').onclick = () => {
  const open = $('updateNotes').hidden;
  $('updateNotes').hidden = !open;
  $('updateNotesToggle').setAttribute('aria-expanded', String(open));
  $('updateNotesToggle').textContent = open ? 'Weniger anzeigen' : 'Was ist neu?';
};
$('showLog').onclick = () => window.phone.openLog();
for (const b of document.querySelectorAll('.tab')) b.onclick = () => setTab(b.dataset.tab);
$('contactSearch').oninput = renderContacts;
$('addContact').onclick = () => openContactDialog();
$('importBtn').onclick = openImportDialog;
$('importOutlook').onclick = () => runImport('outlook');
// Nur unter Windows: Outlook-Import (COM über PowerShell) und Abmelden bei Bildschirmsperre
// (Electron meldet die Sperre unter Linux nicht).
if (!IS_WIN) {
  $('importOutlook').hidden = true;
  $('lockUnregister').closest('label').hidden = true;
}
$('importCsv').onclick = () => runImport('csv');
$('exportCsv').onclick = exportCsv;
$('addNumber').onclick = () => addNumberRow();
$('contactForm').onsubmit = saveContact;
$('contactCancel').onclick = () => $('contactDialog').close();
$('contactDelete').onclick = deleteContact;
$('accountForm').onsubmit = saveAccount;
$('importPhonerLite').onclick = async () => {
  const res = await window.phone.importPhonerLite();
  if (!res) return; // Dateiauswahl abgebrochen
  if (res.error) {
    toast(res.error, true);
    return;
  }
  const f = $('accountForm');
  const a = res.account;
  f.elements.label.value = a.label || '';
  f.elements.displayName.value = a.displayName || '';
  f.elements.username.value = a.username || '';
  f.elements.domain.value = a.domain || '';
  if (a.authUsername && a.authUsername !== a.username) {
    f.querySelector('details').open = true;
    f.elements.authUsername.value = a.authUsername;
  }
  f.elements.password.focus();
  toast('Konto aus PhonerLite übernommen – bitte noch das Passwort eingeben.');
};
$('accountCancel').onclick = closeAccountForm;
$('accountDelete').onclick = deleteAccount;
$('addAccount').onclick = () => {
  $('settings').close();
  showAccountForm();
};
$('lineSelect').onchange = () => {
  try {
    localStorage.setItem('sipphone.line', $('lineSelect').value);
  } catch {}
  render();
};
$('clearHistory').onclick = () => confirm('Verlauf wirklich löschen?') && window.phone.clearHistory();
window.addEventListener('focus', () => activeTab === 'history' && markHistorySeen());
$('regStatus').onclick = openSettings;
$('settingsBtn').onclick = openSettings;
$('reconnectBtn').onclick = () => {
  const btn = $('reconnectBtn');
  btn.classList.remove('spinning');
  void btn.offsetWidth; // Animation auch bei schnellem Wiederklick neu starten
  btn.classList.add('spinning');
  send({ type: 'register' });
  toast('Neu verbinden …');
};
$('reRegister').onclick = () => send({ type: 'register' });
$('takeoverBtn').onclick = () => send({ type: 'register' });
$('addFavorite').onclick = () => openFavoriteDialog();
$('favForm').onsubmit = saveFavorite;
$('favCancel').onclick = () => $('favDialog').close();
$('favDelete').onclick = deleteFavorite;
$('lockUnregister').onchange = () => window.phone.setOptions({ lockUnregister: $('lockUnregister').checked });
$('showOnCall').onchange = () => window.phone.setOptions({ showOnCall: $('showOnCall').checked });
$('micProcessing').onchange = () => {
  micProcessing = $('micProcessing').checked;
  window.phone.setOptions({ micProcessing });
  if (mic) { // im Gespräch sofort mit neuer Einstellung neu aufnehmen
    stopMic();
    updateAudio();
  }
};
$('hdVoice').onchange = () => window.phone.setOptions({ hdVoice: $('hdVoice').checked });
$('ringOnHeadset').onchange = () => {
  ringOnHeadset = $('ringOnHeadset').checked;
  window.phone.setOptions({ ringOnHeadset });
  if (tone && tone.kind === 'ring') { // klingelt gerade -> sofort umstellen
    stopTone();
    playTone('ring');
  }
};
$('headsetAnswer').onchange = async () => {
  headsetAnswer = $('headsetAnswer').checked;
  window.phone.setOptions({ headsetAnswer });
  if (headsetAnswer) await syncHeadset();
  updateHeadsetCall(); // beim Ausschalten Signale löschen, beim Einschalten ggf. setzen
  updateHeadsetStatus();
};
$('connectHeadset').onclick = connectHeadset;
$('themeSelect').onchange = () => window.phone.setOptions({ theme: $('themeSelect').value });
$('gateBtn').onclick = unlockAudio;
for (const id of ['micSelect', 'speakerSelect', 'ringerSelect', 'spkMicSelect', 'spkSpeakerSelect']) $(id).onchange = onDeviceChange;
$('testSpeaker').onclick = () => testTone('ringback');
$('testRinger').onclick = () => testTone('ring');
$('ringtoneChoose').onclick = chooseRingtone;
$('ringtoneReset').onclick = resetRingtone;
$('settings').addEventListener('close', stopMeter);
// Headset an-/abgesteckt: gespeicherte Auswahl neu zuordnen
navigator.mediaDevices.addEventListener('devicechange', async () => {
  await refreshDevices();
  applySinks();
});
setInterval(updateCallStatus, 1000);

window.phone.onState((s) => {
  state = s;
  render();
});
window.phone.onEnded((reason) => toast(reason));
window.phone.onInfo((text) => toast(text));
window.phone.onHistory((entries) => {
  history = entries;
  if (activeTab === 'history' && document.hasFocus()) markHistorySeen();
  renderHistory();
});
window.phone.onShowHistory(() => setTab('history'));
window.phone.onContacts((list) => {
  contacts = list;
  renderContacts();
});
window.phone.onPresence(({ ext, state: st }) => {
  presence[ext] = st;
  renderFavorites();
});
window.phone.onUpdate((info) => {
  update = info;
  render();
});
window.phone.onAudio((pcm) => {
  if (!audio) return;
  const copy = pcm.slice();
  audio.node.port.postMessage(copy.buffer, [copy.buffer]);
});
window.phone.onAudioFormat((fmt) => {
  callRate = fmt.rate || 8000;
  if (audio) audio.node.port.postMessage({ type: 'config', rate: callRate });
});

(async () => {
  try {
    audioCfg = await window.phone.getAudio();
    $('volume').value = typeof audioCfg.volume === 'number' ? audioCfg.volume : 1;
    const options = await window.phone.getOptions();
    $('lockUnregister').checked = options.lockUnregister;
    $('showOnCall').checked = options.showOnCall;
    micProcessing = options.micProcessing;
    $('micProcessing').checked = micProcessing;
    $('hdVoice').checked = options.hdVoice;
    ringOnHeadset = options.ringOnHeadset;
    $('ringOnHeadset').checked = ringOnHeadset;
    headsetAnswer = options.headsetAnswer;
    $('headsetAnswer').checked = headsetAnswer;
    $('themeSelect').value = options.theme || 'system';
    await refreshDevices();
    await initAudio();
    await loadRingtone();
  } catch (err) {
    toast(`Audio-Initialisierung fehlgeschlagen: ${err.message}`, true);
  }
  state = await window.phone.getState();
  accounts = await window.phone.getAccounts();
  update = await window.phone.getUpdate();
  $('appVersion').textContent = await window.phone.getVersion();
  if (!accountConfigured()) showAccountForm();
  history = await window.phone.getHistory();
  renderHistory();
  contacts = await window.phone.getContacts();
  renderContacts();
  const fav = await window.phone.getFavorites();
  favorites = fav.list;
  presence = fav.presence || {};
  renderFavorites();
  render();
  initHeadset();
})();
