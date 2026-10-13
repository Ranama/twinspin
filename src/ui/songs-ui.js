// SONGS panel: "+ Add music" (a <label> wrapping the file input, so the native picker opens everywhere), the
// SET LIST with the AUTO MIX switch (setlist-ui.js), the user's library (title, artist, BPM, duration) with big
// A / B load buttons, a + (add to the set list = the player's queue) button and, with a Player, a ⋯ button for
// Play now / Play next / Add to queue / Remove (sheets/song-sheet.js; without a Player a two-step remove), the
// demo tracks, storage use, and a plain "Where are my songs?" hint per platform. It is the SONGS page on phones
// and tablets, a sheet over the centre column in phone landscape and a bottom drawer on the desktop console.
//   const songs = new SongsUI(app);  shell.append(songs.el);  songs.render();
// List buttons fire on click (not pointerdown) because the list scrolls.

import { h, icon, setKids, fileLabel } from './dom.js';
import { songMeta, songTitle, fmtBytes } from './format.js';
import { SetListUI } from './setlist-ui.js';
import { songSheet } from './sheets/song-sheet.js';
import { env } from '../core/env.js';
import { ACCEPT } from '../audio/decode.js';
import { DEMO_TRACKS } from '../audio/demo-synth.js';

export class SongsUI {
  /** @param {object} app the AppUI (library, decks, addFiles, loadFromLibrary, loadDemo, setPage, dialog) */
  constructor(app) {
    this.app = app;
    this.armed = null; // { id, timer } for the two-step remove
    this.usage = null;
    this._usageTimer = 0;
    const add = fileLabel('btn.btn-primary.btn-add', ACCEPT, true, 'Add music from this device',
      (files) => app.addFiles(files), icon('plus'), h('span', { text: 'Add music' }));
    this.addLabel = add.label;
    this.closeBtn = h('button.icon-btn.songs-close', { type: 'button', 'aria-label': 'Close songs' }, icon('close'));
    this.closeBtn.addEventListener('click', () => app.setPage('mix'));
    this.setList = new SetListUI(app);
    this.list = h('div.song-list', { role: 'list', 'aria-label': 'Your songs' });
    this.countEl = h('span.songs-count');
    this.addAllBtn = this._addAllButton('Add all your songs to the set list', () => this._addAllLibrary());
    this.demoList = h('div.song-list', { role: 'list', 'aria-label': 'Demo tracks' });
    this.addDemosBtn = this._addAllButton('Add both demo tracks to the set list', () => this._addAllDemos());
    this.storageEl = h('p.songs-storage');
    this.clearBtn = h('button.btn.btn-ghost.btn-sm.btn-clear', { type: 'button' }, icon('trash'), h('span', { text: 'Clear library' }));
    this.clearBtn.addEventListener('click', () => this._clearAll());
    this.scroll = h('div.songs-scroll', {},
      this.setList.el,
      h('div.songs-sec', {}, h('h3.songs-h', {}, h('span', { text: 'Your songs' }), this.countEl, h('span.sl-h-gap'), this.addAllBtn), this.list),
      h('div.songs-sec', {}, h('h3.songs-h', {}, h('span', { text: 'Demo tracks' }), h('span.sl-h-gap'), this.addDemosBtn), this.demoList),
      this._helpBlock(),
      h('div.songs-foot', {}, this.storageEl, this.clearBtn));
    this.setList.setScroller(this.scroll);
    this.el = h('section.songs', { 'aria-label': 'Songs' },
      h('div.songs-head', {}, this.addLabel, h('span.songs-drop', { text: 'or drop files on a deck' }), this.closeBtn),
      this.scroll);
    this._renderDemos();
    this.setList.render();
  }

  _addAllButton(label, onClick) {
    const b = h('button.btn.btn-ghost.btn-sm.add-all', { type: 'button', 'aria-label': label, hidden: !this.app.playlist },
      icon('listAdd'), h('span', { text: 'Add all' }));
    b.addEventListener('click', onClick);
    return b;
  }

