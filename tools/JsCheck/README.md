# JsCheck

A headless checker and test runner for TwinSpin's browser code (plain ES modules, no build step), for
machines with no Node.js and no browser. It is a .NET 10 console app built on
[Jint](https://github.com/sebastienros/jint) 4.16.4, a JavaScript interpreter, and its parser
[Acornima](https://github.com/adams85/acornima) 1.7.0. Those are its only dependencies.

| Command | What it does |
|---|---|
| `check <dir\|file>...` | Parses every `*.js`/`*.mjs` as an ES module. Reports syntax errors, plus warnings for broken imports, missing exports and undeclared variables. |
| `run <file.js>` | Runs one ES module test file with browser-like globals, on a virtual clock. |
| `test <dir\|file>...` | Runs every `*.test.js` it finds, each in a fresh engine, then prints a summary. |

Exit codes: **0** means OK, **1** means errors or failed tests, **2** means a usage error or a failed build.

## Requirements

* The **.NET 10 SDK** (`dotnet --list-sdks` must list a `10.x` version). Get it from
  https://dotnet.microsoft.com/download. Windows, macOS and Linux all work.
* Internet access for the first build only: it restores Jint and Acornima from NuGet.

The first call builds JsCheck (Release) into `tools/JsCheck/bin/` and `obj/`; both are gitignored.

## Quick start

From the repository root:

```bash
tools/JsCheck/jscheck check src tests          # syntax, imports, exports, undeclared names
tools/JsCheck/jscheck test tests               # every tests/*.test.js, in parallel
tools/JsCheck/jscheck run tests/pwa.test.js    # one file, with its full output
```

```powershell
tools\JsCheck\jscheck.ps1 check src tests      # the same in PowerShell
tools\JsCheck\jscheck.ps1 test tests
```

`jscheck` is a bash script (Git Bash on Windows, any shell on macOS/Linux; it is stored with LF line endings
and the executable bit). `jscheck.ps1` is the PowerShell twin. Both build on first use, then call the DLL
directly: about 0.3 s per call, against about 1.4 s for the equivalent `dotnet run`:

```bash
dotnet run --project tools/JsCheck -- check src tests
dotnet run --project tools/JsCheck -- test tests
```

When a launcher runs, it rebuilds JsCheck if any `*.cs`, `prelude.js` or `*.csproj` file is newer than the
built DLL.

TwinSpin's rules for tests (small signals, under 60 s per file, `check` must report 0 errors and 0 warnings)
are in `docs/CONTRACT.md`, section 0. `tests/realsongs.test.js` analyses your own WAV files from
`tests/media/` (not in the repository) and skips each song whose file is missing.

---

## `check`

```
dotnet run --project tools/JsCheck -- check <dir|file>... [--strict] [--web-root <dir>]
                                            [--globals a,b] [--no-undef] [--no-classic] [--exclude <name>]
```

* **Syntax errors.** Each file is parsed as an ES module (`ecmaVersion: latest`, `sourceType: module`).
  Modules are always strict, so the parser also reports the strict-mode early errors a browser would reject.
  Examples are octal literals, `with`, duplicate parameters, `delete x`, invalid regular expressions,
  duplicate exports and reserved words. The parser stops at the first error in a file, as browsers do.
  Each error prints as `<path>:<line>:<col> SyntaxError: <message>`. Lines and columns are 1-based. A path is
  relative to the current directory when the file is inside it, and absolute otherwise.
  When the error line contains an invisible character that commonly causes such errors, the message ends
  with a `[hint: ...]` naming it. The usual culprit is a raw U+2028 LINE SEPARATOR pasted into a regex
  literal, which acts as a line break; zero-width spaces are another.
* **Warnings.** Warnings print as `<path>:<line>:<col> warning: <message>` and do not change the exit code.
  Pass `--strict` to make them fail the check. JsCheck warns about:
  * a relative (`./`, `../`) or root-absolute (`/`) import whose file does not exist. Dynamic `import('...')`
    with a string literal is checked too. The warning adds a hint for a missing `.js` extension (browsers
    never add one) and for directory imports.
  * an import whose file exists only with different letter case, such as `./ui/Deck-ui.js` versus
    `deck-ui.js`. Windows accepts it, but a case-sensitive web server (GitHub Pages) returns a 404.
  * an imported name the target module does not export, with a "did you mean" suggestion.
    `export * from` chains are followed. In a browser this is a link-time `SyntaxError` that stops the whole
    module graph.
  * a bare specifier (`import x from 'three'`), unless an HTML file in the web root contains an import map.
  * an identifier that is read or written but declared nowhere, which throws a `ReferenceError` at runtime.
    Scope analysis comes from the parser and covers hoisting, blocks, parameters, catch clauses, classes
    and labels. `typeof x` is allowed. A name counts as declared if it is any of these:
    * a browser or ECMAScript built-in (`window`, `document`, `AudioContext`, `requestAnimationFrame` and others)
    * listed in a `/* global a, b */` comment in the file (TwinSpin's worklet files do this)
    * listed in `--globals a,b`
    * assigned as `window.X = ...` (or `globalThis.X`, `self.X`) in any checked file
    * declared at the top level of a **classic script**
    * one of `assert`, `fail`, `test` in `*.test.js` files and in files under a `test`, `tests`, `__tests__` or `spec` directory

    Pass `--no-undef` to turn this check off.
* **Classic scripts.** A `.js` file that an HTML page in the web root loads with `<script src>` and no
  `type="module"` is parsed as a sloppy-mode script instead of a module. TwinSpin's `index.html` loads
  `config.js` this way. The top-level names it declares become globals for the modules. Pass `--no-classic`
  to parse every file as a module, as the strictest reading of "every .js is an ES module" would.
* **Web root.** This is the directory that `/x.js` imports resolve against: the nearest directory, from the
  file upwards (stopping at the git root), that contains `index.html`. If there is none, JsCheck uses the git
  root. `--web-root` overrides it. For TwinSpin that is the repository root.
* **Skipped directories.** `node_modules`, every dot-directory and any `--exclude <name>`.

Example output for a small project with mistakes in it:

```
src/broken.js:2:13 SyntaxError: Unexpected token '{'
src/main.js:1:23 warning: './curves.js' does not provide an export named 'faderGian' (did you mean 'faderGain'?)
src/main.js:2:22 warning: cannot resolve import './peer': no file at src/peer
src/main.js:3:22 warning: bare import specifier 'canvas-confetti' cannot be resolved by a browser without an import map (use './' or '../')
src/main.js:5:1 warning: 'deckState' is not defined; this throws a ReferenceError when reached (declare it, import it, or list it in /* global deckState */)
FAIL 1 error in 1 of 3 files, 4 warnings
```

On success, the last line is `OK <n> files`, or `OK <n> files, <w> warnings` when there are warnings.
On failure it is `FAIL <e> errors in <f> of <n> files[, <w> warnings]`.

---

## `run`

```
dotnet run --project tools/JsCheck -- run <file.js> [--root <dir>] [--timeout <sec>] [--seed <n>]
                                          [--grep <regex>] [--max-virtual-ms <n>] [--linger-ms <n>]
                                          [--max-timers <n>]
```

The file is imported as an ES module, so relative, `/`-rooted, dynamic and JSON
(`with { type: 'json' }`) imports all work. Top-level `await` works too, including in dependencies
(TwinSpin's own modules do not use it; see `docs/CONTRACT.md`). `--root` sets the web root for `/` imports
and `fetch`. It defaults to the same rule `check` uses, and falls back to the file's own directory.

### Globals

| Global | Notes |
|---|---|
| `console.log/info/debug/warn/error` | All print to **stdout**, formatted like Node's `util.inspect`. `%s %d %i %f %j %o %O %c %%` are supported. Also `dir`, `table`, `group`, `count`, `time`/`timeEnd` (virtual ms), `assert` and `trace`. |
| `assert(cond, msg)` | Plus `assert.equal`, `notEqual`, `deepEqual`, `notDeepEqual`, `closeTo(a, b, eps)`, `match(str, re)`, `throws(fn, matcher)`, `rejects(promiseOrFn, matcher)`, `doesNotThrow`, `doesNotReject` and `fail`. A matcher is a class, RegExp, substring, `{name, message}` object or predicate. `equal` uses `===`, except that NaN equals NaN. |
| `fail(msg)` | Records a failure, prints it and throws an `AssertionError`. The run fails **even if the error is caught**. |
| `test(name, fn)`, `test.skip`, `test.only` | Optional. Registered tests run one after another, after the module (including its top-level await) finishes. Each prints `ok N - name` or `not ok N - name`, plus its virtual duration, and its real duration when that is 1 s or more. `--grep <regex>` (case-insensitive) runs only the tests whose names match and marks the rest `# SKIP (--grep)`. |
| `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval` | On the virtual clock (see below). Extra arguments are passed to the callback, and a string callback throws a TypeError. |
| `requestAnimationFrame`, `cancelAnimationFrame` | Frames fall on 60 fps boundaries (multiples of 16.67 ms). The callback gets the frame timestamp. |
| `queueMicrotask`, `structuredClone` | `structuredClone` handles cycles, Date, RegExp, Map, Set, ArrayBuffer, typed arrays and errors. Functions throw `DataCloneError`. |
| `performance.now()`, `Date.now()` | Both follow the virtual clock. Dates start at the real time the run began. The time zone is **UTC**. |
| `URL`, `URLSearchParams`, `atob`, `btoa`, `TextEncoder`, `TextDecoder` | WHATWG-style subsets. `TextDecoder` is UTF-8 only. |
| `localStorage`, `sessionStorage` | In memory, and empty at the start of every run. |
| `fetch`, `Response`, `Headers` | `fetch` reads local files only. Relative and `/` URLs resolve against the web root, and `file:` URLs also work, so `fetch(new URL('./x.json', import.meta.url))` loads from disk. A missing file returns a 404 response, and `http(s)` URLs reject. Supports `text()`, `json()`, `arrayBuffer()` and `bytes()`. |
| `import.meta.url`, `import.meta.resolve()` | Return `file:///...` URLs. |

There is **no** `window`, `document`, canvas, WebGL, Web Audio, IndexedDB or `WebSocket`. That is why
TwinSpin keeps its pure logic (DSP, BPM detection, cue and sync maths, routing plans) in DOM-free modules,
and the tests stub the rest (`tests/helpers/fake-dom.js`, `tests/helpers/fake-models.js`, the stub
`self`/`caches`/`fetch` in `tests/pwa.test.js`). Intl and `toLocaleString` use .NET's ICU data and format
like a browser.

**Engine workaround.** Jint 4 returns holes from `slice()` on a frozen or sealed array (`Object.freeze([0..9]).slice(3)`
gave `[3,4,5,6,null,null,null]`). The prelude detects the bug at start-up and, only then, slices non-extensible arrays
with a spec-following copy, so tests see what a browser returns.

### Event loop and virtual clock

Nothing ever sleeps. After every task, all promise jobs (microtasks) run. Then the earliest timer runs,
and the clock jumps to its due time. Timers with the same due time run in the order they were scheduled.
So `await sleep(10_000)` finishes in microseconds, and the order of events is deterministic. The HTML timer
rules are followed: a negative or NaN delay means 0, and a timer nested more than 5 levels deep is clamped
to at least 4 ms. Because of that clamp, `setTimeout(f, 0)` loops still advance time.

The run ends when no timers and no jobs are left. Three limits stop it earlier:

* **`--max-virtual-ms`** (default 7 days). Virtual time costs nothing, so long simulated sessions (a whole
  Auto Mix set, a service-worker timeout) are cheap. Reaching this limit while the module or a `test()` is
  still pending is a failure.
* **`--linger-ms`** (default 1 minute). After the module and all its tests have finished, leftover timers
  run for at most this much more virtual time. A `setInterval` or `requestAnimationFrame` loop that is
  never cleared therefore ends quickly, with a **warning** that lists the timers still scheduled. It is
  not a failure.
* **`--max-timers`** (2,000,000 callbacks) and the real-time **`--timeout`** (default 60 s). Busy loops never
  advance virtual time, so only `--timeout` can stop them.

### When a run fails (exit code 1)

* An **error thrown while the module evaluates**. It is printed as `Uncaught <Error>` with its stack, and the
  run stops. A missing export also prints a `hint:` line with the exact `file:line:col`, taken from the checker.
* An **uncaught error in a timer, rAF callback or microtask**, or an **unhandled promise rejection**. It is
  printed as `Uncaught ...` or `Uncaught (in promise) ...`. It fails the `test()` that is running at that
  moment, but the event loop carries on, as it would in a browser. After 25 such errors the run stops.
* Any failed `assert*` or any call to `fail()`.
* A top-level `await` or `test()` that can never finish. When nothing is left that could settle it, or
  `--max-virtual-ms` passes, JsCheck reports `error: module evaluation never finished ...` or
  `error: test '<name>' never finished ...` and does not hang.
* The real-time `--timeout` is exceeded, or runaway recursion gives
  `RangeError: Maximum call stack size exceeded`. Depth is about 30k frames, and the error is catchable.

A timer loop that is still running once everything has finished is only a warning (see `--linger-ms`).
The last line of the output is always a summary:

```
PASS tests/pwa.test.js (20 tests, 234 assertions, 102 timer callbacks, 15.876 s virtual, 120 ms real)
FAIL tests/curves.test.js (2 of 3 tests failed, 2 failures, 2 assertions, 1 timer callback, 100 ms virtual, 272 ms real)
```

### Test patterns

```js
// tests/curves.test.js: pure modules import straight away
import { xfadeSCurve } from '../src/audio/curves.js';

test('scheduled crossfade S-curve: ends and middle', () => {
  assert.equal(xfadeSCurve(0), 0);
  assert.equal(xfadeSCurve(1), 1);
  assert.closeTo(xfadeSCurve(0.5), 0.5, 1e-12);
});
```

```js
// tests/pwa.test.js (shortened): stub the browser globals first, then load the module under test with a
// dynamic import, because static imports are evaluated before any code in this file runs.
const handlers = {};
globalThis.self = {
  location: { href: 'https://u.github.io/twinspin/sw.js', origin: 'https://u.github.io' },
  addEventListener(type, fn) { handlers[type] = fn; },
};
globalThis.caches = new FakeCacheStorage(); // a small in-memory fake defined in the test
await import('../sw.js');                   // sw.js registers its install/activate/fetch handlers
```

* Use `--seed <n>` to make code that calls `Math.random` reproducible.
* `fetch('tests/media/song.wav')` works headless when the file exists under the web root; that is how
  `tests/realsongs.test.js` reads its WAV files (a missing file is a 404 response, and the test skips).

---

## `test`

```
dotnet run --project tools/JsCheck -- test <dir|file>... [--exclude <name>] [--jobs <n>] [run options]
```

Runs every `*.test.js` and `*.test.mjs` file it finds, each in its own engine, then prints:

```
ALL PASSED: 27 files, 394 tests, 29322 assertions
```

or `FAILED: <k> of <n> files`, followed by the summary line of each failed file.

Files run in parallel. `--jobs` sets how many at once; the default is half the CPU cores, up to 8. Each
file's output is still printed in one block, in file order, so the report is the same on every run.
`--jobs 1` runs the files one at a time and streams their output as it happens. Run options such as
`--timeout`, `--seed` and `--grep` apply to every file.

---

## Not included here

JsCheck started in another project. Its demo fixtures (`samples/`) and golden-output self-tests
(`selftest/`, `selftest.sh`) are **not** part of this repository; TwinSpin's own `tests/` exercise the
runner instead.

## Several processes at once

Windows locks a DLL while a process is running it. If JsCheck's sources have changed, the next
`dotnet run --project tools/JsCheck` rebuilds. If another JsCheck process is running at that moment,
the rebuild can fail with `MSB3027 ... being used by another process`. Run the command again once the
other run has finished, or use `dotnet run --no-build`.

The launchers (`jscheck`, `jscheck.ps1`) handle this case themselves: they print a warning on stderr and
run the previous build.

## Source layout

| File | Role |
|---|---|
| `Program.cs` | Argument parsing, usage, and the `test` command. |
| `Checker.cs` | The `check` command: parsing (Acornima, tolerant mode, with every error collected), imports and exports, classic-script detection. |
| `UndeclaredCheck.cs` | The no-undef pass, which uses the scope data the parser reports through `OnNode`. |
| `Globals.cs` | Browser and ECMAScript global names. |
| `Runner.cs` | The `run` command: engine setup, event-loop driver, failure reporting and summary. It runs on a 64 MB-stack thread. |
| `TimerQueue.cs` | The virtual clock and timer queue. |
| `RunnerModuleLoader.cs` | Browser-like module resolution, readable load errors and case-mismatch warnings. |
| `RunnerHost.cs` | `import.meta.url` and `import.meta.resolve`. |
| `Util.cs` | Output (buffered stdout, captured per file for parallel `test`), path display and directory helpers. |
| `prelude.js` | Globals written in JS: console and inspect, assert, test, structuredClone, URL, fetch, storage, encoders and the seeded `Math.random`. It is embedded in the assembly. |
| `JsCheck.csproj` | .NET 10 project file (Jint package reference, embedded prelude). |
| `jscheck`, `jscheck.ps1` | The fast launchers (bash and PowerShell). |

## Limitations

* `run` uses Jint, an interpreter: roughly 50 to 100 times slower than V8 (about 2-3 million simple loop
  iterations per second). That is fine for logic and protocol tests, but not for benchmarks; keep test
  signals small (TwinSpin's audio tests use 8000-12000 Hz sample rates and 10-40 s of audio).
* Stack trace frames are formatted by Jint. They have file, line and column, but anonymous callbacks are
  sometimes labelled after their caller. Test bodies show up as `<test>`.
* `check` finds parse-time (early) errors only. A runtime TypeError, such as assigning to a `const`, is
  found only by `run`. The undeclared-variable check cannot see globals created through
  `Object.assign(window, ...)`, `eval` or other dynamic means. Use `/* global */` or `--globals` for those.
* `URL`, `TextDecoder`, `structuredClone` and `fetch` are pragmatic subsets, not full WHATWG
  implementations.
