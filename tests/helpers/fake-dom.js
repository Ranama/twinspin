// A small fake DOM for headless UI tests (JsCheck has no DOM): elements with attributes, classes, dataset,
// style, children, events with capture/bubble, closest/querySelector for simple and descendant selectors, a
// canvas 2D context that accepts every call, and window/document/navigator globals.
//   import { installFakeDom, FakeEvent, Element, FakeDocument } from './helpers/fake-dom.js';
//   installFakeDom();                          // BEFORE importing app modules (env.js reads navigator at load)
//   const { AppUI } = await import('../src/ui/app-ui.js');

const G = globalThis;

function kebab(k) {
  return k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

export class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles !== false;
    this.defaultPrevented = false;
    this.timeStamp = performance.now();
    this._stop = false;
    this._stopNow = false;
    Object.assign(this, init);
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this._stop = true;
  }

  stopImmediatePropagation() {
    this._stop = true;
    this._stopNow = true;
  }
}

export class Target {
  constructor() {
    this._ls = new Map();
  }

  addEventListener(type, fn, opts) {
    if (!fn) return;
    const capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
    const once = !!(opts && typeof opts === 'object' && opts.once);
    if (!this._ls.has(type)) this._ls.set(type, []);
    const list = this._ls.get(type);
    if (list.some((l) => l.fn === fn && l.capture === capture)) return;
    list.push({ fn, capture, once });
  }

  removeEventListener(type, fn, opts) {
    const capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
    const list = this._ls.get(type);
    if (!list) return;
    const i = list.findIndex((l) => l.fn === fn && l.capture === capture);
    if (i >= 0) list.splice(i, 1);
  }

  _invoke(ev, phase) {
    const list = this._ls.get(ev.type);
    if (!list) return;
    for (const l of [...list]) {
      if (phase === 'capture' && !l.capture) continue;
      if (phase === 'bubble' && l.capture) continue;
      if (l.once) this.removeEventListener(ev.type, l.fn, l.capture);
      ev.currentTarget = this;
      l.fn.call(this, ev);
      if (ev._stopNow) return;
    }
  }

  dispatchEvent(ev) {
    ev.target = ev.target || this;
    const path = [];
    for (let n = this; n; n = n.parentNode || (n === G.document ? G.window : null)) {
      path.push(n);
      if (n === G.window) break;
    }
    for (let i = path.length - 1; i >= 1; i--) {
      path[i]._invoke(ev, 'capture');
      if (ev._stop) return !ev.defaultPrevented;
    }
    this._invoke(ev, 'target');
    if (ev.bubbles) {
      for (let i = 1; i < path.length; i++) {
        if (ev._stop) break;
        path[i]._invoke(ev, 'bubble');
      }
    }
    return !ev.defaultPrevented;
  }
}

export class TextNode {
  constructor(text) {
    this.nodeType = 3;
    this.textContent = String(text);
    this.parentNode = null;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
}

function matchSimple(el, sel) {
  const m = /^([a-zA-Z0-9-]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/.exec(sel.trim());
  if (!m || el.nodeType !== 1) return false;
  const [, tag, classes, attrs] = m;
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  for (const c of classes.split('.').filter(Boolean)) if (!el.classList.contains(c)) return false;
  for (const a of attrs.match(/\[[^\]]+\]/g) || []) {
    const am = /^\[([\w-]+)(?:=['"]?([^'"\]]*)['"]?)?\]$/.exec(a);
    if (!am) return false;
    const v = el.getAttribute(am[1]);
    if (v === null) return false;
    if (am[2] !== undefined && v !== am[2]) return false;
  }
  return true;
}

/** Simple selectors with descendant combinators ('.deck-a .t-play'), comma lists. */
function matchComplex(el, sel) {
  const parts = sel.trim().split(/\s+/);
  if (!matchSimple(el, parts[parts.length - 1])) return false;
  let i = parts.length - 2;
  for (let x = el.parentNode; i >= 0 && x && x.nodeType === 1; x = x.parentNode) {
    if (matchSimple(x, parts[i])) i--;
  }
  return i < 0;
}

const matches = (el, selector) => selector.split(',').some((s) => matchComplex(el, s));

export class Element extends Target {
  constructor(tag) {
    super();
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.nodeName = this.tagName;
    this.childNodes = [];
    this.parentNode = null;
    this._attrs = new Map();
    this._classes = [];
    this.hidden = false;
    this.disabled = false;
    this.inert = false;
    this.scrollTop = 0;
    this.style = {
      setProperty(k, v) {
        this[k] = String(v);
      },
      removeProperty(k) {
        delete this[k];
      },
      getPropertyValue(k) {
        return this[k] || '';
      },
    };
    const self = this;
    this.classList = {
      add(...cs) {
        for (const c of cs) if (c && !self._classes.includes(c)) self._classes.push(c);
      },
      remove(...cs) {
        self._classes = self._classes.filter((c) => !cs.includes(c));
      },
      toggle(c, force) {
        const on = force === undefined ? !self._classes.includes(c) : !!force;
        if (on) this.add(c);
        else this.remove(c);
        return on;
      },
      contains(c) {
        return self._classes.includes(c);
      },
    };
    this.dataset = new Proxy({}, {
      get: (t, k) => (typeof k === 'string' ? (self.getAttribute(`data-${kebab(k)}`) ?? undefined) : undefined),
      set: (t, k, v) => {
        self.setAttribute(`data-${kebab(String(k))}`, String(v));
        return true;
      },
      deleteProperty: (t, k) => {
        self.removeAttribute(`data-${kebab(String(k))}`);
        return true;
      },
      ownKeys: () => [],
    });
    if (this.tagName === 'CANVAS') {
      this.width = 300;
      this.height = 150;
    }
    if (this.tagName === 'INPUT') {
      this.value = '';
      this.files = null;
    }
  }