  _helpBlock() {
    let text;
    if (env.ios) {
      text = 'On iPhone and iPad, TwinSpin opens music files saved in the Files app (On My iPhone, iCloud Drive, ' +
        'Downloads). MP3, M4A/AAC, WAV and AIFF work best. Songs from Apple Music or Spotify are protected and ' +
        "can't be loaded.";
      if (!env.standalone) text += ' Tip: add TwinSpin to your Home Screen (Share, then Add to Home Screen) so Safari keeps your songs.';
    } else if (env.android) {
      text = 'Pick MP3, M4A, WAV, FLAC or OGG files from Downloads, Music or an SD card. Songs inside streaming apps ' +
        "(Spotify, YouTube Music) are protected and can't be loaded.";
    } else {
      text = 'Use Add music or drop audio files straight onto deck A or B. MP3, M4A, WAV, FLAC and OGG work in most ' +
        'browsers. Your songs stay on this computer; nothing is uploaded.';
    }
    return h('details.songs-help', {}, h('summary', {}, icon('help'), h('span', { text: 'Where are my songs?' })), h('p', { text }));
  }

  _renderDemos() {
    const rows = DEMO_TRACKS.map((d) => {
      const entry = { kind: 'demo', id: d.id, title: d.title, artist: d.artist, bpm: d.bpm };
      return this._row({
        key: `demo-${d.id}`,
        title: d.title,
        meta: `${d.artist} · ${d.bpm} BPM`,
        entry,
        loadedOn: (i) => {
          const t = this.app.decks[i] && this.app.decks[i].track;
          return !!t && t.source === 'demo' && t.title === d.title;
        },
        onLoad: (i) => this.app.loadDemo(i, d.id),
        onAdd: () => this.app.addToSetList([entry]),
      });
    });
    setKids(this.demoList, rows);
  }

  _entries() {
    const lib = this.app.library;
    if (!lib || typeof lib.list !== 'function') return [];
    try {
      const all = lib.list() || [];
      return all.filter((e) => e && !(e.demo || e.source === 'demo' || (typeof e.id === 'string' && e.id.startsWith('demo'))));
    } catch {
      return [];
    }
  }

  /** Rebuild the lists (library change, deck track change). */
  render() {
    const entries = this._entries();
    const app = this.app;
    this.countEl.textContent = entries.length ? String(entries.length) : '';
    if (!entries.length) {
      setKids(this.list, h('div.songs-empty', {},
        h('p', { text: 'No songs yet.' }),
        h('p', { text: 'Tap Add music and pick audio files from this device. They stay on this device, ready for next time.' })));
    } else {
      setKids(this.list, entries.map((e) => this._row({
        key: e.id,
        title: songTitle(e),
        meta: songMeta(e),
        entry: e,
        loadedOn: (i) => {
          const d = app.decks[i];
          const t = d && d.track;
          return !!t && (t.libraryId === e.id || (app.libIds[i] === e.id && t.source !== 'demo'));
        },
        onLoad: (i) => app.loadFromLibrary(i, e),
        onAdd: () => app.addToSetList([e]),
        onRemove: () => this._remove(e),
      })));
    }
    this.clearBtn.hidden = !entries.length;
    this.addAllBtn.hidden = !app.playlist || entries.length < 2;
    // Demo rows also show which deck has them.
    this._renderDemos();
    this._scheduleUsage();
  }

  /** Rebuild the set list rows (playlist 'change'). */
  renderSetList() {
    this.setList.render();
  }

  /**
   * One song row: title + meta, A / B load buttons, + (add to the set list = the queue) and, with a Player, a ⋯
   * button for Play now / Play next / Add to queue / Remove (song-sheet.js); without a Player the two-step
   * remove button stays on the row.
   */
  _row({ key, title, meta, entry, loadedOn, onLoad, onAdd, onRemove }) {
    const app = this.app;
    const btn = (i) => {
      const id = i ? 'B' : 'A';
      const loaded = loadedOn(i);
      const b = h(`button.load-btn.deck-${id.toLowerCase()}${loaded ? '.loaded' : ''}`, { type: 'button',
        'aria-label': `Load ${title} on deck ${id}${loaded ? ' (loaded)' : ''}`, text: id });
      b.addEventListener('click', () => onLoad(i));
      return b;
    };
    const kids = [
      h('div.song-info', {}, h('span.song-title', { text: title }), meta ? h('span.song-meta', { text: meta }) : null),
      btn(0), btn(1),
    ];
    if (onAdd && app.playlist) {
      const add = h('button.add-btn', { type: 'button', 'aria-label': `Add ${title} to the queue (set list)` }, icon('plus'));
      add.addEventListener('click', () => {
        onAdd();
        add.classList.add('added');
        setTimeout(() => add.classList.remove('added'), 900);
      });
      kids.push(add);
    }
    const menu = !!(app.player && entry);
    if (menu) {
      const more = h('button.icon-btn.song-more', { type: 'button', 'aria-haspopup': 'dialog',
        'aria-label': `More for ${title}: play now, play next, add to queue${onRemove ? ', remove' : ''}` }, icon('more'));
      more.addEventListener('click', () => {
        app.sheets.open(songSheet(app, { title, meta, entry, onRemove: onRemove ? () => this._removeAsk(entry) : null }));
      });
      kids.push(more);
    } else if (onRemove) {
      const armed = this.armed && this.armed.id === key;
      const rm = h(`button.icon-btn.song-rm${armed ? '.armed' : ''}`, { type: 'button', 'aria-label': armed ? `Confirm remove ${title}` : `Remove ${title}` },
        armed ? h('span.rm-text', { text: 'Remove?' }) : icon('trash'));
      rm.addEventListener('click', onRemove);
      kids.push(rm);
    }
    const cls = `div.song-row${app.playlist && onAdd ? '.with-add' : ''}${menu ? '.with-menu' : onRemove ? '' : '.no-rm'}`;
    return h(cls, { role: 'listitem', dataset: { key: String(key) } }, kids);
  }

