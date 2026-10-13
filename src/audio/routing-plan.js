// Output routing decisions (pure: no DOM, no Web Audio, so JsCheck can test every platform combination).
// OutputRouter (outputs.js) and the Outputs sheet use these to decide which modes this device can offer and
// what to tell the user, in plain words.
//
//   const modes = availableModes(env, { topLevel: !env.embedded, formFactor: 'phone' });
//   modes.dual.ok === false; modes.dual.reason === 'Phones can only play to one output at a time. ...'
//   dedupeOutputs(await navigator.mediaDevices.enumerateDevices())  -> [{ deviceId, label, groupId }]
//   deviceLabelHint('Headset (WH-1000XM4 Hands-Free AG Audio)')     -> 'Hands-free (call) mode: ...'
//   friendlySinkError(err, 'cue')                                    -> user-facing sentence for a setSinkId failure
//
// Facts behind the rules (docs/research/research-routing.md + verify-routing.md, the verify notes win):
// * a web page on a phone gets exactly one output (Android: no per-stream device selection unless the device is a
//   desktop form factor, which then exposes HTMLMediaElement.setSinkId; iOS/iPadOS: setSinkId exists but moves the
//   whole session, so it is never used there);
// * dual output needs HTMLMediaElement.setSinkId, a secure context and a top-level page (Permissions-Policy);
// * the remote mode needs WebRTC and is off in the claude.ai preview build.

/** Every output mode, in the order the Outputs sheet lists them. */
export const MODES = Object.freeze(['single', 'dual', 'split', 'remote']);

/** Shown in single mode next to the headphone (PFL) buttons. */
export const SINGLE_HINT = 'Headphone pre-listen needs a second output. Open Outputs.';

/**
 * Phone, tablet or computer, from the env flags and the short side of the screen in CSS px.
 * @param {object} env  src/core/env.js flags (mobile, ios, android)
 * @param {number} [screenShort]  Math.min(screen.width, screen.height); 0/unknown = guess from the flags
 * @returns {'phone'|'tablet'|'computer'}
 */
export function formFactorOf(env, screenShort = 0) {
  const e = env || {};
  if (!e.mobile && !e.ios && !e.android) return 'computer';
  return screenShort >= 600 ? 'tablet' : 'phone';
}

function deviceWord(env, formFactor) {
  if (env.ios) return formFactor === 'tablet' ? 'iPads' : 'iPhones';
  return formFactor === 'tablet' ? 'Tablets' : 'Phones';
}

/**
 * Which output modes this device and page can use, each with a plain-language reason when it can't.
 * @param {object} env  src/core/env.js flags
 * @param {{ topLevel?: boolean, formFactor?: 'phone'|'tablet'|'computer' }} [opts]
 *   topLevel: false when the page runs inside another page (iframe); formFactor defaults to formFactorOf(env)
 * @returns {{ single: {ok: true}, dual: {ok: boolean, reason: string|null}, split: {ok: true, note: string},
 *            remote: {ok: boolean, reason: string|null} }}
 */
export function availableModes(env, { topLevel = true, formFactor } = {}) {
  const e = env || {};
  const ff = formFactor || formFactorOf(e);
  const handheld = !!(e.ios || e.android || e.mobile);
  const remote = remoteCheck(e, topLevel);
  return {
    single: { ok: true },
    dual: dualCheck(e, topLevel, ff, handheld, remote.ok),
    split: { ok: true, note: splitNote(handheld) },
    remote,
  };
}

function dualCheck(e, topLevel, ff, handheld, remoteOk) {
  const no = (reason) => ({ ok: false, reason });
  if (e.preview) return no('Two outputs don\'t work inside the preview. Open TwinSpin in its own browser tab.');
  if (!topLevel) return no('Two outputs only work when TwinSpin is open in its own browser tab, not inside another page.');
  const alternatives = remoteOk
    ? 'For headphones, use Split cable or Second device.'
    : 'For headphones, use Split cable.';
  if (e.ios) {
    return no(`${deviceWord(e, ff)} play everything through one output at a time. ${alternatives}`);
  }
  // Desktop-form-factor Android exposes HTMLMediaElement.setSinkId (Chrome M152+); phones and tablets do not.
  if (handheld && !e.mediaSetSinkId) {
    return no(`${deviceWord(e, ff)} can only play to one output at a time. ${alternatives}`);
  }
  if (!e.secure) {
    return no('Two outputs need the secure (https://) address of TwinSpin. Open it from its https:// link.');
  }
  if (!e.mediaSetSinkId) {
    return no('This browser can\'t send sound to a chosen speaker. Use a current Chrome, Edge, Firefox or Safari on a computer.');
  }
  if (!e.enumerateDevices && !e.selectAudioOutput) {
    return no('This browser can\'t list your speakers. Use a current Chrome, Edge, Firefox or Safari on a computer.');
  }
  return { ok: true, reason: null };
}

