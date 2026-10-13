// Small DOM helpers shared by the app UI: an element builder, the inline SVG icon set, cheap text/class
// setters for per-frame updates, and a "control is being held" tracker so state sync never fights a finger.
//   const btn = h('button.tbtn.t-play', { type: 'button', onclick: fn }, icon('play'));
//   setText(el, 'new text');  // only touches the DOM when the text changed
//   if (!isHeld(slot)) fader.set(deck.mix.volume);
// User-provided strings (track titles, tags, device names) always go through textContent, never innerHTML.

const SVG_OPEN = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';

const ICONS = {
  play: '<path d="M8 5.2v13.6L19 12z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>' +
    '<rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="5" height="7" rx="1.6"/>' +
    '<rect x="16" y="14" width="5" height="7" rx="1.6"/>',
  decks: '<circle cx="7.5" cy="12" r="5"/><circle cx="7.5" cy="12" r="1"/><circle cx="16.5" cy="12" r="5"/>' +
    '<circle cx="16.5" cy="12" r="1"/>',
  mix: '<path d="M6 4v16M12 4v16M18 4v16"/><rect x="4" y="13" width="4" height="3" rx="1" fill="currentColor"/>' +
    '<rect x="10" y="7" width="4" height="3" rx="1" fill="currentColor"/>' +
    '<rect x="16" y="11" width="4" height="3" rx="1" fill="currentColor"/>',
  fx: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  songs: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  speaker: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
  outputs: '<rect x="3" y="4" width="8" height="16" rx="2"/><circle cx="7" cy="14" r="2.5"/><path d="M7 7.5h.01"/>' +
    '<path d="M15 9v-1a4 4 0 0 1 6 3.5V14"/><rect x="14" y="13" width="3" height="5" rx="1"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 ' +
    '1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 ' +
    '.3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 ' +
    '1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 ' +
    '2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.6 2.6 0 0 1 5 1c0 1.7-2.5 2.2-2.5 3.8M12 17.3h.01"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  install: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19h14"/>',
  share: '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5v9h14v-9h-1"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  eject: '<path d="M12 5l7 8H5z" fill="currentColor" stroke="none"/><rect x="5" y="16" width="14" height="3" rx="1" fill="currentColor" stroke="none"/>',
  sync: '<path d="M4 12a8 8 0 0 1 13.7-5.6L20 9M20 4v5h-5M20 12a8 8 0 0 1-13.7 5.6L4 15M4 20v-5h5"/>',
  zoomIn: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.4-4.4M8.5 11h5M11 8.5v5"/>',
  zoomOut: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.4-4.4M8.5 11h5"/>',
  wifi: '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.8 16a5 5 0 0 1 6.4 0M12 19.5h.01"/>',
  cable: '<path d="M7 3v5M17 3v5M5 8h4v4a2 2 0 0 1-4 0zM15 8h4v4a2 2 0 0 1-4 0zM7 14v2a5 5 0 0 0 10 0v-2M12 21v-2"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4.5M12 17.5h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6L20 9M20 4v5h-5"/>',
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
  // Auto Mix: an endless loop (one song flows into the next)
  auto: '<path d="M7.6 15.6C5.6 15.6 4 14 4 12s1.6-3.6 3.6-3.6c3.6 0 5.2 7.2 8.8 7.2 2 0 3.6-1.6 3.6-3.6s-1.6-3.6-3.6-3.6c-3.6 0-5.2 7.2-8.8 7.2z"/>',
  grip: '<circle cx="9" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.5" fill="currentColor" stroke="none"/>' +
    '<circle cx="9" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.5" fill="currentColor" stroke="none"/>' +
    '<circle cx="9" cy="18" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.5" fill="currentColor" stroke="none"/>',
  listAdd: '<path d="M4 6h11M4 12h11M4 18h7M18 14v6M15 17h6"/>',
  // Music player
  player: '<circle cx="10.5" cy="13" r="8"/><circle cx="10.5" cy="13" r="2"/><path d="M20.5 2.5v7.5l-3.5 3.2"/>',
  prev: '<path d="M19 19.5L9 12l10-7.5z" fill="currentColor" stroke="none"/><path d="M5.5 19V5"/>',
  next: '<path d="M5 4.5L15 12 5 19.5z" fill="currentColor" stroke="none"/><path d="M18.5 5v14"/>',
  shuffle: '<path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  repeat: '<path d="M17 2l4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3"/>',
  repeatOne: '<path d="M17 2l4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3"/>' +
    '<path d="M10.8 10.6l1.6-1.1v5" stroke-width="1.8"/>',
  more: '<circle cx="5" cy="12" r="1.9" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.9" fill="currentColor" stroke="none"/>' +
    '<circle cx="19" cy="12" r="1.9" fill="currentColor" stroke="none"/>',
  playNext: '<path d="M3 6h12M3 12h7M3 18h12"/><path d="M15 9l6 3-6 3z" fill="currentColor" stroke="none"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5M3.5 3.5v5h5"/><path d="M12 7.5V12l3 2"/>',
  chevronDown: '<path d="M5 9l7 7 7-7"/>',
};

