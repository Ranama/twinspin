<#
.SYNOPSIS
  Renders the TwinSpin app icons into icons\ (Windows PowerShell 5.1, System.Drawing; no other tools needed).

.DESCRIPTION
  The icon is an iridescent CD (rainbow sweep with a metallic sheen, two light beams and a clear hub) with a
  dark centre label carrying the twin-disc mark (deck A blue and deck B orange discs), on the #0b0c12 background.

  Writes:
    icons\icon-192.png            any      rounded dark tile, transparent corners
    icons\icon-512.png            any      rounded dark tile, transparent corners
    icons\icon-maskable-512.png   maskable full-bleed and opaque, artwork inside the central 80 % safe circle
    icons\apple-touch-icon.png    180 px   full-bleed and opaque (iOS rounds the corners itself)
    icons\favicon-32.png          32 px    small tab icon for browsers without SVG favicons
    icons\icon.svg                         the same design as a hand-written SVG (favicon and manifest)

  Pixels are shaded analytically in a small C# helper (compiled once per run with Add-Type) with 6 x 6 supersampling,
  so every edge is antialiased and the result does not depend on GDI+ drawing quirks.

.PARAMETER Out
  Output folder (default: icons\ next to this tools\ folder).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-icons.ps1
#>
[CmdletBinding()]
param([string]$Out = '')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 1

Add-Type -AssemblyName System.Drawing

