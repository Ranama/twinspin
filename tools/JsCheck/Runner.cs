using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using Jint;
using Jint.Native;
using Jint.Native.Object;
using Jint.Native.Promise;
using Jint.Runtime;
using Jint.Runtime.Interop;

namespace JsCheck;

internal sealed class RunOptions
{
    public required string File { get; init; }

    /// <summary>Directory that root-absolute imports ('/src/x.js') resolve against. Null = auto-detect.</summary>
    public string? Root { get; init; }

    public double TimeoutSeconds { get; init; } = 60;

    /// <summary>Virtual-time cap while the module or a test is still pending (default 7 days: whole-game
    /// simulations legitimately need hours of virtual time, and virtual time itself costs nothing).</summary>
    public double MaxVirtualMs { get; init; } = 7 * 24 * 3_600_000.0;

    /// <summary>How much more virtual time leftover timers may run after the module and its tests finished.</summary>
    public double LingerMs { get; init; } = 60_000;

    public long MaxTimerCallbacks { get; init; } = 2_000_000;

    /// <summary>Seed for a deterministic Math.random, or null for the engine default.</summary>
    public uint? Seed { get; init; }

    /// <summary>Collect the run's output in <see cref="RunResult.Output"/> instead of printing it.</summary>
    public bool CaptureOutput { get; init; }

    /// <summary>Only run test() cases whose name matches this regular expression (case-insensitive).</summary>
    public string? Grep { get; init; }
}

internal sealed class RunResult
{
    public bool Passed { get; set; }
    public int Failures { get; set; }
    public int Tests { get; set; }
    public int TestsFailed { get; set; }
    public int Assertions { get; set; }
    public string Summary { get; set; } = "";

    /// <summary>Captured output lines (only with <see cref="RunOptions.CaptureOutput"/>).</summary>
    public List<string> Output { get; set; } = new();
}

/// <summary>
/// Executes one ES module with Jint and drives a deterministic event loop:
/// microtasks after every task, then the earliest virtual timer, until nothing is left.
/// </summary>
internal sealed class Runner
{
    private const string PreludeName = "jscheck:prelude";
    private static readonly Lazy<string> PreludeSource = new(LoadPrelude);

    private readonly RunOptions _options;
    private readonly TimerQueue _timers = new();
    private readonly List<(JsValue Promise, JsValue? Reason)> _unhandled = new();
    private readonly long _timeOriginMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private readonly CancellationTokenSource _cts;
    private readonly Stopwatch _realClock = Stopwatch.StartNew();
    private Engine _engine = null!;
    private ObjectInstance _api = null!;
    private RunnerModuleLoader _loader = null!;
    private string _webRoot = "";
    private Jint.Runtime.Modules.ModuleImportOperation? _import;
    private bool _importReported;

    private const int MaxUncaught = 25;

    private bool _fatal;
    private int _uncaughtCount;
    private bool _testsFinished;
    private string? _currentTest;
    private int _hostFailures;
    private string? _abortReason;

    private Runner(RunOptions options)
    {
        _options = options;
        _cts = new CancellationTokenSource(TimeSpan.FromSeconds(options.TimeoutSeconds));
    }

    /// <summary>Runs the file on a dedicated thread with a large stack (deep JS recursion needs native stack).</summary>
    public static RunResult Run(RunOptions options)
    {
        RunResult? result = null;
        Exception? crash = null;
        List<string>? captured = null;
        var thread = new Thread(() =>
        {
            if (options.CaptureOutput)
            {
                Out.BeginCapture();
            }

            try
            {
                var runner = new Runner(options);
                try
                {
                    result = runner.RunCore();
                }
                finally
                {
                    runner._cts.Dispose();
                }
            }
            catch (Exception ex)
            {
                crash = ex;
            }
            finally
            {
                if (options.CaptureOutput)
                {
                    captured = Out.EndCapture();
                }
            }
        }, maxStackSize: 64 * 1024 * 1024)
        {
            Name = "jscheck-run",
            CurrentCulture = CultureInfo.InvariantCulture,
            CurrentUICulture = CultureInfo.InvariantCulture,
        };
        thread.Start();
        thread.Join();

        if (crash != null)
        {
            captured ??= new List<string>();
            captured.Add("internal error in JsCheck runner: " + crash);
            if (!options.CaptureOutput)
            {
                Out.Line(captured[^1]);
            }

            result = new RunResult { Passed = false, Failures = 1, Summary = "FAIL " + PathUtil.Display(options.File) + " (internal error)" };
        }

        result!.Output = captured ?? new List<string>();
        return result;
    }

