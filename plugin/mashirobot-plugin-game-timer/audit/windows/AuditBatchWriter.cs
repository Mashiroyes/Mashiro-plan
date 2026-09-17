using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace MashiroBot.UsageAudit;

public sealed class AuditBatchWriter
{
    private readonly string _nodePath;
    private readonly string _helperPath;
    private readonly string _databasePath;
    private readonly TargetCatalog _catalog;
    private AuditTarget? _currentTarget;
    private string? _currentPath;
    private DateTimeOffset? _currentStart;

    public AuditBatchWriter(string nodePath, string helperPath, string databasePath, TargetCatalog catalog)
    {
        _nodePath = nodePath;
        _helperPath = helperPath;
        _databasePath = databasePath;
        _catalog = catalog;
    }

    public void Observe(ForegroundObservation observation)
    {
        var target = _catalog.Match(observation.ExecutablePath);
        if (SameTarget(target, observation.ExecutablePath)) return;
        CloseCurrent(observation.ObservedAt, observation.Reason);
        if (target is not null && observation.ExecutablePath is not null)
        {
            _currentTarget = target;
            _currentPath = observation.ExecutablePath;
            _currentStart = observation.ObservedAt;
        }
        WriteHeartbeat(observation.ObservedAt);
    }

    public void Checkpoint(DateTimeOffset now)
    {
        if (_currentTarget is not null && _currentStart is not null && now > _currentStart)
        {
            var target = _currentTarget;
            var path = _currentPath!;
            var start = _currentStart.Value;
            Append(target, path, start, now, "checkpoint");
            _currentStart = now;
        }
        WriteHeartbeat(now);
    }

    public void Close(DateTimeOffset now, string reason)
    {
        CloseCurrent(now, reason);
        WriteHeartbeat(now);
    }

    private bool SameTarget(AuditTarget? next, string? executablePath) =>
        _currentTarget?.Key == next?.Key && string.Equals(_currentPath, executablePath, StringComparison.OrdinalIgnoreCase);

    private void CloseCurrent(DateTimeOffset endedAt, string reason)
    {
        if (_currentTarget is not null && _currentPath is not null && _currentStart is not null && endedAt > _currentStart)
            Append(_currentTarget, _currentPath, _currentStart.Value, endedAt, reason);
        _currentTarget = null;
        _currentPath = null;
        _currentStart = null;
    }

    private void Append(AuditTarget target, string executablePath, DateTimeOffset startedAt, DateTimeOffset endedAt, string reason)
    {
        var payload = new[] { new {
            targetKey = target.Key,
            displayName = target.DisplayName,
            executablePath,
            startedAt = startedAt.UtcDateTime.ToString("O"),
            endedAt = endedAt.UtcDateTime.ToString("O"),
            durationSeconds = Math.Max(0, (int)Math.Round((endedAt - startedAt).TotalSeconds)),
            closeReason = reason,
        }};
        Invoke("append64", payload);
    }

    private void WriteHeartbeat(DateTimeOffset observedAt)
    {
        Invoke("heartbeat64", new {
            workerId = "interactive",
            observedAt = observedAt.UtcDateTime.ToString("O"),
            currentTargetKey = _currentTarget?.Key,
            currentExecutablePath = _currentPath,
            currentIntervalStartedAt = _currentStart?.UtcDateTime.ToString("O"),
            workerVersion = "1",
        });
    }

    private void Invoke(string command, object payload)
    {
        var json = JsonSerializer.Serialize(payload);
        var payload64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(json));
        var start = new ProcessStartInfo(_nodePath)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
        };
        start.ArgumentList.Add(_helperPath);
        start.ArgumentList.Add(command);
        start.ArgumentList.Add(_databasePath);
        start.ArgumentList.Add(payload64);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Unable to start audit database helper");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit(15_000);
        if (!process.HasExited)
        {
            process.Kill(entireProcessTree: true);
            throw new TimeoutException("Audit database helper timed out");
        }
        if (process.ExitCode != 0) throw new InvalidOperationException($"Audit database helper failed: {stderr}{stdout}");
    }
}
