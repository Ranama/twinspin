// SDP helpers for the second-device stream (pure string work, tested in tests/sdp.test.js).
//
//   call.answer(undefined, { sdpTransform: addOpusStereo });   // receiver.js, on the listener's LOCAL answer
//
// Why only this: libwebrtc's Opus DECODER takes its channel count from the receiver's own fmtp line, and the
// sender's ENCODER from the remote one. Putting stereo=1 in the listener's local answer therefore makes the host
// encode stereo (music mode) and the listener decode stereo. Nothing else is munged: the bitrate is raised on the
// host with RTCRtpSender.setParameters (encodings[0].maxBitrate), and sprop-stereo has no effect in a recvonly
// answer (docs/research/verify-webrtc.md). The host never munges anything.

const OPUS_RTPMAP = /^a=rtpmap:(\d+)\s+opus\/48000(?:\/\d+)?\s*$/i;

/**
 * Add `stereo=1` to the fmtp line of every Opus payload type (per m= section). Existing `stereo=0` becomes 1, a
 * missing fmtp line is created right after the rtpmap line, other codecs and line endings stay untouched.
 * Idempotent. Returns the input unchanged when there is no Opus.
 * @param {string} sdp
 * @returns {string}
 */
export function addOpusStereo(sdp) {
  if (typeof sdp !== 'string' || !sdp) return sdp;
  const eol = sdp.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const trailing = sdp.endsWith(eol);
  const lines = sdp.split(eol);
  if (trailing) lines.pop();
  const out = [];
  let i = 0;
  while (i < lines.length) {
    // one block = session part or one m= section
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith('m=')) j++;
    out.push(...patchSection(lines.slice(i, j)));
    i = j;
  }
  return out.join(eol) + (trailing ? eol : '');
}

function patchSection(lines) {
  const pts = [];
  for (const l of lines) {
    const m = OPUS_RTPMAP.exec(l);
    if (m) pts.push(m[1]);
  }
  if (!pts.length) return lines;
  const result = lines.slice();
  for (const pt of pts) {
    const prefix = `a=fmtp:${pt} `;
    const idx = result.findIndex((l) => l.startsWith(prefix) || l === `a=fmtp:${pt}`);
    if (idx >= 0) {
      result[idx] = `a=fmtp:${pt} ` + withStereo(result[idx].slice(`a=fmtp:${pt}`.length).trim());
    } else {
      const rtp = result.findIndex((l) => OPUS_RTPMAP.test(l) && OPUS_RTPMAP.exec(l)[1] === pt);
      result.splice(rtp + 1, 0, `a=fmtp:${pt} stereo=1`);
    }
  }
  return result;
}

function withStereo(params) {
  if (!params) return 'stereo=1';
  const parts = params.split(';').map((p) => p.trim()).filter(Boolean);
  let found = false;
  const next = parts.map((p) => {
    const eq = p.indexOf('=');
    const key = (eq >= 0 ? p.slice(0, eq) : p).trim().toLowerCase();
    if (key !== 'stereo') return p;
    found = true;
    return 'stereo=1';
  });
  if (!found) next.push('stereo=1');
  return next.join(';');
}

/**
 * True when every Opus payload type in the SDP asks for stereo (diagnostics and tests).
 * @param {string} sdp
 */
export function hasOpusStereo(sdp) {
  if (typeof sdp !== 'string') return false;
  const lines = sdp.split(/\r?\n/);
  const pts = lines.map((l) => OPUS_RTPMAP.exec(l)).filter(Boolean).map((m) => m[1]);
  if (!pts.length) return false;
  return pts.every((pt) => lines.some((l) => l.startsWith(`a=fmtp:${pt} `)
    && /(^|;)\s*stereo=1\s*(;|$)/i.test(l.slice(`a=fmtp:${pt} `.length))));
}
