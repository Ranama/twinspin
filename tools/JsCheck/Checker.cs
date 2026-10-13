using Acornima;
using Acornima.Ast;

namespace JsCheck;

internal sealed class CheckOptions
{
    public required List<string> Paths { get; init; }
    public bool Strict { get; init; }
    public string? WebRoot { get; init; }
    public List<string> ExtraGlobals { get; init; } = new();
    public bool CheckUndeclared { get; init; } = true;
    public List<string> Excludes { get; init; } = new();

    /// <summary>Parse classic &lt;script src&gt; files (named in the web root's HTML) as scripts instead of modules.</summary>
    public bool DetectClassicScripts { get; init; } = true;
}

internal enum Severity
{
    Error,
    Warning,
}

internal sealed record Diagnostic(string File, int Line, int Column, Severity Severity, string Message);

internal static class SourceFiles
{
    private static readonly string[] AlwaysSkipped = { "node_modules" };

    /// <summary>All *.js / *.mjs files below <paramref name="dir"/>, sorted, skipping node_modules and dot-directories.</summary>
    public static IEnumerable<string> Enumerate(string dir, IReadOnlyCollection<string> excludes)
    {
        var result = new List<string>();
        var pending = new Stack<string>();
        pending.Push(Path.GetFullPath(dir));
        while (pending.Count > 0)
        {
            var current = pending.Pop();
            string[] files;
            string[] dirs;
            try
            {
                files = Directory.GetFiles(current);
                dirs = Directory.GetDirectories(current);
            }
            catch (Exception)
            {
                continue;
            }

            result.AddRange(files.Where(IsSource));
            foreach (var d in dirs)
            {
                var name = Path.GetFileName(d);
                if (name.StartsWith('.') || AlwaysSkipped.Contains(name, StringComparer.OrdinalIgnoreCase) || excludes.Contains(name, StringComparer.OrdinalIgnoreCase))
                {
                    continue;
                }

                pending.Push(d);
            }
        }

        result.Sort(StringComparer.OrdinalIgnoreCase);
        return result;
    }

    public static bool IsSource(string path) =>
        path.EndsWith(".js", StringComparison.OrdinalIgnoreCase) || path.EndsWith(".mjs", StringComparison.OrdinalIgnoreCase);
}

/// <summary>Parse result for one file plus everything the import/export and scope checks need.</summary>
internal sealed class ParsedFile
{
    public required string Path { get; init; }
    public Acornima.Ast.Program? Ast { get; set; }
    public List<ParseError> Errors { get; } = new();
    public Dictionary<Node, HashSet<string>> Scopes { get; } = new(ReferenceEqualityComparer.Instance);
    public HashSet<string> CommentGlobals { get; } = new(StringComparer.Ordinal);
    public string? ReadError { get; set; }

    /// <summary>The source text (kept for error hints).</summary>
    public string Code { get; set; } = "";

    /// <summary>True for a classic (non-module) script that an HTML page loads with &lt;script src&gt;.</summary>
    public bool IsClassic { get; init; }

    /// <summary>Names this file makes global: window.X / globalThis.X / self.X assignments, plus top-level declarations of classic scripts.</summary>
    public HashSet<string> GlobalNames { get; } = new(StringComparer.Ordinal);

    /// <summary>Names exported by this module itself (not counting 'export * from').</summary>
    public HashSet<string> OwnExports { get; } = new(StringComparer.Ordinal);

    /// <summary>Specifiers of 'export * from' (without 'as').</summary>
    public List<string> StarExportSources { get; } = new();

    public bool HasSyntaxErrors => Errors.Count > 0 || Ast is null;
}

internal static class Checker
{
    public static int Run(CheckOptions options)
    {
        var files = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in options.Paths)
        {
            IEnumerable<string> found;
            if (Directory.Exists(p))
            {
                found = SourceFiles.Enumerate(p, options.Excludes);
            }
            else if (File.Exists(p))
            {
                found = new[] { Path.GetFullPath(p) };
            }
            else
            {
                throw new UsageException($"no such file or directory: {p}");
            }

            foreach (var f in found)
            {
                if (seen.Add(f))
                {
                    files.Add(f);
                }
            }
        }

