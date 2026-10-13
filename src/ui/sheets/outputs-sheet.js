// Outputs sheet: where the main mix and the headphone (cue) mix go. Built from the OutputRouter API (contract
// section 7 + CHANGES.md routing notes): four mode cards with plain availability reasons, then the controls for
// the chosen mode, then the levels (main volume, headphone cue/main blend, headphone volume).
//   single  a plain note (the headphone buttons only light the meters)
//   dual    "Show my speakers" explained first (router.accessInfo()), speaker + headphone pickers, Test, alignment
//   split   L/R diagram, swap switch, the phone-settings warning, Test
//   remote  the routing agent's mountRemotePanel(); the panel's own "Start sharing" switches the router to
//           'remote' (the card only opens the panel; sharing needs the panel's stream hand-off)
//   host.open(outputsSheet(app));
// Every router call that needs a user gesture (setMode for dual, device access, setSinkId) runs synchronously
// inside the click handler, before any await. The router persists its own settings (outputMode, device ids,
// alignment, split swap, remote bus).

import { h, icon, setKids } from '../dom.js';
import { section, note, switchRow, sliderRow } from './sheet.js';
import { Fader } from '../widgets/controls.js';
import { mountRemotePanel } from '../../remote/remote-panel.js';
import { env } from '../../core/env.js';
import { fmtAlign, fmtPct, fmtCueMix } from '../format.js';

const MODES = [
  { key: 'single', icon: 'speaker', title: 'One output',
    text: 'Everything plays from this device: its speaker, or whatever is plugged in or paired.' },
  { key: 'dual', icon: 'laptop', title: 'Speaker + headphones',
    text: 'The mix goes to one output and your headphone mix to another. Computers only.' },
  { key: 'split', icon: 'cable', title: 'Split cable',
    text: 'One headphone socket split in two: one side to the speaker, the other to your headphones.' },
  { key: 'remote', icon: 'wifi', title: 'Second device',
    text: 'Another phone or laptop plays your headphone mix over Wi-Fi.' },
];

