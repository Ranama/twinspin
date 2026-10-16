// Song actions sheet: the ⋯ button of a library or demo row on the Songs page (docs/PLAYER.md section 5), and a
// song row of the music server browser (docs/SOURCES.md section 4). Play now (the player jumps to it with a quick
// fade, or starts with it), Play next (right after the current song), Add to queue (the end of the set list),
// optionally Load on deck A / B (server songs: the Songs rows have A / B on the row), Save offline for a song that
// plays from the music server, and for your own songs Remove from this device (asks first). Keeps the rows on a
// 360 px phone down to A / B / + / ⋯ (the A / B load buttons stay on the row).
//   app.sheets.open(songSheet(app, { title, meta, entry, onRemove: () => ... }));
//   host.push(songSheet(app, { title, meta, onAction: (kind) => ..., loads: true, offline: 'save' }));

import { h, icon } from '../dom.js';
import { section, navRow } from './sheet.js';
import { sourceBadge, needsDownload } from '../sources-text.js';

/**
 * @param {object} app  the AppUI (songAction(), loadFromLibrary(), addToSetList(), sourcesUI, sheets)
 * @param {{title:string, meta?:string, entry?:object, onRemove?:()=>void, onAction?:(kind:string)=>void,
 *   loads?:boolean, offline?:'save'|'saved'|null, removeText?:string}} o
 *   entry: the library entry or { kind: 'demo', id, title, artist, bpm }; onRemove only for library songs.
 *   onAction(kind) replaces the default actions (kind: 'now' | 'next' | 'queue' | 'loadA' | 'loadB' | 'offline');
 *   loads adds Load on deck A / B; offline adds Save offline ('save') or a "saved" line ('saved'); by default
 *   a library song that plays from the music server gets Save offline. stayOn: the kinds after which a pushed
 *   sheet goes back to the sheet below (the server browser keeps its album open after Add to queue).
 */
export function songSheet(app, { title, meta = '', entry = null, onRemove = null, onAction = null, loads = false, offline, removeText,
  stayOn = [] }) {
  const badge = entry ? sourceBadge(entry) : null;
  const off = offline !== undefined ? offline : entry && needsDownload(entry) ? 'save' : null;
  return {
    id: 'song',
    title: title || 'Song',
    mount(body, host) {
      const run = (kind) => {
        if (onAction) {
          onAction(kind);
          return;
        }
        if (kind === 'loadA' || kind === 'loadB') app.loadFromLibrary(kind === 'loadB' ? 1 : 0, entry);
        else if (kind === 'offline') app.sourcesUI.saveOffline([entry]);
        else if (app.player) app.songAction(kind, entry);
        else app.addToSetList([entry]);
      };
      const act = (kind) => () => {
        // pushed over a list (the server browser): queueing goes back to that list, playing closes everything
        if (stayOn.includes(kind) && host.stack && host.stack.length > 1) host.back();
        else host.close();
        run(kind);
      };
      const rows = [];
      if (app.player) {
        rows.push(
          navRow('play', 'Play now', 'Starts it now; the queue goes on after it', act('now'), { noChevron: true }),
          navRow('playNext', 'Play next', 'Plays right after the current song', act('next'), { noChevron: true }),
          navRow('listAdd', 'Add to queue', 'Adds it to the end of the queue (the set list)', act('queue'), { noChevron: true }));
      } else if (app.playlist) {
        rows.push(navRow('listAdd', 'Add to the set list', 'Adds it to the end of the set list', act('queue'), { noChevron: true }));
      }
      const parts = [];
      if (meta || badge) {
        parts.push(h('p.sheet-note.song-sheet-meta', {},
          badge ? icon(badge.icon, `inline-ico src-ico src-${badge.kind}`) : icon('songs', 'inline-ico'),
          h('span', { text: ` ${[meta, badge ? badge.label : ''].filter(Boolean).join(' · ')}` })));
      }
      if (rows.length) parts.push(section(app.player ? 'Player' : 'Set list', ...rows.map((r) => r.el)));
      if (loads) {
        const deckRow = (i) => {
          const id = i ? 'B' : 'A';
          const r = navRow('decks', `Load on deck ${id}`, i ? 'The orange deck on the right' : 'The blue deck on the left',
            act(i ? 'loadB' : 'loadA'), { noChevron: true, className: `row-load deck-${id.toLowerCase()}` });
          return r.el;
        };
        parts.push(section('Decks', deckRow(0), deckRow(1)));
      }
      if (off === 'save') {
        parts.push(section('', navRow('download', 'Save offline', 'Keeps a copy on this device, so it plays without the ' +
          'server and mixes without waiting', act('offline'), { noChevron: true }).el));
      } else if (off === 'saved') {
        parts.push(section('', h('p.sheet-note.song-saved', {}, icon('check', 'inline-ico'),
          h('span', { text: ' Saved on this device: it plays without the server.' }))));
      }
      if (onRemove) {
        const streamed = entry && needsDownload(entry);
        const rm = navRow('trash', streamed ? 'Remove from your songs' : 'Remove from this device', removeText ||
          (streamed ? 'It stays on your music server. Songs on the decks keep playing.'
            : 'Deletes the saved song. Songs on the decks keep playing.'), () => {
          host.close();
          onRemove();
        }, { noChevron: true, className: 'row-danger' });
        parts.push(section('', rm.el));
      }
      body.append(...parts);
    },
  };
}
