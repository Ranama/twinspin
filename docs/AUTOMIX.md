# TwinSpin contract addendum: Set list + Auto Mix (v3)

This addendum extends `docs/CONTRACT.md` (still binding, together with `docs/CHANGES.md`). It adds a set list
and an Auto Mix mode, and fixes the bugs found in the first browser test. File ownership for this round is in
section 7.

## 0. What the user asked for

> "A list of songs that will keep on playing like a list of songs, then there is an 'auto mix' toggle button,
> that will sync the beats of the next song (and could also change speed of current song if needed), then it
> seamlessly mixes from one to the next one, and then it slowly changes the speed of the next song to its
> original pace. I can create a list of songs, and it will automatically mix between each one to the next one
> until all the songs have been played, like a real DJ."

So: a **set list** (ordered queue of songs from the library and the demo tracks) and an **AUTO MIX** switch.
With Auto Mix ON the app plays the whole set list by itself with DJ transitions: beat-matched, phrase-aligned,
crossfaded with a bass swap, tempo met in the middle when the songs differ, then the new song eases back to its
own tempo. With Auto Mix OFF the set list is a queue the user loads from by hand (A/B buttons) and the app
behaves as before.

## 1. Settings (already added to `src/core/settings.js` by the lead)

`setList: [{ kind: 'library'|'demo', id }]`, `mixBeats: 32` (16 | 32 | 64), `automixReturn: true`,
`automixBassSwap: true`. Auto Mix ON/OFF itself is NOT persisted (a reload never starts music by itself).

## 2. Analysis changes (`src/analysis/*`)

1. **Beat map.** `BeatInfo` gains `beats: Float64Array | null`: the time (s, track time) of every beat from the
   first grid beat to the end of the track, following tempo drift. For steady tracks it equals the constant grid
   (within 2 ms). Build it from the windowed phase tracking the analyzer already does (Fourier phase per window,
   corrected by the constant fold-vs-Fourier offset, unwrapped, smoothed, interpolated) or an Ellis-style DP
   (tightness ~100) followed by smoothing; your choice, but it must be robust and fast (< 100 ms extra for a
   6 min track in a browser). `firstBeat` stays the first map beat >= 0. Tests: constant synthetic tracks (map
   within 2 ms of the grid), 0.5 % wobble and a 120 -> 124 ramp (every map beat within 10 ms of the true beat),
   drumless intro (map starts at the first real beat region but `firstBeat` stays on the grid extrapolation).
2. **Variable-tempo flag recalibrated on real music.** Real songs are a regression set (your own WAV files in
   `tests/media/`, gitignored; skip these tests with a clear message when the files are missing). Ground truth
   (from a separate, independent beat tracker): `Boss Battle Groove.wav` 148.1 BPM CONSTANT (beat fit
   residual 4 ms), `Bubble Star Parade.wav` drifts 140.1 -> 140.6, `Arcade Rush.wav` ~141.9 drifting,
   `Kaleidoscopic Loop.wav` ~141.1 drifting. Today Boss Battle Groove comes out `variable: true, confidence 0.5`
   which is wrong. Required: Boss -> 148.1 +- 0.05, `variable: false`, confidence >= 0.7; the drifting ones ->
   average BPM within 0.4 of the truth and a beat map that follows them. Write a small WAV (PCM 16/24-bit, float)
   parser for the test (or `src/analysis/wav.js` if useful), decimate to ~11025 Hz mono like `preparePcm`, and
   keep the test under 60 s in Jint (analyse 60-90 s excerpts if needed).
3. **Loudness / auto-gain.** `measureLoudness` target becomes -13 dBFS RMS (90th percentile of 400 ms windows)
   and the boost is capped so `peakDb + gainDb <= +2 dB`; clamp -12..+6 dB. (Today quiet songs get +6.6 dB and
   drive the limiter hard.) Update the tests.

## 3. Engine changes (`src/audio/*`)

1. **Scheduled start**: `DeckDSP` supports starting the motor at an exact output frame:
   `setPlayingAt(frame)` (worklet message `{t:'play', on:true, at: frame}`; `at` absent = now). Pausing or
   seeking cancels a pending start. `DeckPlayer.playAt(ctxTime)` converts context time to frames and keeps its
   optimistic state right (playing becomes true at that time; `getPosition()` stays put before it).
2. **Scheduled seek**: `DeckPlayer.seekAt(pos, ctxTime)` jumps the head to `pos` exactly at `ctxTime`
   (declicked), so sync can line the slave up with where the leader WILL be. DSP message `{t:'seek', pos,
   declick, at: frame}`.
