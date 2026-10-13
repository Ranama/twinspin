# research-webrtc
## Findings
- [high] PeerJS latest stable is 1.5.5 (npm publish 2025-06-07). Its only change from 1.5.4 (2024-05-14) is an inlined package version. No release has shipped since: the npm 'modified' date is still 2025-06-07 and the repo is in maintenance mode. The dist-tags 'beta' = 2.0.0-beta.3 and 'rc' = 1.5.3-rc.1 are stale (2.0 betas date from Feb 2022), so do not use them.
- [high,critical] The UMD build is served by all three CDNs (each returned HTTP 200, ACAO *, 86,948 bytes, byte-identical with SRI sha384-x0YgkOr/3UOZP2CRDxGW9e0Q+2Qjyr3uJrm4xU32Y7ZCNAo7Cc7bjhrZMi/dwczu): https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js, https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js, https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.5/peerjs.min.js. It defines window.peerjs and (deprecated) window.Peer. The npm 'main' is dist/bundler.cjs and 'module' is dist/bundler.mjs; neither is usable from a CDN without a bundler.
- [high,critical] PeerJS 1.5.5 defaults, read from dist/peerjs.js: host 0.peerjs.com, port 443, secure forced true for the cloud host, key 'peerjs', path '/', pingInterval 5000 ms. Default config.iceServers is [stun:stun.l.google.com:19302, turn:eu-0.turn.peerjs.com:3478 + turn:us-0.turn.peerjs.com:3478 (username 'peerjs', credential 'peerjsp')]; passing your own config.iceServers replaces this list. Peer ids must match /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/ and share one global namespace under key 'peerjs', so prefix them with an app name.
- [high,critical] In PeerJS, peer.call(id, stream, {metadata, sdpTransform}) requires a stream and logs an error without one, so the DJ host (which owns the MediaStream) must be the caller. mediaConnection.answer(undefined, {sdpTransform}) with no stream gives a one-way (receive-only) call. sdpTransform only rewrites the LOCAL offer or answer (between createOffer/createAnswer and setLocalDescription); there is no hook for the remote SDP. The caller's RTCPeerConnection exists synchronously as call.peerConnection right after peer.call(). A MediaConnection also opens a small data channel, so call 'close' fires when the remote side hangs up (fixed in 1.5.0).
- [high,critical] Losing the signalling socket (the Peer 'disconnected' event or peer.disconnect()) does not close live P2P connections, so audio keeps flowing if 0.peerjs.com drops mid-set. peer.reconnect() re-registers the same id; it throws on a destroyed peer and emits errors if the id was taken meanwhile. On ICE 'failed', PeerJS emits 'negotiation-failed' and closes the connection. ICE 'disconnected' is only logged. PeerJS has no ICE restart or renegotiation, so recovery means placing a new call. The peerjs-server defaults are alive_timeout 60000 ms, expire_timeout 5000 ms and concurrent_limit 5000.
- [high,critical] The free cloud server 0.peerjs.com has no SLA. A maintainer said in 2022 that there is no per-app limit. Slow or failed registration keeps being reported: issue #461 (Sept 2024) saw ~20 s waits that needed retries, and issue #1350 (Oct 2025, still open) saw intermittent multi-minute delays before the OPEN message while the status page (status.peerjs.com) showed green. Older reports show hitting the 5000 concurrent-user limit. Expect occasional 10 s+ pairing and design retry and timeout UX around it.
- [high] An earlier reference project (its client/src/net/p2p.js) uses data channels only, no media. It pins PeerJS 1.5.4 from https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js and lazy-loads it with a <script crossorigin=anonymous> (12 s timeout, navigator.onLine check, accepts window.Peer or window.peerjs.Peer, overridable via peerJsUrl). Peer ids are '<app>-p2p-' + a 4-char CODE, retried up to 5 times on 'unavailable-id'. iceServers are Google STUN, plus PeerJS's own eu-0/us-0 TURN (repeated because a custom list replaces the defaults), plus Open Relay TURN over TCP 443 (openrelay.metered.ca, user/pass 'openrelayproject'), kept to 4 URLs because browsers warn that 5 or more slow down ICE gathering. Other settings: debug 1; overrides for peerHost/Port/Path/Secure/Key for self-hosting; timings load/open/join 12 s, heartbeat 5 s, dead after 15 s. Lessons in its comments: a JSON DataConnection refuses messages of 16300 bytes or more (it chunks at 15000); 'peer-unavailable' arrives on the Peer, not the connection, and the id has to be parsed from 'Could not connect to peer X'; a link that never opens fires 'negotiation-failed' with no 'close'; queued incoming connections can arrive right after 'open', so they are buffered early; heartbeats are answered from message handlers because background-tab timers get throttled; on 'disconnected' it calls peer.reconnect(), rate-limited to once per 2 s; content blockers can block cdn.jsdelivr.net; the public TURN relays are best effort.
- [high,critical] In libwebrtc (Chrome; Safari is also libwebrtc-based), the sender's Opus encoder is configured from the REMOTE description's fmtp. Juberti noted that stereo=1 has no effect on setLocalDescription. The parameters parsed are stereo, maxaveragebitrate, ptime/minptime/maxptime, usedtx, cbr, useinbandfec and maxplaybackrate. Default bitrate when maxaveragebitrate is absent is 32 kbps × channels. Application mode is kVoip (speech-tuned) for mono and kAudio (music) for stereo. Supported frame lengths are 10/20/40/60(/120) ms. RFC 7587: 'stereo' is a receive preference, and a sender MUST NOT send stereo when stereo=0 or the parameter is absent.
- [medium,critical] On the receiving side, the libwebrtc Opus DECODER takes its channel count from the receiver's own negotiated fmtp. With no 'stereo' parameter, it decodes MONO unless the field trial 'WebRTC-Audio-OpusDecodeStereoByDefault' is enabled (GetDefaultNumChannels returns 2 only then; whether Chrome turns this on by default is unverified). So a Chrome or Safari listener must put stereo=1 in its LOCAL answer to hear stereo. That answer is then the host's remote description, which also makes the host encode stereo. Doing this in the receiver's PeerJS answer sdpTransform covers both ends.
- [medium,critical] Chrome is tightening local SDP munging. From M138 (PSA May 2025), removing an m= section before setLocalDescription is an error. An April 2025 PSA says modified ice-ufrag/ice-pwd will be rejected, with no date set yet. Changes to fmtp, Opus FEC/DTX and codec order are currently only DETECTED (metrics in webrtc-internals), not blocked. Adding stereo=1 to a local answer works today but could break in a future Chrome, so wrap it with a fallback to the plain answer. Munging the REMOTE description is not restricted.
- [high] Chrome does not apply echo cancellation, AGC or noise suppression to non-microphone tracks. Since M37 (2014), audio processing lives in the getUserMedia capture layer, not in RTCPeerConnection, so a MediaStreamAudioDestinationNode track is sent unprocessed (developers regularly complain that such tracks get no AEC). The only receiver-side processing is NetEq jitter buffering, whose time-stretch (accelerate/expand) can cause small artifacts on music when the network jitters.
- [medium] RTCRtpSender.setParameters has shipped since Chrome 68, Safari 11 and Firefox 64; encodings[0].maxBitrate is a cap on the send bitrate. The encoder's target bitrate still comes from the remote fmtp maxaveragebitrate (default 32 kbps per channel), so use both. Raising maxBitrate alone does not lift a 32/64 kbps default target.
- [medium] RTCRtpReceiver.jitterBufferTarget (ms, 0-4000, otherwise RangeError) shipped in Chrome/Edge/Chrome Android 124 (Apr 2024), Firefox 115 (Jul 2023) and Safari 27.0 (released 2026-09-17, i.e. iOS 27). Safari 27 also adds a WebRTC 'targetLatency' receiver attribute whose semantics are not documented in the release notes. The value only influences the UA's target; in libwebrtc it acts as a lower bound, so it can ADD delay for stability but cannot push latency below NetEq's adaptive minimum. Leave it unset for the lowest latency. Chrome's older non-standard receiver.playoutDelayHint (seconds) is superseded.
- [low,critical] Latency budget, estimated (not measured on target devices). Opus 20 ms frame plus ~6.5 ms look-ahead. Phone Wi-Fi network: a Sept 2026 Android-to-Android data-channel test measured RTT p50 41-72 ms and p99 94-119 ms, i.e. ~20-35 ms one way with spikes. NetEq jitter buffer ~40-120 ms on phone Wi-Fi. Output buffering 10-40 ms. Expect ~100-250 ms before the speaker or headphone. Bluetooth A2DP adds roughly 100-300 ms more: AirPods/AAC on iPhone ~80-180 ms, SBC 150-250 ms, AAC/SBC on Android up to ~280 ms, aptX LL/LC3 20-80 ms. Remote output therefore lands ~0.2-0.5 s after the touch, and stays ~0.1-0.25 s behind a locally played Bluetooth output.
- [high,critical] Autoplay on the receiver. Chrome requires a user gesture before an AudioContext can run (context.resume() after the first tap). Media elements fed via srcObject = MediaStream were historically allowed to autoplay, with an explicit warning that this might change, and a failed play() rejects with NotAllowedError. iOS Safari autoplays MediaStream media only if the page is already capturing (mic/camera) or already playing audio; otherwise play() must come from a user action. Design for one tap ('Tap to listen') and retry play() from a tap if it rejects.
- [medium,critical] Play the remote stream through an <audio playsinline autoplay> element, not Web Audio. Reasons: (1) Chrome has a long-standing bug (crbug 121673, reports 2019+, fix status not verified) where a remote WebRTC stream fed into createMediaStreamSource is silent unless the stream is also attached to a (muted) media element. (2) iOS Safari ignores HTMLMediaElement.volume (not settable; reading it returns 1), so volume belongs on the hardware buttons or the host's bus gain. (3) The iOS 15 extra-latency bug on <audio> playback of WebRTC (WebKit 230903) was fixed in Oct 2021 (r284689). (4) For a level meter, use getStats inbound-rtp audioLevel instead of an AnalyserNode.
- [high,critical] Keeping devices awake. iOS Safari suspends WebRTC and Web Audio as soon as the screen locks or Safari goes to the background (Apple forum, Feb 2025), so both the DJ iPhone and an iPhone listener must keep the screen on. The Screen Wake Lock API is in Chrome/Chrome Android 84, Firefox 126 and Safari 16.4; on iOS it does not work in standalone Home Screen web apps until iOS 18.4 (WebKit 254545). navigator.audioSession.type = 'playback' is Safari-only (16.4+; Chrome none, Firefox preview) and stops the ringer/silent switch from muting Web Audio.
- [high,critical] No phone browser can split a page's audio between two local outputs. HTMLMediaElement.setSinkId does not exist on Chrome Android or Firefox Android (platform limitation). It exists in Chrome desktop 49+, Safari 18.4 and Firefox 116, and AudioContext.setSinkId is Chrome 110+ only. So on both iPhone and Android, a second device over WebRTC is the general way to get a second Bluetooth output. On a laptop, setSinkId could split outputs locally.
- [medium,critical] Host candidates on one LAN. Desktop Chrome hides host IPs behind random '<uuid>.local' mDNS names (rolled out by Chrome 76, 2019) unless the page has camera or mic permission. iOS Safari publishes only mDNS host candidates. A Sept 2026 field test saw Android Chrome/WebView 153 publish raw private IPv4 host candidates, and Android Chrome failed to resolve .local names ('Failed to resolve address ... errorcode -105'). The link still worked because the Android end's raw IP was reachable and the other side became peer-reflexive. Rule: the same Wi-Fi works without STUN or TURN if at least one end publishes a reachable address and the access point does not isolate clients. iPhone-to-iPhone depends on iOS resolving the other's mDNS name (unverified). Failing that, it falls back to srflx via STUN plus router hairpin NAT.
- [medium,critical] TURN is needed only when no direct path exists: AP/client isolation (guest, hotel, café and enterprise Wi-Fi), symmetric NAT across different networks, or routers without hairpin NAT. PeerJS's free TURN listens on 3478 only (UDP/TCP, no TLS on 443), so it fails on networks that allow only web ports; Open Relay on TCP 443 covers that but its shared credentials may be retired. A relay sends the audio out to the internet and back, which adds latency and depends on uplink quality. A September 2026 project also found that iOS WebKit can leave RTCPeerConnection.connectionState at 'connecting' after ICE has connected.
- [medium] Serverless QR pairing is practical but needs two scans (offer, then answer back), as in QWBP (Jan 2026). The essential payload is ice-ufrag, ice-pwd, the DTLS sha-256 fingerprint, the setup role and host candidates: 55-100 bytes in binary, versus ~2.5 KB of full SDP. Bootstrap only a DataChannel, then negotiate the audio over it. Do not derive or munge ufrag/pwd (Chrome is moving to reject that); transmit the real values. In-page scanning: BarcodeDetector exists on Chrome Android 83+ but not iOS Safari (flag only since 17), so bundle a JS decoder locally. Offline also requires the app (and any scanner) to be cached by a service worker, since there is no CDN.
## Recommendations
- Architecture: the DJ phone is the HOST and registers PeerJS id 'twinspin-v1-' + a 4-char code (alphabet without 0/O/1/I). The listener (second phone or laptop) opens a random-id Peer and a JSON DataConnection to the host (control channel). On dc 'open', the host calls peer.call(listenerId, remoteDest.stream). The listener answers receive-only with call.answer(undefined, {sdpTransform: tuneOpus}). Keep the DataConnection for control messages: recall, ping/pong for latency, bus choice.
- One AudioContext on the host: create one MediaStreamAudioDestinationNode (channelCount 2, channelCountMode 'explicit') for the remote output, fed from the cue bus and the master bus through two GainNodes. Switching which bus goes remote is then a gain change: no renegotiation, no replaceTrack, no glitch. Make the remote/headphone stream a 'cue mix' (cue plus an adjustable master blend) so that, wherever it plays, cue and master stay mutually aligned for beat-matching by ear.
- UI default for iPhone DJs: offer a toggle 'Second device plays: [Headphones/cue] [Speaker/master]'. Explain that the remote device runs ~0.2-0.5 s late. If the master goes remote, the audience never notices the delay, but the DJ hears the room speaker late. Optional 'Align outputs': delay the LOCAL output with a DelayNode by the measured remote latency.
- Load PeerJS lazily, only when the user opens 'Second device', from https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js with integrity sha384-x0YgkOr/3UOZP2CRDxGW9e0Q+2Qjyr3uJrm4xU32Y7ZCNAo7Cc7bjhrZMi/dwczu and crossorigin='anonymous'. Fall back to cdnjs, then unpkg (same bytes, same SRI). Use a 12 s timeout per attempt. The core DJ app must never depend on it.
- Opus tuning, done on the LISTENER's local answer (PeerJS sdpTransform). Merge into the opus a=fmtp line: stereo=1;sprop-stereo=1;maxaveragebitrate=192000;useinbandfec=1;usedtx=0;cbr=0. Leave ptime at the default 20 ms; a=ptime:10 saves ~10 ms but doubles the packet rate on phone Wi-Fi. This one change makes the host's encoder go stereo, music mode (kAudio), 192 kbps, and makes the listener's decoder output stereo.
- Fallback when munging fails: if the listener gets a Peer 'error' of type 'webrtc' after answering (a future Chrome rejecting fmtp munging), set stereoMunge = false and send {t:'recall'} on the DataConnection. The host closes the old call and calls again, and the listener answers unmodified (mono, still works). Optionally the host also patches call.peerConnection.setRemoteDescription to add maxaveragebitrate and stereo, since remote munging is spec-legal.
- After ICE reaches connected/completed, the host calls sender.setParameters with encodings[0].maxBitrate = 192000 and networkPriority 'high' (create encodings:[{}] if missing). Watch getStats: if the selected candidate pair is 'relay', drop to 128 kbps.
- Latency: leave receiver.jitterBufferTarget unset (null) for minimum delay. Offer a 'Stable / fewer dropouts' setting that sets 80-150 ms where 'jitterBufferTarget' in receiver (Chrome 124+, Firefox 115+, Safari 27+). Show the measured delay: jitterBufferDelay/jitterBufferEmittedCount deltas from inbound-rtp, plus currentRoundTripTime/2 from the candidate pair, plus ~30 ms codec, plus a note that Bluetooth adds 100-300 ms.
- Listener page UX: the host shows the code in huge type plus a QR of `${origin}${pathname}#listen=CODE`. The listener scans with the phone's camera app (no in-app scanner needed when online), the page opens with the code prefilled, and one giant 'Tap to listen' button does everything inside the gesture: navigator.audioSession.type='playback' (if present), navigator.wakeLock.request('screen'), load PeerJS, connect. Retry audio.play() from a second tap if it rejects with NotAllowedError.
- Listener playback: a single <audio autoplay playsinline> element with srcObject = remote stream, no Web Audio. Volume comes from the listener's hardware buttons (iOS ignores element.volume) or from the host's per-bus gain. Level meter from getStats audioLevel.
- Reconnects. Host: on 'disconnected', peer.reconnect() after 2 s (rate-limited) and keep the code; live calls survive. On startup 'unavailable-id', pick a new code (max 5 tries); to reclaim the same code after a crash, retry for up to ~60 s (server alive_timeout). Listener: a watchdog every ~5 s re-opens the DataConnection if it is not open. Treat Peer 'peer-unavailable' as 'waiting for DJ'. On call 'close' while the dc is open, send {t:'recall'}. Judge link health by iceConnectionState and track/bytesReceived, not connectionState (iOS bug).
- ICE config, at most 4 URLs: stun:stun.l.google.com:19302; turn:eu-0.turn.peerjs.com:3478 and turn:us-0.turn.peerjs.com:3478 (peerjs/peerjsp); turn:openrelay.metered.ca:443?transport=tcp (openrelayproject/openrelayproject). Make it overridable through window.TWINSPIN_CONFIG.iceServers and peerHost/peerPort/peerPath/peerKey, like the reference project.
- Wake lock on BOTH devices: request in the tap, re-request on visibilitychange→visible, and tell iPhone users the screen must stay on (lock = silence). If the app runs as an iOS Home Screen app, wake lock needs iOS 18.4+.
- Hosting: HTTPS static hosting (GitHub Pages) is fine. In an iframe preview, the embedding page needs allow='autoplay; screen-wake-lock; camera' for those features. Wrap all storage in try/catch (opaque-origin sandboxes throw), and expect no service worker inside sandboxed iframes.
- Offline fallback (phase 2, optional): pair by two QR scans. Show a compact JSON or binary payload {ufrag, pwd, fingerprint as base64, setup, host candidates incl. mDNS UUIDs} built after non-trickle gathering (wait for 'complete' or 2.5 s). Use a negotiated DataChannel (id 0) on both ends and rebuild a minimal m=application SDP from a template. Then run the same audio call over that channel, sending offer/answer as messages. Requires a service worker caching the app, the scanner and a local jsQR/zxing-wasm decoder; request camera as video only and stop the tracks right after scanning.
## Gotchas
- peer.call() needs a stream, so the listener cannot call the host. The host must call the listener after the listener's DataConnection opens.
- PeerJS sdpTransform touches only the LOCAL SDP. Stereo needs stereo=1 in the listener's local answer: it makes the host encode stereo and the listener decode stereo. Without it, libwebrtc's decoder defaults to mono (unless the field trial is on) and the encoder runs speech-mode kVoip at 32 kbps.
- Chrome is progressively rejecting local SDP munging: m-line removal since M138, ufrag/pwd announced. fmtp munging works in 2026 but keep the 'recall without munging' fallback.
- jitterBufferTarget cannot lower latency below the UA's own target. It is a stability knob that adds delay. Safari only gained it in 27.0 (Sept 2026).
- Every Bluetooth hop adds 100-300 ms, and phone Wi-Fi power saving adds jitter, so the remote output is always noticeably late (~0.2-0.5 s). Never compare a remote stream against a local one by ear; put cue and master together in the same stream.
- iOS Safari: screen lock or backgrounding immediately suspends WebRTC and Web Audio. element.volume is ignored. A MediaStream will not autoplay unless the page is capturing or already playing audio. The ringer switch mutes Web Audio unless navigator.audioSession.type = 'playback' (Safari 16.4+).
- Chrome: a remote MediaStream fed into createMediaStreamSource can be silent unless also attached to a media element. Avoid Web Audio on the listener.
- Do not call getUserMedia({audio:true}) on the DJ iPhone (e.g. to expose host candidates or for a QR scanner with audio). Mic capture switches the iOS audio session to play-and-record, which reroutes and degrades music output. For QR scanning, request video only and stop the tracks immediately.
- Android Chrome cannot resolve '.local' mDNS candidates, and iOS Safari only offers mDNS candidates. iPhone-to-iPhone on the same Wi-Fi therefore relies on iOS mDNS resolution, then on STUN plus hairpin NAT. Client-isolated Wi-Fi needs TURN.
- Public relays (0.peerjs.com signalling, PeerJS TURN, Open Relay) are best-effort third-party services with recurring slow-connect reports. Always show progress, time out at ~12-15 s and offer retry.
- PeerJS's global id namespace (key 'peerjs') is shared by all users of the cloud server. Use an app prefix ('twinspin-v1-') and handle 'unavailable-id'.
- A Peer 'error' listener registered with once() before 'open' will still catch (and, if it destroys the peer, kill it on) the first error after open. Remove both open/error listeners once one fires.
- PeerJS has no ICE restart or renegotiation: a failed ICE means a new call (1-3 s gap). Recovery has to be coded via the DataConnection 'recall' message.
- Five or more ICE server URLs slow down gathering (browser warning noted in the reference project's code). Keep the list to 4.
- In iframes, wake lock, camera and autoplay need explicit allow= permissions. A sandbox without allow-same-origin breaks storage and service workers.
## Snippets
```js
// net/peer.js — shared helpers (ES module, no build step)
export const PEERJS_URLS = [
  'https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.5/peerjs.min.js',
  'https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js',
];
export const PEERJS_SRI = 'sha384-x0YgkOr/3UOZP2CRDxGW9e0Q+2Qjyr3uJrm4xU32Y7ZCNAo7Cc7bjhrZMi/dwczu'; // same bytes on all 3 CDNs
export const ICE_SERVERS = [ // <= 4 URLs
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];
export const ID_PREFIX = 'twinspin-v1-';
const ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const makeCode = (n = 4) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => ABC[b % ABC.length]).join('');

export function loadPeerJs(i = 0) {
  if (window.peerjs?.Peer || window.Peer) return Promise.resolve(window.peerjs?.Peer || window.Peer);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    let done = false;
    const fail = () => { if (done) return; done = true; clearTimeout(t); s.remove();
      i + 1 < PEERJS_URLS.length ? loadPeerJs(i + 1).then(resolve, reject) : reject(new Error('peerjs_blocked')); };
    const t = setTimeout(fail, 12000);
    s.src = PEERJS_URLS[i]; s.integrity = PEERJS_SRI; s.crossOrigin = 'anonymous'; s.async = true;
    s.onload = () => { if (done) return; done = true; clearTimeout(t);
      const P = window.peerjs?.Peer || window.Peer; P ? resolve(P) : reject(new Error('peerjs_missing')); };
    s.onerror = fail;
    document.head.appendChild(s);
  });
}

export function openPeer(Peer, id) { // resolves on 'open'; rejects with PeerJS error (e.type) or timeout
  return new Promise((resolve, reject) => {
    const opts = { config: { iceServers: ICE_SERVERS }, debug: 1 };
    const p = id ? new Peer(id, opts) : new Peer(opts);
    const done = () => { clearTimeout(t); p.off('open', onOpen); p.off('error', onErr); };
    const onOpen = () => { done(); resolve(p); };
    const onErr = (e) => { done(); p.destroy(); reject(e); };
    const t = setTimeout(() => onErr(Object.assign(new Error('signalling timeout'), { type: 'timeout' })), 15000);
    p.on('open', onOpen); p.on('error', onErr);
  });
}
```
```js
// Opus fmtp tuning. Apply to the LISTENER's local answer (PeerJS sdpTransform) and/or to a REMOTE answer on the host.
// a=fmtp:111 minptime=10;useinbandfec=1  ->  a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=192000;usedtx=0;cbr=0
export function tuneOpus(sdp, { stereo = true, kbps = 192, ptime = 0 } = {}) {
  const rtp = /a=rtpmap:(\d+) opus\/48000\/2\r?\n/i.exec(sdp);
  if (!rtp) return sdp;
  const pt = rtp[1];
  const want = { stereo: stereo ? 1 : 0, 'sprop-stereo': stereo ? 1 : 0, maxaveragebitrate: kbps * 1000, useinbandfec: 1, usedtx: 0, cbr: 0 };
  const fmtpRe = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  const merged = (params = '') => {
    const kv = {};
    for (const p of params.split(';')) { const [k, v] = p.trim().split('='); if (k) kv[k] = v; }
    Object.assign(kv, want);
    return `a=fmtp:${pt} ` + Object.entries(kv).map(([k, v]) => `${k}=${v}`).join(';');
  };
  sdp = fmtpRe.test(sdp) ? sdp.replace(fmtpRe, (_, p) => merged(p)) : sdp.replace(rtp[0], rtp[0] + merged() + '\r\n');
  if (ptime && !/a=ptime:/.test(sdp)) sdp = sdp.replace(fmtpRe, (line) => `${line}\r\na=ptime:${ptime}`);
  return sdp;
}
```
```js
// remote-host.js — DJ phone. buses = { master: AudioNode, cue: AudioNode } (stereo).
import { loadPeerJs, openPeer, makeCode, ID_PREFIX } from './peer.js';
export async function startRemoteOut(ctx, buses, ui) {
  const out = ctx.createMediaStreamDestination();
  out.channelCount = 2; out.channelCountMode = 'explicit';
  const sel = {};
  for (const k of ['master', 'cue']) { sel[k] = ctx.createGain(); sel[k].gain.value = 0; buses[k].connect(sel[k]).connect(out); }
  const setBus = (k) => { for (const b in sel) sel[b].gain.setTargetAtTime(b === k ? 1 : 0, ctx.currentTime, 0.015); }; // no renegotiation
  setBus('cue');

  const Peer = await loadPeerJs();
  let peer = null, code = '';
  for (let i = 0; !peer; i++) {
    code = makeCode();
    try { peer = await openPeer(Peer, ID_PREFIX + code); }
    catch (e) { if (e.type !== 'unavailable-id' || i >= 4) throw e; }
  }
  ui.showPairing(code, `${location.origin}${location.pathname}#listen=${code}`); // big code + QR of this URL
  peer.on('disconnected', () => setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, 2000)); // live calls survive
  peer.on('error', (e) => ui.log('peer', e.type));

  const calls = new Map(); // listener peer id -> MediaConnection
  const callListener = (id) => {
    calls.get(id)?.close();
    const call = peer.call(id, out.stream, { metadata: { app: 'twinspin', v: 1 } });
    calls.set(id, call);
    const pc = call.peerConnection; // exists synchronously for the caller
    pc?.addEventListener('iceconnectionstatechange', () => {
      if (/^(connected|completed)$/.test(pc.iceConnectionState)) capBitrate(pc, 192);
    });
    call.on('close', () => { if (calls.get(id) === call) calls.delete(id); });
  };
  peer.on('connection', (dc) => { // listener's control channel
    dc.on('open', () => callListener(dc.peer));
    dc.on('data', (m) => {
      if (m?.t === 'recall') callListener(dc.peer);
      else if (m?.t === 'ping') dc.send({ t: 'pong', c: m.c });
    });
    dc.on('close', () => { calls.get(dc.peer)?.close(); calls.delete(dc.peer); });
  });
  return { code, setBus, stop: () => peer.destroy() };
}
async function capBitrate(pc, kbps) {
  const s = pc.getSenders().find((x) => x.track?.kind === 'audio');
  if (!s) return;
  const p = s.getParameters();
  if (!p.encodings?.length) p.encodings = [{}];
  p.encodings[0].maxBitrate = kbps * 1000;
  p.encodings[0].networkPriority = 'high';
  try { await s.setParameters(p); } catch (e) { console.warn('setParameters', e); }
}
```
```js
// listen.js — second device. Call listen() from the big 'Tap to listen' button's click handler (user gesture).
import { loadPeerJs, openPeer, ID_PREFIX } from './peer.js';
import { tuneOpus } from './opus.js';
export async function listen(code, audioEl, ui) {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  const wake = async () => { try { await navigator.wakeLock?.request('screen'); } catch {} }; // Chrome 84+, Safari 16.4+ (iOS PWA 18.4+)
  wake(); document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
  audioEl.autoplay = true; audioEl.setAttribute('playsinline', '');

  const Peer = await loadPeerJs();
  const peer = await openPeer(Peer); // random id
  let stereoMunge = true, dc = null, dcSince = 0;

  peer.on('call', (call) => {
    if (!String(call.peer).startsWith(ID_PREFIX)) { call.close(); return; }
    call.answer(undefined, stereoMunge ? { sdpTransform: (s) => tuneOpus(s, { kbps: 192 }) } : {}); // receive-only
    call.on('stream', async (stream) => {
      audioEl.srcObject = stream; // <audio>, not Web Audio
      try { await audioEl.play(); ui.state('playing'); } catch { ui.state('tap-to-play'); } // button -> audioEl.play()
    });
    call.on('close', () => { ui.state('reconnecting'); if (dc?.open) dc.send({ t: 'recall' }); });
  });
  peer.on('error', (e) => {
    if (e.type === 'webrtc' && stereoMunge) { stereoMunge = false; if (dc?.open) dc.send({ t: 'recall' }); } // munged answer refused -> plain
    else if (e.type === 'peer-unavailable') ui.state('waiting-for-dj');
  });
  peer.on('disconnected', () => setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, 2000));

  const connect = () => {
    try { dc?.close(); } catch {}
    dcSince = Date.now();
    dc = peer.connect(ID_PREFIX + code, { reliable: true, serialization: 'json', metadata: { app: 'twinspin' } });
  };
  connect();
  setInterval(() => { if (!peer.disconnected && !dc?.open && Date.now() - dcSince > 8000) connect(); }, 2000);
}
```
```js
// Live latency/quality readout on the listener (deltas between two samples give the current value).
let prev = null;
export async function sampleRx(pc) {
  const st = await pc.getStats(); let rx = null, rtt = 0, relay = false;
  st.forEach((s) => {
    if (s.type === 'inbound-rtp' && s.kind === 'audio') rx = s;
    if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
      rtt = (s.currentRoundTripTime || 0) * 1000;
      relay = st.get(s.localCandidateId)?.candidateType === 'relay' || st.get(s.remoteCandidateId)?.candidateType === 'relay';
    }
  });
  let jbMs = 0;
  if (rx && prev && rx.jitterBufferEmittedCount > prev.jitterBufferEmittedCount)
    jbMs = 1000 * (rx.jitterBufferDelay - prev.jitterBufferDelay) / (rx.jitterBufferEmittedCount - prev.jitterBufferEmittedCount);
  prev = rx;
  return { estMs: Math.round(jbMs + rtt / 2 + 30), jbMs: Math.round(jbMs), rttMs: Math.round(rtt), relay,
           level: rx?.audioLevel ?? 0, lost: rx?.packetsLost ?? 0, concealed: rx?.concealedSamples ?? 0 }; // + Bluetooth 100-300 ms
}
// Optional stability knob (Chrome 124+, Firefox 115+, Safari 27+): receiver.jitterBufferTarget = 120; // ms; null = lowest latency
```
```js
// Offline pairing sketch (two QR scans). Bootstraps a negotiated DataChannel; the audio call is then signalled over it.
export const makeBootstrapPc = () => { const pc = new RTCPeerConnection({ iceServers: [] });
  const ch = pc.createDataChannel('sig', { negotiated: true, id: 0 }); return { pc, ch }; };