if (-not ('TwinSpinIcon' -as [type])) {
  Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class TwinSpinIcon
{
    // Colours (sRGB 0..1)
    static readonly double[] Bg = Hex(0x0b0c12);
    static readonly double[] BgLift = Hex(0x181b2a);
    static readonly double[] DeckA = Hex(0x3da5ff);
    static readonly double[] DeckB = Hex(0xff8a2a);
    static readonly double[] Silver = Hex(0xd9dce8);
    static readonly double[] Label = Hex(0x10121b);
    static readonly double[] LabelLift = Hex(0x1c1f2d);
    static readonly double[] Line = Hex(0x2b2e3c);

    static double[] Hex(int rgb)
    {
        return new double[] { ((rgb >> 16) & 255) / 255.0, ((rgb >> 8) & 255) / 255.0, (rgb & 255) / 255.0 };
    }

    static double Clamp01(double v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
    static double Smooth(double a, double b, double x) { double t = Clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }

    static double[] Hsv(double h, double s, double v)
    {
        h = h - Math.Floor(h);
        double i = Math.Floor(h * 6), f = h * 6 - i;
        double p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
        switch ((int)i % 6)
        {
            case 0: return new double[] { v, t, p };
            case 1: return new double[] { q, v, p };
            case 2: return new double[] { p, v, t };
            case 3: return new double[] { p, q, v };
            case 4: return new double[] { t, p, v };
            default: return new double[] { v, p, q };
        }
    }

    static void Over(double[] dst, ref double dstA, double[] c, double a)
    {
        // "source over" on premultiplied dst (dst holds premultiplied colour)
        for (int k = 0; k < 3; k++) dst[k] = c[k] * a + dst[k] * (1 - a);
        dstA = a + dstA * (1 - a);
    }

    static double[] Mix(double[] a, double[] b, double t)
    {
        return new double[] { a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t };
    }

    // Iridescent data-side colour at polar position (theta from +x axis, clockwise because y points down; rn = r/R)
    static double[] Iridescent(double theta, double rn)
    {
        double turn = theta / (2 * Math.PI);
        double hue = turn + 0.62 + 0.10 * rn;                    // full rainbow sweep with a slight swirl
        double[] c = Hsv(hue, 0.78, 1.0);
        c = Mix(c, Silver, 0.18);                                 // metallic base
        double beam = Math.Cos(2 * (theta + Math.PI / 4));        // light from the top-left and bottom-right
        double diffuse = 0.80 + 0.20 * beam;
        for (int k = 0; k < 3; k++) c[k] *= diffuse;
        double spec = Math.Pow(Math.Max(0, beam), 18) * 0.75 + Math.Pow(Math.Max(0, beam), 4) * 0.12;
        c = Mix(c, new double[] { 1, 1, 1 }, Clamp01(spec));
        double fade = 0.86 + 0.14 * Smooth(0.46, 0.75, rn);        // a touch darker near the hub
        for (int k = 0; k < 3; k++) c[k] *= fade;
        return c;
    }

    // Shades one sample. x, y in icon units (0..1, origin top-left). Returns premultiplied rgb + alpha.
    // mode 0: rounded tile with transparent corners; 1: full-bleed opaque square.
    static void Shade(double x, double y, int mode, double discR, double[] outc, out double outA)
    {
        double[] c = new double[] { 0, 0, 0 };
        double a = 0;
        double cx = x - 0.5, cy = y - 0.5;

        // 1. background tile
        bool inside = true;
        if (mode == 0)
        {
            double rr = 0.225, hw = 0.5;
            double qx = Math.Abs(cx) - (hw - rr), qy = Math.Abs(cy) - (hw - rr);
            double d = Math.Sqrt(Math.Max(qx, 0) * Math.Max(qx, 0) + Math.Max(qy, 0) * Math.Max(qy, 0)) - rr;
            inside = d <= 0;
        }
        if (inside)
        {
            double rb = Math.Sqrt(cx * cx + (cy + 0.04) * (cy + 0.04)) / 0.62;
            Over(c, ref a, Mix(BgLift, Bg, Smooth(0.0, 1.0, rb)), 1.0);
        }

        double r = Math.Sqrt(cx * cx + cy * cy);
        double rn = r / discR;
        double theta = Math.Atan2(cy, cx);

        // 2. soft iridescent halo around the disc
        if (rn > 1.0 && rn < 1.16)
        {
            double t = (rn - 1.0) / 0.16;
            double ha = 0.30 * (1 - t) * (1 - t);
            if (mode == 0 && !inside) ha = 0;
            Over(c, ref a, Hsv(theta / (2 * Math.PI) + 0.62 + 0.1, 0.85, 1.0), ha);
        }

        if (rn <= 1.0)
        {
            double[] d;
            if (rn > 0.968)
            {
                // outer rim: bright edge with a darker lip
                double t = (rn - 0.968) / 0.032;
                d = Mix(Iridescent(theta, rn), Silver, 0.55);
                double k = 1.0 - 0.45 * Smooth(0.55, 1.0, t);
                d = new double[] { d[0] * k, d[1] * k, d[2] * k };
            }
            else if (rn > 0.47)
            {
                d = Iridescent(theta, rn);
                // two faint track-boundary rings
                double ring = Math.Max(Math.Exp(-Math.Pow((rn - 0.66) / 0.007, 2)), Math.Exp(-Math.Pow((rn - 0.83) / 0.007, 2)));
                double k = 1.0 - 0.22 * ring;
                d = new double[] { d[0] * k, d[1] * k, d[2] * k };
            }
            else if (rn > 0.405)
            {
                // clear plastic hub ring
                double t = (rn - 0.405) / 0.065;
                d = Mix(Hex(0x2a2e3e), Hex(0x3d4256), t);
                double beam = Math.Cos(2 * (theta + Math.PI / 4));
                d = Mix(d, new double[] { 1, 1, 1 }, 0.10 * Math.Pow(Math.Max(0, beam), 6));
                if (t > 0.88) d = Mix(d, Silver, 0.35);         // bright inner lip of the data area
            }
            else if (rn > 0.385)
            {
                d = Line;                                        // label outline
            }
            else
            {
                // dark label with the twin-disc mark
                d = Mix(LabelLift, Label, Smooth(0.0, 0.39, Math.Sqrt(cx * cx + (cy + 0.05 * discR) * (cy + 0.05 * discR)) / discR));
                double s = discR;
                double ax = cx + 0.112 * s, ay = cy + 0.112 * s;   // deck A: upper left
                double bx = cx - 0.112 * s, by = cy - 0.112 * s;   // deck B: lower right
                double ra = Math.Sqrt(ax * ax + ay * ay) / s, rb2 = Math.Sqrt(bx * bx + by * by) / s;
                const double markR = 0.178, holeR = 0.038;
                bool inA = ra <= markR, inB = rb2 <= markR;
                if (inA && inB) d = Mix(Mix(DeckA, DeckB, 0.5), new double[] { 1, 1, 1 }, 0.62);
                else if (inA) d = DeckA;
                else if (inB) d = DeckB;
                if ((inA && ra <= holeR) || (inB && rb2 <= holeR)) d = Label;
            }
            Over(c, ref a, d, 1.0);
        }

        if (mode == 0 && !inside) { c[0] = c[1] = c[2] = 0; a = 0; }
        outc[0] = c[0]; outc[1] = c[1]; outc[2] = c[2];
        outA = a;
    }

    /// <summary>Renders one icon. mode 0 = rounded tile (transparent corners), 1 = full-bleed opaque.</summary>
    public static Bitmap Render(int size, int mode, double discR, int ss)
    {
        var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        var data = bmp.LockBits(new Rectangle(0, 0, size, size), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        var row = new byte[size * 4];
        var c = new double[3];
        try
        {
            for (int py = 0; py < size; py++)
            {
                for (int px = 0; px < size; px++)
                {
                    double sr = 0, sg = 0, sb = 0, sa = 0;
                    for (int j = 0; j < ss; j++)
                    {
                        for (int i = 0; i < ss; i++)
                        {
                            double x = (px + (i + 0.5) / ss) / size, y = (py + (j + 0.5) / ss) / size;
                            double a;
                            Shade(x, y, mode, discR, c, out a);
                            sr += c[0]; sg += c[1]; sb += c[2]; sa += a;
                        }
                    }
                    double n = ss * ss;
                    sr /= n; sg /= n; sb /= n; sa /= n;
                    if (mode == 1) sa = 1;
                    double ia = sa > 1e-6 ? 1.0 / sa : 0;           // un-premultiply for GDI+ (straight alpha)
                    int o = px * 4;
                    row[o + 0] = (byte)Math.Round(Clamp01(sb * ia) * 255);
                    row[o + 1] = (byte)Math.Round(Clamp01(sg * ia) * 255);
                    row[o + 2] = (byte)Math.Round(Clamp01(sr * ia) * 255);
                    row[o + 3] = (byte)Math.Round(Clamp01(sa) * 255);
                }
                Marshal.Copy(row, 0, data.Scan0 + py * data.Stride, row.Length);
            }
        }
        finally { bmp.UnlockBits(data); }
        return bmp;
    }

    /// <summary>
    /// Saves as PNG with per-row adaptive filtering (GDI+ writes unfiltered rows, about twice the size for smooth
    /// gradients). Opaque icons are written as 24-bit RGB without an alpha channel (iOS wants that for
    /// apple-touch-icon); the others as 32-bit RGBA.
    /// </summary>
    public static void Save(Bitmap bmp, string path, bool opaque)
    {
        int w = bmp.Width, h = bmp.Height, bpp = opaque ? 3 : 4;
        var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        int stride = data.Stride;
        var raw = new byte[h * stride];
        try { Marshal.Copy(data.Scan0, raw, 0, raw.Length); }
        finally { bmp.UnlockBits(data); }

        int rowLen = w * bpp;
        var prev = new byte[rowLen];
        var cur = new byte[rowLen];
        var trial = new byte[5][];
        for (int k = 0; k < 5; k++) trial[k] = new byte[rowLen];
        var scan = new System.IO.MemoryStream();
        for (int y = 0; y < h; y++)
        {
            for (int x = 0; x < w; x++)
            {
                int s = y * stride + x * 4, d = x * bpp;          // GDI+ memory order is B, G, R, A
                cur[d] = raw[s + 2]; cur[d + 1] = raw[s + 1]; cur[d + 2] = raw[s];
                if (!opaque) cur[d + 3] = raw[s + 3];
            }
            int best = 0; long bestSum = long.MaxValue;
            for (int f = 0; f < 5; f++)
            {
                long sum = 0;
                for (int i = 0; i < rowLen; i++)
                {
                    int left = i >= bpp ? cur[i - bpp] : 0, up = prev[i], ul = i >= bpp ? prev[i - bpp] : 0;
                    int pred;
                    switch (f)
                    {
                        case 0: pred = 0; break;
                        case 1: pred = left; break;
                        case 2: pred = up; break;
                        case 3: pred = (left + up) >> 1; break;
                        default:
                            int p = left + up - ul, pa = Math.Abs(p - left), pb = Math.Abs(p - up), pc = Math.Abs(p - ul);
                            pred = (pa <= pb && pa <= pc) ? left : (pb <= pc ? up : ul);
                            break;
                    }
                    byte v = (byte)(cur[i] - pred);
                    trial[f][i] = v;
                    sum += v < 128 ? v : 256 - v;
                }
                if (sum < bestSum) { bestSum = sum; best = f; }
            }
            scan.WriteByte((byte)best);
            scan.Write(trial[best], 0, rowLen);
            var t = prev; prev = cur; cur = t;
        }

        byte[] filtered = scan.ToArray();
        var z = new System.IO.MemoryStream();
        z.WriteByte(0x78); z.WriteByte(0xDA);
        using (var def = new System.IO.Compression.DeflateStream(z, System.IO.Compression.CompressionLevel.Optimal, true))
            def.Write(filtered, 0, filtered.Length);
        uint a1 = 1, a2 = 0;
        foreach (byte b in filtered) { a1 = (a1 + b) % 65521; a2 = (a2 + a1) % 65521; }
        uint adler = (a2 << 16) | a1;
        z.WriteByte((byte)(adler >> 24)); z.WriteByte((byte)(adler >> 16)); z.WriteByte((byte)(adler >> 8)); z.WriteByte((byte)adler);

        using (var file = new System.IO.FileStream(path, System.IO.FileMode.Create, System.IO.FileAccess.Write))
        {
            file.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }, 0, 8);
            var ihdr = new byte[13];
            Be32(ihdr, 0, (uint)w); Be32(ihdr, 4, (uint)h);
            ihdr[8] = 8; ihdr[9] = (byte)(opaque ? 2 : 6); ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
            Chunk(file, "IHDR", ihdr);
            Chunk(file, "IDAT", z.ToArray());
            Chunk(file, "IEND", new byte[0]);
        }
    }

    static void Be32(byte[] buf, int at, uint v)
    {
        buf[at] = (byte)(v >> 24); buf[at + 1] = (byte)(v >> 16); buf[at + 2] = (byte)(v >> 8); buf[at + 3] = (byte)v;
    }

    static uint[] crcTable;

    static void Chunk(System.IO.Stream s, string type, byte[] body)
    {
        if (crcTable == null)
        {
            crcTable = new uint[256];
            for (uint n = 0; n < 256; n++)
            {
                uint c = n;
                for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
                crcTable[n] = c;
            }
        }
        var head = new byte[8];
        Be32(head, 0, (uint)body.Length);
        for (int i = 0; i < 4; i++) head[4 + i] = (byte)type[i];
        uint crc = 0xFFFFFFFFu;
        for (int i = 4; i < 8; i++) crc = crcTable[(crc ^ head[i]) & 255] ^ (crc >> 8);
        foreach (byte b in body) crc = crcTable[(crc ^ b) & 255] ^ (crc >> 8);
        crc ^= 0xFFFFFFFFu;
        var tail = new byte[4];
        Be32(tail, 0, crc);
        s.Write(head, 0, 8);
        s.Write(body, 0, body.Length);
        s.Write(tail, 0, 4);
    }
}
'@
}

