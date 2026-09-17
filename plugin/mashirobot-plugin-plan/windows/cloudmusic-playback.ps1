Set-StrictMode -Version Latest

function Initialize-CloudMusicAutomationType {
    if ('OpenClawCloudMusic.NativeMethods' -as [type]) { return }

    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace OpenClawCloudMusic {
    public static class NativeMethods {
        public const uint WM_APPCOMMAND = 0x0319;
        public const int APPCOMMAND_MEDIA_PLAY_PAUSE = 14;
        public const int SW_RESTORE = 9;
        public const ushort VK_MEDIA_PLAY_PAUSE = 0xB3;
        private const uint INPUT_KEYBOARD = 1;
        private const uint KEYEVENTF_KEYUP = 0x0002;

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT {
            public uint type;
            public INPUTUNION inputUnion;
        }

        [StructLayout(LayoutKind.Explicit, Size = 32)]
        private struct INPUTUNION {
            [FieldOffset(0)] public KEYBDINPUT keyboard;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT {
            public ushort virtualKey;
            public ushort scanCode;
            public uint flags;
            public uint time;
            public UIntPtr extraInfo;
        }

        public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hwnd, StringBuilder className, int maxCount);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hwnd);

        [DllImport("user32.dll")]
        public static extern bool ShowWindowAsync(IntPtr hwnd, int command);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint sourceThreadId, uint targetThreadId, bool attach);

        [DllImport("user32.dll")]
        private static extern bool BringWindowToTop(IntPtr hwnd);

        [DllImport("user32.dll")]
        private static extern IntPtr SetFocus(IntPtr hwnd);

        [DllImport("user32.dll")]
        public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint inputCount, INPUT[] inputs, int inputSize);

        public static IntPtr FindVisibleWindow(uint processId, string expectedClassName) {
            IntPtr result = IntPtr.Zero;
            EnumWindows((hwnd, lParam) => {
                uint ownerProcessId;
                GetWindowThreadProcessId(hwnd, out ownerProcessId);
                if (ownerProcessId != processId || !IsWindowVisible(hwnd)) return true;

                var className = new StringBuilder(256);
                GetClassName(hwnd, className, className.Capacity);
                if (String.Equals(className.ToString(), expectedClassName, StringComparison.Ordinal)) {
                    result = hwnd;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            return result;
        }

        public static void SendPlayPause(IntPtr hwnd) {
            int command = APPCOMMAND_MEDIA_PLAY_PAUSE << 16;
            SendMessage(hwnd, WM_APPCOMMAND, hwnd, new IntPtr(command));
        }

        public static void SendSystemMediaPlayPause() {
            var inputs = new INPUT[] {
                new INPUT {
                    type = INPUT_KEYBOARD,
                    inputUnion = new INPUTUNION {
                        keyboard = new KEYBDINPUT { virtualKey = VK_MEDIA_PLAY_PAUSE }
                    }
                },
                new INPUT {
                    type = INPUT_KEYBOARD,
                    inputUnion = new INPUTUNION {
                        keyboard = new KEYBDINPUT {
                            virtualKey = VK_MEDIA_PLAY_PAUSE,
                            flags = KEYEVENTF_KEYUP
                        }
                    }
                }
            };
            uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (sent != inputs.Length) {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "SendInput media key failed");
            }
        }


        public static bool ForceForeground(IntPtr hwnd) {
            IntPtr foreground = GetForegroundWindow();
            uint unused;
            uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out unused);
            uint currentThread = GetCurrentThreadId();
            bool attached = foregroundThread != 0 && foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
            try {
                ShowWindowAsync(hwnd, SW_RESTORE);
                BringWindowToTop(hwnd);
                SetFocus(hwnd);
                return SetForegroundWindow(hwnd);
            } finally {
                if (attached) AttachThreadInput(currentThread, foregroundThread, false);
            }
        }
    }

    enum EDataFlow { eRender, eCapture, eAll }
    enum ERole { eConsole, eMultimedia, eCommunications }
    [Flags] enum CLSCTX : uint { ALL = 23 }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    interface IMMDeviceEnumerator {
        int EnumAudioEndpoints(EDataFlow dataFlow, uint stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    interface IMMDevice {
        int Activate(ref Guid iid, CLSCTX clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object interfacePointer);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064")]
    interface IAudioMeterInformation {
        int GetPeakValue(out float peak);
        int GetMeteringChannelCount(out int channelCount);
        int GetChannelsPeakValues(int channelCount, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] float[] peaks);
        int QueryHardwareSupport(out int hardwareSupportMask);
    }

    public static class AudioMeter {
        private static IMMDeviceEnumerator CreateDeviceEnumerator() {
            var type = Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"));
            return (IMMDeviceEnumerator)Activator.CreateInstance(type);
        }

        public static float GetPeakValue() {
            var enumerator = CreateDeviceEnumerator();
            IMMDevice device;
            Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device));
            Guid iid = typeof(IAudioMeterInformation).GUID;
            object meterObject;
            Marshal.ThrowExceptionForHR(device.Activate(ref iid, CLSCTX.ALL, IntPtr.Zero, out meterObject));
            var meter = (IAudioMeterInformation)meterObject;
            float peak;
            Marshal.ThrowExceptionForHR(meter.GetPeakValue(out peak));
            return peak;
        }

    }
}
'@
}

