<#
.SYNOPSIS
  Opens TwinSpin on your phone: runs the local server plus a free Cloudflare quick tunnel and prints an https link
  (and a QR code to scan). Double-click tools\phone-link.cmd, or run:
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\phone-link.ps1

.DESCRIPTION
  Phones only enable the audio engine, offline mode and screen wake lock on secure (https) pages, so opening
  http://<this PC>:8100 on a phone gives a crippled app. This script:
    1. starts tools\serve.ps1 on http://localhost:<Port> (or uses the one already running there),
    2. starts "cloudflared tunnel --url http://localhost:<Port> --http-host-header localhost:<Port>", which gives a
       random https://<words>.trycloudflare.com address that forwards to this PC,
    3. prints that link big and clear with a QR code, and copies it to the clipboard.
  Stop with Enter, Ctrl+C or by closing the window: the server and the tunnel stop with it.

  The link is public while it runs (anyone who knows it can open the app; your songs stay on your phone and are
  never uploaded) and changes every time. Every new link is a new website to the phone, so its song list and
  home-screen app start fresh. For a permanent address publish the app (tools\publish-web.ps1).

  cloudflared is looked for in tools\cloudflared\ (gitignored), on the PATH and in the winget install folder. If
  it is missing, the script explains how to install it.

.PARAMETER Port
  Local port (default 8100).
.PARAMETER NoQr
  Do not print the QR code.
.PARAMETER Qr
  Only print a QR code for this text or link (for example your GitHub Pages address) and exit.

.EXAMPLE
  tools\phone-link.cmd
.EXAMPLE
  tools\phone-link.cmd -Qr https://you.github.io/twinspin/