  /** Remove a library song from the ⋯ sheet: asks first (the row has no two-step button then). */
  async _removeAsk(entry) {
    const title = songTitle(entry);
    const ok = await this.app.dialog.confirm({
      title: 'Remove this song?',
      message: `“${title}” is deleted from this device and leaves the queue. Songs on the decks keep playing.`,
      ok: 'Remove', cancel: 'Keep it', danger: true,
    });
    if (!ok) return;
    const lib = this.app.library;
    try {
      await lib.remove(entry.id);
      this.app.toast(`Removed “${title}”`, { kind: 'ok' });
    } catch {
      this.app.toast("That song couldn't be removed. Try again.", { kind: 'error' });
    }
    this.render();
  }

  _addAllLibrary() {
    const entries = this._entries();
    if (entries.length) this.app.addToSetList(entries);
  }

  _addAllDemos() {
    this.app.addToSetList(DEMO_TRACKS.map((d) => ({ kind: 'demo', id: d.id, title: d.title, artist: d.artist, bpm: d.bpm })));
  }

  _remove(entry) {
    if (!this.armed || this.armed.id !== entry.id) {
      if (this.armed) clearTimeout(this.armed.timer);
      this.armed = { id: entry.id, timer: setTimeout(() => {
        this.armed = null;
        this.render();
      }, 3500) };
      this.render();
      return;
    }
    clearTimeout(this.armed.timer);
    this.armed = null;
    const lib = this.app.library;
    Promise.resolve()
      .then(() => lib.remove(entry.id))
      .then(() => this.app.toast(`Removed “${songTitle(entry)}”`, { kind: 'ok' }))
      .catch(() => this.app.toast("That song couldn't be removed. Try again.", { kind: 'error' }))
      .then(() => this.render());
  }

  async _clearAll() {
    const ok = await this.app.dialog.confirm({
      title: 'Clear your song library?',
      message: 'This removes every saved song from this device. Songs on the decks keep playing.',
      ok: 'Clear library', cancel: 'Keep songs', danger: true,
    });
    if (!ok) return;
    try {
      await this.app.library.clear();
      this.app.toast('Library cleared', { kind: 'ok' });
    } catch {
      this.app.toast("The library couldn't be cleared. Try again.", { kind: 'error' });
    }
    this.render();
  }

  _scheduleUsage() {
    clearTimeout(this._usageTimer);
    this._usageTimer = setTimeout(() => this._updateUsage(), 400);
  }

  _updateUsage() {
    const lib = this.app.library;
    const entries = this._entries();
    const count = entries.length;
    const base = count ? `${count} song${count === 1 ? '' : 's'}` : 'No songs saved';
    const persistNote = lib && lib.persistent === false ? ' · kept for this visit only (storage is blocked)' : '';
    this.storageEl.textContent = base + persistNote;
    if (!lib || typeof lib.usage !== 'function' || !count) return;
    Promise.resolve()
      .then(() => lib.usage())
      .then((u) => {
        if (!u || !Number.isFinite(u.usedBytes)) return;
        const quota = Number.isFinite(u.quotaBytes) && u.quotaBytes > 0 ? ` of ${fmtBytes(u.quotaBytes)}` : '';
        this.storageEl.textContent = `${base} · ${fmtBytes(u.usedBytes)} used${quota}${persistNote}`;
      })
      .catch(() => {});
  }

  destroy() {
    clearTimeout(this._usageTimer);
    this.setList.destroy();
  }
}