export function outputsSheet(app) {
  return {
    id: 'outputs',
    title: 'Outputs',
    mount(body) {
      const st = {
        busy: null, devices: null, loadingDevices: false, detailKey: '', remote: null, unsubRouter: null,
        widgets: [], hpRows: [], wantRemote: false,
      };
      const intro = h('div.out-intro');
      const cards = h('div.mode-cards', { role: 'radiogroup', 'aria-label': 'Where the sound goes' });
      const detail = h('div.mode-detail');
      const levels = h('div.out-levels');
      body.append(intro, section('Where the sound goes', cards), detail, levels);

      const router = () => (app.engine && app.engine.ready ? app.engine.outputs : null);
      const settings = app.settings;

      /** The mode whose controls are shown: the router's mode, or 'remote' while the user sets sharing up. */
      const view = () => {
        const r = router();
        if (!r) return 'none';
        const mode = safe(() => r.mode, 'single');
        if (mode === 'remote') st.wantRemote = false;
        return st.wantRemote ? 'remote' : mode;
      };

      // ---- intro ------------------------------------------------------------------------------------------
      const renderIntro = () => {
        const r = router();
        const now = r ? safe(() => r.describe(), '') : '';
        const ff = r ? safe(() => r.formFactor, '') : '';
        const handheld = ff ? ff !== 'computer' : env.mobile;
        setKids(intro,
          h('p.out-now', {}, icon('outputs'), h('span', { text: r ? `Now: ${now || 'Default output'}` : 'Audio is not started yet.' })),
          note(handheld
            ? 'Phones and tablets play to only one output at a time, so a Bluetooth speaker plus Bluetooth ' +
              'headphones is not possible. For headphone pre-listen, use a split cable or a second device.'
            : 'This computer can send the main mix and your headphone mix to two different outputs, for example ' +
              'speakers and USB or Bluetooth headphones.'));
      };

      // ---- mode cards -------------------------------------------------------------------------------------
      const renderCards = () => {
        const r = router();
        const modes = r ? safe(() => r.modes, null) : null;
        const cur = view();
        const sharing = r ? safe(() => r.mode, '') === 'remote' : false;
        setKids(cards, MODES.map((m) => {
          const avail = (modes && modes[m.key]) || { ok: m.key === 'single' };
          const ok = !!r && !!avail.ok;
          const on = cur === m.key;
          let extra = !r ? 'Start audio first.' : !avail.ok ? avail.reason || 'Not available on this device.' : avail.note || '';
          if (m.key === 'remote' && on && !sharing && ok) extra = 'Tap Start sharing below.';
          const card = h(`button.mode-card${on ? '.on' : ''}${ok ? '' : '.na'}`, {
            type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', 'aria-disabled': ok ? null : 'true',
          },
          icon(m.icon, 'mode-ico'),
          h('span.mode-main', {},
            h('span.mode-title', { text: st.busy === m.key ? `${m.title}: switching…` : m.title }),
            h('span.mode-text', { text: m.text }),
            extra ? h(`span.mode-extra${ok ? '' : '.why'}`, { text: extra }) : null),
          on ? icon('check', 'mode-check') : null);
          card.addEventListener('click', () => choose(m.key, ok, avail));
          return card;
        }));
      };

      const choose = (mode, ok, avail) => {
        const r = router();
        if (!r) {
          app.toast('Tap Start first so TwinSpin can play sound.');
          return;
        }
        if (!ok) {
          if (avail && avail.reason) app.toast(avail.reason);
          return;
        }
        if (st.busy) return;
        const cur = safe(() => r.mode, 'single');
        if (mode === 'remote') {
          // Sharing starts from the panel (it hands the router's stream to the remote host).
          st.wantRemote = cur !== 'remote';
          renderAll();
          return;
        }
        st.wantRemote = false;
        if (cur === mode) {
          renderAll();
          return;
        }
        st.busy = mode;
        let p;
        try {
          p = r.setMode(mode); // synchronously inside the click (dual starts its <audio> outputs in the gesture)
        } catch (err) {
          p = Promise.reject(err);
        }
        renderCards();
        Promise.resolve(p)
          .catch(() => app.toastLater('router', "That output mode couldn't be switched on. Back to one output."))
          .then(() => {
            st.busy = null;
            renderAll();
          });
      };

      // ---- mode detail ------------------------------------------------------------------------------------
      const disposeDetailWidgets = () => {
        for (const w of st.widgets) if (w && typeof w.destroy === 'function') safe(() => w.destroy());
        st.widgets = [];
      };

      const unmountRemote = () => {
        const c = st.remote;
        st.remote = null;
        if (c && typeof c.destroy === 'function') safe(() => c.destroy());
      };

      const renderDetail = (force) => {
        const r = router();
        const v = view();
        const access = r && v === 'dual' ? !!safe(() => r.hasDeviceAccess(), false) : false;
        const devKey = st.devices ? st.devices.map((d) => d.deviceId).join(',') : st.loadingDevices ? 'loading' : '';
        const key = `${v}|${access}|${devKey}|${safe(() => r.masterDeviceId, '')}|${safe(() => r.cueDeviceId, '')}|` +
          `${safe(() => r.splitSwap, '')}`;
        for (const el of st.hpRows) el.hidden = v === 'single' || v === 'none';
        if (v === 'remote' && st.remote) {
          // keep the live remote panel mounted; just let it re-read the router / host
          st.detailKey = key;
          safe(() => st.remote.refresh());
          return;
        }
        if (!force && key === st.detailKey) return;
        st.detailKey = key;
        disposeDetailWidgets();
        unmountRemote();
        setKids(detail);
        if (!r) return;
        if (v === 'single') detail.append(singleDetail(r));
        else if (v === 'dual') detail.append(dualDetail(r, access));
        else if (v === 'split') detail.append(splitDetail(r));
        else if (v === 'remote') detail.append(remoteDetail(r));
      };

      const singleDetail = (r) => {
        const ff = safe(() => r.formFactor, '');
        const more = ff === 'computer' ? ', or Speaker + headphones' : '';
        return section('Headphones',
          note('The headphone buttons still light the meters, but there is only one output here, so you hear the ' +
            `main mix only. For a separate headphone mix choose Split cable or Second device${more}.`));
      };

      const testButtons = (r) => {
        const mk = (which, label, ico) => {
          const b = h('button.btn.btn-test', { type: 'button' }, icon(ico), h('span', { text: label }));
          b.addEventListener('click', () => {
            b.disabled = true;
            let p;
            try {
              p = r.test(which); // inside the click
            } catch (err) {
              p = Promise.reject(err);
            }
            Promise.resolve(p)
              .catch(() => app.toastLater('router', "The test sound couldn't play on that output."))
              .then(() => setTimeout(() => {
                b.disabled = false;
              }, 600));
          });
          return b;
        };
        return h('div.btn-row', {}, mk('master', 'Test speaker', 'speaker'), mk('cue', 'Test headphones', 'headphones'));
      };

      const accessInfo = (r) => (typeof r.accessInfo === 'function' ? safe(() => r.accessInfo(), null) : null);

      const dualDetail = (r, access) => {
        const wrap = h('div');
        const info = accessInfo(r);
        const pickMode = info ? info.method === 'pick' : env.selectAudioOutput;
        if (!access) {
          // Explain the unlock BEFORE the button (it may ask for the microphone or open a picker).
          const text = (info && info.text) || ('Your browser only shows speaker names after you allow the microphone. ' +
            'TwinSpin never records: it asks once and turns the microphone off right away.');
          wrap.append(section('Find your outputs', note(text),
            pickMode ? h('div.btn-row', {}, unlockBtn(r, 'master', 'Choose speaker…'), unlockBtn(r, 'cue', 'Choose headphones…'))
              : h('div.btn-row', {}, unlockBtn(r, 'cue', (info && info.label) || 'Show my speakers'))));
          return wrap;
        }
        if (!st.devices) {
          if (!st.loadingDevices) loadDevices(r);
          wrap.append(section('Outputs', note('Looking for outputs…')));
          return wrap;
        }
        const devs = st.devices;
        const pick = (role, id) => {
          let p;
          try {
            p = role === 'master' ? r.setMasterDevice(id) : r.setCueDevice(id); // inside the click (Safari)
          } catch (err) {
            p = Promise.reject(err);
          }
          Promise.resolve(p)
            .catch(() => app.toastLater('router', "That output couldn't be selected. Pick another one or refresh the list."))
            .then(() => renderDetail(true));
        };
        const list = (role) => {
          const cur = role === 'master' ? safe(() => r.masterDeviceId, 'default') : safe(() => r.cueDeviceId, '');
          if (!devs.length) return note('No outputs found. Plug in or pair a device, then refresh.');
          return h('div.dev-list', { role: 'radiogroup', 'aria-label': role === 'master' ? 'Speaker output' : 'Headphone output' },
            devs.map((d) => {
              const on = d.deviceId === cur;
              const b = h(`button.dev-row${on ? '.on' : ''}`, { type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false' },
                icon(role === 'master' ? 'speaker' : 'headphones', 'dev-ico'),
                h('span.dev-main', {}, h('span.dev-label', { text: d.label || (d.deviceId === 'default' ? 'System default' : 'Unnamed output') }),
                  d.hint ? h('span.dev-hint', { text: d.hint }) : null),
                on ? icon('check', 'dev-check') : null);
              b.addEventListener('click', () => pick(role, d.deviceId));
              return b;
            }));
        };
        const refresh = h('button.btn.btn-ghost.btn-sm', { type: 'button' }, icon('refresh'), h('span', { text: 'Refresh list' }));
        refresh.addEventListener('click', () => {
          st.devices = null;
          loadDevices(r);
          renderDetail(true);
        });
        const align = sliderRow('Output alignment', 'Headphones behind the speaker? Slide right. Speaker behind the headphones? Slide left.');
        setKids(wrap,
          pickMode ? section('Pick outputs', note('This browser lists only the outputs you picked. Pick the other one here.'),
            h('div.btn-row', {}, unlockBtn(r, 'master', 'Choose speaker…'), unlockBtn(r, 'cue', 'Choose headphones…'))) : null,
          section('Speaker (main mix)', list('master')),
          section('Headphones (your cue mix)', list('cue')),
          section('Check', note('Tap Test to hear which output is which.'), testButtons(r), refresh),
          section('Alignment', align.el, note('Bluetooth outputs run late. Line the beats up by ear with the Test sounds or the music.')));
        const initial = Number(safe(() => r.alignmentMs, 0)) || 0;
        align.valueEl.textContent = fmtAlign(initial);
        const f = safe(() => new Fader(align.slot, {
          orientation: 'horizontal', min: -300, max: 300, value: initial, defaultValue: 0, detent: 0, step: 1,
          label: 'ALIGN', format: fmtAlign, className: 'fader-align',
          onInput: (v) => {
            const ms = Math.round(v);
            align.valueEl.textContent = fmtAlign(ms);
            safe(() => r.setAlignmentMs(ms)); // the router stores the setting
          },
        }), null);
        if (f) st.widgets.push(f);
        return wrap;
      };

      const unlockBtn = (r, role, label) => {
        const b = h('button.btn.btn-primary', { type: 'button' }, icon(role === 'cue' ? 'headphones' : 'speaker'), h('span', { text: label }));
        b.addEventListener('click', () => {
          let p;
          try {
            p = r.requestDeviceAccess(role); // synchronously inside the click
          } catch (err) {
            p = Promise.reject(err);
          }
          b.disabled = true;
          Promise.resolve(p)
            .catch(() => app.toastLater('router', "The outputs couldn't be listed. Check the browser's site permissions."))
            .then(() => {
              b.disabled = false;
              st.devices = null;
              renderDetail(true);
            });
        });
        return b;
      };

      const loadDevices = (r) => {
        st.loadingDevices = true;
        Promise.resolve()
          .then(() => r.listOutputs())
          .then((list) => {
            st.devices = Array.isArray(list) ? list : [];
          })
          .catch(() => {
            st.devices = [];
          })
          .then(() => {
            st.loadingDevices = false;
            renderDetail(true);
          });
      };

      const splitDetail = (r) => {
        const swap = !!safe(() => r.splitSwap, false);
        const side = (lr, what, ico) => h('div.split-side', {}, h('span.split-lr', { text: lr }), icon(ico), h('span', { text: what }));
        const diagram = h('div.split-diagram', { role: 'img', 'aria-label': swap ? 'Left: headphones. Right: speaker.' : 'Left: speaker. Right: headphones.' },
          swap ? side('LEFT', 'Headphones', 'headphones') : side('LEFT', 'Speaker', 'speaker'),
          swap ? side('RIGHT', 'Speaker', 'speaker') : side('RIGHT', 'Headphones', 'headphones'));
        const sw = switchRow('Swap sides', 'Use this if the speaker plays your headphone mix.', swap, (on) => {
          let p;
          try {
            p = r.setSplitSwap(on); // the router stores the setting
          } catch (err) {
            p = Promise.reject(err);
          }
          Promise.resolve(p).catch(() => {}).then(() => renderDetail(true));
        });
        const modes = safe(() => r.modes, null);
        const warn = (modes && modes.split && modes.split.note) || 'Turn off Mono audio and Dolby/spatial effects on the phone.';
        return h('div', {},
          section('Split cable', diagram, sw.el,
            note('Plug a stereo-to-dual-mono Y splitter into the headphone socket (or a USB-C adapter): one plug to ' +
              "the speaker's AUX input, one to your headphones. Both sides play in mono. This does not work over Bluetooth."),
            note(warn, 'warn'),
            testButtons(r)));
      };

      const remoteDetail = (r) => {
        const slot = h('div.remote-slot');
        const res = safe(() => mountRemotePanel(slot, { router: r, settings }), null);
        if (res) st.remote = res;
        else slot.append(note("The second-device panel couldn't open. Close Outputs and try again.", 'warn'));
        return section('Second device', slot);
      };

      // ---- levels (built once) ------------------------------------------------------------------------------
      const levelWidgets = [];
      const buildLevels = () => {
        const rows = [
          { key: 'masterVolume', label: 'Main volume', detail: 'The speaker / main mix level.', fmt: fmtPct, def: 0.8,
            set: (v) => app.setMasterVolume(v), hp: false },
          { key: 'cueMix', label: 'Headphone mix', detail: 'Left: only the decks with the headphone button on. Right: the main mix.',
            fmt: fmtCueMix, def: 0, set: (v) => app.setCueMix(v), hp: true },
          { key: 'cueVolume', label: 'Headphone volume', detail: '', fmt: fmtPct, def: 0.8, set: (v) => app.setCueVolume(v), hp: true },
        ];
        const sec = section('Levels');
        for (const row of rows) {
          const sr = sliderRow(row.label, row.detail);
          if (row.hp) st.hpRows.push(sr.el);
          const v0 = Number(app.getSetting(row.key));
          const val = Number.isFinite(v0) ? v0 : row.def;
          sr.valueEl.textContent = row.fmt(val);
          const f = safe(() => new Fader(sr.slot, {
            orientation: 'horizontal', min: 0, max: 1, value: val, defaultValue: row.def, label: row.label.toUpperCase(),
            format: row.fmt, className: 'fader-level',
            onInput: (v) => {
              sr.valueEl.textContent = row.fmt(v);
              row.set(v);
            },
          }), null);
          if (f) levelWidgets.push(f);
          sec.append(sr.el);
        }
        setKids(levels, sec);
      };

      const renderAll = () => {
        renderIntro();
        renderCards();
        renderDetail(true);
      };

      const subscribeRouter = () => {
        if (st.unsubRouter) safe(st.unsubRouter);
        st.unsubRouter = null;
        const r = router();
        if (r && typeof r.on === 'function') {
          st.unsubRouter = r.on('change', () => {
            renderIntro();
            renderCards();
            renderDetail(false);
          });
        }
      };

      buildLevels();
      subscribeRouter();
      renderAll();
      const offs = [];
      if (app.engine && typeof app.engine.on === 'function') {
        const re = () => {
          st.devices = null;
          st.wantRemote = false;
          unmountRemote();
          subscribeRouter();
          renderAll();
        };
        offs.push(app.engine.on('ready', re));
        offs.push(app.engine.on('restarted', re));
      }
      return () => {
        for (const off of offs) safe(off);
        if (st.unsubRouter) safe(st.unsubRouter);
        unmountRemote();
        disposeDetailWidgets();
        for (const w of levelWidgets) if (w && typeof w.destroy === 'function') safe(() => w.destroy());
      };
    },
  };
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    if (fallback === undefined) console.warn('[TwinSpin] outputs:', err);
    return fallback;
  }
}
