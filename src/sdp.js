'use strict';

// Unterstützte Codecs. rate = Audioabtastrate, frame = PCM-Samples je 20 ms. clock = RTP-Zeittakt.
// rtpName = Name in der SDP. G.711/G.722 haben feste 160-Byte-Payload; Opus ist variabel (Fullband,
// mit Fehlerkorrektur/Paketverlust-Verdeckung). HD-Reihenfolge: Opus vor G.722 vor G.711.
const G711 = [
  { pt: 8, name: 'PCMA', rate: 8000, frame: 160, clock: 8000, rtpName: 'PCMA' },
  { pt: 0, name: 'PCMU', rate: 8000, frame: 160, clock: 8000, rtpName: 'PCMU' },
];
const G722 = { pt: 9, name: 'G722', rate: 16000, frame: 320, clock: 8000, rtpName: 'G722' };
const OPUS = { pt: 111, name: 'OPUS', rate: 48000, frame: 960, clock: 48000, rtpName: 'opus', channels: 2, fmtp: 'useinbandfec=1' };
const STATIC_NAMES = { 0: 'PCMU', 8: 'PCMA', 9: 'G722' };
const DTMF_PT = 101;

// Angebots-/Akzeptanzliste: mit HD Opus bevorzugt, dann G.722, sonst nur G.711.
function offerCodecs(hd) {
  return hd ? [OPUS, G722, ...G711] : [...G711];
}

function parse(text) {
  let section = 'session';
  let sessionIp = null;
  let audioIp = null;
  let audio = null;
  let direction = 'sendrecv';
  const rtpmap = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('m=')) {
      const m = /^m=audio (\d+) \S+ (.*)$/.exec(line);
      if (m && !audio) {
        audio = { port: Number(m[1]), pts: m[2].trim().split(/\s+/).map(Number) };
        section = 'audio';
      } else {
        section = 'other';
      }
      continue;
    }
    if (section === 'other') continue;
    let m;
    if ((m = /^c=IN IP4 (\S+)/.exec(line))) {
      if (section === 'audio') audioIp = m[1];
      else sessionIp = m[1];
    } else if ((m = /^a=rtpmap:(\d+) ([^/\s]+)\//.exec(line))) {
      rtpmap[Number(m[1])] = m[2].toUpperCase();
    } else if ((m = /^a=(sendrecv|sendonly|recvonly|inactive)\s*$/.exec(line))) {
      direction = m[1];
    }
  }
  if (!audio) return null;
  return {
    ip: audioIp || sessionIp,
    port: audio.port,
    pts: audio.pts,
    dtmfPt: audio.pts.find((pt) => rtpmap[pt] === 'TELEPHONE-EVENT'),
    direction,
    rtpmap,
  };
}

// First codec from the remote list that we support (G.722 nur bei aktivem HD).
function chooseCodec(remote, hd = false) {
  const supported = offerCodecs(hd);
  for (const pt of remote.pts) {
    const name = remote.rtpmap[pt] || STATIC_NAMES[pt];
    const c = supported.find((x) => x.name === name);
    if (c) return { ...c, pt };
  }
  return null;
}

// Without a negotiated codec this is an offer with all codecs, otherwise an answer.
function build({ ip, port, sessionId, version, codec, codecs: offer, dtmfPt, direction = 'sendrecv' }) {
  const codecs = codec ? [codec] : offer || G711;
  const dtmf = codec ? dtmfPt : DTMF_PT;
  const pts = codecs.map((c) => c.pt);
  if (dtmf !== undefined && dtmf !== null) pts.push(dtmf);
  const lines = [
    'v=0',
    `o=- ${sessionId} ${version} IN IP4 ${ip}`,
    's=sipphone',
    `c=IN IP4 ${ip}`,
    't=0 0',
    `m=audio ${port} RTP/AVP ${pts.join(' ')}`,
  ];
  for (const c of codecs) {
    lines.push(`a=rtpmap:${c.pt} ${c.rtpName || c.name}/${c.clock || 8000}${c.channels ? `/${c.channels}` : ''}`);
    if (c.fmtp) lines.push(`a=fmtp:${c.pt} ${c.fmtp}`);
  }
  if (dtmf !== undefined && dtmf !== null) {
    lines.push(`a=rtpmap:${dtmf} telephone-event/8000`, `a=fmtp:${dtmf} 0-16`);
  }
  lines.push('a=ptime:20', `a=${direction}`);
  return lines.join('\r\n') + '\r\n';
}

module.exports = { parse, build, chooseCodec, offerCodecs };