#>
param(
  [int]$Port = 8100,
  [switch]$NoQr,
  [string]$Qr = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 1

$QrSource = @'
using System;
using System.Collections.Generic;
using System.Text;

/// <summary>Minimal QR code encoder (byte mode, versions 1-6, error correction M, or L when M does not fit).</summary>
public static class TwinSpinQr
{
    // Per version 1..6 (index 0 unused): error correction codewords per block and number of blocks.
    static readonly int[] EccM = { 0, 10, 16, 26, 18, 24, 16 };
    static readonly int[] BlocksM = { 0, 1, 1, 1, 2, 2, 4 };
    static readonly int[] EccL = { 0, 7, 10, 15, 20, 26, 18 };
    static readonly int[] BlocksL = { 0, 1, 1, 1, 1, 1, 2 };

    public static int RawCodewords(int ver)
    {
        int result = (16 * ver + 128) * ver + 64;
        if (ver >= 2)
        {
            int na = ver / 7 + 2;
            result -= (25 * na - 10) * na - 55;
            if (ver >= 7) result -= 36;
        }
        return result / 8;
    }

    static int Mul(int x, int y)
    {
        int z = 0;
        for (int i = 7; i >= 0; i--)
        {
            z = (z << 1) ^ ((z >> 7) * 0x11D);
            z ^= ((y >> i) & 1) * x;
        }
        return z;
    }

    public static byte[] RsDivisor(int degree)
    {
        var r = new byte[degree];
        r[degree - 1] = 1;
        int root = 1;
        for (int i = 0; i < degree; i++)
        {
            for (int j = 0; j < degree; j++)
            {
                r[j] = (byte)Mul(r[j], root);
                if (j + 1 < degree) r[j] ^= r[j + 1];
            }
            root = Mul(root, 0x02);
        }
        return r;
    }

    public static byte[] RsRemainder(byte[] data, byte[] div)
    {
        var r = new byte[div.Length];
        foreach (byte b in data)
        {
            int factor = b ^ r[0];
            Array.Copy(r, 1, r, 0, r.Length - 1);
            r[r.Length - 1] = 0;
            for (int i = 0; i < r.Length; i++) r[i] ^= (byte)Mul(div[i], factor);
        }
        return r;
    }

    public static int FormatBits(int eclBits, int mask)
    {
        int data = (eclBits << 3) | mask;
        int rem = data;
        for (int i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
        return ((data << 10) | rem) ^ 0x5412;
    }

    sealed class Grid
    {
        public readonly int Size;
        public readonly bool[,] Dark;   // [y, x]
        public readonly bool[,] Fixed;
        public Grid(int size) { Size = size; Dark = new bool[size, size]; Fixed = new bool[size, size]; }
        public void Set(int x, int y, bool dark) { Dark[y, x] = dark; Fixed[y, x] = true; }
    }

    static void Finder(Grid g, int cx, int cy)
    {
        for (int dy = -4; dy <= 4; dy++)
            for (int dx = -4; dx <= 4; dx++)
            {
                int x = cx + dx, y = cy + dy;
                if (x < 0 || y < 0 || x >= g.Size || y >= g.Size) continue;
                int d = Math.Max(Math.Abs(dx), Math.Abs(dy));
                g.Set(x, y, d != 2 && d != 4);
            }
    }

    static void Alignment(Grid g, int cx, int cy)
    {
        for (int dy = -2; dy <= 2; dy++)
            for (int dx = -2; dx <= 2; dx++)
                g.Set(cx + dx, cy + dy, Math.Max(Math.Abs(dx), Math.Abs(dy)) != 1);
    }

    static void DrawFormat(Grid g, int bits)
    {
        int n = g.Size;
        for (int i = 0; i <= 5; i++) g.Set(8, i, ((bits >> i) & 1) != 0);
        g.Set(8, 7, ((bits >> 6) & 1) != 0);
        g.Set(8, 8, ((bits >> 7) & 1) != 0);
        g.Set(7, 8, ((bits >> 8) & 1) != 0);
        for (int i = 9; i < 15; i++) g.Set(14 - i, 8, ((bits >> i) & 1) != 0);
        for (int i = 0; i < 8; i++) g.Set(n - 1 - i, 8, ((bits >> i) & 1) != 0);
        for (int i = 8; i < 15; i++) g.Set(8, n - 15 + i, ((bits >> i) & 1) != 0);
        g.Set(8, n - 8, true);
    }

    static bool MaskBit(int mask, int x, int y)
    {
        switch (mask)
        {
            case 0: return (x + y) % 2 == 0;
            case 1: return y % 2 == 0;
            case 2: return x % 3 == 0;
            case 3: return (x + y) % 3 == 0;
            case 4: return (x / 3 + y / 2) % 2 == 0;
            case 5: return x * y % 2 + x * y % 3 == 0;
            case 6: return (x * y % 2 + x * y % 3) % 2 == 0;
            default: return ((x + y) % 2 + x * y % 3) % 2 == 0;
        }
    }

    static void ApplyMask(Grid g, int mask)
    {
        for (int y = 0; y < g.Size; y++)
            for (int x = 0; x < g.Size; x++)
                if (!g.Fixed[y, x] && MaskBit(mask, x, y)) g.Dark[y, x] = !g.Dark[y, x];
    }

    static int Penalty(Grid g)
    {
        int n = g.Size, score = 0, dark = 0;
        for (int pass = 0; pass < 2; pass++)
        {
            for (int a = 0; a < n; a++)
            {
                int run = 0; bool prev = false;
                for (int b = 0; b < n; b++)
                {
                    bool v = pass == 0 ? g.Dark[a, b] : g.Dark[b, a];
                    if (b > 0 && v == prev) run++;
                    else { if (run >= 5) score += run - 2; run = 1; prev = v; }
                    // finder-like 1:1:3:1:1 run with four light modules before or after it
                    if (b >= 10)
                    {
                        int s = b - 10;
                        if (MatchAt(g, pass, a, s, Finderish) && MatchAt(g, pass, a, s + 7, FourLight)) score += 40;
                        if (MatchAt(g, pass, a, s, FourLight) && MatchAt(g, pass, a, s + 4, Finderish)) score += 40;
                    }
                }
                if (run >= 5) score += run - 2;
            }
        }
        for (int y = 0; y < n; y++)
            for (int x = 0; x < n; x++)
            {
                if (g.Dark[y, x]) dark++;
                if (x + 1 < n && y + 1 < n)
                {
                    bool c = g.Dark[y, x];
                    if (c == g.Dark[y, x + 1] && c == g.Dark[y + 1, x] && c == g.Dark[y + 1, x + 1]) score += 3;
                }
            }
        int total = n * n;
        int k2 = (Math.Abs(dark * 20 - total * 10) + total - 1) / total - 1;
        score += k2 * 10;
        return score;
    }

    static readonly int[] Finderish = { 1, 0, 1, 1, 1, 0, 1 };
    static readonly int[] FourLight = { 0, 0, 0, 0 };

    static bool MatchAt(Grid g, int pass, int a, int start, int[] pat)
    {
        for (int k = 0; k < pat.Length; k++)
        {
            bool v = pass == 0 ? g.Dark[a, start + k] : g.Dark[start + k, a];
            if (v != (pat[k] == 1)) return false;
        }
        return true;
    }

    /// <summary>Encodes text (UTF-8, byte mode). Returns [y, x] modules (true = dark) or null when too long.</summary>
    public static bool[,] Encode(string text, out int version, out char level)
    {
        return Encode(text, -1, out version, out level);
    }

    /// <summary>As Encode(text), with a fixed mask 0..7 (-1 = pick the best one); for tests.</summary>
    public static bool[,] Encode(string text, int forceMask, out int version, out char level)
    {
        byte[] payload = Encoding.UTF8.GetBytes(text);
        version = 0; level = 'M';
        int[] eccTable = null, blockTable = null;
        int eclBits = 0;
        for (int pass = 0; pass < 2 && version == 0; pass++)
        {
            int[] e = pass == 0 ? EccM : EccL, b = pass == 0 ? BlocksM : BlocksL;
            for (int v = 1; v <= 6; v++)
            {
                int dataCw = RawCodewords(v) - e[v] * b[v];
                if (12 + payload.Length * 8 <= dataCw * 8)
                {
                    version = v; eccTable = e; blockTable = b;
                    level = pass == 0 ? 'M' : 'L'; eclBits = pass == 0 ? 0 : 1;
                    break;
                }
            }
        }
        if (version == 0) return null;

        int raw = RawCodewords(version);
        int numBlocks = blockTable[version], blockEcc = eccTable[version];
        int dataCodewords = raw - blockEcc * numBlocks;

        // Data bits: mode 0100 (byte), 8-bit count, payload, terminator, pad to a byte, pad codewords.
        var bits = new List<bool>();
        Action<int, int> put = (value, len) => { for (int i = len - 1; i >= 0; i--) bits.Add(((value >> i) & 1) != 0); };
        put(4, 4);
        put(payload.Length, 8);
        foreach (byte pb in payload) put(pb, 8);
        int capacity = dataCodewords * 8;
        put(0, Math.Min(4, capacity - bits.Count));
        put(0, (8 - bits.Count % 8) % 8);
        for (int pad = 0xEC; bits.Count < capacity; pad ^= 0xEC ^ 0x11) put(pad, 8);
        var data = new byte[dataCodewords];
        for (int i = 0; i < bits.Count; i++) if (bits[i]) data[i >> 3] |= (byte)(0x80 >> (i & 7));

        // Split into blocks, add Reed-Solomon codewords, interleave.
        int numShort = numBlocks - raw % numBlocks;
        int shortLen = raw / numBlocks;
        byte[] div = RsDivisor(blockEcc);
        var blocks = new List<byte[]>();
        for (int i = 0, k = 0; i < numBlocks; i++)
        {
            int len = shortLen - blockEcc + (i < numShort ? 0 : 1);
            var dat = new byte[len];
            Array.Copy(data, k, dat, 0, len);
            k += len;
            var block = new byte[shortLen + 1];
            Array.Copy(dat, block, len);
            Array.Copy(RsRemainder(dat, div), 0, block, block.Length - blockEcc, blockEcc);
            blocks.Add(block);
        }
        var all = new byte[raw];
        for (int i = 0, k = 0; i < shortLen + 1; i++)
            for (int j = 0; j < numBlocks; j++)
                if (i != shortLen - blockEcc || j >= numShort) all[k++] = blocks[j][i];

        // Function patterns.
        int size = version * 4 + 17;
        var g = new Grid(size);
        for (int i = 0; i < size; i++) { g.Set(6, i, i % 2 == 0); g.Set(i, 6, i % 2 == 0); }
        Finder(g, 3, 3);
        Finder(g, size - 4, 3);
        Finder(g, 3, size - 4);
        if (version >= 2)
        {
            int na = version / 7 + 2;
            int step = (version * 4 + na * 2 + 1) / (na * 2 - 2) * 2;
            var pos = new int[na];
            pos[0] = 6;
            for (int i = na - 1, p = size - 7; i >= 1; i--, p -= step) pos[i] = p;
            for (int i = 0; i < na; i++)
                for (int j = 0; j < na; j++)
                    if (!((i == 0 && j == 0) || (i == 0 && j == na - 1) || (i == na - 1 && j == 0))) Alignment(g, pos[i], pos[j]);
        }
        DrawFormat(g, 0);   // reserve the format areas

        // Codewords in the zigzag order (two-module columns, bottom-right first, skipping the timing column).
        int bit = 0;
        for (int right = size - 1; right >= 1; right -= 2)
        {
            if (right == 6) right = 5;
            for (int vert = 0; vert < size; vert++)
                for (int j = 0; j < 2; j++)
                {
                    int x = right - j;
                    bool upward = ((right + 1) & 2) == 0;
                    int y = upward ? size - 1 - vert : vert;
                    if (!g.Fixed[y, x] && bit < all.Length * 8)
                    {
                        g.Dark[y, x] = ((all[bit >> 3] >> (7 - (bit & 7))) & 1) != 0;
                        bit++;
                    }
                }
        }

        // Pick the mask with the lowest penalty.
        int best = 0, bestScore = int.MaxValue;
        for (int m = 0; m < 8; m++)
        {
            ApplyMask(g, m);
            DrawFormat(g, FormatBits(eclBits, m));
            int s = Penalty(g);
            if (s < bestScore) { bestScore = s; best = m; }
            ApplyMask(g, m);
        }
        if (forceMask >= 0 && forceMask < 8) best = forceMask;
        ApplyMask(g, best);
        DrawFormat(g, FormatBits(eclBits, best));
        return g.Dark;
    }

    /// <summary>Text rows for a console: two modules per character with half blocks, dark = foreground.</summary>
    public static string[] ToLines(bool[,] m, int quiet)
    {
        int n = m.GetLength(0), total = n + 2 * quiet;
        var lines = new List<string>();
        for (int y = 0; y < total; y += 2)
        {
            var sb = new StringBuilder();
            for (int x = 0; x < total; x++)
            {
                bool top = At(m, x - quiet, y - quiet), bottom = At(m, x - quiet, y + 1 - quiet);
                sb.Append(top ? (bottom ? (char)0x2588 : (char)0x2580) : (bottom ? (char)0x2584 : ' '));
            }
            lines.Add(sb.ToString());
        }
        return lines.ToArray();
    }

    static bool At(bool[,] m, int x, int y)
    {
        int n = m.GetLength(0);
        return x >= 0 && y >= 0 && x < n && y < n && m[y, x];
    }
}

/// <summary>Kills the processes we start when this PowerShell process ends, even when the window is closed.</summary>
public static class TwinSpinJob
{
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits Basic;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    static IntPtr job = IntPtr.Zero;

    public static bool Add(System.Diagnostics.Process process)
    {
        try
        {
            if (job == IntPtr.Zero)
            {
                IntPtr j = CreateJobObject(IntPtr.Zero, null);
                if (j == IntPtr.Zero) return false;
                var info = new ExtendedLimits();
                info.Basic.LimitFlags = 0x2000;    // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                int len = System.Runtime.InteropServices.Marshal.SizeOf(typeof(ExtendedLimits));
                IntPtr ptr = System.Runtime.InteropServices.Marshal.AllocHGlobal(len);
                try
                {
                    System.Runtime.InteropServices.Marshal.StructureToPtr(info, ptr, false);
                    if (!SetInformationJobObject(j, 9, ptr, (uint)len)) return false;   // JobObjectExtendedLimitInformation
                }
                finally { System.Runtime.InteropServices.Marshal.FreeHGlobal(ptr); }
                job = j;
            }
            return AssignProcessToJobObject(job, process.Handle);
        }
        catch { return false; }
    }
}
'@

# ------------------------------------------------------------------------------------------------------- helpers

function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }

function Initialize-Helpers {
  if (-not ('TwinSpinQr' -as [type])) { Add-Type -TypeDefinition $QrSource -Language CSharp }
}

function Show-Qr([string]$Text) {
  try {
    Initialize-Helpers
    $version = 0; $level = [char]'M'
    $m = [TwinSpinQr]::Encode($Text, [ref]$version, [ref]$level)
    if ($null -eq $m) { Say '  (The link is too long for the QR code; type it or paste it instead.)' DarkGray; return }
    $lines = [TwinSpinQr]::ToLines($m, 2)
    $width = 0
    try { $width = [Console]::WindowWidth } catch { $width = 200 }
    if ($width -gt 0 -and $width -lt $lines[0].Length + 6) {
      Say '  (Make this window wider to see a QR code for the link.)' DarkGray
      return
    }
    foreach ($line in $lines) {
      Write-Host '    ' -NoNewline
      Write-Host $line -ForegroundColor Black -BackgroundColor White
    }
  } catch {
    Say "  (No QR code: $($_.Exception.Message))" DarkGray
  }
}

function Test-Http([string]$Url, [int]$TimeoutSec = 3) {
  try {
    $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -Method Get
    return [int]$r.StatusCode -eq 200
  } catch { return $false }
}

function Test-PortOpen([int]$P) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $ar = $client.BeginConnect('127.0.0.1', $P, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne(400)) { return $false }
    $client.EndConnect($ar)
    return $true
  } catch { return $false } finally { $client.Close() }
}