const gathered = (pc) => new Promise((r) => { if (pc.iceGatheringState === 'complete') return r();
  pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && r()); setTimeout(r, 2500); });
export async function compactLocal(pc) { // -> ~150-250 chars of JSON (smaller if binary/base64)
  await gathered(pc);
  const s = pc.localDescription.sdp, g = (re) => (re.exec(s) || [])[1];
  return JSON.stringify({ u: g(/a=ice-ufrag:(\S+)/), p: g(/a=ice-pwd:(\S+)/), f: g(/a=fingerprint:sha-256 (\S+)/), s: g(/a=setup:(\S+)/),
    c: [...s.matchAll(/a=candidate:\S+ 1 udp \d+ (\S+) (\d+) typ (host|srflx)/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`) });
}
export function expandRemote(json, type) { // type 'offer' (built by the answerer) or 'answer' (built by the offerer)
  const o = JSON.parse(json);
  const cands = o.c.map((c, i) => { const [ip, port, typ] = c.split(' ');
    return `a=candidate:${i + 1} 1 udp ${2122260223 - i} ${ip} ${port} typ ${typ}`; });
  const sdp = ['v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', `a=ice-ufrag:${o.u}`, `a=ice-pwd:${o.p}`,
    `a=fingerprint:sha-256 ${o.f}`, `a=setup:${type === 'offer' ? 'actpass' : o.s}`, 'a=mid:0', 'a=sctp-port:5000',
    'a=max-message-size:262144', ...cands, 'a=end-of-candidates', ''].join('\r\n');
  return { type, sdp };
}
// Offerer: createOffer -> setLocalDescription (unmodified) -> show QR(compactLocal). Answerer: scan -> setRemoteDescription(expandRemote(x,'offer'))
// -> createAnswer -> setLocalDescription -> show QR(compactLocal). Offerer: scan -> setRemoteDescription(expandRemote(y,'answer')). ch 'open' = paired.
```
## Open questions
- Is Chrome's field trial 'WebRTC-Audio-OpusDecodeStereoByDefault' enabled by default (Finch) in Chrome 14x/15x? If so, listener-side stereo munging is unnecessary for decoding. Could not verify; the WebRTC log and Chromium config were not readable.
- When, if ever, will Chrome reject fmtp/stereo munging in setLocalDescription? The PSAs cover m-line removal (M138) and ufrag/pwd (date unset).
- iPhone-to-iPhone on the same Wi-Fi or iOS Personal Hotspot: does iOS Safari resolve the other iPhone's mDNS host candidate, or does it need STUN plus hairpin or TURN? Needs a device test.
- Real end-to-end latency on target devices (DJ iPhone → listener Android/iPhone → Bluetooth headphones). Measure with a click or clap test and compare to the getStats estimate.
- Semantics of Safari 27's new WebRTC 'targetLatency' receiver attribute (which object it lives on, and whether it can lower latency), versus jitterBufferTarget.
- Does Android Chrome keep playing the remote WebRTC audio with the screen off or the tab in the background? It was not verifiable this session (search budget exhausted); assume the screen must stay on and use wake lock.
- Current availability of PeerJS's TURN (eu-0/us-0.turn.peerjs.com) and validity of Open Relay's shared 'openrelayproject' credentials. Both are third-party and best-effort; consider a user-configurable TURN.
- Whether the Chrome crbug 121673 Web Audio silence bug still reproduces in 2026 is irrelevant if the listener uses only an <audio> element, but it matters if a Web Audio meter or EQ is ever added on the listener.
