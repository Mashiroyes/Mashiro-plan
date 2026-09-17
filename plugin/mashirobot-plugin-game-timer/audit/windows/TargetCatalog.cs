using System.Text.Json;

namespace MashiroBot.UsageAudit;

public sealed record AuditTarget(string Key, string DisplayName, string Kind, string ExecutablePath);

public sealed class TargetCatalog
{
    private readonly string _manifestPath;
    private DateTime _lastWriteUtc = DateTime.MinValue;
    private Dictionary<string, AuditTarget> _targets = new(StringComparer.OrdinalIgnoreCase);

    public TargetCatalog(string manifestPath)
    {
        _manifestPath = Path.GetFullPath(manifestPath);
        Reload(force: true);
    }

    public AuditTarget? Match(string? executablePath)
    {
        if (string.IsNullOrWhiteSpace(executablePath)) return null;
        Reload(force: false);
        _targets.TryGetValue(Canonical(executablePath), out var target);
        return target;
    }

    public int Count
    {
        get { Reload(force: false); return _targets.Count; }
    }

    private void Reload(bool force)
    {
        var info = new FileInfo(_manifestPath);
        if (!info.Exists) throw new FileNotFoundException("Audit target manifest not found", _manifestPath);
        if (!force && info.LastWriteTimeUtc == _lastWriteUtc) return;
        using var document = JsonDocument.Parse(File.ReadAllText(_manifestPath));
        var root = document.RootElement;
        var items = root.ValueKind == JsonValueKind.Array ? root : root.GetProperty("targets");
        var next = new Dictionary<string, AuditTarget>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in items.EnumerateArray())
        {
            var target = new AuditTarget(
                item.GetProperty("key").GetString() ?? throw new InvalidDataException("Target key is missing"),
                item.GetProperty("displayName").GetString() ?? throw new InvalidDataException("Target displayName is missing"),
                item.TryGetProperty("kind", out var kind) ? kind.GetString() ?? "game" : "game",
                item.GetProperty("executablePath").GetString() ?? throw new InvalidDataException("Target executablePath is missing"));
            next[Canonical(target.ExecutablePath)] = target;
        }
        _targets = next;
        _lastWriteUtc = info.LastWriteTimeUtc;
    }

    private static string Canonical(string value) => Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar).ToUpperInvariant();
}
