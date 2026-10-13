// DJ app wiring: Settings, AudioEngine, Library, Deck A/B, SyncController, Playlist (the set list = the queue),
// AutoMix, Player (the music player facade) and AppUI (contract section 1, docs/AUTOMIX.md section 5,
// docs/PLAYER.md sections 4-5).
// src/main.js loads this module with ONE dynamic import (so the second-device receiver page never downloads the
// DJ engine, and a module that fails to load shows a readable message instead of a blank page). Every import
// in the DJ module graph from here on is static. No side effects at import time.
//   const app = startApp(document.getElementById('app'));
//   // { settings, engine, library, decks, sync, playlist, automix, player, ui }
// Screenshot mode (?shot=<name>, for the README pictures) is at the end of this file; without ?shot it never runs.

import { env } from '../core/env.js';
import { Settings } from '../core/settings.js';
import { AudioEngine } from '../audio/engine.js';
import { Library } from '../library/library.js';
import { Deck } from '../deck/deck.js';
import { SyncController } from '../deck/sync.js';
import { Playlist } from '../deck/playlist.js';
import { AutoMix } from '../deck/automix.js';
import { Player } from '../deck/player.js';
import { AppUI } from './app-ui.js';
import { waitFor } from './track-loader.js';

/**
 * Build the DJ app inside `root` (#app). The UI is usable at once behind the start overlay; audio starts from
 * the overlay's click. The library opens in the background and the Songs list refreshes when it is ready.
 * Auto Mix always starts switched off (a reload never starts music by itself); the set list is restored.
 * @param {HTMLElement} root
 * @returns {{settings:Settings, engine:AudioEngine, library:Library, decks:Deck[], sync:SyncController,
 *   playlist:Playlist|null, automix:AutoMix|null, player:Player|null, ui:AppUI}}
 */
export function startApp(root) {
  const shot = shotName();
  const settings = shot ? shotSettings(shot) : new Settings();
  const engine = new AudioEngine({ settings });
  const library = new Library();
  const decks = [new Deck('A', engine, settings), new Deck('B', engine, settings)];
  const sync = new SyncController(decks, settings);
  // The set list, Auto Mix and the player are extras: if one fails to build, the two decks still work (and the
  // UI hides what is missing).
  let playlist = null;
  let automix = null;
  let player = null;
  try {
    playlist = new Playlist({ settings, library });
  } catch (err) {
    console.error('[TwinSpin] set list unavailable', err);
  }
  if (playlist) {
    try {
      automix = new AutoMix({ engine, decks, sync, settings, playlist });
    } catch (err) {
      console.error('[TwinSpin] Auto Mix unavailable', err);
    }
  }
  if (playlist && automix) {
    try {
      player = new Player({ automix, playlist, decks, engine, settings, library });
    } catch (err) {
      console.error('[TwinSpin] music player unavailable', err);
    }
  }
  root.classList.remove('booting');
  const ui = new AppUI({ root, engine, decks, sync, settings, library, playlist, automix, player });
  const app = { settings, engine, library, decks, sync, playlist, automix, player, ui, env };
  try {
    window.twinspin = app; // handy in the browser console and for remote debugging
  } catch {
    /* ignore */
  }
  let init;
  try {
    init = library.init();
  } catch (err) {
    init = Promise.reject(err);
  }
  Promise.resolve(init)
    .catch((err) => {
      console.warn('[TwinSpin] library init failed', err);
      ui.toast("Your saved songs couldn't be opened. Songs you add now are kept for this visit only.", { kind: 'error' });
    })
    .then(() => {
      ui.songs.render();
      ui.songs.renderSetList();
    });
  if (shot) runShot(app, shot);
  return app;
}

// ---- Screenshot mode ---------------------------------------------------------------------------------------------
// Opt-in scenes for capturing the README screenshots with a headless browser that allows autoplay (for example
// Edge or Chrome started with --headless=new --autoplay-policy=no-user-gesture-required --mute-audio), opened at
//   http://localhost:8100/?nosw&shot=decks        (decks | mix | fx | songs | player | desktop | start)
// A scene uses its own settings key (the visitor's own settings and set list are never touched), shows no tips
// and no install offer, starts audio without a tap (if the browser keeps the context suspended the engine still
// comes up and the UI renders), and then:
//   decks, mix, fx, desktop: both demo tracks play, deck B synced to deck A; fx also switches ECHO on for deck A;
//   songs: the demos go into the set list, Auto Mix plays them and starts the first mix at once (MIX NOW);
//   player: the PLAYER page; the demos go into the queue and the player plays them;
//   start: nothing, the "Tap to start" screen is the picture.
// Without a valid ?shot value none of this runs.

const SHOTS = ['decks', 'mix', 'fx', 'songs', 'player', 'desktop', 'start'];

/** The ?shot=<name> scene, or null (the normal app). */
function shotName() {
  try {
    const v = new URLSearchParams(location.search).get('shot');
    return SHOTS.includes(v) ? v : null;
  } catch {
    return null;
  }
}

/** Throw-away settings for a scene: defaults, tips already seen, the scene's page. */
function shotSettings(shot) {
  const s = new Settings('twinspin.settings.shot');
  try {
    s.reset();
    s.set('tipsSeen', true);
    s.set('page', shot === 'desktop' || shot === 'start' ? 'mix' : shot);
  } catch {
    /* storage may be blocked: the defaults still work */
  }
  return s;
}

/** Start audio, load and play the demos for the scene. Every step is best effort: a failure leaves the UI as is. */
function runShot(app, shot) {
  const { ui, engine, decks, sync, playlist, automix, player } = app;
  ui._offerInstall = () => {}; // no "Install TwinSpin" toast over the picture
  if (shot === 'start') return;
  const has = (d) => !!(d && d.track && d.bpm > 0 && !d.loading && !d.analyzing);
  const WAIT = 20000;
  ui.start(false); // engine.start() without a tap
  waitFor(() => engine.ready, WAIT).then((ready) => {
    if (!ready) return;
    if (shot === 'player' && playlist && player) {
      ui.addToSetList([{ kind: 'demo', id: 0 }, { kind: 'demo', id: 1 }], { quiet: true });
      player.play();
      return;
    }
    if (shot === 'songs' && playlist && automix) {
      // Auto Mix starts the list from idle (demo 1 on deck A, demo 2 prepared on deck B), then mixes right away.
      ui.addToSetList([{ kind: 'demo', id: 0 }, { kind: 'demo', id: 1 }], { quiet: true });
      automix.setEnabled(true);
      waitFor(() => automix.nextReady, WAIT).then((ok) => ok && automix.mixNow());
      return;
    }
    ui.loader.loadDemos();
    waitFor(() => has(decks[0]) && has(decks[1]), WAIT).then(() => {
      decks[0].seek(32); // well into the songs, so the waveforms fill both sides of the playhead
      decks[1].seek(16);
      decks[0].play();
      sync.setSync(1, true); // tempo and beat follow deck A (autoSync may have done it already)
      decks[1].play();
      ui.setCrossfader(-0.2);
      if (shot === 'fx') decks[0].setFx('echo', true);
    });
  });
}
