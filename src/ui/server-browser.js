// Music server browser (docs/SOURCES.md section 4): a Navidrome / Subsonic server, for example on the user's
// Synology NAS, inside the app's sheet (a bottom sheet on phones, a side panel on tablets and computers). Not
// connected: the connect form (server-connect.js; the password is handed to MusicServerSource.connect and never kept). Connected: the server line with Disconnect, then the tabs Artists /
// Albums / Playlists / Search. Albums, artists and playlists open as pushed sheets (the sheet's Back returns, with
// the scroll position kept), with cover art, "Add all" and "Save offline". Every song row opens the song action
// sheet (Play now / Play next / Add to queue / Load on deck A / B / Save offline); its + adds it to the queue.
// A song becomes a library entry (library.addRemote) only when it is used. Long lists render a page at a time
// ("Show more"); albums are fetched from the server 40 at a time.
//   const sb = new ServerBrowser(app);  app.sheets.open(sb.sheet());  sb.reset();   // after a disconnect

import { h, icon, setKids } from './dom.js';
import { songSheet } from './sheets/song-sheet.js';
import { renderConnect, connectServer, forgetForm } from './server-connect.js';
import {
  listArtists, listAlbums, listPlaylists, albumOf, playlistOf, artistOf, searchOf, songLine, albumLine, playlistLine,
  countWord, pageOf, serverLabel, serverKind, errText,
} from './sources-text.js';

const PAGE = 60;              // rows rendered at a time
const ALBUM_PAGE = 40;        // albums asked from the server at a time
const SEARCH_DELAY_MS = 400;  // typing pause before a search runs
const COVER = { row: 96, card: 300, head: 480 };
const TABS = [
  { id: 'artists', label: 'Artists' },
  { id: 'albums', label: 'Albums' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'search', label: 'Search' },
];
const SORTS = [
  { id: 'alphabeticalByName', label: 'A–Z' },
  { id: 'newest', label: 'Newest' },
  { id: 'random', label: 'Random' },
];
const UNREACHABLE = "Can't reach your music server. Check your connection and the server, then try again.";

export class ServerBrowser {
  /** @param {object} app the AppUI (sources.server, library, player, sheets, dialog, toast(), songAction(), ...) */
  constructor(app) {
    this.app = app;
    this.tab = 'albums';
    this.sort = 'alphabeticalByName';
    this.query = '';
    this.data = new Map();      // load key -> { status, value, error, p }
    this.albums = new Map();    // sort -> { items, done, loading, error, p }
    this.shown = new Map();     // list key -> rows shown
    this.scroll = new Map();    // view key -> scrollTop
    this.connecting = false;
    this._gen = 0;
  }

  get server() {
    return (this.app.sources && this.app.sources.server) || null;
  }

  get client() {
    const s = this.server;
    try {
      return s && s.connected ? s.client || null : null;
    } catch {
      return null;
    }
  }

  get connected() {
    const s = this.server;
    try {
      return !!(s && s.connected);
    } catch {
      return false;
    }
  }

  /** Forget everything fetched (disconnect, another server). */
  reset() {
    this._gen++;
    this._verified = false;
    this.data.clear();
    this.albums.clear();
    this.shown.clear();
    this.scroll.clear();
    this.query = '';
  }

  // ---- sheets ---------------------------------------------------------------------------------------------------

  /** The browser's first page: the connect form, or the tabs. */
  sheet() {
    const self = this;
    this.relogin = false;
    return {
      id: 'server',
      title: 'Music server',
      mount(body, host) {
        self.mounted = true;
        const off = self._mount(body, host, 'root', (root, live) => {
          if (self.connected && !self.relogin) self._renderBrowser(root, host, live);
          else self._renderConnect(root, host, live);
        }, true);
        self._verifyOnce();
        return () => {
          self.mounted = false;
          off();
        };
      },
    };
  }

  /** A connection restored from this device is checked once per visit (its status shows in the browser). */
  _verifyOnce() {
    const s = this.server;
    if (this._verified || !s || !this.connected || typeof s.verify !== 'function') return;
    this._verified = true;
    Promise.resolve()
      .then(() => s.verify())
      .catch(() => {});
  }