    private RunResult RunCore()
    {
        var file = Path.GetFullPath(_options.File);
        var display = PathUtil.Display(file);
        var started = Stopwatch.StartNew();

        if (!File.Exists(file))
        {
            Out.Line($"error: file not found: {display}");
            return new RunResult { Passed = false, Failures = 1, Summary = $"FAIL {display} (file not found)" };
        }

        var fileDir = Path.GetDirectoryName(file)!;
        var root = _options.Root != null
            ? Path.GetFullPath(_options.Root)
            : PathUtil.FindWebRoot(fileDir) ?? PathUtil.FindRepoRoot(fileDir) ?? fileDir;
        _webRoot = root;

        _loader = new RunnerModuleLoader(root, Out.Line);
        _engine = new Engine(o =>
        {
            o.EnableModules(_loader);
            o.UseHostFactory(_ => new RunnerHost());
            o.CancellationToken(_cts.Token);
            o.Constraints.StackOverflowGuard = true;
            o.TimeSystem = new VirtualTimeSystem(_timers, _timeOriginMs);
            o.TimeZone = TimeZoneInfo.Utc;
            o.Culture = CultureInfo.InvariantCulture;
        });
        _engine.Advanced.PromiseRejectionTracker += OnPromiseRejection;

        InstallTimerGlobals();
        _api = InstallPrelude();

        _import = _engine.Modules.StartImport(new Uri(file).AbsoluteUri);
        var import = _import;
        var stage = Stage.Importing;
        var limitHit = false;
        var doneAt = 0.0;

        while (true)
        {
            Drain();
            if (_fatal)
            {
                break;
            }

            if (_cts.IsCancellationRequested)
            {
                Abort($"timed out after {_options.TimeoutSeconds:0.###} s of real time (use --timeout to raise the limit)", "timed out");
                break;
            }

            if (stage == Stage.Importing && import.IsCompleted)
            {
                if (import.IsFaulted)
                {
                    ReportImportFailure();
                    break;
                }

                // Registered test() cases run now; the prelude calls host.testsFinished() when they are done.
                stage = Stage.Testing;
                Guard(() => _engine.Call(_api.Get("runTests"), _api, Array.Empty<JsValue>()));
                continue;
            }

            if (stage == Stage.Testing && _testsFinished)
            {
                stage = Stage.Done;
                doneAt = _timers.Now;
                continue;
            }

            if (!_timers.TryPeek(out var next))
            {
                break;
            }

            var virtualLimit = stage == Stage.Done ? doneAt + _options.LingerMs : _options.MaxVirtualMs;
            if (next.Due > virtualLimit || _timers.Fired >= _options.MaxTimerCallbacks)
            {
                limitHit = true;
                break;
            }

            FireTimer(_timers.Take());
        }

        if (!_fatal)
        {
            CheckCompletion(stage, limitHit);
        }

        var stats = ReadStats();
        var failures = stats.Failures + _hostFailures;
        var passed = failures == 0 && !_fatal;
        if (!passed && failures == 0)
        {
            failures = 1;
        }

        var parts = new List<string>();
        if (stats.Tests > 0)
        {
            var unfinished = stats.Tests - stats.Passed - stats.TestsFailed - stats.Skipped;
            parts.Add(stats.TestsFailed > 0
                ? $"{stats.TestsFailed} of {stats.Tests} tests failed"
                : $"{stats.Tests} test{(stats.Tests == 1 ? "" : "s")}");
            if (unfinished > 0)
            {
                parts.Add($"{unfinished} not finished");
            }

            if (stats.Skipped > 0)
            {
                parts.Add($"{stats.Skipped} skipped");
            }
        }

        if (!passed)
        {
            parts.Add($"{failures} failure{(failures == 1 ? "" : "s")}");
        }

        parts.Add($"{stats.Assertions} assertion{(stats.Assertions == 1 ? "" : "s")}");
        if (_timers.Fired > 0)
        {
            parts.Add($"{_timers.Fired} timer callback{(_timers.Fired == 1 ? "" : "s")}");
        }

        parts.Add($"{FormatMs(_timers.Now)} virtual");
        parts.Add($"{started.ElapsedMilliseconds} ms real");
        if (_abortReason != null)
        {
            parts.Add(_abortReason);
        }

        return new RunResult
        {
            Passed = passed,
            Failures = failures,
            Tests = stats.Tests,
            TestsFailed = stats.TestsFailed,
            Assertions = stats.Assertions,
            Summary = $"{(passed ? "PASS" : "FAIL")} {display} ({string.Join(", ", parts)})",
        };
    }

