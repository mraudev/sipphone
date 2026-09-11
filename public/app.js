'use strict';

const $ = (id) => document.getElementById(id);

const REG_LABELS = {
  idle: 'Starte …',
  registering: 'Verbinde …',
  registered: 'Verbunden',
  unregistering: 'Melde ab …',
  unregistered: 'Abgemeldet',
  failed: 'Nicht verbunden',
};

let state = { registration: { state: 'idle' }, call: null };
let audio = null; // { ctx, node, ringCtx }
let mic = null; // null | 'pending' | { stream, source }
let muted = false;
let audioCfg = { microphone: '', speaker: '', ringer: '' }; // Gerätenamen aus config.json
let devices = [];
let history = [];
let activeTab = 'dialer';
let ringtone = null; // { name, buffer } – eigener Klingelton, null = eingebaute Melodie
let account = null; // { displayName, username, domain, ..., hasCredentials }
let editingAccount = false;
let updateVersion = null; // heruntergeladenes Update, wartet auf Neustart

// --- Verbindung zum SIP-Stack im Electron-Hauptprozess ---

async function send(msg) {
  const res = await window.phone.command(msg);
  if (res && res.error) toast(res.error, true);
}

// --- Oberfläche ---

function render() {
  const reg = state.registration;
  const status = $('regStatus');
  status.dataset.state = reg.state;
  status.querySelector('.status-text').textContent = REG_LABELS[reg.state] || reg.state;
  status.querySelector('.status-aor').textContent = accountConfigured() && reg.aor ? reg.aor.replace(/^sip:/, '') : '';
  $('regReason').hidden = !(reg.state === 'failed' && reg.reason);
  $('regReason').textContent = reg.reason || '';
  $('accAor').textContent = accountConfigured() && reg.aor ? reg.aor : '–';
  $('accServer').textContent = reg.server || '–';

  const call = state.call;
  $('updateBar').hidden = !updateVersion || !!call; // nie mitten im Gespräch
  $('updateVersion').textContent = updateVersion || '';
  const setup = !call && (!accountConfigured() || editingAccount);
  $('accountView').hidden = !setup;
  $('tabs').hidden = !!call || setup;
  $('dialer').hidden = !!call || setup || activeTab !== 'dialer';
  $('history').hidden = !!call || setup || activeTab !== 'history';
  $('callView').hidden = !call;
  $('callBtn').disabled = reg.state !== 'registered';

  if (call) {
    const user = call.remoteUri.replace(/^(sips?|tel):/i, '').split('@')[0];
    const name = call.remoteName || user;
    $('callName').textContent = name;
    $('callUri').textContent = call.remoteUri.replace(/^(sips?|tel):/i, '');
    $('initials').textContent = initials(name);
    $('avatar').classList.toggle('ringing', call.state === 'incoming' || call.state === 'ringing' || call.state === 'calling');
    $('answerBtn').hidden = call.state !== 'incoming';
    $('muteBtn').hidden = call.state !== 'active';
    $('keypadBtn').hidden = call.state !== 'active';
    if (call.state !== 'active' && dtmfOpen) setDtmfOpen(false);
    document.title = call.state === 'incoming' ? `📞 ${name} ruft an` : 'SIP Phone';
  } else {
    document.title = 'SIP Phone';
    if (muted) setMuted(false); // nächstes Gespräch beginnt nicht stumm
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
  let text;
  if (call.state === 'calling') text = 'Wählt …';
  else if (call.state === 'ringing') text = 'Klingelt …';
  else if (call.state === 'incoming') text = 'Eingehender Anruf';
  else {
    const s = Math.max(0, Math.floor((Date.now() - call.startedAt) / 1000));
    text = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    if (call.codec) text += `  ·  ${call.codec}`;
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
  send({ type: 'dial', target });
}

// --- Konto ---

function accountConfigured() {
  return !!(account && account.username && account.domain);
}

function showAccountForm() {
  const form = $('accountForm');
  const configured = accountConfigured();
  for (const name of ['displayName', 'username', 'domain', 'authUsername', 'proxy']) {
    form.elements[name].value = (account && account[name]) || '';
  }
  // Proxy nur anzeigen, wenn er vom Server abweicht
  if (account && account.proxy === account.domain) form.elements.proxy.value = '';
  form.elements.proxyPort.value = account && account.proxyPort !== 5060 ? account.proxyPort : '';
  form.elements.password.value = '';
  form.elements.password.placeholder = account && account.hasCredentials ? 'unverändert lassen' : '';
  $('accountTitle').textContent = configured ? 'Konto bearbeiten' : 'SIP-Konto einrichten';
  $('accountCancel').hidden = !configured;
  $('accountError').hidden = true;
  editingAccount = configured;
  render();
}

async function saveAccount(e) {
  e.preventDefault();
  $('accountSave').disabled = true;
  try {
    const res = await window.phone.saveAccount(Object.fromEntries(new FormData($('accountForm'))));
    if (res.error) {
      $('accountError').textContent = res.error;
      $('accountError').hidden = false;
      return;
    }
    account = res.account;
    editingAccount = false;
    render();
  } finally {
    $('accountSave').disabled = false;
  }
}

// --- Verlauf ---

const ICON_PATHS = {
  out: 'M9 5v2h6.59L4 18.59 5.41 20 17 8.41V15h2V5z',
  in: 'M20 5.41 18.59 4 7 15.59V9H5v10h10v-2H8.41z',
  missed: 'M19.59 7 12 14.59 6.41 9H11V7H3v8h2v-4.59l7 7 9-9z',
  phone: 'M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1z',
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
  const domain = (state.registration.aor || '').split('@')[1];
  return domain && user.endsWith(`@${domain}`) ? user.slice(0, -domain.length - 1) : user;
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
  $('historyList').replaceChildren(...history.map((entry) => {
    const failed = entry.status === 'missed' || entry.status === 'rejected';
    const li = el('li', `entry ${entry.direction}${failed ? ' failed' : ''}`);
    const dir = el('span', 'entry-dir');
    dir.append(svgIcon(entry.direction === 'out' ? ICON_PATHS.out : failed ? ICON_PATHS.missed : ICON_PATHS.in));
    const number = shortUri(entry.remoteUri);
    const who = el('div', 'entry-who');
    who.append(el('b', '', entry.remoteName || number), el('small', 'muted', entry.remoteName ? number : ''));
    const meta = el('div', 'entry-meta');
    meta.append(el('small', 'muted', formatWhen(entry.at)), el('small', 'entry-status', describe(entry)));
    const callBack = el('button', 'icon-btn entry-call');
    callBack.title = 'Zurückrufen';
    callBack.append(svgIcon(ICON_PATHS.phone));
    callBack.onclick = () => send({ type: 'dial', target: entry.remoteUri });
    li.append(dir, who, meta, callBack);
    return li;
  }));
  $('historyEmpty').hidden = history.length > 0;
  $('clearHistory').hidden = history.length === 0;
  renderBadge();
}

// --- Audio ---

async function initAudio() {
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('audio-worklet.js');
  const node = new AudioWorkletNode(ctx, 'phone', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  node.connect(ctx.destination);
  node.port.onmessage = (e) => window.phone.sendAudio(new Int16Array(e.data));
  audio = { ctx, node, ringCtx: new AudioContext() };
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

async function applySinks() {
  if (!audio) return;
  const sinks = [[audio.ctx, audioCfg.speaker], [audio.ringCtx, audioCfg.ringer]];
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
    const id = deviceId('audioinput', audioCfg.microphone);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: id ? { exact: id } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
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

function playTone(kind) {
  if (tone && tone.kind === kind) return;
  stopTone();
  if (!audio) return;
  const spec = TONES[kind];
  const ctx = audio[spec.ctx];
  tone = { kind, oscillators: [] };
  if (kind === 'ring' && ringtone) {
    const source = ctx.createBufferSource();
    source.buffer = ringtone.buffer;
    source.loop = true;
    source.connect(ctx.destination);
    source.start();
    tone.oscillators.push(source);
    return;
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
  tone.timer = setInterval(burst, spec.period * 1000);
}

function stopTone() {
  if (!tone) return;
  clearInterval(tone.timer);
  for (const osc of tone.oscillators) {
    try {
      osc.stop();
    } catch {}
  }
  tone = null;
}

function updateAudio() {
  const call = state.call;
  const media = call && (call.state === 'active' || (call.state === 'ringing' && call.earlyMedia));
  if (media) startMic();
  else stopMic();

  if (call && call.state === 'incoming') playTone('ring');
  else if (call && call.state === 'ringing' && !call.earlyMedia) playTone('ringback');
  else stopTone();

  if (!call && audio) audio.node.port.postMessage('reset');
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
  $('settings').showModal();
  startMeter();
}

function onDeviceChange() {
  audioCfg = { microphone: $('micSelect').value, speaker: $('speakerSelect').value, ringer: $('ringerSelect').value };
  window.phone.setAudio(audioCfg);
  applySinks();
  startMeter();
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
$('backspace').onclick = () => ($('number').value = $('number').value.slice(0, -1));
$('answerBtn').onclick = () => send({ type: 'answer' });
$('hangupBtn').onclick = () => send({ type: 'hangup' });
$('muteBtn').onclick = () => setMuted(!muted);
$('updateBtn').onclick = async () => {
  const res = await window.phone.installUpdate();
  if (res && res.error) toast(res.error, true);
};
for (const b of document.querySelectorAll('.tab')) b.onclick = () => setTab(b.dataset.tab);
$('accountForm').onsubmit = saveAccount;
$('accountCancel').onclick = () => {
  editingAccount = false;
  render();
};
$('editAccount').onclick = () => {
  $('settings').close();
  showAccountForm();
};
$('clearHistory').onclick = () => confirm('Verlauf wirklich löschen?') && window.phone.clearHistory();
window.addEventListener('focus', () => activeTab === 'history' && markHistorySeen());
$('regStatus').onclick = openSettings;
$('settingsBtn').onclick = openSettings;
$('reRegister').onclick = () => send({ type: 'register' });
$('gateBtn').onclick = unlockAudio;
for (const id of ['micSelect', 'speakerSelect', 'ringerSelect']) $(id).onchange = onDeviceChange;
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
window.phone.onHistory((entries) => {
  history = entries;
  if (activeTab === 'history' && document.hasFocus()) markHistorySeen();
  renderHistory();
});
window.phone.onShowHistory(() => setTab('history'));
window.phone.onUpdate((version) => {
  updateVersion = version;
  render();
});
window.phone.onAudio((pcm) => {
  if (!audio) return;
  const copy = pcm.slice();
  audio.node.port.postMessage(copy.buffer, [copy.buffer]);
});

(async () => {
  try {
    audioCfg = await window.phone.getAudio();
    await refreshDevices();
    await initAudio();
    await loadRingtone();
  } catch (err) {
    toast(`Audio-Initialisierung fehlgeschlagen: ${err.message}`, true);
  }
  state = await window.phone.getState();
  account = await window.phone.getAccount();
  updateVersion = await window.phone.getUpdate();
  $('appVersion').textContent = await window.phone.getVersion();
  if (!accountConfigured()) showAccountForm();
  history = await window.phone.getHistory();
  renderHistory();
  render();
})();
