// The PLAYER page (docs/PLAYER.md section 5): a familiar music-player view on top of the set list (= the queue)
// and Auto Mix. Now-playing card (a spinning disc in the song's colour, still while paused or with reduced
// motion; title, artist, BPM, a Deck A / B badge and the AUTO MIX switch), seek bar with elapsed / remaining
// time (off while two songs mix, with a short hint; a thin "mixing into" line instead), transport (shuffle,
// previous, play / pause, next, repeat off / all / one), the transition chooser (DJ mix / Crossfade with its
// seconds / Gapless), master volume, the Up next list (drag the handle to reorder, x removes, tap plays it now),
// Clear queue and "+ Add" (the Add music sheet), a collapsible History, an empty state with Add music and Open
// Songs, and "Downloading 45% from your music server" while a server song loads (docs/SOURCES.md section 4).
// One column on phones (the top part stays put, the queue scrolls under it; the transition chooser opens as a
// sheet from the options row), two columns from 640 px (phone landscape, tablets, the desktop drawer). AppUI
// shows it as a page (pp / tp / pl: the whole screen under the header) or a drawer (console), sets the layout
// from layout-math.js (playerBox / playerLayout) and calls render() every frame while it is visible.
//   const pui = new PlayerUI(app);  shell.append(pui.el);  pui.bind();  pui.setLayout(playerLayout(w, h));
// Works without a Player (older builds, tests): AppUI then hides the page and its tab.

import { h, icon, setText, setClass, setAttr, setKids, trackHold, isHeld, touchedRecently, stampInput, guard } from './dom.js';
import { Fader, bindPress } from './widgets/controls.js';
import { songMeta, fmtPct } from './format.js';
import { itemTitle } from './automix-text.js';
import {
  playerSnapshot, playerView, TRANSITIONS, transitionInfo, transitionText, transitionShort, repeatInfo, nextRepeat,
  seekTarget, queueKey, queueMoveIndex, cleanCrossfade, fmtSeconds, countText, CROSSFADE_MIN, CROSSFADE_MAX,
} from './player-text.js';
import { DragReorder } from './drag-reorder.js';
import { section } from './sheets/sheet.js';
import { downloadText } from './sources-text.js';
import { sourceBadgeEl, libraryEntryOf } from './source-badge.js';

const TEXT_EVERY = 3;      // frames between time / state refreshes (~20 per second)
const HINT_MS = 2600;      // how long the "seeking is off" hint stays
const HISTORY_MAX = 50;    // history rows shown
/** Player 'change' reasons that never touch Up next / History. */
const QUIET_CHANGES = new Set(['progress', 'transport', 'plan', 'mix', 'mode']);
/** _call() result when the Player has no such method. */
const NO_METHOD = Symbol('no method');

export class PlayerUI {
  /** @param {object} app the AppUI (player, playlist, automix, settings, engine, dialog, toast(), showSongs()) */
  constructor(app) {
    this.app = app;
    this._snap = {};
    this._view = null;
    this._frame = 0;
    this._dirty = true;
    this._listDirty = true;
    this._listKey = null;
    this._pending = false;
    this._rows = [];
    this._focusUid = null;
    this._layout = { cols: 1, colW: 0, stack: false, art: 84 };
    this._hintUntil = 0;
    this._hintText = '';
    this._seekShown = 0;
    this._lastHue = null;
    this._lastTrans = '';
    this._offs = [];
    this._unbind = [];
    this.trans = null;
    this._build();
    this.dragger = new DragReorder({
      list: this.list,
      rows: () => this._rows,
      scroller: () => this.colB,
      onDrop: (uid, to) => this._moveTo(uid, to),
      onEnd: () => {
        if (this._pending) this.renderLists(true);
      },
    });
  }

  get player() {
    return this.app.player || null;
  }

  // ---- build ------------------------------------------------------------------------------------------------

