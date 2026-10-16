// Settings sheet: every user setting in plain words (tempo range, crossfader curve, quantize, vinyl mode, auto
// sync, Auto Mix transition / length / ease back / bass swap, keep screen awake, haptics, time display, waveform
// zoom, outdoor contrast), the music server and Google Drive (connected server, disconnect, sign out), Restart
// audio, tips, reset, and an About / diagnostics block with the privacy link (engine.diagnostics(),
// feature flags, layout, build).
//   host.push(settingsSheet(app));

import { h, icon, setKids } from '../dom.js';
import { section, note, switchRow, segmented, navRow } from './sheet.js';
import { env } from '../../core/env.js';
import { fmtRange, waveSeconds, ZOOM_STEPS } from '../format.js';
import { formatDiagnostics } from '../app-info.js';
import { TRANSITIONS } from '../player-text.js';
import { GUIDES, serverLabel, serverKind } from '../sources-text.js';

const KEEP_ON_RESET = ['outputMode', 'masterDeviceId', 'cueDeviceId', 'alignmentMs', 'splitSwap', 'remoteBus', 'tipsSeen', 'setList'];

export function settingsSheet(app) {
  return {
    id: 'settings',
    title: 'Settings',
    mount(body) {
      const s = app.settings;
      const set = (key, value) => {
        try {
          s.set(key, value);
        } catch (err) {
          console.warn('[TwinSpin] setting failed', key, err);
        }
      };

      // Decks
      const range = segmented('Tempo range', [0.08, 0.16, 0.5].map((v) => ({ value: v, label: fmtRange(v) })), s.get('tempoRange'),
        (v) => {
          set('tempoRange', v);
          for (const d of app.decks) safe(() => d.setTempoRange(v));
        }, { detail: 'How far the tempo control reaches. ±8% is precise, ±50% is wild.' });
      const vinyl = switchRow('Scratch on the record', 'On: touching the record holds and scratches it. Off: it nudges the tempo.',
        s.get('vinyl'), (on) => {
          set('vinyl', on);
          for (const d of app.decks) safe(() => d.setVinyl(on));
        });
      const quant = switchRow('Snap to the beat', 'Cue points and loops land exactly on a beat (quantize).', s.get('quantize'),
        (on) => set('quantize', on));
      const auto = switchRow('Auto sync', 'A stopped deck matches the playing deck as soon as its BPM is known.', s.get('autoSync'),
        (on) => set('autoSync', on));
      const time = segmented('Time display', [{ value: 'remain', label: 'Remaining' }, { value: 'elapsed', label: 'Elapsed' }],
        s.get('timeMode'), (v) => set('timeMode', v));

      // Mixer
      const curve = segmented('Crossfader', [{ value: 'smooth', label: 'Smooth' }, { value: 'cut', label: 'Cut' }], s.get('xfadeCurve'),
        (v) => {
          set('xfadeCurve', v);
          const m = app.engine && app.engine.mixer;
          if (m) safe(() => m.setCrossfaderCurve(v));
        }, { detail: 'Smooth blends gently. Cut switches fast, for scratching.' });

      // Auto Mix (changes apply to the next transition)
      const mixLen = segmented('Mix length', [16, 32, 64].map((n) => ({ value: n, label: `${n}` })), s.get('mixBeats'),
        (v) => set('mixBeats', v), { detail: 'How long each Auto Mix transition lasts, in beats. 32 beats is about 15 seconds at 124 BPM; longer is smoother.' });
      const easeBack = switchRow('Ease back to the song’s own tempo', 'After a mix, the new song slowly returns to its original speed.',
        s.get('automixReturn'), (on) => set('automixReturn', on));
      const bassSwap = switchRow('Bass swap', 'Half way through a mix the bass moves from the old song to the new one, so the two never clash.',
        s.get('automixBassSwap'), (on) => set('automixBassSwap', on));
      // the queue's transition style (also on the PLAYER page, with the crossfade length)
      const trans = segmented('Transition', TRANSITIONS.map((t) => ({ value: t.value, label: t.label })), s.get('transitionStyle'),
        (v) => {
          const p = app.player;
          if (p && typeof p.setTransition === 'function') safe(() => p.setTransition(v));
          else set('transitionStyle', v);
        }, { detail: 'How the queue moves from song to song: DJ mix beat-matches, Crossfade fades (its length is on the player page), Gapless starts the next song the moment one ends.' });

      // Screen
      const zoomVal = h('span.row-value');
      const showZoom = () => {
        const w = app.waveCanvas ? app.waveCanvas.clientWidth : 0;
        zoomVal.textContent = `${waveSeconds(w > 0 ? w : app.layout, s.get('waveZoom'))} s visible`;
      };
      const zoom = segmented('Waveform zoom', ZOOM_STEPS.map((z) => ({ value: z, label: zoomLabel(z) })), nearest(s.get('waveZoom')),
        (v) => {
          set('waveZoom', v);
          showZoom();
        }, { detail: 'Pinch the waveforms to zoom too.', extra: zoomVal });
      zoom.el.classList.add('row-zoom');
      showZoom();
      const outdoor = switchRow('Outdoor contrast', 'Pure black and white with thicker lines, for bright light.', s.get('outdoor'),
        (on) => set('outdoor', on));
      const awake = switchRow('Keep the screen on', env.wakeLock ? 'Stops the phone from sleeping while TwinSpin is open.'
        : 'Not supported by this browser.', s.get('keepAwake'), (on) => set('keepAwake', on));
      const rows = [range.el, vinyl.el, quant.el, auto.el, time.el];
      const screenRows = [zoom.el, outdoor.el, awake.el];
      // navigator.vibrate exists on Firefox Android but does nothing there; iPhones have no web vibration at all.
      const canBuzz = env.vibrate && !env.ios && !env.firefox;
      const hap = switchRow('Vibration ticks', canBuzz ? 'A short buzz on button presses and centre clicks.'
        : "This device or browser can't vibrate.", s.get('haptics'), (on) => set('haptics', on));
      screenRows.push(hap.el);

      // Audio
      const restart = navRow('refresh', 'Restart audio', 'Use this if the sound stops or stutters. Songs stay loaded.', () => {
        app.restartAudio();
      }, { noChevron: true });
      const tips = navRow('bulb', 'Show the tips again', 'The three first-run hints.', () => {
        set('tipsSeen', false);
        app.sheets.close();
        app.startCoach(true);
      }, { noChevron: true });
      const reset = navRow('trash', 'Reset all settings', 'Back to the defaults. Your songs, set list and outputs are kept.', async () => {
        const ok = await app.dialog.confirm({ title: 'Reset all settings?', message: 'Your songs stay in the library and the sound keeps going where it goes now.', ok: 'Reset', danger: true });
        if (!ok) return;
        // Keep the routing (changing it mid-set would move the sound) and do not replay the first-run tips.
        const keep = {};
        for (const k of KEEP_ON_RESET) keep[k] = s.get(k);
        safe(() => s.reset());
        for (const k of KEEP_ON_RESET) safe(() => s.set(k, keep[k]));
        for (const d of app.decks) {
          safe(() => d.setTempoRange(s.get('tempoRange')));
          safe(() => d.setVinyl(s.get('vinyl')));
        }
        app.applySettingsToEngine();
        app.toast('Settings reset', { kind: 'ok' });
        app.sheets.refresh();
      }, { noChevron: true, className: 'row-danger' });

      // Song sources: the music server and Google Drive (docs/SOURCES.md section 4)
      const sourceSecs = sourceSections(app);

      // About + diagnostics
      const diag = h('pre.diag', { tabindex: '0' });
      const about = h('p.sheet-note.about');
      const fillAbout = () => {
        const info = app.buildInfo();
        about.textContent = `TwinSpin ${info.version}${info.build ? ` · build ${info.build}` : ''}`;
        diag.textContent = formatDiagnostics(app.diagnostics());
      };
      fillAbout();
      app.loadBuildInfo().then(fillAbout).catch(() => {});
      const copy = h('button.btn.btn-ghost.btn-sm', { type: 'button' }, icon('check'), h('span', { text: 'Copy details' }));
      copy.addEventListener('click', () => {
        const text = diag.textContent;
        try {
          navigator.clipboard.writeText(text).then(() => app.toast('Copied', { kind: 'ok' }), () => selectText(diag));
        } catch {
          selectText(diag);
        }
      });
      const details = h('details.diag-wrap', {}, h('summary', { text: 'Diagnostics' }), diag, copy);

      setKids(body,
        section('Decks', ...rows),
        section('Mixer', curve.el),
        app.automix ? section('Auto Mix', trans.el, mixLen.el, easeBack.el, bassSwap.el) : null,
        section('Screen', ...screenRows),
        section('Audio', restart.el,
          note('Outputs, headphones and volumes are in the Outputs panel.')),
        ...sourceSecs,
        section('Help', tips.el, reset.el),
        section('About', about, h('p.sheet-note', {}, h('a.src-link', { href: GUIDES.privacy, target: '_blank', rel: 'noopener',
          text: 'Privacy: what TwinSpin keeps and sends' })), details));
    },
  };
}

