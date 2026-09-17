using System.Text.Json;
using System.Windows.Forms;

namespace MashiroBot.UsageAudit;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            var options = Parse(args);
            if (options.ContainsKey("self-test")) return SelfTest(options);
            foreach (var required in new[] { "targets", "database", "node", "db-helper" })
                if (!options.ContainsKey(required)) throw new ArgumentException($"Missing --{required}");

            ApplicationConfiguration.Initialize();
            using var context = new AuditApplicationContext(
                options["targets"], options["database"], options["node"], options["db-helper"]);
            Application.Run(context);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }

    private static int SelfTest(Dictionary<string, string> options)
    {
        if (!options.TryGetValue("fixture-targets", out var manifest)) throw new ArgumentException("Missing --fixture-targets");
        var catalog = new TargetCatalog(manifest);
        var item = JsonDocument.Parse(File.ReadAllText(manifest)).RootElement;
        var array = item.ValueKind == JsonValueKind.Array ? item : item.GetProperty("targets");
        var firstPath = array.EnumerateArray().First().GetProperty("executablePath").GetString();
        var matched = catalog.Match(firstPath);
        Console.WriteLine(JsonSerializer.Serialize(new { ok = matched is not null && catalog.Count > 0, targetCount = catalog.Count }));
        return matched is null ? 1 : 0;
    }

    private static Dictionary<string, string> Parse(string[] args)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < args.Length; index++)
        {
            if (!args[index].StartsWith("--")) continue;
            var key = args[index][2..];
            if (index + 1 < args.Length && !args[index + 1].StartsWith("--")) result[key] = args[++index];
            else result[key] = "true";
        }
        return result;
    }
}

internal sealed class AuditApplicationContext : ApplicationContext
{
    private readonly ForegroundTracker _tracker;
    private readonly AuditBatchWriter _writer;
    private readonly System.Windows.Forms.Timer _timer;
    private bool _closed;

    public AuditApplicationContext(string manifest, string database, string node, string helper)
    {
        var catalog = new TargetCatalog(manifest);
        _writer = new AuditBatchWriter(node, helper, database, catalog);
        _tracker = new ForegroundTracker();
        _tracker.Observed += _writer.Observe;
        _timer = new System.Windows.Forms.Timer { Interval = 60_000 };
        _timer.Tick += (_, _) => _writer.Checkpoint(DateTimeOffset.UtcNow);
        Application.ApplicationExit += (_, _) => Close("application-exit");
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Close("process-exit");
        _tracker.Start();
        _timer.Start();
    }

    private void Close(string reason)
    {
        if (_closed) return;
        _closed = true;
        _timer.Stop();
        _writer.Close(DateTimeOffset.UtcNow, reason);
        _tracker.Dispose();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) Close("dispose");
        base.Dispose(disposing);
    }
}
