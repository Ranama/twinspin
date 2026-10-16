// Add music sheet (docs/SOURCES.md section 4): the ways to bring songs in, as big rows: This device (the
// file input, opens the system picker in the same tap), Google Drive (Google's own picker; a short explanation and
// the setup guide while it is not set up), Music server / NAS (the server browser), Paste a Drive link (with up
// to 3 saved links right under it, src/ui/saved-links.js) and Songs from Suno (how to download them from Suno,
// incl. the playlist helper script, src/ui/sheets/suno-sheet.js); then a collapsible "Other ways" card: how the
// phone's own file picker already reaches Google Drive and the NAS (iPhone Files app, Android system picker, CIFS
// Documents Provider, a mapped network drive), current platform first. Opened by the Songs page's Add music
// button, the player's empty state and the menu.
//   app.sheets.open(addMusicSheet(app));  host.push(driveLinkSheet(app));

import { h, icon, fileLabel } from '../dom.js';
import { section } from './sheet.js';
import { ACCEPT } from '../../audio/decode.js';
import { env } from '../../core/env.js';
import { otherWays, GUIDES } from '../sources-text.js';
import { savedLinksSection, savedLinksQuick } from '../saved-links.js';
import { sunoSheet } from './suno-sheet.js';

/** One big option row: icon, label, detail, chevron. `tag` 'button' (default) or an element from fileLabel. */
function optionKids(ico, label, detail) {
  const det = h('span.row-detail', { text: detail || '' });
  return {
    kids: [h('span.add-opt-ico', { 'aria-hidden': 'true' }, icon(ico)),
      h('span.row-main', {}, h('span.row-label', { text: label }), det), icon('chevron', 'row-chev')],
    det,
  };
}

function option(cls, ico, label, detail, onClick) {
  const { kids, det } = optionKids(ico, label, detail);
  const el = h(`button.row.add-opt.${cls}`, { type: 'button' }, kids);
  el.addEventListener('click', onClick);
  return { el, det };
}

/** A link that opens in a new tab (the guides live on GitHub). */
export function guideLink(href, text, cls = '') {
  return h(`a.src-link${cls ? '.' + cls : ''}`, { href, target: '_blank', rel: 'noopener' },
    h('span', { text }), icon('external', 'inline-ico'));
}

/**
 * @param {object} app the AppUI (sourcesUI, addFiles(), sheets)
 */
export function addMusicSheet(app) {
  return {
    id: 'add-music',
    title: 'Add music',
    mount(body, host) {
      const src = app.sourcesUI;
      src.preloadDrive();

      // This device: the label wraps the file input, so the system picker opens in this very tap
      const dev = optionKids('phone', 'This device', env.ios
        ? 'Files on this iPhone or iPad, iCloud Drive and other places in the Files app'
        : env.android ? 'Downloads, Music, an SD card, or Drive from the picker’s menu'
          : 'Songs on this computer, also a mapped network drive');
      const device = fileLabel('row.add-opt.add-device', ACCEPT, true, 'Add music from this device', (files) => {
        host.close();
        app.addFiles(files);
      }, ...dev.kids).label;

      // Google Drive
      const driveInfo = h('div.add-explain', { hidden: true });
      const drive = option('add-drive', 'cloud', 'Google Drive', src.driveDetail(), () => {
        if (!src.driveConfigured) {
          const open = driveInfo.hidden;
          driveInfo.hidden = !open;
          drive.el.setAttribute('aria-expanded', open ? 'true' : 'false');
          return;
        }
        if (!src.driveReady) {
          // Google's scripts are still loading (or failed): the popup could not open from this tap yet
          src.preloadDrive();
          drive.det.textContent = src.driveDetail();
          app.toast('Google Drive is getting ready. Tap Google Drive again in a moment.');
          return;
        }
        // pick() opens Google's sign-in popup: it must start inside this tap, before anything else
        if (src.pickDrive()) host.close();
      });
      if (!src.driveConfigured) {
        drive.el.setAttribute('aria-expanded', 'false');
        driveInfo.append(
          h('p', { text: 'Google Drive needs a one-time setup by whoever runs this copy of TwinSpin: a free Google ' +
            'Cloud project that gives three public values for config.js. It takes about 15 minutes.' }),
          h('p', { text: 'Until then your phone can open Drive itself: Add music > This device, then Google Drive in ' +
            'the picker (see Other ways below).' }),
          guideLink(GUIDES.drive, 'How to set up Google Drive'));
      }
      src.onDriveState = () => {
        drive.det.textContent = src.driveDetail();
      };

      // Music server / NAS
      const srv = option('add-server', 'server', 'Music server / NAS', src.serverDetail(), () => {
        host.push(src.browser.sheet());
      });

      // Paste a Drive link (needs only the API key: no sign-in); the links imported before, one tap away
      const link = option('add-link', 'link', 'Paste a Google Drive link', 'A song or a folder shared with “Anyone with ' +
        'the link”. No sign-in.', () => host.push(driveLinkSheet(app)));
      const quick = savedLinksQuick(app, host, { openAll: () => host.push(driveLinkSheet(app)) });

      // Songs from Suno: how to download them from Suno (one by one, or a playlist with the helper script)
      const suno = option('add-suno', 'fx', 'Songs from Suno', 'Download your Suno songs, then add them here',
        () => host.push(sunoSheet(app, { driveLinkSheet })));

      // Other ways: the phone's own file picker already reaches Drive and the NAS
      const ways = otherWays(env).map((w) => h('section.add-way', { dataset: { way: w.id } },
        h('h4.add-way-h', { text: w.title }), h('ul.help-list', {}, w.items.map((t) => h('li', { text: t })))));
      const other = h('details.add-other', {},
        h('summary', {}, icon('help', 'inline-ico'), h('span', { text: 'Other ways' }), icon('chevronDown', 'add-other-chev')),
        h('p.sheet-note', { text: 'Your phone or computer can open Google Drive and your NAS by itself. Pick the ' +
          'songs with This device; they are saved in TwinSpin like any other song.' }),
        ...ways,
        h('p.add-guides', {}, guideLink(GUIDES.nas, 'NAS guide'), guideLink(GUIDES.drive, 'Google Drive guide')));

      body.append(
        section('', device, drive.el, driveInfo, srv.el, link.el, quick.el, suno.el),
        section('', other),
        h('p.sheet-note.add-privacy', {}, h('span', { text: 'Songs stay on this device. TwinSpin only talks to the ' +
          'services you connect. ' }), h('a.src-link', { href: GUIDES.privacy, target: '_blank', rel: 'noopener', text: 'Privacy' })));
      return () => {
        src.onDriveState = null;
        quick.destroy();
      };
    },
  };
}

