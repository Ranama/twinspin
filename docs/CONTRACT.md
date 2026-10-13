# TwinSpin build contract (v2)

TwinSpin is a two-deck DJ web app for phones first, then tablets and computers. It is plain HTML, CSS and
JavaScript ES modules. There is no build step and no npm. The same folder runs from any static HTTPS host
(GitHub Pages), from `tools/serve.ps1` on localhost, and inside the claude.ai artifact preview (`config.js` sets
`preview: true` there: sandboxed iframe, no service worker, no WebRTC, no microphone, maybe no blob: workers).

This file is the single source of truth for module boundaries, APIs, units and behaviour. Every build agent
codes against it. When you must deviate (an API turns out to be impossible), keep the documented signature
working as an adapter and write the change in `docs/CHANGES.md` (append; one bullet per change with the file
and the reason).

Research notes (read the ones named for your part; they are long, skim the Recommendations/Gotchas and the
verify-* corrections, which override the research-* claims): `docs/research/research-{routing,engine,bpm,ux,
webrtc,pwa}.md` and `docs/research/verify-*.md`. A working BPM prototype is in `docs/research/proto/`.

## 0. Ground rules

* **ES modules only**, relative imports with the `.js` extension, no bare specifiers, no import maps.
  `config.js` is the only classic script. **No top-level `await`, no circular imports** (Safari < 27 module
  loader bugs). No module may have side effects at import time except `src/main.js`.
* **No dependencies** except lazily loaded CDN scripts for the remote feature only: PeerJS 1.5.5 UMD and an
  optional QR encoder (section 7). Everything else is hand-written.
* **Units.** Track positions and durations are **seconds of track time** (float64). `rate` is a playback speed
  multiplier (1 = normal). Tempo fader value is -1..1. Gains are linear unless the name ends in `Db`.
  BPM is beats per minute of the **original track** unless the name says `effective` (= bpm * rate).
  Never round BPM except for display.
* **Pure logic lives in DOM-free, Web-Audio-free modules** so the JsCheck runner (Jint, no DOM, no audio) can
  test it: `src/core/*`, `src/audio/{deck-dsp,curves,routing-plan,tags,demo-synth}.js`, `src/analysis/{bpm,
  waveform,loudness}.js`, `src/deck/{sync-math,cue-logic}.js`, `src/remote/sdp.js`.
* **Never allocate in audio callbacks** (worklet `process`, ScriptProcessor `onaudioprocess`, `DeckDSP.process`).
* **User activation**: touch `pointerdown` is NOT an activation. Anything that needs a gesture (creating/resuming
  the AudioContext, opening a file picker, `setSinkId`, `getUserMedia`, `selectAudioOutput`, `audio.play()`,
  fullscreen, wake lock) runs from `click` (or `pointerup`/`keydown`), synchronously before the first `await`.
  Timing-critical controls (PLAY, CUE, SYNC, pads) still fire on `pointerdown`.
* **Errors**: user-facing failures become `emit('error', message)` on the owning object with a short, plain
  message that says what to do ("This file can't be played in this browser. Try an MP3 or WAV."). Never
  `alert()`/`confirm()`/`prompt()` (disabled in the preview frame). Wrap every storage access in try/catch.
* **Never call `speechSynthesis`** (iOS 27 bug silences Web Audio). **Never call `getUserMedia` on phones**
  (Android switches to call mode, iOS to play-and-record; Bluetooth drops to hands-free quality).
* **Style**: 2-space indentation, single quotes, semicolons, JSDoc on exported APIs, a header comment per file
  saying what it is and how to use it (see `src/core/*.js`). Keep files under ~900 lines; split if larger.
* **Tests**: `tests/<name>.test.js`, run with `tools/JsCheck/jscheck test tests` (Git Bash) or
  `tools\JsCheck\jscheck.ps1 test tests`. `tools/JsCheck/jscheck check src tests` must report 0 errors and
  0 warnings (add `/* global ... */` comments for worklet globals). Jint runs about 2-3 million simple loop
  iterations per second, so test signals must be small: 8000-12000 Hz sample rates and 10-40 s of audio.
  Each test file must finish in under 60 s; run single files with `tools/JsCheck/jscheck run tests/x.test.js`.
  JsCheck has no DOM, canvas or audio: stub what you need inside the test.
* **Do not edit files you do not own** (ownership table, section 11). If you need something from another
  module that is not in this contract, write a small local helper or note it in `docs/CHANGES.md`.

Already written (owned by the lead, read them, do not rewrite): `src/core/emitter.js` (Emitter with
`on/off/once/emit`, `on` returns an unsubscribe function), `src/core/util.js` (clamp, lerp, dbToGain, wrap,
wrapPhase, fmtTime, fmtBpm, fmtPercent, hashHue, storageGet/Set, mulberry32), `src/core/settings.js`
(`Settings` + `DEFAULTS`, read it for every setting key), `src/core/env.js` (`env` feature flags, `config`,
`haptic()`), `config.js`.

## 1. Runtime overview

```
                 +-------------- AudioContext (latencyHint 'interactive') ------------------------------+
 File -> decode  |  DeckPlayer A (AudioWorklet 'twinspin-deck' | ScriptProcessor fallback)              |
 -> Int16 PCM    |    -> ChannelStrip A: trim -> EQ isolator -> filter -> FxRack(echo, flanger)        |
 -> analysis     |         -> [PFL tap -> cueBus] -> fader -> xfade gain -> masterBus                  |
 (worker)        |                                                   \-> reverb send -> shared reverb  |
                 |  DeckPlayer B -> ChannelStrip B (same)                                              |
                 |  masterBus (+ reverb return) -> limiter -> masterOut ; cueBus (+ master) -> cueOut   |
                 |  OutputRouter: masterOut / cueOut -> destination | <audio>.setSinkId | split | remote|
                 +-------------------------------------------------------------------------------------+
 Deck controllers (A, B) own transport/cue/loop/tempo state and drive the player + channel.
 SyncController matches tempo and beat phase between decks. AppUI renders decks, mixer, pages, sheets.
```

Boot (`src/main.js`): construct `Settings`, `AudioEngine`, `Library`, two `Deck`s, `SyncController`, `AppUI`.
The UI is visible immediately but covered by a **start overlay** ("Tap to start"). Its `click` handler calls
`engine.start()` synchronously (iOS needs the AudioContext created/resumed inside the gesture). When `engine`
emits `'ready'`, decks attach to their players/channels and the overlay closes.

## 2. Audio engine (`src/audio/`)

### 2.1 `deck-dsp.js` - pure DSP core (no Web Audio, no imports, no module-level helpers)

