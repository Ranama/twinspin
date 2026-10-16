// Songs from Suno (Add music > Songs from Suno). Suno has no public API and TwinSpin never talks to Suno itself:
// people download their own songs from Suno, then add the files like any other song. Three parts:
//  * One song at a time (phone or computer): Suno's own ⋯ > Download > MP3 (WAV on paid plans), then This device.
//  * A whole playlist at once (computer): a helper script that runs in the browser console on suno.com and
//    downloads every song the signed-in account made in a playlist (extras/suno-playlist-downloader.js, shipped as
//    is: a panel with Start / Pause / Stop, progress, a minimised pill, saving into a folder in Chrome and Edge, and
//    resume). Copy script (the clipboard inside the tap; else the code selected in the read-only box), Download
//    script (.js) (a plain same-origin link) and Show the script (the whole code). The text is fetched only when this
//    sheet opens; when it cannot load, a plain error links the file on GitHub. A calm note says the helper is not
//    made by Suno and can stop working, that a blocked direct file means Suno's own Download (it counts toward the
//    plan's downloads; the panel shows how many are left), that Suno's terms do not allow bots or scraping (Suno could
//    act on the account), that paid gigs need songs from Suno's own Download on a paid plan, and to paste only code
//    you trust.
//  * Get them into TwinSpin: This device on the computer, or a shared Google Drive folder for the phone (Paste a
//    Google Drive link, remembered under Saved links).
// The Drive link sheet comes in as an option (add-music-sheet.js opens this sheet, so no import cycle).
//   host.push(sunoSheet(app, { driveLinkSheet }));

import { h, icon, fileLabel, setKids } from '../dom.js';
import { section } from './sheet.js';
import { ACCEPT } from '../../audio/decode.js';
import { GUIDES } from '../sources-text.js';

/** The helper script's file name; it is served next to the app as extras/<name>. */
export const SUNO_SCRIPT_NAME = 'suno-playlist-downloader.js';

/**
 * The helper script's address on this site (this module is src/ui/sheets/, the script extras/), so it works under
 * any base: https://ranama.github.io/twinspin/extras/... on GitHub Pages, http://localhost:8100/extras/... locally.
 * @param {string} [base] this module's address (a test passes another one)
 */
export function sunoScriptUrl(base = import.meta.url) {
  try {
    return new URL(`../../../extras/${SUNO_SCRIPT_NAME}`, base).href;
  } catch {
    return `extras/${SUNO_SCRIPT_NAME}`;
  }
}

