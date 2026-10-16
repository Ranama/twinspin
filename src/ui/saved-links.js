// Saved Google Drive links in the Add music sheets (src/sources/drive-links.js keeps them on this device):
//  * savedLinksSection: the "Saved links" section of the Google Drive link sheet, above the paste field (hidden
//    while there are none). One card per link: a folder or song icon, the name, "9 songs · imported 16 Oct", a
//    big Import again button and a ⋯ button that opens Copy link (the clipboard, else a field to select), Rename
//    (inline) and Remove (two taps: "Remove?" then gone, like the Songs list); "Forget all saved links" asks first.
//    When the browser blocks storage the note says the links are kept for this visit only.
//  * savedLinksQuick: up to 3 quick rows under "Paste a Google Drive link" in Add music (name, short line,
//    Import) and "All saved links (N)", hidden while there are none or Drive links are not set up.
// Both follow the store's 'change' event (also from another tab) and return { el, destroy }.
//   const saved = savedLinksSection(app, host);  body.append(saved.el);  ...  saved.destroy();

import { h, icon, setKids } from './dom.js';
import { section } from './sheets/sheet.js';
import { savedLinkName, savedLinkMeta } from './sources-text.js';

/** Cards shown before "Show N more". */
export const SAVED_LINKS_SHOWN = 6;
/** Quick rows in Add music. */
export const QUICK_LINKS = 3;
const DISARM_MS = 3500;

function store(app) {
  const src = app.sourcesUI;
  return src ? src.driveLinks : null;
}

/** Select the whole text of a field (the copy fallback). */
function selectAll(input) {
  try {
    input.focus({ preventScroll: true });
    if (typeof input.select === 'function') input.select();
    if (typeof input.setSelectionRange === 'function') input.setSelectionRange(0, String(input.value || '').length);
  } catch {
    /* the user can still select it by hand */
  }
}