/** Inline SVG markup for an icon name (static, trusted strings only). */
export function iconSvg(name) {
  return SVG_OPEN + (ICONS[name] || ICONS.info) + '</svg>';
}

/** A <span class="ico"> holding an icon. */
export function icon(name, className = '') {
  const el = document.createElement('span');
  el.className = className ? `ico ${className}` : 'ico';
  el.innerHTML = iconSvg(name);
  return el;
}

/**
 * Create an element. `tag` may carry classes: 'button.tbtn.t-play'. Props: text, html (trusted only), class,
 * dataset, style (object), on<event> handlers, boolean attributes (true -> present, false/null -> skipped),
 * anything else as an attribute. Children: nodes, strings, numbers, arrays; null/false are skipped.
 */
export function h(tag, props, ...kids) {
  const parts = String(tag).split('.');
  const el = document.createElement(parts[0] || 'div');
  if (parts.length > 1) el.className = parts.slice(1).join(' ');
  if (props) {
    for (const key of Object.keys(props)) {
      const v = props[key];
      if (v == null || v === false) continue;
      if (key === 'text') el.textContent = String(v);
      else if (key === 'html') el.innerHTML = v;
      else if (key === 'class') el.className = el.className ? `${el.className} ${v}` : v;
      else if (key === 'dataset') Object.assign(el.dataset, v);
      else if (key === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (key.length > 2 && key.startsWith('on') && typeof v === 'function') el.addEventListener(key.slice(2), v);
      else if (key === 'hidden') el.hidden = !!v;
      else el.setAttribute(key, v === true ? '' : String(v));
    }
  }
  appendKids(el, kids);
  return el;
}

function appendKids(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) appendKids(el, k);
    else if (typeof k === 'object' && k.nodeType) el.appendChild(k);
    else el.appendChild(document.createTextNode(String(k)));
  }
}

/** Replace all children of an element. */
export function setKids(el, ...kids) {
  while (el.firstChild) el.removeChild(el.firstChild);
  appendKids(el, kids);
}

/** Set textContent only when it changed (cheap enough for every animation frame). */
export function setText(el, text) {
  const s = String(text);
  if (el && el.__text !== s) {
    el.__text = s;
    el.textContent = s;
  }
}

/** Toggle a class only when the state changed. */
export function setClass(el, cls, on) {
  if (!el) return;
  const key = '__c_' + cls;
  const want = !!on;
  if (el[key] === want) return;
  el[key] = want;
  el.classList.toggle(cls, want);
}