if (-not $Out) { $Out = Join-Path $PSScriptRoot '..\icons' }   # (not a param default: empty there in PS 5.1)
$Out = [IO.Path]::GetFullPath($Out)
if (-not (Test-Path -LiteralPath $Out)) { [void][IO.Directory]::CreateDirectory($Out) }

# name, size, mode (0 rounded tile / 1 full bleed), disc radius (fraction of the icon), supersampling, opaque
$jobs = @(
  @('icon-192.png',          192, 0, 0.405, 6, $false),
  @('icon-512.png',          512, 0, 0.405, 6, $false),
  @('icon-maskable-512.png', 512, 1, 0.345, 6, $true),   # disc + halo stay inside the 0.40 safe circle
  @('apple-touch-icon.png',  180, 1, 0.400, 6, $true),
  @('favicon-32.png',         32, 0, 0.440, 8, $false)
)
foreach ($j in $jobs) {
  $path = Join-Path $Out $j[0]
  $bmp = [TwinSpinIcon]::Render($j[1], $j[2], $j[3], $j[4])
  try { [TwinSpinIcon]::Save($bmp, $path, $j[5]) } finally { $bmp.Dispose() }
  Write-Host ("  {0,-24} {1,4} px  {2,6:N0} bytes" -f $j[0], $j[1], (Get-Item -LiteralPath $path).Length)
}