3. **Tempo ramp**: `DeckDSP.setRate(r, rampSec = 0)` ramps the rate linearly over `rampSec` (per sample);
   `DeckPlayer.setRate(r, rampSec = 0)`; `DeckPlayer.rate` getter returns the current (ramping) rate estimate.
   A new `setRate` during a ramp starts a new ramp from the current value.
4. **Scheduled crossfade**: `Mixer.scheduleCrossfade(fromX, toX, startTime, duration)` schedules both channel
   crossfader gains on the audio clock (`setValueCurveAtTime` with an equal-power S-curve sampled at >= 64 points,
   regardless of the user's 'cut' curve), and the `crossfader` getter returns the interpolated value for the
   current `ctx.currentTime` while the schedule runs (the UI reads it every frame). `Mixer.cancelCrossfade()`
   freezes the gains at their current values (and `crossfader` at the current value). `setCrossfader(x)` cancels
   any schedule first. `Mixer.crossfadeScheduled` getter.
5. **Timed EQ**: `ChannelStrip.setEq(band, v, { at, ramp } = {})`: optional context time and ramp length
   (linear ramp of the band gain); without options the existing behaviour.
6. **Sync phase accuracy** (bug): SYNC on two playing demo decks starts ~0.03 beat (15 ms) off and only
   converges through the bend controller over ~5 s. With `seekAt` the SyncController can align exactly. Also
   check `DeckPlayer.getPosition()` right after `seek()` while playing ("new position minus output latency")
   is consistent with how positions are compared between decks, and fix whatever causes the offset.
   Tests for all of the above (DSP at 8 kHz; fake contexts for the player/mixer).

## 4. Deck, sync and Auto Mix (`src/deck/*`)

### 4.1 Deck changes
* `track.beats` (beat map) stored from the analysis; `beatsAt(pos)` (fractional beat index, from the map when
  present, else the grid) and `beatPhase(pos)` use it; `timeOfBeat(beatIndex)` (inverse, extrapolating past the
  ends with the local beat length).
* **Tempo source** (bug): the deck remembers who set its tempo: 'user' | 'sync' | 'auto'. On loading a new song,
  a tempo that was NOT set by the user resets to 0 % (rate 1). Today a sync rate (-12 %) silently carries into
  the next song.
* `rampTempo(rate, seconds)` (Auto Mix: smooth tempo change; tempo source 'auto'; widens the range like
  `applySyncRate`; no 'tempoTouched'), `playAt(ctxTime)`, `seekAt(pos, ctxTime)` pass-throughs, `setEq(band, v,
  opts)` pass-through of the timed EQ (deck state updated at once for the UI).
* Event `'userAction'` (with a name: 'tempo'|'eq'|'volume'|'crossfader'... for deck-level controls the UI calls)
  so Auto Mix can detect a takeover: emit it from the user-facing setters (`setTempo`, `resetTempo`,
  `setEq`/`setVolume`/`setFilter` when not called with `{ source: 'auto' }`, `seek`, `scratchBegin`, `play`,
  `pause`, `cueDown`, loads). Auto Mix itself passes `{ source: 'auto' }` where it calls these.

### 4.2 Sync (`sync-math.js`, `sync.js`)
* Beat-map aware: grid objects become `{ pos, bpm, firstBeat, beats? }` and `beatsAt` interpolates the map.
  Tracks with a beat map get phase lock even when `variable` (the map follows the drift).
* Exact alignment on enable when both play: compute where the leader will be at `t = ctx.currentTime + 0.1 s`
  and `deck.seekAt(slavePosAtT, t)`.

### 4.3 `playlist.js` - the set list (pure model + persistence)

```js
export class Playlist extends Emitter {
  constructor({ settings, library })      // restores settings.setList; titles/bpm/duration from the library
  readonly items: Array<{ uid, kind: 'library'|'demo', id, title, artist, bpm?, duration? }>
  readonly currentIndex: number           // index of the song Auto Mix is playing (-1 = none yet)
  add(entries, { at } = {})               // library entries ({ id, title, ... }) or { kind:'demo', id }; dedupe
                                          // is NOT applied (a song may appear twice on purpose)
  remove(uid), move(uid, toIndex), clear()
  setCurrent(uidOrIndex), peekNext(): item|null, advance(): item|null
  isPlayed(uid): boolean                  // before the current index
  // persists [{kind,id}] to settings.setList on every change; library 'change' refreshes titles and drops
  // items whose library song was removed; events: 'change'
}
```

### 4.4 `automix-plan.js` (pure, thoroughly tested)

```js
export function musicalBounds(waveform, duration, opts): { start, end }
//   first / last time the detail peak envelope (smoothed over ~0.5 s) exceeds -30 dB relative to the track's
//   loud level (95th percentile); skips leading/trailing silence and fade tails.
export function chooseInPoint(track, bounds): number
//   the first beat (map or grid) at or after bounds.start, rounded DOWN to a bar (4 beats from firstBeat) when
//   that bar is still >= bounds.start - 0.1 s; for no-bpm tracks bounds.start.
export function chooseOutPoint(track, mixBeats, bounds): { at, beats }
//   track time where the mix starts so that `beats` (normally mixBeats) end at or before bounds.end, snapped
//   DOWN to a bar, preferring a 16-beat phrase boundary when one is within 8 beats; reduces beats (64 -> 32 ->
//   16 -> 8) for short tracks; never before chooseInPoint + 16 beats. No bpm: { at: bounds.end - 8 s, beats: 0 }.
export function planTempo(curEffBpm, nextBpm, opts): {
//   mode: 'match' | 'meet' | 'cut', multiplier (0.5|1|2 from matchTempo), nextStartRate, curTargetRate,
//   meetBpm, preRampBeats, returnSeconds }
//   |tempo gap| <= 4 %: 'match' (next starts at the current song's tempo, current unchanged).
//   4 %..20 %: 'meet': during the preRampBeats (16) before the mix the current song ramps half way (in log
//   space) toward the next song's BPM; the next song starts at that meet tempo.
//   > 20 % or either bpm unknown: 'cut' (no beat matching: echo-out style quick blend over 8 beats / 6 s, next
//   starts at rate 1).
//   returnSeconds: how long the next song takes afterwards to ease back to rate 1 when automixReturn is on:
//   about 1 % tempo per 8 beats, min 16 beats, max 64 beats, converted to seconds at the meet tempo.
export function crossfadeAt(progress): number      // -1..1 S-curve of the mix (0 -> -1, 1 -> +1), exported for UI
export function planTransition(cur, next, settings): Transition   // ties it together (pure, from track data)
```

### 4.5 `automix.js` - the Auto Mix controller

```js
export class AutoMix extends Emitter {
  constructor({ engine, decks, sync, settings, playlist })
  readonly enabled: boolean
  readonly state: 'off' | 'starting' | 'playing' | 'preparing' | 'mixing' | 'finished'
  readonly currentDeck: 0 | 1 | null
  readonly nextItem: PlaylistItem | null      // what will be mixed in next
  readonly nextReady: boolean                 // loaded + analysed on the other deck
  readonly secondsToMix: number | null        // countdown to the planned mix start (UI)
  readonly progress: number | null            // 0..1 while mixing
  readonly plan: Transition | null            // includes mode ('match'|'meet'|'cut'), beats, tempos
  setEnabled(on), toggle()
  mixNow()                                    // start the transition at the next bar of the current song
  // events: 'change'(what), 'error'(message), 'takeover'(message), 'finished'
}
```
Behaviour:
* **Enable**: empty set list -> `emit('error', 'Add songs to the set list first.')` and stay off. If a deck is
  playing, it becomes the current deck; its song is matched to the set list (or the list just continues from
  its start). Otherwise load the first unplayed item into deck A, cue at its in-point, crossfader fully to A
  (`setCrossfader`), volume 0.8 if it was 0, play. Then preload the next item into the other deck (`loadFile`
  with the library blob or `loadDemo`), cue it at its in-point, EQ flat except low = -1 when bass swap is on,
  tempo per plan.
* **Plan**: whenever the current or next track (or its analysis, the mix length or the current tempo) changes,
  re-plan with `planTransition`. Only from about 30 s before the mix start can the plan freeze.
* **Schedule** (about 2 s ahead of the mix start, on the main thread, all actual changes on the audio clock):
  compute the context time `t0` when the current deck reaches `plan.out.at` (from its position and rate); ramp
  the current deck for 'meet' starting `preRampBeats` earlier (`rampTempo`); set the next deck's rate
  (`applySyncRate`-like, source 'auto') and `seekAt`/`playAt` so its in-point beat lands exactly on the current
  deck's beat at `t0` (beat-map aware, bar aligned); `mixer.scheduleCrossfade(from, to, t0, beats * beatSec)`;
  bass swap at the half way beat over one beat with timed EQ (current low -> -1, next low -> 0). During the mix,
  SyncController keeps the next deck phase locked to the current one (`sync.setSync(next, true)`), except in
  'cut' mode.
* **After the mix**: pause the old deck, reset its EQ low to 0, tempo 0 % ('auto'), sync off; the new deck
  becomes current; if `automixReturn`, `rampTempo(1, plan.tempo.returnSeconds)`; `playlist.advance()`; preload
  the following item into the free deck. At the end of the list let the last song play out, then state
  'finished', emit 'finished', switch off.
* **Takeover**: a user action on a deck/crossfader that Auto Mix is driving DURING a mix (`'userAction'` events,
  or `mixer.setCrossfader` called by the UI) cancels the scheduled automation (`mixer.cancelCrossfade()`, keep
  current values), switches Auto Mix off and emits `'takeover'` ("Auto Mix off. You took over the mix."). Outside
  a mix, user actions on the current deck are fine (the plan updates); loading another song onto the deck Auto
  Mix prepared makes it re-plan with that song. The UI must route its crossfader changes through
  `automix.noteUserCrossfader()` (or the AutoMix listens to a mixer event) so this works.
* Robustness: deck errors while preloading skip that item with a toast; a next song without BPM gets a 'cut'
  transition; a song that ends early (user seeked) triggers the mix immediately; `engine 'restarted'` cancels
  the current mix and re-plans; nothing allocates per frame; timers stop when disabled.

## 5. UI changes (`index.html`, `css/*`, `src/main.js`, `src/ui/**`)

* `src/main.js` / boot: create `Playlist` and `AutoMix` after the decks and sync; expose them on
  `window.twinspin` (`playlist`, `automix`).
* **Songs page** (phone tab, landscape sheet, desktop drawer) gets a **SET LIST** section at the top: a big
  **AUTO MIX** switch with a one-line explanation, mix length (16 / 32 / 64 beats), "Ease back to original
  tempo" and "Bass swap" toggles (or put those two in Settings), the ordered list (now playing / next badges,
  BPM and duration, drag handle to reorder with pointer events on the handle only - the list itself scrolls -,
  remove), "Clear", and an empty state ("Add songs with + on any song below, or tap Add music."). Library and
  demo rows get a **+ (add to set list)** button next to A / B, plus "Add all". Files added with "+ Add music"
  go to the library AND the end of the set list.