/** The helper script's text (rejects when it cannot be read: offline, not published, empty). */
async function loadScript() {
  const res = await fetch(sunoScriptUrl());
  if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 0}`);
  const text = await res.text();
  if (!text || !String(text).trim()) throw new Error('The script is empty');
  return String(text);
}

/** Select the whole text of a field (the copy fallback). */
function selectAll(field) {
  try {
    field.focus();
    if (typeof field.select === 'function') field.select();
    if (typeof field.setSelectionRange === 'function') field.setSelectionRange(0, String(field.value || '').length);
  } catch {
    /* the user can still select it by hand */
  }
}

const key = (k) => h('kbd', { text: k });
const code = (t) => h('code', { text: t });
/** Numbered steps; each step is a string or an array of text and elements. */
const steps = (...items) => h('ol.help-list.src-steps.suno-steps', {}, items.map((it) => h('li', {}, it)));

/**
 * @param {object} app the AppUI (sourcesUI, addFiles(), toast())
 * @param {{ driveLinkSheet?: (app: object) => object }} [opts] the Google Drive link sheet, for its shortcut button
 */
export function sunoSheet(app, { driveLinkSheet = null } = {}) {
  return {
    id: 'suno',
    title: 'Songs from Suno',
    mount(body, host) {
      const src = app.sourcesUI;
      let live = true;
      let script = '';

      // ---- one song at a time: Suno's own Download
      const one = section('One song at a time (phone or computer)',
        steps(
          'Open your song on suno.com or in the Suno app.',
          'Tap the song’s ⋯ menu > Download > MP3 (WAV on paid plans).',
          'In TwinSpin, open Add music > This device and pick the song.'),
        h('p.sheet-note', { text: 'Each song you download counts once toward your Suno plan’s download limit, and ' +
          'songs made on the free plan are for non-commercial use only. Check your plan on Suno.' }));

      // ---- a whole playlist at once: the helper script in the browser console on suno.com
      const status = h('p.sheet-note.suno-status', { role: 'status', 'aria-live': 'polite', text: 'Getting the script…' });
      const err = h('div.src-error.suno-error', { role: 'alert', hidden: true });
      const copyBtn = h('button.btn.btn-primary.suno-copy', { type: 'button' }, icon('copy'), h('span', { text: 'Copy script' }));
      copyBtn.disabled = true; // until the text is here
      const download = h('a.btn.suno-download', { href: sunoScriptUrl(), download: SUNO_SCRIPT_NAME },
        icon('download'), h('span', { text: 'Download script (.js)' }));
      const box = h('textarea.suno-code', { readonly: true, rows: '12', wrap: 'off', spellcheck: 'false',
        autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', 'aria-label': 'The playlist helper script' });
      const show = h('details.add-other.suno-show', { hidden: true },
        h('summary', {}, icon('info', 'inline-ico'), h('span', { text: 'Show the script' }), icon('chevronDown', 'add-other-chev')),
        box);

      const fallback = () => {
        show.open = true;
        status.textContent = 'Your browser did not let TwinSpin copy. The script is selected below: press Ctrl+C ' +
          '(Cmd+C on a Mac) to copy it.';
        selectAll(box);
      };
      copyBtn.addEventListener('click', () => {
        if (!script) return;
        const clip = typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function'
          ? navigator.clipboard : null;
        if (!clip) {
          fallback();
          return;
        }
        let p;
        try {
          p = clip.writeText(script); // still inside the tap: browsers want that
        } catch (e) {
          p = Promise.reject(e);
        }
        Promise.resolve(p).then(() => {
          if (!live) return;
          status.textContent = 'Copied. Paste it into the console on suno.com and press Enter.';
          app.toast('Script copied', { kind: 'ok' });
        }, () => {
          if (live) fallback();
        });
      });

      const caution = h('div.suno-note', { role: 'note' }, icon('info', 'suno-note-ico'),
        h('div.suno-note-main', {},
          h('p', { text: 'This helper is not made by Suno. It reads your playlist the way suno.com does and saves the ' +
            'songs you made to your computer. Suno can change their site at any time, and then the helper stops ' +
            'working. If it saves nothing, use Suno’s own Download.' }),
          h('p', { text: 'If Suno blocks the direct file, the helper uses Suno’s own Download, which counts toward your ' +
            'plan’s downloads. The panel shows how many you have left.' }),
          h('p', { text: 'Suno’s terms do not allow bots, scraping or downloading in ways Suno did not make for that. ' +
            'Using this helper can break those terms, and Suno could act against your account. Use it at your own ' +
            'risk. For paid gigs, use songs from Suno’s own Download on a paid plan.' }),
          h('p', { text: 'Only paste code you trust into a browser console. This script only talks to Suno (suno.com ' +
            'and Suno’s own file servers); you can read all of it below.' })));

      const playlist = section('A whole playlist at once (computer)',
        h('p.sheet-note', {}, 'A small helper script that runs in your browser on suno.com and downloads every song ',
          h('strong', { text: 'you made' }), ' in a playlist. Songs by other people are skipped.'),
        h('p.sheet-note.suno-phone', { text: 'Phones have no console: use the Suno app’s Download, or do the playlist ' +
          'on a computer and send it to Google Drive.' }),
        caution,
        steps(
          'On a computer, open suno.com in Chrome, Edge or Firefox and sign in.',
          ['Open the playlist. Its address contains ', code('/playlist/'), '.'],
          ['Open the browser console. Windows or Linux: ', key('Ctrl+Shift+J'), ' in Chrome or Edge, ',
            key('Ctrl+Shift+K'), ' in Firefox. Mac: ', key('Cmd+Option+J'), ' in Chrome or Edge, ',
            key('Cmd+Option+K'), ' in Firefox.'],
          'Come back here and click Copy script below. Paste it into the console on suno.com and press Enter.',
          ['The first time, the browser may ask you to type ', code('allow pasting'), '. Do what it says, then paste ' +
            'again and press Enter.'],
          'A panel appears on suno.com. Keep MP3 ticked (MP3 is enough for TwinSpin). In Chrome or Edge choose ' +
            'Save to: A folder I pick. Click Start, then pick a folder and allow it when the browser asks.',
          'If you save to the Downloads folder (the only choice in Firefox), allow multiple downloads when the browser ' +
            'asks. The songs land in your Downloads folder.'),
        h('p.sheet-note.suno-tip', { text: 'You can Pause, minimise the panel to a small progress pill, or close it and ' +
          'paste the script again later: it skips the songs it already saved.' }),
        h('div.suno-actions', {}, copyBtn, download),
        status, err, show);

      // ---- get them into TwinSpin: this computer, or a Google Drive folder for the phone
      const files = fileLabel('btn.suno-files', ACCEPT, true, 'Add the downloaded songs from this device', (list) => {
        host.close();
        app.addFiles(list);
      }, icon('songs'), h('span', { text: 'Choose the songs' })).label;
      let toDrive = null;
      if (typeof driveLinkSheet === 'function') {
        toDrive = h('button.btn.suno-drive', { type: 'button' }, icon('link'), h('span', { text: 'Paste a Google Drive link' }));
        toDrive.addEventListener('click', () => host.push(driveLinkSheet(app)));
      }
      const linkReady = !!(src && src.driveLinkReady);
      const into = section('Get them into TwinSpin',
        h('h4.add-way-h', { text: 'On this computer' }),
        h('p.sheet-note', { text: 'Add music > This device, then select all the songs you downloaded (Ctrl+A, or ' +
          'Cmd+A on a Mac, selects every file in the folder).' }),
        h('div.suno-actions', {}, files),
        h('h4.add-way-h', { text: 'On your phone, through Google Drive' }),
        steps(
          'Put the songs in one folder on the computer.',
          'On drive.google.com click New > Folder upload and choose that folder. (With Google Drive for desktop, ' +
            'you can also just move the folder into your Google Drive.)',
          'Open the folder’s menu (⋮) > Share. Under General access choose “Anyone with the link”, then Copy link.',
          'Get the link to your phone: send it to yourself, or copy it in the Google Drive app (the folder’s ⋮ > ' +
            'Copy link).',
          'On your phone, open TwinSpin > Add music > Paste a Google Drive link and paste it.'),
        h('p.sheet-note', { text: 'TwinSpin remembers the link under Saved links, so songs you add to that folder later ' +
          'come in with one tap (Import again). Anyone who has the link can open the songs.' }),
        linkReady ? null : h('p.sheet-note.warn', { text: 'Drive links need the one-time Google setup on this copy of ' +
          'TwinSpin. Until then, on your phone use Add music > This device and pick the songs from Drive in the picker.' }),
        toDrive ? h('div.suno-actions', {}, toDrive) : null);

      body.append(
        section('', h('p.sheet-note.suno-lead', { text: 'Suno has no way for other apps to reach your songs. So you ' +
          'download them from Suno first, then add them to TwinSpin like any other song.' })),
        one, playlist, into);

      // the script text loads now, only while this sheet is open
      loadScript().then((text) => {
        if (!live) return;
        script = text;
        box.value = text;
        show.hidden = false;
        copyBtn.disabled = false;
        status.textContent = '';
      }, () => {
        if (!live) return;
        status.textContent = '';
        setKids(err,
          h('span', { text: 'The script could not be loaded. Check your connection and open this page again, or get ' +
            'it from GitHub: ' }),
          h('a.src-link', { href: GUIDES.sunoScript, target: '_blank', rel: 'noopener' },
            h('span', { text: SUNO_SCRIPT_NAME }), icon('external', 'inline-ico')));
        err.hidden = false;
      });
      return () => {
        live = false;
      };
    },
  };
}