    private enum Stage
    {
        Importing,
        Testing,
        Done,
    }

    private void CheckCompletion(Stage stage, bool limitHit)
    {
        var why = limitHit
            ? $"the virtual time/timer limit was reached ({DescribeLimit()}) with {DescribeTimers()} still pending"
            : "nothing is left that could settle it (no pending timers or jobs)";

        switch (stage)
        {
            case Stage.Importing:
                _hostFailures++;
                Out.Line($"error: module evaluation never finished: a top-level await is still pending, and {why}");
                break;
            case Stage.Testing:
                _hostFailures++;
                var name = _currentTest != null ? $"test '{_currentTest}'" : "the test runner";
                Out.Line($"error: {name} never finished: it is awaiting a promise, and {why}");
                break;
            case Stage.Done when limitHit:
                Out.Line($"warning: stopped {FormatMs(_options.LingerMs)} (virtual) after the module and its tests finished; " +
                         $"{DescribeTimers()} still scheduled (a loop that is never cleared? raise --linger-ms to keep running them)");
                break;
        }
    }

    private string DescribeLimit()
    {
        return _timers.Fired >= _options.MaxTimerCallbacks
            ? $"{_options.MaxTimerCallbacks} timer callbacks, --max-timers"
            : $"{FormatMs(_options.MaxVirtualMs)} of virtual time, --max-virtual-ms";
    }

    private string DescribeTimers()
    {
        var active = _timers.Active.Where(t => !t.Cancelled).ToList();
        if (active.Count == 0)
        {
            return "no timers";
        }

        var described = active.Take(5).Select(t => t.Kind switch
        {
            TimerKind.Interval => $"setInterval #{t.Id} ({FormatMs(t.Delay)})",
            TimerKind.AnimationFrame => $"requestAnimationFrame #{t.Id}",
            _ => $"setTimeout #{t.Id} ({FormatMs(t.Delay)}, due at {FormatMs(t.Due)})",
        });
        var text = string.Join(", ", described);
        if (active.Count > 5)
        {
            text += $" and {active.Count - 5} more";
        }

        return $"{active.Count} timer{(active.Count == 1 ? "" : "s")}: {text}";
    }

    private static string FormatMs(double ms)
    {
        if (ms >= 86_400_000)
        {
            return (ms / 86_400_000).ToString("0.###", CultureInfo.InvariantCulture) + " d";
        }

        if (ms >= 3_600_000)
        {
            return (ms / 3_600_000).ToString("0.###", CultureInfo.InvariantCulture) + " h";
        }

        if (ms >= 10_000)
        {
            return (ms / 1000).ToString("0.###", CultureInfo.InvariantCulture) + " s";
        }

        return ms.ToString("0.###", CultureInfo.InvariantCulture) + " ms";
    }

    private void FireTimer(VirtualTimer timer)
    {
        // Animation frame callbacks are not timer tasks, so timers they schedule start a new nesting chain.
        _timers.CurrentNesting = timer.Kind == TimerKind.AnimationFrame ? 0 : timer.Nesting;
        try
        {
            var args = timer.Kind == TimerKind.AnimationFrame ? new JsValue[] { JsNumber.Create(timer.Due) } : timer.Args;
            Guard(() => _engine.Call(timer.Callback, JsValue.Undefined, args));
            // Microtasks queued by the callback belong to the same task (same nesting level).
            Drain();
        }
        finally
        {
            _timers.CurrentNesting = 0;
        }

        _timers.Rearm(timer);
    }

    /// <summary>Runs all queued promise jobs, then fails on rejections nobody handled (Node semantics).</summary>
    private void Drain()
    {
        if (_fatal)
        {
            return;
        }

        Guard(() => _engine.Advanced.ProcessTasks());

        // A module that throws while evaluating also leaves internal promises rejected; report the
        // evaluation error itself (as "Uncaught") before those, so it is not mislabelled "(in promise)".
        if (_import is { IsCompleted: true, IsFaulted: true } && !_fatal)
        {
            ReportImportFailure();
        }

        if (_unhandled.Count > 0 && !_fatal)
        {
            var list = _unhandled.ToList();
            _unhandled.Clear();
            foreach (var (_, reason) in list)
            {
                ReportUncaught(reason ?? JsValue.Undefined, "Uncaught (in promise) ");
            }
        }
    }

