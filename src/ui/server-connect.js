// The music server connect form (docs/SOURCES.md section 4), split out of server-browser.js: address, user name,
// password and "Remember on this device" (off by default), a live hint for http:// addresses, checks before anything
// is sent, and the source's own words when connect() fails. The password goes only to MusicServerSource.connect()
// (which keeps a token, never the password); the form itself remembers the address and user name (localStorage
// only when Remember was on, else sessionStorage). Signing in again (a saved sign-in that stopped working) fills in
// the saved address and user name and offers Back to the server.
//   renderConnect(browser, root, host, live);   const res = await connectServer(browser, { url, username, ... });

import { h, icon, setKids } from './dom.js';
import { section, switchRow } from './sheets/sheet.js';
import { guideLink } from './sheets/add-music-sheet.js';
import { serverLabel, serverUrlHint, errText, GUIDES } from './sources-text.js';

const FORM_KEY = 'twinspin.serverForm';

/**
 * Render the connect form into `root` (the server browser's first page while not connected, or Sign in again).
 * @param {import('./server-browser.js').ServerBrowser} sb
 */
export function renderConnect(sb, root, host, live) {
  const s = sb.server;
  if (!s) {
    setKids(root, section('', h('p.sheet-note', { text: 'Music servers are not available in this version of TwinSpin. ' +
      'Reload the page, or add songs with This device.' })));
    return;
  }
  const mem = readForm();
  if (sb.relogin && sb.connected) {
    // sign in again: the saved address and user name
    try {
      mem.url = (s.server && s.server.url) || mem.url;
      mem.username = (s.client && s.client.auth && s.client.auth.u) || mem.username;
      mem.remember = !!s.remembered;
    } catch {
      /* keep what the form remembered */
    }
  }
  const field = (id, label, attrs) => {
    const input = h('input.src-input', { id, ...attrs });
    return { input, el: h('div.src-field', {}, h('label.src-label', { for: id, text: label }), input) };
  };
  const url = field('sb-url', 'Server address', {
    type: 'url', inputmode: 'url', autocomplete: 'url', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false',
    enterkeyhint: 'next', placeholder: 'https://music.yourname.synology.me', value: mem.url || '',
  });
  const user = field('sb-user', 'User name', {
    type: 'text', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false',
    enterkeyhint: 'next', value: mem.username || '',
  });
  const pass = field('sb-pass', 'Password', { type: 'password', autocomplete: 'current-password', enterkeyhint: 'go' });
  let remember = mem.remember === true;
  const rem = switchRow('Remember on this device', 'Keeps a sign-in key on this device, never your password. ' +
    'Off: you connect again next time.', remember, (on) => {
    remember = on;
  });
  rem.el.classList.add('sb-remember');
  const hint = h('p.src-hint', { hidden: true });
  const showHint = () => {
    const pageHttps = typeof location !== 'undefined' && location.protocol === 'https:';
    const t = serverUrlHint(url.input.value, { pageHttps });
    hint.textContent = t;
    hint.hidden = !t;
  };
  url.input.addEventListener('input', showHint);
  showHint();
  const err = h('p.src-error', { role: 'alert', hidden: true });
  const btnText = h('span', { text: 'Connect' });
  const btn = h('button.btn.btn-primary.sb-connect', { type: 'submit' }, icon('server'), btnText);
  const busy = (on) => {
    btn.disabled = on;
    btnText.textContent = on ? 'Connecting…' : 'Connect';
    if (on) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
  };
  const showErr = (t) => {
    err.textContent = t || '';
    err.hidden = !t;
  };
  let cancel = null;
  if (sb.relogin && sb.connected) {
    cancel = h('button.btn.btn-ghost.btn-sm.sb-cancel', { type: 'button' }, h('span', { text: 'Back to the server' }));
    cancel.addEventListener('click', () => {
      sb.relogin = false;
      host.refresh();
    });
  }
  const form = h('form.src-form.sb-form', { novalidate: true }, url.el, hint, user.el, pass.el, rem.el, err, btn, cancel);
  form.addEventListener('submit', (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (sb.connecting) return;
    const vals = { url: url.input.value.trim(), username: user.input.value.trim(), password: pass.input.value, remember };
    const missing = !vals.url ? 'Type the address of your music server.' : !vals.username ? 'Type your user name.'
      : !vals.password ? 'Type your password.' : '';
    if (missing) {
      showErr(missing);
      return;
    }
    showErr('');
    busy(true);
    connectServer(sb, vals).then((res) => {
      if (res.ok) {
        pass.input.value = '';
        if (live() && (res.refresh || !sb.connected || root.querySelector('.sb-form'))) host.refresh();
        return;
      }
      busy(false);
      if (live()) showErr(res.error);
    });
  });
  setKids(root,
    section('', h('p.sheet-note', { text: 'Play songs from your own music server: Navidrome (for example on a ' +
      'Synology NAS), Gonic, Airsonic or another Subsonic server.' }), form),
    section('', h('p.sheet-note', { text: 'Use the https:// address that works from anywhere, and a user that can ' +
      'only play music. TwinSpin talks only to your server.' }), guideLink(GUIDES.nas, 'How to set up Navidrome on a Synology NAS'),
    h('p.sheet-note.sb-noserver', { text: 'No music server? Add music > This device opens your NAS too, through the ' +
      'Files app or a network drive (see Other ways).' })));
}

