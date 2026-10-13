# TwinSpin contract addendum: Music player page (v4)

Extends `docs/CONTRACT.md` and `docs/AUTOMIX.md` (both still binding, with `docs/CHANGES.md`). Ownership for this
round is in section 6.

## 0. What the user asked for

> "Make it possible to queue songs, shuffle, etc and make it a small music player app page inside of the DJ app."

A **PLAYER** page: a simple, familiar music-player view (like a phone's music app) on top of the existing set list
and Auto Mix engine. The set list IS the queue. Playing the queue uses Auto Mix to move from song to song, with a
choice of transition: a DJ beat-matched mix (today's Auto Mix), a plain crossfade, or gapless. Everything stays
local; no streaming services in this round.

## 1. Settings (already added to `src/core/settings.js` by the lead)

`transitionStyle: 'dj' | 'crossfade' | 'gapless'` (default 'dj'), `crossfadeSec: 6` (2..12),
`playerShuffle: false`, `playerRepeat: 'off' | 'all' | 'one'`.

## 2. Playlist additions (`src/deck/playlist.js`)

* `addNext(entries)`: insert right after the current song ("Play next"); `add(entries)` stays "Add to queue".
* `setShuffle(on)`: on -> shuffle the UPCOMING items only (after the current one), remembering the order before
  shuffling; off -> restore that order for the items still upcoming (items added meanwhile keep their place at the
  end). Persists via `settings.playerShuffle`; items added while shuffle is on go to a random upcoming position
  (`add`) or right next (`addNext`).
* `previous()`: make the item before the current one current and return it (null at the top).
* `rewind()`: mark everything unplayed and make the first item current (repeat all).
* Keep `advance()` / `peekNext()`; `peekNext({ repeat })` returns the first item when repeat is 'all' and the
  current item is the last one, and the current item itself when repeat is 'one'.
* Shuffle uses a seedable PRNG (`mulberry32` from core/util) so tests are deterministic.

## 3. Auto Mix additions (`src/deck/automix.js`, `src/deck/automix-plan.js`)

* **Transition styles** (from `settings.transitionStyle`, re-planned on change):
  * `'dj'`: today's plan (match / meet / cut).
  * `'crossfade'`: no tempo change, no sync, no bass swap. The next song starts at its musical start (its first
    beat when known) `crossfadeSec` seconds before the current song's musical end, and the crossfade
    (scheduled, equal power) lasts `crossfadeSec`. Both songs play at rate 1.
  * `'gapless'`: the next song starts exactly when the current song reaches its musical end (short 15 ms
    fades, crossfader jumps on the audio clock at that moment).
  `planTransition(cur, next, settings)` takes the style into account; the 'dj' path is unchanged.
* **Repeat**: at the end of the queue, `playerRepeat === 'all'` rewinds the playlist and continues;
  `'one'` repeats the current song (the same song is loaded on the other deck and mixed into itself with the
  chosen style). `'off'` finishes as today.
* **Player transport** (new public methods, all safe to call in any state, no-ops when they make no sense):
  * `pause()` / `resume()`: pause/resume the current deck (and a mix in progress: both decks, with the scheduled
    crossfade frozen and continued) WITHOUT a takeover and without switching Auto Mix off. `paused` getter.
  * `skip()`: go to the next song now: a quick 1.5 s equal-power fade (no beat matching), or, during a mix,
    complete the mix at once.
  * `back()`: if the current song is past 5 s, restart it from its in-point; otherwise go to the previous queue
    item with the same quick fade.
  * `jumpTo(uid)`: play that queue item now with the quick fade; the queue continues after it.
  * `seek(sec)`: seek the current song (disabled during a mix); re-plans.
  * `play()`: when off, enable Auto Mix (start the queue from its current item, or the first unplayed one); when
    paused, resume.
  These do not count as user takeovers (they use `{ source: 'auto' }` on the decks).
* Events: `'change'` with what = 'state' | 'next' | 'plan' | 'transport' | 'progress'.

## 4. Player controller (`src/deck/player.js`, new, UI-agnostic)

```js
export class Player extends Emitter {
  constructor({ automix, playlist, decks, engine, settings, library })
  readonly state: 'stopped' | 'playing' | 'paused' | 'loading' | 'mixing'
  readonly nowPlaying: { item, deckIndex, title, artist, bpm, hue } | null
  readonly position: number, readonly duration: number   // of the current song (live)
  readonly upNext: PlaylistItem[]                          // upcoming items, in play order (after shuffle)
  readonly history: PlaylistItem[]                         // played items, most recent first
  readonly shuffle: boolean, readonly repeat: 'off'|'all'|'one', readonly transition: 'dj'|'crossfade'|'gapless'
  play(), pause(), toggle(), next(), previous(), seek(sec), jumpTo(uid)
  setShuffle(on), cycleRepeat(), setRepeat(mode), setTransition(style), setCrossfadeSec(s)
  playNow(entry), playNext(entry), addToQueue(entry)       // library or demo entries
  // events: 'change'(what)
}
```
`playNow(entry)` inserts the song next and jumps to it. The Player is a thin facade: all audio work stays in
AutoMix. It also drives the **Media Session API** where available (`navigator.mediaSession`): metadata (title,
artist, album 'TwinSpin', artwork = the app icon), `playbackState`, `setPositionState`, and action handlers for
play, pause, previoustrack, nexttrack, seekto (guard every call; no-op in JsCheck).

## 5. UI (`src/ui/**`, `css/*`, `index.html`)

* **PLAYER page** in every layout (phone tab; landscape/desktop sheet or drawer like Songs):
  * now-playing card: large spinning artwork (reuse the platter art or a CSS disc in the track hue, spinning only
    while playing; respects reduced motion), title, artist, BPM and a small "Deck A/B" badge;
  * seek bar with elapsed / remaining time (drag to seek, disabled while mixing with a short hint), a thin
    "mixing into <next>" progress line during a transition;
  * transport row: shuffle, previous, big play/pause, next, repeat (off/all/one icon states); targets >= 48 px,
    play >= 64 px;
  * transition chooser: DJ mix / Crossfade (with a seconds slider 2..12) / Gapless, one line explaining each;
  * **Up next** list: the queue after the current song, with drag-to-reorder (handle), remove, tap = play now;
    a collapsible **History**; "Clear queue"; empty state that points to the Songs page;
  * master volume slider.
* **Songs page**: each library and demo row gets a small menu or buttons for **Play now**, **Play next**,
  **Add to queue** (the existing + stays as Add to queue; A/B load buttons stay). Keep rows uncluttered on 360 px.
* **Phone tab bar**: at most 5 items. Add **PLAYER**; keep Auto Mix reachable within two taps from the DECKS page
  (e.g. the Player page's play button and the DECKS status strip). Decide the best arrangement and explain it in
  CHANGES.md.
* DECKS page status strip: while the queue plays, show the current/next song and a mini transport
  (previous / play-pause / next) next to MIX NOW, if it fits at 360 x 560.
* Keyboard (desktop): Space = player play/pause when the Player page is open (never while a text field has focus),
  N = next, B = previous (avoid clashes with existing shortcuts; document them in Help).
* Help: a short "Music player" section.

## 6. Ownership for this round

| Agent | Files |
|---|---|
| lead | `src/core/*`, `docs/PLAYER.md` |
| core | `src/deck/{playlist,automix,automix-plan,automix-deck,player}.js`, `tests/{playlist,automix,automix-plan,player}.test.js` |
| ui | `index.html`, `css/*`, `src/main.js`, `src/ui/**`, `tests/ui-*.test.js`, `sw.js` (SHELL list only) |

Definition of done: `tools/JsCheck/jscheck check src tests` clean, `tools/JsCheck/jscheck test tests` all pass,
README "Features" and "Controls" sections updated by the ui agent (short).
