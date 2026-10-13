using Jint;
using Jint.Native;
using Jint.Native.Object;
using Jint.Runtime;
using Jint.Runtime.Interop;
using Jint.Runtime.Modules;

namespace JsCheck;

/// <summary>Jint host that fills in import.meta like a browser does: url and resolve().</summary>
internal sealed class RunnerHost : Host
{
    public override List<KeyValuePair<JsValue, JsValue>> GetImportMetaProperties(Module moduleRecord)
    {
        var props = new List<KeyValuePair<JsValue, JsValue>>();
        var url = ModuleUrl(moduleRecord);
        if (url is null)
        {
            return props;
        }

        props.Add(new KeyValuePair<JsValue, JsValue>("url", url.AbsoluteUri));
        props.Add(new KeyValuePair<JsValue, JsValue>("resolve", new ClrFunction(Engine, "resolve", (_, args) =>
        {
            var specifier = args.Length > 0 ? TypeConverter.ToString(args[0]) : "";
            if (Uri.TryCreate(specifier, UriKind.Absolute, out var absolute) && absolute.Scheme.Length > 1)
            {
                return absolute.AbsoluteUri;
            }

            if (specifier.StartsWith("./", StringComparison.Ordinal) || specifier.StartsWith("../", StringComparison.Ordinal) || specifier.StartsWith('/'))
            {
                return new Uri(url, specifier).AbsoluteUri;
            }

            throw new JavaScriptException(Engine.Intrinsics.TypeError,
                $"import.meta.resolve: cannot resolve bare specifier '{specifier}' (no import map in JsCheck)");
        }, 1)));
        return props;
    }

    private static Uri? ModuleUrl(Module module)
    {
        var location = module.Location;
        if (string.IsNullOrEmpty(location))
        {
            return null;
        }

        if (Uri.TryCreate(location, UriKind.Absolute, out var uri) && uri.Scheme.Length > 1)
        {
            return uri;
        }

        try
        {
            return Path.IsPathRooted(location) ? new Uri(Path.GetFullPath(location)) : null;
        }
        catch (Exception)
        {
            return null;
        }
    }
}