    private void ReportImportFailure()
    {
        if (_importReported || _import is null)
        {
            return;
        }

        _importReported = true;
        var error = _import.Error ?? JsValue.Undefined;
        ReportUncaught(error, "Uncaught ", fatal: true);

        // Jint reports a missing export as "Ambiguous import statement for identifier x" without a
        // location. The static checker knows exactly which import is wrong, so show its findings.
        if (error is ObjectInstance obj && TypeConverter.ToString(obj.Get("name")) == "SyntaxError"
            && TypeConverter.ToString(obj.Get("message")).Contains("import", StringComparison.OrdinalIgnoreCase))
        {
            var session = new CheckSession(new CheckOptions { Paths = new List<string>(), CheckUndeclared = false, WebRoot = _loader.WebRoot });
            foreach (var file in _loader.LoadedFiles)
            {
                foreach (var d in session.CheckFile(file).Where(d => d.Message.Contains("export", StringComparison.Ordinal)))
                {
                    Out.Line($"hint: {PathUtil.Display(d.File)}:{d.Line}:{d.Column} {d.Message}");
                }
            }
        }
    }

    private void OnPromiseRejection(object? sender, PromiseRejectionTrackerEventArgs e)
    {
        if (e.Operation == PromiseRejectionOperation.Reject)
        {
            _unhandled.Add((e.Promise, e.Value));
        }
        else
        {
            _unhandled.RemoveAll(x => ReferenceEquals(x.Promise, e.Promise));
        }
    }

    private void Guard(Action action)
    {
        try
        {
            action();
        }
        catch (JavaScriptException ex)
        {
            ReportUncaught(ex.Error, "Uncaught ", ex);
        }
        catch (ExecutionCanceledException)
        {
            Abort($"timed out after {_options.TimeoutSeconds:0.###} s of real time (infinite loop? use --timeout to raise the limit)", "timed out");
        }
        catch (PromiseRejectedException ex)
        {
            ReportUncaught(ex.RejectedValue, "Uncaught (in promise) ");
        }
        catch (JintException ex)
        {
            Abort($"engine error: {ex.GetType().Name}: {ex.Message}", "engine error");
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            Abort($"host error: {ex.GetType().Name}: {ex.Message}", "host error");
            Out.Line(ex.ToString());
        }
    }

    private void Abort(string reason, string shortReason)
    {
        _fatal = true;
        _hostFailures++;
        _abortReason = shortReason;
        if (_currentTest != null && !_testsFinished)
        {
            reason += $" [while running test '{_currentTest}']";
        }

        Out.Line("error: " + reason);
    }

    /// <summary>
    /// Reports an error nobody caught (timer callback, microtask, unhandled rejection, module evaluation).
    /// It counts as a failure (of the running test, if any) but, like in a browser, the event loop keeps
    /// going so the remaining timers and tests still run - unless <paramref name="fatal"/> or too many pile up.
    /// </summary>
    private void ReportUncaught(JsValue error, string prefix, JavaScriptException? ex = null, bool fatal = false)
    {
        if (fatal)
        {
            _fatal = true;
        }

        bool printedNow;
        try
        {
            // Prints once per error object and counts it as a failure; false if it was already reported
            // (an assertion failure that nobody caught is printed when the assertion fails).
            printedNow = _engine.Call(_api.Get("reportUncaught"), _api, new[] { error, (JsValue) prefix }).AsBoolean();
        }
        catch (Exception)
        {
            Out.Line(prefix + SafeToString(error));
            _hostFailures++;
            printedNow = true;
        }

        if (!printedNow)
        {
            return;
        }

        if (ex != null && !(error is ObjectInstance o && o.HasProperty("stack")) && ex.Location.SourceFile != null)
        {
            var loc = ex.Location;
            Out.Line($"    at {PathUtil.Display(loc.SourceFile)}:{loc.Start.Line}:{loc.Start.Column + 1}");
        }

        if (++_uncaughtCount >= MaxUncaught && !_fatal)
        {
            Abort($"stopping after {MaxUncaught} uncaught errors", "too many uncaught errors");
            _hostFailures--; // the errors themselves are already counted
        }
    }

    private static string SafeToString(JsValue value)
    {
        try
        {
            return value.ToString();
        }
        catch (Exception)
        {
            return "<unprintable value>";
        }
    }

