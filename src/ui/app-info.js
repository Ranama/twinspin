// App facts for the menu and Settings "About" block: the version, the published build stamp (asked from the
// service worker), the diagnostics report, and the one-time install offer (Android / desktop Chrome prompt, or
// the iPhone "Share, then Add to Home Screen" tip).
//   const { swVersion, cacheName } = await fetchBuildVersion();
//   pre.textContent = formatDiagnostics(collectDiagnostics(app));
//   if (offerInstall(app) === 'later') setTimeout(retry, 30000);

import { env } from '../core/env.js';
import { storageGet, storageSet } from '../core/util.js';
import { isStandalone, canInstall, promptInstall, showIosInstallHint } from './install.js';
import { serverKind } from './sources-text.js';

/** App version shown in the menu and diagnostics (the service worker VERSION adds the build stamp). */
export const APP_VERSION = '1.0.0';

const INSTALL_OFFERED_KEY = 'twinspin.installOffered';

/**
 * Ask the controlling service worker for its VERSION ('version' message, reply on a MessageChannel port, see
 * sw.js) and read the newest TwinSpin cache name as a fallback. Never rejects.
 * @returns {Promise<{swVersion: string, cacheName: string}>}
 */
export function fetchBuildVersion() {
  const out = { swVersion: '', cacheName: '' };
  const fromCaches = () => {
    try {
      if (!globalThis.caches || typeof caches.keys !== 'function') return Promise.resolve();
      return caches.keys().then((keys) => {
        const k = (keys || []).filter((n) => /twinspin/i.test(n) && !/fonts/i.test(n)).sort().pop();
        if (k) out.cacheName = String(k).split(' ')[0];
      }).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  };
  const fromWorker = () => new Promise((resolve) => {
    let ctrl = null;
    try {
      ctrl = navigator.serviceWorker && navigator.serviceWorker.controller; // the getter throws in sandboxes
    } catch {
      ctrl = null;
    }
    if (!ctrl || typeof MessageChannel !== 'function') {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 1500);
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => {
        clearTimeout(timer);
        const d = e && e.data;
        if (d && d.version) out.swVersion = String(d.version).split(' ')[0];
        resolve();
      };
      ctrl.postMessage('version', [ch.port2]);
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
  return Promise.all([fromWorker(), fromCaches()]).then(() => out, () => out);
}

/**
 * The diagnostics report (Settings > About > Diagnostics): app state, engine.diagnostics(), feature flags, decks.
 * @param {object} app the AppUI
 */
export function collectDiagnostics(app) {
  let engineInfo = {};
  try {
    engineInfo = app.engine && typeof app.engine.diagnostics === 'function' ? app.engine.diagnostics() || {} : {};
  } catch (err) {
    engineInfo = { error: String(err && err.message ? err.message : err) };
  }
  const vp = app.viewport || { w: 0, h: 0 };
  const info = app.buildInfo();
  let ua = '';
  try {
    ua = (navigator && navigator.userAgent) || '';
  } catch {
    ua = '';
  }
  return {
    app: {
      version: info.version, build: info.build || '-', layout: app.layout, page: app.page,
      viewport: `${vp.w}x${vp.h}`, dpr: globalThis.devicePixelRatio || 1, standalone: isStandalone(),
      engineState: app.engine ? app.engine.state : '-', output: app.describeOutputs(),
    },
    engine: engineInfo,
    env: {
      secure: env.secure, ios: env.ios, android: env.android, mobile: env.mobile, safari: env.safari, firefox: env.firefox,
      embedded: env.embedded, preview: env.preview, audioWorklet: env.audioWorklet, ctxSetSinkId: env.ctxSetSinkId,
      mediaSetSinkId: env.mediaSetSinkId, webrtc: env.webrtc, serviceWorker: env.serviceWorker, wakeLock: env.wakeLock,
      audioSession: env.audioSession,
    },
    decks: (app.decks || []).map((d) => ({
      id: d.id, loaded: !!d.track, playing: !!d.playing, bpm: d.bpm || '-', rate: d.rate || 1, synced: !!d.synced,
    })),
    library: { persistent: app.library ? app.library.persistent : '-' },
    automix: automixInfo(app),
    player: playerInfo(app),
    sources: sourcesInfo(app),
    userAgent: ua,
  };
}

/**
 * Song sources for the diagnostics block (never throws): whether Google Drive is set up / loaded, and the music
 * server's kind and status (never its address, user or sign-in key: the block may be shared).
 */
function sourcesInfo(app) {
  const src = app.sources || {};
  const out = { drive: '-', server: '-' };
  try {
    const g = src.gdrive;
    if (g) {
      out.drive = !g.configured ? 'not set up' : g.loadError ? 'load failed' : g.ready ? (g.signedIn ? 'ready, signed in' : 'ready')
        : g.loading ? 'loading' : 'set up';
    }
    const s = src.server;
    if (s) {
      const info = s.connected ? s.server || {} : null;
      out.server = info ? `${serverKind(info) || 'server'} (${s.status || 'connected'})` : 'none';
    }
    const lib = app.library;
    if (lib && typeof lib.list === 'function') {
      const all = lib.list() || [];
      out.remoteSongs = all.filter((e) => e && e.source === 'subsonic').length;
      out.driveSongs = all.filter((e) => e && e.source === 'gdrive').length;
    }
  } catch {
    /* partial info is fine */
  }
  return out;
}

/** Auto Mix / set list state for the diagnostics block (never throws). */
function automixInfo(app) {
  const am = app.automix;
  const pl = app.playlist;
  try {
    const plan = am ? am.plan : null;
    return {
      available: !!am,
      enabled: am ? !!am.enabled : false,
      state: am ? am.state : '-',
      currentDeck: am && am.currentDeck !== null && am.currentDeck !== undefined ? am.currentDeck : '-',
      nextReady: am ? !!am.nextReady : false,
      mode: plan && plan.mode ? plan.mode : '-',
      setList: pl ? `${pl.items.length} songs, current ${pl.currentIndex}` : '-',
    };
  } catch {
    return { available: !!am };
  }
}

/** Music player state for the diagnostics block (never throws). */
function playerInfo(app) {
  const p = app.player;
  if (!p) return { available: false };
  try {
    return {
      available: true, state: p.state, shuffle: !!p.shuffle, repeat: p.repeat, transition: p.transition,
      upNext: Array.isArray(p.upNext) ? p.upNext.length : '-',
    };
  } catch {
    return { available: true };
  }
}

/** Flatten a diagnostics object into "a.b: value" lines. */
export function formatDiagnostics(obj) {
  const lines = [];
  const walk = (o, prefix) => {
    for (const k of Object.keys(o || {})) {
      const v = o[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, `${prefix}${k}.`);
      else if (Array.isArray(v)) {
        v.forEach((item, i) => {
          if (item && typeof item === 'object') walk(item, `${prefix}${k}.${i}.`);
          else lines.push(`${prefix}${k}.${i}: ${String(item)}`);
        });
      } else lines.push(`${prefix}${k}: ${String(v)}`);
    }
  };
  walk(obj, '');
  return lines.join('\n');
}

/**
 * Offer installing once per device: Android / desktop Chrome get an "Install" toast (the browser prompt, from the
 * button's click); iPhone / iPad Safari get the Share-menu tip. Waits while audio is off, the first-run tips run
 * or a sheet is open.
 * @param {object} app the AppUI (audioOn, coachFlow, sheets, toast())
 * @returns {'none'|'later'|'done'} 'later': call again in a while
 */
export function offerInstall(app) {
  const prompt = canInstall();
  const iosHint = !prompt && showIosInstallHint();
  if ((!prompt && !iosHint) || storageGet(INSTALL_OFFERED_KEY, false)) return 'none';
  if (!app.audioOn || (app.coachFlow && app.coachFlow.active) || (app.sheets && app.sheets.isOpen)) return 'later';
  storageSet(INSTALL_OFFERED_KEY, true);
  if (iosHint) {
    // the menu keeps this hint too
    app.toast('Tip: tap Share, then “Add to Home Screen”. TwinSpin then opens full screen and keeps your songs.', {
      timeout: 12000,
    });
    return 'done';
  }
  app.toast('Install TwinSpin: it opens full screen like an app and keeps your songs.', {
    timeout: 12000,
    action: {
      label: 'Install',
      onClick: () => promptInstall().then((ok) => {
        if (ok) app.toast('Installed. Open TwinSpin from your home screen.', { kind: 'ok' });
      }),
    },
  });
  return 'done';
}
