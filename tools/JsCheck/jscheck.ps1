# Fast launcher for JsCheck: ~0.3 s per call instead of ~1.4 s for `dotnet run`.
# Builds (Release) on first use and whenever a source file is newer than the built DLL.
# If that rebuild fails while an older build exists (typically because another JsCheck process is
# running and Windows keeps its DLL locked), it warns on stderr and runs the older build.
# Usage: tools/JsCheck/jscheck.ps1 check src tests   |   tools/JsCheck/jscheck.ps1 test tests   |   tools/JsCheck/jscheck.ps1 run tests/pwa.test.js
$dir = $PSScriptRoot
$dll = Join-Path $dir 'bin/Release/net10.0/JsCheck.dll'
$stale = -not (Test-Path $dll)
if (-not $stale) {
    $built = (Get-Item $dll).LastWriteTimeUtc
    $stale = @(Get-ChildItem -Path $dir -File | Where-Object {
        ($_.Extension -eq '.cs' -or $_.Extension -eq '.csproj' -or $_.Name -eq 'prelude.js') -and $_.LastWriteTimeUtc -gt $built
    }).Count -gt 0
}
if ($stale) {
    $buildOutput = & dotnet build (Join-Path $dir 'JsCheck.csproj') -c Release -nologo -v q 2>&1
    if ($LASTEXITCODE -eq 0) {
        (Get-Item $dll).LastWriteTimeUtc = [DateTime]::UtcNow
    }
    elseif ((Test-Path $dll) -and (($buildOutput | Out-String) -match 'MSB302[16]|being used by another process')) {
        [Console]::Error.WriteLine('jscheck: could not rebuild (the DLL is in use by another JsCheck process); running the previous build')
    }
    else {
        $buildOutput | ForEach-Object { [Console]::Error.WriteLine($_) }
        [Console]::Error.WriteLine('jscheck: build failed')
        exit 2
    }
}
& dotnet $dll @args
exit $LASTEXITCODE