function Find-Cloudflared {
  $candidates = @(
    (Join-Path $PSScriptRoot 'cloudflared\cloudflared.exe')
  )
  foreach ($c in $candidates) { if (Test-Path -LiteralPath $c -PathType Leaf) { return $c } }
  $cmd = Get-Command cloudflared -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  foreach ($dir in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'))) {
    if (-not $dir) { continue }
    foreach ($c in @((Join-Path $dir 'cloudflared\cloudflared.exe'), (Join-Path $dir 'cloudflared.exe'))) {
      if (Test-Path -LiteralPath $c -PathType Leaf) { return $c }
    }
  }
  return $null
}

function Get-LogTail([string]$Path, [int]$Count = 8) {
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  try { return @(Get-Content -LiteralPath $Path -Tail $Count -ErrorAction Stop) } catch { return @() }
}

# ------------------------------------------------------------------------------------------------- QR-only mode

if ($Qr) {
  Say ''
  Say "  $Qr" Cyan
  Say ''
  Show-Qr $Qr
  Say ''
  exit 0
}

# ------------------------------------------------------------------------------------------------------ preflight

$Root = Split-Path $PSScriptRoot -Parent
$ServeScript = Join-Path $PSScriptRoot 'serve.ps1'
if (-not (Test-Path -LiteralPath (Join-Path $Root 'index.html'))) {
  Say "Warning: $Root\index.html is missing, so the link will show 'Not found' until the app is there." Yellow
}

