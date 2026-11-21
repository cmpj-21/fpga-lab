# Generates multi-resolution Trace FPGA Workbench Windows icon (packaging/native/trace.ico)
# Uses built-in .NET System.Drawing (zero external dependencies).
param(
  [string]$OutPath = (Join-Path $PSScriptRoot 'native\trace.ico')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngBlobs = New-Object System.Collections.Generic.List[byte[]]

function New-RoundedRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

foreach ($sz in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($sz, $sz, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  $pad = [math]::Max(1.0, $sz * 0.0625)
  $rectSz = $sz - ($pad * 2.0)
  $radius = $sz * 0.22
  $bgPath = New-RoundedRectPath $pad $pad $rectSz $rectSz $radius
  $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 35, 42, 34))
  $g.FillPath($bgBrush, $bgPath)

  $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 62, 77, 56), [math]::Max(1.0, $sz * 0.03))
  $g.DrawPath($borderPen, $bgPath)

  # Crisp Trace 'T' monogram matching favicon (#d4ed80)
  $strokeW = [math]::Max(2.0, $sz * 0.11)
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 212, 237, 128), $strokeW)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $yTop = $sz * 0.32
  $xLeft = $sz * 0.25
  $xRight = $sz * 0.75
  $xMid = $sz * 0.50
  $yBot = $sz * 0.76
  $g.DrawLine($pen, $xLeft, $yTop, $xRight, $yTop)
  $g.DrawLine($pen, $xMid, $yTop, $xMid, $yBot)

  # Subtle period accent dot in bottom-right
  $dotR = [math]::Max(1.2, $sz * 0.055)
  $dotBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 134, 179, 88))
  $g.FillEllipse($dotBrush, ($sz * 0.69) - $dotR, ($sz * 0.73) - $dotR, $dotR * 2, $dotR * 2)

  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngBlobs.Add($ms.ToArray())

  $ms.Dispose(); $dotBrush.Dispose(); $pen.Dispose(); $borderPen.Dispose(); $bgBrush.Dispose(); $bgPath.Dispose(); $g.Dispose(); $bmp.Dispose()
}

$outDir = Split-Path -Parent $OutPath
if (!(Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

$fs = [System.IO.File]::Open($OutPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$bw = New-Object System.IO.BinaryWriter($fs)
try {
  # ICONDIR header
  $bw.Write([uint16]0)
  $bw.Write([uint16]1)
  $bw.Write([uint16]$sizes.Count)

  $offset = 6 + (16 * $sizes.Count)
  for ($i = 0; $i -lt $sizes.Count; $i++) {
    $sz = $sizes[$i]
    $blob = $pngBlobs[$i]
    $bw.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz })))
    $bw.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz })))
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]32)
    $bw.Write([uint32]$blob.Length)
    $bw.Write([uint32]$offset)
    $offset += $blob.Length
  }
  foreach ($blob in $pngBlobs) {
    $bw.Write($blob)
  }
} finally {
  $bw.Dispose()
  $fs.Dispose()
}

Write-Host "Generated icon: $OutPath ($($sizes.Count) resolutions)" -ForegroundColor Green
