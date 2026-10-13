using System.Text;
using System.Text.RegularExpressions;

namespace JsCheck;

/// <summary>
/// Buffered UTF-8 stdout. Everything (logs, warnings, errors) goes to stdout so ordering is preserved.
/// A background timer flushes every 200 ms, so output survives if an outer harness kills a long run.
/// A thread can capture its lines instead (parallel `test` prints each file's output in one piece).
/// </summary>
internal static class Out
{
    private static readonly TextWriter Writer = CreateWriter();
    private static readonly object Gate = new();
    private static readonly Timer FlushTimer = new(_ => Flush(), null, 200, 200);

    [ThreadStatic]
    private static List<string>? _capture;

    private static TextWriter CreateWriter()
    {
        var stream = Console.OpenStandardOutput();
        return new StreamWriter(stream, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false), bufferSize: 1 << 16) { AutoFlush = false, NewLine = "\n" };
    }

    public static void Line(string text)
    {
        var capture = _capture;
        if (capture != null)
        {
            capture.Add(text);
            return;
        }

        lock (Gate)
        {
            Writer.WriteLine(text);
        }
    }

    /// <summary>From now on, lines written by the current thread are collected instead of printed.</summary>
    public static void BeginCapture() => _capture = new List<string>();

    public static List<string> EndCapture()
    {
        var lines = _capture ?? new List<string>();
        _capture = null;
        return lines;
    }

    public static void Flush()
    {
        GC.KeepAlive(FlushTimer);
        lock (Gate)
        {
            try
            {
                Writer.Flush();
            }
            catch (IOException)
            {
                // stdout closed (e.g. piped into `head`); nothing useful left to do
            }
        }
    }
}

internal static partial class PathUtil
{
    private static readonly string Cwd = Path.GetFullPath(Directory.GetCurrentDirectory());

    /// <summary>Path for humans: relative to the current directory when it lives below it, absolute otherwise; always '/'.</summary>
    public static string Display(string path)
    {
        string full;
        try
        {
            full = Path.GetFullPath(path);
        }
        catch (Exception)
        {
            return path.Replace('\\', '/');
        }

        var rel = Path.GetRelativePath(Cwd, full);
        if (!Path.IsPathRooted(rel) && rel != ".." && !rel.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal))
        {
            return rel.Replace('\\', '/');
        }

        return full.Replace('\\', '/');
    }

    [GeneratedRegex(@"file:///(?<p>[A-Za-z]:/[^\s:()'""]+)|(?<w>\b[A-Za-z]:[\\/][^\s:()'""]+)")]
    private static partial Regex AbsolutePathPattern();

    /// <summary>Rewrites file:/// URIs and absolute Windows paths inside free text (stack traces) to display paths.</summary>
    public static string PrettifyPaths(string text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return text;
        }

        return AbsolutePathPattern().Replace(text, m =>
        {
            var raw = m.Groups["p"].Success ? Uri.UnescapeDataString(m.Groups["p"].Value) : m.Groups["w"].Value;
            return Display(raw);
        });
    }

    private static readonly Dictionary<string, string[]?> DirListingCache = new(StringComparer.OrdinalIgnoreCase);

    private static string[]? ListDirectory(string dir)
    {
        lock (DirListingCache)
        {
            if (DirListingCache.TryGetValue(dir, out var cached))
            {
                return cached;
            }

            string[]? names;
            try
            {
                names = Directory.Exists(dir)
                    ? Directory.EnumerateFileSystemEntries(dir).Select(Path.GetFileName).Where(n => n != null).Select(n => n!).ToArray()
                    : null;
            }
            catch (Exception)
            {
                names = null;
            }

            DirListingCache[dir] = names;
            return names;
        }
    }

    /// <summary>
    /// Checks that <paramref name="fullPath"/> exists as a file. On case-insensitive file systems (Windows) the
    /// on-disk spelling is compared too, because the deployed web server is usually case-sensitive:
    /// <paramref name="actualPath"/> receives the real spelling when it differs only by case.
    /// </summary>
    public static bool FileExistsExactCase(string fullPath, out string? actualPath)
    {
        actualPath = null;
        if (!File.Exists(fullPath))
        {
            return false;
        }

        var root = Path.GetPathRoot(fullPath) ?? "";
        var rest = fullPath[root.Length..];
        var parts = rest.Split(new[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries);
        var current = root;
        var actual = new StringBuilder(root);
        var mismatch = false;
        foreach (var part in parts)
        {
            var names = ListDirectory(current);
            string? match = null;
            if (names != null)
            {
                match = Array.Find(names, n => string.Equals(n, part, StringComparison.Ordinal))
                        ?? Array.Find(names, n => string.Equals(n, part, StringComparison.OrdinalIgnoreCase));
            }

            match ??= part;
            if (!string.Equals(match, part, StringComparison.Ordinal))
            {
                mismatch = true;
            }

            if (actual.Length > 0 && actual[^1] != '\\' && actual[^1] != '/')
            {
                actual.Append(Path.DirectorySeparatorChar);
            }

            actual.Append(match);
            current = Path.Combine(current, match);
        }

        if (mismatch)
        {
            actualPath = actual.ToString();
        }

        return true;
    }

    /// <summary>
    /// The directory a static web server would most likely serve: the nearest directory, starting at
    /// <paramref name="startDir"/> and walking up, that contains an index.html. Null when there is none.
    /// </summary>
    public static string? FindWebRoot(string startDir)
    {
        var dir = new DirectoryInfo(Path.GetFullPath(startDir));
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "index.html")))
            {
                return dir.FullName;
            }

            if (Directory.Exists(Path.Combine(dir.FullName, ".git")))
            {
                // Do not wander out of the repository.
                return null;
            }

            dir = dir.Parent;
        }

        return null;
    }

    /// <summary>Nearest ancestor containing a .git directory, or null.</summary>
    public static string? FindRepoRoot(string startDir)
    {
        var dir = new DirectoryInfo(Path.GetFullPath(startDir));
        while (dir != null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, ".git")) || File.Exists(Path.Combine(dir.FullName, ".git")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        return null;
    }

    public static bool IsUnder(string path, string dir)
    {
        var p = Path.GetFullPath(path).TrimEnd('\\', '/');
        var d = Path.GetFullPath(dir).TrimEnd('\\', '/');
        return p.Equals(d, StringComparison.OrdinalIgnoreCase)
               || p.StartsWith(d + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
               || p.StartsWith(d + '/', StringComparison.OrdinalIgnoreCase);
    }
}
