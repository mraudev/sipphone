'use strict';

// Supported audio codecs in order of preference (offer order).
const CODECS = [
  { pt: 8, name: 'PCMA' },
  { pt: 0, name: 'PCMU' },
];
const STATIC_NAMES = { 0: 'PCMU', 8: 'PCMA' };
const DTMF_PT = 101;

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

// First codec from the remote list that we support.
function chooseCodec(remote) {
  for (const pt of remote.pts) {
    const name = remote.rtpmap[pt] || STATIC_NAMES[pt];
    if (CODECS.some((c) => c.name === name)) return { pt, name };
  }
  return null;
}

// Without a negotiated codec this is an offer with all codecs, otherwise an answer.
function build({ ip, port, sessionId, version, codec, dtmfPt, direction = 'sendrecv' }) {
  const codecs = codec ? [codec] : CODECS;
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
    ...codecs.map((c) => `a=rtpmap:${c.pt} ${c.name}/8000`),
  ];
  if (dtmf !== undefined && dtmf !== null) {
    lines.push(`a=rtpmap:${dtmf} telephone-event/8000`, `a=fmtp:${dtmf} 0-16`);
  }
  lines.push('a=ptime:20', `a=${direction}`);
  return lines.join('\r\n') + '\r\n';
}

module.exports = { parse, build, chooseCodec };
