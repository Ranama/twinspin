using Acornima;
using Acornima.Ast;

namespace JsCheck;

/// <summary>
/// Reports identifiers that are read or written but declared nowhere (ESLint's no-undef): in a browser module
/// they throw a ReferenceError the moment that line runs. Declarations come from the parser's own scope
/// tracking (var hoisting, let/const/class blocks, params, catch params, imports); the walk only has to decide
/// which identifiers are references and keep a stack of the scopes it is inside.
/// </summary>
internal static class UndeclaredCheck
{
    public static void Run(ParsedFile file, HashSet<string> globals, List<Diagnostic> diags)
    {
        var walker = new Walker(file, globals);
        walker.Visit(file.Ast!, null);
        foreach (var name in walker.Order)
        {
            var uses = walker.Uses[name];
            var first = uses[0].Location.Start;
            var more = uses.Count > 1 ? $" ({uses.Count} uses, first shown)" : "";
            diags.Add(new Diagnostic(file.Path, first.Line, first.Column + 1, Severity.Warning,
                $"'{name}' is not defined{more}; this throws a ReferenceError when reached (declare it, import it, or list it in /* global {name} */)"));
        }
    }

    private sealed class Walker
    {
        private readonly ParsedFile _file;
        private readonly HashSet<string> _globals;
        private readonly List<HashSet<string>> _scopes = new();

        public Walker(ParsedFile file, HashSet<string> globals)
        {
            _file = file;
            _globals = globals;
        }

        public List<string> Order { get; } = new();

        public Dictionary<string, List<Identifier>> Uses { get; } = new(StringComparer.Ordinal);

        public void Visit(Node? node, Node? parent)
        {
            if (node is null)
            {
                return;
            }

            switch (node)
            {
                case Identifier id:
                    if (IsReference(id, parent))
                    {
                        Check(id);
                    }

                    return;
                case ImportDeclaration or ExportAllDeclaration or MetaProperty or BreakStatement or ContinueStatement or PrivateIdentifier:
                    return;
                case ExportNamedDeclaration { Source: not null }:
                    return;
                case UnaryExpression { Operator: Operator.TypeOf, Argument: Identifier }:
                    return; // typeof undeclaredName is legal
                case WithStatement ws:
                    // Names inside with (obj) { ... } may be properties of obj: only the object expression is checked.
                    Visit(ws.Object, ws);
                    return;
                case SwitchStatement sw:
                    // The discriminant is evaluated outside the scope of the case clauses.
                    Visit(sw.Discriminant, sw);
                    WithScope(sw, null, () =>
                    {
                        foreach (var c in sw.Cases)
                        {
                            Visit(c, sw);
                        }
                    });
                    return;
            }

            string? ownName = node switch
            {
                FunctionExpression { Id: not null } fe => fe.Id.Name,
                ClassExpression { Id: not null } ce => ce.Id.Name,
                _ => null,
            };

            WithScope(node, ownName, () =>
            {
                foreach (var child in node.ChildNodes)
                {
                    Visit(child, node);
                }
            });
        }

        private void WithScope(Node node, string? extraName, Action body)
        {
            var pushed = 0;
            if (_file.Scopes.TryGetValue(node, out var names))
            {
                _scopes.Add(names);
                pushed++;
            }

            if (extraName != null)
            {
                _scopes.Add(new HashSet<string>(StringComparer.Ordinal) { extraName });
                pushed++;
            }

            try
            {
                body();
            }
            finally
            {
                _scopes.RemoveRange(_scopes.Count - pushed, pushed);
            }
        }

        private static bool IsReference(Identifier id, Node? parent)
        {
            switch (parent)
            {
                case MemberExpression m when !m.Computed && ReferenceEquals(m.Property, id):
                    return false;
                case Property p when !p.Computed && ReferenceEquals(p.Key, id) && !ReferenceEquals(p.Value, id):
                    return false;
                case ClassProperty cp when !cp.Computed && ReferenceEquals(cp.Key, id):
                    return false;
                case LabeledStatement:
                case ImportSpecifier:
                case ImportDefaultSpecifier:
                case ImportNamespaceSpecifier:
                case ImportAttribute:
                    return false;
                case ExportSpecifier es:
                    return ReferenceEquals(es.Local, id);
                default:
                    return true;
            }
        }

        private void Check(Identifier id)
        {
            var name = id.Name;
            for (var i = _scopes.Count - 1; i >= 0; i--)
            {
                if (_scopes[i].Contains(name))
                {
                    return;
                }
            }

            if (_globals.Contains(name))
            {
                return;
            }

            if (!Uses.TryGetValue(name, out var list))
            {
                list = new List<Identifier>();
                Uses[name] = list;
                Order.Add(name);
            }

            list.Add(id);
        }
    }
}