  _build() {
    const app = this.app;
    // head (phone landscape page, desktop drawer): title + close
    this.closeBtn = h('button.icon-btn.pl-close', { type: 'button', 'aria-label': 'Close the player' }, icon('close'));
    this.closeBtn.addEventListener('click', () => app.setPage('mix'));
    this.head = h('header.pl-head', {}, icon('player', 'pl-head-ico'), h('h2.pl-head-title', { text: 'Player' }),
      h('span.pl-gap'), this.closeBtn);

    // now playing
    this.disc = h('div.pl-disc', { 'aria-hidden': 'true' }, h('span.pl-disc-label'), h('span.pl-disc-hole'));
    this.deckBadge = h('span.pl-deck', { 'aria-hidden': 'true' });
    this.art = h('div.pl-art', {}, this.disc, this.deckBadge);
    this.stateEl = h('span.pl-state', { text: 'READY' });
    this.autoText = h('span.pl-auto-text', { text: 'AUTO MIX' });
    this.autoBtn = h('button.pl-auto', { type: 'button', role: 'switch', 'aria-checked': 'false',
      'aria-label': 'Auto Mix: plays the queue by itself and moves from song to song' },
    h('span.am-mini', { 'aria-hidden': 'true' }, h('span.am-mini-dot')), this.autoText);
    this.autoBtn.addEventListener('click', () => app.toggleAutomix());
    this.autoBtn.hidden = !app.automix;
    this.titleEl = h('span.pl-title', { text: '' });
    this.artistEl = h('span.pl-artist', { text: '' });
    this.tagsEl = h('span.pl-tags', { text: '' });
    this.now = h('div.pl-now', {}, this.art,
      h('div.pl-meta', {}, h('div.pl-meta-top', {}, this.stateEl, this.autoBtn), this.titleEl, this.artistEl, this.tagsEl));

    // seek bar + times + hint / "mixing into" line
    this.seekSlot = trackHold(h('div.pl-seek-slot'));
    this.elEl = h('span.pl-el', { text: '0:00' });
    this.remEl = h('span.pl-rem', { text: '' });
    this.subEl = h('span.pl-sub');
    this.mixFill = h('span.pl-mixbar-fill');
    this.mixBar = h('span.pl-mixbar', { 'aria-hidden': 'true', hidden: true }, this.mixFill);
    this.seekWrap = h('div.pl-seek', {}, this.seekSlot, this.mixBar, h('div.pl-times', {}, this.elEl, this.subEl, this.remEl));
    this.seek = guard('seek Fader', () => new Fader(this.seekSlot, {
      orientation: 'horizontal', min: 0, max: 1, value: 0, defaultValue: 0, label: 'Song position',
      className: 'fader-seek', absolute: true, doubleTapReset: false,
      step: () => {
        const d = this._snap.duration;
        return d > 0 ? Math.min(0.25, 5 / d) : 0.02;
      },
      format: (f) => fmtTimeOf(f, this._snap.duration),
      onInput: (f) => {
        stampInput(this.seek);
        if (this._snap.duration > 0) setText(this.elEl, fmtTimeOf(f, this._snap.duration));
      },
      onRelease: (f) => this._seekTo(f),
    })) || null;
    // a touch on the bar while it is off explains why
    this.seekSlot.addEventListener('pointerdown', () => {
      const v = this._view;
      if (!v || v.seekEnabled) return;
      this._hint(v.mixing ? 'Seeking is off while the songs mix' : v.busy ? 'Loading the song…' : 'Play a song first');
    }, true);

    // transport
    const tbtn = (cls, ico, label, fn) => {
      const b = h(`button.pl-btn.${cls}`, { type: 'button', 'aria-label': label }, ico);
      this._unbind.push(bindPress(b, { onActivate: () => fn() }));
      return b;
    };
    this.shuffleBtn = tbtn('pl-shuffle', icon('shuffle'), 'Shuffle', () => this.toggleShuffle());
    this.shuffleBtn.setAttribute('aria-pressed', 'false');
    this.prevBtn = tbtn('pl-prev', icon('prev'), 'Previous song (or the start of this one)', () => this.previous());
    this.playBtn = tbtn('pl-play', [icon('play', 'i-play'), icon('pause', 'i-pause'), h('span.pl-spin', { 'aria-hidden': 'true' })],
      'Play', () => this.togglePlay());
    this.nextBtn = tbtn('pl-next', icon('next'), 'Next song', () => this.next());
    this.repeatBtn = tbtn('pl-repeat', [icon('repeat', 'i-rep'), icon('repeatOne', 'i-rep1')], 'Repeat off', () => this.cycleRepeat());
    this.repeatBtn.dataset.mode = 'off';
    this.transport = h('div.pl-transport', {}, this.shuffleBtn, this.prevBtn, this.playBtn, this.nextBtn, this.repeatBtn);

    // transition chooser (inline in two-column layouts) + options row (transition button on phones, volume)
    this.trans = new TransitionChooser(this, { rows: false });
    this.transBtnText = h('span.pl-tb-text', { text: 'DJ mix' });
    this.transBtn = h('button.pl-trans-btn', { type: 'button', 'aria-haspopup': 'dialog', 'aria-label': 'Transition between songs' },
      icon('auto', 'pl-tb-ico'), this.transBtnText, icon('chevronDown', 'pl-tb-chev'));
    this.transBtn.addEventListener('click', () => this.openTransitions());
    this.volSlot = trackHold(h('div.pl-vol-slot'));
    this.volVal = h('span.pl-vol-val', { text: '' });
    this.vol = h('div.pl-vol', {}, icon('speaker', 'pl-vol-ico'), this.volSlot, this.volVal);
    this.volume = guard('player volume Fader', () => new Fader(this.volSlot, {
      orientation: 'horizontal', min: 0, max: 1, value: num(app.getSetting('masterVolume'), 0.8), defaultValue: 0.8,
      label: 'Volume', className: 'fader-pvol', format: fmtPct,
      onInput: (v) => {
        stampInput(this.volume);
        setText(this.volVal, fmtPct(v));
        app.setMasterVolume(v);
      },
    })) || null;
    this.opts = h('div.pl-opts', {}, this.transBtn, this.vol);

    this.colA = h('div.pl-col-a', {}, this.now, this.seekWrap, this.transport, this.trans.el, this.opts);

    // queue: Up next, empty state, History
    this.countEl = h('span.songs-count');
    this.clearBtn = h('button.btn.btn-ghost.btn-sm.pq-clear', { type: 'button' }, h('span', { text: 'Clear queue' }));
    this.clearBtn.addEventListener('click', () => this._clear());
    this.list = h('div.pq-list', { role: 'list', 'aria-label': 'Up next, in play order' });
    this.emptyTitle = h('p.pq-empty-title', { text: '' });
    this.emptyText = h('p.pq-empty-text', { text: '' });
    this.songsBtn = h('button.btn.btn-sm.pq-songs', { type: 'button' }, icon('songs'), h('span', { text: 'Open Songs' }));
    this.songsBtn.addEventListener('click', () => app.showSongs());
    this.addMusicBtn = h('button.btn.btn-sm.btn-primary.pq-add', { type: 'button', 'aria-haspopup': 'dialog' }, icon('plus'),
      h('span', { text: 'Add music' }));
    this.addMusicBtn.addEventListener('click', () => app.openAddMusic());
    this.empty = h('div.pq-empty', { hidden: true }, icon('listAdd', 'pq-empty-ico'), this.emptyTitle, this.emptyText,
      h('div.pq-empty-btns', {}, this.addMusicBtn, this.songsBtn));
    this.addBtn = h('button.btn.btn-ghost.btn-sm.pq-addmusic', { type: 'button', 'aria-haspopup': 'dialog',
      'aria-label': 'Add music: from this device, Google Drive or your music server' }, icon('plus'), h('span', { text: 'Add' }));
    this.addBtn.addEventListener('click', () => app.openAddMusic());
    this.histCount = h('span.songs-count');
    this.histList = h('div.pq-list.pq-hist-list', { role: 'list', 'aria-label': 'Played songs, most recent first' });
    this.hist = h('details.pq-hist', { hidden: true },
      h('summary', {}, icon('history', 'pq-hist-ico'), h('span', { text: 'History' }), this.histCount, h('span.sl-h-gap'),
        icon('chevronDown', 'pq-hist-chev')),
      this.histList);
    this.colB = h('div.pl-col-b', {},
      h('h3.songs-h.pq-h', {}, h('span', { text: 'Up next' }), this.countEl, h('span.sl-h-gap'), this.addBtn, this.clearBtn),
      this.list, this.empty, this.hist);

    this.body = h('div.pl-body', {}, this.colA, this.colB);
    this.el = h('section.player', { 'aria-label': 'Music player', hidden: true, dataset: { cols: '1', stack: '0' } }, this.head, this.body);
  }

