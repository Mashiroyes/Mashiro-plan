using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace MashiroBot.UsageAudit;

public sealed record ForegroundObservation(int ProcessId, string? ExecutablePath, DateTimeOffset ObservedAt, string Reason);

public sealed class ForegroundTracker : IDisposable
{
    private const uint EventSystemForeground = 0x0003;
    private const uint WineventOutofcontext = 0x0000;
    private readonly WinEventDelegate _callback;
    private readonly Dictionary<int, (long StartTicks, string Path)> _pathCache = new();
    private IntPtr _hook;
    private bool _paused;

    public event Action<ForegroundObservation>? Observed;

    public ForegroundTracker()
    {
        _callback = OnWinEvent;
        SystemEvents.SessionSwitch += OnSessionSwitch;
        SystemEvents.PowerModeChanged += OnPowerModeChanged;
    }

    public void Start()
    {
        _hook = SetWinEventHook(EventSystemForeground, EventSystemForeground, IntPtr.Zero, _callback, 0, 0, WineventOutofcontext);
        if (_hook == IntPtr.Zero) throw new InvalidOperationException($"SetWinEventHook failed: {Marshal.GetLastWin32Error()}");
        ObserveCurrent("startup");
    }

    public Task RunAsync(CancellationToken cancellationToken)
    {
        Start();
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        cancellationToken.Register(() => completion.TrySetResult());
        return completion.Task;
    }

    public void ObserveCurrent(string reason = "checkpoint")
    {
        if (_paused)
        {
            Observed?.Invoke(new ForegroundObservation(0, null, DateTimeOffset.UtcNow, reason));
            return;
        }
        var hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero)
        {
            Observed?.Invoke(new ForegroundObservation(0, null, DateTimeOffset.UtcNow, reason));
            return;
        }
        GetWindowThreadProcessId(hwnd, out var pidValue);
        var pid = unchecked((int)pidValue);
        Observed?.Invoke(new ForegroundObservation(pid, ResolvePath(pid), DateTimeOffset.UtcNow, reason));
    }

    private void OnWinEvent(IntPtr hook, uint eventType, IntPtr hwnd, int objectId, int childId, uint thread, uint time)
    {
        if (!_paused) ObserveCurrent("foreground-changed");
    }

    private string? ResolvePath(int pid)
    {
        if (pid <= 0) return null;
        try
        {
            using var process = Process.GetProcessById(pid);
            var startTicks = process.StartTime.ToUniversalTime().Ticks;
            if (_pathCache.TryGetValue(pid, out var cached) && cached.StartTicks == startTicks) return cached.Path;
            var executablePath = process.MainModule?.FileName;
            if (string.IsNullOrWhiteSpace(executablePath)) return null;
            executablePath = Path.GetFullPath(executablePath);
            _pathCache[pid] = (startTicks, executablePath);
            return executablePath;
        }
        catch
        {
            _pathCache.Remove(pid);
            return null;
        }
    }

    private void OnSessionSwitch(object sender, SessionSwitchEventArgs args)
    {
        if (args.Reason is SessionSwitchReason.SessionLock or SessionSwitchReason.SessionLogoff or
            SessionSwitchReason.RemoteDisconnect or SessionSwitchReason.ConsoleDisconnect)
        {
            _paused = true;
            Observed?.Invoke(new ForegroundObservation(0, null, DateTimeOffset.UtcNow, "session-locked"));
        }
        else if (args.Reason is SessionSwitchReason.SessionUnlock or SessionSwitchReason.SessionLogon or
                 SessionSwitchReason.RemoteConnect or SessionSwitchReason.ConsoleConnect)
        {
            _paused = false;
            ObserveCurrent("session-unlocked");
        }
    }

    private void OnPowerModeChanged(object sender, PowerModeChangedEventArgs args)
    {
        if (args.Mode == PowerModes.Suspend)
        {
            _paused = true;
            Observed?.Invoke(new ForegroundObservation(0, null, DateTimeOffset.UtcNow, "suspend"));
        }
        else if (args.Mode == PowerModes.Resume)
        {
            _paused = false;
            ObserveCurrent("resume");
        }
    }

    public void Dispose()
    {
        SystemEvents.SessionSwitch -= OnSessionSwitch;
        SystemEvents.PowerModeChanged -= OnPowerModeChanged;
        if (_hook != IntPtr.Zero) UnhookWinEvent(_hook);
        _hook = IntPtr.Zero;
    }

    private delegate void WinEventDelegate(IntPtr hook, uint eventType, IntPtr hwnd, int objectId, int childId, uint thread, uint time);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module, WinEventDelegate callback, uint processId, uint threadId, uint flags);
    [DllImport("user32.dll")]
    private static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
}