* **Auto Mix status on the DECKS page** (all layouts, must fit 360 x 560 without scrolling): while Auto Mix is
  on, show a compact status strip: `AUTO MIX · Next: <title> · mix in 0:42` with a **MIX NOW** button; while
  mixing `Mixing into <title> 45 %`; and an AUTO toggle reachable in one tap from the DECKS page on phones
  (e.g. in the crossfader row or the header). The crossfader thumb follows `mixer.crossfader` every frame (it
  moves by itself during a mix). Toasts for automix 'error' / 'takeover' / 'finished'.
* Overview strips may show the planned mix-out point on the current deck and the in-point on the next deck
  (small markers in the deck colour) when `automix.plan` exists (nice to have).
* Settings: mix length, ease back, bass swap. Help: a short "Auto Mix" section. Keyboard: `M` toggles Auto Mix.
* **Bug fixes** found in the browser test:
  1. Desktop console layout: after the phone SONGS page was active, the songs drawer shows as a half-transparent
     ghost over the decks. The drawer must be fully hidden (or fully shown) in every layout.
  2. FX pad labels (REVERB, FLANGER, CRUSH) overflow their pads at ~800 x 600 (console layout); fit them
     (smaller condensed font, two-line, or wider pads).
  3. The vertical TEMPO fader next to each platter (console layout) shows only its thumb; its track has no
     height. Make it a proper full-height fader, or remove it if the TempoField already covers tempo there.
  4. A deck's platter can keep its "SYNC" badge after sync was switched off (load a new song into a synced
     deck): the platter must reflect `deck.synced` live.

