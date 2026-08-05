<#
.SYNOPSIS
  §5.8: captures the Windows desktop (or one named window) to a PNG, for the "it's a desktop app,
  Playwright can't see it" half of the screenshot feature - a Bridge-provided asset a session's
  Claude invokes directly via Bash, not an aibridge protocol call itself (the resulting PNG still
  goes to the operator via the send_file channel tool, same as a Playwright screenshot would).

.PARAMETER Out
  Absolute output path for the PNG. Should be under $env:AIBRIDGE_OUTBOX_DIR so send_file is
  allowed to pick it up - this script does not enforce that itself, the Bridge does, at send_file
  time (outbox.ts's resolveOutboxPath).

.PARAMETER WindowTitle
  Optional. A substring matched (case-insensitively) against open windows' titles. When given,
  only that window's bounds are captured; when omitted, the whole virtual screen (all monitors) is
  captured. No match -> a clear error naming what was searched for, not a silent full-screen
  fallback (that would look like it worked while showing the wrong thing).

.EXAMPLE
  screenshot-desktop.ps1 -Out C:\...\outbox\shot.png
  screenshot-desktop.ps1 -Out C:\...\outbox\shot.png -WindowTitle "Notepad"
#>
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$WindowTitle
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AibridgeWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@

function Get-CaptureBounds {
  param([string]$TitleSubstring)

  if (-not $TitleSubstring) {
    # Virtual screen bounds cover every monitor, not just the primary one.
    $left = [System.Windows.Forms.SystemInformation]::VirtualScreen.Left
    $top = [System.Windows.Forms.SystemInformation]::VirtualScreen.Top
    $width = [System.Windows.Forms.SystemInformation]::VirtualScreen.Width
    $height = [System.Windows.Forms.SystemInformation]::VirtualScreen.Height
    return @{ Left = $left; Top = $top; Width = $width; Height = $height }
  }

  $matches = New-Object System.Collections.Generic.List[object]
  $proc = [AibridgeWin32+EnumWindowsProc]{
    param($hWnd, $lParam)
    if ([AibridgeWin32]::IsWindowVisible($hWnd)) {
      $sb = New-Object System.Text.StringBuilder 256
      [void][AibridgeWin32]::GetWindowText($hWnd, $sb, 256)
      $title = $sb.ToString()
      if ($title -and $title.ToLower().Contains($TitleSubstring.ToLower())) {
        $matches.Add(@{ Handle = $hWnd; Title = $title })
      }
    }
    return $true
  }
  [void][AibridgeWin32]::EnumWindows($proc, [IntPtr]::Zero)

  if ($matches.Count -eq 0) {
    throw "no visible window title contains '$TitleSubstring'"
  }
  $target = $matches[0]
  $rect = New-Object AibridgeWin32+RECT
  [void][AibridgeWin32]::GetWindowRect($target.Handle, [ref]$rect)
  Write-Error "capturing window: $($target.Title)" -ErrorAction Continue 2>$null
  return @{ Left = $rect.Left; Top = $rect.Top; Width = ($rect.Right - $rect.Left); Height = ($rect.Bottom - $rect.Top) }
}

$bounds = Get-CaptureBounds -TitleSubstring $WindowTitle
if ($bounds.Width -le 0 -or $bounds.Height -le 0) {
  throw "resolved capture bounds are empty ($($bounds.Width)x$($bounds.Height)) - window may be minimized"
}

$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)

$outDir = Split-Path -Parent $Out
if ($outDir -and -not (Test-Path $outDir)) {
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)

$graphics.Dispose()
$bitmap.Dispose()

Write-Output "saved $($bounds.Width)x$($bounds.Height) screenshot to $Out"