/**
 * Connect; resolves { ok, refresh } or { ok: false, error } (never rejects).
 * @param {import('./server-browser.js').ServerBrowser} sb
 */
export async function connectServer(sb, vals) {
  const s = sb.server;
  if (!s || typeof s.connect !== 'function') return { ok: false, error: 'Music servers are not available here.' };
  sb.connecting = true;
  const relogin = sb.relogin && sb.connected;
  sb.reset(); // a (new) server: nothing fetched before belongs to it
  try {
    await s.connect(vals);
  } catch (err) {
    return { ok: false, error: errText(err, "Couldn't connect. Check the address, user name and password.") };
  } finally {
    sb.connecting = false;
  }
  if (!sb.connected) return { ok: false, error: "Couldn't connect. Check the address, user name and password." };
  writeForm({ url: vals.url, username: vals.username, remember: vals.remember });
  sb.relogin = false;
  sb.app.toast(`Connected to ${serverLabel(s.server)}`, { kind: 'ok' });
  // a first connection redraws through the 'state' event; signing in again keeps 'connected': redraw here
  return { ok: true, refresh: relogin };
}

// ---- the connect form remembers the address and user name (never the password) -------------------------------------

function readForm() {
  for (const store of [safeStore('localStorage'), safeStore('sessionStorage')]) {
    try {
      const raw = store && store.getItem(FORM_KEY);
      if (raw) {
        const v = JSON.parse(raw);
        if (v && typeof v === 'object') return { url: String(v.url || ''), username: String(v.username || ''), remember: v.remember === true };
      }
    } catch {
      /* ignore */
    }
  }
  return { url: '', username: '', remember: false };
}

/**
 * After Disconnect nothing about the server stays on this device: the address and user name move to this visit's
 * memory only (sessionStorage), so connecting again in this visit is still quick.
 */
export function forgetForm() {
  const mem = readForm();
  try {
    const local = safeStore('localStorage');
    if (local) local.removeItem(FORM_KEY);
  } catch {
    /* storage blocked */
  }
  if (mem.url || mem.username) writeForm({ url: mem.url, username: mem.username, remember: false });
}

/** Remembered on this device only when "Remember" was on; else for this visit (sessionStorage). */
function writeForm(v) {
  const local = safeStore('localStorage');
  const session = safeStore('sessionStorage');
  const raw = JSON.stringify({ url: v.url, username: v.username, remember: !!v.remember });
  try {
    if (v.remember && local) local.setItem(FORM_KEY, raw);
    else {
      if (local) local.removeItem(FORM_KEY);
      if (session) session.setItem(FORM_KEY, raw);
    }
  } catch {
    /* storage blocked: the form just starts empty next time */
  }
}

function safeStore(name) {
  try {
    return globalThis[name] || null;
  } catch {
    return null;
  }
}