  get className() {
    return this._classes.join(' ');
  }

  set className(v) {
    this._classes = String(v || '').split(/\s+/).filter(Boolean);
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  set id(v) {
    this.setAttribute('id', v);
  }

  setAttribute(k, v) {
    if (k === 'class') this.className = v;
    else this._attrs.set(k, String(v));
  }

  getAttribute(k) {
    if (k === 'class') return this.className;
    return this._attrs.has(k) ? this._attrs.get(k) : null;
  }

  hasAttribute(k) {
    return this.getAttribute(k) !== null;
  }

  removeAttribute(k) {
    this._attrs.delete(k);
  }

  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  _adopt(n) {
    const node = typeof n === 'object' && n !== null ? n : new TextNode(n);
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    return node;
  }

  appendChild(n) {
    const node = this._adopt(n);
    this.childNodes.push(node);
    return node;
  }

  append(...ns) {
    for (const n of ns) this.appendChild(n);
  }

  prepend(...ns) {
    const nodes = ns.map((n) => this._adopt(n));
    this.childNodes.unshift(...nodes);
  }

  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    const node = this._adopt(n);
    const i = this.childNodes.indexOf(ref);
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, node);
    return node;
  }

  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }

  replaceChildren(...ns) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    this.append(...ns);
  }

  replaceWith(n) {
    const p = this.parentNode;
    if (!p) return;
    p.insertBefore(n, this);
    p.removeChild(this);
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  before(n) {
    if (this.parentNode) this.parentNode.insertBefore(n, this);
  }

  after(n) {
    const p = this.parentNode;
    if (!p) return;
    const i = p.childNodes.indexOf(this);
    p.insertBefore(n, p.childNodes[i + 1] || null);
  }

  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }

  set textContent(v) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    if (v !== '' && v != null) this.appendChild(new TextNode(v));
  }

  get innerHTML() {
    return this._html || '';
  }

  set innerHTML(v) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    this._html = String(v);
  }

  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }

  closest(sel) {
    for (let x = this; x && x.nodeType === 1; x = x.parentNode) if (matches(x, sel)) return x;
    return null;
  }

  matches(sel) {
    return matches(this, sel);
  }

  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (matches(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }

  get isConnected() {
    for (let x = this; x; x = x.parentNode) if (x === G.document) return true;
    return false;
  }

  get ownerDocument() {
    return G.document;
  }

  _shown() {
    for (let x = this; x && x.nodeType === 1; x = x.parentNode) if (x.hidden) return false;
    return this.isConnected;
  }

  getBoundingClientRect() {
    const w = this.tagName === 'CANVAS' ? 200 : 120;
    const hh = this.tagName === 'CANVAS' ? 100 : 48;
    return { left: 10, top: 10, right: 10 + w, bottom: 10 + hh, width: w, height: hh, x: 10, y: 10 };
  }

  getClientRects() {
    return this._shown() ? [this.getBoundingClientRect()] : [];
  }

  get clientWidth() {
    return this._shown() ? this.getBoundingClientRect().width : 0;
  }

  get clientHeight() {
    return this._shown() ? this.getBoundingClientRect().height : 0;
  }

  get offsetWidth() {
    return this.clientWidth;
  }

  get offsetHeight() {
    return this.clientHeight;
  }

  get isContentEditable() {
    return false;
  }

  focus() {
    G.document.activeElement = this;
  }

  blur() {
    if (G.document.activeElement === this) G.document.activeElement = G.document.body;
  }

  click() {
    if (this.disabled) return;
    this.dispatchEvent(new FakeEvent('click', { button: 0, pointerType: 'mouse' }));
  }

  setPointerCapture(id) {
    this._cap = id;
  }

  releasePointerCapture() {
    this._cap = null;
  }

  hasPointerCapture(id) {
    return this._cap === id;
  }

  scrollIntoView() {}

  getContext() {
    return makeCtx(this);
  }

  animate() {
    return { cancel() {}, finished: Promise.resolve(), onfinish: null };
  }
}