`DeckDSP` must be **self-contained**: the worklet source is built at runtime from `DeckDSP.toString()`, so the
class may not reference anything outside its own body (put constants in static fields or methods). A test must
prove `new Function(DeckDSP.toString() + '\nreturn DeckDSP;')()` yields a working class.

```js
export class DeckDSP {
  static PLATTER_SECONDS_PER_TURN = 1.8;   // 33 1/3 rpm (static field so it survives toString)
  constructor(outRate)                     // output sample rate (AudioContext.sampleRate)
  load(channels, srcRate)                  // channels: Int16Array[] or Float32Array[] (1 or 2; mono feeds both
                                           // sides). Int16 is scaled by 1/32768.
  unload()
  get loaded(): boolean
  get duration(): number                   // seconds
  get position(): number                   // seconds, current read head
  get velocity(): number                   // current signed speed, track-seconds per output second
  get playing(): boolean                   // motor on
  setPlaying(on)                           // motor on/off. Start: 3 ms gain fade-in. Stop: brake 0 -> 3 ms gain
                                           // fade-out then the head freezes; brake > 0 -> speed ramps to 0 over
                                           // brake ms (vinyl brake), then motor off
  setRate(r)                               // tempo rate, 0.25..4
  setBend(b)                               // additive temporary speed offset (nudge / sync correction), -0.9..0.9
  setBrake(ms)                             // 0 = CDJ stop
  seek(sec, declick = true)                // jump; declick = 256-frame crossfade from a ghost head
  scratchBegin()                           // finger down: the platter is held
  scratchMove(targetSec, targetVel)        // absolute target position + finger speed (track-s per s)
  scratchEnd()                             // finger up: speed returns to (playing ? rate + bend : 0) with a
                                           // 70 ms time-constant ramp (motor pull-in)
  setLoop(startSec, endSec)                // seamless loop with declicked wrap; reverse play wraps too
  clearLoop()
  setCrush(amount)                         // 0 = off. 0..1: sample-hold factor 1..16 and bit depth 16..3
  process(outL, outR, frames)              // fill `frames` samples (use the array length, never assume 128)
  consumeEnded(): boolean                  // true once after the head ran off the end while the motor was on
}
```

Behaviour details (see `docs/research/research-engine.md` "Scratch input" / "Worklet scratch follower"):
* Read head in source frames (float64); per output sample advance `velocity * srcRate / outRate`.
* **4-point cubic Hermite (Catmull-Rom) interpolation.** Reads outside `[0, length)` are 0 (the head may sit up
  to 2 s before 0 while scratching; clamp there).
* **Scratch follower** (per sample): `targetPred = target + targetVel * min(samplesSinceMsg, 30 ms)`;
  `desired = targetVel + (targetPred - pos) / (0.012 s)`; one-pole smoother with a 4 ms time constant; clamp
  speed to +-12. `targetVel` decays to 0 when no `scratchMove` arrived for 60 ms, so a held, unmoving platter goes
  silent. If `|targetPred - pos| > 0.25 s`, do a declicked jump instead of a wild sweep.
* **Declick**: on seek and loop wrap keep a ghost head for 256 frames and crossfade linearly. No clicks on
  start/stop either (3 ms gain ramps). End of track: 5 ms fade, motor off, ended flag.
* **Crush**: after interpolation: sample-and-hold every `1 + round(amount * 15)` frames, then quantize to
  `round(16 - amount * 13)` bits. `amount` 0 bypasses completely.

### 2.2 Worklet: `deck-worklet-src.js` + `deck-processor.js`

