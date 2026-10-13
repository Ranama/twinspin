using Jint;
using Jint.Runtime;
using Jint.Runtime.Modules;

namespace JsCheck;

/// <summary>
/// Module loader for <c>run</c>, resolving specifiers the way a browser does for a page served from the web
/// root: './' and '../' against the importing module, '/' against the web root, absolute URLs as they are.
/// Errors name the importing file, and an import that only works because Windows ignores letter case
/// produces a warning (it would 404 on a case-sensitive server).
/// </summary>
internal sealed class RunnerModuleLoader : IModuleLoader
{
    private readonly Uri _webRootUri;
    private readonly List<string> _loaded = new();
    private readonly Action<string> _warn;
    private readonly Dictionary<string, string?> _importers = new(StringComparer.Ordinal);
    private readonly HashSet<string> _caseWarned = new(StringComparer.OrdinalIgnoreCase);

    private static readonly ModuleParsingOptions ParsingOptions = new() { Tolerant = false };

    public RunnerModuleLoader(string webRoot, Action<string> warn)
    {
        var full = Path.GetFullPath(webRoot);
        if (!full.EndsWith(Path.DirectorySeparatorChar))
        {
            full += Path.DirectorySeparatorChar;
        }

        _webRootUri = new Uri(full, UriKind.Absolute);
        _warn = warn;
        WebRoot = full;
    }

    public string WebRoot { get; }

    /// <summary>Files loaded so far, in load order.</summary>
    public IReadOnlyList<string> LoadedFiles => _loaded;

    public ResolvedSpecifier Resolve(string? referencingModuleLocation, ModuleRequest moduleRequest)
    {
        var specifier = moduleRequest.Specifier;
        Uri? resolved = null;

        if (specifier.StartsWith("./", StringComparison.Ordinal) || specifier.StartsWith("../", StringComparison.Ordinal) || specifier is "." or "..")
        {
            resolved = new Uri(BaseUri(referencingModuleLocation), specifier);
        }
        else if (specifier.StartsWith('/') && !specifier.StartsWith("//", StringComparison.Ordinal))
        {
            resolved = new Uri(_webRootUri, specifier.TrimStart('/'));
        }
        else if (Uri.TryCreate(specifier, UriKind.Absolute, out var absolute) && absolute.Scheme.Length > 1)
        {
            resolved = absolute;
        }

        if (resolved is null)
        {
            _importers.TryAdd(specifier, referencingModuleLocation);
            return new ResolvedSpecifier(moduleRequest, specifier, null, SpecifierType.Bare);
        }

        var key = resolved.AbsoluteUri;
        _importers.TryAdd(key, referencingModuleLocation);
        return new ResolvedSpecifier(moduleRequest, key, resolved, SpecifierType.RelativeOrAbsolute);
    }

    private Uri BaseUri(string? referencingModuleLocation)
    {
        if (referencingModuleLocation is null)
        {
            return _webRootUri;
        }

        if (Uri.TryCreate(referencingModuleLocation, UriKind.Absolute, out var uri) && uri.Scheme.Length > 1)
        {
            return uri;
        }

        return Path.IsPathRooted(referencingModuleLocation) ? new Uri(Path.GetFullPath(referencingModuleLocation)) : _webRootUri;
    }

    public Module LoadModule(Engine engine, ResolvedSpecifier resolved)
    {
        var request = resolved.ModuleRequest;
        _importers.TryGetValue(resolved.Key, out var importer);
        var from = importer is null ? "" : " (imported from " + PathUtil.Display(importer) + ")";

        if (resolved.Type == SpecifierType.Bare || resolved.Uri is null)
        {
            throw new JavaScriptException(engine.Intrinsics.TypeError,
                $"Cannot import bare specifier '{request.Specifier}'{from}: only './', '../' and '/' specifiers are supported (a browser would need an import map)");
        }

        if (!resolved.Uri.IsFile)
        {
            throw new JavaScriptException(engine.Intrinsics.TypeError,
                $"Cannot import '{request.Specifier}'{from}: JsCheck only loads local files (stub network modules in the test)");
        }

        var path = resolved.Uri.LocalPath;
        if (Directory.Exists(path))
        {
            var index = Path.Combine(path, "index.js");
            var hint = File.Exists(index) ? $" (did you mean '{request.Specifier.TrimEnd('/')}/index.js'?)" : "";
            throw new JavaScriptException(engine.Intrinsics.TypeError,
                $"Cannot import '{request.Specifier}'{from}: it is a directory, and browsers do not resolve directory imports{hint}");
        }

        if (!PathUtil.FileExistsExactCase(path, out var actual))
        {
            var hint = !Path.HasExtension(path) && File.Exists(path + ".js")
                ? $" (did you mean '{request.Specifier}.js'? browsers do not add file extensions)"
                : "";
            throw new JavaScriptException(engine.Intrinsics.TypeError,
                $"Cannot find module '{request.Specifier}'{from}: no file at {PathUtil.Display(path)}{hint}");
        }

        _loaded.Add(path);
        if (actual is not null && _caseWarned.Add(path))
        {
            _warn($"warning: import '{request.Specifier}'{from} only matches '{PathUtil.Display(actual)}' when letter case is ignored; it will 404 on a case-sensitive web server");
        }

        if (request.IsBytesModule())
        {
            return ModuleFactory.BuildBytesModule(engine, resolved, File.ReadAllBytes(path));
        }

        var code = File.ReadAllText(path);
        if (request.IsJsonModule())
        {
            return ModuleFactory.BuildJsonModule(engine, resolved, code);
        }

        if (request.IsTextModule())
        {
            return ModuleFactory.BuildTextModule(engine, resolved, code);
        }

        return ModuleFactory.BuildSourceTextModule(engine, resolved, code, ParsingOptions);
    }
}
