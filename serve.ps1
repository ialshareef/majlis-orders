# Simple local static file server for the app: http://localhost:8090
# Port 8080 is reserved by Windows on this machine (netsh excludedportrange), so 8090 is the default.
# Run: right-click > Run with PowerShell   (or: powershell -ExecutionPolicy Bypass -File serve.ps1)
param([int]$Port = 8090, [switch]$NoOpen)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$listener = New-Object System.Net.HttpListener
# "http://+:$Port" يغطي الجهاز نفسه والجوال على نفس الشبكة معاً.
# يتطلب حجزاً مسبقاً (netsh http add urlacl url=http://+:$Port/ user=...) أو صلاحية مدير،
# وبدونهما نرجع إلى localhost فقط.
try { $listener.Prefixes.Add("http://+:$Port/") }
catch { $listener.Prefixes.Add("http://localhost:$Port/") }
$listener.Start()
Write-Host "Majlis Orders System running at: http://localhost:$Port/  (Ctrl+C to stop)"
if (-not $NoOpen) { try { Start-Process "http://localhost:$Port/" } catch {} }

$types = @{ '.html'='text/html; charset=utf-8'; '.css'='text/css; charset=utf-8'; '.js'='application/javascript; charset=utf-8'; '.json'='application/json; charset=utf-8'; '.png'='image/png'; '.svg'='image/svg+xml'; '.ico'='image/x-icon'; '.webmanifest'='application/manifest+json'; '.sql'='text/plain; charset=utf-8' }

# قائمة سماح صريحة لما يُخدم (التطبيق + صفحتا الاختبار وما تجلبانه):
#  ملفات الجذر: index.html, config.js, sw.js, manifest.json
#  المجلدات: css/ js/ icons/ assets/ test/ worker/
# السلوك المتوقع:
#  GET /, /index.html, /js/app.js, /worker/schema.sql, /test/local-test.html => يعمل
#  GET /.cf-token, /.env, /*.token, /*.keystore, /keystore.properties      => 404
#  GET /../README.md, /%2e%2e/.., /..%252f.., أي مسار فيه .. أو مقطع يبدأ بنقطة => 404
#  أي امتداد خارج القائمة (مثل .ps1 أو .md) => 404
$rootFiles = @('index.html', 'config.js', 'sw.js', 'manifest.json')
$rootDirs  = @('css/', 'js/', 'icons/', 'assets/', 'test/', 'worker/')

function Test-AllowedPath([string]$rawPath) {
  # فكّ الترميز تكرارياً لالتقاط %252e وأمثاله، ثم ارفض أي .. أو مقطع نقطي
  $p = $rawPath
  for ($i = 0; $i -lt 3; $i++) {
    $d = [Uri]::UnescapeDataString($p)
    if ($d -eq $p) { break }
    $p = $d
  }
  if ($p.IndexOf([char]0) -ge 0) { return $null }
  $segs = $p.Split('/', [StringSplitOptions]::RemoveEmptyEntries)
  foreach ($s in $segs) {
    if ($s -eq '.' -or $s -eq '..' -or $s.StartsWith('.')) { return $null }
  }
  $rel = ($segs -join '/')
  if (-not $rel) { $rel = 'index.html' }
  # أسماء سرية تُرفض دائماً (دفاع إضافي فوق القائمة)
  $base = Split-Path -Leaf $rel
  if ($base -eq '.env' -or $base -eq '.cf-token' -or $base -eq 'keystore.properties' -or $base -like '*.token' -or $base -like '*.keystore' -or $base -like '*.jks') { return $null }
  # ملف جذر؟
  if ($rel -notlike '*/*') {
    foreach ($f in $rootFiles) { if ($rel -eq $f) { return $rel } }
    return $null
  }
  # داخل مجلد مسموح؟
  $okDir = $false
  foreach ($d in $rootDirs) { if ($rel.StartsWith($d, [StringComparison]::OrdinalIgnoreCase)) { $okDir = $true; break } }
  if (-not $okDir) { return $null }
  # امتداد مسموح؟
  $ext = [IO.Path]::GetExtension($rel).ToLower()
  if (-not $types.ContainsKey($ext)) { return $null }
  return $rel
}

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $rel = Test-AllowedPath $ctx.Request.Url.AbsolutePath
    $file = if ($rel) { Join-Path $root ($rel -replace '/', '\') } else { $null }
    if ($file -and (Test-Path -LiteralPath $file -PathType Leaf) -and ((Resolve-Path -LiteralPath $file).Path).StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
      $bytes = [IO.File]::ReadAllBytes($file)
      $ext = [IO.Path]::GetExtension($file).ToLower()
      $ctx.Response.ContentType = $types[$ext]
      $ctx.Response.Headers.Add('Cache-Control', 'no-cache')
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
      $msg = [Text.Encoding]::UTF8.GetBytes('404 Not Found')
      $ctx.Response.OutputStream.Write($msg, 0, $msg.Length)
    }
    $ctx.Response.Close()
  } catch { }
}