  /** Subscribe to the Player / Playlist events (called once by AppUI). */
  bind() {
    const p = this.player;
    if (p && typeof p.on === 'function') {
      this._offs.push(p.on('change', (what) => {
        this._dirty = true;
        // progress / transport / plan / mix ticks never change the lists
        if (!QUIET_CHANGES.has(what)) this._listDirty = true;
      }));
    }
    const pl = this.app.playlist;
    if (pl && typeof pl.on === 'function') this._offs.push(pl.on('change', () => this.markListDirty()));
  }

  /** Layout from layout-math playerLayout(): one or two columns, big or small cover. */
  setLayout(lay) {
    if (!lay) return;
    const prev = this._layout;
    this._layout = lay;
    this.el.dataset.cols = String(lay.cols === 2 ? 2 : 1);
    this.el.dataset.stack = lay.stack ? '1' : '0';
    const st = this.el.style;
    st.setProperty('--pl-art', `${Math.round(lay.art || 84)}px`);
    st.setProperty('--pl-colw', `${Math.round(lay.colW || 0)}px`);
    if (!prev || prev.cols !== lay.cols || prev.stack !== lay.stack) this._dirty = true;
  }

  get layout() {
    return this._layout;
  }

  markDirty() {
    this._dirty = true;
  }

  /** The queue changed (playlist / player events): rebuild the lists on the next render. */
  markListDirty() {
    this._listDirty = true;
    this._dirty = true;
  }