  albumSheet(album) {
    const self = this;
    return {
      id: 'server-album',
      title: album.name || 'Album',
      mount(body, host) {
        return self._mount(body, host, `album:${album.id}`, (root, live) => self._renderAlbum(root, host, live, album));
      },
    };
  }

  artistSheet(artist) {
    const self = this;
    return {
      id: 'server-artist',
      title: artist.name || 'Artist',
      mount(body, host) {
        return self._mount(body, host, `artist:${artist.id}`, (root, live) => self._renderArtist(root, host, live, artist));
      },
    };
  }

  playlistSheet(pl) {
    const self = this;
    return {
      id: 'server-playlist',
      title: pl.name || 'Playlist',
      mount(body, host) {
        return self._mount(body, host, `playlist:${pl.id}`, (root, live) => self._renderPlaylist(root, host, live, pl));
      },
    };
  }

  /**
   * Mount a view: render into a root element, re-render when the connection changes (root page) or the library
   * changes (saved marks), keep the scroll position per view.
   */
  _mount(body, host, key, render, isRoot = false) {
    const root = h('div.sb', { dataset: { view: key.split(':')[0] } });
    body.append(root);
    let alive = true;
    const live = () => alive;
    let wasConnected = this.connected;
    const draw = () => {
      if (!alive) return;
      render(root, live);
    };
    draw();
    const offs = [];
    const s = this.server;
    if (s && typeof s.on === 'function') {
      offs.push(s.on('state', () => {
        const now = this.connected;
        if (now === wasConnected) {
          if (isRoot) this._paintStatus(); // reachable / unreachable / sign-in failed
          return;
        }
        wasConnected = now;
        if (!now) this.reset();
        if (isRoot) draw();
        else if (!now) host.back(); // a sub page of a server that went away
      }));
    }
    const lib = this.app.library;
    if (lib && typeof lib.on === 'function') offs.push(lib.on('change', () => this._refreshMarks(root)));
    const top = this.scroll.get(key) || 0;
    if (top) {
      setTimeout(() => {
        if (alive) body.scrollTop = top;
      }, 0);
    }
    return () => {
      alive = false;
      this.scroll.set(key, body.scrollTop || 0);
      for (const off of offs) {
        if (typeof off === 'function') off();
      }
      clearTimeout(this._searchTimer);
    };
  }

  // ---- connect form (server-connect.js) -------------------------------------------------------------------------

  _renderConnect(root, host, live) {
    renderConnect(this, root, host, live);
  }

  /** Connect; resolves { ok, refresh } or { ok: false, error } (never rejects). */
  _connect(vals) {
    return connectServer(this, vals);
  }

  async disconnect() {
    const ok = await this.app.dialog.confirm({
      title: 'Disconnect the music server?',
      message: 'Songs you saved offline stay on this device. Songs that play from the server stay in your list and ' +
        'play again after you connect.',
      ok: 'Disconnect', cancel: 'Stay connected',
    });
    if (!ok) return false;
    try {
      this.server.disconnect();
    } catch (err) {
      console.warn('[TwinSpin] disconnect failed', err);
    }
    forgetForm(); // the address and user name do not stay on this device either
    this.reset();
    this.app.toast('Music server disconnected', { kind: 'ok' });
    return true;
  }

  // ---- connected: server line, tabs, panels ---------------------------------------------------------------------

