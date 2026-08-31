# Packs the shareable zip: the files Chrome needs, none of the dev tooling.
# Entry names are written with forward slashes by hand because
# ZipFile.CreateFromDirectory on .NET Framework writes backslashes, which some
# unzip tools (macOS Archive Utility among them) turn into literal filenames.
# Run: powershell -ExecutionPolicy Bypass -File tools/make-zip.ps1

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$name = 'vinted-country-flags'
$version = (Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json).version
$zipPath = Join-Path $root ("{0}-{1}.zip" -f $name, $version)
if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

$include = @('manifest.json', 'README.md', 'LICENSE')
$dirs = @('src', 'popup', 'flags', 'icons', 'docs')
# icon-source.png is the full size art the icons are cut from.
# multi-domain.md is research notes: measured rate limits and how they were
# probed. Neither ships. docs/ is here for the README's screenshot.
$skip = @('icon-source.png', 'multi-domain.md')

$files = foreach ($f in $include) { Get-Item (Join-Path $root $f) }
$files += foreach ($d in $dirs) {
  Get-ChildItem -Recurse -File (Join-Path $root $d) | Where-Object { $skip -notcontains $_.Name }
}

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
foreach ($f in $files) {
  $rel = $f.FullName.Substring($root.Length + 1).Replace([char]92, '/')
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
    $zip, $f.FullName, "$name/$rel", [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
}
$zip.Dispose()

Write-Output ("{0}  ({1:N0} bytes, {2} files)" -f $zipPath, (Get-Item $zipPath).Length, $files.Count)