  // ---- actions ----------------------------------------------------------------------------------------------

  /**
   * Call a Player method (guarded). Returns NO_METHOD when the Player lacks it (the caller may fall back to the
   * settings), else what the method returned (false = it did nothing, e.g. jumpTo of a song that is gone).
   */
  _call(name, ...args) {
    const p = this.player;
    if (!p || typeof p[name] !== 'function') return NO_METHOD;
    const r = guard(`player ${name}`, () => p[name](...args));
    this._dirty = true;
    this._listDirty = true;
    return r;
  }

  _audioOk() {
    const eng = this.app.engine;
    if (eng && eng.ready) return true;
    this.app.toast('Tap Start first so TwinSpin can play sound.', { kind: 'error' });
    return false;
  }

  _queueEmpty() {
    const s = playerSnapshot(this.player, this.app.automix, this.app.settings, this._snap);
    let n = 0;
    try {
      n = this.app.playlist ? this.app.playlist.items.length : 0;
    } catch {
      n = 0;
    }
    return !s.hasNow && s.upNextCount === 0 && n === 0;
  }

  /** Big play button, Space on the player page, the strip's play / pause. */
  togglePlay() {
    const p = this.player;
    if (!p) return;
    const st = playerSnapshot(p, this.app.automix, this.app.settings, this._snap).state;
    const pausable = st === 'playing' || st === 'mixing' || st === 'loading';
    if (!pausable) {
      if (!this._audioOk()) return;
      if (this._queueEmpty()) {
        this.app.toast('Your queue is empty. Add songs on the Songs page.',
          { action: { label: 'Songs', onClick: () => this.app.showSongs() } });
        return;
      }
    }
    if (typeof p.toggle === 'function') this._call('toggle');
    else this._call(pausable ? 'pause' : 'play');
  }

  next() {
    if (!this.player || !this._audioOk()) return;
    this._call('next');
  }

  previous() {
    if (!this.player || !this._audioOk()) return;
    this._call('previous');
  }

  toggleShuffle() {
    const p = this.player;
    if (!p) return;
    const on = !playerSnapshot(p, this.app.automix, this.app.settings, this._snap).shuffle;
    if (this._call('setShuffle', on) === NO_METHOD) this._setSetting('playerShuffle', on);
    this.app.toast(on ? 'Shuffle on: the songs up next play in random order' : 'Shuffle off');
  }

  cycleRepeat() {
    const p = this.player;
    if (!p) return;
    const cur = playerSnapshot(p, this.app.automix, this.app.settings, this._snap).repeat;
    const want = nextRepeat(cur);
    if (typeof p.cycleRepeat === 'function') this._call('cycleRepeat');
    else if (this._call('setRepeat', want) === NO_METHOD) this._setSetting('playerRepeat', want);
    const now = playerSnapshot(p, this.app.automix, this.app.settings, this._snap).repeat;
    this.app.toast(repeatInfo(now === cur ? want : now).toast);
  }

  /** Transition style from the chooser ('dj' | 'crossfade' | 'gapless'). */
  setTransition(style) {
    if (this._call('setTransition', style) === NO_METHOD) this._setSetting('transitionStyle', style);
    this._renderChoosers();
  }

