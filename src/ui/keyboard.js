// Desktop keyboard shortcuts (physical key positions, so they work on AZERTY/QWERTZ too):
//   Deck A: Q play, W cue (hold), E sync, 1-4 loops 1/2/4/8.  Deck B: P play, O cue (hold), I sync, 7-0 loops.
//   Arrow left/right: crossfader (Shift = fine).  M: Auto Mix on / off.  Escape: close the open panel.
//   Music player: Space play / pause (only while the player page is open, and never when a focused button,
//   switch or slider uses Space itself), N next song, B previous song (while the player page is open or the
//   queue plays).
// Keys are never taken while a text field has focus, with modifier keys held, or while a dialog is open.
//   const off = bindKeyboard(app);

import { isTypingTarget, usesSpaceKey } from './dom.js';

const LOOP_KEYS = {
  Digit1: [0, 1], Digit2: [0, 2], Digit3: [0, 4], Digit4: [0, 8],
  Digit7: [1, 1], Digit8: [1, 2], Digit9: [1, 4], Digit0: [1, 8],
};

/**
 * @param {object} app AppUI: decks, sync, dialog, sheets, setCrossfader(), xfade, startOverlayVisible, automix,
 *   toggleAutomix(), player, page, playerToggle(), playerNext(), playerPrevious(), playerKeysActive()
 * @returns {Function} unbind
 */
export function bindKeyboard(app) {
  const cueHeld = new Set();
  const play = (i) => {
    const d = app.decks[i];
    if (d && d.track) d.togglePlay();
  };
  const onDown = (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    if (app.dialog && app.dialog.open) return;
    if (app.startOverlayVisible) return;
    if (e.key === 'Escape') {
      if (app.sheets && app.sheets.isOpen) {
        app.sheets.close();
        e.preventDefault();
      }
      return;
    }
    if (app.sheets && app.sheets.isOpen) return;
    const code = e.code;
    let handled = true;
    switch (code) {
      case 'KeyQ': if (!e.repeat) play(0); break;
      case 'KeyP': if (!e.repeat) play(1); break;
      case 'KeyW':
      case 'KeyO': {
        const i = code === 'KeyW' ? 0 : 1;
        if (!e.repeat && !cueHeld.has(i) && app.decks[i] && app.decks[i].track) {
          cueHeld.add(i);
          app.decks[i].cueDown();
        }
        break;
      }
      case 'KeyE': if (!e.repeat) app.sync.toggle(0); break;
      case 'KeyI': if (!e.repeat) app.sync.toggle(1); break;
      case 'KeyM':
        if (!app.automix) handled = false;
        else if (!e.repeat) app.toggleAutomix();
        break;
      case 'Space':
        // the player page only; a focused button / switch / slider keeps Space for itself
        if (!app.player || app.page !== 'player' || usesSpaceKey(e.target)) handled = false;
        else if (!e.repeat) app.playerToggle();
        break;
      case 'KeyN':
      case 'KeyB':
        if (!app.player || typeof app.playerKeysActive !== 'function' || !app.playerKeysActive()) handled = false;
        else if (!e.repeat) {
          if (code === 'KeyN') app.playerNext();
          else app.playerPrevious();
        }
        break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        // Leave arrows to a focused slider/knob (they handle their own keys).
        const t = e.target;
        if (t && t.getAttribute && t.getAttribute('role') === 'slider') {
          handled = false;
          break;
        }
        const step = e.shiftKey ? 0.02 : 0.1;
        const x = Math.max(-1, Math.min(1, (app.xfade || 0) + (code === 'ArrowLeft' ? -step : step)));
        app.setCrossfader(Math.abs(x) < 1e-6 ? 0 : x);
        break;
      }
      default:
        if (LOOP_KEYS[code] && !e.repeat) {
          const [i, beats] = LOOP_KEYS[code];
          const d = app.decks[i];
          if (d && d.track && d.bpm > 0) d.toggleLoop(beats);
        } else handled = false;
    }
    if (handled) e.preventDefault();
  };
  const onUp = (e) => {
    const i = e.code === 'KeyW' ? 0 : e.code === 'KeyO' ? 1 : -1;
    if (i >= 0 && cueHeld.has(i)) {
      cueHeld.delete(i);
      app.decks[i].cueUp();
      e.preventDefault();
    }
  };
  const onBlur = () => {
    for (const i of cueHeld) app.decks[i].cueUp();
    cueHeld.clear();
  };
  document.addEventListener('keydown', onDown);
  document.addEventListener('keyup', onUp);
  window.addEventListener('blur', onBlur);
  return () => {
    document.removeEventListener('keydown', onDown);
    document.removeEventListener('keyup', onUp);
    window.removeEventListener('blur', onBlur);
  };
}