  _renderBrowser(root, host, live) {
    const s = this.server;
    const info = s.server || {};
    const off = h('button.btn.btn-ghost.btn-sm.sb-off', { type: 'button', 'aria-label': 'Disconnect the music server' },
      icon('logout'), h('span', { text: 'Disconnect' }));
    off.addEventListener('click', () => {
      this.disconnect().then((done) => {
        if (done && live()) host.refresh();
      });
    });
    const kind = serverKind(info);
    const head = h('div.sb-server', {}, icon('server', 'sb-server-ico'),
      h('div.sb-server-main', {}, h('span.sb-server-name', { text: serverLabel(info) }),
        h('span.sb-server-url', { text: [kind, info.url || ''].filter(Boolean).join(' · ') })), off);
    this._status = h('div.sb-status', { hidden: true });
    this._statusHost = host;
    this._paintStatus();
    const note = s.warning ? h('p.src-hint.sb-warning', { text: s.warning }) : null;
    const panel = h('div.sb-panel', { role: 'tabpanel', id: 'sb-panel' });
    const tabs = h('div.seg.sb-tabs', { role: 'tablist', 'aria-label': 'Browse your music server' }, TABS.map((t) => {
      const b = h('button.seg-btn.sb-tab', { type: 'button', role: 'tab', 'aria-selected': t.id === this.tab ? 'true' : 'false',
        'aria-controls': 'sb-panel', dataset: { tab: t.id }, text: t.label });
      b.addEventListener('click', () => {
        if (this.tab === t.id) return;
        this.tab = t.id;
        for (const x of tabs.children) x.setAttribute('aria-selected', x.dataset.tab === t.id ? 'true' : 'false');
        host.body.scrollTop = 0;
        this._renderPanel(panel, host, live);
      });
      return b;
    }));
    setKids(root, head, note, this._status, tabs, panel);
    this._renderPanel(panel, host, live);
  }

  /** The line under the server: can't reach it (Try again) or the sign-in stopped working (Sign in again). */
  _paintStatus() {
    const el = this._status;
    const s = this.server;
    if (!el || !s) return;
    let st = '';
    try {
      st = s.status || '';
    } catch {
      st = '';
    }
    if (st !== 'unreachable' && st !== 'auth-failed') {
      el.hidden = true;
      setKids(el);
      return;
    }
    const btn = h('button.btn.btn-sm', { type: 'button' }, icon(st === 'auth-failed' ? 'lock' : 'refresh'),
      h('span', { text: st === 'auth-failed' ? 'Sign in again' : 'Try again' }));
    btn.addEventListener('click', () => {
      if (st === 'auth-failed') {
        this.relogin = true;
        if (this._statusHost) this._statusHost.refresh();
        return;
      }
      this.data.clear();
      this.albums.clear();
      Promise.resolve()
        .then(() => s.verify())
        .catch(() => false)
        .then((ok) => {
          if (ok && this._statusHost && this.mounted) this._statusHost.refresh();
        });
    });
    setKids(el, h('p', { text: st === 'auth-failed'
      ? 'Your music server no longer accepts the saved sign-in (the password may have changed).'
      : "Can't reach your music server right now. Songs saved offline still play." }), btn);
    el.hidden = false;
  }

  _renderPanel(panel, host, live) {
    if (this.tab === 'artists') this._artists(panel, host, live);
    else if (this.tab === 'playlists') this._playlists(panel, host, live);
    else if (this.tab === 'search') this._search(panel, host, live);
    else this._albums(panel, host, live);
  }

  /** Load once per key (the result stays for this connection). */
  _load(key, fn) {
    let d = this.data.get(key);
    if (d && d.status !== 'error') return d;
    const gen = this._gen;
    d = { status: 'loading', value: null, error: '', p: null };
    this.data.set(key, d);
    const cur = d;
    d.p = Promise.resolve()
      .then(() => {
        const c = this.client;
        if (!c) throw new Error('');
        return fn(c);
      })
      .then((v) => {
        if (gen !== this._gen || this.data.get(key) !== cur) return;
        cur.status = 'ok';
        cur.value = v;
      }, (err) => {
        if (gen !== this._gen || this.data.get(key) !== cur) return;
        cur.status = 'error';
        cur.error = errText(err, UNREACHABLE);
      });
    return d;
  }

  /** Show a load's state in `el`: a spinner while it runs (then `again()`), an error with Try again, else true. */
  _ready(d, el, live, again) {
    if (d.status === 'ok') return true;
    if (d.status === 'loading') {
      setKids(el, h('p.sb-loading', { role: 'status' }, h('span.sb-spin', { 'aria-hidden': 'true' }), h('span', { text: 'Loading…' })));
      d.p.then(() => {
        if (live()) again();
      });
      return false;
    }
    const retry = h('button.btn.btn-sm.sb-retry', { type: 'button' }, icon('refresh'), h('span', { text: 'Try again' }));
    retry.addEventListener('click', again);
    setKids(el, h('div.sb-error', { role: 'alert' }, h('p', { text: d.error || UNREACHABLE }), retry));
    return false;
  }