Loading order (implemented in `deck-player.js`): (1) Blob URL built from `DeckDSP.toString()` plus the
processor source (from a function's `toString()`), registered as `'twinspin-deck'`; (2) if that throws (CSP),
`addModule(new URL('./deck-processor.js', import.meta.url))` - a file that imports `deck-dsp.js` and registers the
same processor; (3) if `ctx.audioWorklet` is missing (http LAN) or both fail, ScriptProcessor fallback.
Node options: `{ numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] }` (without
`outputChannelCount` a source worklet renders MONO).

Messages main -> worklet (`port.postMessage`), all objects with a `t` field:
`{t:'load', channels:[Int16Array...], srcRate}` (buffers transferred), `{t:'unload'}`, `{t:'play', on}`,
`{t:'rate', v}`, `{t:'bend', v}`, `{t:'brake', ms}`, `{t:'seek', pos, declick}`,
`{t:'scratch', phase:'begin'|'move'|'end', pos, vel}`, `{t:'loop', start, end}` or `{t:'loop', off:true}`,
`{t:'crush', v}`. Handlers must be O(1).

Messages worklet -> main: `{t:'pos', pos, vel, playing, frame}` every 4 render quanta (~11 ms at 48 kHz), where
`frame` is `currentFrame` at the end of the rendered block; `{t:'ended'}`; `{t:'loaded', duration}`.

### 2.3 `deck-player.js` - main-thread player

```js
export class DeckPlayer extends Emitter {
  static async create(ctx, { worklet = env.audioWorklet } = {}) // loads the worklet module once per ctx
  readonly node: AudioNode                   // stereo output, connect to a ChannelStrip input
  readonly usingWorklet: boolean
  load(channels, srcRate)                    // Int16Array[]; TRANSFERRED to the worklet (callers must not reuse
                                             // them). Resets position to 0, loop off, motor off.
  unload()
  setPlaying(on), play(), pause()
  setRate(r), setBend(b), setBrake(ms), seek(sec, declick = true)
  scratchBegin(), scratchMove(sec, vel), scratchEnd()
  setLoop(start, end), clearLoop(), setCrush(v)
  getPosition(): number                      // extrapolated from the last report using ctx.getOutputTimestamp()
                                             // (or currentTime): pos + vel * elapsed; optimistic: right after
                                             // seek() it returns the new position
  readonly playing: boolean, readonly velocity: number, readonly duration: number, readonly loaded: boolean
  dispose()
  // events: 'ended', 'loaded'
}
```
ScriptProcessor fallback: `bufferSize` 2048 on mobile, 1024 on desktop, 0 inputs / 2 outputs, runs DeckDSP on the
main thread, must stay connected to keep firing.

### 2.4 `curves.js` - pure mapping functions (tested)

```js
export function faderGain(v)               // channel fader 0..1 -> gain, v*v
export function xfadeGains(x, curve)       // x -1 (A) .. +1 (B) -> [gA, gB]
                                           // 'smooth': gA = cos((x+1)*PI/4), gB = sin((x+1)*PI/4)
                                           // 'cut': gA = clamp((1-x)/0.12, 0, 1), gB = clamp((1+x)/0.12, 0, 1)
export function eqGain(v)                  // EQ -1..1 -> gain: v <= -0.98 -> 0 (kill); v<0 -> (1+v)^2.5;
                                           // v>0 -> dbToGain(6*v)
export function filterParams(v)           // filter -1..1 -> { lp, hp, qDb }; |v| < 0.04 -> lp 22000, hp 10, qDb 0
                                           // v<0: lp = 20000*(60/20000)^(-v); v>0: hp = 20*(8000/20)^v
                                           // qDb = 1 + 5*|v|   (BiquadFilter LP/HP Q is in dB!)
export function tempoToRate(value, range)  // 1 + value*range
export function rateToTempo(rate, range)   // inverse, clamped to -1..1
```

### 2.5 `effects.js` - per-channel FX rack + shared reverb (Web Audio nodes)

```js
export const FX_TYPES = ['echo', 'reverb', 'flanger', 'crush'];  // crush runs in DeckDSP (Deck.setFx)
export class FxRack {                        // inserted pre-fader in each ChannelStrip
  constructor(ctx, { reverbSend })           // reverbSend: GainNode owned by the ChannelStrip (post-fader send)
  readonly input: AudioNode, readonly output: AudioNode
  set(name, on)                              // 'echo' | 'flanger' | 'reverb' (reverb ramps reverbSend.gain).
                                             // 20 ms ramps; echo and reverb tails ring out after switching off
                                             // (only the send closes)
  setAmount(v)                               // 0..1 shared wet amount for all active FX of this rack
  setBeatSeconds(sec)                        // echo time = 3/4 beat (clamped 0.06..2 s); flanger LFO period 8 beats
  echoOut(beatSec): number                   // one-shot: echo on (feedback 0.6) and the dry signal fades out over
                                             // 4 beats while the tail rings; returns the seconds until silence;
                                             // dry restores automatically 50 ms after the caller pauses the deck
  dispose()
}
export class ReverbBus {                     // one shared ConvolverNode (generated 2.2 s stereo noise IR with
  constructor(ctx)                           // exponential decay, decorrelated L/R, pre-HP 200 Hz)
  readonly input: AudioNode, readonly output: AudioNode
}
```
Echo: DelayNode (max 2 s) with feedback 0.45, band-limited feedback loop (HP 250 Hz, LP 4.5 kHz).
Flanger: DelayNode with base 4 ms, depth 2 ms from an OscillatorNode LFO (min delay in a feedback cycle is one
render quantum, ~2.7-2.9 ms), feedback 0.55, 50/50 mix. Dry signal always passes at unity: `output = dry + wet`.
Set `automationRate = 'k-rate'` on biquad params in try/catch; smooth with `setTargetAtTime(v, now, 0.015)`.

### 2.6 `mixer.js`

```js
export class ChannelStrip {
  constructor(ctx, name, { reverbInput })    // name 'A' | 'B'; reverbInput = ReverbBus.input
  readonly input: AudioNode                  // connect DeckPlayer.node here
  setTrimDb(db)                              // auto gain + manual trim, -24..+12
  setEq(band, v)                             // band 'low' | 'mid' | 'high', v -1..1 (curves.eqGain)
                                             // 3-band ISOLATOR: low = LR4 lowpass 250 Hz, high = LR4 highpass
                                             // 2.5 kHz, mid = LR4 HP 250 then LR4 LP 2.5 kHz. LR4 = 2 cascaded
                                             // Butterworth biquads with Q = -3.0103 (dB!). Bands summed ~ flat.
  setFilter(v)                               // -1..1 (curves.filterParams), 15 ms smoothing
  readonly fx: FxRack
  setVolume(v)                               // 0..1 (curves.faderGain)
  setXfadeGain(g)                            // set by Mixer
  setCue(on)                                 // PFL: post-FX, pre-fader copy to the cue bus
  readonly meter: Meter                      // post-fader
  dispose()
}
export class Mixer extends Emitter {
  constructor(ctx)
  readonly channels: [ChannelStrip, ChannelStrip]
  readonly reverb: ReverbBus
  readonly masterOut: AudioNode              // master bus (+ reverb return) -> DynamicsCompressor (threshold -3,
                                             // knee 0, ratio 20, attack 0.002, release 0.15) -> soft clip
                                             // WaveShaper (linear to 0.9, tanh knee to 1.0, oversample '2x')
                                             // -> master volume gain
  readonly cueOut: AudioNode                 // headphones: cue bus*(1-mix) + master*mix -> cue volume gain
  readonly masterMeter: Meter, readonly cueMeter: Meter
  setCrossfader(x), setCrossfaderCurve(curve)
  setMasterVolume(v), setCueVolume(v), setCueMix(v)
  dispose()
}
export class Meter {                         // AnalyserNode wrapper (fftSize 512, Float32 time domain)
  constructor(ctx, sourceNode)
  read(): { peak: number, rms: number }      // linear 0..1+, call once per animation frame
}
```

### 2.7 `engine.js`

```js
export class AudioEngine extends Emitter {
  constructor({ settings })
  start(): Promise<void>       // MUST be called from a click. Synchronously: navigator.audioSession.type =
                               // 'playback' when available, new AudioContext({ latencyHint: 'interactive' }) (never
                               // pass sampleRate), ctx.resume(). Then async: create DeckPlayers (worklet or
                               // fallback), Mixer, OutputRouter; apply settings (master/cue volume, cue mix, xfade
                               // curve, output mode); emit 'ready'. Idempotent (returns the same promise).
  restart(): Promise<void>     // from a click: close the old context and rebuild everything (the iOS "audio
                               // died" escape hatch); emits 'restarted' so decks re-load their tracks from the
                               // kept File/Blob (or demo id) and restore position, cue, loop, tempo, mixer state
  readonly ready: boolean
  readonly ctx: AudioContext | null
  readonly mixer: Mixer | null
  readonly outputs: OutputRouter | null
  readonly players: DeckPlayer[]   // [A, B] once ready
  readonly usingWorklet: boolean
  readonly state: 'idle' | 'starting' | 'running' | 'suspended' | 'interrupted' | 'closed'
  resume(): Promise<void>      // call from a click when state is suspended/interrupted
  decode(arrayBuffer): Promise<AudioBuffer>   // promise or callback form; one decode at a time (queue)
  diagnostics(): object        // sampleRate, baseLatency, outputLatency, usingWorklet, secure, state ...
  // events: 'ready', 'restarted', 'statechange'(state), 'error'(message)
}
```
The engine listens to `visibilitychange` and `ctx.onstatechange`; when the context is suspended or
interrupted while the user expects sound it emits `'statechange'` so the UI shows a "Tap to resume audio"
banner (with a "Restart audio" fallback button, since iOS state reporting is unreliable). It keeps a **screen
wake lock** while `settings.keepAwake` is on and the page is visible (request in the start click and on every
play, re-acquire on `visibilitychange`), tolerating rejection.

### 2.8 `outputs.js` + `routing-plan.js` - output routing (section 7)

### 2.9 Track loading helpers: `decode.js`, `tags.js`, `demo-synth.js`, `pcm.js`

```js
// decode.js
export const ACCEPT = '.mp3,.m4a,.aac,.mp4,.wav,.wave,.aif,.aiff,.flac,.ogg,.oga,.opus,.webm,.caf,audio/*';
export async function decodeFile(fileOrBlob, engine, nameHint): Promise<{ buffer: AudioBuffer, meta: TrackMeta }>
//   reads arrayBuffer(), parses tags from a COPY of the first 512 KB (decodeAudioData detaches its input),
//   decodes with engine.decode(); friendly error text on failure (name the format when known). Warn (emit, do
//   not refuse) above 15 min on phones (memory).
// pcm.js (main thread, time-sliced: work ~8 ms, then yield via MessageChannel; no nested setTimeout chains)
export async function preparePcm(audioBuffer, { targetRate = 11025 } = {}):
//   Promise<{ channels: Int16Array[] (clamped to [-1,1) before scaling), mono: Float32Array (decimated by
//   D = max(1, round(sr / targetRate)), mean of D frames of (L+R)/2), monoRate: sr / D }>
// tags.js (pure)
export function readTags(arrayBuffer, fileName): TrackMeta   // { title, artist } from ID3v2.2/2.3/2.4
//   (TIT2/TT2, TPE1/TP1, UTF-16 and ISO-8859-1), MP4 'ilst' (©nam/©ART), FLAC/OGG Vorbis comments; falls back to
//   the file name ("Artist - Title.mp3" -> split on ' - ', strip extension, underscores to spaces).
// demo-synth.js (pure, deterministic)
export const DEMO_TRACKS = [ { id: 0, title: 'Neon Drift', artist: 'TwinSpin demo', bpm: 124 },
                             { id: 1, title: 'Spore Garden', artist: 'TwinSpin demo', bpm: 128 } ];
export function synthDemo(id, sampleRate, seconds = 96): { channels: [Float32Array, Float32Array], sampleRate }
//   real-sounding house grooves: kick (pitch-swept sine + click), off-beat open hat (filtered noise), clap on 2
//   and 4, bassline, chord stabs; 8-bar drums-only intro and outro for mixing; first kick exactly at 0.0 s;
//   peak-normalised to -1 dBFS. Must render 96 s at 48 kHz in < 1.5 s on a mid phone (precomputed one-shots
//   copied into place, one-pole filters, no per-sample Math.sin where a phasor works).
```
`TrackMeta = { title: string, artist: string, fileName: string }`.

## 3. Analysis (`src/analysis/`)

Algorithm: follow `docs/research/research-bpm.md` stages 1-6 and the prototype in `docs/research/proto/
analyzer.js`, WITH the verified fix from `verify-bpm.md` extra finding 1: evaluate the top 3-4 tempo candidates
(folded into range) through the fine-tempo, phase and fold stages and keep the one with the best
`foldContrast * coverage` (the raw comb score alone picks 2/3-tempo on house with off-beat stabs).

```js
// bpm.js (pure)
export function detectBeats(mono, sampleRate, opts = {}): BeatInfo
//   mono: decimated (~11-12 kHz) Float32Array. BeatInfo = { bpm: number|null, firstBeat: number (s, first grid
//   beat >= 0), confidence: 0..1, variable: boolean, alternatives: number[] (bpm/2, bpm*2, bpm*2/3, bpm*3/2 and
//   the other strong candidates) }. opts.minBpm = 78, opts.maxBpm = 180 (fold range, see the octave stage).
//   Exact to +-0.01 BPM on steady synthetic material, octave right for house/techno/DnB/hip-hop, null + conf 0
//   for noise or drumless audio.
// waveform.js (pure)
export function buildWaveform(mono, sampleRate, { detailRate = 150, overviewBins = 1000 } = {}): Waveform
//   Waveform = { detail: { rate, peak, low, high }, overview: { bins, peak, low, high } }
//   peak: Float32Array max |x| per bin (normalised so the track max is 1); low/high: Float32Array 0..1 share of
//   energy below ~200 Hz / above ~2.5 kHz per bin (simple IIR splits).
// loudness.js (pure)
export function measureLoudness(mono, sampleRate): { rmsDb, peakDb, gainDb }
//   gainDb brings the loud parts (90th percentile of 400 ms RMS windows) to -13 dBFS RMS, capped so
//   peakDb + gainDb <= +2 dB, clamped -12..+6 (docs/AUTOMIX.md 2.3).
// analyzer.js (main thread)
export async function analyzeTrack(mono, sampleRate, { onWaveform } = {}):
//   Promise<{ beats: BeatInfo, waveform: Waveform, loudness }>. Runs analyze-worker.js as a module worker
//   (transfers mono), one job at a time; the waveform is reported first through onWaveform. Falls back to the
//   main thread (time-sliced between stages) when workers fail (sandboxed preview).
// analyze-worker.js: message {id, mono, sampleRate} -> {id, waveform} then {id, result} | {id, error}
```

## 4. Deck controller (`src/deck/deck.js`)

UI-agnostic state machine for one deck. UI reads getters every animation frame and listens to `'change'`.

```js
export class Deck extends Emitter {
  constructor(id /* 'A'|'B' */, engine, settings)
  readonly id, index (0|1)
  readonly ready: boolean                    // engine ready and attached
  readonly track: Track | null
  readonly loading: boolean                  // decoding / preparing PCM
  readonly analyzing: boolean                // BPM/waveform running
  readonly playing: boolean
  readonly position: number                  // live (player.getPosition())
  readonly duration: number
  readonly audible: boolean                  // playing and (volume * xfade gain) > -40 dB (needle lock)
  readonly tempo: number                     // fader -1..1
  readonly tempoRange: number                // 0.08 | 0.16 | 0.5
  readonly rate: number                      // final rate incl. sync (no bend)
  readonly bpm: number | null                // track bpm (user can x2 / /2 / tap)
  readonly effectiveBpm: number | null       // bpm * rate
  readonly beatLength: number | null         // seconds of track time per beat (60 / bpm)
  readonly cuePoint: number
  readonly loop: { active, beats, start, end }
  readonly synced: boolean                   // managed by SyncController
  readonly scratching: boolean
  readonly vinyl: boolean
  readonly fx: { echo, reverb, flanger, crush, amount }
  readonly mix: { volume, eq: { low, mid, high }, filter, trimDb, cue }
  // loading (any source; the deck keeps the File/Blob or demo id for engine.restart())
  loadFile(fileOrBlob, meta?): Promise<void>
  loadDemo(id): Promise<void>
  eject()
  // transport
  togglePlay(), play(), pause()
  cueDown(), cueUp()                         // CDJ semantics, see 4.1
  seek(sec), seekFraction(f)
  brake()                                    // one-shot vinyl stop over 1 beat (FX page)
  echoOut()                                  // one-shot echo out (FxRack.echoOut), then pause
  // tempo
  setTempo(v)                                // user tempo move: emits 'tempoTouched' (SyncController drops sync)
  resetTempo()
  setTempoRange(r)
  applySyncRate(rate)                        // SyncController: sets rate, moves tempo value (widening the range to
                                             // 0.16 / 0.5 when needed), no 'tempoTouched'
  setBend(v, source = 'user')                // temporary nudge; source 'sync' for phase correction
  // platter
  scratchBegin(), scratchMove(deltaSec, vel), scratchEnd()   // deltaSec relative to the position at
                                             // scratchBegin (accumulated by the UI from finger rotation)
  setVinyl(on)
  // loops (need a bpm; quantised to the grid when settings.quantize)
  toggleLoop(beats)                          // 1 | 2 | 4 | 8; same size again = exit
  loopHalve(), loopDouble(), exitLoop()
  // bpm
  doubleBpm(), halveBpm(), tapTempo()        // tapTempo: 4+ taps (gaps < 2 s) -> linear regression gives bpm and
                                             // grid anchor
  beatPhase(pos = this.position): number|null    // 0..1 position inside the current beat
  // fx + mixer channel (state kept here for the UI; forwards to engine.mixer.channels[index] / player)
  setFx(name, on), setFxAmount(v)            // crush -> player.setCrush(on ? amount : 0)
  setVolume(v), setEq(band, v), setFilter(v), setTrimDb(db), setCue(on)
  // events: 'change'(what) with what in 'track'|'loading'|'analysis'|'transport'|'tempo'|'cue'|'loop'|
  //   'sync'|'fx'|'mix'|'bpm'|'vinyl', plus 'error'(message), 'ended', 'tempoTouched'
}
```
`Track = { id, title, artist, fileName, source: 'file'|'demo', duration, sampleRate, bpm, bpmDetected,
firstBeat, confidence, variable, alternatives, waveform, gainDb, hue, libraryId? }`.

Loading flow: `loading=true` -> `decodeFile` -> `preparePcm` -> `player.load(channels)` -> `track` set (bpm null),
`'change','track'` -> `analyzeTrack(mono)` -> waveform (`'analysis'`) -> beats + loudness (`'analysis'`,
`'bpm'`), trim set to `gainDb`, cue point = first beat. The AudioBuffer is dropped right after `preparePcm`.
The deck is playable as soon as `track` is set. Loading resets: tempo stays, loop off, fx kept, sync dropped.
If `settings.autoSync` is on, the deck was stopped and the other deck is playing with a bpm, sync turns on
when the bpm arrives.

### 4.1 `cue-logic.js` (pure, tested) - CDJ cue semantics

* Playing + CUE down: jump to the cue point and pause.
* Paused, not at the cue point + CUE down: set the cue point here (snapped to the nearest beat when quantize
  is on and a grid exists); no playback.
* Paused at the cue point + CUE down: play while held (preview); CUE up returns to the cue point and pauses,
  unless PLAY was pressed while holding (then keep playing).
* PLAY at the end of the track: start again from the cue point.
Export `cueReducer(state, event) -> { state, actions[] }`; events `'cueDown'|'cueUp'|'play'|'pause'` carry the
current position; actions are `{type:'seek'|'play'|'pause'|'setCue', ...}`; `Deck` executes them.

### 4.2 `src/library/library.js` - songs page storage

```js
export class Library extends Emitter {       // IndexedDB 'twinspin' store of the user's songs (original File
  constructor()                              // blobs + metadata); in-memory only when IndexedDB is blocked
  init(): Promise<void>
  readonly persistent: boolean
  list(): Array<{ id, title, artist, fileName, size, duration?, bpm?, addedAt }>
  add(files: File[]): Promise<entries>       // dedupe by name+size+lastModified; reads tags for title/artist
  getBlob(id): Promise<Blob>
  update(id, patch)                          // e.g. store bpm/duration/firstBeat after analysis or user x2
  remove(id), clear()
  usage(): Promise<{ usedBytes, quotaBytes }>
  // events: 'change'
}
```
Ask `navigator.storage.persist()` after the first add (try/catch). Cap at 60 songs; oldest-unused go first.
Demo tracks are listed too (not stored).

## 5. Sync (`src/deck/sync-math.js` pure, `src/deck/sync.js`)

```js
// sync-math.js
export function matchTempo(slaveBpm, leaderEffectiveBpm): { rate, multiplier }
//   multiplier in {0.5, 1, 2} chosen so rate = leaderEff*multiplier/slaveBpm is closest to 1 (log distance)
export function beatsAt(pos, bpm, firstBeat): number          // (pos - firstBeat) / (60/bpm)
export function phaseError(slave, leader, multiplier): number  // beats, in [-0.5, 0.5): target frac of
//   slave beats = frac(leaderBeats * multiplier); slave/leader = { pos, bpm, firstBeat }
export function alignOffset(slave, leader, multiplier): number // seconds of SLAVE track time to add to the slave
//   position so its beat phase matches (|offset| <= half a slave beat)
export function correctionBend(errorBeats, kp = 0.25, max = 0.015): number
// sync.js
export class SyncController extends Emitter {
  constructor(decks, settings)
  toggle(index), setSync(index, on), isSynced(index), leaderOf(index)
  resetTempo(index)                          // SYNC long-press: tempo back to 0 % (drops sync)
  // events: 'change', 'error'(message)
}
```
Rules:
* SYNC on deck i makes the other deck the leader. Needs bpm on both, else `emit('error', 'Deck B has no
  tempo yet. Wait for the BPM or tap it in.')`. If the leader is itself synced to deck i, the leader's sync is
  switched off first.
* On enable: `applySyncRate(matchTempo(...).rate)`; if both decks are playing, `seek(position +
  alignOffset)` (declicked). If the slave is paused, align at the moment it starts playing.
* While synced (timer, every 30 ms; skipped while the tab is hidden): follow the leader's effective BPM; when
  both play, neither is scratching and no seek/loop wrap happened in the last 150 ms, apply
  `setBend(correctionBend(err), 'sync')`. If |err| > 0.2 beat for 0.5 s, hard re-align with a declicked seek.
  Tracks flagged `variable` get tempo sync only (no phase lock).
* User tempo move on the slave (`'tempoTouched'`) switches its sync off. Loading a track switches it off.

## 6. UI (`src/ui/`, `css/`, `index.html`)

### 6.1 Visual identity (single, deliberate dark booth theme)

```css
:root {
  /* Phone portrait: deck A | deck B columns under stacked waveforms, crossfader + tabs at the bottom */
  --bg: #0b0c12;  --panel: #14151d;  --raised: #1d1f2a;  --line: #2b2e3c;
  --text: #f1f2f8;  --dim: #a9aec0;  --faint: #7c8296;
  --deck-a: #3da5ff;  --deck-b: #ff8a2a;   /* blue / orange: safe for red-green colour blindness; always with letters */
  --play: #5be38a;  --cue: #ffd447;  --warn: #ff4d5e;  --focus: #ffe36e;
  --font-display: 'Unbounded', 'Arial Black', system-ui, sans-serif;     /* logo, deck letters, big BPM */
  --font-ui: 'Barlow Condensed', 'Roboto Condensed', 'Arial Narrow', system-ui, sans-serif;  /* labels, buttons */
  --font-body: 'Barlow', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;  /* sheets, help */
  --radius: 12px;  --tap: 48px;  --tap-primary: 56px;
}
```
Fonts load from Google Fonts with `display=swap`. Numbers use `font-variant-numeric: tabular-nums`. Labels are
11-12 px uppercase with 0.06-0.08 em letter-spacing, never below 11 px. The CD platters have an iridescent
(rainbow conic gradient that rotates with the disc) data side: the one psychedelic flourish; everything else
stays calm and legible. An "Outdoor contrast" setting switches to pure black/white with thicker strokes.
Respect `prefers-reduced-motion` (no ambient shimmer; platters still rotate because rotation is information).

### 6.2 Layouts (JS sets `data-layout` on `<html>` from the visual viewport; CSS does the rest)

See `docs/research/research-ux.md` (LAYOUT SELECTION, PHONE PORTRAIT, PHONE LANDSCAPE, TABLET, DESKTOP) for
pixel budgets; they are part of this contract. Summary:
* `pp` phone portrait (width < 600, height >= width), the primary target, must fit 360 x 560 CSS px without
  scrolling: (1) header 44 px: deck A chip | menu button | deck B chip (title, BPM, time); (2) waveform block:
  A overview, A zoomed, B zoomed, B overview, zoomed lanes touching with one shared centre playhead; (3) page
  area (1fr) showing one page: DECKS (per column: platter, transport row CUE/PLAY/SYNC, tempo row
  [nudge-][tempo drag field showing % and BPM][nudge+]), MIX (two channel strips: PFL headphone toggle, FILTER,
  HI, MID, LOW as bar sliders, volume fader; centre master volume), FX (deck A|B target switch, 2x2 FX pads,
  amount slider, loop pads 1/2/4/8, ECHO OUT and BRAKE one-shots), SONGS (add music, library list with A/B load
  buttons, demo tracks); (4) crossfader row; (5) bottom tab bar DECKS / MIX / FX / SONGS.
* `pl` phone landscape (width > height, height < 500): [deck A column][centre][deck B column]; centre has the
  waveforms, compact mixer and crossfader; FX and SONGS open as a sheet over the centre column only.
* `tp` tablet portrait and `console` (tablet landscape / desktop, width > height and height >= 500): everything
  visible as in the research pixel budgets; max-width 1360 px centred on desktop.
Touch targets >= 44 px (48 preferred), PLAY >= 56 px. Controls never change size while used. No drag-start zone
within 16 px of the left/right screen edge (OS back gesture). `#app` is `position: fixed; inset: 0` with
`touch-action: none` (except the SONGS list: `pan-y`), safe-area padding, solid `--bg` background, html/body
`overflow: hidden; overscroll-behavior: none`.

### 6.3 Widgets (`src/ui/widgets/`) - owned by the widgets agent

```js
// controls.js
export class Fader {        // vertical or horizontal slider, RELATIVE drag (grab anywhere, no jump), long-press
                            // 450 ms without moving = fine mode x0.25, double-tap resets, value bubble while
                            // dragging, centre detent with a haptic tick, arrow keys/wheel on desktop,
                            // role=slider + aria values, pointer capture, pointercancel = pointerup
  constructor(container, { orientation = 'vertical', min = 0, max = 1, value = 0, defaultValue = value,
                           detent = null, label = '', format = (v) => v.toFixed(2), onInput = (v) => {},
                           onRelease, className, travel /* px for full range, default = track length */ })
  set(v, { silent = true } = {}), get value, setDisabled(b), destroy()
  readonly el
}
export class Knob {         // rotary on tablet/desktop, drawn as a compact BAR SLIDER when opts.bar (phones);
                            // vertical drag (dx - dy) 180 px = full range, double-tap reset, bipolar arc from
                            // centre, 'KILL' state at min when kill: true, centre dead-zone snap when deadZone
  constructor(container, { min = -1, max = 1, value = 0, defaultValue = 0, bipolar = true, kill = false,
                           deadZone = 0, bar = false, label = '', size = 56, format, onInput, className })
  set(v, opts), get value, setDisabled(b), destroy(), readonly el
}
export function bindPress(el, { onPress, onRelease, onTap, onHold, onActivate, holdMs = 450 }) // onPress fires
                            // on pointerdown (timing-critical), onActivate on click (user activation),
                            // haptic tick, no ghost clicks, no long-press menu; returns unbind
export class MeterView { constructor(container, { orientation = 'vertical', segments = 12 }); set(peak) }
export class TempoField {   // horizontal drag field: shows tempo % and effective BPM, relative drag (300 px =
                            // full range), double-tap = reset; flanked by nudge -/+ buttons (hold = bend
                            // -/+4 %, release = 0)
  constructor(container, { deck })  render()  destroy()
}
// platter.js
export class PlatterView {  // canvas CD/jog wheel: iridescent data side rotating with the track, label with deck
                            // letter and track hue, 12 o'clock marker, progress arc (red blink in the last 30 s),
                            // loading/analysing ring, empty state "+ LOAD" (tap -> onEmptyTap, needs click),
                            // touch glow in deck colour. Touch: whole disc = scratch when vinyl, bend when not;
                            // separate outer nudge ring only when the platter is >= 200 px.
  constructor(canvas, { deckId, onScratchBegin, onScratchMove(deltaSec, vel), onScratchEnd,
                        onBend(v) /* -0.12..0.12, 0 on release */, onEmptyTap })
  render(state)             // { position, duration, playing, loading, analyzing, hue, vinyl, warn, synced,
                            //   scratching, loaded }
  resize()
}
// Platter mapping: angle = position / 1.8 * 2PI. Scratch deltaSec = unwrapped finger angle / 2PI * 1.8 (use
// getCoalescedEvents when present). While touched, draw from the finger angle (zero latency). Bend =
// clamp(angular speed / (2PI/1.8) * 0.06, -0.12, 0.12), decaying to 0 within 150 ms after release.
// waveview.js
export class WaveView {     // stacked scrolling waveforms for both decks with ONE shared px-per-second, shared
                            // centre playhead, deck A ticks rising from its bottom edge, deck B ticks hanging from
                            // its top edge (bar lines full height 2 px, beat lines 40 % 1 px), loop region, 3-band
                            // colouring within the deck hue (low saturated, mid tint, high near-white), pre-rendered
                            // to offscreen canvases; seconds visible = 6 (phone) / 8 (tablet) / 10 (desktop) *
                            // settings.waveZoom; two-finger pinch or +/- changes zoom; dragging a lane scrubs (and
                            // sets cue) only when that deck is paused, nudges when it plays
  constructor(canvas, { decks, settings })
  render(), resize()
}
export class OverviewView { // whole-track strip: played part dimmed, cue triangle, loop region, playhead; needle
                            // lock: tap seeks when the deck is paused or inaudible, else needs a 350 ms hold with a
                            // progress ring
  constructor(canvas, { deck })
  render(), resize()
}
```
All canvases handle devicePixelRatio and resize via ResizeObserver. Rendering runs in one shared
`requestAnimationFrame` loop owned by AppUI (widgets expose `render()`, they never start their own loops).

### 6.4 App UI (`src/ui/*.js`, `src/ui/sheets/*.js`) - owned by the layout agent

`app-ui.js` exports `class AppUI { constructor({ root, engine, decks, sync, settings, library }) }`. It builds the
DOM, creates widgets, binds them to `Deck`/`Mixer` APIs, runs the rAF loop, sets `data-layout`, shows toasts
for `'error'` events, the start overlay, the resume banner, coach marks and sheets:
* **Start overlay**: app name, one line ("Two decks in your pocket. Load songs, sync, mix."), big "Tap to start"
  button (click). Shows "Try the demo tracks" as a secondary action that also starts audio.
* **Songs** (page or sheet): "+ Add music" (`<label>` wrapping `<input type=file multiple accept=ACCEPT>`), list
  of library songs (title, artist, BPM when known, duration) each with large [A] [B] load buttons, demo tracks,
  remove per song, storage use. Tapping an EMPTY platter opens the picker for that deck directly. Desktop: drag
  and drop files onto a deck. Load lock: loading onto a deck that is playing and audible shows an in-page
  confirm ("Deck A is playing. Replace the song?").
* **Outputs sheet** (top-bar/menu chip shows the routing, e.g. "Phone speaker" or "Speaker + Headphones"):
  section 7, built by the layout agent from the `OutputRouter` API; the remote section is
  `mountRemotePanel(container, { router, settings })` from the routing agent.
* **Settings sheet**: tempo range, crossfader curve, quantize, vinyl mode, auto sync, keep screen awake,
  haptics, waveform zoom, outdoor contrast, restart audio, about/build + diagnostics (engine.diagnostics()).
* **Help sheet**: gestures and controls in plain words, how outputs work on this device, keyboard shortcuts.
* **Coach marks** (first run, `tipsSeen`): "Tap a record to load a song" -> "Press PLAY" -> "Load deck B,
  press SYNC, slide the crossfader".
Keyboard (desktop): Deck A Q play, W cue, E sync; Deck B P play, O cue, I sync; arrow left/right crossfader;
1-4 / 7-0 loops. Never steal keys while a text field has focus. Label PFL buttons with a headphone icon, never
"CUE".

## 7. Output routing (`src/audio/outputs.js`, `src/audio/routing-plan.js`, `src/remote/`)

Facts (see `docs/research/research-routing.md` + `verify-routing.md`): a web page on a PHONE gets exactly one
audio output (Android and iOS). Two local outputs work only on desktop browsers (Chrome/Edge/Firefox/Safari
macOS 18.4+) and desktop-form-factor Android, via `HTMLMediaElement.setSinkId`. iOS exposes setSinkId but it is
session-wide: never use it on iOS/iPadOS.

Modes (`settings.outputMode`):
1. `single` - masterOut -> ctx.destination. PFL buttons still light and drive the cue meter; a hint says
   "Headphone pre-listen needs a second output. Open Outputs."
2. `dual` (desktop only) - masterOut -> device X, cueOut -> device Y. Cue: MediaStreamAudioDestinationNode ->
   hidden `<audio>` -> `setSinkId(Y)` -> `play()`. Master: `ctx.setSinkId(X)` when available (Chrome/Edge),
   else if X is not the default device, also through its own MediaStreamDestination -> `<audio>.setSinkId(X)`
   (Firefox, Safari macOS), else ctx.destination. Never connect the cue to ctx.destination in this mode. A
   signed "Output alignment" slider (-300..+300 ms) delays whichever path is faster (DelayNode max 0.35 s).
   Device unlock button (desktop only, explained first): Firefox -> `selectAudioOutput()` per role; others ->
   `getUserMedia({audio:true})` then stop all tracks immediately, then `enumerateDevices()`. Safari needs this
   again after every page load; Chrome remembers. Dedupe by groupId, hide 'communications', flag
   "Hands-Free"/"Headset" endpoints. Watch `devicechange`: a vanished device -> fall back to `single` + error.
3. `split` - one output, mono master on one side and mono cue on the other (`splitSwap`), for a wired
   Y-splitter cable. Warn: "Turn off Mono audio and Dolby/spatial effects on the phone."
4. `remote` - this device plays one bus, a second device plays the other over WebRTC (`remoteBus`, default
   'cue'). Not available in the preview build or without WebRTC.

```js
// routing-plan.js (pure, tested)
export function availableModes(env, { topLevel = true } = {}):
//   { single: {ok:true}, dual: {ok, reason}, split: {ok:true, note}, remote: {ok, reason} }  reasons are
//   user-facing sentences (e.g. "Phones can only play to one output at a time.")
export function deviceLabelHint(label): string|null   // e.g. warns for "Hands-Free"/"Headset" BT endpoints
export function dedupeOutputs(devices): Array<{ deviceId, label, groupId }>
// outputs.js
export class OutputRouter extends Emitter {
  constructor(ctx, mixer, settings)
  readonly modes                             // availableModes(env)
  readonly mode
  setMode(mode): Promise<void>               // rewires; on failure falls back to 'single' and emits 'error'
  hasDeviceAccess(): boolean
  requestDeviceAccess(role /* 'master'|'cue' */): Promise<boolean>   // call from a click
  listOutputs(): Promise<Array<{ deviceId, label, hint }>>
  setMasterDevice(id), setCueDevice(id): Promise<void>               // call from a click (Safari)
  setAlignmentMs(ms)
  setSplitSwap(on)
  test(which /* 'master'|'cue' */): Promise<void>   // distinct beep pattern on that output
  getRemoteStream(): MediaStream             // stereo MediaStreamDestination fed by master and cue via gains
  setRemoteBus(which /* 'cue'|'master' */)   // gain switch, no renegotiation; local plays the other bus
  describe(): string                         // chip text: 'Phone speaker', 'Speaker + Headphones', 'Split cable',
                                             // 'Second device'
  // events: 'change', 'error'(message)
}
```
Remote (`src/remote/`, see `docs/research/research-webrtc.md` + `verify-webrtc.md`; the verify corrections win):
* `peer.js`: lazy PeerJS 1.5.5 loader (jsDelivr, then cdnjs, then unpkg; SRI
  `sha384-x0YgkOr/3UOZP2CRDxGW9e0Q+2Qjyr3uJrm4xU32Y7ZCNAo7Cc7bjhrZMi/dwczu`, crossorigin anonymous, 12 s timeout
  each); ids `'twinspin-v1-' + CODE` (4 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`); ICE: Google STUN only by
  default (the old public TURN servers are dead), `config.iceServers` overrides.
* `sdp.js` (pure, tested): `addOpusStereo(sdp)` adds `stereo=1` to the Opus fmtp line (receiver's local answer).
* `remote-host.js`: `class RemoteHost extends Emitter { start(stream), stop(), newCode(), kick() , code,
  listener, state }`. The host is the caller (`peer.call(listenerId, stream)` after the listener's DataConnection
  opens), accepts ONE listener (others get a polite 'busy'), raises the send bitrate with
  `sender.setParameters` (modify `encodings[0].maxBitrate = 192000` in place, never add encodings), reconnects
  signalling on 'disconnected' (live calls survive), re-calls on `{t:'recall'}`.
* `receiver.js`: the second-device page, booted by `src/main.js` when the URL has `?listen=CODE` or
  `#listen=CODE`: minimal UI (css/remote.css). API: `export function bootReceiver(root, { code })` - main.js calls it instead of booting the DJ app: code field, giant "Tap to listen" button whose click handler
  synchronously calls `audio.play()` on an `<audio playsinline>` element, sets `audioSession.type='playback'` and
  requests a wake lock, then loads PeerJS, connects, answers receive-only with the stereo munge (fallback to a
  plain answer + recall on a 'webrtc' error); status, estimated delay from getStats, level from `audioLevel`,
  "Keep this screen on" note. No Web Audio on the receiver.
* `remote-panel.js`: `mountRemotePanel(container, { router, settings })` for the Outputs sheet: start/stop,
  big code + QR (`qrcode-generator@1.4.4` UMD from jsDelivr, lazily; show the link text too), "This phone plays:
  Speaker / Headphones" switch, listener status, new code / disconnect, plain notes ("Both devices on the same
  Wi-Fi or a phone hotspot. Guest Wi-Fi may block it. The second device runs about half a second late.").

## 8. PWA and files

`index.html` links `css/app.css`, `css/widgets.css` and `css/remote.css`. `index.html` (shell: viewport `width=device-width, initial-scale=1, viewport-fit=cover`, theme-color, apple
meta, fonts, `config.js`, `css/app.css`, `src/main.js` as module), `manifest.webmanifest` (`id`/`start_url`/
`scope` `./`, display `standalone`, orientation `any`, dark colours, icons 192/512 + maskable 512),
`sw.js` (VERSION string replaced at publish time; app-shell precache with `cache: 'reload'`; network-first for
navigations/JS/CSS with a 3 s timeout, cache-first for icons/fonts; ignores non-GET and cross-origin except
Google Fonts; no automatic skipWaiting: the page shows "Update ready" and posts 'skipWaiting' on tap).
Registered only when `env.serviceWorker`, not on localhost and not with `?nosw` (unregister there), in
try/catch. Icons in `icons/` (SVG + PNG 192, 512, maskable 512, apple-touch 180 opaque). All URLs relative.

## 9. Tooling (`tools/`)

`serve.ps1` (localhost static server, port 8100, MIME types incl. `.js`, `.webmanifest`, `.woff2`, `.wav`,
`.mp3`, `.m4a`, `.flac`, `.ogg`; `Cache-Control: no-store`), `phone-link.ps1` + `phone-link.cmd` (serve + Cloudflare
quick tunnel `cloudflared tunnel --no-autoupdate --url http://localhost:8100 --http-host-header localhost:8100`
for an HTTPS link on the phone; uses `tools/cloudflared/cloudflared.exe` (gitignored), else `cloudflared` on the
PATH or in the winget folder, else explains `winget install Cloudflare.cloudflared`),
`publish-web.ps1` (copy the app into `site/`, stamp the SW version, run JsCheck, optional `-Zip` and `-Repo`
GitHub Pages push, modelled on an earlier project's publish script), `make-icons.ps1` (PNG icons via
System.Drawing), `JsCheck/` (test runner, present).

## 10. Definition of done (every agent)

* `tools/JsCheck/jscheck check src tests` -> 0 errors, 0 warnings for your files.
* Your tests pass: `tools/JsCheck/jscheck test tests` (or run your files one by one).
* Public API exactly as in this contract (or adapter + `docs/CHANGES.md`).
* Final message: list files written, test results, deviations, and anything the integrator must wire.

## 11. File ownership

| Agent | Files |
|---|---|
| lead | `src/core/*`, `config.js`, `docs/CONTRACT.md` |
| engine | `src/audio/{deck-dsp,deck-worklet-src,deck-processor,deck-player,curves,effects,mixer,engine}.js`, `tests/{deck-dsp,curves}.test.js` |
| analysis | `src/analysis/*`, `tests/{bpm,waveform,loudness}.test.js` |
| deck | `src/deck/*`, `src/library/*`, `src/audio/{decode,pcm,tags,demo-synth}.js`, `tests/{cue-logic,sync-math,sync,tags,demo-synth,deck}.test.js` |
| widgets | `src/ui/widgets/*`, `css/widgets.css`, `tests/widgets-*.test.js` (pure math only) |
| layout | `index.html`, `css/app.css`, `src/main.js`, `src/ui/*.js` (not `widgets/`), `src/ui/sheets/*` |
| routing | `src/audio/{outputs,routing-plan}.js`, `src/remote/*`, `css/remote.css`, `tests/{routing-plan,sdp}.test.js` |
| pwa | `manifest.webmanifest`, `sw.js`, `icons/*`, `tools/{serve,phone-link,publish-web,make-icons}.ps1`, `tools/phone-link.cmd`, `README.md` |
