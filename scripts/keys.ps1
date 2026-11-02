# Sends key presses to the Herdr window without it being the foreground window, e.g.
#   powershell -ExecutionPolicy Bypass -File scripts/keys.ps1 -plan "ctrl c; wait 200; ctrl v"
# A step is "[ctrl] [shift] [alt] <key>", key = a letter, a digit, or enter/esc/tab/back/del/left/right/up/down/home/end;
# "wait ms" pauses. Modifiers are set in Herdr's thread's keyboard state (AttachThreadInput +
# SetKeyboardState), since a posted message alone carries no Ctrl: the app asks GetKeyState.
# Goes wherever Herdr's keyboard focus is, like a real key press; pair with scripts/mouse.ps1.
param([string]$plan)
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class K {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int p);
  [DllImport("kernel32.dll")] public static extern int GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(int a, int b, bool on);
  [DllImport("user32.dll")] public static extern bool GetKeyboardState(byte[] s);
  [DllImport("user32.dll")] public static extern bool SetKeyboardState(byte[] s);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint c, uint t);
}
"@
$h = (Get-Process herdr-app | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle
$p = 0; $tid = [K]::GetWindowThreadProcessId($h, [ref]$p); $me = [K]::GetCurrentThreadId()
$named = @{ enter = 0x0D; esc = 0x1B; tab = 0x09; back = 0x08; del = 0x2E; left = 0x25; up = 0x26; right = 0x27; down = 0x28; home = 0x24; end = 0x23 }
function L($vk, $up) {
  $sc = [K]::MapVirtualKey($vk, 0); $l = 1 -bor ($sc -shl 16)
  if ($up) { $l = $l -bor 0xC0000000 }
  [IntPtr][int64]$l
}
[void][K]::AttachThreadInput($me, $tid, $true)
try {
  foreach ($step in $plan.Split(';')) {
    $w = @($step.Trim().Split(' ') | Where-Object { $_ })
    if ($w[0] -eq 'wait') { Start-Sleep -Milliseconds ([int]$w[1]); continue }
    $mods = @(); $key = $w[-1]
    foreach ($m in $w[0..($w.Count - 2)]) { if ($w.Count -gt 1) { $mods += @{ ctrl = 0x11; shift = 0x10; alt = 0x12 }[$m] } }
    $vk = if ($named.ContainsKey($key)) { $named[$key] } else { [int][char]$key.ToUpper() }
    $s = New-Object byte[] 256; [void][K]::GetKeyboardState($s)
    foreach ($m in $mods) { $s[$m] = 0x80; if ($m -eq 0x11) { $s[0xA2] = 0x80 }; if ($m -eq 0x10) { $s[0xA0] = 0x80 }; if ($m -eq 0x12) { $s[0xA4] = 0x80 } }
    [void][K]::SetKeyboardState($s)
    $down = if ($mods -contains 0x12) { 0x104 } else { 0x100 }
    [void][K]::PostMessage($h, $down, [IntPtr]$vk, (L $vk $false))
    Start-Sleep -Milliseconds 60
    [void][K]::PostMessage($h, $down + 1, [IntPtr]$vk, (L $vk $true))
    Start-Sleep -Milliseconds 60
    foreach ($m in $mods) { $s[$m] = 0; $s[0xA2] = 0; $s[0xA0] = 0; $s[0xA4] = 0 }
    [void][K]::SetKeyboardState($s)
  }
} finally { [void][K]::AttachThreadInput($me, $tid, $false) }