  _artists(panel, host, live) {
    const d = this._load('artists', (c) => c.getArtists());
    if (!this._ready(d, panel, live, () => this._artists(panel, host, live))) return;
    const all = listArtists(d.value);
    if (!all.length) {
      setKids(panel, h('p.sb-empty', { text: 'No artists on this server yet.' }));
      return;
    }
    const list = h('div.sb-list', { role: 'list', 'aria-label': 'Artists' });
    this._paged(list, 'artists', all, (a) => {
      const b = h('button.sb-row.sb-artist', { type: 'button', role: 'listitem' }, this._cover(a.coverArt, COVER.row, '.round', 'artist'),
        h('span.sb-row-main', {}, h('span.song-title', { text: a.name }),
          a.albumCount ? h('span.song-meta', { text: countWord(a.albumCount, 'album') }) : null),
        icon('chevron', 'row-chev'));
      b.addEventListener('click', () => host.push(this.artistSheet(a)));
      return b;
    });
    setKids(panel, list);
  }

  _albums(panel, host, live) {
    const seg = h('div.seg.sb-sort', { role: 'radiogroup', 'aria-label': 'Order of the albums' }, SORTS.map((o) => {
      const b = h('button.seg-btn', { type: 'button', role: 'radio', 'aria-checked': o.id === this.sort ? 'true' : 'false', text: o.label });
      b.addEventListener('click', () => {
        if (o.id === this.sort && o.id !== 'random') return;
        if (o.id === 'random') this.albums.delete('random'); // a new random pick every time
        this.sort = o.id;
        host.body.scrollTop = 0;
        this._albums(panel, host, live);
      });
      return b;
    }));
    const grid = h('div.sb-grid', { role: 'list', 'aria-label': 'Albums' });
    const foot = h('div.sb-foot');
    setKids(panel, seg, grid, foot);
    const st = this._albumState(this.sort);
    const draw = () => {
      if (!live()) return;
      setKids(grid, st.items.map((a) => this._albumCard(a, host)));
      if (st.loading) {
        setKids(foot, h('p.sb-loading', { role: 'status' }, h('span.sb-spin', { 'aria-hidden': 'true' }), h('span', { text: 'Loading albums…' })));
      } else if (st.error) {
        const retry = h('button.btn.btn-sm.sb-retry', { type: 'button' }, icon('refresh'), h('span', { text: 'Try again' }));
        retry.addEventListener('click', () => this._moreAlbums(st).then(draw));
        setKids(foot, h('div.sb-error', { role: 'alert' }, h('p', { text: st.error }), retry));
      } else if (!st.done) {
        const more = h('button.btn.btn-sm.sb-more', { type: 'button' }, h('span', { text: 'Show more albums' }));
        more.addEventListener('click', () => {
          this._moreAlbums(st).then(draw);
          draw();
        });
        setKids(foot, more);
      } else {
        setKids(foot, st.items.length ? null : h('p.sb-empty', { text: 'No albums on this server yet.' }));
      }
    };
    if (!st.items.length && !st.done && !st.loading && !st.error) this._moreAlbums(st).then(draw);
    else if (st.loading && st.p) st.p.then(draw);
    draw();
  }

  _albumState(sort) {
    let st = this.albums.get(sort);
    if (!st) {
      st = { sort, items: [], done: false, loading: false, error: '', p: null, gen: this._gen };
      this.albums.set(sort, st);
    }
    return st;
  }

  /** Fetch the next page of albums for a list state. */
  _moreAlbums(st) {
    if (st.loading) return st.p;
    const c = this.client;
    if (!c) return Promise.resolve();
    st.loading = true;
    st.error = '';
    const gen = this._gen;
    st.p = Promise.resolve()
      .then(() => c.getAlbumList2(st.sort, ALBUM_PAGE, st.items.length))
      .then((res) => {
        if (gen !== this._gen) return;
        const got = listAlbums(res);
        const seen = new Set(st.items.map((a) => a.id));
        let added = 0;
        for (const a of got) {
          if (!seen.has(a.id)) {
            seen.add(a.id);
            st.items.push(a);
            added++;
          }
        }
        // a short page is the last one; a page of albums already shown (a server that ignores offset) too
        if (got.length < ALBUM_PAGE || added === 0) st.done = true;
      }, (err) => {
        if (gen !== this._gen) return;
        st.error = errText(err, UNREACHABLE);
      })
      .then(() => {
        st.loading = false;
      });
    return st.p;
  }

