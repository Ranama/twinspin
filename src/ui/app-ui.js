// AppUI: builds and runs everything the user sees outside the widgets. It creates the app shell (header chips,
// waveforms, two decks, mixer, FX panels, songs + set list, the music player page, crossfader, Auto Mix strip,
// tabs), picks one of four layouts from the viewport (pp phone portrait, pl phone landscape, tp tablet portrait,
// console tablet landscape / desktop; CSS does the placement from data-layout), runs the single
// requestAnimationFrame loop, binds widgets to the Deck / Mixer / SyncController / AutoMix / Playlist / Player
// APIs, and shows the start overlay, resume banner, toasts, confirm dialog, coach marks and sheets.
//   const ui = new AppUI({ root, engine, decks, sync, settings, library, playlist, automix, player, sources });
// Contract: docs/CONTRACT.md section 6.4, docs/AUTOMIX.md section 5, docs/PLAYER.md section 5 and docs/SOURCES.md
// section 4 (song sources: the Add music sheet, Google Drive, the music server browser; sources-ui.js). Widgets come
// from ./widgets/*.js.

import { h, icon, setText, setClass, setAttr, trackHold, guard } from './dom.js';
import {
  pickLayout, computeSizes, cssVars, knobStyle, effectivePage, tabsFor, visibility, automixPlacement, playerBox,
  playerLayout, stripFit, stripWidth,
} from './layout-math.js';
import { stepZoom, songTitle } from './format.js';
import { DeckUI } from './deck-ui.js';
import { MixerUI } from './mixer-ui.js';
import { FxUI } from './fx-ui.js';
import { SongsUI } from './songs-ui.js';
import { AutomixUI } from './automix-ui.js';
import { PlayerUI } from './player-ui.js';
import { songActionText } from './player-text.js';
import { Toasts, Dialog, StartOverlay, ResumeBanner, Coach } from './overlays.js';
import { SheetHost } from './sheets/sheet.js';
import { menuSheet } from './sheets/menu-sheet.js';
import { outputsSheet } from './sheets/outputs-sheet.js';
import { deckSheet } from './sheets/deck-sheet.js';
import { bindKeyboard } from './keyboard.js';
import { TrackLoader } from './track-loader.js';
import { CoachFlow } from './coach-flow.js';
import { SourcesUI } from './sources-ui.js';
import { onInstallChange } from './install.js';
import { APP_VERSION, fetchBuildVersion, collectDiagnostics, offerInstall } from './app-info.js';
import { WaveView, OverviewView } from './widgets/waveview.js';
import { env, setHaptics } from '../core/env.js';
import { clamp } from '../core/util.js';

/** Re-exported for older callers; the version lives in app-info.js. */
export { APP_VERSION };

const TAB_DEFS = {
  decks: { label: 'DECKS', icon: 'decks' },
  mix: { label: 'MIX', icon: 'mix' },
  fx: { label: 'FX', icon: 'fx' },
  songs: { label: 'SONGS', icon: 'songs' },
  player: { label: 'PLAYER', icon: 'player' },
};

/** Frames between refreshes of the PLAYER tab / header button light. */
const INDICATOR_EVERY = 6;

export class AppUI {
  /**
   * @param {{root:HTMLElement, engine:object, decks:object[], sync:object, settings:object, library:object,
   *          playlist?:object, automix?:object, player?:object, sources?:{gdrive?:object, server?:object}}} deps
   *          playlist / automix / player:
   *          src/deck/playlist.js, automix.js, player.js (optional: without them the set list, Auto Mix and
   *          player controls stay hidden; the player needs the other two); sources: src/sources/gdrive.js
   *          GoogleDriveSource and subsonic.js MusicServerSource (optional: the Add music sheet explains)
   */
  constructor({ root, engine, decks, sync, settings, library, playlist = null, automix = null, player = null, sources = null }) {
    this.root = root;
    this.engine = engine;
    this.decks = decks;
    this.sync = sync;
    this.settings = settings;
    this.library = library;
    this.playlist = playlist || null;
    this.automix = automix || null;
    this.player = this.playlist && this.automix && player ? player : null;
    this.sources = { gdrive: (sources && sources.gdrive) || null, server: (sources && sources.server) || null };
    this.html = document.documentElement;
    this._amRow = false;

    this.layout = null;
    this.page = 'decks';
    this.sizes = null;
    this.xfade = 0;
    this.audioOn = false;
    this.starting = false;
    this.lastDeckError = [0, 0];
    this.lastErrorAt = {};
    this.pending = {};
    this.pflHintShown = false;
    this._vars = {};
    this._frameCount = 0;
    this._router = null;
    this._routerOffs = [];
    this._cacheName = '';
    this._swVersion = '';
    this._saveTimer = 0;
    this._measureQueued = false;
    this._restarting = false;
    this.vis = null;

    setHaptics(settings.get('haptics'));
    this.html.dataset.outdoor = settings.get('outdoor') ? '1' : '0';
    root.dataset.fxdeck = settings.get('fxDeck') === 'B' ? 'B' : 'A';
    root.dataset.audio = 'off';
    if (env.ios) this.html.dataset.ios = '1';
    if (env.touch) this.html.dataset.touch = '1';

    this._build();
    this._bindModels();
    this._bindWindow();
    this.unbindKeys = bindKeyboard(this);
    this._measure();
    this.songs.render();
    if (engine && engine.ready) this._onEngineReady();
    this._offInstall = onInstallChange(() => this._offerInstall());
    this._frameFn = () => this._frame();
    this._renderDeck = [0, 1].map((i) => () => this.deckUIs[i].render(!this.vis || this.vis.decks));
    this._renderFx = [0, 1].map((i) => () => this.fxUIs[i].render());
    this._renderWave = () => this.wave.render();
    this._renderOv = [0, 1].map((i) => () => this.overviews[i].render());
    this._renderMixer = () => {
      const eng = this.engine;
      const shown = !!this.vis && this.vis.mixer && this.audioOn;
      this.mixer.render(shown, eng && eng.ready ? eng.mixer : null);
    };
    this._renderAm = () => this.amui.render();
    this._renderPlayer = () => this.playerUI.render();
    this._renderIndicator = () => this._playerIndicator();
    this._raf = requestAnimationFrame(this._frameFn);
  }

