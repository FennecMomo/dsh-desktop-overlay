# ============================================================================
# watch-dsh.ps1 - report whether the DSH main window is minimized or hidden,
#                 so the overlay can follow DSH (minimized -> show, restored -> hide).
#
# Prints ONE line per state change on stdout:
#     visible   - window is on screen
#     hidden    - window is minimized, or hidden (tray)
#     gone      - no matching top-level window any more
#
# Two ways to say which window to watch:
#     -TargetPid 6352                                  exact process
#     -ProcessName 'DeepSeek Harness' -ExcludePid 1234  by process name, minus our own
#
# The second form exists because the DSH host process does NOT own the window:
# the Electron main process does, and both are called "DeepSeek Harness.exe".
# The overlay shell therefore matches by process name and excludes itself.
#
# Deliberately ASCII-only: Windows PowerShell 5.1 reads .ps1 as ANSI unless the
# file carries a BOM, so non-ASCII comments would come out mangled.
#
# NOTE: the parameter must NOT be called $Pid - that is a read-only automatic
# variable in PowerShell, and binding it fails with "Cannot overwrite variable Pid".
# ============================================================================
param(
  [int]$TargetPid = 0,
  [string]$ProcessName = '',
  [int]$ExcludePid = 0,
  [switch]$Once,
  [int]$IntervalMs = 300
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Diagnostics;

public class DshWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);

  public const uint GW_OWNER = 4;
  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_TOOLWINDOW = 0x00000080;

  public static string ProcessNameOf(uint pid) {
    try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
  }

  // A titled, unowned, non-tool top-level window. When processName is given,
  // match it and skip excludePid (that is the overlay shell itself).
  public static IntPtr Find(int targetPid, string processName, int excludePid) {
    IntPtr titled = IntPtr.Zero;
    IntPtr any = IntPtr.Zero;
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      uint owner;
      GetWindowThreadProcessId(hWnd, out owner);
      if (targetPid > 0) {
        if (owner != (uint)targetPid) return true;
      } else {
        if (excludePid > 0 && owner == (uint)excludePid) return true;
        if (processName.Length > 0 &&
            !ProcessNameOf(owner).Equals(processName, StringComparison.OrdinalIgnoreCase)) return true;
      }
      if (GetWindow(hWnd, GW_OWNER) != IntPtr.Zero) return true;
      if ((GetWindowLong(hWnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return true;
      if (any == IntPtr.Zero) any = hWnd;
      if (GetWindowTextLength(hWnd) > 0) { titled = hWnd; return false; }
      return true;
    }, IntPtr.Zero);
    return titled != IntPtr.Zero ? titled : any;
  }
}
'@

function Get-State([IntPtr]$hwnd) {
  if ($hwnd -eq [IntPtr]::Zero) { return 'gone' }
  if ([DshWin]::IsIconic($hwnd)) { return 'hidden' }
  if (-not [DshWin]::IsWindowVisible($hwnd)) { return 'hidden' }
  return 'visible'
}

$hwnd = [IntPtr]::Zero
$last = ''
$goneStreak = 0

while ($true) {
  if ($hwnd -eq [IntPtr]::Zero -or -not [DshWin]::IsWindow($hwnd)) {
    $hwnd = [DshWin]::Find($TargetPid, $ProcessName, $ExcludePid)
  }

  $state = Get-State $hwnd

  if ($state -eq 'gone') {
    $goneStreak++
    # The window may simply not exist yet at startup, so require it to stay
    # gone for a while before declaring the app finished.
    if ($goneStreak -lt 10) { $state = '' }
  } else {
    $goneStreak = 0
  }

  if ($state -ne '' -and $state -ne $last) {
    $last = $state
    [Console]::Out.WriteLine($state)
    [Console]::Out.Flush()
    if ($state -eq 'gone' -or $Once) { exit 0 }
  }

  if ($Once) {
    # Only reachable when the state came out blank (window not found yet).
    [Console]::Out.WriteLine('gone')
    [Console]::Out.Flush()
    exit 0
  }

  Start-Sleep -Milliseconds $IntervalMs
}
