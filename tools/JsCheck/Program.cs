using System.Globalization;

namespace JsCheck;

internal static class Program
{
    private const string Usage = """
        JsCheck - headless checker/runner for browser ES modules (Jint + Acornima)

        Usage:
          JsCheck check <dir|file>... [options]
              Parse every *.js/*.mjs (recursively) as an ES module (classic <script src> files named in
              the web root's HTML as scripts) and report syntax errors as "<path>:<line>:<col> <message>".
              Also warns (as "<path>:<line>:<col> warning: ...") about relative imports that do not
              resolve, imported names a module does not export, and references to undeclared variables.
              Prints "OK <n> files" when there are no errors. Exit code 1 on errors.
                --strict             treat warnings as errors (exit code 1)
                --web-root <dir>     directory '/'-imports resolve against (default: nearest dir with index.html)
                --globals a,b,c      extra global names to accept (also: /* global a, b */ in a file)
                --no-undef           do not report undeclared variables
                --no-classic         parse <script src> classic scripts as modules too (strict ES-module check)
                --exclude <name>     skip directories with this name (repeatable; node_modules/.git always skipped)

          JsCheck run <file.js> [options]
              Execute an ES module test file. Globals: console, assert(+helpers), fail, test,
              setTimeout/setInterval/requestAnimationFrame (+clear) on a virtual clock, queueMicrotask,
              structuredClone, performance.now, URL, URLSearchParams, atob/btoa, TextEncoder/TextDecoder,
              localStorage/sessionStorage (in memory), fetch (local files under the web root only).
              Exit code 1 on uncaught errors, unhandled rejections, assertion failures, fail(), or a
              top-level await / test that can never finish.
                --root <dir>         directory '/'-imports resolve against (default: nearest dir with index.html,
                                     else the git root, else the file's directory)
                --timeout <sec>      real (wall-clock) time limit, default 60
                --max-virtual-ms <n> fail if the module or a test is still pending after n ms of virtual time
                                     (default 604800000 = 7 days; virtual time is free, real time is not)
                --linger-ms <n>      after everything finished, run leftover timers for n more virtual ms
                                     (default 60000), then stop with a warning
                --max-timers <n>     stop after n timer callbacks, default 2000000
                --seed <n>           make Math.random deterministic (same seed, same sequence)
                --grep <regex>       only run test() cases whose name matches (case-insensitive)

          JsCheck test <dir|file>... [options]
              Run every *.test.js / *.test.mjs found (each in a fresh engine) and print a summary.
              Accepts the run options, --exclude <name>, and --jobs <n> (parallel files, default
              half the CPU cores, max 8). Exit code 1 if any file fails.
        """;

    private static int Main(string[] args)
    {
        CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
        CultureInfo.DefaultThreadCurrentUICulture = CultureInfo.InvariantCulture;
        try
        {
            return Dispatch(args);
        }
        catch (UsageException ex)
        {
            Out.Line("error: " + ex.Message);
            Out.Line("run 'JsCheck --help' for usage");
            return 2;
        }
        finally
        {
            Out.Flush();
        }
    }