function makeCtx(canvas) {
  const store = {
    canvas,
    measureText: (t) => ({ width: String(t || '').length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    createImageData: (w, hh) => ({ width: w, height: hh, data: new Uint8ClampedArray(Math.max(1, w * hh * 4)) }),
    getImageData: (x, y, w, hh) => ({ width: w, height: hh, data: new Uint8ClampedArray(Math.max(1, w * hh * 4)) }),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    isPointInPath: () => false,
    getLineDash: () => [],
  };
  let u;
  const fn = function () {};
  u = new Proxy(fn, {
    get(t, p) {
      if (p in store) return store[p];
      if (p === Symbol.toPrimitive) return () => 0;
      if (p === 'then' || p === Symbol.iterator) return undefined;
      return u;
    },
    set(t, p, v) {
      store[p] = v;
      return true;
    },
    apply() {
      return u;
    },
  });
  return u;
}

export class FakeDocument extends Target {
  constructor() {
    super();
    this.nodeType = 9;
    this.parentNode = null;
    this.documentElement = new Element('html');
    this.documentElement.parentNode = this;
    this.head = new Element('head');
    this.body = new Element('body');
    this.documentElement.append(this.head, this.body);
    this.activeElement = this.body;
    this.hidden = false;
    this.visibilityState = 'visible';
    this.readyState = 'complete';
    this.fullscreenEnabled = false;
    this.fullscreenElement = null;
  }

  createElement(tag) {
    return new Element(tag);
  }

  createElementNS(ns, tag) {
    return new Element(tag);
  }

  createTextNode(t) {
    return new TextNode(t);
  }

  getElementById(id) {
    return this.documentElement.querySelectorAll(`[id=${id}]`)[0] || null;
  }

  querySelector(sel) {
    return this.documentElement.querySelector(sel);
  }

  querySelectorAll(sel) {
    return this.documentElement.querySelectorAll(sel);
  }

  createRange() {
    return { selectNodeContents() {} };
  }
}

/**
 * Install the fake window (= globalThis), document, navigator (Android Chrome phone), location, matchMedia,
 * getComputedStyle, requestAnimationFrame (16 ms timers), ResizeObserver (fires once), MutationObserver, ImageData.
 */
export function installFakeDom({ width = 360, height = 560 } = {}) {
  // window = globalThis
  const winTarget = new Target();
  G.window = G;
  G.addEventListener = (t, f, o) => winTarget.addEventListener(t, f, o);
  G.removeEventListener = (t, f, o) => winTarget.removeEventListener(t, f, o);
  G.dispatchEvent = (ev) => {
    ev.target = ev.target || G;
    winTarget._invoke(ev, 'target');
    return !ev.defaultPrevented;
  };
  G._invoke = (ev, phase) => winTarget._invoke(ev, phase);
  G.document = new FakeDocument();
  G.innerWidth = width;
  G.innerHeight = height;
  G.devicePixelRatio = 2;
  G.navigator = {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
    maxTouchPoints: 5,
    vibrate: () => true,
    language: 'en',
  };
  G.location = { search: '', hash: '', hostname: 'localhost', href: 'https://localhost/', origin: 'https://localhost', pathname: '/' };
  G.isSecureContext = true;
  G.TWINSPIN_CONFIG = {};
  G.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  G.getComputedStyle = () => ({
    paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px', getPropertyValue: () => '',
  });
  G.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
  G.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 16);
  G.cancelAnimationFrame = (id) => clearTimeout(id);
  G.ResizeObserver = class {
    constructor(cb) {
      this.cb = cb;
    }

    observe(el) {
      setTimeout(() => this.cb([{ target: el, contentRect: el.getBoundingClientRect() }], this), 0);
    }

    unobserve() {}

    disconnect() {}
  };
  G.MutationObserver = class {
    observe() {}

    disconnect() {}
  };
  G.ImageData = class {
    constructor(w, hh) {
      this.width = w;
      this.height = hh;
      this.data = new Uint8ClampedArray(w * hh * 4);
    }
  };
  if (!G.crypto) {
    G.crypto = {
      getRandomValues(a) {
        for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0;
        return a;
      },
    };
  }
}
