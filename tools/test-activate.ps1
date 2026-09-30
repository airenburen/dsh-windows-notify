# End-to-end check for "click the notification to come back to DSH":
# 1) locate the DSH main window, 2) minimize it, 3) trigger dsh://open (what the
# toast activation does), 4) confirm the window is restored and back in front.
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI.
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinEnum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public static List<IntPtr> VisibleTitled() {
    var found = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (IsWindowVisible(h)) {
        var sb = new StringBuilder(512);
        GetWindowTextW(h, sb, 512);
        if (sb.Length > 0) found.Add(h);
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowTextW(h, sb, 512); return sb.ToString(); }
}
"@

$procs = [System.Diagnostics.Process]::GetProcessesByName('DeepSeek Harness')
if ($procs.Count -eq 0) { throw 'DSH is not running' }
$pids = @{}
foreach ($p in $procs) { $pids[[uint32]$p.Id] = $true }

$mainWindow = [IntPtr]::Zero
foreach ($h in [WinEnum]::VisibleTitled()) {
  $owner = 0
  [void][WinEnum]::GetWindowThreadProcessId($h, [ref]$owner)
  if ($pids.ContainsKey([uint32]$owner)) { $mainWindow = $h; break }
}
if ($mainWindow -eq [IntPtr]::Zero) { throw 'DSH main window not found' }

Write-Output ("main window : 0x{0}  '{1}'" -f $mainWindow.ToString('X'), [WinEnum]::Title($mainWindow))
Write-Output ("before      : minimized={0} foreground={1}" -f [WinEnum]::IsIconic($mainWindow), ([WinEnum]::GetForegroundWindow() -eq $mainWindow))

[void][WinEnum]::ShowWindow($mainWindow, 6)   # SW_MINIMIZE
Start-Sleep -Milliseconds 900
Write-Output ("minimized   : minimized={0} foreground={1}" -f [WinEnum]::IsIconic($mainWindow), ([WinEnum]::GetForegroundWindow() -eq $mainWindow))

$sw = [System.Diagnostics.Stopwatch]::StartNew()
Start-Process 'dsh://open'
$restored = $false
while ($sw.Elapsed.TotalSeconds -lt 15) {
  Start-Sleep -Milliseconds 300
  if (-not [WinEnum]::IsIconic($mainWindow)) { $restored = $true; break }
}
$sw.Stop()
Write-Output ("after       : minimized={0} foreground={1} elapsed={2}s" -f [WinEnum]::IsIconic($mainWindow), ([WinEnum]::GetForegroundWindow() -eq $mainWindow), [math]::Round($sw.Elapsed.TotalSeconds, 1))
if ($restored) { Write-Output 'result      : PASS restored from minimized' } else { Write-Output 'result      : FAIL still minimized' }