$cf = Find-Cloudflared
if (-not $cf) {
  Say ''
  Say 'TwinSpin needs "cloudflared" (free, from Cloudflare) to make the https link for your phone.' Yellow
  Say 'Install it once, in any of these ways:'
  Say '  * In a terminal:   winget install --id Cloudflare.cloudflared' White
  Say '    then open a NEW window and run tools\phone-link.cmd again.'
  Say '  * Or download cloudflared-windows-amd64.exe from'
  Say '      https://github.com/cloudflare/cloudflared/releases/latest' White
  Say "    rename it to cloudflared.exe and put it in $PSScriptRoot\cloudflared\"
  Say ''
  Say 'No tunnel? On Android you can also use a USB cable: Chrome on the PC -> chrome://inspect -> Port forwarding'
  Say "  ($Port -> localhost:$Port), then open http://localhost:$Port on the phone." DarkGray
  exit 1
}

$tag = "twinspin-$PID"
$serveLog = Join-Path $env:TEMP "$tag-serve.log"
$serveErr = Join-Path $env:TEMP "$tag-serve-err.log"
$tunnelLog = Join-Path $env:TEMP "$tag-tunnel.log"
$server = $null
$tunnel = $null
$exitCode = 0

try {
  Initialize-Helpers

  # ---------------------------------------------------------------------------------------------- local server
  $local = "http://localhost:$Port/"
  if (Test-PortOpen $Port) {
    if (Test-Http "${local}manifest.webmanifest") {
      Say "Using the TwinSpin server that is already running on $local" DarkGray
    } else {
      throw "Port $Port is used by another program. Close it, or run: tools\phone-link.cmd -Port $($Port + 1)"
    }
  } else {
    Say "Starting the local server on $local ..." DarkGray
    $ps = (Get-Process -Id $PID).Path
    $server = Start-Process -FilePath $ps -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput $serveLog -RedirectStandardError $serveErr `
      -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$ServeScript`"", '-Port', $Port)
    [void][TwinSpinJob]::Add($server)
    $up = $false
    for ($i = 0; $i -lt 40 -and -not $up; $i++) {
      Start-Sleep -Milliseconds 250
      if ($server.HasExited) { break }
      $up = Test-Http "${local}manifest.webmanifest" 2
    }
    if (-not $up) {
      (Get-LogTail $serveLog) + (Get-LogTail $serveErr) | ForEach-Object { Say "  $_" DarkYellow }
      throw 'The local server did not start (see above).'
    }
  }

  # ---------------------------------------------------------------------------------------------------- tunnel
  Say "Opening the Cloudflare tunnel (using $cf) ..." DarkGray
  $tunnel = Start-Process -FilePath $cf -PassThru -WindowStyle Hidden -RedirectStandardError $tunnelLog `
    -ArgumentList @('tunnel', '--no-autoupdate', '--url', "http://localhost:$Port", '--http-host-header', "localhost:$Port")
  [void][TwinSpinJob]::Add($tunnel)

  $url = $null
  $registered = $false
  for ($i = 0; $i -lt 120 -and -not ($url -and $registered); $i++) {
    Start-Sleep -Milliseconds 500
    if ($tunnel.HasExited) { break }
    if (Test-Path -LiteralPath $tunnelLog) {
      $text = ''
      try {
        $fs = [IO.File]::Open($tunnelLog, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try { $text = (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
      } catch { }
      if (-not $url) {
        $m = [regex]::Match($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
        if ($m.Success) { $url = $m.Value }
      }
      if ($text -match 'Registered tunnel connection') { $registered = $true }
      if ($url -and -not $registered -and $i -ge 60) { break }   # link known; the connection may still be coming up
    }
  }
  if (-not $url) {
    Get-LogTail $tunnelLog 12 | ForEach-Object { Say "  $_" DarkYellow }
    if ($tunnel.HasExited) { throw 'cloudflared stopped before it made a link (see its messages above). Check the internet connection and try again.' }
    throw 'No link from cloudflared after 60 s (see its messages above). Check the internet connection and try again.'
  }
  $link = "$url/"

  # Make sure the link answers before announcing it (the tunnel can take a few seconds to route).
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $live = $false
  for ($i = 0; $i -lt 10 -and -not $live; $i++) {
    $live = Test-Http "${link}manifest.webmanifest" 4
    if (-not $live) { Start-Sleep -Milliseconds 1500 }
  }

  $copied = $false
  try { Set-Clipboard -Value $link; $copied = $true } catch { }

  # ------------------------------------------------------------------------------------------------- announce
  $bar = '=' * ([Math]::Max(60, $link.Length + 12))
  Say ''
  Say "  $bar" Green
  Say '    TwinSpin is ready for your phone. Open this link:' Green
  Say ''
  Say "        $link" Cyan
  Say ''
  if ($copied) { Say '    (It is on your clipboard too.)' DarkGray }
  if (-not $live) { Say '    The link is still warming up: if the phone says it cannot connect, wait a few seconds and reload.' Yellow }
  Say "  $bar" Green
  Say ''
  if (-not $NoQr) {
    Say '  Scan with the phone camera:' White
    Say ''
    Show-Qr $link
    Say ''
  }
  Say '  On the phone: tap "Tap to start". To add an app icon: iPhone Share -> Add to Home Screen;' Gray
  Say '  Android Chrome menu -> Add to Home screen / Install app.' Gray
  Say '  The link works while this window stays open, and anyone who has it can open the app (your songs stay' DarkGray
  Say '  on your phone). It changes every time, and each new link starts with an empty song list.' DarkGray
  Say ''
  Say '  Press Enter here (or close this window) to stop.' White

  # Wait for Enter while watching the tunnel and the server.
  $interactive = $true
  try { [void][Console]::KeyAvailable } catch { $interactive = $false }
  if (-not $interactive) {
    [void](Read-Host)
  } else {
    while ($true) {
      if ([Console]::KeyAvailable) {
        $key = [Console]::ReadKey($true)
        if ($key.Key -eq 'Enter' -or $key.Key -eq 'Escape' -or $key.Key -eq 'Q') { break }
      }
      if ($tunnel.HasExited) {
        Say ''
        Say 'The Cloudflare tunnel stopped, so the link no longer works:' Red
        Get-LogTail $tunnelLog 8 | ForEach-Object { Say "  $_" DarkYellow }
        $exitCode = 1
        break
      }
      if ($server -and $server.HasExited) {
        Say ''
        Say 'The local server stopped:' Red
        (Get-LogTail $serveLog) + (Get-LogTail $serveErr) | ForEach-Object { Say "  $_" DarkYellow }
        $exitCode = 1
        break
      }
      Start-Sleep -Milliseconds 250
    }
  }
} catch {
  Say ''
  Say "STOPPED: $($_.Exception.Message)" Red
  $exitCode = 1
} finally {
  foreach ($p in @($tunnel, $server)) {
    if ($p -and -not $p.HasExited) {
      try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; [void]$p.WaitForExit(3000) } catch { }
    }
  }
  foreach ($f in @($serveLog, $serveErr, $tunnelLog)) {
    if (Test-Path -LiteralPath $f) { try { Remove-Item -LiteralPath $f -Force -ErrorAction Stop } catch { } }
  }
  Say 'Stopped the link and the server.' DarkGray
}
exit $exitCode