/**
 * The "Saved links" section of the Google Drive link sheet.
 * @param {object} app the AppUI (sourcesUI, toast(), dialog)
 * @param {object} host the sheet host (Import again closes it)
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function savedLinksSection(app, host) {
  const src = app.sourcesUI;
  const links = store(app);
  const err = h('p.dl-error', { role: 'alert', hidden: true });
  const list = h('div.dl-list', { role: 'list', 'aria-label': 'Saved Google Drive links' });
  const foot = h('div.dl-foot');
  const note = h('p.sheet-note.dl-note');
  const el = section('Saved links', note, err, list, foot);
  el.classList.add('dl-saved');
  // menu: the id whose ⋯ is open; renaming: the id being renamed (draft = its text); armed: the two-step remove;
  // copy: the id whose link shows in a field to select; all: every card shown
  const state = { menu: null, renaming: null, draft: '', armed: null, copy: null, all: false };

  const disarm = () => {
    if (state.armed) clearTimeout(state.armed.timer);
    state.armed = null;
  };

  const importNow = (id) => {
    const r = src.importSavedLink(id);
    if (r && r.error) {
      err.textContent = r.error;
      err.hidden = false;
      return;
    }
    err.hidden = true;
    host.close();
  };

  const copyLink = (link) => {
    const clip = typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function'
      ? navigator.clipboard : null;
    const fallback = () => {
      state.copy = link.id;
      render();
      const field = list.querySelector('.dl-url');
      if (field) selectAll(field);
    };
    if (!clip) {
      fallback();
      return;
    }
    let p;
    try {
      p = clip.writeText(link.url); // still inside the tap: Safari wants that
    } catch (e) {
      p = Promise.reject(e);
    }
    Promise.resolve(p).then(() => app.toast('Link copied', { kind: 'ok' }), fallback);
  };

  const removeTap = (link) => {
    if (!state.armed || state.armed.id !== link.id) {
      disarm();
      state.armed = { id: link.id, timer: setTimeout(() => {
        state.armed = null;
        render();
      }, DISARM_MS) };
      render();
      return;
    }
    disarm();
    state.menu = null;
    state.copy = null;
    const name = savedLinkName(link);
    if (!links.remove(link.id)) {
      render();
      return;
    }
    app.toast(`Removed “${name}” from your saved links`, { kind: 'ok' });
    // the focused button is gone: the next card's Import again takes the focus
    const next = list.querySelector('.dl-go');
    if (next) {
      try {
        next.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }
  };

  const forgetAll = async () => {
    const n = links.size;
    const ok = await app.dialog.confirm({
      title: 'Forget all saved links?',
      message: `TwinSpin forgets the ${n === 1 ? 'Google Drive link' : `${n} Google Drive links`} saved on this device. ` +
        'Your songs stay.',
      ok: 'Forget links', cancel: 'Keep them', danger: true,
    });
    if (!ok) return;
    links.clear();
    app.toast('Saved links forgotten', { kind: 'ok' });
  };

  const renameForm = (link) => {
    const input = h('input.src-input.dl-name-input', {
      type: 'text', maxlength: '120', autocomplete: 'off', enterkeyhint: 'done', 'aria-label': 'Name for this saved link',
      dataset: { k: `${link.id}:name` },
    });
    input.value = state.draft;
    const hint = h('p.dl-error', { role: 'alert', hidden: true, text: 'Type a name.' });
    const cancel = h('button.btn.btn-sm.dl-cancel', { type: 'button', text: 'Cancel' });
    const save = h('button.btn.btn-sm.btn-primary.dl-save', { type: 'submit', text: 'Save' });
    const form = h('form.dl-rename', { novalidate: true }, input, h('div.dl-rename-btns', {}, cancel, save), hint);
    const stop = (refocus) => {
      state.renaming = null;
      state.draft = '';
      render(refocus);
    };
    input.addEventListener('input', () => {
      state.draft = input.value;
      hint.hidden = true;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation(); // Escape ends the rename, not the whole sheet
      stop(`${link.id}:more`);
    });
    cancel.addEventListener('click', () => stop(`${link.id}:more`));
    form.addEventListener('submit', (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      if (!links.rename(link.id, input.value)) {
        hint.hidden = false;
        return;
      }
      stop(`${link.id}:more`);
    });
    return form;
  };

  const menu = (link, name) => {
    const copy = h('button.btn.btn-sm.dl-copy', { type: 'button', text: 'Copy link', dataset: { k: `${link.id}:copy` } });
    copy.addEventListener('click', () => copyLink(link));
    const rename = h('button.btn.btn-sm.dl-rename-btn', { type: 'button', text: 'Rename', dataset: { k: `${link.id}:rename` } });
    rename.addEventListener('click', () => {
      disarm();
      state.renaming = link.id;
      state.draft = link.name || '';
      state.menu = null;
      state.copy = null;
      render(`${link.id}:name`);
    });
    const armed = !!state.armed && state.armed.id === link.id;
    const rm = h(`button.btn.btn-sm.dl-rm${armed ? '.armed' : ''}`, { type: 'button', dataset: { k: `${link.id}:rm` },
      'aria-label': armed ? `Confirm remove “${name}” from your saved links` : `Remove “${name}” from your saved links`,
      text: armed ? 'Remove?' : 'Remove' });
    rm.addEventListener('click', () => removeTap(link));
    const kids = [h('div.dl-actions', {}, copy, rename, rm)];
    if (state.copy === link.id) {
      const field = h('input.src-input.dl-url', { type: 'text', readonly: true, 'aria-label': `Link to “${name}”`,
        dataset: { k: `${link.id}:url` } });
      field.value = link.url;
      field.addEventListener('focus', () => {
        try {
          field.select();
        } catch {
          /* ignore */
        }
      });
      kids.push(h('p.sheet-note.dl-copy-note', { text: 'Select the link and copy it.' }), field);
    }
    return h('div.dl-menu', { id: `dl-menu-${link.id}` }, kids);
  };

  const card = (link) => {
    const name = savedLinkName(link);
    const ico = h('span.dl-ico', { 'aria-hidden': 'true' }, icon(link.kind === 'file' ? 'songs' : 'folder'));
    if (state.renaming === link.id) {
      return h('div.dl-row.renaming', { role: 'listitem', dataset: { id: link.id, kind: link.kind } }, ico, renameForm(link));
    }
    const open = state.menu === link.id;
    const main = h('div.dl-main', {}, h('span.dl-name', { text: name }),
      h('span.dl-meta', { text: savedLinkMeta(link, Date.now()) }));
    const go = h('button.btn.btn-sm.dl-go', { type: 'button', 'aria-label': `Import “${name}” again`, dataset: { k: `${link.id}:go` } },
      icon('download'), h('span', { text: 'Import again' }));
    go.addEventListener('click', () => importNow(link.id));
    const more = h('button.icon-btn.dl-more', { type: 'button', 'aria-expanded': open ? 'true' : 'false',
      'aria-controls': open ? `dl-menu-${link.id}` : null, 'aria-label': `More for “${name}”: copy link, rename, remove`,
      dataset: { k: `${link.id}:more` } }, icon('more'));
    more.addEventListener('click', () => {
      disarm();
      state.menu = open ? null : link.id;
      state.copy = null;
      render(`${link.id}:more`);
    });
    return h(`div.dl-row${open ? '.open' : ''}`, { role: 'listitem', dataset: { id: link.id, kind: link.kind } },
      ico, main, go, more, open ? menu(link, name) : null);
  };

  /** Draw the cards again; `focusKey` (or the control that had focus) gets the focus back after the redraw. */
  function render(focusKey) {
    const all = links ? links.list() : [];
    el.hidden = !all.length;
    // storage blocked (or full): say that the list only lasts for this visit
    note.textContent = 'Links you imported on this device. Import one again with a tap, no need to look it up.' +
      (links && links.persistent === false ? ' This browser blocks storage for TwinSpin, so they are kept for this ' +
        'visit only.' : '');
    if (state.renaming && !all.some((l) => l.id === state.renaming)) state.renaming = null;
    if (state.menu && !all.some((l) => l.id === state.menu)) state.menu = null;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const key = focusKey || (active && list.contains(active) && active.dataset ? active.dataset.k : '');
    const shown = state.all ? all : all.slice(0, SAVED_LINKS_SHOWN);
    setKids(list, shown.map(card));
    const left = all.length - shown.length;
    const kids = [];
    if (left > 0) {
      const moreBtn = h('button.btn.btn-ghost.btn-sm.dl-showall', { type: 'button', text: `Show ${left} more` });
      moreBtn.addEventListener('click', () => {
        state.all = true;
        render();
      });
      kids.push(moreBtn);
    }
    const forget = h('button.btn.btn-ghost.btn-sm.dl-forget', { type: 'button', text: 'Forget all saved links' });
    forget.addEventListener('click', () => {
      forgetAll();
    });
    kids.push(forget);
    setKids(foot, kids);
    if (key) {
      const target = list.querySelector(`[data-k="${key}"]`);
      if (target) {
        try {
          target.focus({ preventScroll: true });
        } catch {
          /* ignore */
        }
      }
    }
  }

  const off = links && typeof links.on === 'function' ? links.on('change', () => render()) : null;
  render();
  return {
    el,
    destroy() {
      disarm();
      if (off) off();
    },
  };
}