/**
 * Settings > Music server (the connected server, open it, disconnect; or connect) and Google Drive (sign out, or
 * how to set it up).
 */
function sourceSections(app) {
  const src = app.sourcesUI;
  if (!src) return [];
  const out = [];
  const server = src.server;
  if (server) {
    let info = null;
    try {
      info = server.connected ? server.server : null;
    } catch {
      info = null;
    }
    if (info) {
      const kind = serverKind(info);
      const open = navRow('server', serverLabel(info), [kind, info.url || ''].filter(Boolean).join(' · '), () => {
        app.sheets.push(src.browser.sheet());
      });
      const off = navRow('logout', 'Disconnect', 'Songs you saved offline stay on this device.', () => {
        src.browser.disconnect().then((done) => {
          if (done) app.sheets.refresh();
        });
      }, { noChevron: true, className: 'row-danger' });
      out.push(section('Music server', open.el, off.el));
    } else {
      const connect = navRow('server', 'Connect a music server', 'Navidrome or another Subsonic server, for example on ' +
        'a Synology NAS', () => app.sheets.push(src.browser.sheet()));
      out.push(section('Music server', connect.el));
    }
  }
  const drive = src.gdrive;
  if (drive) {
    if (src.driveConfigured) {
      const signOut = navRow('logout', 'Sign out of Google Drive', 'TwinSpin forgets its Google access on this device. ' +
        'Songs you imported stay.', () => {
        try {
          drive.signOut();
          app.toast('Signed out of Google Drive', { kind: 'ok' });
        } catch (err) {
          console.warn('[TwinSpin] Google sign-out failed', err);
          app.toast("Signing out didn't work. Reload the page and try again.", { kind: 'error' });
        }
      }, { noChevron: true });
      out.push(section('Google Drive', signOut.el, note('TwinSpin only sees the songs you pick in Google Drive. You can ' +
        'also remove its access in your Google Account > Security > Third-party apps.')));
    } else {
      out.push(section('Google Drive', note('Google Drive is not set up in this copy of TwinSpin yet. Your phone can ' +
        'still open Drive through Add music > This device.'), h('p.sheet-note', {}, h('a.src-link', { href: GUIDES.drive,
        target: '_blank', rel: 'noopener', text: 'How to set up Google Drive' }))));
    }
  }
  return out;
}

function zoomLabel(z) {
  if (z < 0.4) return '⅓×';
  if (z < 0.6) return '½×';
  if (z < 0.8) return '⅔×';
  return `${z}×`;
}

function nearest(z) {
  let best = 1;
  let d = Infinity;
  for (const s of ZOOM_STEPS) {
    if (Math.abs(s - z) < d) {
      d = Math.abs(s - z);
      best = s;
    }
  }
  return best;
}

function selectText(el) {
  try {
    const r = document.createRange();
    r.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  } catch {
    /* ignore */
  }
}

function safe(fn) {
  try {
    return fn();
  } catch (err) {
    console.warn('[TwinSpin] settings:', err);
    return undefined;
  }
}
