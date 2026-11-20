# ScènePro : fabrique les icônes Windows (.ico 16 à 256 px) à partir des logos PNG 512 px de build\icons
# Utilisation : powershell -ExecutionPolicy Bypass -File build\make-icons.ps1
Add-Type -AssemblyName System.Drawing
$dir = Join-Path $PSScriptRoot 'icons'
$sizes = 256, 64, 48, 32, 24, 16

function Resize-Png([System.Drawing.Image]$img, [int]$n) {
  $bmp = New-Object System.Drawing.Bitmap $n, $n
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'AntiAlias'; $g.PixelOffsetMode = 'HighQuality'; $g.CompositingQuality = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($img, 0, 0, $n, $n)
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  return ,$ms.ToArray()
}

Get-ChildItem $dir -Filter *.png | ForEach-Object {
  $img = [System.Drawing.Image]::FromFile($_.FullName)
  $pngs = foreach ($n in $sizes) { ,(Resize-Png $img $n) }
  $img.Dispose()
  $out = New-Object System.IO.MemoryStream
  $w = New-Object System.IO.BinaryWriter $out
  $w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
  $offset = 6 + 16 * $sizes.Count
  for ($i = 0; $i -lt $sizes.Count; $i++) {
    $n = $sizes[$i]; $len = $pngs[$i].Length
    $w.Write([byte]($n % 256)); $w.Write([byte]($n % 256)); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$len); $w.Write([UInt32]$offset)
    $offset += $len
  }
  foreach ($p in $pngs) { $w.Write($p) }
  $w.Flush()
  $ico = [System.IO.Path]::ChangeExtension($_.FullName, '.ico')
  [System.IO.File]::WriteAllBytes($ico, $out.ToArray())
  $w.Dispose()
  Write-Output ("{0} -> {1} ({2} Ko)" -f $_.Name, (Split-Path $ico -Leaf), [math]::Round((Get-Item $ico).Length / 1KB))
}