function remoteCheck(e, topLevel) {
  const no = (reason) => ({ ok: false, reason });
  if (e.preview) return no('Second device doesn\'t work inside the preview. Open TwinSpin in its own browser tab.');
  if (!topLevel) return no('Second device only works when TwinSpin is open in its own browser tab, not inside another page.');
  if (!e.webrtc) return no('This browser can\'t stream sound to another device. Use a current Chrome, Safari or Firefox.');
  if (!e.secure) return no('Second device needs the secure (https://) address of TwinSpin. Open it from its https:// link.');
  return { ok: true, reason: null };
}

function splitNote(handheld) {
  const where = handheld ? 'the phone' : 'this device';
  return 'Needs a wired headphone output (jack or USB-C adapter) and a stereo-to-dual-mono Y cable: one plug to the '
    + 'speaker, one to your headphones. Doesn\'t work over Bluetooth. '
    + `Turn off Mono audio and Dolby/spatial effects on ${where}.`;
}

/**
 * Warning for output names that are known trouble, or null.
 * @param {string} label  MediaDeviceInfo.label
 * @returns {string|null}
 */
export function deviceLabelHint(label) {
  const s = String(label || '');
  if (!s) return null;
  if (/hands[\s-]?free/i.test(s)) {
    return 'Hands-free (call) mode: mono, low quality. Pick the Stereo or Headphones entry of this headset instead.';
  }
  if (/^communications\b/i.test(s)) {
    return 'This is the Windows calls device. Pick the speaker or headphones by name instead.';
  }
  if (/\bheadset\b/i.test(s)) {
    return 'If this is a Bluetooth headset it may switch to low-quality call sound. Prefer an entry called Headphones or Stereo.';
  }
  if (/\bairpods\b/i.test(s)) {
    return 'Bluetooth adds a delay, and two pairs of AirPods look the same here: use Test to tell them apart.';
  }
  if (/bluetooth/i.test(s)) {
    return 'Bluetooth adds a delay. Use Output alignment to line up the two outputs.';
  }
  return null;
}

const DEFAULT_PREFIX = /^default\s*[-:]\s*/i;

function cleanLabel(label) {
  return String(label || '').replace(DEFAULT_PREFIX, '').trim();
}

/**
 * Turn an enumerateDevices() list into the outputs worth showing:
 * * only 'audiooutput' entries (entries without `kind` are taken as outputs);
 * * masked entries (empty deviceId: no permission yet) and the Windows 'communications' pseudo-entry are dropped;
 * * 'default' is kept (first) and labelled 'System default (<name>)';
 * * within one groupId (one physical device): exact label duplicates are dropped, and 'Hands-Free' endpoints are
 *   dropped when the same device also has a normal endpoint. Different endpoints of one box with different names
 *   (a USB interface's '1/2' and '3/4') are kept: they are real, separate outputs.
 * @param {Array<{deviceId: string, label?: string, groupId?: string, kind?: string}>} devices
 * @returns {Array<{deviceId: string, label: string, groupId: string}>}
 */
export function dedupeOutputs(devices) {
  const list = Array.isArray(devices) ? devices : [];
  const outs = [];
  const seenIds = new Set();
  for (const d of list) {
    if (!d || (d.kind && d.kind !== 'audiooutput')) continue;
    const id = String(d.deviceId || '');
    if (!id || id === 'communications' || seenIds.has(id)) continue;
    seenIds.add(id);
    outs.push({ deviceId: id, label: String(d.label || ''), groupId: String(d.groupId || '') });
  }
  const isHandsFree = (o) => /hands[\s-]?free/i.test(o.label);
  const result = [];
  const def = outs.find((o) => o.deviceId === 'default');
  if (def) {
    const inner = cleanLabel(def.label);
    result.push({ deviceId: 'default', label: inner ? `System default (${inner})` : 'System default', groupId: def.groupId });
  }
  const real = outs.filter((o) => o.deviceId !== 'default');
  const byGroupLabels = new Map();
  let unnamed = 0;
  for (const o of real) {
    const g = o.groupId;
    if (g && isHandsFree(o) && real.some((x) => x !== o && x.groupId === g && !isHandsFree(x))) continue;
    const key = cleanLabel(o.label).toLowerCase();
    if (g && key) {
      let labels = byGroupLabels.get(g);
      if (!labels) byGroupLabels.set(g, (labels = new Set()));
      if (labels.has(key)) continue;
      labels.add(key);
    }
    const label = cleanLabel(o.label) || `Output ${++unnamed}`;
    result.push({ deviceId: o.deviceId, label, groupId: g });
  }
  return result;
}

/**
 * The real endpoint behind an id: 'default' (or '') is matched to the listed device with the same groupId and
 * name. Returns the id itself when it can't be resolved.
 */