/**
 * Paste a Google Drive link: a public ("Anyone with the link") song or folder, imported with the API key only.
 * The links imported before are listed above the field (Saved links: Import again, Copy link, Rename, Remove).
 * @param {object} app the AppUI (sourcesUI)
 */
export function driveLinkSheet(app) {
  return {
    id: 'drive-link',
    title: 'Google Drive link',
    mount(body, host) {
      const src = app.sourcesUI;
      if (!src.driveLinkReady) {
        body.append(section('', h('p.sheet-note', { text: 'Importing Google Drive links needs the one-time Google ' +
          'setup (an API key). Until then, open Drive through your phone’s file picker: Add music > This device.' }),
        guideLink(GUIDES.drive, 'How to set up Google Drive')));
        return undefined;
      }
      const input = h('input.src-input', {
        type: 'url', inputmode: 'url', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false',
        enterkeyhint: 'go', placeholder: 'https://drive.google.com/…', 'aria-label': 'Google Drive link', id: 'drive-link-input',
      });
      const err = h('p.src-error', { role: 'alert', hidden: true });
      const go = h('button.btn.btn-primary.src-go', { type: 'submit' }, icon('download'), h('span', { text: 'Import' }));
      const kids = [h('label.src-label', { for: 'drive-link-input', text: 'Link to a song or a folder' }), input, err];
      const clip = typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.readText === 'function';
      if (clip) {
        const paste = h('button.btn.btn-ghost.btn-sm.src-paste', { type: 'button' }, icon('link'), h('span', { text: 'Paste' }));
        paste.addEventListener('click', () => {
          Promise.resolve()
            .then(() => navigator.clipboard.readText())
            .then((t) => {
              if (t) input.value = String(t).trim();
            })
            .catch(() => {
              try {
                input.focus();
              } catch {
                /* ignore */
              }
            });
        });
        kids.push(h('div.src-actions', {}, paste, go));
      } else {
        kids.push(h('div.src-actions', {}, go));
      }
      const form = h('form.src-form', { novalidate: true }, kids);
      form.addEventListener('submit', (e) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        const r = src.importDriveLink(input.value);
        if (r && r.error) {
          err.textContent = r.error;
          err.hidden = false;
          return;
        }
        err.hidden = true;
        host.close();
      });
      input.addEventListener('input', () => {
        err.hidden = true;
      });
      // the links imported before (hidden while there are none), above the paste field
      const saved = savedLinksSection(app, host);
      body.append(
        saved.el,
        section('', form),
        section('How to get the link', h('ol.help-list.src-steps', {},
          h('li', { text: 'In Google Drive, open the song or folder’s menu (⋮) > Share.' }),
          h('li', { text: 'Under General access choose “Anyone with the link” (Viewer).' }),
          h('li', { text: 'Tap Copy link, come back here and paste it.' })),
        h('p.sheet-note', { text: 'A folder link imports every song in it (not the folders inside it). Anyone who has ' +
          'the link can open those files, so share only music you are happy to share. Links you import are ' +
          'remembered on this device under Saved links.' })));
      return () => saved.destroy();
    },
  };
}