  /** Crossfade length (s) from the slider. */
  setCrossfadeSec(sec) {
    const s = cleanCrossfade(sec);
    if (this._call('setCrossfadeSec', s) === NO_METHOD) this._setSetting('crossfadeSec', s);
    this._renderChoosers();
  }

  /** Show a new transition choice at once (the page may be behind a sheet, rendering less often). */
  _renderChoosers() {
    const s = playerSnapshot(this.player, this.app.automix, this.app.settings, this._snap);
    this._lastTrans = `${s.transition}|${s.crossfadeSec}`;
    this.trans.render(s.transition, s.crossfadeSec);
    if (this._sheetChooser) this._sheetChooser.render(s.transition, s.crossfadeSec);
    setText(this.transBtnText, transitionShort(s.transition, s.crossfadeSec));
    this._dirty = true;
  }

  _setSetting(key, value) {
    try {
      this.app.settings.set(key, value);
    } catch {
      /* ignore */
    }
  }

  _seekTo(f) {
    const v = this._view;
    const d = this._snap.duration;
    if (!v || !v.seekEnabled || !(d > 0)) return;
    if (Math.abs(f - this._seekShown) < 0.0015) return; // released where it was: nothing to do
    this._seekShown = f;
    this._call('seek', seekTarget(f, d));
  }

  /** Tap on an Up next / History row: play it now (the card above shows it; only a failure says something). */
  _jump(uid, title) {
    if (uid == null || !this._audioOk()) return;
    const r = this._call('jumpTo', uid);
    if (r === false) this.app.toast(`“${title || 'That song'}” couldn't be played. It may have left the queue.`, { kind: 'error' });
  }

  _remove(uid) {
    const pl = this.app.playlist;
    if (!pl) return;
    try {
      pl.remove(uid);
    } catch (err) {
      console.warn('[TwinSpin] queue remove failed', err);
    }
  }

  /** Drop a dragged Up next row on row `to`. */
  _moveTo(uid, to) {
    const pl = this.app.playlist;
    if (!pl) return;
    const shown = this._rows.map((r) => r.item);
    const at = queueMoveIndex(shown, to, (u) => pl.indexOf(u));
    if (at < 0) return;
    try {
      pl.move(uid, at);
    } catch (err) {
      console.warn('[TwinSpin] queue move failed', err);
    }
  }

