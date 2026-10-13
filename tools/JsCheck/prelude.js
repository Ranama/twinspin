// JsCheck runtime prelude. Evaluated as a classic script before the test module is imported.
// It receives the C# host bridge and returns the API object the runner uses (inspect, formatError,
// test runner, stats). Everything a test can see is installed on globalThis here or by Runner.cs.
(function (host) {
  'use strict';

  const G = globalThis;
  const PRELUDE = 'jscheck:prelude';
  const objToString = Object.prototype.toString;
  const reported = new WeakSet();
  const state = { assertions: 0, failures: 0, tests: [], passed: 0, failed: 0, skipped: 0, current: null, testsStarted: false };

  // ------------------------------------------------------------------------------------------------
  // Engine workaround: Jint 4.x returns holes from Array.prototype.slice on a sealed or frozen array when
  // start > 0 (Object.freeze([0..9]).slice(3) -> [3,4,5,6,null,null,null]). Browsers never do that, so a test
  // could fail (or pass) for the wrong reason. Only when the engine shows the bug, non-extensible arrays are
  // sliced by a spec-following copy; everything else keeps the native slice.
  // ------------------------------------------------------------------------------------------------
  (function fixFrozenSlice() {
    let buggy = false;
    try {
      const probe = Object.freeze([0, 1, 2, 3]).slice(1);
      buggy = probe.length !== 3 || probe[0] !== 1 || probe[1] !== 2 || probe[2] !== 3;
    } catch (_) {
      buggy = true;
    }
    if (!buggy) return;
    const nativeSlice = Array.prototype.slice;
    const isExtensible = Object.isExtensible;
    const rel = (v, len, dflt) => {
      if (v === undefined) return dflt;
      let n = Math.trunc(Number(v));
      if (Number.isNaN(n)) n = 0;
      if (n === -Infinity) return 0;
      if (n < 0) return Math.max(len + n, 0);
      return Math.min(n, len);
    };
    Object.defineProperty(Array.prototype, 'slice', {
      configurable: true, enumerable: false, writable: true,
      value: function slice(start, end) {
        if (!Array.isArray(this) || isExtensible(this)) return nativeSlice.call(this, start, end);
        const len = this.length >>> 0;
        const from = rel(start, len, 0), to = rel(end, len, len);
        const out = new Array(Math.max(to - from, 0));
        for (let i = from, j = 0; i < to; i++, j++) if (i in this) out[j] = this[i];
        return out;
      },
    });
  })();

  // ------------------------------------------------------------------------------------------------
  // inspect: a small util.inspect look-alike used by console.* and by assertion messages
  // ------------------------------------------------------------------------------------------------
  const IDENT = /^[A-Za-z_$][\w$]*$/;
  const LINE_WIDTH = 72;

  function quote(s) {
    return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + "'";
  }

  function formatKey(k) {
    if (typeof k === 'symbol') return '[' + k.toString() + ']';
    return IDENT.test(k) ? k : quote(k);
  }

  function ctorName(v) {
    try {
      const proto = Object.getPrototypeOf(v);
      if (proto === null) return '[Object: null prototype]';
      const c = proto.constructor;
      return typeof c === 'function' && typeof c.name === 'string' ? c.name : '';
    } catch (_) {
      return '';
    }
  }

  function isError(v) {
    return v instanceof Error || objToString.call(v) === '[object Error]';
  }

  function wrap(open, close, entries, indent, prefix) {
    const head = prefix ? prefix + ' ' : '';
    if (entries.length === 0) return head + open + close;
    const oneLine = head + open + ' ' + entries.join(', ') + ' ' + close;
    if (oneLine.length <= LINE_WIDTH && !oneLine.includes('\n')) return oneLine;
    const pad = '  '.repeat(indent + 1);
    return head + open + '\n' + entries.map(e => pad + e.replace(/\n/g, '\n' + pad)).join(',\n') + '\n' + '  '.repeat(indent) + close;
  }

  function fmt(v, level, maxDepth, seen) {
    switch (typeof v) {
      case 'string': return level === 0 ? v : quote(v);
      case 'number': return Object.is(v, -0) ? '-0' : String(v);
      case 'bigint': return String(v) + 'n';
      case 'boolean':
      case 'undefined': return String(v);
      case 'symbol': return v.toString();
      case 'function': {
        const name = v.name ? ': ' + v.name : ' (anonymous)';
        const keys = Object.keys(v);
        const base = '[Function' + name + ']';
        if (keys.length === 0 || level > maxDepth) return base;
        return fmtObjectBody(v, keys, level, maxDepth, seen, base);
      }
    }
    if (v === null) return 'null';
    if (seen.includes(v)) return '[Circular]';
    if (isError(v)) {
      const s = level === 0 ? formatError(v) : '[' + errorHeader(v) + ']';
      return s;
    }
    if (v instanceof Date) return isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (typeof Promise === 'function' && v instanceof Promise) return 'Promise { <state unknown> }';
    if (typeof WeakMap === 'function' && v instanceof WeakMap) return 'WeakMap { <items unknown> }';
    if (typeof WeakSet === 'function' && v instanceof WeakSet) return 'WeakSet { <items unknown> }';
    if (v instanceof Number || v instanceof String || v instanceof Boolean) return '[' + ctorName(v) + ': ' + fmt(v.valueOf(), 1, maxDepth, seen) + ']';

    const name = ctorName(v);
    if (level > maxDepth) {
      if (Array.isArray(v)) return '[Array]';
      return '[' + (name && name !== 'Object' ? name : 'Object') + ']';
    }

    seen.push(v);
    try {
      if (Array.isArray(v)) {
        const out = [];
        const n = Math.min(v.length, 100);
        let holes = 0;
        for (let i = 0; i < n; i++) {
          if (!(i in v)) { holes++; continue; }
          if (holes) { out.push('<' + holes + ' empty item' + (holes > 1 ? 's' : '') + '>'); holes = 0; }
          out.push(fmt(v[i], level + 1, maxDepth, seen));
        }
        if (holes) out.push('<' + holes + ' empty item' + (holes > 1 ? 's' : '') + '>');
        if (v.length > n) out.push('... ' + (v.length - n) + ' more item' + (v.length - n > 1 ? 's' : ''));
        for (const k of Object.keys(v)) {
          if (!/^\d+$/.test(k)) out.push(formatKey(k) + ': ' + fmt(v[k], level + 1, maxDepth, seen));
        }
        return wrap('[', ']', out, level, name !== 'Array' ? name + '(' + v.length + ')' : '');
      }
      if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
        const out = [];
        const n = Math.min(v.length, 100);
        for (let i = 0; i < n; i++) out.push(fmt(v[i], level + 1, maxDepth, seen));
        if (v.length > n) out.push('... ' + (v.length - n) + ' more items');
        return wrap('[', ']', out, level, name + '(' + v.length + ')');
      }
      if (v instanceof ArrayBuffer) return 'ArrayBuffer { byteLength: ' + v.byteLength + ' }';
      if (v instanceof DataView) return 'DataView { byteLength: ' + v.byteLength + ', byteOffset: ' + v.byteOffset + ' }';
      if (v instanceof Map) {
        const out = [];
        for (const [k, val] of v) out.push(fmt(k, level + 1, maxDepth, seen) + ' => ' + fmt(val, level + 1, maxDepth, seen));
        return wrap('{', '}', out, level, name + '(' + v.size + ')');
      }
      if (v instanceof Set) {
        const out = [];
        for (const val of v) out.push(fmt(val, level + 1, maxDepth, seen));
        return wrap('{', '}', out, level, name + '(' + v.size + ')');
      }
      const keys = Object.keys(v);
      for (const s of Object.getOwnPropertySymbols(v)) {
        if (Object.prototype.propertyIsEnumerable.call(v, s)) keys.push(s);
      }
      return fmtObjectBody(v, keys, level, maxDepth, seen, name && name !== 'Object' ? name : '');
    } finally {
      seen.pop();
    }
  }

  function fmtObjectBody(v, keys, level, maxDepth, seen, prefix) {
    const out = [];
    for (const k of keys) {
      const d = Object.getOwnPropertyDescriptor(v, k);
      let s;
      if (d && (d.get || d.set)) s = d.get && d.set ? '[Getter/Setter]' : d.get ? '[Getter]' : '[Setter]';
      else s = fmt(d ? d.value : v[k], level + 1, maxDepth, seen);
      out.push(formatKey(k) + ': ' + s);
    }
    return wrap('{', '}', out, level, prefix);
  }

  function inspect(v, options) {
    const depth = options && typeof options.depth === 'number' ? options.depth : 2;
    return fmt(v, 1, depth + 1, []);
  }

  function inspectTop(v) {
    return fmt(v, 0, 3, []);
  }

  // ------------------------------------------------------------------------------------------------
  // errors
  // ------------------------------------------------------------------------------------------------
  function errorHeader(e) {
    let name, message;
    try { name = e.name; } catch (_) { name = 'Error'; }
    try { message = e.message; } catch (_) { message = ''; }
    name = name === undefined ? 'Error' : String(name);
    message = message === undefined ? '' : String(message);
    return message ? name + ': ' + message : name;
  }

  const MAX_FRAMES = 30;

  // Drops JsCheck's own frames, folds runs of identical frames (deep recursion) and caps the length.
  function cleanStack(stack) {
    const lines = stack.split('\n').filter(l => !l.includes(PRELUDE));
    const out = [];
    let frames = 0;
    for (let i = 0; i < lines.length; i++) {
      let j = i;
      while (j + 1 < lines.length && lines[j + 1] === lines[i]) j++;
      const isFrame = /^\s*at /.test(lines[i]);
      if (isFrame && ++frames > MAX_FRAMES) {
        const rest = lines.slice(i).filter(l => /^\s*at /.test(l)).length;
        out.push('    ... ' + rest + ' more frame' + (rest === 1 ? '' : 's'));
        break;
      }
      out.push(j > i ? lines[i] + ' (repeated ' + (j - i + 1) + ' times)' : lines[i]);
      i = j;
    }
    // Test bodies are anonymous functions that Jint labels after the prelude code calling them.
    return host.prettify(out.join('\n')).replace(/^(\s*at )(?:runAllTests|testBody) \(/gm, '$1<test> (');
  }

  function formatError(e) {
    if (!isError(e)) {
      return fmt(e, 1, 3, []) + ' (a non-Error value was thrown, so there is no stack trace)';
    }
    const header = errorHeader(e);
    let stack = '';
    try { stack = typeof e.stack === 'string' ? e.stack : ''; } catch (_) { /* ignore */ }
    let text;
    stack = stack ? cleanStack(stack).replace(/\s+$/, '').replace(/^\s*\n/, '') : '';
    if (!stack.trim()) {
      text = header;
    } else {
      // Jint's stack holds only "   at ..." frames; V8's starts with the header. Accept both.
      text = stack.startsWith(header) ? stack : header + '\n' + stack;
    }
    if (e.details !== undefined) text += '\n' + String(e.details).replace(/^/gm, '    ');
    if (typeof AggregateError === 'function' && e instanceof AggregateError && Array.isArray(e.errors)) {
      e.errors.forEach((inner, i) => {
        text += '\n  [errors][' + i + ']: ' + formatError(inner).replace(/\n/g, '\n  ');
      });
    }
    if (e.cause !== undefined) text += '\n  [cause]: ' + (isError(e.cause) ? formatError(e.cause) : fmt(e.cause, 1, 3, [])).replace(/\n/g, '\n  ');
    return text;
  }

  // ------------------------------------------------------------------------------------------------
  // console
  // ------------------------------------------------------------------------------------------------
  let groupIndent = '';
  const counters = new Map();
  const timers = new Map();

  function formatArgs(args) {
    if (args.length === 0) return '';
    let first = args[0];
    let rest = 1;
    let out;
    if (typeof first === 'string' && first.includes('%')) {
      out = '';
      let i = 0;
      while (i < first.length) {
        const c = first[i];
        if (c === '%' && i + 1 < first.length) {
          const f = first[i + 1];
          if (f === '%') { out += '%'; i += 2; continue; }
          if ('sdifoOjc'.includes(f)) {
            if (f === 'c') { if (rest < args.length) rest++; i += 2; continue; }
            if (rest >= args.length) { out += c + f; i += 2; continue; }
            const a = args[rest++];
            switch (f) {
              case 's': out += typeof a === 'string' ? a : (typeof a === 'object' && a !== null ? fmt(a, 1, 1, []) : fmt(a, 1, 2, [])); break;
              case 'd':
              case 'i': {
                if (typeof a === 'bigint') { out += a + 'n'; break; }
                const n = Number(a);
                out += f === 'i' ? String(Math.trunc(n)) : String(n);
                break;
              }
              case 'f': out += String(parseFloat(a)); break;
              case 'j': try { out += JSON.stringify(a); } catch (_) { out += '[Circular]'; } break;
              default: out += fmt(a, 1, 3, []); break;
            }
            i += 2;
            continue;
          }
        }
        out += c;
        i++;
      }
    } else {
      out = typeof first === 'string' ? first : inspectTop(first);
    }
    for (let j = rest; j < args.length; j++) {
      const a = args[j];
      out += ' ' + (typeof a === 'string' ? a : inspectTop(a));
    }
    return out;
  }

  function emit(text) {
    host.write(groupIndent ? groupIndent + text.replace(/\n/g, '\n' + groupIndent) : text);
  }

  const consoleObj = {
    log(...args) { emit(formatArgs(args)); },
    info(...args) { emit(formatArgs(args)); },
    debug(...args) { emit(formatArgs(args)); },
    warn(...args) { emit(formatArgs(args)); },
    error(...args) { emit(formatArgs(args)); },
    trace(...args) {
      const e = new Error();
      const stack = typeof e.stack === 'string' ? cleanStack(e.stack).replace(/\s+$/, '') : '';
      emit('Trace' + (args.length ? ': ' + formatArgs(args) : '') + (stack ? '\n' + stack : ''));
    },
    dir(obj, options) { emit(inspect(obj, options)); },
    dirxml(...args) { emit(formatArgs(args)); },
    assert(cond, ...args) {
      if (!cond) emit('Assertion failed' + (args.length ? ': ' + formatArgs(args) : ''));
    },
    table(data) {
      if (data === null || typeof data !== 'object') { emit(formatArgs([data])); return; }
      const rows = data instanceof Map ? [...data.entries()].map(([k, v]) => [k, v]) : Object.keys(data).map(k => [k, data[k]]);
      const cols = [];
      for (const [, r] of rows) {
        if (r !== null && typeof r === 'object') for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
      }
      const hasValues = rows.some(([, r]) => r === null || typeof r !== 'object');
      const header = ['(index)', ...cols, ...(hasValues ? ['Values'] : [])];
      const table = rows.map(([k, r]) => {
        const isObj = r !== null && typeof r === 'object';
        return [String(k), ...cols.map(c => (isObj && c in r ? fmt(r[c], 1, 0, []) : '')), ...(hasValues ? [isObj ? '' : fmt(r, 1, 0, [])] : [])];
      });
      const widths = header.map((h, i) => Math.max(h.length, ...table.map(r => r[i].length)) + 2);
      const line = (l, m, r) => l + widths.map(w => '─'.repeat(w)).join(m) + r;
      const row = cells => '│' + cells.map((c, i) => {
        const total = widths[i] - c.length;
        const left = Math.floor(total / 2);
        return ' '.repeat(left) + c + ' '.repeat(total - left);
      }).join('│') + '│';
      const out = [line('┌', '┬', '┐'), row(header), line('├', '┼', '┤'), ...table.map(row), line('└', '┴', '┘')];
      emit(out.join('\n'));
    },
    group(...args) { if (args.length) emit(formatArgs(args)); groupIndent += '  '; },
    groupCollapsed(...args) { if (args.length) emit(formatArgs(args)); groupIndent += '  '; },
    groupEnd() { groupIndent = groupIndent.slice(0, -2); },
    count(label = 'default') {
      const n = (counters.get(label) || 0) + 1;
      counters.set(label, n);
      emit(label + ': ' + n);
    },
    countReset(label = 'default') { counters.delete(label); },
    time(label = 'default') { timers.set(label, host.now()); },
    timeLog(label = 'default', ...args) {
      if (!timers.has(label)) { emit("Warning: No such label '" + label + "' for console.timeLog()"); return; }
      emit(label + ': ' + (host.now() - timers.get(label)).toFixed(3) + 'ms' + (args.length ? ' ' + formatArgs(args) : ''));
    },
    timeEnd(label = 'default') {
      if (!timers.has(label)) { emit("Warning: No such label '" + label + "' for console.timeEnd()"); return; }
      emit(label + ': ' + (host.now() - timers.get(label)).toFixed(3) + 'ms');
      timers.delete(label);
    },
  };

  // ------------------------------------------------------------------------------------------------
  // assertions
  // ------------------------------------------------------------------------------------------------
  class AssertionError extends Error {
    constructor(message, details) {
      super(message);
      this.name = 'AssertionError';
      if (details !== undefined) this.details = details;
    }
  }

  function report(e, prefix) {
    if (e !== null && (typeof e === 'object' || typeof e === 'function')) {
      if (reported.has(e)) return false;
      reported.add(e);
    }
    host.writeError((prefix || '') + formatError(e));
    return true;
  }

  // Records the failure, prints it once, and throws so the failing test stops right there.
  function failWith(message, details) {
    const e = new AssertionError(message, details);
    state.failures++;
    report(e);
    throw e;
  }

  function describe(v) {
    return fmt(v, 1, 3, []);
  }

  function messageOr(msg, fallback) {
    if (msg === undefined) return fallback;
    if (isError(msg)) throw msg;
    return String(msg);
  }

  function sameValue(a, b) {
    return a === b || (a !== a && b !== b);
  }

  function deepEqual(a, b, seen) {
    if (sameValue(a, b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    for (const [x, y] of seen) if (x === a && y === b) return true;
    seen.push([a, b]);
    try {
      if (a instanceof Date) return sameValue(a.getTime(), b.getTime());
      if (a instanceof RegExp) return String(a) === String(b);
      if (a instanceof Number || a instanceof String || a instanceof Boolean) return sameValue(a.valueOf(), b.valueOf());
      if (ArrayBuffer.isView(a) && !(a instanceof DataView)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
        return true;
      }
      if (a instanceof ArrayBuffer) return deepEqual(new Uint8Array(a), new Uint8Array(b), seen);
      if (a instanceof Map) {
        if (a.size !== b.size) return false;
        for (const [k, v] of a) {
          if (!b.has(k) || !deepEqual(v, b.get(k), seen)) return false;
        }
        return true;
      }
      if (a instanceof Set) {
        if (a.size !== b.size) return false;
        outer: for (const v of a) {
          if (b.has(v)) continue;
          if (typeof v === 'object' && v !== null) {
            for (const w of b) if (deepEqual(v, w, seen)) continue outer;
          }
          return false;
        }
        return true;
      }
      if (isError(a) && (a.name !== b.name || a.message !== b.message)) return false;
      const ka = Object.keys(a);
      const kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      for (const k of ka) {
        if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
        if (!deepEqual(a[k], b[k], seen)) return false;
      }
      return true;
    } finally {
      seen.pop();
    }
  }

  function matchesExpected(err, expected) {
    if (expected === undefined) return true;
    if (typeof expected === 'function') {
      if (expected.prototype !== undefined && err instanceof expected) return true;
      if (Error.isPrototypeOf(expected) || expected === Error) return false;
      return expected(err) === true;
    }
    const msg = isError(err) ? String(err.message) : String(err);
    if (expected instanceof RegExp) return expected.test(msg) || expected.test(String(err));
    if (typeof expected === 'string') return msg.includes(expected);
    if (typeof expected === 'object' && expected !== null) {
      for (const k of Object.keys(expected)) {
        const want = expected[k];
        const got = err == null ? undefined : err[k];
        if (want instanceof RegExp ? !want.test(String(got)) : !deepEqual(got, want, [])) return false;
      }
      return true;
    }
    return false;
  }

  function assert(cond, msg) {
    state.assertions++;
    if (!cond) failWith(messageOr(msg, 'Assertion failed: got ' + describe(cond)));
  }

  assert.ok = assert;
  assert.equal = function equal(actual, expected, msg) {
    state.assertions++;
    if (!sameValue(actual, expected)) failWith(messageOr(msg, 'Expected values to be strictly equal'), 'actual:   ' + describe(actual) + '\nexpected: ' + describe(expected));
  };
  assert.strictEqual = assert.equal;
  assert.notEqual = function notEqual(actual, expected, msg) {
    state.assertions++;
    if (sameValue(actual, expected)) failWith(messageOr(msg, 'Expected values to differ, both are ' + describe(actual)));
  };
  assert.notStrictEqual = assert.notEqual;
  assert.deepEqual = function deepEqualAssert(actual, expected, msg) {
    state.assertions++;
    if (!deepEqual(actual, expected, [])) failWith(messageOr(msg, 'Expected values to be deeply equal'), 'actual:   ' + describe(actual) + '\nexpected: ' + describe(expected));
  };
  assert.deepStrictEqual = assert.deepEqual;
  assert.notDeepEqual = function notDeepEqual(actual, expected, msg) {
    state.assertions++;
    if (deepEqual(actual, expected, [])) failWith(messageOr(msg, 'Expected values not to be deeply equal: ' + describe(actual)));
  };
  assert.closeTo = function closeTo(actual, expected, epsilon = 1e-9, msg) {
    state.assertions++;
    if (typeof actual !== 'number' || typeof expected !== 'number' || !(Math.abs(actual - expected) <= epsilon)) {
      failWith(messageOr(msg, 'Expected ' + describe(actual) + ' to be within ' + epsilon + ' of ' + describe(expected)));
    }
  };
  assert.match = function match(str, re, msg) {
    state.assertions++;
    if (typeof str !== 'string' || !re.test(str)) failWith(messageOr(msg, 'Expected ' + describe(str) + ' to match ' + String(re)));
  };
  assert.throws = function throws(fn, expected, msg) {
    state.assertions++;
    try {
      fn();
    } catch (e) {
      if (!matchesExpected(e, expected)) failWith(messageOr(msg, 'The thrown error did not match the expectation'), 'thrown:   ' + describe(e) + '\nexpected: ' + describe(expected));
      return e;
    }
    failWith(messageOr(msg, 'Expected the function to throw'));
  };
  assert.doesNotThrow = function doesNotThrow(fn, msg) {
    state.assertions++;
    try {
      return fn();
    } catch (e) {
      failWith(messageOr(msg, 'Expected the function not to throw, but it threw ' + errorHeader(e)));
    }
  };
  assert.rejects = async function rejects(promiseOrFn, expected, msg) {
    state.assertions++;
    try {
      await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
    } catch (e) {
      if (!matchesExpected(e, expected)) failWith(messageOr(msg, 'The rejection did not match the expectation'), 'rejected: ' + describe(e) + '\nexpected: ' + describe(expected));
      return e;
    }
    failWith(messageOr(msg, 'Expected the promise to reject'));
  };
  assert.doesNotReject = async function doesNotReject(promiseOrFn, msg) {
    state.assertions++;
    try {
      return await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
    } catch (e) {
      failWith(messageOr(msg, 'Expected the promise not to reject, but it rejected with ' + errorHeader(e)));
    }
  };
  assert.fail = function fail(msg) {
    failWith(msg === undefined ? 'Failed' : isError(msg) ? errorHeader(msg) : String(msg));
  };
  assert.AssertionError = AssertionError;

  function fail(msg) {
    failWith(msg === undefined ? 'fail() called' : isError(msg) ? errorHeader(msg) : String(msg));
  }

  // ------------------------------------------------------------------------------------------------
  // test(name, fn): optional registry, run sequentially after the module (and its top-level await) finished
  // ------------------------------------------------------------------------------------------------
  function test(name, fn) {
    if (typeof name === 'function') { fn = name; name = fn.name || 'test #' + (state.tests.length + 1); }
    if (typeof fn !== 'function') throw new TypeError('test(name, fn): fn must be a function');
    if (state.testsStarted) throw new Error('test("' + name + '") was registered after the tests started running; register tests at module top level');
    state.tests.push({ name: String(name), fn, skip: false, only: false });
  }
  test.skip = function skip(name, fn) {
    state.tests.push({ name: String(name), fn, skip: true, only: false });
  };
  test.only = function only(name, fn) {
    test(name, fn);
    state.tests[state.tests.length - 1].only = true;
  };

  function runTests() {
    state.testsStarted = true;
    runAllTests().then(
      () => host.testsFinished(),
      e => { host.testsFinished(); host.uncaught(e, 'Uncaught (in test runner) '); });
  }

  function formatDuration(virtualMs, realMs) {
    const parts = [];
    if (virtualMs > 0) parts.push(Math.round(virtualMs) + ' ms virtual');
    // Real time only for slow tests, so normal output stays deterministic.
    if (realMs >= 1000) parts.push((realMs / 1000).toFixed(1) + ' s real');
    return parts.length ? ' (' + parts.join(', ') + ')' : '';
  }

  async function runAllTests() {
    const all = state.tests;
    if (all.length === 0) return;
    const hasOnly = all.some(t => t.only);
    const grepSource = host.grep();
    const grep = typeof grepSource === 'string' ? new RegExp(grepSource, 'i') : null;
    let index = 0;
    for (const t of all) {
      index++;
      if (t.skip || (hasOnly && !t.only) || (grep && !grep.test(t.name))) {
        state.skipped++;
        host.write('ok ' + index + ' - ' + t.name + ' # SKIP' + (grep && !t.skip && !grep.test(t.name) ? ' (--grep)' : ''));
        continue;
      }
      state.current = t.name;
      host.testStarted(t.name);
      const failuresBefore = state.failures;
      const started = host.now();
      const startedReal = host.realNow();
      let threw = false;
      try {
        const testBody = t.fn;
        await testBody();
      } catch (e) {
        threw = true;
        if (!(e !== null && typeof e === 'object' && reported.has(e))) {
          state.failures++;
          report(e);
        }
      }
      state.current = null;
      const timing = formatDuration(host.now() - started, host.realNow() - startedReal);
      if (threw || state.failures > failuresBefore) {
        state.failed++;
        host.write('not ok ' + index + ' - ' + t.name + timing);
      } else {
        state.passed++;
        host.write('ok ' + index + ' - ' + t.name + timing);
      }
    }
  }

  // ------------------------------------------------------------------------------------------------
  // structuredClone (HTML structured clone algorithm subset; prototypes of class instances are dropped)
  // ------------------------------------------------------------------------------------------------
  class DOMExceptionShim extends Error {
    constructor(message = '', name = 'Error') {
      super(message);
      Object.defineProperty(this, 'name', { value: name, configurable: true, writable: true });
    }
  }

  function structuredClone(value) {
    const memo = new Map();
    const dataCloneError = what => new (G.DOMException || DOMExceptionShim)(what + ' could not be cloned.', 'DataCloneError');
    function clone(v) {
      if (v === null || (typeof v !== 'object' && typeof v !== 'function' && typeof v !== 'symbol')) return v;
      if (typeof v === 'function') throw dataCloneError(String(v.name ? 'function ' + v.name : 'function'));
      if (typeof v === 'symbol') throw dataCloneError(v.toString());
      if (memo.has(v)) return memo.get(v);
      let out;
      if (Array.isArray(v)) {
        out = new Array(v.length);
        memo.set(v, out);
        for (const k of Object.keys(v)) out[k] = clone(v[k]);
        return out;
      }
      if (v instanceof Date) { out = new Date(v.getTime()); memo.set(v, out); return out; }
      if (v instanceof RegExp) { out = new RegExp(v.source, v.flags); memo.set(v, out); return out; }
      if (v instanceof Boolean) { out = Object(v.valueOf()); memo.set(v, out); return out; }
      if (v instanceof Number) { out = Object(v.valueOf()); memo.set(v, out); return out; }
      if (v instanceof String) { out = Object(v.valueOf()); memo.set(v, out); return out; }
      if (v instanceof ArrayBuffer) { out = v.slice(0); memo.set(v, out); return out; }
      if (ArrayBuffer.isView(v)) {
        const buf = clone(v.buffer);
        out = v instanceof DataView ? new DataView(buf, v.byteOffset, v.byteLength) : new v.constructor(buf, v.byteOffset, v.length);
        memo.set(v, out);
        return out;
      }
      if (v instanceof Map) {
        out = new Map();
        memo.set(v, out);
        for (const [k, val] of v) out.set(clone(k), clone(val));
        return out;
      }
      if (v instanceof Set) {
        out = new Set();
        memo.set(v, out);
        for (const val of v) out.add(clone(val));
        return out;
      }
      if (isError(v)) {
        const ctor = { EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError }[v.name] || Error;
        out = new ctor(v.message);
        memo.set(v, out);
        if (typeof v.stack === 'string') out.stack = v.stack;
        if ('cause' in v) out.cause = clone(v.cause);
        return out;
      }
      if ((typeof Promise === 'function' && v instanceof Promise) || v instanceof WeakMap || v instanceof WeakSet ||
          (typeof WeakRef === 'function' && v instanceof WeakRef)) {
        throw dataCloneError(fmt(v, 1, 0, []));
      }
      out = {};
      memo.set(v, out);
      for (const k of Object.keys(v)) out[k] = clone(v[k]);
      return out;
    }
    return clone(value);
  }

  // ------------------------------------------------------------------------------------------------
  // TextEncoder / TextDecoder (UTF-8 only)
  // ------------------------------------------------------------------------------------------------
  // UTF-8 conversion runs natively in the host (.NET follows the same replacement rules as the WHATWG
  // Encoding spec: lone surrogates encode as U+FFFD, invalid byte sequences decode to U+FFFD each).
  function toBytes(input) {
    if (input === undefined || input === null) return new Uint8Array(0);
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new TypeError("TextDecoder.decode: expected an ArrayBuffer or ArrayBufferView");
  }

  class TextEncoderShim {
    get encoding() { return 'utf-8'; }
    encode(input = '') {
      return new Uint8Array(host.utf8Encode(String(input)));
    }
    encodeInto(input, dest) {
      const s = String(input);
      // Encode whole code points while they fit, as the spec requires.
      let read = 0, written = 0;
      for (const ch of s) {
        const bytes = this.encode(ch);
        if (written + bytes.length > dest.length) break;
        dest.set(bytes, written);
        written += bytes.length;
        read += ch.length;
      }
      return { read, written };
    }
  }

  class TextDecoderShim {
    constructor(label = 'utf-8', options = {}) {
      const l = String(label).trim().toLowerCase();
      if (l !== 'utf-8' && l !== 'utf8' && l !== 'unicode-1-1-utf-8') throw new RangeError("TextDecoder: only 'utf-8' is supported by JsCheck, got '" + label + "'");
      this.fatal = !!options.fatal;
      this.ignoreBOM = !!options.ignoreBOM;
    }
    get encoding() { return 'utf-8'; }
    decode(input) {
      const text = host.utf8Decode(toBytes(input), this.fatal);
      if (text === null) throw new TypeError('The encoded data was not valid utf-8');
      return !this.ignoreBOM && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    }
  }

  // ------------------------------------------------------------------------------------------------
  // atob / btoa
  // ------------------------------------------------------------------------------------------------
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function invalidChar(msg) {
    return new (G.DOMException || DOMExceptionShim)(msg, 'InvalidCharacterError');
  }

  function btoa(data) {
    const s = String(data);
    let out = '';
    for (let i = 0; i < s.length; i += 3) {
      const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
      if (a > 255 || b > 255 || c > 255) throw invalidChar("btoa: the string contains characters outside of the Latin1 range");
      const n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < s.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < s.length ? B64[n & 63] : '=');
    }
    return out;
  }

  function atob(data) {
    let s = String(data).replace(/[\t\n\f\r ]/g, '');
    if (s.length % 4 === 0) s = s.replace(/==?$/, '');
    if (s.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(s)) throw invalidChar('atob: the string to be decoded is not correctly encoded');
    let out = '';
    let bits = 0, acc = 0;
    for (const ch of s) {
      acc = (acc << 6) | B64.indexOf(ch);
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((acc >> bits) & 255);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------
  // URL / URLSearchParams (WHATWG-ish subset: enough for building and parsing API and asset URLs)
  // ------------------------------------------------------------------------------------------------
  const SPECIAL_PORTS = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'ftp:': '21', 'file:': '' };

  function formEncode(s) {
    return encodeURIComponent(s).replace(/%20/g, '+').replace(/[!'()~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  }

  function formDecode(s) {
    const t = s.replace(/\+/g, ' ');
    try {
      return decodeURIComponent(t);
    } catch (_) {
      return t;
    }
  }

  class URLSearchParamsShim {
    constructor(init = '') {
      this._list = [];
      this._url = null;
      if (init instanceof URLSearchParamsShim) {
        this._list = init._list.map(p => [p[0], p[1]]);
      } else if (typeof init === 'object' && init !== null) {
        if (typeof init[Symbol.iterator] === 'function') {
          for (const pair of init) {
            const arr = [...pair];
            if (arr.length !== 2) throw new TypeError("URLSearchParams: each pair must have exactly two elements");
            this._list.push([String(arr[0]), String(arr[1])]);
          }
        } else {
          for (const k of Object.keys(init)) this._list.push([k, String(init[k])]);
        }
      } else {
        this._parse(String(init));
      }
    }
    _parse(s) {
      this._list = [];
      if (s.startsWith('?')) s = s.slice(1);
      for (const part of s.split('&')) {
        if (!part) continue;
        const eq = part.indexOf('=');
        this._list.push(eq < 0 ? [formDecode(part), ''] : [formDecode(part.slice(0, eq)), formDecode(part.slice(eq + 1))]);
      }
    }
    _changed() {
      if (this._url) this._url._query = this._list.length ? this.toString() : null;
    }
    get size() { return this._list.length; }
    append(name, value) { this._list.push([String(name), String(value)]); this._changed(); }
    delete(name, value) {
      name = String(name);
      this._list = this._list.filter(p => !(p[0] === name && (value === undefined || p[1] === String(value))));
      this._changed();
    }
    get(name) { const p = this._list.find(x => x[0] === String(name)); return p ? p[1] : null; }
    getAll(name) { return this._list.filter(x => x[0] === String(name)).map(x => x[1]); }
    has(name, value) { return this._list.some(p => p[0] === String(name) && (value === undefined || p[1] === String(value))); }
    set(name, value) {
      name = String(name);
      const i = this._list.findIndex(p => p[0] === name);
      if (i < 0) this._list.push([name, String(value)]);
      else {
        this._list[i][1] = String(value);
        this._list = this._list.filter((p, j) => j <= i || p[0] !== name);
      }
      this._changed();
    }
    sort() { this._list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); this._changed(); }
    forEach(cb, thisArg) { for (const [k, v] of this._list) cb.call(thisArg, v, k, this); }
    *keys() { for (const p of this._list) yield p[0]; }
    *values() { for (const p of this._list) yield p[1]; }
    *entries() { for (const p of this._list) yield [p[0], p[1]]; }
    [Symbol.iterator]() { return this.entries(); }
    toString() { return this._list.map(([k, v]) => formEncode(k) + '=' + formEncode(v)).join('&'); }
    get [Symbol.toStringTag]() { return 'URLSearchParams'; }
  }

  function removeDotSegments(path) {
    const out = [];
    const segs = path.split('/');
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s === '.' || s === '%2e' || s === '%2E') {
        if (i === segs.length - 1) out.push('');
      } else if (s === '..' || /^(\.|%2e){2}$/i.test(s)) {
        if (out.length > 1) out.pop();
        if (i === segs.length - 1) out.push('');
      } else {
        out.push(s);
      }
    }
    let r = out.join('/');
    if (path.startsWith('/') && !r.startsWith('/')) r = '/' + r;
    return r;
  }

  function encodePath(p) {
    return p.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@/%]/g, c => encodeURIComponent(c));
  }

  function encodeQueryOrHash(q) {
    return q.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@/?%#[\]{}|\\^`]/g, c => encodeURIComponent(c)).replace(/[`{}|\\^]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  }

  const ABS = /^([A-Za-z][A-Za-z0-9+.\-]*):(.*)$/s;

  class URLShim {
    constructor(url, base) {
      const input = String(url).trim();
      const m = ABS.exec(input);
      if (m && !(base !== undefined && m[1].length === 1 && /^[A-Za-z]$/.test(m[1]))) {
        this._set(m[1].toLowerCase() + ':', m[2]);
      } else {
        if (base === undefined) throw new TypeError("Failed to construct 'URL': Invalid URL '" + input + "'");
        const b = base instanceof URLShim ? base : new URLShim(String(base));
        this._resolve(input, b);
      }
    }

    _set(protocol, rest) {
      this._protocol = protocol;
      this._username = '';
      this._password = '';
      this._hostname = '';
      this._port = '';
      this._query = null;
      this._fragment = null;
      const special = protocol in SPECIAL_PORTS;
      const h = rest.indexOf('#');
      if (h >= 0) { this._fragment = rest.slice(h + 1); rest = rest.slice(0, h); }
      const q = rest.indexOf('?');
      if (q >= 0) { this._query = rest.slice(q + 1); rest = rest.slice(0, q); }
      if (special) rest = rest.replace(/\\/g, '/');
      if (rest.startsWith('//')) {
        rest = rest.slice(2);
        const slash = rest.indexOf('/');
        let authority = slash >= 0 ? rest.slice(0, slash) : rest;
        rest = slash >= 0 ? rest.slice(slash) : '';
        const at = authority.lastIndexOf('@');
        if (at >= 0) {
          const cred = authority.slice(0, at);
          authority = authority.slice(at + 1);
          const c = cred.indexOf(':');
          this._username = c >= 0 ? cred.slice(0, c) : cred;
          this._password = c >= 0 ? cred.slice(c + 1) : '';
        }
        const pm = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(authority);
        if (!pm) throw new TypeError("Failed to construct 'URL': Invalid URL");
        this._hostname = pm[1].toLowerCase();
        this._port = pm[2] && pm[2] !== SPECIAL_PORTS[protocol] ? String(Number(pm[2])) : '';
        if (special && protocol !== 'file:' && !this._hostname) throw new TypeError("Failed to construct 'URL': Invalid URL");
        this._path = special ? removeDotSegments(encodePath(rest) || '/') : encodePath(rest);
        this._opaque = false;
      } else if (special && protocol !== 'file:') {
        // "http:example.com/x" without slashes: treat what follows as the authority (as browsers do).
        this._set(protocol, '//' + rest.replace(/^\/*/, '') + (this._query !== null ? '?' + this._query : '') + (this._fragment !== null ? '#' + this._fragment : ''));
        return;
      } else {
        this._path = special ? removeDotSegments(encodePath(rest)) : rest;
        this._opaque = !rest.startsWith('/');
      }
      if (this._query !== null) this._query = encodeQueryOrHash(this._query);
      if (this._fragment !== null) this._fragment = encodeQueryOrHash(this._fragment);
      this._params = null;
    }

    _resolve(input, b) {
      if (input.startsWith('//')) { this._set(b._protocol, input); return; }
      this._protocol = b._protocol;
      this._username = b._username;
      this._password = b._password;
      this._hostname = b._hostname;
      this._port = b._port;
      this._opaque = false;
      this._params = null;
      let rest = input;
      if (b._protocol in SPECIAL_PORTS) rest = rest.replace(/\\/g, '/');
      let fragment = null, query = null;
      const h = rest.indexOf('#');
      if (h >= 0) { fragment = rest.slice(h + 1); rest = rest.slice(0, h); }
      const q = rest.indexOf('?');
      if (q >= 0) { query = rest.slice(q + 1); rest = rest.slice(0, q); }
      if (rest === '') {
        this._path = b._path;
        this._query = q >= 0 ? encodeQueryOrHash(query) : b._query;
      } else {
        if (b._opaque) throw new TypeError("Failed to construct 'URL': Invalid URL");
        const merged = rest.startsWith('/') ? rest : b._path.slice(0, b._path.lastIndexOf('/') + 1) + rest;
        this._path = removeDotSegments(encodePath(merged));
        this._query = q >= 0 ? encodeQueryOrHash(query) : null;
      }
      this._fragment = fragment !== null ? encodeQueryOrHash(fragment) : null;
    }

    get protocol() { return this._protocol; }
    set protocol(v) { const p = String(v).replace(/:.*$/, '').toLowerCase(); if (/^[a-z][a-z0-9+.\-]*$/.test(p)) { this._protocol = p + ':'; if (this._port === SPECIAL_PORTS[this._protocol]) this._port = ''; } }
    get username() { return this._username; }
    set username(v) { this._username = encodeURIComponent(String(v)); }
    get password() { return this._password; }
    set password(v) { this._password = encodeURIComponent(String(v)); }
    get hostname() { return this._hostname; }
    set hostname(v) { this._hostname = String(v).toLowerCase(); }
    get port() { return this._port; }
    set port(v) { const s = String(v); this._port = s === '' || s === SPECIAL_PORTS[this._protocol] ? '' : String(parseInt(s, 10) || ''); }
    get host() { return this._hostname + (this._port ? ':' + this._port : ''); }
    set host(v) { const m = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(String(v)); if (m) { this._hostname = m[1].toLowerCase(); this.port = m[2] || ''; } }
    get origin() {
      return this._protocol in SPECIAL_PORTS && this._protocol !== 'file:' ? this._protocol + '//' + this.host : 'null';
    }
    get pathname() { return this._path; }
    set pathname(v) { if (!this._opaque) { const s = String(v); this._path = removeDotSegments(encodePath(s.startsWith('/') ? s : '/' + s)); } }
    get search() { return this._query ? '?' + this._query : ''; }
    set search(v) {
      const s = String(v);
      this._query = s === '' || s === '?' ? null : encodeQueryOrHash(s.startsWith('?') ? s.slice(1) : s);
      if (this._params) this._params._parse(this._query || '');
    }
    get searchParams() {
      if (!this._params) {
        this._params = new URLSearchParamsShim(this._query || '');
        this._params._url = this;
      }
      return this._params;
    }
    get hash() { return this._fragment ? '#' + this._fragment : ''; }
    set hash(v) { const s = String(v); this._fragment = s === '' || s === '#' ? null : encodeQueryOrHash(s.startsWith('#') ? s.slice(1) : s); }
    get href() {
      let s = this._protocol;
      if (!this._opaque) {
        s += '//';
        if (this._username || this._password) s += this._username + (this._password ? ':' + this._password : '') + '@';
        s += this.host;
      }
      s += this._path;
      if (this._query !== null) s += '?' + this._query;
      if (this._fragment !== null) s += '#' + this._fragment;
      return s;
    }
    set href(v) { const u = new URLShim(String(v)); Object.assign(this, u); this._params = null; }
    toString() { return this.href; }
    toJSON() { return this.href; }
    get [Symbol.toStringTag]() { return 'URL'; }
    static canParse(url, base) {
      try { new URLShim(url, base); return true; } catch (_) { return false; }
    }
    static parse(url, base) {
      try { return new URLShim(url, base); } catch (_) { return null; }
    }
  }

  // ------------------------------------------------------------------------------------------------
  // localStorage / sessionStorage (in memory, fresh for every run)
  // ------------------------------------------------------------------------------------------------
  class StorageShim {
    constructor() { Object.defineProperty(this, '_map', { value: new Map() }); }
    get length() { return this._map.size; }
    key(i) { const keys = [...this._map.keys()]; return i >= 0 && i < keys.length ? keys[i] : null; }
    getItem(k) { k = String(k); return this._map.has(k) ? this._map.get(k) : null; }
    setItem(k, v) { this._map.set(String(k), String(v)); }
    removeItem(k) { this._map.delete(String(k)); }
    clear() { this._map.clear(); }
  }

  // ------------------------------------------------------------------------------------------------
  // fetch: reads local files below the web root (--root); any network URL rejects
  // ------------------------------------------------------------------------------------------------
  class HeadersShim {
    constructor(init) {
      this._map = new Map();
      if (init) {
        const entries = init instanceof HeadersShim ? [...init._map] : typeof init[Symbol.iterator] === 'function' ? [...init] : Object.entries(init);
        for (const [k, v] of entries) this.append(k, v);
      }
    }
    append(k, v) { k = String(k).toLowerCase(); this._map.set(k, this._map.has(k) ? this._map.get(k) + ', ' + v : String(v)); }
    set(k, v) { this._map.set(String(k).toLowerCase(), String(v)); }
    get(k) { const v = this._map.get(String(k).toLowerCase()); return v === undefined ? null : v; }
    has(k) { return this._map.has(String(k).toLowerCase()); }
    delete(k) { this._map.delete(String(k).toLowerCase()); }
    forEach(cb, thisArg) { for (const [k, v] of this._map) cb.call(thisArg, v, k, this); }
    *entries() { yield* this._map.entries(); }
    *keys() { yield* this._map.keys(); }
    *values() { yield* this._map.values(); }
    [Symbol.iterator]() { return this.entries(); }
  }

  class ResponseShim {
    constructor(body = null, init = {}) {
      this._bytes = body === null || body === undefined ? new Uint8Array(0)
        : body instanceof Uint8Array ? body
        : body instanceof ArrayBuffer ? new Uint8Array(body)
        : new TextEncoderShim().encode(String(body));
      this.status = init.status === undefined ? 200 : init.status;
      this.statusText = init.statusText || '';
      this.headers = new HeadersShim(init.headers);
      this.url = init.url || '';
      this.redirected = false;
      this.type = 'basic';
      this.bodyUsed = false;
    }
    get ok() { return this.status >= 200 && this.status < 300; }
    _consume() {
      if (this.bodyUsed) return Promise.reject(new TypeError('Body has already been consumed.'));
      this.bodyUsed = true;
      return Promise.resolve(this._bytes);
    }
    text() { return this._consume().then(b => new TextDecoderShim().decode(b)); }
    json() { return this.text().then(t => JSON.parse(t)); }
    arrayBuffer() { return this._consume().then(b => (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b.buffer : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))); }
    bytes() { return this._consume().then(b => b.slice()); }
    clone() { const r = new ResponseShim(this._bytes.slice(), this); r.url = this.url; return r; }
    static json(data, init = {}) { return new ResponseShim(JSON.stringify(data), { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } }); }
  }

  function fetchShim(resource, init) {
    return new Promise((resolve, reject) => {
      const raw = resource && typeof resource === 'object' && 'url' in resource ? resource.url : String(resource);
      const method = String((init && init.method) || 'GET').toUpperCase();
      if (/^[a-z][a-z0-9+.\-]*:/i.test(raw) && !/^file:/i.test(raw)) {
        reject(new TypeError("fetch('" + raw + "'): network access is not available in JsCheck; stub globalThis.fetch in the test"));
        return;
      }
      if (method !== 'GET' && method !== 'HEAD') {
        reject(new TypeError("fetch('" + raw + "'): only GET/HEAD of local files is supported in JsCheck (got " + method + ')'));
        return;
      }
      const found = host.readFile(raw);
      // Resolve on a later task, like a real network response.
      G.setTimeout(() => {
        if (found === null || found === undefined) {
          resolve(new ResponseShim('Not Found', { status: 404, statusText: 'Not Found', url: raw }));
        } else {
          const r = new ResponseShim(method === 'HEAD' ? null : new Uint8Array(found.data), { status: 200, statusText: 'OK', url: found.url, headers: { 'content-type': found.type } });
          resolve(r);
        }
      }, 0);
    });
  }

  // ------------------------------------------------------------------------------------------------
  // install globals
  // ------------------------------------------------------------------------------------------------
  function define(name, value) {
    Object.defineProperty(G, name, { value, writable: true, configurable: true, enumerable: false });
  }

  define('console', consoleObj);
  define('assert', assert);
  define('fail', fail);
  define('test', test);
  define('AssertionError', AssertionError);
  define('structuredClone', structuredClone);
  define('queueMicrotask', function queueMicrotask(callback) {
    if (typeof callback !== 'function') throw new TypeError('queueMicrotask: callback must be a function');
    Promise.resolve().then(() => {
      try {
        callback();
      } catch (e) {
        host.uncaught(e);
      }
    });
  });
  if (typeof G.DOMException !== 'function') define('DOMException', DOMExceptionShim);
  if (typeof G.TextEncoder !== 'function') define('TextEncoder', TextEncoderShim);
  if (typeof G.TextDecoder !== 'function') define('TextDecoder', TextDecoderShim);
  if (typeof G.atob !== 'function') define('atob', atob);
  if (typeof G.btoa !== 'function') define('btoa', btoa);
  if (typeof G.URL !== 'function') define('URL', URLShim);
  if (typeof G.URLSearchParams !== 'function') define('URLSearchParams', URLSearchParamsShim);
  if (typeof G.Headers !== 'function') define('Headers', HeadersShim);
  if (typeof G.Response !== 'function') define('Response', ResponseShim);
  if (typeof G.fetch !== 'function') define('fetch', fetchShim);
  define('localStorage', new StorageShim());
  define('sessionStorage', new StorageShim());
  define('Storage', StorageShim);
  const timeOrigin = host.timeOrigin();
  define('performance', {
    now() { return host.now(); },
    get timeOrigin() { return timeOrigin; },
    toJSON() { return { timeOrigin }; },
  });

  // --seed <n>: deterministic Math.random (sfc32), so randomized game logic is reproducible.
  const seed = host.seed();
  if (typeof seed === 'number') {
    let a = 0x9e3779b9, b = 0x243f6a88, c = 0xb7e15162, d = seed >>> 0;
    const next = () => {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
    for (let i = 0; i < 15; i++) next();
    Object.defineProperty(Math, 'random', { value: function random() { return next(); }, writable: true, configurable: true, enumerable: false });
  }

  return {
    inspect: inspectTop,
    formatError,
    report,
    reportUncaught(e, prefix) {
      const printed = report(e, prefix);
      if (printed) state.failures++;
      return printed;
    },
    runTests,
    stats() {
      return {
        assertions: state.assertions,
        failures: state.failures,
        tests: state.tests.length,
        passed: state.passed,
        failed: state.failed,
        skipped: state.skipped,
      };
    },
  };
})
