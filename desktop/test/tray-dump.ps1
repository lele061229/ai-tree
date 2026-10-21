# Diagnostic dump: what top-level windows and UIA elements exist while the tray menu is up.
# ASCII-only source (PowerShell 5.1 -File parses ANSI).
param(
  [string]$Out = "$PSScriptRoot\..\test\out-local\tray-dump.json",
  [int]$WaitMs = 8000
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class Win32Enum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public static List<string> Dump() {
    var res = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var cn = new StringBuilder(256); GetClassName(h, cn, 256);
      var tx = new StringBuilder(512); GetWindowText(h, tx, 512);
      int pid; GetWindowThreadProcessId(h, out pid);
      res.Add(cn.ToString() + "\t" + tx.ToString() + "\t" + pid);
      return true;
    }, IntPtr.Zero);
    return res;
  }
  public static long Foreground() { return (long)GetForegroundWindow(); }
}
"@

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$root = $AE::RootElement

$dump = [ordered]@{ windows = @(); menu_items = @(); menu_class = @(); foreground = 0 }

function Take-Snapshot {
  $script:dump.windows = @()
  foreach ($line in [Win32Enum]::Dump()) {
    $p = $line.Split("`t")
    $script:dump.windows += [ordered]@{ class = $p[0]; title = $p[1]; pid = $p[2] }
  }
  $script:dump.foreground = [Win32Enum]::Foreground()

  $condMenu = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)
  $items = $root.FindAll($TS::Descendants, $condMenu)
  $script:dump.menu_items = @()
  foreach ($it in $items) {
    try { $script:dump.menu_items += [ordered]@{ name = $it.Current.Name; cls = $it.Current.ClassName; pid = $it.Current.ProcessId } } catch {}
  }

  $condCls = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, '#32768')
  $menus = $root.FindAll($TS::Descendants, $condCls)
  $script:dump.menu_class = @()
  foreach ($m in $menus) {
    try { $script:dump.menu_class += [ordered]@{ name = $m.Current.Name; type = $m.Current.ControlType.ProgrammaticName; pid = $m.Current.ProcessId } } catch {}
  }
}

$deadline = (Get-Date).AddMilliseconds($WaitMs)
$seen = @{}
$history = @()
while ((Get-Date) -lt $deadline) {
  Take-Snapshot
  $now = (Get-Date).ToString('HH:mm:ss.fff')
  foreach ($w in $dump.windows) {
    $k = $w.class + '|' + $w.title
    if (-not $seen.ContainsKey($k)) { $seen[$k] = $now; $history += [ordered]@{ t = $now; class = $w.class; title = $w.title; pid = $w.pid } }
  }
  if ($dump.menu_class.Count -gt 0) { break }
  Start-Sleep -Milliseconds 120
}
$dump.new_windows = @($history | Where-Object { $_.class -eq '#32768' -or $_.class -like '*menu*' -or $_.class -like '*Popup*' -or $_.title -like '*AI Tree*' })

# 任务栏按钮清单：确认托盘图标在任务栏可见，还是在「隐藏图标」里。
$dump.taskbar_buttons = @()
$dump.ai_tree_elements = @()
try {
  $condName = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'AI Tree')
  $hits = $root.FindAll($TS::Descendants, $condName)
  foreach ($h in $hits) {
    try { $dump.ai_tree_elements += [ordered]@{ type = $h.Current.ControlType.ProgrammaticName; cls = $h.Current.ClassName; aid = $h.Current.AutomationId; pid = $h.Current.ProcessId } } catch {}
  }
  $condTray = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'Shell_TrayWnd')
  $trayEl = $root.FindFirst($TS::Children, $condTray)
  if ($trayEl) {
    $condBtn2 = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    foreach ($b in $trayEl.FindAll($TS::Descendants, $condBtn2)) {
      try { $dump.taskbar_buttons += [ordered]@{ name = $b.Current.Name; cls = $b.Current.ClassName; aid = $b.Current.AutomationId } } catch {}
    }
  }
} catch {}

$json = $dump | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output $json