# ------------------------------------------------------------------------------------------- icon.svg (same design)
# Hand-written SVG; only the rainbow wedges are generated (SVG 1.1 has no conic gradient): 36 wedges of 10 degrees,
# each filled with a linear gradient from its start hue to its end hue, overlapping slightly so no seams show.
$inv = [Globalization.CultureInfo]::InvariantCulture
function F([double]$v) { return $v.ToString('0.##', $inv) }
function Get-HueHex([double]$h) {
  $h = $h - [Math]::Floor($h)
  $i = [Math]::Floor($h * 6); $f = $h * 6 - $i
  $s = 0.78; $v = 1.0
  $p = $v * (1 - $s); $q = $v * (1 - $f * $s); $t = $v * (1 - (1 - $f) * $s)
  switch ([int]$i % 6) { 0 { $rgb = $v, $t, $p } 1 { $rgb = $q, $v, $p } 2 { $rgb = $p, $v, $t } 3 { $rgb = $p, $q, $v } 4 { $rgb = $t, $p, $v } default { $rgb = $v, $p, $q } }
  $silver = @((0xd9 / 255.0), (0xdc / 255.0), (0xe8 / 255.0))
  $hex = '#'
  for ($k = 0; $k -lt 3; $k++) { $hex += ([int][Math]::Round((($rgb[$k] * 0.82) + ($silver[$k] * 0.18)) * 0.94 * 255)).ToString('x2') }
  return $hex
}