  // ---- build ------------------------------------------------------------------------------------------------

  _build() {
    const root = this.root;
    this.loader = new TrackLoader(this);
    while (root.firstChild) root.removeChild(root.firstChild);
    root.classList.add('ts-app');

    this.deckUIs = [new DeckUI(this, 0), new DeckUI(this, 1)];
    this.mixer = new MixerUI(this);
    this.fxUIs = [new FxUI(this, 0), new FxUI(this, 1)];
    this.songs = new SongsUI(this);

    // Header: deck A chip | tools | deck B chip
    this.outChipText = h('span.out-chip-text', { text: 'Audio off' });
    this.outChip = h('button.out-chip', { type: 'button', 'aria-label': 'Outputs and headphones' }, icon('outputs'), this.outChipText);
    this.outChip.addEventListener('click', () => this.openOutputs());
    this.hbFx = h('button.hbtn.hb-fx', { type: 'button', 'aria-label': 'Effects and loops', 'aria-pressed': 'false' },
      icon('fx'), h('span.hb-text', { text: 'FX' }));
    this.hbSongs = h('button.hbtn.hb-songs', { type: 'button', 'aria-label': 'Songs', 'aria-pressed': 'false' },
      icon('songs'), h('span.hb-text', { text: 'SONGS' }));
    this.hbPlayer = h('button.hbtn.hb-player',
      { type: 'button', 'aria-label': 'Music player', 'aria-pressed': 'false', hidden: !this.player },
      icon('player'), h('span.hb-text', { text: 'PLAYER' }), h('span.live-dot', { 'aria-hidden': 'true' }));
    this.hbMenu = h('button.hbtn.hb-menu', { type: 'button', 'aria-label': 'Menu: outputs, settings, help' }, icon('menu'));
    this.hbFx.addEventListener('click', () => this.setPage('fx'));
    this.hbSongs.addEventListener('click', () => this.setPage('songs'));
    this.hbPlayer.addEventListener('click', () => this.setPage('player'));
    this.hbMenu.addEventListener('click', () => this.openMenu());
    const brand = h('span.brand', { 'aria-hidden': 'true' }, h('span.brand-disc'), h('span.brand-twin', { text: 'Twin' }),
      h('span.brand-spin', { text: 'Spin' }));
    this.header = h('header.hdr', {}, this.deckUIs[0].chip,
      h('div.hdr-mid', {}, brand, this.outChip, this.hbFx, this.hbSongs, this.hbPlayer, this.hbMenu), this.deckUIs[1].chip);

    // Waveforms: A overview, zoomed lanes (one canvas, both decks), B overview
    this.ovCanvas = [h('canvas.ov.ov-a', { 'aria-label': 'Deck A whole-song overview. Tap to jump.' }),
      h('canvas.ov.ov-b', { 'aria-label': 'Deck B whole-song overview. Tap to jump.' })];
    this.waveCanvas = h('canvas.wave', { 'aria-label': 'Scrolling waveforms: deck A above, deck B below' });
    const zIn = h('button.zbtn', { type: 'button', 'aria-label': 'Zoom in (fewer seconds)' }, icon('zoomIn'));
    const zOut = h('button.zbtn', { type: 'button', 'aria-label': 'Zoom out (more seconds)' }, icon('zoomOut'));
    zIn.addEventListener('click', () => this._zoom(-1));
    zOut.addEventListener('click', () => this._zoom(1));
    this.waves = h('section.waves', { 'aria-label': 'Waveforms' },
      trackHold(h('div.ov-wrap.ov-wrap-a', {}, this.ovCanvas[0])),
      trackHold(h('div.wave-wrap', {}, this.waveCanvas, h('div.zoom', {}, zIn, zOut))),
      trackHold(h('div.ov-wrap.ov-wrap-b', {}, this.ovCanvas[1])));

    // Bottom tab bar (phone/tablet portrait): DECKS MIX FX SONGS PLAYER on phones (with no Player the AUTO MIX
    // switch takes the last place), MIX FX SONGS PLAYER + the AUTO MIX switch on tablets: never more than five.
    this.amui = new AutomixUI(this);
    this.playerUI = new PlayerUI(this);
    this.tabBtns = {};
    this.tabs = h('nav.tabs', { 'aria-label': 'Pages' }, Object.keys(TAB_DEFS).map((p) => {
      const d = TAB_DEFS[p];
      const b = h(`button.tab.tab-${p}`, { type: 'button', dataset: { page: p } }, icon(d.icon, 'tab-ico'),
        h('span.tab-text', { text: d.label }), p === 'player' ? h('span.live-dot', { 'aria-hidden': 'true' }) : null);
      b.addEventListener('click', () => this.setPage(p));
      this.tabBtns[p] = b;
      return b;
    }), this.amui.tabBtn);
    this.songs.setList.el.hidden = !this.playlist;
    this.amui.addTarget(this.songs.setList);

    this.shell = h('div.shell', {}, this.header, this.waves, this.deckUIs[0].el, this.deckUIs[1].el, this.mixer.el,
      this.fxUIs[0].el, this.fxUIs[1].el, this.songs.el, this.playerUI.el, this.amui.el, this.mixer.xfEl, this.tabs);
    this.overlay = h('div.overlays');
    this.probe = h('div.inset-probe', { 'aria-hidden': 'true' });
    root.append(this.shell, this.overlay, this.probe);

    this.toasts = new Toasts(this.overlay);
    this.sheets = new SheetHost(this.overlay, { onToggle: (open) => this._setInert(open) });
    this.coach = new Coach(this.overlay);
    this.coachFlow = new CoachFlow(this, this.coach);
    this.banner = new ResumeBanner(this.overlay, { onResume: () => this.resumeAudio(), onRestart: () => this.restartAudio() });
    this.dialog = new Dialog(this.overlay);
    this.sourcesUI = new SourcesUI(this);
    this.startOverlay = new StartOverlay(this.overlay, { onStart: () => this.start(false), onDemo: () => this.start(true) });
    this._setInert(true);

    const decks = this.decks;
    this.wave = guard('WaveView', () => new WaveView(this.waveCanvas, { decks, settings: this.settings })) || null;
    this.overviews = [0, 1].map((i) => guard('OverviewView', () => new OverviewView(this.ovCanvas[i], { deck: decks[i] })) || null);
  }

