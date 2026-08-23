# Generate Ponos app icons with TRANSPARENT background using System.Drawing
# Creates public/icon-<size>.png files for packaging into .ico
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

function Draw-PonosIcon([int]$size, [string]$path) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)  # TRANSPARENT background

    # Brand orange rounded square (no outer background)
    $pad = [int]($size * 0.14)
    $sq = $size - ($pad * 2)
    $p3 = [System.Drawing.Point]::new($pad, $pad)
    $p4 = [System.Drawing.Point]::new(($size - $pad), ($size - $pad))
    $orange = [System.Drawing.Drawing2D.LinearGradientBrush]::new($p3, $p4,
        [System.Drawing.Color]::FromArgb(255, 255, 150, 40),
        [System.Drawing.Color]::FromArgb(255, 220, 90, 0))
    $pathRounded = New-Object System.Drawing.Drawing2D.GraphicsPath
    $radius = [int]($sq * 0.26)
    $rect = New-Object System.Drawing.Rectangle($pad, $pad, $sq, $sq)
    $d = $radius * 2
    $pathRounded.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
    $pathRounded.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
    $pathRounded.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
    $pathRounded.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
    $pathRounded.CloseFigure()
    $g.FillPath($orange, $pathRounded)

    # White "YF" text
    $fontSize = [int]($sq * 0.44)
    $font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $textRect = New-Object System.Drawing.RectangleF($pad, ($pad - [int]($size * 0.02)), $sq, $sq)
    $g.DrawString("YF", $font, $white, $textRect, $sf)

    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Host ("  created {0} ({1}x{1})" -f $path, $size)
}

Write-Host "Generating Ponos icons (transparent bg)..."
$root = "C:\Users\T203-15\claude-code-gui\public"
if (-not (Test-Path $root)) { New-Item -ItemType Directory -Path $root | Out-Null }

# Generate master 256px PNG
Draw-PonosIcon 256 "$root\icon-256.png"
Copy-Item "$root\icon-256.png" "$root\icon.png" -Force

# Generate sizes for ICO
foreach ($s in @(16, 32, 48, 64, 128, 256)) {
    Draw-PonosIcon $s "$root\icon-$s.png"
}
Write-Host "Done generating PNGs."