$C = 256.0; $R = 0.405 * 512; $N = 36
$grads = New-Object Text.StringBuilder
$wedges = New-Object Text.StringBuilder
for ($i = 0; $i -lt $N; $i++) {
  $a0 = 2 * [Math]::PI * $i / $N
  $a1 = 2 * [Math]::PI * ($i + 1.35) / $N                         # overlap into the next wedge
  $am = 2 * [Math]::PI * ($i + 1) / $N
  $h0 = $i / $N + 0.62 + 0.07; $h1 = ($i + 1) / $N + 0.62 + 0.07
  $mx0 = $C + 0.72 * $R * [Math]::Cos($a0); $my0 = $C + 0.72 * $R * [Math]::Sin($a0)
  $mx1 = $C + 0.72 * $R * [Math]::Cos($am); $my1 = $C + 0.72 * $R * [Math]::Sin($am)
  [void]$grads.AppendFormat('<linearGradient id="w{0}" gradientUnits="userSpaceOnUse" x1="{1}" y1="{2}" x2="{3}" y2="{4}"><stop offset="0" stop-color="{5}"/><stop offset="1" stop-color="{6}"/></linearGradient>',
    $i, (F $mx0), (F $my0), (F $mx1), (F $my1), (Get-HueHex $h0), (Get-HueHex $h1))
  [void]$grads.Append("`n    ")
  $x0 = $C + ($R + 2) * [Math]::Cos($a0); $y0 = $C + ($R + 2) * [Math]::Sin($a0)
  $x1 = $C + ($R + 2) * [Math]::Cos($a1); $y1 = $C + ($R + 2) * [Math]::Sin($a1)
  [void]$wedges.AppendFormat('<path fill="url(#w{0})" d="M256 256L{1} {2}A{3} {3} 0 0 1 {4} {5}Z"/>', $i, (F $x0), (F $y0), (F ($R + 2)), (F $x1), (F $y1))
  [void]$wedges.Append("`n      ")
}