  _setInert(on) {
    const blocked = on || (this.startOverlay && this.startOverlay.visible);
    try {
      this.shell.inert = !!blocked;
    } catch {
      /* ignore */
    }
    if (blocked) this.shell.setAttribute('aria-hidden', 'true');
    else this.shell.removeAttribute('aria-hidden');
    this.root.dataset.sheet = this.sheets && this.sheets.isOpen ? '1' : '0';
  }

  // ---- model bindings ---------------------------------------------------------------------------------------

  _bindModels() {
    this.decks.forEach((d, i) => {
      if (!d || typeof d.on !== 'function') return;
      d.on('change', (what) => {
        this.deckUIs[i].markDirty();
        this.fxUIs[i].markDirty();
        this.mixer.markDirty();
        if (what === 'track' || what === 'loading') this.songs.render();
        if (what === 'bpm' || what === 'analysis' || what === 'track') this.loader.syncLibraryMeta(i);
      });
      d.on('error', (msg) => {
        this.lastDeckError[i] = Date.now();
        this.toast(msg, { kind: 'error', deck: d.id });
      });
    });
    if (this.sync && typeof this.sync.on === 'function') {
      this.sync.on('change', () => this.deckUIs.forEach((u) => u.markDirty()));
      this.sync.on('error', (msg) => this.toast(msg, { kind: 'error' }));
    }
    if (this.library && typeof this.library.on === 'function') {
      this.library.on('change', () => this.songs.render());
      this.library.on('error', (msg) => this.toast(msg, { kind: 'error' }));
    }
    this.amui.bind();
    this.playerUI.bind();
    this.sourcesUI.bind();
    const eng = this.engine;
    if (eng && typeof eng.on === 'function') {
      eng.on('ready', () => this._onEngineReady());
      eng.on('restarted', () => {
        this._restarting = false;
        this._attachEngine();
        this.banner.hide();
        this.toast('Audio restarted', { kind: 'ok' });
      });
      eng.on('statechange', (state) => this._onAudioState(state));
      eng.on('error', (msg) => {
        this.lastErrorAt.engine = Date.now();
        // Before audio runs the start overlay is on top: say it there instead of in a toast behind it.
        if (!this.audioOn && this.startOverlay && this.startOverlay.visible) this.startOverlay.showError(msg);
        else this.toast(msg, { kind: 'error' });
      });
    }
    this.settings.on('change', (key, value) => this._onSetting(key, value));
  }

  _onSetting(key, value) {
    switch (key) {
      case 'outdoor': this.html.dataset.outdoor = value ? '1' : '0'; break;
      case 'haptics': setHaptics(value); break;
      case 'page':
      case 'fxDeck': this._applyPage(); break;
      case 'masterVolume':
      case 'cueVolume':
      case 'cueMix': this.mixer.markDirty(); break;
      case 'xfadeCurve': {
        const m = this.engine && this.engine.ready ? this.engine.mixer : null;
        if (m) guard('xfade curve', () => m.setCrossfaderCurve(value));
        this.mixer.setCurve(value);
        break;
      }
      case 'outputMode': this._updateOutChip(); break;
      case 'mixBeats': this.songs.setList.renderOptions(); break;
      case 'transitionStyle':
      case 'crossfadeSec':
      case 'playerShuffle':
      case 'playerRepeat': this.playerUI.markDirty(); break;
      case 'setList':
      case 'automixReturn':
      case 'automixBassSwap': break;
      default: this.deckUIs.forEach((u) => u.markDirty());
    }
  }