    private static int Dispatch(string[] args)
    {
        if (args.Length == 0 || args[0] is "-h" or "--help" or "help" or "/?")
        {
            Out.Line(Usage);
            return args.Length == 0 ? 2 : 0;
        }

        var command = args[0];
        var parsed = ParseArgs(args.AsSpan(1));
        switch (command)
        {
            case "check":
            {
                parsed.AllowOnly("--strict", "--web-root", "--globals", "--no-undef", "--no-classic", "--exclude");
                if (parsed.Positional.Count == 0)
                {
                    throw new UsageException("check needs a directory or file");
                }

                var options = new CheckOptions
                {
                    Paths = parsed.Positional,
                    Strict = parsed.Has("--strict"),
                    WebRoot = parsed.Single("--web-root"),
                    ExtraGlobals = parsed.All("--globals").SelectMany(g => g.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)).ToList(),
                    CheckUndeclared = !parsed.Has("--no-undef"),
                    Excludes = parsed.All("--exclude"),
                    DetectClassicScripts = !parsed.Has("--no-classic"),
                };
                return Checker.Run(options);
            }

            case "run":
            {
                parsed.AllowOnly("--root", "--timeout", "--max-virtual-ms", "--linger-ms", "--max-timers", "--seed", "--grep");
                if (parsed.Positional.Count != 1)
                {
                    throw new UsageException("run needs exactly one file");
                }

                var result = Runner.Run(BuildRunOptions(parsed, parsed.Positional[0]));
                Out.Line(result.Summary);
                return result.Passed ? 0 : 1;
            }

            case "test":
            {
                parsed.AllowOnly("--root", "--timeout", "--max-virtual-ms", "--linger-ms", "--max-timers", "--seed", "--grep", "--exclude", "--jobs");
                if (parsed.Positional.Count == 0)
                {
                    throw new UsageException("test needs a directory or file");
                }

                return TestCommand(parsed);
            }

            default:
                throw new UsageException($"unknown command '{command}'");
        }
    }

    private static RunOptions BuildRunOptions(ParsedArgs parsed, string file, bool capture = false)
    {
        return new RunOptions
        {
            File = file,
            CaptureOutput = capture,
            Root = parsed.Single("--root"),
            TimeoutSeconds = parsed.Number("--timeout", 60),
            MaxVirtualMs = parsed.Number("--max-virtual-ms", 7 * 24 * 3_600_000.0),
            LingerMs = parsed.Number("--linger-ms", 60_000),
            MaxTimerCallbacks = (long) parsed.Number("--max-timers", 2_000_000),
            Seed = parsed.Seed(),
            Grep = parsed.Single("--grep"),
        };
    }

    private static int TestCommand(ParsedArgs parsed)
    {
        var files = new List<string>();
        foreach (var p in parsed.Positional)
        {
            if (File.Exists(p))
            {
                files.Add(Path.GetFullPath(p));
            }
            else if (Directory.Exists(p))
            {
                files.AddRange(SourceFiles.Enumerate(p, parsed.All("--exclude"))
                    .Where(f => f.EndsWith(".test.js", StringComparison.OrdinalIgnoreCase) || f.EndsWith(".test.mjs", StringComparison.OrdinalIgnoreCase)));
            }
            else
            {
                throw new UsageException($"no such file or directory: {p}");
            }
        }

        if (files.Count == 0)
        {
            Out.Line("no *.test.js files found");
            return 1;
        }

        // Files run in parallel (each in its own engine and thread); each file's output is printed in one
        // piece, in file order, so the report is deterministic. --jobs 1 streams output as it happens.
        var jobs = (int) parsed.Number("--jobs", Math.Clamp(Environment.ProcessorCount / 2, 1, 8));
        var results = new List<RunResult>();
        if (jobs <= 1)
        {
            foreach (var f in files)
            {
                Out.Line($"# {PathUtil.Display(f)}");
                var r = Runner.Run(BuildRunOptions(parsed, f));
                Out.Line(r.Summary);
                results.Add(r);
            }
        }
        else
        {
            // A fixed set of workers pulls files in order; the main thread prints each result as soon as
            // it and everything before it are done.
            var finished = new RunResult?[files.Count];
            var ready = files.Select(_ => new ManualResetEventSlim(false)).ToArray();
            var nextIndex = -1;
            var workers = Enumerable.Range(0, Math.Min(jobs, files.Count)).Select(_ => new Thread(() =>
            {
                int i;
                while ((i = Interlocked.Increment(ref nextIndex)) < files.Count)
                {
                    finished[i] = Runner.Run(BuildRunOptions(parsed, files[i], capture: true));
                    ready[i].Set();
                }
            }) { IsBackground = true, Name = "jscheck-test-worker" }).ToList();
            workers.ForEach(w => w.Start());

            for (var i = 0; i < files.Count; i++)
            {
                ready[i].Wait();
                var r = finished[i]!;
                Out.Line($"# {PathUtil.Display(files[i])}");
                foreach (var line in r.Output)
                {
                    Out.Line(line);
                }

                Out.Line(r.Summary);
                results.Add(r);
            }
        }

        var failed = results.Where(r => !r.Passed).ToList();
        Out.Line("");
        Out.Line(failed.Count == 0
            ? $"ALL PASSED: {results.Count} file{(results.Count == 1 ? "" : "s")}, {results.Sum(r => r.Tests)} tests, {results.Sum(r => r.Assertions)} assertions"
            : $"FAILED: {failed.Count} of {results.Count} files");
        foreach (var r in failed)
        {
            Out.Line("  " + r.Summary);
        }

        return failed.Count == 0 ? 0 : 1;
    }

    private static ParsedArgs ParseArgs(ReadOnlySpan<string> args)
    {
        var flags = new HashSet<string> { "--strict", "--no-undef", "--no-classic" };
        var result = new ParsedArgs();
        for (var i = 0; i < args.Length; i++)
        {
            var a = args[i];
            if (a.StartsWith("--", StringComparison.Ordinal))
            {
                var eq = a.IndexOf('=');
                if (eq > 0)
                {
                    result.Add(a[..eq], a[(eq + 1)..]);
                }
                else if (flags.Contains(a))
                {
                    result.Add(a, "true");
                }
                else
                {
                    if (i + 1 >= args.Length)
                    {
                        throw new UsageException($"option {a} needs a value");
                    }

                    result.Add(a, args[++i]);
                }
            }
            else
            {
                result.Positional.Add(a);
            }
        }

        return result;
    }

    private sealed class ParsedArgs
    {
        private readonly List<(string Key, string Value)> _options = new();

        public List<string> Positional { get; } = new();

        public void Add(string key, string value) => _options.Add((key, value));

        public bool Has(string key) => _options.Any(o => o.Key == key);

        public string? Single(string key) => _options.LastOrDefault(o => o.Key == key).Value;

        public List<string> All(string key) => _options.Where(o => o.Key == key).Select(o => o.Value).ToList();

        public double Number(string key, double fallback)
        {
            var v = Single(key);
            if (v == null)
            {
                return fallback;
            }

            if (!double.TryParse(v, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) || d <= 0)
            {
                throw new UsageException($"option {key} needs a positive number, got '{v}'");
            }

            return d;
        }

        public uint? Seed()
        {
            var v = Single("--seed");
            if (v == null)
            {
                return null;
            }

            if (!uint.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out var seed))
            {
                throw new UsageException($"option --seed needs a non-negative integer, got '{v}'");
            }

            return seed;
        }

        public void AllowOnly(params string[] keys)
        {
            foreach (var (key, _) in _options)
            {
                if (!keys.Contains(key))
                {
                    throw new UsageException($"unknown option {key}");
                }
            }
        }
    }
}

internal sealed class UsageException(string message) : Exception(message);