$svg = @"
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <title>TwinSpin</title>
  <defs>
    <radialGradient id="bg" cx="256" cy="236" r="318" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#181b2a"/><stop offset="1" stop-color="#0b0c12"/>
    </radialGradient>
    <radialGradient id="halo" cx="256" cy="256" r="$(F ($R * 1.16))" gradientUnits="userSpaceOnUse">
      <stop offset="$(F (1 / 1.16))" stop-color="#a58bff" stop-opacity="0.32"/>
      <stop offset="1" stop-color="#3da5ff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="shade" cx="256" cy="256" r="$(F $R)" gradientUnits="userSpaceOnUse">
      <stop offset="0.47" stop-color="#000" stop-opacity="0.14"/><stop offset="0.75" stop-color="#000" stop-opacity="0"/>
      <stop offset="0.955" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.38"/>
    </radialGradient>
    <filter id="soft" filterUnits="userSpaceOnUse" x="-300" y="-300" width="600" height="600">
      <feGaussianBlur stdDeviation="10"/>
    </filter>
    <radialGradient id="label" cx="256" cy="246" r="$(F (0.39 * $R))" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#1c1f2d"/><stop offset="1" stop-color="#10121b"/>
    </radialGradient>
    <clipPath id="disc"><circle cx="256" cy="256" r="$(F $R)"/></clipPath>
    $($grads.ToString().TrimEnd())
  </defs>
  <rect width="512" height="512" rx="115" fill="url(#bg)"/>
  <circle cx="256" cy="256" r="$(F ($R * 1.16))" fill="url(#halo)"/>
  <g clip-path="url(#disc)">
    <g>
      $($wedges.ToString().TrimEnd())
    </g>
    <circle cx="256" cy="256" r="$(F $R)" fill="url(#shade)"/>
    <g transform="translate(256 256) rotate(-45)" fill="#fff" fill-opacity="0.6" filter="url(#soft)">
      <path d="M0 0L$(F ($R + 24)) -22L$(F ($R + 24)) 22Z"/>
      <path d="M0 0L-$(F ($R + 24)) -22L-$(F ($R + 24)) 22Z"/>
    </g>
    <circle cx="256" cy="256" r="$(F ($R * 0.66))" fill="none" stroke="#000" stroke-opacity="0.14" stroke-width="2"/>
    <circle cx="256" cy="256" r="$(F ($R * 0.83))" fill="none" stroke="#000" stroke-opacity="0.14" stroke-width="2"/>
    <circle cx="256" cy="256" r="$(F ($R - 3.3))" fill="none" stroke="#e3e6f0" stroke-opacity="0.55" stroke-width="6.6"/>
  </g>
  <circle cx="256" cy="256" r="$(F ($R * 0.4375))" fill="#33374a" stroke="#c9ccd8" stroke-opacity="0.45" stroke-width="2"/>
  <circle cx="256" cy="256" r="$(F ($R * 0.395))" fill="url(#label)" stroke="#2b2e3c" stroke-width="$(F ($R * 0.02))"/>
  <circle cx="$(F (256 - 0.112 * $R))" cy="$(F (256 - 0.112 * $R))" r="$(F (0.178 * $R))" fill="#3da5ff"/>
  <circle cx="$(F (256 + 0.112 * $R))" cy="$(F (256 + 0.112 * $R))" r="$(F (0.178 * $R))" fill="#ff8a2a"/>
  <clipPath id="a"><circle cx="$(F (256 - 0.112 * $R))" cy="$(F (256 - 0.112 * $R))" r="$(F (0.178 * $R))"/></clipPath>
  <circle clip-path="url(#a)" cx="$(F (256 + 0.112 * $R))" cy="$(F (256 + 0.112 * $R))" r="$(F (0.178 * $R))" fill="#dad8d6"/>
  <circle cx="$(F (256 - 0.112 * $R))" cy="$(F (256 - 0.112 * $R))" r="$(F (0.038 * $R))" fill="#10121b"/>
  <circle cx="$(F (256 + 0.112 * $R))" cy="$(F (256 + 0.112 * $R))" r="$(F (0.038 * $R))" fill="#10121b"/>
</svg>
"@
$svgPath = Join-Path $Out 'icon.svg'
[IO.File]::WriteAllText($svgPath, ($svg -replace "`r`n", "`n"), (New-Object Text.UTF8Encoding($false)))
Write-Host ("  {0,-24} {1,4}     {2,6:N0} bytes" -f 'icon.svg', 'svg', (Get-Item -LiteralPath $svgPath).Length)
Write-Host "Icons written to $Out" -ForegroundColor Green
