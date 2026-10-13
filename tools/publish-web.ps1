<#
.SYNOPSIS
  Builds the TwinSpin website (site\), and optionally zips it or publishes it to GitHub Pages.

.DESCRIPTION
  Makes a clean, upload-ready copy of the app in <TwinSpin>\site (the folder is rebuilt on every run) with only the
  files the app needs at runtime:
    * index.html, config.js, manifest.webmanifest, sw.js (+ any other local file index.html or the manifest uses)
    * css\**, src\** and icons\** (without tests, notes and hidden files)
    * NOT docs\, tests\, tools\, README.md or anything else that is for development only
  Then it:
    * stamps the service worker: VERSION becomes twinspin-<UTC time> (so phones see "Update ready") and its SHELL list
      becomes the exact list of files in the site (the offline copy the installed app keeps)
    * adds .nojekyll (GitHub Pages then serves every file as is), 404.html (unknown addresses go to the app, keeping
      ?listen=CODE and #listen=CODE) and build.txt (build time, to see which version is live)
    * checks that every file index.html and the manifest refer to exists, and checks every JavaScript module of the
      site with tools\JsCheck (syntax, imports, exports, letter case), unless -SkipCheck; it refuses to finish a
      broken site
    * prints the file count and size

  -Zip   also writes <TwinSpin>\site.zip (index.html at the top level) for Netlify Drop or Cloudflare Pages.

  -Repo  publishes site\ to the gh-pages branch of YOUR repository with git, as you. Signing in is done by Git
         Credential Manager (part of Git for Windows): the first time, a window asks you to sign in to GitHub in
         your browser. This script never asks for, sees or stores a password or token.
         It builds a throw-away git repository in %TEMP% that contains only the website and force-pushes it to the
         gh-pages branch. Your TwinSpin folder, its git history and every other branch of the repository are never
         touched. Only github.com addresses are accepted unless you add -AnyRemote.

  -Open  opens the result: after -Repo the website (or its Pages settings page while the site is not live yet);
         otherwise Netlify Drop plus an Explorer window with the folder (or site.zip) to drag in.

  -Ci    the non-interactive build that .github/workflows/pages.yml runs on GitHub Actions (it is turned on by
         itself when GITHUB_ACTIONS=true): never opens anything, fails when the JavaScript check cannot run
         instead of skipping it, and writes a short summary to the job page.

  404.html sends unknown addresses to the app, so it has to know where the app lives on GitHub Pages: /<repo>/
  for a project site, / for a <you>.github.io repository. That comes from -Repo, else (on GitHub Actions) from
  GITHUB_REPOSITORY, else the page guesses it in the browser. On any host that is not *.github.io (your own
  domain, Netlify, a local server) it always goes to the top of the address.

.PARAMETER Zip
  Also write site.zip next to the site folder.
.PARAMETER Repo
  Your repository: https://github.com/<you>/<repo>.git, git@github.com:<you>/<repo>.git or just <you>/<repo>.
.PARAMETER AnyRemote
  Allow a -Repo that is not on github.com (GitLab, Codeberg, ...). The site still goes to its gh-pages branch.
.PARAMETER Open
  Open the website / upload page when done.
.PARAMETER NoPush
  With -Repo: prepare everything (temporary repository and commit), print what would be pushed, push nothing.
.PARAMETER SkipCheck
  Skip the checks (not recommended: one broken module stops the whole app from loading).
.PARAMETER Ci
  Non-interactive build for continuous integration (automatic when GITHUB_ACTIONS=true), see above.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish-web.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish-web.ps1 -Ci
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish-web.ps1 -Zip -Open
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish-web.ps1 -Repo https://github.com/<you>/twinspin.git -Open
#>
[CmdletBinding()]
param(
  [switch]$Zip,
  [string]$Repo = '',
  [switch]$AnyRemote,
  [switch]$Open,
  [switch]$NoPush,
  [switch]$SkipCheck,
  [switch]$Ci
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 1
trap {
  Write-Host ''
  Write-Host "STOPPED: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

$ToolsDir = Split-Path -Parent $MyInvocation.MyCommand.Path      # ($PSScriptRoot is empty in param defaults)
$Root = [IO.Path]::GetFullPath((Join-Path $ToolsDir '..')).TrimEnd('\')
$Site = Join-Path $Root 'site'
$ZipPath = Join-Path $Root 'site.zip'
$JsCheck = Join-Path $ToolsDir 'JsCheck\jscheck.ps1'
$Branch = 'gh-pages'
$BuildMarker = 'TwinSpin website build'
$StoredExt = @('.png', '.jpg', '.jpeg', '.webp', '.gif', '.woff2', '.woff', '.mp3', '.m4a', '.ogg', '.opus', '.zip')
$DevExt = @('.md', '.map', '.bak', '.orig', '.tmp', '.log', '.ps1', '.cmd', '.cs', '.psd', '.xcf')
$TestDirs = @('tests', 'test', '__tests__', 'spec')
$Utf8 = New-Object Text.UTF8Encoding($false)
$Inv = [Globalization.CultureInfo]::InvariantCulture
$InActions = $env:GITHUB_ACTIONS -eq 'true'
$CiMode = [bool]$Ci -or $InActions

# ------------------------------------------------------------------------------------------------------------ helpers

function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }
function Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }

function Format-Size([double]$Bytes) {
  if ($Bytes -ge 1MB) { return [string]::Format($Inv, '{0:0.0} MB', $Bytes / 1MB) }
  if ($Bytes -ge 1KB) { return [string]::Format($Inv, '{0:0} KB', $Bytes / 1KB) }
  return "$Bytes bytes"
}

# "D:\x\TwinSpin\src\main.js" relative to "D:\x\TwinSpin" -> "src/main.js"
function Get-Rel([string]$Base, [string]$Full) { return $Full.Substring($Base.Length).TrimStart('\', '/').Replace('\', '/') }

function Read-Text([string]$Path) { return [IO.File]::ReadAllText($Path, $Utf8) }
function Write-Text([string]$Path, [string]$Text) { [IO.File]::WriteAllText($Path, $Text, $Utf8) }

# Runs a console program, returns {Code, Out} (stdout + stderr lines). Windows PowerShell turns stderr lines into
# errors while ErrorActionPreference is Stop, so it is relaxed for the call.
function Invoke-Quiet([string]$Exe, [string[]]$ArgList) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = @(& $Exe @ArgList 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
  }
  finally { $ErrorActionPreference = $prev }
  return [pscustomobject]@{ Code = $code; Out = $out }
}

function Invoke-Git([string]$Dir, [string[]]$ArgList) {
  $r = Invoke-Quiet 'git' (@('-C', $Dir) + $ArgList)
  if ($r.Code -ne 0) { throw ("git $($ArgList -join ' ') failed:`n" + ($r.Out -join "`n")) }
  return $r.Out
}

function Remove-Dir([string]$Path) {
  for ($i = 0; $i -lt 5 -and (Test-Path -LiteralPath $Path); $i++) {
    try { Remove-Item -LiteralPath $Path -Recurse -Force } catch { if ($i -eq 4) { throw } Start-Sleep -Milliseconds 400 }
  }
}

function Copy-Files([hashtable]$Map, [string]$Dest) {
  foreach ($rel in $Map.Keys) {
    $dst = Join-Path $Dest ($rel.Replace('/', '\'))
    $dir = Split-Path $dst -Parent
    if (-not (Test-Path -LiteralPath $dir)) { [void][IO.Directory]::CreateDirectory($dir) }
    [IO.File]::Copy($Map[$rel], $dst, $true)
  }
}

function Test-DevFile([string]$Rel, [IO.FileInfo]$File) {
  $segs = $Rel.Split('/')
  if (@($segs | Where-Object { $_.StartsWith('.') -or ($TestDirs -contains $_) }).Count -gt 0) { return $true }
  if ($File.Name -match '\.(test|spec)\.m?js$' -or $File.Name -eq 'Thumbs.db' -or $File.Name -eq 'desktop.ini') { return $true }
  return $DevExt -contains $File.Extension.ToLowerInvariant()
}

# Understands https://github.com/<owner>/<repo>(.git), git@github.com:<owner>/<repo>(.git),
# ssh://git@github.com/<owner>/<repo>(.git) and <owner>/<repo>. Returns the push URL and, for GitHub, the Pages URL.
function Resolve-Repo([string]$Spec) {
  $s = $Spec.Trim()
  if ($s -match '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$') { $s = 'https://github.com/' + ($s -replace '\.git$', '') + '.git' }
  $m = [regex]::Match($s, '^(?<scheme>[a-z][a-z0-9+.-]*)://(?:(?<user>[^@/]*)@)?(?<host>[^/:@]+)(?::\d+)?/(?<path>[^?#]*)$', 'IgnoreCase')
  if (-not $m.Success) {
    $m = [regex]::Match($s, '^(?<user>[^@/:]+)@(?<host>[^:/]+):(?<path>[^?#]+)$')
    if (-not $m.Success) { throw "-Repo '$Spec' is not a git address. Example: https://github.com/<you>/twinspin.git" }
  }
  $scheme = if ($m.Groups['scheme'].Success) { $m.Groups['scheme'].Value.ToLowerInvariant() } else { 'ssh' }
  $user = $m.Groups['user'].Value
  $hostName = $m.Groups['host'].Value.ToLowerInvariant()
  # Never let a secret travel in the address (it would end up in logs and shell history).
  if ($user.Contains(':') -or $user -match '^(gh[pousr]_|github_pat_|glpat-)' -or $user.Length -gt 39) {
    throw 'The -Repo address contains a password or token. Use the plain address (https://github.com/<you>/<repo>.git): Git Credential Manager asks you to sign in in your browser instead.'
  }
  if ($scheme -ne 'https' -and $scheme -ne 'ssh' -and $scheme -ne 'git+ssh') {
    throw "-Repo must be an https:// or ssh address (got ${scheme}://)."
  }
  $isGitHub = $hostName -eq 'github.com' -or $hostName -eq 'www.github.com' -or $hostName -eq 'ssh.github.com'
  if (-not $isGitHub) {
    if (-not $AnyRemote) {
      throw "-Repo points to '$hostName', not github.com. This script publishes to GitHub Pages; add -AnyRemote to push the gh-pages branch to another host anyway."
    }
    return [pscustomobject]@{ Url = $s; GitHub = $false; Owner = ''; Name = ''; PagesUrl = ''; Base = ''; RepoPage = ''; SettingsUrl = '' }
  }
  $parts = @(($m.Groups['path'].Value.Trim('/') -replace '\.git$', '').Split('/') | Where-Object { $_ })
  if ($parts.Count -ne 2 -or $parts[0] -notmatch '^[A-Za-z0-9-]+$' -or $parts[1] -notmatch '^[A-Za-z0-9._-]+$') {
    throw "-Repo '$Spec' should look like https://github.com/<you>/<repo>.git"
  }
  $owner = $parts[0]; $name = $parts[1]
  $url = if ($scheme -eq 'https') {
    'https://' + $(if ($user) { "$user@" } else { '' }) + "github.com/$owner/$name.git"
  } else { $s }
  $ownerLc = $owner.ToLowerInvariant()
  if ($name.ToLowerInvariant() -eq "$ownerLc.github.io") { $pages = "https://$ownerLc.github.io/"; $base = '/' }
  else { $pages = "https://$ownerLc.github.io/$name/"; $base = "/$name/" }
  return [pscustomobject]@{
    Url = $url; GitHub = $true; Owner = $owner; Name = $name; PagesUrl = $pages; Base = $base
    RepoPage = "https://github.com/$owner/$name"; SettingsUrl = "https://github.com/$owner/$name/settings/pages"
  }
}

function Test-Live([string]$Url) {
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $r = Invoke-WebRequest -Uri $Url -Method Head -UseBasicParsing -TimeoutSec 10
    return [int]$r.StatusCode -eq 200
  } catch { return $false }
}

$NotFoundPage = @'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0b0c12">
<title>TwinSpin</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0c12; }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px;
    padding: 0 16px; box-sizing: border-box; text-align: center; color: #f1f2f8;
    font: 18px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }
  p { margin: 0; }
  a {
    display: inline-flex; align-items: center; min-height: 56px; padding: 0 28px; border-radius: 12px;
    background: #5be38a; color: #0b0c12; font-weight: 700; text-decoration: none;
  }
  small { color: #a9aec0; }
</style>
</head>
<body>
<p>This page is not part of TwinSpin.</p>
<a id="go" href="./">Open TwinSpin</a>
<small id="note">Taking you to the app.</small>
<script>
  // Any unknown address on this website lands here: go to the app, keeping ?listen=CODE and #listen=CODE.
  // tools/publish-web.ps1 fills in BASE for GitHub Pages ('/<repo>/', or '/' for <you>.github.io); empty = guess
  // from the address. On any other host (own domain, Netlify, a local server) the app is at the top: '/'.
  (function () {
    var BASE = ''; // @base
    var l = window.location;
    if (!/\.github\.io$/i.test(l.hostname)) {
      BASE = '/';
    } else if (!BASE) {
      var first = l.pathname.split('/')[1] || '';
      BASE = first ? '/' + first + '/' : '/';
    }
    var target = BASE + l.search + l.hash;
    document.getElementById('go').href = target;
    try {
      var last = Number(sessionStorage.getItem('twinspin.404')) || 0;
      if (Date.now() - last < 8000) { document.getElementById('note').textContent = 'Tap the button to open the app.'; return; }
      sessionStorage.setItem('twinspin.404', String(Date.now()));
    } catch (e) {}
    l.replace(target);
  })();
</script>
</body>
</html>
'@

# ------------------------------------------------------------------------------------------------------ preflight

foreach ($f in @('index.html', 'config.js', 'sw.js', 'manifest.webmanifest', 'src\main.js')) {
  if (-not (Test-Path -LiteralPath (Join-Path $Root $f) -PathType Leaf)) { throw "$f is missing in $Root. Run this script from the TwinSpin folder (tools\publish-web.ps1)." }
}
$target = $null
if ($Repo) {
  $target = Resolve-Repo $Repo
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git is not installed. Install Git for Windows (https://git-scm.com/download/win, default options), open a NEW PowerShell window and run this again.'
  }
} elseif ($NoPush -or $AnyRemote) {
  Say '-NoPush / -AnyRemote only matter together with -Repo; ignoring them.' Yellow
}
if ($CiMode -and $Open) { Say '-Open is ignored in a CI build.' Yellow; $Open = $false }

# Where the site lives on GitHub Pages, for 404.html: '/<repo>/' for a project site, '/' for <owner>.github.io.
$pagesBase = ''
$baseFrom = 'guessed in the browser'
if ($target) {
  if ($target.GitHub) { $pagesBase = $target.Base; $baseFrom = 'from -Repo' }
} elseif ($InActions -and $env:GITHUB_REPOSITORY) {
  $server = "$env:GITHUB_SERVER_URL".TrimEnd('/')
  if ($server -and $server -ne 'https://github.com') {
    $baseFrom = "guessed in the browser (Pages of $server)"
  } else {
    try { $pagesBase = (Resolve-Repo $env:GITHUB_REPOSITORY).Base; $baseFrom = "from GITHUB_REPOSITORY=$env:GITHUB_REPOSITORY" }
    catch { Say "GITHUB_REPOSITORY '$env:GITHUB_REPOSITORY' is not <owner>/<repo>; 404.html will guess the address." Yellow }
  }
}

# ------------------------------------------------------------------------------------------------ pick the files

Step 'Collecting the app files'
$plan = @{}                                              # site path ("src/main.js") -> source file
$skipped = New-Object System.Collections.Generic.List[string]
$problems = New-Object System.Collections.Generic.List[string]

$indexHtml = Read-Text (Join-Path $Root 'index.html')
$manifestText = Read-Text (Join-Path $Root 'manifest.webmanifest')

foreach ($n in @('index.html', 'config.js', 'manifest.webmanifest', 'sw.js')) { $plan[$n] = Join-Path $Root $n }

# Every local file index.html or the manifest points at must exist (a missing stylesheet or icon breaks the site).
$refs = @([regex]::Matches($indexHtml, '(?i)\b(?:href|src)\s*=\s*["'']([^"''#?]+)') | ForEach-Object { $_.Groups[1].Value }) +
        @([regex]::Matches($manifestText, '"src"\s*:\s*"([^"#?]+)"') | ForEach-Object { $_.Groups[1].Value })
foreach ($ref in $refs) {
  if ($ref -match '^[a-z][a-z0-9+.-]*:' -or $ref.StartsWith('//')) { continue }     # https:, data:, //host
  if ($ref.StartsWith('/')) { $problems.Add("'$ref' starts with '/': it breaks on GitHub Pages project sites (use a relative path)"); continue }
  $p = [IO.Path]::GetFullPath((Join-Path $Root ($ref -replace '^\./', '')))
  if (-not $p.StartsWith($Root + '\')) { $problems.Add("'$ref' points outside the app folder"); continue }
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) {
    if (Test-Path -LiteralPath $p -PathType Container) { continue }               # e.g. href="./"
    $problems.Add("'$ref' does not exist"); continue
  }
  $rel = Get-Rel $Root $p
  if ($TestDirs -contains $rel.Split('/')[0]) { continue }
  $plan[$rel] = $p
}
try { [void]($manifestText | ConvertFrom-Json) } catch { $problems.Add("manifest.webmanifest is not valid JSON: $($_.Exception.Message)") }

# css/**, src/**, icons/**: everything except tests, notes and hidden files.
foreach ($dir in @('css', 'src', 'icons')) {
  $full = Join-Path $Root $dir
  if (-not (Test-Path -LiteralPath $full -PathType Container)) {
    if ($dir -ne 'icons') { $problems.Add("the $dir\ folder is missing") }
    continue
  }
  foreach ($f in @(Get-ChildItem -LiteralPath $full -Recurse -File -Force)) {
    $rel = Get-Rel $Root $f.FullName
    if (Test-DevFile $rel $f) { $skipped.Add($rel); continue }
    $plan[$rel] = $f.FullName
  }
}

# What else is in the folder (for the summary).
foreach ($item in @(Get-ChildItem -LiteralPath $Root -Force)) {
  if ($item.Name -eq 'site' -or $item.Name -eq 'site.zip') { continue }
  if ($item.PSIsContainer) {
    if (@('css', 'src', 'icons') -notcontains $item.Name) { $skipped.Add("$($item.Name)/") }
  } elseif (-not $plan.ContainsKey($item.Name)) { $skipped.Add($item.Name) }
}

if ($problems.Count) {
  $problems | ForEach-Object { Say "  $_" Red }
  if (-not $SkipCheck) { throw 'index.html or the manifest refers to files that are missing or unusable (see above). Fix them and run this again (or use -SkipCheck at your own risk).' }
}

# -------------------------------------------------------------------------------------------------- build site\

Step "Building $Site"
if (Test-Path -LiteralPath $Site) {
  $marker = Join-Path $Site 'build.txt'
  $ours = (Test-Path -LiteralPath $marker) -and (Read-Text $marker).StartsWith($BuildMarker)
  $empty = @(Get-ChildItem -LiteralPath $Site -Force).Count -eq 0
  if (-not $ours -and -not $empty) {
    throw "$Site already exists and was not made by this script. Rename or move that folder, then run this again."
  }
  Remove-Dir $Site
}
[void][IO.Directory]::CreateDirectory($Site)
Copy-Files $plan $Site

# Service worker: a new VERSION per build, and the exact list of files to keep offline.
$now = [DateTime]::UtcNow
$version = 'twinspin-' + $now.ToString('yyyyMMdd-HHmmss', $Inv)
$swPath = Join-Path $Site 'sw.js'
$sw = Read-Text $swPath
$versionRe = New-Object regex "(?m)^const VERSION = '[^'\r\n]*';"
if (-not $versionRe.IsMatch($sw)) { throw "sw.js has no line `"const VERSION = '...';`" to stamp." }
$sw = $versionRe.Replace($sw, "const VERSION = '$version';", 1)

$shellPaths = @('./', './index.html', './config.js', './manifest.webmanifest')
[string[]]$rest = @($plan.Keys | Where-Object { @('index.html', 'config.js', 'manifest.webmanifest', 'sw.js') -notcontains $_ })
[Array]::Sort($rest, [StringComparer]::Ordinal)
$shellPaths += @($rest | ForEach-Object { './' + $_ })
$nl = if ($sw.Contains("`r`n")) { "`r`n" } else { "`n" }
$list = New-Object Text.StringBuilder
[void]$list.Append("// @shell-begin (generated by tools/publish-web.ps1 for ${version}: every file of this site)").Append($nl)
[void]$list.Append('const SHELL = [').Append($nl)
foreach ($p in $shellPaths) { [void]$list.Append("  '").Append($p.Replace('\', '\\').Replace("'", "\'")).Append("',").Append($nl) }
[void]$list.Append('];').Append($nl).Append('// @shell-end')
$shellRe = New-Object regex '(?s)//[ \t]*@shell-begin.*?//[ \t]*@shell-end'
if (-not $shellRe.IsMatch($sw)) { throw 'sw.js has no "// @shell-begin ... // @shell-end" block to fill in.' }
$sw = $shellRe.Replace($sw, $list.ToString().Replace('$', '$$'), 1)
Write-Text $swPath $sw

# GitHub Pages extras: serve files as is (no Jekyll), send unknown addresses to the app, record the build.
[IO.File]::WriteAllBytes((Join-Path $Site '.nojekyll'), [byte[]]@())
$baseLine = "var BASE = ''; // @base"
if (-not $NotFoundPage.Contains($baseLine)) { throw "The 404 page template has no line `"$baseLine`"." }
$notFound = if ($pagesBase) { $NotFoundPage.Replace($baseLine, "var BASE = '$pagesBase'; // @base") } else { $NotFoundPage }
Write-Text (Join-Path $Site '404.html') $notFound
$baseShown = if ($pagesBase) { $pagesBase } else { '(none)' }
$commit = 'none'
if (Get-Command git -ErrorAction SilentlyContinue) {
  $r = Invoke-Quiet 'git' @('-C', $Root, 'rev-parse', '--short', 'HEAD')
  if ($r.Code -eq 0 -and $r.Out.Count -gt 0 -and $r.Out[0] -match '^[0-9a-f]+$') {
    $commit = $r.Out[0]
    $d = Invoke-Quiet 'git' @('-C', $Root, 'status', '--porcelain', '--', 'index.html', 'config.js', 'sw.js', 'manifest.webmanifest', 'css', 'src', 'icons')
    if ($d.Code -eq 0 -and $d.Out.Count -gt 0) { $commit += ' + uncommitted changes' }
  }
}
Write-Text (Join-Path $Site 'build.txt') ($BuildMarker + "`n" +
  'built: ' + $now.ToString('yyyy-MM-dd HH:mm:ss', $Inv) + " UTC`n" +
  "version: $version`n" + "commit: $commit`n" + "files: $($shellPaths.Count - 1)`n" + "404 base: $baseShown`n")
Say "  Service worker version $version, $($shellPaths.Count - 1) files kept for offline use."
if ($pagesBase) { Say "  404.html sends unknown addresses on *.github.io to $pagesBase ($baseFrom)." }
else { Say "  404.html sends unknown addresses to the app; its address is $baseFrom." }

# ------------------------------------------------------------------------------------------------------ check it

$checkResult = 'skipped'
if ($SkipCheck) {
  Say 'JavaScript check skipped (-SkipCheck).' Yellow
} elseif (-not (Test-Path -LiteralPath $JsCheck) -or -not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
  if ($CiMode) { throw 'The JavaScript check needs tools\JsCheck and the .NET SDK (in a workflow: actions/setup-dotnet before this step).' }
  Say 'JavaScript check skipped: it needs tools\JsCheck and the .NET SDK.' Yellow
} else {
  Step 'Checking every JavaScript module of the site'
  $ps = (Get-Process -Id $PID).Path
  $r = Invoke-Quiet $ps @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $JsCheck, 'check', $Site)
  $summary = @($r.Out | Where-Object { $_ -match '^(OK|FAIL) ' } | Select-Object -Last 1)
  $fatal = @($r.Out | Where-Object { $_ -match 'SyntaxError|cannot resolve|points to a directory|letter case is ignored|does not provide an export|bare .* specifier' })
  if ($r.Code -eq 2 -or $summary.Count -eq 0) {
    if ($CiMode) {
      $r.Out | Select-Object -Last 30 | ForEach-Object { Say "  $_" Red }
      throw 'The JavaScript check could not run (JsCheck did not build, see above), so the site was not checked.'
    }
    Say 'JavaScript check could not run (JsCheck did not build); the site was not checked.' Yellow
    $r.Out | Select-Object -Last 5 | ForEach-Object { Say "  $_" DarkYellow }
  } elseif ($r.Code -ne 0 -or $fatal.Count -gt 0) {
    $r.Out | ForEach-Object { Say "  $_" Red }
    throw 'The JavaScript check found problems that would break the website (see above). Fix them and run this again (or use -SkipCheck at your own risk).'
  } else {
    $r.Out | Where-Object { $_ -match 'warning:' } | ForEach-Object { Say "  $_" DarkYellow }
    Say "JavaScript check: $($summary[0])" Green
    $checkResult = $summary[0]
  }
}

# ---------------------------------------------------------------------------------------------------- summary

$siteFiles = @(Get-ChildItem -LiteralPath $Site -Recurse -File -Force)
$total = ($siteFiles | Measure-Object -Property Length -Sum).Sum
Step 'Website ready'
Say "  Folder   $Site" White
Say "  Files    $($siteFiles.Count) files, $(Format-Size $total)" White
$nested = @($siteFiles | Where-Object { (Get-Rel $Site $_.FullName).Contains('/') })
foreach ($g in @($nested | Group-Object { (Get-Rel $Site $_.FullName).Split('/')[0] } | Sort-Object Name)) {
  Say ("           {0,-8} {1} files, {2}" -f ($g.Name + '/'), $g.Count, (Format-Size (($g.Group | Measure-Object -Property Length -Sum).Sum)))
}
if ($skipped.Count) {
  Say '  Left out (development only):'
  $skipped | Sort-Object | ForEach-Object { Say "           $_" DarkGray }
}
if (-not $CiMode) {
  Say '  Try it on this PC: powershell -ExecutionPolicy Bypass -File tools\serve.ps1 -Root site   (then http://localhost:8100/)' DarkGray
}

# The job page of a GitHub Actions run shows this summary.
if ($env:GITHUB_STEP_SUMMARY) {
  $md = @(
    '### TwinSpin website build', '',
    '| | |', '|---|---|',
    ('| Service worker version | `{0}` |' -f $version),
    ('| Files | {0} files, {1} ({2} kept offline by sw.js) |' -f $siteFiles.Count, (Format-Size $total), ($shellPaths.Count - 1)),
    ('| 404.html base | `{0}` ({1}) |' -f $baseShown, $baseFrom),
    ('| Commit | {0} |' -f $commit),
    ('| JavaScript check | {0} |' -f $checkResult), '')
  try { [IO.File]::AppendAllText($env:GITHUB_STEP_SUMMARY, ($md -join "`n") + "`n", $Utf8) }
  catch { Say "  Could not write the job summary: $($_.Exception.Message)" DarkYellow }
}

# --------------------------------------------------------------------------------------------------------- zip

if ($Zip) {
  Step 'Zipping'
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
  # Entries are written one by one with forward slashes (Windows PowerShell's Compress-Archive may use backslashes,
  # which web hosts unpack into wrong file names).
  $fs = [IO.File]::Open($ZipPath, [IO.FileMode]::CreateNew)
  try {
    $za = New-Object IO.Compression.ZipArchive -ArgumentList $fs, ([IO.Compression.ZipArchiveMode]::Create)
    try {
      foreach ($f in $siteFiles) {
        $level = if ($StoredExt -contains $f.Extension.ToLowerInvariant()) { [IO.Compression.CompressionLevel]::NoCompression } else { [IO.Compression.CompressionLevel]::Optimal }
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($za, $f.FullName, (Get-Rel $Site $f.FullName), $level)
      }
    } finally { $za.Dispose() }
  } finally { $fs.Dispose() }
  Say "  $ZipPath ($(Format-Size (Get-Item -LiteralPath $ZipPath).Length), $($siteFiles.Count) files, index.html at the top)" White
  Say '  Upload it at https://app.netlify.com/drop (or Cloudflare Pages -> Upload assets).' Gray
  Say '  Netlify Drop removes anonymous sites after an hour unless you claim them (free account).' DarkGray
}

# --------------------------------------------------------------------------------------------- GitHub Pages

$live = $false
$pushed = $false
if ($target) {
  Step "Publishing to the $Branch branch of $($target.Url)"
  if ($target.Url -like 'https://*') {
    $helper = Invoke-Quiet 'git' @('config', '--get', 'credential.helper')
    if ($helper.Code -ne 0 -or -not ($helper.Out -join '')) {
      Say '  No git credential helper is set up, so git may ask for a username and password in this window. GitHub does not accept your account password there: reinstall Git for Windows with its default options (it includes Git Credential Manager) to sign in through the browser.' Yellow
    }
  }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('twinspin-pages-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $keepTmp = $false
  try {
    [void][IO.Directory]::CreateDirectory($tmp)
    $map = @{}
    foreach ($f in $siteFiles) { $map[(Get-Rel $Site $f.FullName)] = $f.FullName }
    Copy-Files $map $tmp                                 # (site\404.html already carries this repository's base)
    # A fresh, separate repository holding only the website: nothing of the project's own history is involved.
    [void](Invoke-Git $tmp @('init', '-q'))
    [void](Invoke-Git $tmp @('symbolic-ref', 'HEAD', "refs/heads/$Branch"))
    [void](Invoke-Git $tmp @('config', 'core.autocrlf', 'false'))
    [void](Invoke-Git $tmp @('config', 'core.safecrlf', 'false'))
    [void](Invoke-Git $tmp @('add', '-A'))
    $who = @()
    $nameSet = Invoke-Quiet 'git' @('-C', $tmp, 'config', '--get', 'user.name')
    $mailSet = Invoke-Quiet 'git' @('-C', $tmp, 'config', '--get', 'user.email')
    if ($nameSet.Code -ne 0 -or $mailSet.Code -ne 0) { $who = @('-c', 'user.name=TwinSpin publisher', '-c', 'user.email=publisher@twinspin.invalid') }
    $stamp = $now.ToString('yyyy-MM-dd HH:mm', $Inv)
    [void](Invoke-Git $tmp ($who + @('commit', '-q', '-m', "Publish TwinSpin website ($stamp UTC, $version)")))
    $count = @(Invoke-Git $tmp @('ls-files')).Count
    Say "  Prepared one commit with $count files on branch $Branch (temporary repository)."

    if ($NoPush) {
      $keepTmp = $true
      Say '  -NoPush: nothing was pushed. This is what would run:' Yellow
      Say "    git -C `"$tmp`" push --force $($target.Url) HEAD:refs/heads/$Branch" Yellow
      Say "  The temporary repository is kept for a look: $tmp (delete it when done)." Yellow
    } else {
      Say '  The first time, a window opens to sign you in to GitHub (Git Credential Manager).' White
      Say '  Sign in with the account that owns the repository. This script never sees your password.' White
      if ($CiMode) { $env:GIT_TERMINAL_PROMPT = '0'; $env:GCM_INTERACTIVE = 'never' }   # fail, never wait for a sign-in
      $prev = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try { & git -C $tmp push --force $target.Url "HEAD:refs/heads/$Branch"; $code = $LASTEXITCODE }
      finally { $ErrorActionPreference = $prev }
      if ($code -ne 0) {
        throw ("git push failed (exit code $code). Check that the repository exists, that the address is right and that you signed in with the account that owns it. " +
               'To sign in again: Windows Credential Manager -> Windows Credentials -> remove "git:https://github.com", then run this again.')
      }
      $pushed = $true
    }
  }
  finally {
    if (-not $keepTmp -and (Test-Path -LiteralPath $tmp)) { try { Remove-Dir $tmp } catch { Say "  Could not delete the temporary folder $tmp" DarkYellow } }
  }

  if ($pushed) {
    Say ''
    Say "  Pushed the website to the $Branch branch." Green
    if ($target.GitHub) {
      $live = Test-Live $target.PagesUrl
      Say ''
      Say '  ONE-TIME STEP (first publish only; skip it if Pages is already on):' White
      Say "    1. Open $($target.SettingsUrl)"
      Say '    2. Build and deployment -> Source: Deploy from a branch'
      Say "    3. Branch: $Branch   Folder: / (root)   -> Save"
      Say '    4. Wait a minute or two (the Actions tab shows "pages build and deployment").'
      Say ''
      if ($live) { Say '  GitHub Pages is already on: the new version appears within a few minutes. Phones that installed the app show "Update ready".' Green }
      else { Say '  The website is not answering yet: do the one-time step above, or wait a minute if you already did.' Yellow }
      Say ''
      Say "  Your website:  $($target.PagesUrl)" Green
      Say '  To update it later, run this same command again.' Gray
      $qrScript = Join-Path $ToolsDir 'phone-link.ps1'
      if (-not $CiMode -and (Test-Path -LiteralPath $qrScript)) {
        Say '  Scan this with your phone to open it:' Gray
        & $qrScript -Qr $target.PagesUrl
      }
    } else {
      Say "  Turn on your host's static pages for the $Branch branch to put it online." Yellow
    }
  }
}

# ------------------------------------------------------------------------------------------------------- open

if ($Open) {
  if ($target) {
    if ($pushed -and $target.GitHub) {
      $url = if ($live) { $target.PagesUrl } else { $target.SettingsUrl }
      Say "Opening $url"
      Start-Process $url
    } elseif ($NoPush -and $target.GitHub) {
      Say "-Open: nothing to open with -NoPush (it would open $($target.PagesUrl))." Yellow
    }
  } else {
    $pick = if ($Zip) { $ZipPath } else { $Site }
    Say "Opening Netlify Drop and Explorer at $pick (drag it onto the Netlify page)."
    Start-Process 'https://app.netlify.com/drop'
    Start-Process explorer.exe -ArgumentList "/select,`"$pick`""
  }
}