export function resolveOutput(id, devices) {
  const want = String(id || 'default');
  if (want !== 'default') return want;
  const list = Array.isArray(devices) ? devices : [];
  const def = list.find((d) => d && d.deviceId === 'default');
  if (!def) return 'default';
  const inner = cleanLabel(def.label).replace(/^system default\s*\((.*)\)$/i, '$1').toLowerCase();
  const match = list.find((d) => d && d.deviceId !== 'default' && d.deviceId !== 'communications'
    && (!def.groupId || d.groupId === def.groupId) && (!inner || cleanLabel(d.label).toLowerCase() === inner));
  return match ? match.deviceId : 'default';
}

/**
 * True when two output ids end up on the same physical endpoint (so dual mode would play both buses into one
 * output). Shared groupIds alone are NOT the same output (multi-endpoint USB interfaces).
 */
export function sameOutput(a, b, devices) {
  const ra = resolveOutput(a, devices);
  const rb = resolveOutput(b, devices);
  return ra === rb;
}

/** '' for the system default (what setSinkId wants), else the id. */
export function sinkIdOf(deviceId) {
  const id = String(deviceId || '');
  return id === 'default' ? '' : id;
}

/**
 * Signed output alignment -> per-path delays in seconds. +ms delays the master (speaker) path, -ms the headphone
 * path. Clamped to -300..300 ms (the DelayNodes allow 0.35 s).
 * @returns {{ master: number, cue: number, ms: number }}
 */
export function alignmentDelays(ms) {
  let v = Number(ms);
  if (!Number.isFinite(v)) v = 0;
  v = Math.max(-300, Math.min(300, Math.round(v)));
  return { master: v > 0 ? v / 1000 : 0, cue: v < 0 ? -v / 1000 : 0, ms: v };
}

/** Split cable sides: which ChannelMerger input (0 = left, 1 = right) gets each bus. */
export function splitSides(swap) {
  return swap ? { master: 1, cue: 0 } : { master: 0, cue: 1 };
}

/**
 * Chip text for the current routing.
 * @param {string} mode
 * @param {{ formFactor?: 'phone'|'tablet'|'computer' }} [opts]
 */
export function describeRouting(mode, { formFactor = 'phone' } = {}) {
  switch (mode) {
    case 'dual': return 'Speaker + Headphones';
    case 'split': return 'Split cable';
    case 'remote': return 'Second device';
    default:
      return formFactor === 'computer' ? 'Speakers' : formFactor === 'tablet' ? 'Tablet speaker' : 'Phone speaker';
  }
}

/** Label used for the speaker-list unlock button; error messages refer to it by this name. */
export const UNLOCK_LABEL = 'Show my speakers';

const ROLE_NAME = { master: 'speaker', cue: 'headphones' };

/**
 * A setSinkId / selectAudioOutput / play() failure as a short sentence that says what to do.
 * @param {Error|{name?: string, message?: string}} err
 * @param {'master'|'cue'} [role]
 */
export function friendlySinkError(err, role = 'cue') {
  const name = (err && err.name) || '';
  const msg = String((err && err.message) || '');
  const what = ROLE_NAME[role] || 'that';
  switch (name) {
    case 'NotAllowedError':
      if (/gesture|user activation|interact/i.test(msg)) return `Tap the button again to switch the ${what} output.`;
      if (/policy/i.test(msg)) return 'This page isn\'t allowed to choose speakers. Open TwinSpin in its own browser tab.';
      if (/play|autoplay/i.test(msg)) return 'The browser blocked the second output from starting. Tap Two outputs again.';
      return `Access to the ${what} output wasn't allowed. Tap "${UNLOCK_LABEL}", allow it, then pick the output again.`;
    case 'NotFoundError':
      return `The ${what} output isn't available any more. Plug it in or switch it on, tap "${UNLOCK_LABEL}" and pick it again.`;
    case 'SecurityError':
      return `No permission to use the ${what} output. Tap "${UNLOCK_LABEL}", allow it, then pick the output again.`;
    case 'AbortError':
      return `The ${what} output couldn't be opened. Check it's on and not busy in another app, then try again.`;
    case 'TimeoutError':
      return `The ${what} output took too long to answer. Check it's connected, then try again.`;
    case 'InvalidStateError':
      return 'Audio isn\'t running right now. Tap to resume audio, then try again.';
    case 'NotSupportedError':
      return 'This browser can\'t switch outputs. Use Split cable or Second device instead.';
    default:
      return `Couldn't switch the ${what} output. Try again or pick another one.`;
  }
}

/** Friendly text for a getUserMedia failure during the speaker-list unlock (desktop only). */
export function friendlyAccessError(err) {
  const name = (err && err.name) || '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Your browser only shows speaker names after microphone permission. TwinSpin never records. '
        + 'Allow the microphone for this site (lock icon in the address bar) and try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Your browser only shows speaker names after microphone permission, and no microphone was found. '
        + 'Plug in a headset or webcam mic once, or use Split cable.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone is busy in another app, so the browser keeps your speakers hidden. Close that app and try again.';
    default:
      return 'Couldn\'t show your speakers. Try again, or use Split cable.';
  }
}
