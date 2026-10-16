param([string]$Op, [string]$Target)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
if (-not ('AgentLayersCred' -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class AgentLayersCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist;
    public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, UInt32 type, UInt32 flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL cred, UInt32 flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredEnumerateW(string filter, UInt32 flags, out UInt32 count, out IntPtr creds);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr cred);
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) { return null; }
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      if (c.CredentialBlobSize == 0) { return ""; }
      return Marshal.PtrToStringUni(c.CredentialBlob, (int)c.CredentialBlobSize / 2);
    } finally { CredFree(p); }
  }
  public static void Write(string target, string secret) {
    byte[] bytes = Encoding.Unicode.GetBytes(secret);
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.UserName = "agent-layers"; c.Persist = 2;
    c.CredentialBlobSize = (UInt32)bytes.Length;
    c.CredentialBlob = Marshal.AllocCoTaskMem(Math.Max(bytes.Length, 1));
    try {
      Marshal.Copy(bytes, 0, c.CredentialBlob, bytes.Length);
      if (!CredWriteW(ref c, 0)) { throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
    } finally { Marshal.FreeCoTaskMem(c.CredentialBlob); }
  }
  public static bool Delete(string target) { return CredDeleteW(target, 1, 0); }
  public static string[] List(string filter) {
    UInt32 count; IntPtr p;
    List<string> names = new List<string>();
    if (!CredEnumerateW(filter, 0, out count, out p)) { return names.ToArray(); }
    try {
      for (int i = 0; i < count; i++) {
        IntPtr item = Marshal.ReadIntPtr(p, i * IntPtr.Size);
        CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(item, typeof(CREDENTIAL));
        names.Add(c.TargetName);
      }
    } finally { CredFree(p); }
    return names.ToArray();
  }
}
"@
}
switch ($Op) {
  'get' {
    $v = [AgentLayersCred]::Read($Target)
    if ($null -eq $v) { exit 3 }
    [Console]::Out.Write($v)
  }
  'getmany' {
    $names = [Console]::In.ReadToEnd() -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    $out = @{}
    foreach ($n in $names) { $v = [AgentLayersCred]::Read($n); if ($null -ne $v) { $out[$n] = $v } }
    [Console]::Out.Write(($out | ConvertTo-Json -Compress))
  }
  'set' {
    $v = [Console]::In.ReadToEnd()
    [AgentLayersCred]::Write($Target, $v)
  }
  'delete' {
    if (-not [AgentLayersCred]::Delete($Target)) { exit 3 }
  }
  'list' {
    [Console]::Out.Write(([AgentLayersCred]::List($Target) -join "`n"))
  }
  default { exit 2 }
}