function Get-CloudMusicMainWindow {
    Initialize-CloudMusicAutomationType
    foreach ($process in @(Get-Process -Name 'cloudmusic' -ErrorAction SilentlyContinue)) {
        $handle = [OpenClawCloudMusic.NativeMethods]::FindVisibleWindow(
            [uint32]$process.Id,
            'OrpheusBrowserHost'
        )
        if ($handle -ne [IntPtr]::Zero) {
            return @{ Process = $process; Handle = $handle }
        }
    }
    return $null
}

function Test-AudioOutputActive {
    param(
        [int]$DurationMilliseconds = 2400,
        [single]$MinimumPeak = 0.004
    )

    Initialize-CloudMusicAutomationType
    $deadline = [DateTime]::UtcNow.AddMilliseconds($DurationMilliseconds)
    $positiveSamples = 0
    do {
        if ([OpenClawCloudMusic.AudioMeter]::GetPeakValue() -ge $MinimumPeak) {
            $positiveSamples++
            if ($positiveSamples -ge 4) {
                return $true
            }
        }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Test-CloudMusicPlaybackActive {
    param(
        [int]$DurationMilliseconds = 2400,
        [single]$MinimumPeak = 0.004
    )

    if (-not (Get-Process -Name 'cloudmusic' -ErrorAction SilentlyContinue)) {
        return $false
    }
    return Test-AudioOutputActive `
        -DurationMilliseconds $DurationMilliseconds `
        -MinimumPeak $MinimumPeak
}

function Send-SystemMediaPlayPause {
    Initialize-CloudMusicAutomationType
    [OpenClawCloudMusic.NativeMethods]::SendSystemMediaPlayPause()
}

function Send-CloudMusicPlayPause {
    param([Parameter(Mandatory = $true)][IntPtr]$WindowHandle)

    Initialize-CloudMusicAutomationType
    [OpenClawCloudMusic.NativeMethods]::ShowWindowAsync(
        $WindowHandle,
        [OpenClawCloudMusic.NativeMethods]::SW_RESTORE
    ) | Out-Null
    [OpenClawCloudMusic.NativeMethods]::SendPlayPause($WindowHandle)
}

function Start-CloudMusicPlayback {
    param(
        [Parameter(Mandatory = $true)][string]$ExecutablePath,
        [int]$StartupTimeoutSeconds = 30,
        [int]$MaximumAttempts = 3
    )

    if (-not (Test-Path -LiteralPath $ExecutablePath)) {
        throw "CloudMusic executable not found: $ExecutablePath"
    }

    $window = Get-CloudMusicMainWindow
    if (-not $window) {
        Start-Process -FilePath $ExecutablePath | Out-Null
        $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
        do {
            Start-Sleep -Milliseconds 500
            $window = Get-CloudMusicMainWindow
        } while (-not $window -and [DateTime]::UtcNow -lt $deadline)
    }

    if (-not $window) {
        throw 'CloudMusic OrpheusBrowserHost main window did not appear.'
    }

    # Give the Chromium player time to restore the previous track after its native window appears.
    Start-Sleep -Seconds 4
    if (Test-CloudMusicPlaybackActive -DurationMilliseconds 1200) {
        return @{ Method = 'already-playing'; ProcessId = $window.Process.Id; WindowHandle = $window.Handle.ToInt64() }
    }

    for ($attempt = 1; $attempt -le $MaximumAttempts; $attempt++) {
        # A system media key does not require a background scheduled task to own the foreground.
        Send-SystemMediaPlayPause
        Start-Sleep -Seconds 2
        if (Test-CloudMusicPlaybackActive -DurationMilliseconds 5000) {
            return @{ Method = 'system-media-key'; Attempts = $attempt; ProcessId = $window.Process.Id; WindowHandle = $window.Handle.ToInt64() }
        }

        # Foreground activation is only a fallback. Windows may reject it for scheduled tasks.
        $window = Get-CloudMusicMainWindow
        if (-not $window) {
            Start-Sleep -Milliseconds 500
            continue
        }
        $foregroundFocused = [OpenClawCloudMusic.NativeMethods]::ForceForeground($window.Handle)
        if ($foregroundFocused) {
            Start-Sleep -Milliseconds 300
            $shell = New-Object -ComObject WScript.Shell
            $shell.SendKeys(' ')
            if (Test-CloudMusicPlaybackActive -DurationMilliseconds 5000) {
                return @{ Method = 'orpheus-window-space'; Attempts = $attempt; ProcessId = $window.Process.Id; WindowHandle = $window.Handle.ToInt64() }
            }
        } else {
            $foregroundStatus = 'foreground-space-skipped'
        }

        # Retain the targeted media command as a compatibility fallback for later versions.
        Send-CloudMusicPlayPause -WindowHandle $window.Handle
        if (Test-CloudMusicPlaybackActive -DurationMilliseconds 3500) {
            return @{ Method = 'targeted-media-command-fallback'; Attempts = $attempt; ProcessId = $window.Process.Id; WindowHandle = $window.Handle.ToInt64() }
        }
    }

    throw 'CloudMusic opened, but no audio output was detected after all playback attempts.'
}