  _bindWindow() {
    const queue = () => {
      if (this._measureQueued) return;
      this._measureQueued = true;
      requestAnimationFrame(() => this._measure());
    };
    this._queueMeasure = queue;
    window.addEventListener('resize', queue);
    window.addEventListener('orientationchange', () => {
      queue();
      setTimeout(queue, 300);
    });
    if (window.visualViewport) window.visualViewport.addEventListener('resize', queue);
    // iOS Home Screen apps can report a short innerHeight right after launch: measure again.
    setTimeout(queue, 300);
    setTimeout(queue, 1000);
    window.addEventListener('pageshow', queue);

    // Gesture suppression: iOS pinch, long-press menus inside controls, and file drops outside the decks.
    const prevent = (e) => e.preventDefault();
    document.addEventListener('gesturestart', prevent, { passive: false });
    document.addEventListener('gesturechange', prevent, { passive: false });
    this.root.addEventListener('contextmenu', (e) => {
      const t = e.target;
      if (t && t.closest && t.closest('input, textarea, .diag, .selectable')) return;
      e.preventDefault();
    });
    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      this.addFiles(Array.from(e.dataTransfer.files));
    });

    const flush = () => this.flushSettings();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        flush();
        return;
      }
      queue();
      // Back from the background: give the engine's own resume a moment, then offer the banner if still silent.
      clearTimeout(this._visTimer);
      this._visTimer = setTimeout(() => {
        const eng = this.engine;
        if (eng && !document.hidden) this._onAudioState(eng.state);
      }, 1200);
    });
  }

  // ---- layout -----------------------------------------------------------------------------------------------

  _insets() {
    try {
      const cs = getComputedStyle(this.probe);
      const px = (v) => {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : 0;
      };
      return { t: px(cs.paddingTop), r: px(cs.paddingRight), b: px(cs.paddingBottom), l: px(cs.paddingLeft) };
    } catch {
      return { t: 0, r: 0, b: 0, l: 0 };
    }
  }

  _measure() {
    this._measureQueued = false;
    const de = document.documentElement;
    const vv = window.visualViewport;
    let w = window.innerWidth || de.clientWidth || 0;
    let hgt = window.innerHeight || de.clientHeight || 0;
    if ((!w || !hgt) && vv) {
      w = vv.width;
      hgt = vv.height;
    }
    w = Math.round(w || 360);
    hgt = Math.round(hgt || 640);
    const layout = pickLayout(w, hgt);
    const prevLayout = this.layout;
    this._measuring = true;
    const savedPage = this.settings.get('page');
    if (layout !== prevLayout && layout === 'console' && (savedPage === 'songs' || savedPage === 'player')) {
      // The songs / player page of a phone layout (or of the last visit) must not come back as an open drawer over
      // the desktop decks: a drawer opens only when asked for in this layout. (The 'page' setting event re-applies
      // the page; the layout switch below applies it again for the new layout.)
      try {
        this.settings.set('page', 'mix');
      } catch {
        /* ignore */
      }
    }
    this._measuring = false;
    const place = automixPlacement(layout, this._pageFor(layout), this.amui.enabled && !!this.automix, { player: !!this.player });
    this._amRow = place.row;
    const s = computeSizes(layout, w, hgt, this._insets(), { am: place.row });
    this.sizes = s;
    const pb = playerBox(s);
    this.playerUI.setLayout(playerLayout(pb.w, pb.h));
    this.amui.setFit(stripFit(stripWidth(s), { toggle: place.where === 'xf' }));
    this.viewport = { w, h: hgt };
    const vars = cssVars(s);
    vars['--app-h'] = `${hgt}px`;
    for (const k of Object.keys(vars)) {
      if (this._vars[k] !== vars[k]) {
        this._vars[k] = vars[k];
        de.style.setProperty(k, vars[k]);
      }
    }
    this.root.dataset.quick = s.quick ? '1' : '0';
    this.root.dataset.compact = s.compact ? '1' : '0';
    this.root.dataset.am = place.row ? '1' : '0';
    this.root.dataset.fxrows = String(s.fxRows || 2);
    if (layout !== prevLayout) {
      this.layout = layout;
      de.dataset.layout = layout;
      this._applyPage();
    }
    this.mixer.setKnobStyle(knobStyle(layout), s.knob);
    this.coach.place();
  }

  /** The page settings.page means in a layout (the player page only exists with a Player). */
  _pageFor(layout) {
    const page = effectivePage(layout, this.settings.get('page'));
    return page === 'player' && !this.player ? effectivePage(layout, 'decks') : page;
  }

  /** Apply settings.page / fxDeck to the DOM for the current layout. */
  _applyPage() {
    const layout = this.layout || 'pp';
    const page = this._pageFor(layout);
    this.page = page;
    this.root.dataset.page = page;
    const fxDeck = this.settings.get('fxDeck') === 'B' ? 'B' : 'A';
    this.root.dataset.fxdeck = fxDeck;
    for (const f of this.fxUIs) f.setTarget(fxDeck);
    const vis = visibility(layout, page, fxDeck);
    this.vis = vis;
    this.deckUIs[0].el.hidden = !vis.decks;
    this.deckUIs[1].el.hidden = !vis.decks;
    this.mixer.el.hidden = !vis.mixer;
    this.fxUIs[0].el.hidden = !vis.fxA;
    this.fxUIs[1].el.hidden = !vis.fxB;
    this.songs.el.hidden = !vis.songs;
    this.playerUI.el.hidden = !vis.player || !this.player;
    this.waves.hidden = !vis.waves;
    this.tabs.hidden = !vis.tabs;
    this.mixer.xfEl.hidden = !vis.xf;
    const tabs = tabsFor(layout);
    for (const p of Object.keys(this.tabBtns)) {
      const b = this.tabBtns[p];
      b.hidden = !tabs.includes(p) || (p === 'player' && !this.player);
      setAttr(b, 'aria-current', p === page ? 'page' : null);
      setClass(b, 'on', p === page);
    }
    setAttr(this.hbFx, 'aria-pressed', page === 'fx' ? 'true' : 'false');
    setAttr(this.hbSongs, 'aria-pressed', page === 'songs' ? 'true' : 'false');
    setAttr(this.hbPlayer, 'aria-pressed', page === 'player' ? 'true' : 'false');
    this.hbPlayer.hidden = !this.player;
    if (page === 'songs') this.songs.render();
    if (page === 'player') this.playerUI.markListDirty();
    this._applyAutomix();
    this.mixer.markDirty();
    this.fxUIs.forEach((f) => f.markDirty());
    this.coach.place();
  }

  /** Place and show the Auto Mix strip for the layout / page; re-measure when its row appears or goes. */
  _applyAutomix() {
    const layout = this.layout || 'pp';
    const place = automixPlacement(layout, this.page, this.amui.enabled, { player: !!this.player });
    this.amui.place(place.where, { shell: this.shell, waves: this.waves, xf: this.mixer.xfEl });
    this.amui.setShown(place.show && !!this.automix);
    this.amui.tabBtn.hidden = !this.automix || !place.tabToggle;
    // the strip row appeared or went: re-run the pixel budget now (same layout, so no recursion back here)
    if (place.row !== this._amRow && this.layout && !this._measuring) this._measure();
  }

  /** AutoMix 'change' / 'takeover' / 'finished': badges, strip placement, markers. */
  onAutomixChange() {
    this.amui.markDirty();
    this.playerUI.markDirty();
    this.songs.setList.updateBadges();
    this._applyAutomix();
  }

  /** Show a page (phones/tablets) or toggle FX / SONGS / PLAYER (phone landscape, desktop). */
  setPage(p) {
    let next = p;
    if ((this.layout === 'pl' || this.layout === 'console') && next === this.page && next !== 'mix') next = 'mix';
    if (this.layout === 'tp' && next === 'decks') next = 'mix';
    try {
      this.settings.set('page', next);
    } catch {
      /* ignore */
    }
    this._applyPage();
  }

  /** Point the single-panel FX page at deck 'A' or 'B'. */
  setFxDeck(id) {
    try {
      this.settings.set('fxDeck', id === 'B' ? 'B' : 'A');
    } catch {
      /* ignore */
    }
    this._applyPage();
  }

  /** Open the songs page/sheet/drawer. */
  showSongs() {
    if (effectivePage(this.layout, 'songs') !== this.page) this.setPage('songs');
  }

  /** Open the player page/drawer (when there is a Player). */
  showPlayer() {
    if (!this.player) return;
    if (effectivePage(this.layout, 'player') !== this.page) this.setPage('player');
  }

  // ---- music player (the work is in player-ui.js; the Player itself is src/deck/player.js) -----------------------

  /** Play / pause the queue (big play button, the strip, Space on the player page). */
  playerToggle() {
    this.playerUI.togglePlay();
  }

  /** Next song (the strip, key N). */
  playerNext() {
    this.playerUI.next();
  }

  /** Previous song, or the start of this one (the strip, key B). */
  playerPrevious() {
    this.playerUI.previous();
  }

  /** Keys N / B act while the player page is open or the queue is playing. */
  playerKeysActive() {
    if (!this.player) return false;
    if (this.page === 'player') return true;
    try {
      const st = this.player.state;
      return !!st && st !== 'stopped';
    } catch {
      return false;
    }
  }

  /**
   * A Songs page ⋯ action for a library entry or { kind: 'demo', id, ... }: 'now' (Play now), 'next' (Play next)
   * or 'queue' (Add to queue). Toasts what happened.
   */
  songAction(kind, entry) {
    const p = this.player;
    if (!p || !entry) return;
    const title = songTitle(entry);
    const method = kind === 'now' ? 'playNow' : kind === 'next' ? 'playNext' : 'addToQueue';
    if (typeof p[method] !== 'function') return;
    if (kind === 'now' && !(this.engine && this.engine.ready)) {
      this.toast('Tap Start first so TwinSpin can play sound.', { kind: 'error' });
      return;
    }
    let res;
    try {
      res = p[method](entry);
    } catch (err) {
      console.warn('[TwinSpin] player action failed', err);
      this.toast("That song couldn't be queued. Try again.", { kind: 'error' });
      return;
    }
    if (Array.isArray(res) && !res.length) {
      this.toast('The queue is full. Remove some songs first.', { kind: 'error' });
      return;
    }
    const opts = { kind: 'ok' };
    if (this.page !== 'player') opts.action = { label: 'Player', onClick: () => this.showPlayer() };
    this.toast(songActionText(kind, title), opts);
    this.playerUI.markListDirty();
  }

  /** The PLAYER tab / header button light up while the queue plays (every few frames). */
  _playerIndicator() {
    const st = this.playerUI.indicator();
    for (const el of [this.tabBtns.player, this.hbPlayer]) {
      setClass(el, 'live', st === 'live');
      setClass(el, 'paused', st === 'paused');
    }
  }

  openMenu() {
    this.sheets.open(menuSheet(this));
  }

  /** The Add music sheet: This device, Google Drive, music server / NAS, a Drive link, other ways. */
  openAddMusic() {
    this.sourcesUI.openAddMusic();
  }

  /** The music server browser (its connect form when no server is connected). */
  openMusicServer() {
    this.sourcesUI.openServer();
  }

  openOutputs() {
    this.sheets.open(outputsSheet(this));
  }

  openDeckSheet(i) {
    this.sheets.open(deckSheet(this, i));
  }

  _zoom(dir) {
    const w = this.wave;
    if (w && typeof w.zoomIn === 'function' && typeof w.zoomOut === 'function') {
      guard('zoom', () => (dir < 0 ? w.zoomIn() : w.zoomOut()));
      return;
    }
    try {
      this.settings.set('waveZoom', stepZoom(this.settings.get('waveZoom'), dir));
    } catch {
      /* ignore */
    }
  }

  // ---- audio start / state ------------------------------------------------------------------------------------

  /** Start overlay click. Calls engine.start() synchronously inside the click (iOS needs the gesture). */
  start(withDemos) {
    const eng = this.engine;
    if (!eng) return;
    if (this.starting) {
      // A second tap while starting: give a stuck context another resume() inside this gesture.
      if (eng.state === 'suspended' || eng.state === 'interrupted') guard('resume', () => eng.resume());
      return;
    }
    // Busy text first: the engine may report a failure synchronously (its 'error' text must stay visible).
    this.starting = true;
    this.startOverlay.setBusy(true, withDemos ? 'Starting audio and making the demo tracks…' : 'Starting audio…');
    let p;
    try {
      p = eng.start(); // synchronously inside the click (iOS needs the gesture to create/resume the context)
    } catch (err) {
      p = Promise.reject(err);
    }
    const slow = setTimeout(() => {
      if (!this.starting) return;
      this.startOverlay.setBusy(false, 'Audio is taking long to start. Tap again, close other apps that play sound, or reload the page.');
    }, 8000);
    Promise.resolve(p)
      .then(() => {
        clearTimeout(slow);
        this.starting = false;
        this._onEngineReady();
        if (withDemos) this.loader.loadDemos();
      })
      .catch((err) => {
        clearTimeout(slow);
        this.starting = false;
        console.error('[TwinSpin] audio start failed', err);
        const noAudio = typeof window.AudioContext !== 'function' && typeof window.webkitAudioContext !== 'function';
        if (Date.now() - (this.lastErrorAt.engine || 0) <= 3000) {
          // the engine explained the failure itself: its 'error' message is already on the overlay
          this.startOverlay.setBusy(false);
        } else if (noAudio) {
          this.startOverlay.showError("This browser can't play audio from web pages. Update it, or try Chrome or Safari.");
        } else {
          this.startOverlay.showError("Audio couldn't start. Tap to try again. If it keeps failing, reload the page.");
        }
      });
  }

  get startOverlayVisible() {
    return !!this.startOverlay && this.startOverlay.visible;
  }

  _onEngineReady() {
    if (!this.audioOn) {
      this.audioOn = true;
      this.root.dataset.audio = 'on';
      this.startOverlay.hide();
      this._setInert(this.sheets.isOpen);
      setTimeout(() => this.startCoach(false), 600);
      clearTimeout(this._installTimer);
      this._installTimer = setTimeout(() => this._offerInstall(), 90000);
    }
    this._attachEngine();
  }

  _attachEngine() {
    const eng = this.engine;
    const r = eng ? eng.outputs : null;
    if (r !== this._router) {
      for (const off of this._routerOffs) guard('router off', off);
      this._routerOffs = [];
      this._router = r;
      if (r && typeof r.on === 'function') {
        this._routerOffs.push(r.on('change', () => this._updateOutChip()));
        this._routerOffs.push(r.on('error', (msg) => {
          this.lastErrorAt.router = Date.now();
          this.toast(msg, { kind: 'error' });
        }));
      }
    }
    const m = eng && eng.ready ? eng.mixer : null;
    // restoring the crossfader on a new engine is not a user move (Auto Mix must not read it as a takeover)
    if (m) guard('crossfader', () => m.setCrossfader(this.xfade, { source: 'restore' }));
    this._updateOutChip();
    this.mixer.markDirty();
    this.deckUIs.forEach((u) => u.markDirty());
  }

  _onAudioState(state) {
    this.root.dataset.audioState = state || '';
    if (!this.audioOn) return;
    if (state === 'starting' || state === 'running') {
      this.banner.hide();
      return;
    }
    // A restart closes the old context on purpose: no "Audio stopped" flash while it rebuilds.
    if (this._restarting && state === 'closed') return;
    if (state === 'suspended' || state === 'interrupted' || state === 'closed') {
      // Hidden tab: the system suspends audio on purpose; show the banner when the user comes back.
      if (document.hidden) return;
      this.banner.show(state);
    }
  }

  /** Resume banner button (click). */
  resumeAudio() {
    const eng = this.engine;
    let p;
    try {
      p = eng.resume();
    } catch (err) {
      p = Promise.reject(err);
    }
    Promise.resolve(p)
      .then(() => {
        if (eng.state === 'running' || !eng.state) this.banner.hide();
      })
      .catch(() => this.toast("Sound couldn't resume. Tap Restart audio.", { kind: 'error' }));
  }

  /** Restart audio (click): rebuilds the AudioContext; decks reload their songs. */
  restartAudio() {
    const eng = this.engine;
    if (!eng) return;
    if (!this.audioOn) {
      this.start(false);
      return;
    }
    this._restarting = true;
    let p;
    try {
      p = eng.restart();
    } catch (err) {
      p = Promise.reject(err);
    }
    this.banner.hide();
    this.toast('Restarting audio…');
    Promise.resolve(p)
      .catch((err) => {
        console.error('[TwinSpin] restart failed', err);
        this.toast("Audio couldn't restart. Reload the page.", { kind: 'error' });
      })
      .then(() => {
        this._restarting = false;
      });
  }

  // ---- loading (TrackLoader does the work; these are the entry points other UI parts call) -----------------------

  /** Load-lock confirm before replacing a playing, audible song. */
  confirmReplace(deck) {
    return this.loader.confirmReplace(deck);
  }

  /** Files picked or dropped for a deck. */
  loadFiles(index, files) {
    return this.loader.loadFiles(index, files);
  }

  /** Add music > This device, a Google Drive import, or a drop outside the decks. */
  addFiles(files) {
    return this.loader.addFiles(files);
  }

  /** A library row's A / B button. */
  loadFromLibrary(index, entry) {
    return this.loader.loadFromLibrary(index, entry);
  }

  /** A demo row's A / B button. */
  loadDemo(index, id) {
    return this.loader.loadDemo(index, id);
  }

  /** Library ids of the songs on the decks (for the Songs list markers). */
  get libIds() {
    return this.loader.libIds;
  }

  // ---- mixer actions ------------------------------------------------------------------------------------------

  /**
   * The user moved the crossfader (drag, keys). Auto Mix hears about it first, so a move during a scheduled mix
   * cancels the automation where it is ("You took over the mix") before the new value is set.
   */
  setCrossfader(v) {
    const x = clamp(Number.isFinite(v) ? v : 0, -1, 1);
    this.xfade = x;
    const am = this.automix;
    if (am && typeof am.noteUserCrossfader === 'function') guard('automix crossfader', () => am.noteUserCrossfader(x));
    const m = this.engine && this.engine.ready ? this.engine.mixer : null;
    if (m) guard('crossfader', () => m.setCrossfader(x));
    this.mixer.markDirty();
  }

  // ---- Auto Mix + set list (the work is in automix-ui.js) -------------------------------------------------------

  /** AUTO switch (tab bar, strip, Songs card, key M). */
  toggleAutomix() {
    this.amui.setEnabled(!this.amui.enabled);
  }

  /** Switch Auto Mix on or off (needs running audio; AutoMix explains an empty set list itself). */
  setAutomix(on) {
    this.amui.setEnabled(on);
  }

  /** MIX NOW: start the transition at the next bar. */
  mixNow() {
    this.amui.mixNow();
  }

  /** Add songs (library entries or { kind: 'demo', id }) to the end of the set list; returns how many. */
  addToSetList(entries, opts) {
    return this.amui.addToSetList(entries, opts);
  }

  /** A set list row's A / B button. */
  loadSetListItem(index, item) {
    return this.loader.loadSetListItem(index, item);
  }

  setMasterVolume(v) {
    const m = this.engine && this.engine.ready ? this.engine.mixer : null;
    if (m) guard('master volume', () => m.setMasterVolume(v));
    this.saveSettingSoon('masterVolume', v);
  }

  setCueVolume(v) {
    const m = this.engine && this.engine.ready ? this.engine.mixer : null;
    if (m) guard('cue volume', () => m.setCueVolume(v));
    this.saveSettingSoon('cueVolume', v);
  }

  setCueMix(v) {
    const m = this.engine && this.engine.ready ? this.engine.mixer : null;
    if (m) guard('cue mix', () => m.setCueMix(v));
    this.saveSettingSoon('cueMix', v);
  }

  /** Headphone PFL toggle for a deck. */
  togglePfl(i) {
    const d = this.decks[i];
    if (!d) return;
    const on = !(d.mix && d.mix.cue);
    guard('pfl', () => d.setCue(on));
    this.mixer.markDirty();
    this.deckUIs[i].markDirty();
    const r = this.engine && this.engine.ready ? this.engine.outputs : null;
    let hint = null;
    if (r) {
      try {
        hint = 'hint' in r ? r.hint : r.mode === 'single' ? 'Headphone pre-listen needs a second output. Open Outputs.' : null;
      } catch {
        hint = null;
      }
    } else if (this.settings.get('outputMode') === 'single') {
      hint = 'Headphone pre-listen needs a second output. Open Outputs.';
    }
    if (on && hint && !this.pflHintShown) {
      this.pflHintShown = true;
      this.toast(hint, { action: { label: 'Outputs', onClick: () => this.openOutputs() } });
    }
  }

  /** Re-apply the mixer-related settings (after a settings reset). */
  applySettingsToEngine() {
    const m = this.engine && this.engine.ready ? this.engine.mixer : null;
    this.pending = {};
    if (m) {
      guard('apply settings', () => {
        m.setMasterVolume(this.settings.get('masterVolume'));
        m.setCueVolume(this.settings.get('cueVolume'));
        m.setCueMix(this.settings.get('cueMix'));
        m.setCrossfaderCurve(this.settings.get('xfadeCurve'));
      });
    }
    this.mixer.markDirty();
  }

  // ---- settings writes (debounced for continuous controls) ----------------------------------------------------

  /** Current value of a setting including not-yet-saved continuous edits. */
  getSetting(key) {
    return Object.prototype.hasOwnProperty.call(this.pending, key) ? this.pending[key] : this.settings.get(key);
  }

  /** Save a continuously changing setting (volume, alignment) shortly after the last change. */
  saveSettingSoon(key, value) {
    this.pending[key] = value;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flushSettings(), 350);
  }

  flushSettings() {
    clearTimeout(this._saveTimer);
    const p = this.pending;
    this.pending = {};
    for (const k of Object.keys(p)) {
      try {
        this.settings.set(k, p[k]);
      } catch {
        /* ignore */
      }
    }
  }

  // ---- messages -------------------------------------------------------------------------------------------------

  /** Show a toast. opts: { kind: 'info'|'error'|'ok', deck: 'A'|'B', action: {label, onClick}, sticky } */
  toast(text, opts) {
    return this.toasts.show(text, opts || {});
  }

  /** Fallback error toast unless the source (e.g. 'router') already reported an error just now. */
  toastLater(source, text) {
    setTimeout(() => {
      if (Date.now() - (this.lastErrorAt[source] || 0) > 1500) this.toast(text, { kind: 'error' });
    }, 150);
  }

  /** Service worker: a new version is waiting. onReload posts skipWaiting and reloads. */
  showUpdateReady(onReload) {
    this.toast('Update ready. Reload when you are not playing.', { sticky: true, action: { label: 'Reload', onClick: onReload } });
  }

  // ---- outputs chip / info --------------------------------------------------------------------------------------

  describeOutputs() {
    const r = this.engine && this.engine.ready ? this.engine.outputs : null;
    if (!r) return 'Audio off';
    try {
      return r.describe() || 'Default output';
    } catch {
      return 'Default output';
    }
  }

  _updateOutChip() {
    setText(this.outChipText, this.describeOutputs());
  }

  /** { version, build }: the app version and the published build stamp (service worker VERSION), when known. */
  buildInfo() {
    return { version: APP_VERSION, build: this._swVersion || this._cacheName || '' };
  }

  /** Ask the service worker for the build stamp (app-info.js). Never rejects; resolves with buildInfo(). */
  loadBuildInfo() {
    return fetchBuildVersion().then((v) => {
      if (v.swVersion) this._swVersion = v.swVersion;
      if (v.cacheName) this._cacheName = v.cacheName;
      return this.buildInfo();
    });
  }

  /** One-time install offer (app-info.js), retried while audio is off, tips run or a sheet is open. */
  _offerInstall() {
    clearTimeout(this._installTimer);
    if (offerInstall(this) === 'later') this._installTimer = setTimeout(() => this._offerInstall(), 30000);
  }

  /** Settings > About > Diagnostics. */
  diagnostics() {
    return collectDiagnostics(this);
  }

  // ---- coach marks ----------------------------------------------------------------------------------------------

  /** Start the first-run tips (or force them again from Settings). */
  startCoach(force) {
    this.coachFlow.start(force);
  }

  // ---- frame loop -----------------------------------------------------------------------------------------------

  /**
   * The one requestAnimationFrame loop (contract 6.3): decks (platter, tempo field, header chip), waveforms and
   * overviews, mixer meters and widget sync, FX pads, Auto Mix strip, the player page, coach bubble. Hidden parts
   * are skipped; each part is guarded so one failing widget cannot stop the others.
   */
  _frame() {
    this._raf = requestAnimationFrame(this._frameFn);
    if (document.hidden) return;
    this._frameCount++;
    const vis = this.vis;
    guard('deck ui A', this._renderDeck[0]);
    guard('deck ui B', this._renderDeck[1]);
    if (!vis || vis.waves) {
      if (this.wave) guard('waveview', this._renderWave);
      if (this.overviews[0]) guard('overview A', this._renderOv[0]);
      if (this.overviews[1]) guard('overview B', this._renderOv[1]);
    }
    guard('mixer ui', this._renderMixer);
    if (!vis || vis.fxA) guard('fx ui A', this._renderFx[0]);
    if (!vis || vis.fxB) guard('fx ui B', this._renderFx[1]);
    guard('automix ui', this._renderAm);
    if (this.player) {
      if (vis && vis.player) guard('player ui', this._renderPlayer);
      if (this._frameCount % INDICATOR_EVERY === 0) guard('player indicator', this._renderIndicator);
    }
    if (this._frameCount % 12 === 0) this.coachFlow.tick();
  }

  /** Stop the frame loop and listeners (tests / hot reload). */
  destroy() {
    cancelAnimationFrame(this._raf);
    if (this.unbindKeys) this.unbindKeys();
    if (this._offInstall) this._offInstall();
    clearTimeout(this._installTimer);
    clearTimeout(this._visTimer);
    this.deckUIs.forEach((u) => u.destroy());
    this.mixer.destroy();
    this.fxUIs.forEach((f) => f.destroy());
    this.amui.destroy();
    this.playerUI.destroy();
    this.songs.destroy();
    this.sourcesUI.destroy();
    for (const w of [this.wave, ...this.overviews]) {
      if (w && typeof w.destroy === 'function') guard('destroy', () => w.destroy());
    }
  }
}