        var session = new CheckSession(options);
        session.Prepare(files);
        var diagnostics = new List<Diagnostic>();
        foreach (var file in files)
        {
            diagnostics.AddRange(session.CheckFile(file));
        }

        var fileOrder = files.Select((f, i) => (f, i)).ToDictionary(x => x.f, x => x.i, StringComparer.OrdinalIgnoreCase);
        var ordered = diagnostics
            .OrderBy(d => fileOrder.TryGetValue(d.File, out var i) ? i : int.MaxValue)
            .ThenBy(d => d.Line)
            .ThenBy(d => d.Column)
            .ToList();

        foreach (var d in ordered)
        {
            var prefix = d.Severity == Severity.Warning ? "warning: " : "";
            Out.Line($"{PathUtil.Display(d.File)}:{d.Line}:{d.Column} {prefix}{d.Message}");
        }

        var errors = ordered.Count(d => d.Severity == Severity.Error);
        var warnings = ordered.Count - errors;
        var fileWord = files.Count == 1 ? "file" : "files";
        var warningText = warnings == 0 ? "" : $", {warnings} warning{(warnings == 1 ? "" : "s")}";
        if (errors == 0)
        {
            Out.Line($"OK {files.Count} {fileWord}{warningText}");
        }
        else
        {
            var bad = ordered.Where(d => d.Severity == Severity.Error).Select(d => d.File).Distinct().Count();
            Out.Line($"FAIL {errors} error{(errors == 1 ? "" : "s")} in {bad} of {files.Count} {fileWord}{warningText}");
        }

        return errors > 0 || (options.Strict && warnings > 0) ? 1 : 0;
    }
}

internal sealed class CheckSession
{
    private readonly CheckOptions _options;
    private readonly Dictionary<string, ParsedFile> _cache = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, string> _webRoots = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, bool> _hasImportMap = new(StringComparer.OrdinalIgnoreCase);

    private readonly Dictionary<string, HashSet<string>> _classicScripts = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _sharedGlobals = new(StringComparer.Ordinal);

    public CheckSession(CheckOptions options)
    {
        _options = options;
    }

    /// <summary>
    /// Parses every file up front so that globals one file creates (window.X = ..., or top-level
    /// declarations of a classic &lt;script src&gt;) are known when another file is checked.
    /// </summary>
    public void Prepare(IEnumerable<string> files)
    {
        foreach (var file in files)
        {
            var parsed = GetParsed(file);
            _sharedGlobals.UnionWith(parsed.GlobalNames);
        }

        // Classic scripts referenced from HTML but outside the checked paths still define globals.
        foreach (var classic in _classicScripts.Values.SelectMany(s => s).ToList())
        {
            if (File.Exists(classic))
            {
                _sharedGlobals.UnionWith(GetParsed(classic).GlobalNames);
            }
        }
    }

    public List<Diagnostic> CheckFile(string path)
    {
        var diags = new List<Diagnostic>();
        var parsed = GetParsed(path);
        if (parsed.ReadError != null)
        {
            diags.Add(new Diagnostic(path, 1, 1, Severity.Error, parsed.ReadError));
            return diags;
        }

        foreach (var e in parsed.Errors)
        {
            var line = e.LineNumber > 0 ? e.LineNumber : 1;
            var col = e.LineNumber > 0 ? e.Column + 1 : 1;
            diags.Add(new Diagnostic(path, line, col, Severity.Error, "SyntaxError: " + e.Description + InvisibleCharHint(parsed.Code, line)));
        }

        if (parsed.Ast is null)
        {
            return diags;
        }

        if (!parsed.IsClassic)
        {
            CheckImports(parsed, diags);
        }

        if (_options.CheckUndeclared)
        {
            var globals = new HashSet<string>(Globals.Builtin, StringComparer.Ordinal);
            globals.UnionWith(_options.ExtraGlobals);
            globals.UnionWith(parsed.CommentGlobals);
            globals.UnionWith(_sharedGlobals);
            if (IsTestFile(path))
            {
                globals.UnionWith(Globals.TestOnly);
            }

            UndeclaredCheck.Run(parsed, globals, diags);
        }

        return diags;
    }

    // ----------------------------------------------------------------------------------------------
    // classic scripts: <script src="x.js"> without type="module" in an HTML page of the web root
    // ----------------------------------------------------------------------------------------------