## 6. Tests and definition of done

`tools/JsCheck/jscheck check src tests` clean (0 errors, 0 warnings) and every test file passing. New tests:
`tests/automix-plan.test.js`, `tests/playlist.test.js`, `tests/automix.test.js` (controller with fake decks,
fake mixer and a virtual clock: enable from idle, preload, scheduled mix calls with exact times, meet/match/cut
modes, takeover, end of list), engine tests for playAt/seekAt/setRate ramp/scheduleCrossfade/timed EQ, analysis
tests for beat maps and the real-song regression set, deck tests for tempo source and beat-map helpers, sync
tests for beat-map phase and exact alignment.

## 7. Ownership for this round

| Agent | Files |
|---|---|
| lead | `src/core/*`, `config.js`, `docs/CONTRACT.md`, `docs/AUTOMIX.md` |
| analysis | `src/analysis/*`, `tests/{bpm,waveform,loudness,beatmap,realsongs}.test.js` |
| engine | `src/audio/{deck-dsp,deck-worklet-src,deck-processor,deck-player,curves,effects,mixer,engine}.js`, `tests/{deck-dsp,curves,engine-sched}.test.js` |
| automix | `src/deck/*`, `src/library/*`, `tests/{deck,sync,sync-math,cue-logic,automix-plan,automix,playlist}.test.js` |
| ui | `index.html`, `css/*`, `src/main.js`, `src/ui/**` (widgets included this round), `tests/ui-*.test.js`, `tests/widgets-*.test.js` |
