<#
.SYNOPSIS
  Small static web server for TwinSpin on this computer (http://localhost:8100). No Node or Python needed.

.DESCRIPTION
  Serves the TwinSpin folder (or -Root) on http://localhost:<Port>/ with:
    * correct MIME types for modules (.js, .mjs), the manifest, fonts and audio files
    * Cache-Control: no-store, so a reload always shows your latest edits
    * no access outside the folder and none to hidden files or folders (.git and friends), because
      tools\phone-link.cmd makes this server reachable from the internet while it runs
    * HEAD and byte-range requests (audio elements need them)

  localhost is a secure context, so everything works here: AudioWorklet, service worker APIs, wake lock and the
  output device pickers. Do NOT open http://<this PC's LAN address>:8100 on a phone: that is not secure, so the
  browser hides those features. For phones use tools\phone-link.cmd (an https link) instead.

  Press Ctrl+C to stop.

.PARAMETER Port
  Port to listen on (default 8100).
.PARAMETER Root
  Folder to serve (default: the TwinSpin folder above tools\). Use -Root site to try the published build.
.PARAMETER Open
  Open the app in the default browser once the server runs.
.PARAMETER Log
  Print every request (by default only failed requests are printed).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\serve.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\serve.ps1 -Port 8200 -Root site -Open
#>
param(
  [int]$Port = 8100,
  [string]$Root = '',
  [switch]$Open,
  [switch]$Log
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 1

if (-not $Root) { $Root = Join-Path $PSScriptRoot '..' }
if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
  Write-Host "Folder not found: $Root" -ForegroundColor Red
  exit 1
}
$Root = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Root).ProviderPath).TrimEnd('\')
$RootPrefix = $Root + '\'

$Mime = @{
  '.html' = 'text/html; charset=utf-8'; '.htm' = 'text/html; charset=utf-8'
  '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'
  '.map' = 'application/json; charset=utf-8'; '.webmanifest' = 'application/manifest+json; charset=utf-8'
  '.txt' = 'text/plain; charset=utf-8'; '.md' = 'text/markdown; charset=utf-8'; '.xml' = 'application/xml'
  '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.ico' = 'image/x-icon'; '.jpg' = 'image/jpeg'
  '.jpeg' = 'image/jpeg'; '.webp' = 'image/webp'; '.gif' = 'image/gif'; '.avif' = 'image/avif'
  '.woff2' = 'font/woff2'; '.woff' = 'font/woff'; '.ttf' = 'font/ttf'; '.otf' = 'font/otf'
  '.wasm' = 'application/wasm'; '.zip' = 'application/zip'
  '.wav' = 'audio/wav'; '.wave' = 'audio/wav'; '.mp3' = 'audio/mpeg'; '.m4a' = 'audio/mp4'; '.aac' = 'audio/aac'
  '.mp4' = 'video/mp4'; '.flac' = 'audio/flac'; '.ogg' = 'audio/ogg'; '.oga' = 'audio/ogg'; '.opus' = 'audio/ogg'
  '.webm' = 'audio/webm'; '.weba' = 'audio/webm'; '.aif' = 'audio/aiff'; '.aiff' = 'audio/aiff'; '.caf' = 'audio/x-caf'
}

function Write-Log([string]$Text, [string]$Color = 'DarkGray') {
  Write-Host ("{0:HH:mm:ss} {1}" -f (Get-Date), $Text) -ForegroundColor $Color
}

# Maps a URL path to a file under $Root, or returns $null when it must not be served.
function Resolve-Request([string]$UrlPath) {
  try { $rel = [Uri]::UnescapeDataString($UrlPath) } catch { return $null }
  $rel = $rel.TrimStart('/')
  # No backslashes, drive letters or alternate data streams (':'), no NUL, no 8.3 short names ('~': GIT~1 = .git).
  if ($rel -match '[\\:\x00~]') { return $null }
  $segments = $rel.Split('/')
  foreach ($s in $segments) {
    if ($s -eq '..' -or ($s.Length -gt 0 -and $s.StartsWith('.'))) { return $null }   # parent dirs, hidden files
  }
  $full = [IO.Path]::GetFullPath([IO.Path]::Combine($Root, $rel.Replace('/', '\')))
  if ($full -ne $Root -and -not $full.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase)) { return $null }
  return $full
}

# Requests that arrive through a tunnel or proxy (tools\phone-link.ps1 uses a public Cloudflare quick tunnel) may only
# reach the app itself, never the rest of the project folder (private notes, your test songs in tests\media, docs).
# Cloudflare adds Cf-Connecting-Ip / Cf-Ray; other proxies add X-Forwarded-For.
$PublicFiles = @('', 'index.html', 'config.js', 'manifest.webmanifest', 'sw.js', '404.html', 'build.txt')
$PublicDirs = @('css/', 'src/', 'icons/', 'extras/')   # extras/: the Suno playlist script (Add music > Songs from Suno)
function Test-ViaProxy($Req) {
  foreach ($h in @('Cf-Connecting-Ip', 'Cf-Ray', 'X-Forwarded-For', 'Forwarded')) { if ($Req.Headers[$h]) { return $true } }
  return $false
}
function Test-PublicPath([string]$UrlPath) {
  try { $rel = [Uri]::UnescapeDataString($UrlPath).TrimStart('/') } catch { return $false }
  if ($PublicFiles -contains $rel) { return $true }
  foreach ($d in $PublicDirs) { if ($rel.StartsWith($d, [StringComparison]::OrdinalIgnoreCase)) { return $true } }
  return $false
}

function Send-Text($Res, [int]$Status, [string]$Text) {
  $Res.StatusCode = $Status
  $Res.ContentType = 'text/plain; charset=utf-8'
  $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
  $Res.ContentLength64 = $bytes.Length
  $Res.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Send-File($Req, $Res, [string]$File) {
  $ext = [IO.Path]::GetExtension($File).ToLowerInvariant()
  $Res.ContentType = if ($Mime.ContainsKey($ext)) { $Mime[$ext] } else { 'application/octet-stream' }
  $Res.AddHeader('Accept-Ranges', 'bytes')
  $stream = [IO.File]::Open($File, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try {
    $length = $stream.Length
    $start = 0L; $end = $length - 1
    $range = $Req.Headers['Range']
    if ($range -and $range -match '^bytes=(\d*)-(\d*)$' -and ($Matches[1] -ne '' -or $Matches[2] -ne '')) {
      if ($Matches[1] -eq '') {                       # bytes=-N: the last N bytes
        $n = [long]$Matches[2]
        $start = [Math]::Max(0L, $length - $n)
      } else {
        $start = [long]$Matches[1]
        if ($Matches[2] -ne '') { $end = [Math]::Min([long]$Matches[2], $length - 1) }
      }
      if ($start -ge $length -or $start -gt $end) {
        $Res.StatusCode = 416
        $Res.AddHeader('Content-Range', "bytes */$length")
        $Res.ContentLength64 = 0
        return 416
      }
      $Res.StatusCode = 206
      $Res.AddHeader('Content-Range', "bytes $start-$end/$length")
    } else {
      $Res.StatusCode = 200
    }
    $count = $end - $start + 1
    if ($length -eq 0) { $count = 0 }
    $Res.ContentLength64 = $count
    if ($Req.HttpMethod -eq 'HEAD' -or $count -eq 0) { return $Res.StatusCode }
    [void]$stream.Seek($start, [IO.SeekOrigin]::Begin)
    $buffer = New-Object byte[] 65536
    $left = $count
    while ($left -gt 0) {
      $read = $stream.Read($buffer, 0, [int][Math]::Min([long]$buffer.Length, $left))
      if ($read -le 0) { break }
      $Res.OutputStream.Write($buffer, 0, $read)
      $left -= $read
    }
    return $Res.StatusCode
  } finally { $stream.Dispose() }
}

function Invoke-Request($Ctx) {
  $req = $Ctx.Request
  $res = $Ctx.Response
  $status = 0
  try {
    $res.AddHeader('Cache-Control', 'no-store')
    $res.AddHeader('X-Content-Type-Options', 'nosniff')
    if ($req.HttpMethod -ne 'GET' -and $req.HttpMethod -ne 'HEAD') {
      $res.AddHeader('Allow', 'GET, HEAD')
      Send-Text $res 405 'Method not allowed'
      $status = 405
      return
    }
    $path = $req.Url.AbsolutePath
    if ((Test-ViaProxy $req) -and -not (Test-PublicPath $path)) { Send-Text $res 404 'Not found'; $status = 404; return }
    $file = Resolve-Request $path
    if ($null -eq $file) { Send-Text $res 404 'Not found'; $status = 404; return }
    if (Test-Path -LiteralPath $file -PathType Container) {
      if (-not $path.EndsWith('/')) {                 # folder without a slash: redirect so relative URLs work
        $res.StatusCode = 301
        $res.RedirectLocation = $path + '/' + $req.Url.Query
        $status = 301
        return
      }
      $file = Join-Path $file 'index.html'
    }
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Send-Text $res 404 'Not found'; $status = 404; return }
    $status = Send-File $req $res $file
  } catch {
    $status = 500
    try { Send-Text $res 500 'Server error' } catch { }
    Write-Log "500 $($req.HttpMethod) $($req.Url.AbsolutePath): $($_.Exception.Message)" 'Red'
  } finally {
    try { $res.Close() } catch { }                    # the client may have gone away mid-download
    if ($status -ne 500 -and ($Log -or $status -ge 400)) {
      $color = if ($status -ge 400) { 'Yellow' } else { 'DarkGray' }
      Write-Log "$status $($req.HttpMethod) $($req.Url.PathAndQuery)" $color
    }
  }
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try {
  $listener.Start()
} catch {
  Write-Host "Could not start the server on port ${Port}: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Is TwinSpin (or another server) already running there? Close it, or pick another port: -Port $($Port + 1)" -ForegroundColor Yellow
  exit 1
}

$url = "http://localhost:$Port/"
Write-Host ''
Write-Host "  TwinSpin is running at  $url" -ForegroundColor Green
Write-Host "  Serving $Root" -ForegroundColor DarkGray
Write-Host '  Phone? Use tools\phone-link.cmd for an https link (a LAN http:// address disables audio features).' -ForegroundColor DarkGray
Write-Host '  Press Ctrl+C to stop.' -ForegroundColor DarkGray
Write-Host ''
if ($Open) { try { Start-Process $url } catch { } }

try {
  while ($listener.IsListening) {
    $pending = $listener.BeginGetContext($null, $null)
    # Wait in short slices so Ctrl+C can stop the script between them.
    while (-not $pending.AsyncWaitHandle.WaitOne(200)) { }
    try { $ctx = $listener.EndGetContext($pending) } catch { continue }
    Invoke-Request $ctx
  }
} finally {
  try { $listener.Stop(); $listener.Close() } catch { }
  Write-Host 'Server stopped.' -ForegroundColor DarkGray
}
