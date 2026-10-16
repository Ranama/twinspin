// The small cloud / server badge in front of a song title (docs/SOURCES.md section 4): songs from Google Drive
// (stored on this device) and songs on the music server (they download when played; a filled badge once saved
// offline). Used by the Songs list, the set list and the player's Up next / History.
//   h('span.song-title', {}, sourceBadgeEl(entry), title);
//   sourceBadgeEl(libraryEntryOf(app.library, setListItem));

import { h, icon } from './dom.js';
import { sourceBadge } from './sources-text.js';

/** The badge element for a library entry, or null for a song from this device (or a demo). */
export function sourceBadgeEl(entry) {
  const b = entry ? sourceBadge(entry) : null;
  if (!b) return null;
  return h(`span.src-badge.src-${b.kind}${b.offline ? '.offline' : ''}`, { title: b.label },
    icon(b.icon), h('span.sr-only', { text: `(${b.label}) ` }));
}

/** The library entry of a set-list / queue item ({ kind: 'library', id }), or null. */
export function libraryEntryOf(library, item) {
  if (!library || !item || item.kind !== 'library' || typeof library.get !== 'function') return null;
  try {
    return library.get(item.id) || null;
  } catch {
    return null;
  }
}