    private (int Assertions, int Failures, int Tests, int TestsFailed, int Skipped, int Passed) ReadStats()
    {
        try
        {
            var s = _engine.Call(_api.Get("stats"), _api, Array.Empty<JsValue>()).AsObject();
            int N(string k) => (int) TypeConverter.ToNumber(s.Get(k));
            return (N("assertions"), N("failures"), N("tests"), N("failed"), N("skipped"), N("passed"));
        }
        catch (Exception)
        {
            return (0, 0, 0, 0, 0, 0);
        }
    }

    // ----------------------------------------------------------------------------------------------
    // globals
    // ----------------------------------------------------------------------------------------------

    private void InstallTimerGlobals()
    {
        var e = _engine;

        JsValue Schedule(JsValue[] args, TimerKind kind, string fnName)
        {
            var callback = args.Length > 0 ? args[0] : JsValue.Undefined;
            if (!callback.IsCallable())
            {
                throw new JavaScriptException(e.Intrinsics.TypeError,
                    $"{fnName}: the callback must be a function (string callbacks are not supported), got {TypeName(callback)}");
            }

            double delay = 0;
            JsValue[] extra = Array.Empty<JsValue>();
            if (kind != TimerKind.AnimationFrame)
            {
                delay = args.Length > 1 ? TypeConverter.ToNumber(args[1]) : 0;
                if (args.Length > 2)
                {
                    extra = args[2..];
                }
            }

            return JsNumber.Create(_timers.Schedule(kind, callback, extra, delay));
        }

        JsValue Clear(JsValue[] args)
        {
            if (args.Length > 0 && args[0].IsNumber())
            {
                var n = args[0].AsNumber();
                if (n >= 1 && n <= int.MaxValue && Math.Floor(n) == n)
                {
                    _timers.Clear((int) n);
                }
            }

            return JsValue.Undefined;
        }

        void Def(string name, int length, Func<JsValue, JsValue[], JsValue> fn)
        {
            e.SetValue(name, new ClrFunction(e, name, fn, length));
        }

        Def("setTimeout", 1, (_, a) => Schedule(a, TimerKind.Timeout, "setTimeout"));
        Def("setInterval", 1, (_, a) => Schedule(a, TimerKind.Interval, "setInterval"));
        Def("requestAnimationFrame", 1, (_, a) => Schedule(a, TimerKind.AnimationFrame, "requestAnimationFrame"));
        Def("clearTimeout", 1, (_, a) => Clear(a));
        Def("clearInterval", 1, (_, a) => Clear(a));
        Def("cancelAnimationFrame", 1, (_, a) => Clear(a));
    }

    private static string TypeName(JsValue v)
    {
        if (v.IsUndefined())
        {
            return "undefined";
        }

        if (v.IsNull())
        {
            return "null";
        }

        return v.Type.ToString().ToLowerInvariant();
    }

    private ObjectInstance InstallPrelude()
    {
        var e = _engine;
        var host = new JsObject(e);

        void Def(string name, Func<JsValue, JsValue[], JsValue> fn)
        {
            host.Set(name, new ClrFunction(e, name, fn, 1));
        }

        Def("write", (_, a) =>
        {
            Out.Line(a.Length > 0 ? TypeConverter.ToString(a[0]) : "");
            return JsValue.Undefined;
        });
        Def("writeError", (_, a) =>
        {
            Out.Line(PathUtil.PrettifyPaths(a.Length > 0 ? TypeConverter.ToString(a[0]) : ""));
            return JsValue.Undefined;
        });
        Def("now", (_, _) => JsNumber.Create(_timers.Now));
        Def("timeOrigin", (_, _) => JsNumber.Create(_timeOriginMs));
        Def("uncaught", (_, a) =>
        {
            ReportUncaught(a.Length > 0 ? a[0] : JsValue.Undefined, a.Length > 1 ? TypeConverter.ToString(a[1]) : "Uncaught ");
            return JsValue.Undefined;
        });
        Def("testsFinished", (_, _) =>
        {
            _testsFinished = true;
            _currentTest = null;
            return JsValue.Undefined;
        });
        Def("testStarted", (_, a) =>
        {
            _currentTest = a.Length > 0 ? TypeConverter.ToString(a[0]) : null;
            return JsValue.Undefined;
        });
        Def("prettify", (_, a) => PathUtil.PrettifyPaths(a.Length > 0 ? TypeConverter.ToString(a[0]) : ""));
        Def("grep", (_, _) => _options.Grep is { } g ? g : JsValue.Undefined);
        Def("realNow", (_, _) => JsNumber.Create(_realClock.Elapsed.TotalMilliseconds));
        Def("utf8Encode", (_, a) => _engine.Intrinsics.ArrayBuffer.Construct(System.Text.Encoding.UTF8.GetBytes(a.Length > 0 ? TypeConverter.ToString(a[0]) : "")));
        Def("utf8Decode", (_, a) => Utf8Decode(a.Length > 0 ? a[0] : JsValue.Undefined, a.Length > 1 && TypeConverter.ToBoolean(a[1])));
        Def("seed", (_, _) => _options.Seed is { } s ? JsNumber.Create(s) : JsValue.Undefined);
        Def("readFile", (_, a) => ReadFileForFetch(a.Length > 0 ? TypeConverter.ToString(a[0]) : ""));

        var factory = e.Evaluate(PreludeSource.Value, PreludeName);
        return e.Call(factory, JsValue.Undefined, new JsValue[] { host }).AsObject();
    }

