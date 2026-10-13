# research-routing
## Findings
- [high,critical] SUPPORT MATRIX: AudioContext.setSinkId(), the AudioContext sinkId attribute, the constructor option new AudioContext({sinkId}) and setSinkId({type:'none'}). Chrome desktop: 110+ (Feb 2023). Edge: 110+. Chrome Android: the API is exposed (the AudioContextSetSinkId runtime feature is 'stable' everywhere) and '' or {type:'none'} work. But on phones and tablets enumerateDevices only reports a 'default' output, so it cannot target a specific BT or USB device. Samsung Internet: 21+, with the same Android limits. Firefox desktop and Android: not supported (BCD false through 160). Safari macOS and iOS/iPadOS: not shipped. WebKit PR #74675, opened 2026-09-23, adds it behind an 'AudioContextSetSinkIdEnabled' testable flag that is off in shipping builds.
- [high,critical] SUPPORT MATRIX: HTMLMediaElement.setSinkId() and sinkId. Chrome desktop: 49+. Edge: 17+ (Chromium Edge 79+). Firefox desktop: 116+ (Aug 2023). Safari macOS: 18.4+ (Mar 2025, macOS 15.4). Firefox Android: no (bug 1473346). Chrome Android phones and tablets: NOT exposed (prototype has no setSinkId). In Blink the runtime feature 'AudioOutputDevices' has status {Android:'', default:'stable'}. On Android it is switched on only when kAAudioPerStreamDeviceSelection is enabled AND base::android::device_info::is_desktop() is true. That gating landed in M152 ('Reland: Enable kAAudioPerStreamDeviceSelection by default', main@#1668092, 2026-07-24). The first attempt was reverted because it 'caused setSinkId() to unexpectedly launch on Android'. So only desktop-form-factor Android gets it, not phones. Samsung Internet: no.
- [high,critical] Safari iOS/iPadOS 18.4+ DOES expose HTMLMediaElement.setSinkId. The WebKit IDL is gated by ExposeSpeakersEnabled & PerElementSpeakerSelectionEnabled, both true for PLATFORM(COCOA), which includes iOS. MDN BCD lists iOS 18.4 as well. However, the WebKit 18.4 release notes describe the speaker-selection API as 'on macOS'. iOS has a single AVAudioSession output route: WebKit's iOS speaker preference is set session-wide (AVAudioSessionCaptureDeviceManager::setPreferredSpeakerID). enumerateDevices on iOS has been reported to return 0 audiooutput devices (BCD issue #23148, still open). Result: two simultaneous outputs on iOS are impossible from a web page.
- [high,critical] Safari's HTMLMediaElement.setSinkId requires a user gesture. The preference SpeakerSelectionRequiresUserGesture defaults to true. Without a gesture, setAudioOutputDevice rejects with NotAllowedError 'A user gesture is required'. An unknown deviceId rejects with NotFoundError. Safari supports per-track output-device switching for MediaStream-backed <audio> (MediaPlayerPrivateMediaStreamAVFObjC::audioOutputDeviceChanged), so the MediaStreamDestination -> <audio> path can be routed.
- [high] navigator.mediaDevices.selectAudioOutput() ships only in Firefox desktop 116+. It needs transient activation, shows one device per call, and accepts an optional {deviceId} to skip re-prompting. It is not persisted by default. Firefox Android: no. Chrome/Edge: it exists behind the runtime feature 'SelectAudioOutput' with status 'test' on desktop and disabled on Android, so it is not shipped. A contributor effort is ongoing (crbug 372214870). Safari: no.
- [high,critical] Chrome/Edge enumerateDevices rules. Without permission, each kind returns at most one entry, and its deviceId, label and groupId are all empty strings. Audio outputs are fully listed with labels when BOTH conditions hold: (a) microphone permission is GRANTED, as a stored content setting (an active stream is not needed) AND the frame's 'microphone' Permissions-Policy allows it; or (b) speaker-selection permission is granted AND the 'speaker-selection' policy allows it. Case (b) only happens via selectAudioOutput, which is not shipped. On Windows the list also includes 'default' and 'communications' pseudo-entries. On Android phones the output list is only 'default', even with mic permission. AudioManagerAndroid::GetAudioOutputDeviceNames adds only the default unless per-stream selection is on, which requires is_desktop().
- [high] Firefox enumerateDevices. It lists audiooutput from 116+. The list contains speakers granted through selectAudioOutput(). After microphone access it also contains devices sharing a groupId with the exposed mic, and since Firefox 140 ALL speakers (compatibility change, blog update 2025-07-03). The enumerateDevices promise resolves only while the document has focus. Safari 18.4 macOS: speakers are enumerated once microphone access has been granted via getUserMedia.
- [high,critical] 'speaker-selection' Permissions-Policy has the default allowlist 'self'. In Chrome, AudioContext.setSinkId() checks this policy before anything else and rejects with NotAllowedError 'Permissions-Policy disallows speaker selection.' This applies even for '' or {type:'none'}. HTMLMediaElement.setSinkId also rejects, and enumerateDevices omits outputs. A cross-origin or sandboxed iframe preview without allow="speaker-selection" (and allow="microphone" for the permission unlock) therefore cannot do dual output. The dual-output feature must run top-level on HTTPS. GitHub Pages is fine because 'self' is the default and no header is needed.
- [high,critical] Windows Bluetooth endpoints. Windows 10 creates up to 3 endpoints per Bluetooth Classic device: '{Name} Stereo' (A2DP out) and '{Name} Hands-Free' (HFP out and in). Opening Hands-Free puts the device into HFP and discards Stereo audio. Windows 11 unifies them into ONE output and ONE input endpoint. It switches to HFP when any app opens the device's microphone or a Communications-category stream. When the mic closes it switches back to A2DP 'momentarily'. So getUserMedia({audio:true}) that opens a BT headset's mic (often the default input) drops the headset to mono 8/16 kHz until the track is stopped.
- [high,critical] Chrome Android calling getUserMedia: opening an input stream with audio effects (the default constraints) sets AudioManager.MODE_IN_COMMUNICATION, which gives call-style routing and volume and may use BT SCO/HFP. MODE_NORMAL is restored only when no input streams remain. Since mic permission gives NO extra output routing on Android phones, the app must never call getUserMedia there.
- [medium] iOS Safari calling getUserMedia switches the page's audio session to play-and-record (call-like). Bluetooth output then moves to HFP-quality or the route changes (sometimes to the speaker). It also gives no second-output capability. Avoid getUserMedia on iOS. Set navigator.audioSession.type = 'playback' (Safari 16.4+) so Web Audio ignores the silent switch.
- [medium] Desktop OS with two BT devices. macOS can drive two Bluetooth outputs at once: Audio MIDI Setup can build a Multi-Output Device from two BT headphones, so each is a separate CoreAudio device that setSinkId can target. Windows lists each connected A2DP device as its own endpoint, and apps can be routed per endpoint. Concurrent playback to two Classic-BT sinks depends on the radio and driver, and stutter is common. One wired/USB plus one BT is the reliable combination. Windows 11 'Shared audio (preview)' (Insider build 26220.7051, Copilot+ PCs, LE Audio only) MIRRORS the same audio, so it is irrelevant for separate cue.
- [high,critical] Android OS level: there is no user-facing way to send DIFFERENT audio from one app to two BT devices. Samsung Dual Audio, Android 16 'Audio sharing' (LE Audio/Auracast, Pixel 8+, rolled out Sep 2025) and Windows-style shared audio all mirror the same stream. AOSP 'combined audio device routing' (Android 12+) is limited to privileged apps and also plays the same stream to several devices. Native apps can use AudioTrack.setPreferredDevice to split wired/USB vs BT, but Chrome only uses per-stream device selection on desktop-form-factor Android. A web page on an Android phone therefore gets exactly one output.
- [high] Native mobile DJ apps confirm the limits. djay iOS offers pre-cueing only via 'Split Output' (master on one stereo side, cue on the other, plus a stereo-to-dual-mono Y cable) or via a DJ controller or audio interface with dedicated cue channels. It states 'Pre-cueing is not supported in combination with AirPlay or Bluetooth devices'. An existing open-source browser DJ app also uses this L/R split mode.
- [medium] destination.maxChannelCount, i.e. a 4-output USB interface as an alternative. Chrome Android: the output stream parameters default to Stereo. Only automotive builds with kUseAudioManagerMaxChannelLayout get more, so expect maxChannelCount 2 and no 4-channel cue routing on Android phones. Safari iOS: WebKit returns AVAudioSession.maximumOutputNumberOfChannels, so a class-compliant 4-out interface can report 4. Rendering ch3/4 to hardware is unverified and must be tested on a device. Safari macOS: the default device's stream configuration. Chrome desktop: the sink device's channel count. Many Windows USB DJ interfaces instead expose separate stereo endpoints ('1/2', '3/4'), which fits the two-sink strategy.
- [medium] Latency of the two paths in Chrome. (1) AudioContext.setSinkId renders straight to the device: baseLatency (latencyHint) plus device outputLatency. (2) MediaStreamAudioDestinationNode -> <audio>.srcObject + setSinkId goes through TrackAudioRenderer. That uses an AudioShifter, which compensates clock drift and buffers with 20 ms clock-accuracy tolerance, and opens the sink with RTC latency (AudioLatency kRtc, 10 ms buffers on mac/Linux, the native buffer on Windows), not the large media-element 'playback' buffers. My estimate from the pipeline (not measured): +20 to 50 ms over path (1). That is small next to Bluetooth A2DP's roughly 100 to 300 ms. Avoid a second AudioContext with createMediaStreamSource as the cue sink: Chrome's WebAudioMediaStreamAudioSink is a plain FIFO with overrun/underrun handling and no drift compensation, so two device clocks cause periodic clicks.
- [medium] Chrome's AudioContext has diagnostics usable for latency and underrun checks. outputLatency, getOutputTimestamp() and onerror are in the IDL. ctx.playbackStats (AudioPlaybackStats: averageLatency, minimumLatency, maximumLatency, underrunDuration, underrunEvents, resetLatency()) is a 'stable' runtime feature in main. The sinkchange event and sinkId attribute also exist, and latencyHint accepts 'balanced'.
## Recommendations
- Build the engine with three fixed buses that never change: masterBus (stereo, post-crossfader), cueBus (stereo PFL plus an optional master blend through a 'cue mix' knob), and an OutputRouter that only rewires these two buses into one of the output modes below. The deck worklets and FX never need to know which mode is active.
- Mode 'single' (default on all phones and the safe fallback): masterBus -> ctx.destination. The cue buttons still work as 'preview on main' (solo cue to the master for a moment), or are hidden. Use this whenever dual output is not possible.
- Mode 'split' (any browser, including Android Chrome and iOS Safari; this is THE phone answer for a separate headphone cue): sum master to mono -> LEFT channel and cue to mono -> RIGHT channel using GainNode(channelCount=1, explicit, speakers) and ChannelMergerNode(2) -> ctx.destination. Add a 'swap L/R' toggle. Label it clearly: 'Needs a wired or USB-C headphone output plus a stereo-to-dual-mono Y-splitter cable (one plug to the speaker's AUX, one to the headphones). Does not work over Bluetooth.'
- Mode 'dual-device' (Chrome/Edge desktop 110+, Firefox desktop 116+, Safari macOS 18.4+, Chrome on desktop-form-factor Android M152+). Master: if 'setSinkId' in AudioContext.prototype, call ctx.setSinkId(masterId), with '' meaning the system default. Otherwise leave master on ctx.destination as the OS default output and tell the user to pick the speaker in OS sound settings. Cue: cueBus -> ctx.createMediaStreamDestination() -> new Audio() with srcObject = dest.stream -> await el.setSinkId(cueId) -> el.play(). Always disconnect cueBus from ctx.destination in this mode so cue does not leak to the speaker.
- Mode 'multichannel' (optional, advanced): if ctx.destination.maxChannelCount >= 4, set destination.channelCount = 4, channelCountMode 'explicit', channelInterpretation 'discrete'. Use ChannelSplitter/ChannelMerger(4) so master goes to ch0/1 and cue to ch2/3. Re-read maxChannelCount after any setSinkId. Expect 2 on Android Chrome. Only enable it when the reported count is >= 4, and include a test tone per channel pair.
- Gate dual-device on capabilities, not on AudioContext.setSinkId. Chrome Android phones expose AudioContext.prototype.setSinkId but can only route to 'default'. Use 'setSinkId' in HTMLMediaElement.prototype (false on Android phones, true on desktop browsers and desktop-Android). Then exclude iOS/iPadOS by UA sniff: /iPad|iPhone|iPod/ or Macintosh with maxTouchPoints > 1, because iOS 18.4+ exposes the method but has one route. Also require window.isSecureContext and that the frame is top-level or policy-allowed (document.featurePolicy?.allowsFeature('speaker-selection') in Chromium; otherwise treat any cross-origin iframe as not allowed).
- Speaker-list unlock flow, behind an explicit 'Set up 2 outputs' button. Step 1: call enumerateDevices(); if audiooutput entries already have labels, skip the permission step. This happens in Chrome when mic permission was stored earlier, and needs no stream. Step 2 for Firefox: call navigator.mediaDevices.selectAudioOutput() twice ('Pick SPEAKER', 'Pick HEADPHONES'), each from its own click, and store the deviceIds. Step 2 for Chrome/Edge/Safari macOS: call getUserMedia({audio:true}) once, stop all tracks right away, then re-enumerate. Explain beforehand: 'Your browser only shows speaker names after microphone permission. We never record; Bluetooth headsets may blip for a second.'
- Never call getUserMedia on Android phones or iOS. It gives no routing benefit there and forces call/communication audio mode (Android MODE_IN_COMMUNICATION, iOS play-and-record), which wrecks Bluetooth quality.
- Persist masterId and cueId in localStorage (they are per-origin salted IDs that stay stable while site data is kept). On load, re-validate them against enumerateDevices(). Listen for navigator.mediaDevices 'devicechange' and ctx 'sinkchange'/'error'. If a chosen device disappears, for example a BT headset switched off, fall back to 'single' and show a toast. Spec behaviour for a media element whose sink vanishes is silent continuation with no automatic reroute.
- On Safari macOS, call cueEl.setSinkId() synchronously at the top of the click handler, before any other await, so the user-gesture requirement is met. In Chrome, wrap every setSinkId call in try/catch and handle NotAllowedError (policy), NotFoundError (stale id) and AbortError/InvalidStateError (device unavailable).
- If masterId === cueId, or both resolve to the same groupId, refuse dual mode and suggest 'split' instead.
- Add a 'cue latency offset' slider (0 to 300 ms, a DelayNode on the cue path; optionally a second one on master). The two outputs (BT speaker vs BT or wired headphones) will have different latencies, and DJs beatmatching by ear need alignment. Rely on the automatic BPM/phase SYNC rather than ear-matching when on Bluetooth.
- Do not use a second AudioContext with createMediaStreamSource as the cue sink. Use the <audio> element path, which has drift compensation in Chrome (AudioShifter) and works in Firefox and Safari. Keep all DSP in ONE AudioContext so both outputs come from the same render clock and the same deck state.
- Set navigator.audioSession.type = 'playback' when available (Safari 16.4+), before creating or resuming the AudioContext, so iPhone audio plays with the ring/silent switch on.
- Optional phase 2, 'Remote cue' for phone-only users: send cueBus over WebRTC (via a MediaStreamDestination track) to a second phone or laptop that opens a receiver page. This needs signaling: a QR code with the SDP, or a third-party broker. Expect about 150 to 400 ms extra latency, which is acceptable for pre-listen when SYNC does the beatmatching.
- UI copy per detected platform. Android/iOS: 'Phones can only play to one output. Use Split mode with a wired Y-cable, or use a laptop for speaker + headphones.' Desktop Chrome/Edge/Firefox/Safari: offer dual-device with two big pickers (SPEAKER / HEADPHONES) and a test-tone button for each.
## Gotchas
- 'setSinkId' in AudioContext.prototype is TRUE on Chrome Android phones and Samsung Internet. It only routes to 'default' or {type:'none'} there. Do not use it to decide that dual output is possible.
- iOS Safari 18.4+ has HTMLMediaElement.prototype.setSinkId, yet iOS has a single AVAudioSession route, so dual output is impossible. A UA/iPadOS sniff is required.
- Chrome Android may gain HTMLMediaElement.setSinkId on desktop-form-factor Android (M152+), but not on phones. Feature-detect instead of excluding all of /Android/.
- Without mic permission, Chrome returns ONE audiooutput entry with deviceId '' and label ''. Do not treat that as 'one real device found'.
- Windows Chrome lists the pseudo-devices 'default' and 'communications' in addition to real endpoints, so the same physical device can appear 2 to 3 times. Dedupe by groupId and show the real device names.
- Windows 10 shows BT headphones as both 'X Stereo' and 'X Hands-Free'. Picking Hands-Free gives mono 8/16 kHz audio and kills the Stereo stream. Windows 11 shows one endpoint but drops to HFP while ANY app holds the headset mic.
- getUserMedia opening a BT headset's mic, even for a split second, flips it to HFP. Stop the tracks immediately and do the permission step before music starts.
- In a cross-origin or sandboxed iframe (e.g. an artifact preview), Chrome rejects even ctx.setSinkId('') and ctx.setSinkId({type:'none'}) with NotAllowedError, and the outputs are hidden. Guard every call and show an 'Open full page' link.
- Safari macOS setSinkId needs a live user gesture. Awaiting other promises first inside the click handler can lose it.
- Firefox desktop has no AudioContext.setSinkId. The master can only follow the OS default device unless it is also routed through an <audio> element with setSinkId.
- Firefox's selectAudioOutput needs transient activation, and its grant is not persisted by default. Expect to re-prompt in a new session; pass {deviceId: saved} to try to skip the prompt.
- The Chrome MediaStream -> <audio> path still adds buffering (about 20 to 50 ms, my estimate). AudioContext.outputLatency does NOT include the element path, so measure with a loopback or let the user tune the offset slider.
- Two Classic-BT sinks on one laptop radio can stutter or drop. Recommend one wired/USB plus one BT for reliability.
- Chrome on Android caps the Web Audio output at stereo (maxChannelCount 2), even with multichannel USB interfaces. iOS may report more channels; verify on a device before advertising it.
- Bluetooth outputs each add roughly 100 to 300 ms with different values per device. Scratch feedback and ear-beatmatching across two BT devices will feel off. Wired is better for the headphone cue.
- A MediaStreamAudioDestinationNode -> <audio> element needs el.play() after a user gesture (autoplay policy), and must not be muted. Do not also connect the cue to ctx.destination, or it leaks into the speaker.
- Older sources (2015 Chrome blog, a 2022 BCD issue) claim setSinkId works on Chrome Android. Current Chromium source disables AudioOutputDevices on Android unless is_desktop().
## Snippets
```js
// output-caps.js: capability detection for dual output
export function detectOutputCaps() {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  let xFrame = false;
  try { xFrame = window.top !== window.self && !window.top.location.href; } catch { xFrame = true; }
  const pp = document.featurePolicy; // Chromium only
  const allows = (f) => (pp && pp.allowsFeature) ? pp.allowsFeature(f) : !xFrame;
  const ctxSink = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
  const elSink = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  const selectOut = typeof navigator.mediaDevices?.selectAudioOutput === 'function';
  const speakerPolicy = allows('speaker-selection');
  const micPolicy = allows('microphone');
  return {
    isIOS, ctxSink, elSink, selectOut, speakerPolicy, micPolicy,
    // elSink is false on Android phones; iOS has it but only one route
    dualDevice: window.isSecureContext && elSink && !isIOS && speakerPolicy,
    split: true, // always available (needs wired Y-cable)
  };
}
```
```js
// list outputs; ask for permission only when needed and only on desktop
export async function listOutputs(caps, { unlock = false } = {}) {
  const md = navigator.mediaDevices;
  const read = async () => (await md.enumerateDevices())
    .filter(d => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'communications');
  let outs = await read();
  if (outs.some(d => d.label) || !unlock || !caps.dualDevice) return outs;
  if (caps.selectOut) return outs;            // Firefox: use pickOutput() per role instead
  if (!caps.micPolicy) return outs;
  const s = await md.getUserMedia({ audio: true }); // permission unlock only
  s.getTracks().forEach(t => t.stop());              // release mic now -> BT back to A2DP
  return read();
}
// Firefox: one prompt per role, must be called inside a click handler
export const pickOutput = (savedId) => navigator.mediaDevices.selectAudioOutput(savedId ? { deviceId: savedId } : {});
```
```js
// router: one AudioContext, buses rewired per mode
export async function setMode(mode, { ctx, masterBus, cueBus, masterId, cueId, caps, cueEl }) {
  masterBus.disconnect(); cueBus.disconnect();
  if (mode === 'dual') {
    // call this from the click handler (Safari gesture rule)
    const p = cueEl.setSinkId(cueId);                    // cueEl = new Audio(), srcObject set once
    if (caps.ctxSink) await ctx.setSinkId(masterId === 'default' ? '' : masterId);
    masterBus.connect(ctx.destination);
    cueBus.connect(cueEl._dest);                          // _dest = ctx.createMediaStreamDestination()
    await p; await cueEl.play();
  } else if (mode === 'split') {
    const mono = () => { const g = ctx.createGain(); g.channelCount = 1; g.channelCountMode = 'explicit'; g.channelInterpretation = 'speakers'; return g; };
    const m = mono(), c = mono(), merge = ctx.createChannelMerger(2);
    masterBus.connect(m); cueBus.connect(c);
    m.connect(merge, 0, 0);   // LEFT  = master (speaker)
    c.connect(merge, 0, 1);   // RIGHT = cue (headphones)
    merge.connect(ctx.destination);
  } else if (mode === 'quad' && ctx.destination.maxChannelCount >= 4) {
    const d = ctx.destination; d.channelCount = 4; d.channelCountMode = 'explicit'; d.channelInterpretation = 'discrete';
    const merge = ctx.createChannelMerger(4), ms = ctx.createChannelSplitter(2), cs = ctx.createChannelSplitter(2);
    masterBus.connect(ms); cueBus.connect(cs);
    ms.connect(merge, 0, 0); ms.connect(merge, 1, 1); cs.connect(merge, 0, 2); cs.connect(merge, 1, 3);
    merge.connect(d);
  } else {
    masterBus.connect(ctx.destination);                  // single
  }
}
```
```js
// robustness: fall back when a device vanishes
navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
  const ids = new Set((await navigator.mediaDevices.enumerateDevices()).map(d => d.deviceId));
  if (state.mode === 'dual' && (!ids.has(state.cueId) || (state.masterId !== 'default' && !ids.has(state.masterId)))) {
    await setMode('single', state); toast('Output disconnected - switched to single output');
  }
});
if ('audioSession' in navigator) navigator.audioSession.type = 'playback'; // iOS: ignore silent switch
```
## Open questions
- Does iOS Safari 18.4+/26 list any audiooutput devices after getUserMedia, and what does setSinkId do on iOS (switch the whole session route)? This needs an on-device test, but it does not change the conclusion that there is no simultaneous dual output on iOS.
- Does iPadOS/iOS Safari actually render discrete channels 3/4 to a class-compliant 4-out USB-C interface when destination.channelCount = 4? WebKit reports AVAudioSession.maximumOutputNumberOfChannels, but rendering was not verified.
- Exact extra latency of the MediaStreamDestination -> <audio>.setSinkId path in Chrome, Firefox and Safari. The +20 to 50 ms figure is derived from the pipeline code, not measured. A loopback test or Chrome's ctx.playbackStats could quantify it.
- Reliability of two simultaneous Classic-Bluetooth A2DP sinks on typical Windows laptop radios (Intel/Realtek/MediaTek). It is not documented by Microsoft and needs testing.
- Which Android devices count as is_desktop() in Chromium (Android desktop/laptop form factors; probably not Samsung DeX or large tablets)? This decides whether any Android tablet gets real setSinkId.
- Whether Chrome will ship selectAudioOutput (currently runtime status 'test') or mediaDevices.setPreferredSinkId (origin-trial runtime feature 'PreferredAudioOutputDevices') in the next milestones. Either would give a permission path that does not touch the microphone, avoiding the HFP blip.
