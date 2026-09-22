# Bundles the front-end (index.html, css, js) INTO worker/worker.js
# Output: worker/worker.bundle.js  -> one Cloudflare Worker serving both the app and the API.
# Run: powershell -ExecutionPolicy Bypass -File build-worker.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# Escape a string into an ASCII-only JS/JSON string literal (avoids any encoding issues)
function ConvertTo-JsString([string]$s) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('"')
  foreach ($ch in $s.ToCharArray()) {
    $c = [int]$ch
    switch ($ch) {
      '"'  { [void]$sb.Append('\"'); continue }
      '\'  { [void]$sb.Append('\\'); continue }
      "`n" { [void]$sb.Append('\n'); continue }
      "`r" { [void]$sb.Append('\r'); continue }
      "`t" { [void]$sb.Append('\t'); continue }
      default {
        if ($c -lt 32 -or $c -gt 126) { [void]$sb.AppendFormat('\u{0:x4}', $c) }
        else { [void]$sb.Append($ch) }
      }
    }
  }
  [void]$sb.Append('"')
  return $sb.ToString()
}

$types = @{ '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css; charset=utf-8'; '.js' = 'application/javascript; charset=utf-8'; '.svg' = 'image/svg+xml'; '.json' = 'application/json; charset=utf-8' }

# Files served by the Worker. config.js is generated (points the app at its own origin).
$files = @(
  @{ url = '/index.html';    path = 'index.html' },
  @{ url = '/css/style.css'; path = 'css\style.css' },
  @{ url = '/js/store.js';   path = 'js\store.js' },
  @{ url = '/js/designer.js';path = 'js\designer.js' },
  @{ url = '/js/app.js';     path = 'js\app.js' }
)

$entries = New-Object System.Collections.Generic.List[string]
foreach ($f in $files) {
  $full = Join-Path $root $f.path
  if (-not (Test-Path -LiteralPath $full)) { throw "Missing file: $($f.path)" }
  $content = [IO.File]::ReadAllText($full, [Text.Encoding]::UTF8)
  $ext = [IO.Path]::GetExtension($full).ToLower()
  $entries.Add((ConvertTo-JsString $f.url) + ':{ct:' + (ConvertTo-JsString $types[$ext]) + ',body:' + (ConvertTo-JsString $content) + '}')
  Write-Host ("  + {0,-18} {1,8:N0} bytes" -f $f.url, $content.Length)
}

# Generated config: the deployed app talks to its own origin
$cfg = "window.APP_CONFIG = { apiUrl: window.location.origin };" + "`n"
$entries.Add((ConvertTo-JsString '/config.js') + ':{ct:' + (ConvertTo-JsString $types['.js']) + ',body:' + (ConvertTo-JsString $cfg) + '}')
Write-Host ("  + {0,-18} {1,8:N0} bytes (generated)" -f '/config.js', $cfg.Length)

$assets = 'const ASSETS = {' + ($entries -join ',') + '};'

$workerPath = Join-Path $root 'worker\worker.js'
$worker = [IO.File]::ReadAllText($workerPath, [Text.Encoding]::UTF8)
$marker = 'const ASSETS = null; /* __ASSETS__ */'
if ($worker -notmatch [regex]::Escape($marker)) { throw 'Marker not found in worker/worker.js' }
$bundle = $worker.Replace($marker, $assets)

$outPath = Join-Path $root 'worker\worker.bundle.js'
[IO.File]::WriteAllText($outPath, $bundle, (New-Object Text.UTF8Encoding($false)))
Write-Host ""
Write-Host ("Built worker/worker.bundle.js  ({0:N0} bytes)" -f $bundle.Length) -ForegroundColor Green