    /// <summary>
    /// fetch() support: resolves a URL the way a page served from the web root would (relative and
    /// '/'-absolute both against the web root) and returns { data (ArrayBuffer), url, type }, or null.
    /// </summary>
    private JsValue ReadFileForFetch(string url)
    {
        var clean = url;
        var cut = clean.IndexOfAny(new[] { '?', '#' });
        if (cut >= 0)
        {
            clean = clean[..cut];
        }

        string path;
        try
        {
            if (clean.StartsWith("file:", StringComparison.OrdinalIgnoreCase))
            {
                path = new Uri(clean).LocalPath;
            }
            else
            {
                path = Path.GetFullPath(Path.Combine(_webRoot, Uri.UnescapeDataString(clean.TrimStart('/'))));
            }
        }
        catch (Exception)
        {
            return JsValue.Null;
        }

        if (!PathUtil.FileExistsExactCase(path, out var actual))
        {
            return JsValue.Null;
        }

        if (actual != null)
        {
            Out.Line($"warning: fetch('{url}') only matches '{PathUtil.Display(actual)}' when letter case is ignored; it will 404 on a case-sensitive web server");
        }

        var bytes = File.ReadAllBytes(path);
        var type = Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".json" => "application/json",
            ".txt" => "text/plain; charset=utf-8",
            ".js" or ".mjs" => "text/javascript",
            ".html" => "text/html",
            ".css" => "text/css",
            ".svg" => "image/svg+xml",
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".webp" => "image/webp",
            ".mp3" => "audio/mpeg",
            ".ogg" => "audio/ogg",
            ".wav" => "audio/wav",
            _ => "application/octet-stream",
        };

        var result = new JsObject(_engine);
        result.Set("data", _engine.Intrinsics.ArrayBuffer.Construct(bytes)); // wraps the array, no copy
        result.Set("url", new Uri(path).AbsoluteUri);
        result.Set("type", type);
        return result;
    }

    private static readonly System.Text.UTF8Encoding StrictUtf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    /// <summary>TextDecoder backend: decodes a Uint8Array; null when fatal and the bytes are not valid UTF-8.</summary>
    private static JsValue Utf8Decode(JsValue input, bool fatal)
    {
        var bytes = input.ToObject() as byte[] ?? Array.Empty<byte>();
        if (!fatal)
        {
            return System.Text.Encoding.UTF8.GetString(bytes);
        }

        try
        {
            return StrictUtf8.GetString(bytes);
        }
        catch (System.Text.DecoderFallbackException)
        {
            return JsValue.Null;
        }
    }

    private static string LoadPrelude()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("prelude.js")
                           ?? throw new InvalidOperationException("embedded prelude.js is missing");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    /// <summary>Date.now()/new Date() follow the virtual clock, starting at the real time the run began.</summary>
    private sealed class VirtualTimeSystem : DefaultTimeSystem
    {
        private readonly TimerQueue _timers;
        private readonly long _originMs;

        public VirtualTimeSystem(TimerQueue timers, long originMs)
            : base(TimeZoneInfo.Utc, CultureInfo.InvariantCulture)
        {
            _timers = timers;
            _originMs = originMs;
        }

        public override DateTimeOffset GetUtcNow()
        {
            return DateTimeOffset.FromUnixTimeMilliseconds(_originMs).AddMilliseconds(_timers.Now);
        }
    }
}