    private static readonly System.Text.RegularExpressions.Regex ScriptTag = new(@"<script\b([^>]*)>", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    private static readonly System.Text.RegularExpressions.Regex SrcAttr = new(@"\bsrc\s*=\s*(?:""([^""]*)""|'([^']*)'|([^\s>]+))", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    private static readonly System.Text.RegularExpressions.Regex TypeAttr = new(@"\btype\s*=\s*(?:""([^""]*)""|'([^']*)'|([^\s>]+))", System.Text.RegularExpressions.RegexOptions.IgnoreCase);

    private bool IsClassicScript(string path)
    {
        if (!_options.DetectClassicScripts)
        {
            return false;
        }

        var root = WebRootFor(path);
        if (!_classicScripts.TryGetValue(root, out var set))
        {
            set = ScanHtmlForClassicScripts(root);
            _classicScripts[root] = set;
        }

        return set.Contains(path);
    }

    private static HashSet<string> ScanHtmlForClassicScripts(string root)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        IEnumerable<string> pages;
        try
        {
            pages = Directory.EnumerateFiles(root, "*.htm*", SearchOption.TopDirectoryOnly).ToList();
        }
        catch (Exception)
        {
            return set;
        }

        foreach (var page in pages)
        {
            string html;
            try
            {
                html = File.ReadAllText(page);
            }
            catch (Exception)
            {
                continue;
            }

            foreach (System.Text.RegularExpressions.Match tag in ScriptTag.Matches(html))
            {
                var attrs = tag.Groups[1].Value;
                var src = FirstGroup(SrcAttr.Match(attrs));
                if (src == null)
                {
                    continue;
                }

                var type = (FirstGroup(TypeAttr.Match(attrs)) ?? "").Trim().ToLowerInvariant();
                if (type is not ("" or "text/javascript" or "application/javascript" or "text/ecmascript"))
                {
                    continue; // module, importmap, json, templates ...
                }

                var cut = src.IndexOfAny(new[] { '?', '#' });
                if (cut >= 0)
                {
                    src = src[..cut];
                }

                if (src.StartsWith("//", StringComparison.Ordinal) || src.Contains(':', StringComparison.Ordinal))
                {
                    continue; // CDN / absolute URL
                }

                try
                {
                    var file = src.StartsWith('/')
                        ? Path.Combine(root, Uri.UnescapeDataString(src.TrimStart('/')))
                        : Path.Combine(Path.GetDirectoryName(page)!, Uri.UnescapeDataString(src));
                    set.Add(Path.GetFullPath(file));
                }
                catch (Exception)
                {
                    // ignore malformed src
                }
            }
        }

        return set;
    }

    private static string? FirstGroup(System.Text.RegularExpressions.Match m)
    {
        if (!m.Success)
        {
            return null;
        }

        for (var i = 1; i < m.Groups.Count; i++)
        {
            if (m.Groups[i].Success)
            {
                return m.Groups[i].Value;
            }
        }

        return null;
    }

    /// <summary>
    /// Names invisible characters on the error line that commonly cause baffling syntax errors:
    /// U+2028/U+2029 end a regex literal or comment line like a newline does, zero-width characters are
    /// not valid in identifiers.
    /// </summary>
    private static string InvisibleCharHint(string code, int lineNumber)
    {
        if (string.IsNullOrEmpty(code))
        {
            return "";
        }

        // Acornima counts U+2028/U+2029 as line breaks, so the error may be reported on the line after them:
        // look at the reported line and the one before, split on \n only.
        var lines = code.Split('\n');
        var found = new SortedSet<string>(StringComparer.Ordinal);
        for (var i = Math.Max(0, lineNumber - 2); i < Math.Min(lines.Length, lineNumber + 1); i++)
        {
            foreach (var ch in lines[i])
            {
                var name = ch switch
                {
                    (char) 0x2028 => "U+2028 LINE SEPARATOR (a line break inside regex literals and // comments; write \\u2028)",
                    (char) 0x2029 => "U+2029 PARAGRAPH SEPARATOR (a line break inside regex literals and // comments; write \\u2029)",
                    (char) 0x200B => "U+200B ZERO WIDTH SPACE",
                    (char) 0x200C => "U+200C ZERO WIDTH NON-JOINER",
                    (char) 0x200D => "U+200D ZERO WIDTH JOINER",
                    (char) 0x2060 => "U+2060 WORD JOINER",
                    _ => null,
                };
                if (name != null)
                {
                    found.Add(name);
                }
            }
        }

        return found.Count == 0 ? "" : " [hint: the code here contains invisible " + string.Join(", ", found) + "]";
    }

    private static readonly string[] TestDirectoryNames = { "test", "tests", "__tests__", "spec", "specs" };

    /// <summary>Test files and their helpers may use the JsCheck runner globals (assert, fail, test).</summary>
    private static bool IsTestFile(string path)
    {
        var name = Path.GetFileName(path);
        if (name.EndsWith(".test.js", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".test.mjs", StringComparison.OrdinalIgnoreCase)
            || name.EndsWith(".spec.js", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        var dir = Path.GetDirectoryName(path) ?? "";
        return dir.Split('\\', '/').Any(segment => TestDirectoryNames.Contains(segment, StringComparer.OrdinalIgnoreCase));
    }

    // ----------------------------------------------------------------------------------------------
    // parsing
    // ----------------------------------------------------------------------------------------------

    private ParsedFile GetParsed(string path)
    {
        var full = Path.GetFullPath(path);
        if (_cache.TryGetValue(full, out var cached))
        {
            return cached;
        }

        var parsed = Parse(full, IsClassicScript(full));
        _cache[full] = parsed;
        return parsed;
    }

    private static ParsedFile Parse(string path, bool classic)
    {
        var result = new ParsedFile { Path = path, IsClassic = classic };
        string code;
        try
        {
            code = File.ReadAllText(path);
            result.Code = code;
        }
        catch (Exception ex)
        {
            result.ReadError = $"cannot read file: {ex.Message}";
            return result;
        }

        var options = new ParserOptions
        {
            EcmaVersion = EcmaVersion.Latest,
            Tolerant = true,
            ErrorHandler = new CollectingErrorHandler(result.Errors),
            OnNode = (Node node, in OnNodeContext context) =>
            {
                if (!context.HasScope)
                {
                    return;
                }

                ref readonly var scope = ref context.Scope;
                var names = new HashSet<string>(StringComparer.Ordinal);
                foreach (var id in scope.VarVariables)
                {
                    names.Add(id.Name);
                }

                foreach (var id in scope.LexicalVariables)
                {
                    names.Add(id.Name);
                }

                foreach (var id in scope.Functions)
                {
                    names.Add(id.Name);
                }

                result.Scopes[node] = names;
            },
            OnComment = (in Comment comment) =>
            {
                if (comment.Kind != CommentKind.Block)
                {
                    return;
                }

                var content = comment.GetContent(code).ToString().Trim();
                string rest;
                if (content.StartsWith("globals ", StringComparison.Ordinal) || content.StartsWith("globals\n", StringComparison.Ordinal))
                {
                    rest = content[7..];
                }
                else if (content.StartsWith("global ", StringComparison.Ordinal) || content.StartsWith("global\n", StringComparison.Ordinal))
                {
                    rest = content[6..];
                }
                else
                {
                    return;
                }

                foreach (var item in rest.Split(new[] { ',', ' ', '\n', '\r', '\t' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    var name = item.Split(':')[0].Trim();
                    if (name.Length > 0)
                    {
                        result.CommentGlobals.Add(name);
                    }
                }
            },
        };

        try
        {
            var parser = new Parser(options);
            result.Ast = classic ? parser.ParseScript(code, path, strict: false) : parser.ParseModule(code, path);
        }
        catch (ParseErrorException ex)
        {
            result.Errors.Add(ex.Error);
            result.Ast = null;
        }

        if (result.Ast != null)
        {
            if (!classic)
            {
                CollectExports(result);
            }

            CollectGlobalNames(result);
        }

        return result;
    }

    private static readonly HashSet<string> GlobalObjectNames = new(StringComparer.Ordinal) { "window", "globalThis", "self" };

    /// <summary>window.X = ... anywhere, and (for classic scripts) every top-level declaration.</summary>
    private static void CollectGlobalNames(ParsedFile file)
    {
        foreach (var node in Descendants(file.Ast!))
        {
            if (node is AssignmentExpression { Left: MemberExpression { Object: Identifier obj, Property: Identifier prop, Computed: false } }
                && GlobalObjectNames.Contains(obj.Name))
            {
                file.GlobalNames.Add(prop.Name);
            }
        }

        if (file.IsClassic && file.Scopes.TryGetValue(file.Ast!, out var topLevel))
        {
            file.GlobalNames.UnionWith(topLevel);
        }
    }

    private sealed class CollectingErrorHandler : ParseErrorHandler
    {
        private readonly List<ParseError> _errors;

        public CollectingErrorHandler(List<ParseError> errors)
        {
            _errors = errors;
        }

        protected override void RecordError(ParseError error)
        {
            _errors.Add(error);
        }
    }

    // ----------------------------------------------------------------------------------------------
    // exports / imports
    // ----------------------------------------------------------------------------------------------

    private static string? ModuleExportName(Node? node) => node switch
    {
        Identifier id => id.Name,
        StringLiteral s => s.Value,
        _ => null,
    };

    private static void CollectExports(ParsedFile file)
    {
        foreach (var statement in file.Ast!.Body)
        {
            switch (statement)
            {
                case ExportNamedDeclaration named:
                    if (named.Declaration != null)
                    {
                        foreach (var name in DeclaredNames(named.Declaration))
                        {
                            file.OwnExports.Add(name);
                        }
                    }

                    foreach (var spec in named.Specifiers)
                    {
                        var exported = ModuleExportName(spec.Exported);
                        if (exported != null)
                        {
                            file.OwnExports.Add(exported);
                        }
                    }

                    break;
                case ExportDefaultDeclaration:
                    file.OwnExports.Add("default");
                    break;
                case ExportAllDeclaration all:
                    var asName = ModuleExportName(all.Exported);
                    if (asName != null)
                    {
                        file.OwnExports.Add(asName);
                    }
                    else
                    {
                        file.StarExportSources.Add(all.Source.Value);
                    }

                    break;
            }
        }
    }

    private static IEnumerable<string> DeclaredNames(Declaration declaration)
    {
        switch (declaration)
        {
            case VariableDeclaration v:
                foreach (var d in v.Declarations)
                {
                    foreach (var n in PatternNames(d.Id))
                    {
                        yield return n;
                    }
                }

                break;
            case FunctionDeclaration f when f.Id != null:
                yield return f.Id.Name;
                break;
            case ClassDeclaration c when c.Id != null:
                yield return c.Id.Name;
                break;
        }
    }

    private static IEnumerable<string> PatternNames(Node? pattern)
    {
        switch (pattern)
        {
            case Identifier id:
                yield return id.Name;
                break;
            case ObjectPattern o:
                foreach (var p in o.Properties)
                {
                    var target = p switch
                    {
                        Property prop => prop.Value,
                        RestElement rest => rest.Argument,
                        _ => null,
                    };
                    foreach (var n in PatternNames(target))
                    {
                        yield return n;
                    }
                }

                break;
            case ArrayPattern a:
                foreach (var e in a.Elements)
                {
                    foreach (var n in PatternNames(e))
                    {
                        yield return n;
                    }
                }

                break;
            case AssignmentPattern ap:
                foreach (var n in PatternNames(ap.Left))
                {
                    yield return n;
                }

                break;
            case RestElement r:
                foreach (var n in PatternNames(r.Argument))
                {
                    yield return n;
                }

                break;
        }
    }

    /// <summary>All names a module exports, following 'export * from' chains (default is never re-exported by *).</summary>
    private HashSet<string>? ExportedNames(string path, HashSet<string> visiting)
    {
        var file = GetParsed(path);
        if (file.HasSyntaxErrors || !visiting.Add(file.Path))
        {
            return file.HasSyntaxErrors ? null : new HashSet<string>(StringComparer.Ordinal);
        }

        var names = new HashSet<string>(file.OwnExports, StringComparer.Ordinal);
        foreach (var source in file.StarExportSources)
        {
            var target = ResolveSpecifier(file.Path, source, out _);
            if (target == null || !File.Exists(target) || !SourceFiles.IsSource(target))
            {
                continue;
            }

            var inner = ExportedNames(target, visiting);
            if (inner == null)
            {
                return null; // unknown: do not report missing names
            }

            names.UnionWith(inner.Where(n => n != "default"));
        }

        return names;
    }

    private enum SpecifierKind
    {
        Relative,
        RootAbsolute,
        External,
        Bare,
    }

    /// <summary>Maps an import specifier to a file path the way a browser maps it to a URL on a static server.</summary>
    private string? ResolveSpecifier(string importer, string specifier, out SpecifierKind kind)
    {
        var clean = specifier;
        var cut = clean.IndexOfAny(new[] { '?', '#' });
        if (cut >= 0)
        {
            clean = clean[..cut];
        }

        if (clean.StartsWith("./", StringComparison.Ordinal) || clean.StartsWith("../", StringComparison.Ordinal) || clean is "." or "..")
        {
            kind = SpecifierKind.Relative;
            return Path.GetFullPath(Path.Combine(Path.GetDirectoryName(importer)!, Uri.UnescapeDataString(clean)));
        }

        if (clean.StartsWith('/') && !clean.StartsWith("//", StringComparison.Ordinal))
        {
            kind = SpecifierKind.RootAbsolute;
            return Path.GetFullPath(Path.Combine(WebRootFor(importer), Uri.UnescapeDataString(clean.TrimStart('/'))));
        }

        if (clean.StartsWith("//", StringComparison.Ordinal) || clean.Contains(':', StringComparison.Ordinal))
        {
            kind = SpecifierKind.External; // http:, https:, data:, blob:, protocol-relative
            return null;
        }

        kind = SpecifierKind.Bare;
        return null;
    }

    private string WebRootFor(string importer)
    {
        if (_options.WebRoot != null)
        {
            return Path.GetFullPath(_options.WebRoot);
        }

        var dir = Path.GetDirectoryName(importer)!;
        if (!_webRoots.TryGetValue(dir, out var root))
        {
            root = PathUtil.FindWebRoot(dir) ?? PathUtil.FindRepoRoot(dir) ?? dir;
            _webRoots[dir] = root;
        }

        return root;
    }

    private bool HasImportMap(string importer)
    {
        var root = WebRootFor(importer);
        if (!_hasImportMap.TryGetValue(root, out var has))
        {
            has = false;
            try
            {
                foreach (var html in Directory.EnumerateFiles(root, "*.html"))
                {
                    if (File.ReadAllText(html).Contains("importmap", StringComparison.OrdinalIgnoreCase))
                    {
                        has = true;
                        break;
                    }
                }
            }
            catch (Exception)
            {
                // ignore
            }

            _hasImportMap[root] = has;
        }

        return has;
    }

    private sealed record ImportUse(string Specifier, Node SourceNode, List<(string Name, Node Node)> Names, bool Dynamic, bool NonJs);

    private static List<ImportUse> CollectImports(Acornima.Ast.Program ast)
    {
        var uses = new List<ImportUse>();
        foreach (var statement in ast.Body)
        {
            switch (statement)
            {
                case ImportDeclaration import:
                {
                    var names = new List<(string, Node)>();
                    foreach (var spec in import.Specifiers)
                    {
                        switch (spec)
                        {
                            case ImportDefaultSpecifier d:
                                names.Add(("default", d));
                                break;
                            case ImportSpecifier s:
                                var n = ModuleExportName(s.Imported);
                                if (n != null)
                                {
                                    names.Add((n, s.Imported));
                                }

                                break;
                        }
                    }

                    uses.Add(new ImportUse(import.Source.Value, import.Source, names, false, import.Attributes.Count > 0));
                    break;
                }

                case ExportNamedDeclaration { Source: not null } named:
                {
                    var names = new List<(string, Node)>();
                    foreach (var spec in named.Specifiers)
                    {
                        var n = ModuleExportName(spec.Local);
                        if (n != null)
                        {
                            names.Add((n, spec.Local));
                        }
                    }

                    uses.Add(new ImportUse(named.Source.Value, named.Source, names, false, named.Attributes.Count > 0));
                    break;
                }

                case ExportAllDeclaration all:
                    uses.Add(new ImportUse(all.Source.Value, all.Source, new List<(string, Node)>(), false, all.Attributes.Count > 0));
                    break;
            }
        }

        // Dynamic import('literal') anywhere in the file.
        foreach (var node in Descendants(ast))
        {
            if (node is ImportExpression { Source: StringLiteral lit })
            {
                uses.Add(new ImportUse(lit.Value, lit, new List<(string, Node)>(), true, false));
            }
        }

        return uses;
    }

    private static IEnumerable<Node> Descendants(Node root)
    {
        var stack = new Stack<Node>();
        stack.Push(root);
        while (stack.Count > 0)
        {
            var node = stack.Pop();
            yield return node;
            foreach (var child in node.ChildNodes)
            {
                if (child != null)
                {
                    stack.Push(child);
                }
            }
        }
    }

    private void CheckImports(ParsedFile file, List<Diagnostic> diags)
    {
        void Warn(Node at, string message)
        {
            var start = at.Location.Start;
            diags.Add(new Diagnostic(file.Path, start.Line, start.Column + 1, Severity.Warning, message));
        }

        foreach (var use in CollectImports(file.Ast!))
        {
            var spec = use.Specifier;
            var what = use.Dynamic ? "dynamic import" : "import";
            var target = ResolveSpecifier(file.Path, spec, out var kind);
            if (kind == SpecifierKind.External)
            {
                continue;
            }

            if (kind == SpecifierKind.Bare)
            {
                if (!HasImportMap(file.Path))
                {
                    Warn(use.SourceNode, $"bare {what} specifier '{spec}' cannot be resolved by a browser without an import map (use './' or '../')");
                }

                continue;
            }

            if (Directory.Exists(target))
            {
                var hint = File.Exists(Path.Combine(target!, "index.js")) ? $" (did you mean '{spec.TrimEnd('/')}/index.js'?)" : "";
                Warn(use.SourceNode, $"{what} '{spec}' points to a directory; browsers do not resolve directory imports{hint}");
                continue;
            }

            if (!PathUtil.FileExistsExactCase(target!, out var actual))
            {
                var hint = "";
                if (!Path.HasExtension(target) && File.Exists(target + ".js"))
                {
                    hint = $" (did you mean '{spec}.js'? browsers do not add file extensions)";
                }

                Warn(use.SourceNode, $"cannot resolve {what} '{spec}': no file at {PathUtil.Display(target!)}{hint}");
                continue;
            }

            if (actual != null)
            {
                Warn(use.SourceNode, $"{what} '{spec}' only matches '{PathUtil.Display(actual)}' when letter case is ignored; it will 404 on a case-sensitive web server");
            }

            if (use.Names.Count == 0 || use.NonJs || !SourceFiles.IsSource(target!))
            {
                continue;
            }

            var exported = ExportedNames(target!, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            if (exported == null)
            {
                continue; // target has syntax errors; reported on its own
            }

            foreach (var (name, node) in use.Names)
            {
                if (exported.Contains(name))
                {
                    continue;
                }

                Warn(node, $"'{spec}' does not provide an export named '{name}'{Suggest(name, exported)}");
            }
        }
    }

    private static string Suggest(string name, HashSet<string> exported)
    {
        if (exported.Count == 0)
        {
            return "; it has no exports";
        }

        var best = exported
            .Select(e => (Name: e, Distance: Levenshtein(name.ToLowerInvariant(), e.ToLowerInvariant())))
            .OrderBy(x => x.Distance)
            .First();
        if (best.Distance <= Math.Max(2, name.Length / 3))
        {
            return $" (did you mean '{best.Name}'?)";
        }

        var list = exported.OrderBy(n => n, StringComparer.Ordinal).Take(12).ToList();
        return $"; it exports: {string.Join(", ", list)}{(exported.Count > list.Count ? ", ..." : "")}";
    }

    private static int Levenshtein(string a, string b)
    {
        var prev = new int[b.Length + 1];
        var cur = new int[b.Length + 1];
        for (var j = 0; j <= b.Length; j++)
        {
            prev[j] = j;
        }

        for (var i = 1; i <= a.Length; i++)
        {
            cur[0] = i;
            for (var j = 1; j <= b.Length; j++)
            {
                var cost = a[i - 1] == b[j - 1] ? 0 : 1;
                cur[j] = Math.Min(Math.Min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
            }

            (prev, cur) = (cur, prev);
        }

        return prev[b.Length];
    }
}
