# Builds the toolbar PNGs from icons/icon-source.png.
# The source art sits on an opaque black square, so this flood-fills the black
# from the corners to get transparency, crops to the artwork, then downscales
# by halving until close to the target size (one big bicubic jump smears at 16px).
# Run: powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$srcPath = Join-Path $root 'icons\icon-source.png'
$sizes = 16, 32, 48, 128

$src = [System.Drawing.Image]::FromFile($srcPath)
$w = $src.Width; $h = $src.Height
$bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.DrawImage($src, 0, 0, $w, $h)
$g.Dispose(); $src.Dispose()

$rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
$data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$stride = $data.Stride
$px = New-Object byte[] ($stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $px, 0, $px.Length)

# Flood fill the black surround from the four corners. Tolerance 48 also eats
# most of the pixels where the rounded square was antialiased against black.
$tol = 48
$seen = New-Object bool[] ($w * $h)
$stack = New-Object System.Collections.Generic.Stack[int]
foreach ($c in @(0, ($w - 1), ($w * ($h - 1)), ($w * $h - 1))) { $stack.Push($c) }
while ($stack.Count -gt 0) {
  $i = $stack.Pop()
  if ($seen[$i]) { continue }
  $y = [math]::Floor($i / $w); $x = $i - $y * $w
  $o = $y * $stride + $x * 4
  if ($px[$o] -gt $tol -or $px[$o + 1] -gt $tol -or $px[$o + 2] -gt $tol) { continue }
  $seen[$i] = $true
  $px[$o] = 0; $px[$o + 1] = 0; $px[$o + 2] = 0; $px[$o + 3] = 0
  if ($x -gt 0) { $stack.Push($i - 1) }
  if ($x -lt $w - 1) { $stack.Push($i + 1) }
  if ($y -gt 0) { $stack.Push($i - $w) }
  if ($y -lt $h - 1) { $stack.Push($i + $w) }
}

# Bounding box of what is left, so the artwork fills the icon.
$minX = $w; $minY = $h; $maxX = -1; $maxY = -1
for ($y = 0; $y -lt $h; $y++) {
  $row = $y * $stride
  for ($x = 0; $x -lt $w; $x++) {
    if ($px[$row + $x * 4 + 3] -ne 0) {
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
[System.Runtime.InteropServices.Marshal]::Copy($px, 0, $data.Scan0, $px.Length)
$bmp.UnlockBits($data)

$side = [math]::Max($maxX - $minX + 1, $maxY - $minY + 1)
$pad = [int]($side * 0.03)
$box = $side + 2 * $pad
$square = New-Object System.Drawing.Bitmap $box, $box, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($square)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$dst = New-Object System.Drawing.Rectangle ([int](($box - ($maxX - $minX + 1)) / 2)), ([int](($box - ($maxY - $minY + 1)) / 2)), ($maxX - $minX + 1), ($maxY - $minY + 1)
$srcR = New-Object System.Drawing.Rectangle $minX, $minY, ($maxX - $minX + 1), ($maxY - $minY + 1)
$g.DrawImage($bmp, $dst, $srcR, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$bmp.Dispose()

function Resize-Half($img, $target) {
  $cur = $img
  while ($cur.Width -gt $target * 2) {
    $n = [math]::Max($target, [int]($cur.Width / 2))
    $next = New-Object System.Drawing.Bitmap $n, $n, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $gg = [System.Drawing.Graphics]::FromImage($next)
    $gg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $gg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $gg.DrawImage($cur, 0, 0, $n, $n)
    $gg.Dispose()
    if (-not [object]::ReferenceEquals($cur, $img)) { $cur.Dispose() }
    $cur = $next
  }
  $out = New-Object System.Drawing.Bitmap $target, $target, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gg = [System.Drawing.Graphics]::FromImage($out)
  $gg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $gg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $gg.DrawImage($cur, 0, 0, $target, $target)
  $gg.Dispose()
  if (-not [object]::ReferenceEquals($cur, $img)) { $cur.Dispose() }
  return $out
}

foreach ($s in $sizes) {
  $out = Resize-Half $square $s
  $path = Join-Path $root ("icons\icon{0}.png" -f $s)
  $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  Write-Output ("wrote icons/icon{0}.png" -f $s)
}
$square.Dispose()
