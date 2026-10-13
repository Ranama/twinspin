// Song actions sheet: the ⋯ button of a library or demo row on the Songs page (docs/PLAYER.md section 5). Play now
// (the player jumps to it with a quick fade, or starts with it), Play next (right after the current song), Add to
// queue (the end of the set list), and for your own songs Remove from this device (asks first). Keeps the rows
// on a 360 px phone down to A / B / + / ⋯ (the A / B load buttons stay on the row).
//   app.sheets.open(songSheet(app, { title, meta, entry, onRemove: () => ... }));

import { h, icon } from '../dom.js';
import { section, navRow } from './sheet.js';

/**
 * @param {object} app  the AppUI (songAction(), sheets)
 * @param {{title:string, meta?:string, entry:object, onRemove?:()=>void}} o
 *   entry: the library entry or { kind: 'demo', id, title, artist, bpm }; onRemove only for library songs
 */
export function songSheet(app, { title, meta = '', entry, onRemove = null }) {
  return {
    id: 'song',
    title: title || 'Song',
    mount(body, host) {
      const act = (kind) => () => {
        host.close();
        app.songAction(kind, entry);
      };
      const rows = [
        navRow('play', 'Play now', 'Starts it now; the queue goes on after it', act('now'), { noChevron: true }),
        navRow('playNext', 'Play next', 'Plays right after the current song', act('next'), { noChevron: true }),
        navRow('listAdd', 'Add to queue', 'Adds it to the end of the queue (the set list)', act('queue'), { noChevron: true }),
      ];
      const parts = [];
      if (meta) parts.push(h('p.sheet-note.song-sheet-meta', {}, icon('songs', 'inline-ico'), h('span', { text: ` ${meta}` })));
      parts.push(section('Player', ...rows.map((r) => r.el)));
      if (onRemove) {
        const rm = navRow('trash', 'Remove from this device', 'Deletes the saved song. Songs on the decks keep playing.', () => {
          host.close();
          onRemove();
        }, { noChevron: true, className: 'row-danger' });
        parts.push(section('', rm.el));
      }
      body.append(...parts);
    },
  };
}
