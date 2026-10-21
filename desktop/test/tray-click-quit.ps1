# Click the real "quit" item of the AI Tree tray menu through Windows UI Automation.
#
# Preferred path: the app is started with --self-test-tray-menu, which pops up its
# real tray menu; this script then finds the menu item whose name contains "AI Tree"
# and invokes it (a real menu item click).
# Fallback path: locate the tray icon, right-click it, then find the menu item.
#
# This script only performs UI input. Process launch/verification is done by the
# Node orchestrator (test/tray-quit.cjs).
# ASCII-only source (PowerShell 5.1 -File parses ANSI).
param(
  [string]$Out = "$PSScriptRoot\..\reports\_tray-click.json",
  [int]$WaitMs = 20000
)

$ErrorActionPreference = 'Stop'
$result = [ordered]@{
  ok = $false
  stage = 'init'
  icon_found = $false
  menu_found = $false
  invoked = $false
  error = $null
  steps = @()
}

function Add-Step([string]$s) { $script:result.steps += $s }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class TrayNative {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);
}
"@

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$root = $AE::RootElement
$condMenuItem = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)

function Find-QuitItem {
  $items = $root.FindAll($TS::Descendants, $condMenuItem)
  foreach ($it in $items) {
    try {
      $nm = $it.Current.Name
      if ($nm -and $nm -like '*AI Tree*') { return $it }
    } catch {}
  }
  return $null
}

function Wait-QuitItem([int]$ms) {
  $deadline = (Get-Date).AddMilliseconds($ms)
  while ((Get-Date) -lt $deadline) {
    $it = Find-QuitItem
    if ($it) { return $it }
    Start-Sleep -Milliseconds 250
  }
  return $null
}

function Invoke-Item($it) {
  try {
    $ip = $it.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $ip.Invoke()
    Add-Step 'invoked via InvokePattern'
    return $true
  } catch {
    Add-Step ("InvokePattern failed: " + $_.Exception.Message)
    $pt = $it.GetClickablePoint()
    [TrayNative]::SetCursorPos([int]$pt.X, [int]$pt.Y) | Out-Null
    Start-Sleep -Milliseconds 150
    [TrayNative]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
    [TrayNative]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
    Add-Step 'invoked via left click'
    return $true
  }
}

try {
  # 1) Menu already popped up by the app (--self-test-tray-menu).
  $result.stage = 'find-menu'
  $target = Wait-QuitItem $WaitMs
  if ($target) {
    Add-Step ("menu item: " + $target.Current.Name)
    $result.menu_found = $true
    $result.stage = 'invoke'
    $result.invoked = (Invoke-Item $target)
    $result.stage = 'invoked'
    $result.ok = $result.invoked
  } else {
    # 2) Fallback: find tray icon, right-click, then look again.
    Add-Step 'menu not open; trying tray icon'
    $result.stage = 'find-icon'
    $condName = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'AI Tree')
    $condType = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    $condIcon = New-Object System.Windows.Automation.AndCondition($condName, $condType)
    $icon = $root.FindFirst($TS::Descendants, $condIcon)
    if (-not $icon) {
      $result.error = 'tray icon and menu item not found via UI Automation'
    } else {
      $result.icon_found = $true
      Add-Step ("icon class: " + $icon.Current.ClassName)
      $pt = $icon.GetClickablePoint()
      [TrayNative]::SetCursorPos([int]$pt.X, [int]$pt.Y) | Out-Null
      Start-Sleep -Milliseconds 150
      [TrayNative]::mouse_event(0x0008, 0, 0, 0, [IntPtr]::Zero)
      [TrayNative]::mouse_event(0x0010, 0, 0, 0, [IntPtr]::Zero)
      $target = Wait-QuitItem 6000
      if (-not $target) {
        $result.error = 'quit menu item not found'
      } else {
        $result.menu_found = $true
        $result.invoked = (Invoke-Item $target)
        $result.ok = $result.invoked
      }
    }
  }
} catch {
  $result.error = $_.Exception.Message
}

$json = $result | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output $json