/**
 * Up to QUICK_LINKS saved links under "Paste a Google Drive link" in Add music, plus "All saved links (N)".
 * @param {object} app the AppUI (sourcesUI, toast())
 * @param {object} host the sheet host (Import closes it)
 * @param {{ openAll: () => void }} opts opens the Google Drive link sheet with every saved link
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function savedLinksQuick(app, host, { openAll }) {
  const src = app.sourcesUI;
  const links = store(app);
  const el = h('div.add-saved', { role: 'group', 'aria-label': 'Saved Google Drive links', hidden: true });
  const render = () => {
    const all = links && src.driveLinkReady ? links.list() : [];
    el.hidden = !all.length;
    if (!all.length) {
      setKids(el);
      return;
    }
    const rows = all.slice(0, QUICK_LINKS).map((link) => {
      const name = savedLinkName(link);
      const go = h('button.btn.btn-sm.add-saved-go', { type: 'button', 'aria-label': `Import “${name}” again` },
        h('span', { text: 'Import' }));
      go.addEventListener('click', () => {
        const r = src.importSavedLink(link.id);
        if (r && r.error) app.toast(r.error, { kind: 'error' });
        else host.close();
      });
      return h('div.add-saved-row', { dataset: { id: link.id, kind: link.kind } },
        h('span.add-saved-ico', { 'aria-hidden': 'true' }, icon(link.kind === 'file' ? 'songs' : 'folder')),
        h('span.add-saved-main', {}, h('span.add-saved-name', { text: name }),
          h('span.add-saved-meta', { text: savedLinkMeta(link, Date.now(), { short: true }) })),
        go);
    });
    const allBtn = h('button.add-saved-all', { type: 'button' }, h('span', { text: `All saved links (${all.length})` }),
      icon('chevron', 'row-chev'));
    allBtn.addEventListener('click', () => openAll());
    setKids(el, rows, allBtn);
  };
  const off = links && typeof links.on === 'function' ? links.on('change', render) : null;
  render();
  return {
    el,
    destroy() {
      if (off) off();
    },
  };
}
