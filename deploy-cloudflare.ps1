# =============================================================================
#  Deploy to Cloudflare: D1 database + a single Worker serving the app and API.
#  Usage:  powershell -ExecutionPolicy Bypass -File deploy-cloudflare.ps1
#  Requires a file named .cf-token in this folder containing a Cloudflare API token.
#  The token value is never printed.
# =============================================================================
param(
  [string]$TokenFile  = '.cf-token',
  [string]$AccountId  = '',
  [string]$DbName     = 'majlis-db',
  [string]$WorkerName = 'majlis-api'
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$API  = 'https://api.cloudflare.com/client/v4'

function Fail([string]$m) { Write-Host ''; Write-Host "[X] $m" -ForegroundColor Red; exit 1 }
function Step([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }
function OK([string]$m)   { Write-Host "    $m" -ForegroundColor Green }

function ErrText($errors) {
  $parts = @()
  foreach ($e in $errors) { $parts += ('' + $e.code + ': ' + $e.message) }
  return ($parts -join ' ; ')
}

# --------------------------------------------------- token
$tf = if ([IO.Path]::IsPathRooted($TokenFile)) { $TokenFile } else { Join-Path $root $TokenFile }
if (-not (Test-Path -LiteralPath $tf)) {
  Fail "Token file not found: $tf
    Create a Cloudflare API token and save it into that file."
}
$token = ([IO.File]::ReadAllText($tf)).Trim()
if ($token.Length -lt 20) { Fail 'Token file content looks invalid.' }
$H = @{ Authorization = "Bearer $token" }

function CF($method, $path, $bodyObj) {
  $req = @{ Method = $method; Uri = ($API + $path); Headers = $H; ContentType = 'application/json; charset=utf-8' }
  if ($null -ne $bodyObj) {
    $jsonBody = ($bodyObj | ConvertTo-Json -Depth 10 -Compress)
    $req.Body = [Text.Encoding]::UTF8.GetBytes($jsonBody)
  }
  try { return Invoke-RestMethod @req }
  catch {
    $msg = $_.Exception.Message
    try {
      $stream = $_.Exception.Response.GetResponseStream()
      $sr = New-Object IO.StreamReader($stream)
      $raw = $sr.ReadToEnd()
      $j = $raw | ConvertFrom-Json
      if ($j.errors) { $msg = ErrText $j.errors }
    } catch { }
    Fail "Request failed: $method $path
    $msg"
  }
}

# --------------------------------------------------- 1) verify token + account
Step 'Verifying API token'
$v = CF GET '/user/tokens/verify' $null
if (-not $v.success) { Fail 'Token is not valid.' }
OK ('Token active (' + $v.result.status + ')')

if (-not $AccountId) {
  Step 'Reading account id'
  $acc = CF GET '/accounts?per_page=50' $null
  if (-not $acc.result -or @($acc.result).Count -eq 0) {
    Fail 'No account returned. Add the "Account Settings: Read" permission to the token, or pass -AccountId.'
  }
  $AccountId = @($acc.result)[0].id
  OK ('Account: ' + @($acc.result)[0].name)
}

# --------------------------------------------------- 2) D1 database
Step ("Preparing D1 database: $DbName")
$list = CF GET ("/accounts/$AccountId/d1/database?name=$DbName&per_page=50") $null
$db = @($list.result) | Where-Object { $_.name -eq $DbName } | Select-Object -First 1
if ($db) {
  OK 'Database already exists'
} else {
  $created = CF POST "/accounts/$AccountId/d1/database" @{ name = $DbName }
  $db = $created.result
  OK 'Database created'
}
$dbId = if ($db.uuid) { $db.uuid } else { $db.id }

# --------------------------------------------------- 3) schema
Step 'Creating tables and seed data'
$schemaPath = Join-Path $root 'worker\schema.sql'
if (-not (Test-Path -LiteralPath $schemaPath)) { Fail 'worker\schema.sql not found' }
$sql = [IO.File]::ReadAllText($schemaPath, [Text.Encoding]::UTF8)
$q = CF POST "/accounts/$AccountId/d1/database/$dbId/query" @{ sql = $sql }
OK ('Executed ' + @($q.result).Count + ' SQL statements')

# --------------------------------------------------- 4) build + upload worker
Step 'Building worker bundle'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'build-worker.ps1') | Out-Host
$bundle = Join-Path $root 'worker\worker.bundle.js'
if (-not (Test-Path -LiteralPath $bundle)) { Fail 'worker.bundle.js was not produced' }

Step 'Uploading worker'
$metaObj = @{
  main_module        = 'worker.js'
  compatibility_date = '2025-01-01'
  bindings           = @(@{ type = 'd1'; name = 'DB'; id = $dbId })
}
$meta = $metaObj | ConvertTo-Json -Depth 10 -Compress
$metaFile = Join-Path $env:TEMP 'majlis-worker-metadata.json'
[IO.File]::WriteAllText($metaFile, $meta, (New-Object Text.UTF8Encoding($false)))

if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { Fail 'curl.exe not found on this machine.' }
$uploadUrl = "$API/accounts/$AccountId/workers/scripts/$WorkerName"
$resp = & curl.exe -s -X PUT $uploadUrl -H "Authorization: Bearer $token" -F "metadata=@$metaFile;filename=metadata.json;type=application/json" -F "worker.js=@$bundle;filename=worker.js;type=application/javascript+module"
Remove-Item -LiteralPath $metaFile -Force -ErrorAction SilentlyContinue
try { $r = $resp | ConvertFrom-Json } catch { Fail "Unexpected response from Cloudflare:
    $resp" }
if (-not $r.success) { Fail ('Worker upload failed: ' + (ErrText $r.errors)) }
OK 'Worker uploaded with D1 binding (DB)'

# --------------------------------------------------- 5) public url
Step 'Enabling workers.dev url'
CF POST "/accounts/$AccountId/workers/scripts/$WorkerName/subdomain" @{ enabled = $true; previews_enabled = $false } | Out-Null
$sub = CF GET "/accounts/$AccountId/workers/subdomain" $null
$appUrl = 'https://' + $WorkerName + '.' + $sub.result.subdomain + '.workers.dev'
OK $appUrl

# --------------------------------------------------- 6) health check
Step 'Health check'
$ready = $false
foreach ($i in 1..10) {
  Start-Sleep -Seconds 3
  try {
    $probe = Invoke-RestMethod -Uri ($appUrl + '/api/me') -Method GET -TimeoutSec 20
    if ($null -ne $probe) { $ready = $true; break }
  } catch {
    $code = 0
    try { $code = $_.Exception.Response.StatusCode.value__ } catch { }
    if ($code -eq 401) { $ready = $true; break }
  }
  Write-Host "    waiting for worker to propagate... ($i/10)"
}
if ($ready) { OK 'Server responds and D1 is bound' }
else { Write-Host '    [!] No response yet - try opening the url in a minute.' -ForegroundColor Yellow }

Write-Host ''
Write-Host '==================================================================' -ForegroundColor Green
Write-Host '  DEPLOYED' -ForegroundColor Green
Write-Host ("  URL   : $appUrl") -ForegroundColor Green
Write-Host '  Login : admin / admin   (change the password right away)' -ForegroundColor Green
Write-Host '==================================================================' -ForegroundColor Green
Write-Host '  To update later: run this script again.' -ForegroundColor DarkGray
Write-Host '  For safety: delete the .cf-token file when done.' -ForegroundColor DarkGray