  _key(e, uid) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    e.stopPropagation();
    const i = this._rows.findIndex((r) => r.uid === uid);
    if (i < 0) return;
    const to = e.key === 'ArrowUp' ? i - 1 : i + 1;
    if (to < 0 || to >= this._rows.length) return;
    this._focusUid = uid;
    this._moveTo(uid, to);
  }

  async _clear() {
    const pl = this.app.playlist;
    if (!pl || !this._upNext().length) return;
    const ok = await this.app.dialog.confirm({
      title: 'Clear the queue?',
      message: 'The songs up next leave the queue. The song playing now keeps playing, and your songs stay in the library.',
      ok: 'Clear queue', cancel: 'Keep them',
    });
    if (!ok) return;
    // what is up next NOW (a mix may have finished while the dialog was open): Player.clearQueue() removes it in
    // one go (one save, one change, Auto Mix re-plans once); older Players: one by one, last first
    if (this._call('clearQueue') === NO_METHOD) {
      const up = this._upNext().slice();
      for (let i = up.length - 1; i >= 0; i--) {
        if (up[i] && up[i].uid != null) this._remove(up[i].uid);
      }
    }
    this.app.toast('Queue cleared', { kind: 'ok' });
  }

  /** The transition chooser as a sheet (phones: the options row's button). */
  openTransitions() {
    const ui = this;
    this.app.sheets.open({
      id: 'transition',
      title: 'Transition',
      mount(body) {
        const ch = new TransitionChooser(ui, { rows: true });
        body.append(section('Between songs', ch.el),
          h('p.sheet-note', { text: 'The queue moves from song to song with this transition while the player plays.' }));
        ch.render(ui._snap.transition || 'dj', ui._snap.crossfadeSec || 6);
        ui._sheetChooser = ch;
        return () => {
          ui._sheetChooser = null;
          ch.destroy();
        };
      },
    });
  }

  _hint(text) {
    this._hintText = text;
    this._hintUntil = Date.now() + HINT_MS;
    this._dirty = true;
  }

  _upNext() {
    const p = this.player;
    if (!p) return [];
    try {
      const v = p.upNext;
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  _history() {
    const p = this.player;
    if (!p) return [];
    try {
      const v = p.history;
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  // ---- render -----------------------------------------------------------------------------------------------

  /** Per animation frame while the page is visible (text throttled; the seek bar follows every frame). */
  render() {
    if (!this.player) return;
    this._frame++;
    if (!this._dirty && this._frame % TEXT_EVERY !== 0) return;
    this._dirty = false;
    const app = this.app;
    const s = playerSnapshot(this.player, app.automix, app.settings, this._snap);
    const v = playerView(s);
    this._view = v;
    // now playing
    setText(this.stateEl, v.stateText);
    setText(this.titleEl, v.title);
    setText(this.artistEl, v.artist);
    setText(this.tagsEl, v.tags);
    this.tagsEl.hidden = !v.tags;
    this.artistEl.hidden = !v.artist;
    setText(this.deckBadge, v.deck);
    this.deckBadge.hidden = !v.deck;
    setAttr(this.deckBadge, 'data-deck', v.deck || null);
    if (v.hue !== this._lastHue) {
      this._lastHue = v.hue;
      this.art.style.setProperty('--hue', String(v.hue));
    }
    setClass(this.art, 'spinning', v.spinning);
    setClass(this.art, 'idle', !s.hasNow);
    setClass(this.el, 'is-empty', v.empty);
    setClass(this.el, 'is-mixing', v.mixing);
    const auto = s.autoOn;
    setAttr(this.autoBtn, 'aria-checked', auto ? 'true' : 'false');
    setClass(this.autoBtn, 'on', auto);
    // seek
    if (this.seek) {
      if (typeof this.seek.setDisabled === 'function' && this._seekOff !== !v.seekEnabled) {
        this._seekOff = !v.seekEnabled;
        guard('seek disable', () => this.seek.setDisabled(!v.seekEnabled));
      }
      if (!isHeld(this.seekSlot) && !touchedRecently(this.seek, 400)) {
        this._seekShown = v.seek;
        guard('seek set', () => this.seek.set(v.seek));
        setText(this.elEl, v.elapsed || '0:00');
      }
    } else {
      setText(this.elEl, v.elapsed || '0:00');
    }
    setText(this.remEl, v.remaining);
    const hint = Date.now() < this._hintUntil ? this._hintText : '';
    setText(this.subEl, hint || (v.busy && this._downloadHint()) || v.sub);
    setClass(this.subEl, 'hint', !!hint);
    this.mixBar.hidden = !v.mixing;
    if (v.mixing) this.mixFill.style.setProperty('--p', String(v.mixPct / 100));
    // transport
    setClass(this.playBtn, 'is-playing', v.playIcon === 'pause');
    setClass(this.playBtn, 'busy', v.busy);
    setAttr(this.playBtn, 'aria-label', v.playLabel);
    setAttr(this.shuffleBtn, 'aria-pressed', s.shuffle ? 'true' : 'false');
    setClass(this.shuffleBtn, 'on', s.shuffle);
    const rep = repeatInfo(s.repeat);
    this.repeatBtn.dataset.mode = rep.mode;
    setClass(this.repeatBtn, 'on', rep.on);
    setAttr(this.repeatBtn, 'aria-label', rep.label);
    const canSkip = v.active || s.upNextCount > 0;
    setClass(this.nextBtn, 'dim', !canSkip);
    setClass(this.prevBtn, 'dim', !v.active);
    // transition + volume
    const tkey = `${s.transition}|${s.crossfadeSec}`;
    if (tkey !== this._lastTrans) {
      this._lastTrans = tkey;
      this.trans.render(s.transition, s.crossfadeSec);
      if (this._sheetChooser) this._sheetChooser.render(s.transition, s.crossfadeSec);
      setText(this.transBtnText, transitionShort(s.transition, s.crossfadeSec));
    }
    if (this.volume && !isHeld(this.volSlot) && !touchedRecently(this.volume)) {
      const mv = num(app.getSetting('masterVolume'), 0.8);
      if (Math.abs(this.volume.value - mv) > 1e-4) guard('volume set', () => this.volume.set(mv));
      setText(this.volVal, fmtPct(mv));
    }
    if (this._listDirty) this.renderLists(false);
    // keep the hint ticking away even with nothing else changing
    if (hint) this._dirty = Date.now() < this._hintUntil + 50;
  }

  /** Rebuild Up next / History when the queue changed (deferred while a row is being dragged). */
  renderLists(force) {
    if (this.dragger && this.dragger.active) {
      this._pending = true;
      return;
    }
    this._pending = false;
    this._listDirty = false;
    const up = this._upNext();
    const hist = this._history();
    const s = this._snap;
    // the Player hands out the same frozen arrays until the queue changes: compare those first (no allocation)
    if (!force && up === this._lastUp && hist === this._lastHist && s.uid === this._lastUid && s.hasNow === this._lastHasNow) return;
    this._lastUp = up;
    this._lastHist = hist;
    this._lastUid = s.uid;
    this._lastHasNow = s.hasNow;
    const key = `${queueKey(up, s.uid)}#${queueKey(hist)}#${s.hasNow ? 1 : 0}`;
    if (!force && key === this._listKey) return;
    this._listKey = key;
    setText(this.countEl, countText(up.length));
    this.clearBtn.hidden = !up.length;
    this._rows = up.map((it) => this._row(it, true));
    setKids(this.list, this._rows.map((r) => r.el));
    // empty state
    this.empty.hidden = up.length > 0;
    if (!up.length) {
      if (s.hasNow) {
        setText(this.emptyTitle, 'Nothing after this song');
        setText(this.emptyText, 'Add more on the Songs page: + adds a song to the end, ⋯ then Play next puts it next.');
      } else {
        setText(this.emptyTitle, 'Your queue is empty');
        setText(this.emptyText, 'Open Songs and tap + on a song (or Add all), or ⋯ then Play now. The player moves from ' +
          'song to song with the transition you pick.');
      }
    }
    // history
    this.hist.hidden = !hist.length;
    setText(this.histCount, countText(hist.length));
    setKids(this.histList, hist.slice(0, HISTORY_MAX).map((it) => this._row(it, false).el));
    if (this._focusUid != null) {
      const r = this._rows.find((x) => x.uid === this._focusUid);
      this._focusUid = null;
      if (r && r.handle) {
        try {
          r.handle.focus({ preventScroll: false });
        } catch {
          /* ignore */
        }
      }
    }
  }

  _row(item, upcoming) {
    const title = itemTitle(item);
    const uid = item.uid;
    const meta = songMeta({ artist: item.artist, bpm: item.bpm, duration: item.duration });
    const main = h('button.pq-main', { type: 'button', 'aria-label': upcoming ? `Play ${title} now` : `Play ${title} again` },
      h('span.song-title', {}, sourceBadgeEl(libraryEntryOf(this.app.library, item)), title),
      meta ? h('span.song-meta', { text: meta }) : null);
    main.addEventListener('click', () => this._jump(uid, title));
    if (!upcoming) {
      const el = h('div.pq-row.pq-played', { role: 'listitem', dataset: { uid: String(uid) } }, main, icon('play', 'pq-replay'));
      return { uid, item, el };
    }
    const handle = h('button.sl-handle.pq-handle', { type: 'button', 'aria-label': `Move ${title}. Drag, or use the arrow keys.` },
      icon('grip'));
    const rm = h('button.icon-btn.pq-rm', { type: 'button', 'aria-label': `Remove ${title} from the queue` }, icon('close'));
    rm.addEventListener('click', () => this._remove(uid));
    handle.addEventListener('pointerdown', (e) => this.dragger.start(e, uid));
    handle.addEventListener('keydown', (e) => this._key(e, uid));
    const el = h('div.pq-row', { role: 'listitem', dataset: { uid: String(uid) } }, handle, main, rm);
    return { uid, item, el, handle };
  }

  /**
   * While the player waits for a song: 'Downloading 45% from your music server' when that song (or any song) is
   * downloading through the library ('' otherwise).
   */
  _downloadHint() {
    const lib = this.app.library;
    if (!lib || typeof lib.downloadState !== 'function') return '';
    const am = this.app.automix;
    const ids = [];
    try {
      for (const it of [am && am.pendingItem, am && am.currentItem]) {
        if (it && it.kind === 'library' && it.id) ids.push(it.id);
      }
      const all = lib.downloading;
      if (Array.isArray(all)) ids.push(...all);
      for (const id of ids) {
        const st = lib.downloadState(id);
        if (st) return `${downloadText({ bytes: st.bytes, totalBytes: st.totalBytes })} from your music server`;
      }
    } catch {
      return '';
    }
    return '';
  }

  /** The PLAYER tab / header button light up while the queue plays (AppUI, every few frames). */
  indicator() {
    const p = this.player;
    if (!p) return '';
    let st = 'stopped';
    try {
      st = p.state || 'stopped';
    } catch {
      st = 'stopped';
    }
    return st === 'playing' || st === 'mixing' || st === 'loading' ? 'live' : st === 'paused' ? 'paused' : '';
  }

  destroy() {
    for (const off of this._offs) guard('player off', off);
    this._offs = [];
    for (const u of this._unbind) guard('player unbind', u);
    this._unbind = [];
    if (this.dragger) this.dragger.cancel();
    if (this.trans) this.trans.destroy();
  }
}

/**
 * The transition chooser: DJ mix / Crossfade / Gapless with a line explaining the chosen one (inline, two-column
 * layouts) or a line under each (rows: the phone sheet), and the crossfade seconds slider (2..12) under it.
 */
class TransitionChooser {
  /** @param {PlayerUI} ui  @param {{rows:boolean}} o */
  constructor(ui, { rows }) {
    this.ui = ui;
    this.rows = !!rows;
    this.style = '';
    this.sec = 0;
    this.btns = TRANSITIONS.map((t) => {
      const b = this.rows
        ? h('button.row.pl-trans-row', { type: 'button', role: 'radio', 'aria-checked': 'false' },
          h('span.pl-radio', { 'aria-hidden': 'true' }),
          h('span.row-main', {}, h('span.row-label', { text: t.label }), h('span.row-detail', { text: t.text })))
        : h('button.seg-btn', { type: 'button', role: 'radio', 'aria-checked': 'false', text: t.label });
      b.addEventListener('click', () => ui.setTransition(t.value));
      return { t, b, detail: this.rows ? b.querySelector('.row-detail') : null };
    });
    this.text = h('p.pl-trans-text', { text: '' });
    this.secSlot = trackHold(h('div.pl-xf-slot'));
    this.secVal = h('span.pl-xf-val', { text: '' });
    this.secRow = h('div.pl-xf-row', { hidden: true }, h('span.pl-xf-label', { text: 'Fade' }), this.secSlot, this.secVal);
    this.secFader = guard('crossfade Fader', () => new Fader(this.secSlot, {
      orientation: 'horizontal', min: CROSSFADE_MIN, max: CROSSFADE_MAX, value: 6, defaultValue: 6, step: 1,
      label: 'Crossfade length', className: 'fader-xfsec', format: (v) => `${Math.round(v)} s`,
      onInput: (v) => {
        stampInput(this.secFader);
        const n = Math.round(cleanCrossfade(v)); // whole seconds from the slider
        setText(this.secVal, fmtSeconds(n));
        if (n !== this.sec) {
          this.sec = n;
          ui.setCrossfadeSec(n);
        }
      },
    })) || null;
    const group = this.rows
      ? h('div.pl-trans-rows', { role: 'radiogroup', 'aria-label': 'Transition between songs' }, this.btns.map((x) => x.b))
      : h('div.seg.pl-trans-seg', { role: 'radiogroup', 'aria-label': 'Transition between songs' }, this.btns.map((x) => x.b));
    this.el = h(`div.pl-trans${this.rows ? '.pl-trans-sheet' : ''}`, {}, group, this.rows ? null : this.text, this.secRow);
  }

  render(style, sec) {
    const info = transitionInfo(style);
    this.style = info.value;
    const n = cleanCrossfade(sec);
    for (const x of this.btns) {
      const on = x.t.value === info.value;
      x.b.setAttribute('aria-checked', on ? 'true' : 'false');
      setClass(x.b, 'on', on);
      if (x.detail) x.detail.textContent = x.t.value === 'crossfade' ? transitionText('crossfade', n) : x.t.text;
    }
    setText(this.text, transitionText(info.value, n));
    this.secRow.hidden = info.value !== 'crossfade';
    setText(this.secVal, fmtSeconds(n));
    this.sec = n;
    if (this.secFader && !isHeld(this.secSlot) && !touchedRecently(this.secFader)) guard('crossfade set', () => this.secFader.set(n));
  }

  destroy() {
    if (this.secFader && typeof this.secFader.destroy === 'function') guard('crossfade destroy', () => this.secFader.destroy());
  }
}

function num(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

function fmtTimeOf(f, dur) {
  if (!(dur > 0)) return '0:00';
  const s = Math.max(0, Math.floor(seekTarget(f, dur)));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