  _playlists(panel, host, live) {
    const d = this._load('playlists', (c) => c.getPlaylists());
    if (!this._ready(d, panel, live, () => this._playlists(panel, host, live))) return;
    const all = listPlaylists(d.value);
    if (!all.length) {
      setKids(panel, h('p.sb-empty', { text: 'No playlists yet. Make one in your server’s own app (Navidrome: ' +
        'Playlists > +); it shows up here.' }));
      return;
    }
    const list = h('div.sb-list', { role: 'list', 'aria-label': 'Playlists' });
    this._paged(list, 'playlists', all, (p) => {
      const b = h('button.sb-row.sb-pl', { type: 'button', role: 'listitem' }, this._cover(p.coverArt, COVER.row, '', 'playlist'),
        h('span.sb-row-main', {}, h('span.song-title', { text: p.name }), h('span.song-meta', { text: playlistLine(p) })),
        icon('chevron', 'row-chev'));
      b.addEventListener('click', () => host.push(this.playlistSheet(p)));
      return b;
    });
    setKids(panel, list);
  }

  _search(panel, host, live) {
    const input = h('input.src-input.sb-q', {
      type: 'search', inputmode: 'search', enterkeyhint: 'search', autocomplete: 'off', autocapitalize: 'none',
      autocorrect: 'off', spellcheck: 'false', placeholder: 'Songs, albums, artists', 'aria-label': 'Search your music server',
      value: this.query,
    });
    const out = h('div.sb-results', { 'aria-live': 'polite' });
    const form = h('form.sb-search', { role: 'search', novalidate: true }, icon('search', 'sb-q-ico'), input);
    const run = (force) => {
      clearTimeout(this._searchTimer);
      const q = input.value.trim();
      this.query = input.value;
      if (!q || (q.length < 2 && !force)) {
        setKids(out, h('p.sb-empty', { text: q ? 'Type one more letter, or press Search.' : 'Search your server for songs, albums and artists.' }));
        return;
      }
      this._results(out, host, live, q);
    };
    input.addEventListener('input', () => {
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => {
        if (live()) run(false);
      }, SEARCH_DELAY_MS);
    });
    form.addEventListener('submit', (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      run(true);
      try {
        input.blur(); // close the phone keyboard so the results show
      } catch {
        /* ignore */
      }
    });
    setKids(panel, form, out);
    run(false);
  }

  _results(out, host, live, q) {
    const key = `search:${q.toLowerCase()}`;
    const d = this._load(key, (c) => c.search3(q));
    if (!this._ready(d, out, live, () => {
      if (this.query.trim() === q) this._results(out, host, live, q);
    })) return;
    const r = searchOf(d.value);
    if (!r.artists.length && !r.albums.length && !r.songs.length) {
      setKids(out, h('p.sb-empty', { text: `Nothing found for “${q}”.` }));
      return;
    }
    const parts = [];
    if (r.songs.length) {
      const list = h('div.sb-list.sb-songs', { role: 'list', 'aria-label': 'Songs' });
      this._paged(list, `${key}:songs`, r.songs, (s) => this._songRow(s, host, { withArtist: true }));
      parts.push(h('h3.songs-h', {}, h('span', { text: 'Songs' }), h('span.songs-count', { text: String(r.songs.length) })), list);
    }
    if (r.albums.length) {
      parts.push(h('h3.songs-h', {}, h('span', { text: 'Albums' }), h('span.songs-count', { text: String(r.albums.length) })),
        h('div.sb-grid', { role: 'list', 'aria-label': 'Albums' }, r.albums.map((a) => this._albumCard(a, host))));
    }
    if (r.artists.length) {
      const list = h('div.sb-list', { role: 'list', 'aria-label': 'Artists' }, r.artists.map((a) => {
        const b = h('button.sb-row.sb-artist', { type: 'button', role: 'listitem' }, this._cover(a.coverArt, COVER.row, '.round', 'artist'),
          h('span.sb-row-main', {}, h('span.song-title', { text: a.name })), icon('chevron', 'row-chev'));
        b.addEventListener('click', () => host.push(this.artistSheet(a)));
        return b;
      }));
      parts.push(h('h3.songs-h', {}, h('span', { text: 'Artists' }), h('span.songs-count', { text: String(r.artists.length) })), list);
    }
    setKids(out, parts);
  }

  // ---- album / artist / playlist pages --------------------------------------------------------------------------

  _renderAlbum(root, host, live, album) {
    const d = this._load(`album:${album.id}`, (c) => c.getAlbum(album.id));
    const full = d.status === 'ok' ? albumOf(d.value) : null;
    const a = full || { ...album, songs: [] };
    const list = h('div.sb-list.sb-songs', { role: 'list', 'aria-label': `Songs of ${a.name}` });
    const actions = h('div.sb-actions');
    setKids(root, this._head(a.coverArt, a.name, a.artist, albumLine(a, { withArtist: false }), 'album'), actions, list);
    if (!this._ready(d, list, live, () => this._renderAlbum(root, host, live, album))) return;
    const songs = a.songs;
    if (!songs.length) {
      setKids(list, h('p.sb-empty', { text: 'This album has no songs.' }));
      return;
    }
    this._actions(actions, songs, a.name);
    const various = songs.some((s) => s.artist && s.artist !== a.artist);
    this._paged(list, `album:${album.id}`, songs, (s) => this._songRow(s, host, { withArtist: various, number: s.track }));
  }

  _renderPlaylist(root, host, live, pl) {
    const d = this._load(`playlist:${pl.id}`, (c) => c.getPlaylist(pl.id));
    const full = d.status === 'ok' ? playlistOf(d.value) : null;
    const p = full || { ...pl, songs: [] };
    const list = h('div.sb-list.sb-songs', { role: 'list', 'aria-label': `Songs of ${p.name}` });
    const actions = h('div.sb-actions');
    setKids(root, this._head(p.coverArt, p.name, p.owner ? `By ${p.owner}` : '', playlistLine(p), 'playlist'), actions, list);
    if (!this._ready(d, list, live, () => this._renderPlaylist(root, host, live, pl))) return;
    if (!p.songs.length) {
      setKids(list, h('p.sb-empty', { text: 'This playlist is empty.' }));
      return;
    }
    this._actions(actions, p.songs, p.name);
    this._paged(list, `playlist:${pl.id}`, p.songs, (s) => this._songRow(s, host, { withArtist: true }));
  }

  _renderArtist(root, host, live, artist) {
    const d = this._load(`artist:${artist.id}`, (c) => c.getArtist(artist.id));
    const full = d.status === 'ok' ? artistOf(d.value) : null;
    const a = full || { ...artist, albums: [] };
    const grid = h('div.sb-grid', { role: 'list', 'aria-label': `Albums by ${a.name}` });
    setKids(root, this._head(a.coverArt, a.name, '', a.albumCount ? countWord(a.albumCount, 'album') : '', 'artist'), grid);
    if (!this._ready(d, grid, live, () => this._renderArtist(root, host, live, artist))) return;
    if (!a.albums.length) {
      setKids(grid, h('p.sb-empty', { text: 'No albums by this artist.' }));
      return;
    }
    setKids(grid, a.albums.map((x) => this._albumCard(x, host)));
  }

  /** Big cover + title lines at the top of an album / playlist / artist page. */
  _head(coverId, title, sub, line, kind) {
    return h('div.sb-head', {}, this._cover(coverId, COVER.head, kind === 'artist' ? '.round.big' : '.big', kind),
      h('div.sb-head-main', {}, h('h3.sb-head-title', { text: title || '' }), sub ? h('p.sb-head-sub', { text: sub }) : null,
        line ? h('p.sb-head-line', { text: line }) : null));
  }

  /** "Add all" (to the queue / set list) and "Save offline" for an album or a playlist. */
  _actions(el, songs, name) {
    const app = this.app;
    const kids = [];
    if (app.playlist) {
      const add = h('button.btn.btn-primary.btn-sm.sb-addall', { type: 'button' }, icon('listAdd'),
        h('span', { text: 'Add all' }));
      add.setAttribute('aria-label', `Add all ${countWord(songs.length, 'song')} of ${name} to the ${app.player ? 'queue' : 'set list'}`);
      add.addEventListener('click', () => this.act('all', songs));
      kids.push(add);
    }
    const save = h('button.btn.btn-sm.sb-saveall', { type: 'button' }, icon('download'), h('span', { text: 'Save offline' }));
    save.setAttribute('aria-label', `Save all ${countWord(songs.length, 'song')} of ${name} on this device`);
    save.addEventListener('click', () => this.act('offline', songs));
    kids.push(save);
    setKids(el, kids);
  }

  // ---- rows and cards ---------------------------------------------------------------------------------------------

  /** Render `all` into `list` a page at a time, with "Show more" (the count is kept per list key). */
  _paged(list, key, all, row) {
    const draw = () => {
      const { items, left } = pageOf(all, this.shown.get(key) || PAGE);
      const kids = items.map(row);
      if (left > 0) {
        const more = h('button.btn.btn-sm.sb-more', { type: 'button' }, h('span', { text: `Show ${Math.min(left, PAGE)} more` }),
          h('span.songs-count', { text: String(left) }));
        more.addEventListener('click', () => {
          this.shown.set(key, (this.shown.get(key) || PAGE) + PAGE);
          draw();
        });
        kids.push(h('div.sb-foot', {}, more));
      }
      setKids(list, kids);
    };
    draw();
  }

  _albumCard(a, host) {
    const b = h('button.sb-card', { type: 'button', role: 'listitem', 'aria-label': `${a.name}${a.artist ? `, ${a.artist}` : ''}` },
      this._cover(a.coverArt, COVER.card, '.card', 'album'),
      h('span.sb-card-title', { text: a.name }), a.artist ? h('span.sb-card-sub', { text: a.artist }) : null);
    b.addEventListener('click', () => host.push(this.albumSheet(a)));
    return b;
  }

  _songRow(s, host, { withArtist = true, number = 0 } = {}) {
    const saved = this._savedIds();
    const isSaved = saved.has(s.id);
    const meta = songLine(s, { withArtist });
    const main = h('button.sb-song-main', { type: 'button', 'aria-haspopup': 'dialog',
      'aria-label': `${s.title}${s.artist ? `, ${s.artist}` : ''}: play, queue or load on a deck` },
    number > 0 ? h('span.sb-num', { text: String(number) }) : null,
    h('span.sb-row-main', {}, h('span.song-title', { text: s.title }),
      h('span.song-meta', {}, h('span.sb-saved', { hidden: !isSaved, 'aria-label': 'saved on this device' }, icon('check')), meta)));
    main.addEventListener('click', () => this._openSong(s, host));
    const kids = [main];
    if (this.app.playlist) {
      const add = h('button.add-btn.sb-add', { type: 'button', 'aria-label': `Add ${s.title} to the ${this.app.player ? 'queue' : 'set list'}` }, icon('plus'));
      add.addEventListener('click', () => {
        add.classList.add('added');
        setTimeout(() => add.classList.remove('added'), 900);
        this.act('queue', [s]);
      });
      kids.push(add);
    }
    return h('div.sb-song', { role: 'listitem', dataset: { song: s.id } }, kids);
  }

  _openSong(s, host) {
    const saved = this._savedIds().has(s.id);
    host.push(songSheet(this.app, {
      title: s.title,
      meta: [s.artist, s.album].filter(Boolean).join(' · '),
      onAction: (kind) => this.act(kind, [s]),
      loads: true,
      offline: saved ? 'saved' : 'save',
      stayOn: ['next', 'queue', 'offline'],
    }));
  }

  /** Cover art from the server (lazy), over a plain placeholder that stays when there is none. */
  _cover(id, size, cls, kind) {
    const box = h(`span.sb-cover${cls || ''}`, { 'aria-hidden': 'true' }, icon(kind === 'artist' ? 'artist' : kind === 'playlist' ? 'playlist' : 'album', 'sb-cover-ico'));
    const c = this.client;
    let url = '';
    if (id && c && typeof c.coverArtUrl === 'function') {
      try {
        url = c.coverArtUrl(id, size) || '';
      } catch {
        url = '';
      }
    }
    if (url) {
      const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false' });
      img.addEventListener('load', () => box.classList.add('has-img'));
      img.addEventListener('error', () => img.remove());
      img.setAttribute('src', url);
      box.append(img);
    }
    return box;
  }

  /** Song ids of this server that are saved on this device (library entries with stored: true). */
  _savedIds() {
    const out = new Set();
    const lib = this.app.library;
    const sid = this._serverId();
    try {
      for (const e of lib.list() || []) {
        const r = e && e.remote;
        if (r && r.kind === 'subsonic' && e.stored === true && (!sid || !r.serverId || r.serverId === sid)) out.add(String(r.songId));
      }
    } catch {
      /* no library */
    }
    return out;
  }

  _serverId() {
    const s = this.server;
    try {
      return s && s.server && s.server.id ? String(s.server.id) : '';
    } catch {
      return '';
    }
  }

  /** Library changed: update the "saved" marks of the visible song rows. */
  _refreshMarks(root) {
    const saved = this._savedIds();
    for (const row of root.querySelectorAll('.sb-song')) {
      const mark = row.querySelector('.sb-saved');
      if (mark) mark.hidden = !saved.has(row.dataset.song);
    }
  }

  // ---- actions ----------------------------------------------------------------------------------------------------

  /**
   * The library entries for server songs, adding the missing ones (library.addRemote). Never rejects: [] when
   * they could not be added (a toast says why).
   */
  async ensureEntries(songs) {
    const lib = this.app.library;
    const s = this.server;
    if (!lib || typeof lib.addRemote !== 'function' || !s || typeof s.toEntries !== 'function') {
      this.app.toast('Songs from a music server need a newer TwinSpin. Reload the page.', { kind: 'error' });
      return [];
    }
    let res;
    try {
      res = await lib.addRemote(s.toEntries(songs.map((x) => x.raw || x)));
    } catch (err) {
      this.app.toast(errText(err, "Those songs couldn't be added. Try again."), { kind: 'error' });
      return [];
    }
    if (Array.isArray(res) && res.length === songs.length && res.every((e) => e && e.id)) return res;
    // look them up by their server song id
    const sid = this._serverId();
    let all = [];
    try {
      all = lib.list() || [];
    } catch {
      all = [];
    }
    const out = [];
    for (const x of songs) {
      const e = all.find((y) => y && y.remote && y.remote.kind === 'subsonic' && String(y.remote.songId) === String(x.id) &&
        (!sid || !y.remote.serverId || String(y.remote.serverId) === sid));
      if (e) out.push(e);
    }
    if (!out.length) this.app.toast("Those songs couldn't be added. Try again.", { kind: 'error' });
    return out;
  }

  /**
   * Do something with server songs: 'now' | 'next' | 'queue' (the player, or the set list without one),
   * 'all' (every song to the end of the queue), 'loadA' | 'loadB', 'offline' (save on this device).
   */
  async act(kind, songs) {
    const app = this.app;
    const list = (songs || []).filter(Boolean);
    if (!list.length) return;
    const entries = await this.ensureEntries(list);
    if (!entries.length) return;
    if (kind === 'loadA' || kind === 'loadB') {
      app.loadFromLibrary(kind === 'loadB' ? 1 : 0, entries[0]);
    } else if (kind === 'offline') {
      app.sourcesUI.saveOffline(entries);
    } else if (kind === 'all') {
      // (a full set list: addToSetList has already said so)
      const n = app.addToSetList(entries, { quiet: true });
      if (n > 0) {
        const opts = { kind: 'ok' };
        if (app.player && app.page !== 'player') opts.action = { label: 'Player', onClick: () => app.showPlayer() };
        app.toast(`Added ${countWord(n, 'song')} to the ${app.player ? 'queue' : 'set list'}`, opts);
      }
    } else if (app.player) {
      app.songAction(kind, entries[0]);
    } else {
      app.addToSetList(entries);
    }
  }
}
