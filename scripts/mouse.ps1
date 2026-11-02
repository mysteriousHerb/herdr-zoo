# Sends mouse messages to the Herdr window without moving the real cursor, e.g.
#   powershell -ExecutionPolicy Bypass -File scripts/mouse.ps1 -plan "move 400 636; down 400 636; drag 600 636; up 600 636"
# Steps: move/drag (button held)/down/up x y, in window pixels = `herdr-app shot` pixels.
# GPUI counts clicks itself: a double-click is down; up; down; up (not "dbl").
# A click only lands after hovering: "move x y; wait 300; down x y; up x y" ("wait ms").
# "wheel x y d": the wheel at x y, d = 120 per notch (positive = up). "rdown"/"rup": right button.
param([string]$plan)
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int l, t, r, b; }
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out R r);
  [StructLayout(LayoutKind.Sequential)] public struct P { public int x, y; }
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref P p);
}
"@
$h = (Get-Process herdr-app | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle
$r = New-Object W+R; [void][W]::GetClientRect($h, [ref]$r); "client $($r.r)x$($r.b)"
function L($x, $y) { [IntPtr](($y -shl 16) -bor ($x -band 0xffff)) }
foreach ($step in $plan.Split(';')) {
  $p = $step.Trim().Split(' '); $x = [int]$p[1]; $y = [int]$p[2]
  switch ($p[0]) {
    'move' { [void][W]::SendMessage($h, 0x200, [IntPtr]0, (L $x $y)) }
    'drag' { [void][W]::SendMessage($h, 0x200, [IntPtr]1, (L $x $y)) }
    'down' { [void][W]::SendMessage($h, 0x201, [IntPtr]1, (L $x $y)) }
    'dbl'  { [void][W]::SendMessage($h, 0x203, [IntPtr]1, (L $x $y)) }
    'wheel' { $pt = New-Object W+P; $pt.x = $x; $pt.y = $y; [void][W]::ClientToScreen($h, [ref]$pt); $d = [int]$p[3]; [void][W]::SendMessage($h, 0x20A, [IntPtr](($d -band 0xffff) -shl 16), (L $pt.x $pt.y)) }
    'wait' { Start-Sleep -Milliseconds $x }
    'up'   { [void][W]::SendMessage($h, 0x202, [IntPtr]0, (L $x $y)) }
    'rdown' { [void][W]::SendMessage($h, 0x204, [IntPtr]2, (L $x $y)) }
    'rup'   { [void][W]::SendMessage($h, 0x205, [IntPtr]0, (L $x $y)) }
  }
  Start-Sleep -Milliseconds 20
}