/** Set an attribute only when it changed (null removes it). */
export function setAttr(el, name, value) {
  if (!el) return;
  const key = '__a_' + name;
  const v = value == null || value === false ? null : String(value === true ? '' : value);
  if (el[key] === v) return;
  el[key] = v;
  if (v === null) el.removeAttribute(name);
  else el.setAttribute(name, v);
}

// ---- "held" tracking: which control slots have a finger/mouse on them right now ----------------------------

const held = new Map(); // pointerId -> element
let heldBound = false;

function bindHeld() {
  if (heldBound || typeof document === 'undefined' || !document.addEventListener) return;
  heldBound = true;
  document.addEventListener('pointerdown', (e) => {
    const t = e.target;
    const slot = t && t.closest ? t.closest('[data-hold]') : null;
    if (slot) held.set(e.pointerId, slot);
  }, true);
  const up = (e) => held.delete(e.pointerId);
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', up, true);
  window.addEventListener('blur', () => held.clear());
}

/** Mark an element as a hold-tracked control slot (a widget container). */
export function trackHold(el) {
  bindHeld();
  if (el && el.setAttribute) el.setAttribute('data-hold', '');
  return el;
}

/** True while a pointer that went down inside `el` (a trackHold slot) is still down. */
export function isHeld(el) {
  if (!el || held.size === 0) return false;
  for (const v of held.values()) {
    if (v === el || (el.contains && el.contains(v))) return true;
  }
  return false;
}

/** Recent-input guard: remember when a control last produced input (wheel/keyboard have no pointer). */
export function touchedRecently(obj, ms = 250) {
  const t = obj && obj.__inputAt;
  return !!t && (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t < ms;
}

/** Stamp an object with the time of its last input (pairs with touchedRecently). */
export function stampInput(obj) {
  if (obj) obj.__inputAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Does a keyboard event's target use Space itself (a focused button, switch, link, slider, summary, text
 * field)? Page-wide Space shortcuts stay away from these so a focused control never fires twice.
 */
export function usesSpaceKey(t) {
  if (!t || !t.tagName) return false;
  if (isTypingTarget(t)) return true;
  const tag = t.tagName.toLowerCase();
  if (tag === 'button' || tag === 'a' || tag === 'summary' || tag === 'input' || tag === 'label') return true;
  const role = t.getAttribute ? t.getAttribute('role') : null;
  return !!role && ['button', 'switch', 'radio', 'checkbox', 'slider', 'menuitem', 'tab', 'option'].includes(role);
}

/** Is a keyboard event aimed at a text field (never steal keys there)? */
export function isTypingTarget(t) {
  if (!t || !t.tagName) return false;
  const tag = t.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = (t.getAttribute('type') || 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'file', 'submit', 'reset', 'color'].includes(type);
  }
  return !!t.isContentEditable;
}

/** Visually hidden file input inside a label: tapping the label opens the native picker (works in sandboxes). */
export function fileLabel(className, accept, multiple, ariaLabel, onFiles, ...kids) {
  const input = h('input.file-input', { type: 'file', accept, multiple: !!multiple, tabindex: '-1', 'aria-hidden': 'true' });
  input.addEventListener('change', () => {
    const files = input.files ? Array.from(input.files) : [];
    try {
      input.value = '';
    } catch {
      /* ignore */
    }
    if (files.length) onFiles(files);
  });
  const label = h('label.' + className, { tabindex: '0', role: 'button', 'aria-label': ariaLabel || null }, input, ...kids);
  label.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      try {
        input.click();
      } catch {
        /* ignore */
      }
    }
  });
  return { label, input };
}

/** Run fn, logging (once per key) instead of throwing: keeps the render loop alive if one widget breaks. */
const failed = new Map();
export function guard(key, fn) {
  try {
    return fn();
  } catch (err) {
    const n = (failed.get(key) || 0) + 1;
    failed.set(key, n);
    if (n === 1 || n === 100) console.error(`[TwinSpin] ${key} failed${n > 1 ? ` (${n} times)` : ''}`, err);
    return undefined;
  }
}
