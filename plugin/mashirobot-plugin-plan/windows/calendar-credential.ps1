$script:CalendarCredentialTarget = 'MashiroBot/Plan/QQ-CalDAV/2768442763@qq.com'

if (-not ('MashiroBotCredentialStore' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class MashiroBotCredentialStore {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct CREDENTIAL {
    public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError=true)] private static extern void CredFree(IntPtr buffer);

  public static void Write(string target, string username, string secret) {
    byte[] bytes = Encoding.Unicode.GetBytes(secret);
    IntPtr blob = Marshal.AllocCoTaskMem(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, blob, bytes.Length);
      CREDENTIAL c = new CREDENTIAL { Type=1, TargetName=target, UserName=username, CredentialBlob=blob,
        CredentialBlobSize=(UInt32)bytes.Length, Persist=2, Comment="MashiroBot Plan QQ CalDAV" };
      if (!CredWrite(ref c, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      byte[] zero = new byte[bytes.Length];
      Marshal.Copy(zero, 0, blob, zero.Length);
      Array.Clear(bytes, 0, bytes.Length);
      Marshal.FreeCoTaskMem(blob);
    }
  }
  public static string Read(string target) {
    IntPtr ptr;
    if (!CredRead(target, 1, 0, out ptr)) return null;
    try {
      CREDENTIAL c = Marshal.PtrToStructure<CREDENTIAL>(ptr);
      if (c.CredentialBlob == IntPtr.Zero || c.CredentialBlobSize == 0) return "";
      byte[] bytes = new byte[checked((int)c.CredentialBlobSize)];
      Marshal.Copy(c.CredentialBlob, bytes, 0, bytes.Length);
      try { return Encoding.Unicode.GetString(bytes); } finally { Array.Clear(bytes, 0, bytes.Length); }
    } finally { CredFree(ptr); }
  }
}
'@
}

function Get-PlanCalendarCredential {
    return [MashiroBotCredentialStore]::Read($script:CalendarCredentialTarget)
}

function Set-PlanCalendarCredential {
    param([Parameter(Mandatory=$true)][Security.SecureString]$SecureSecret)
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureSecret)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
        [MashiroBotCredentialStore]::Write($script:CalendarCredentialTarget, '2768442763@qq.com', $plain)
    } finally {
        if ($null -ne $plain) { $plain = $null }
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
}
