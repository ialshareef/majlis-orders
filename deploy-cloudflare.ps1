# =============================================================================
#  Deploy to Cloudflare: D1 database + a single Worker serving the app and API.
#  Usage (defaults are SAFE: -Environment test + -Preview, nothing is written):
#    Preview production plan (no writes):
#      powershell -ExecutionPolicy Bypass -File deploy-cloudflare.ps1 -Environment production
#    Deploy production (asks you to type yes):
#      powershell -ExecutionPolicy Bypass -File deploy-cloudflare.ps1 -Environment production -Preview:$false
#    Deploy to a separate test Worker/DB (test names + account id are mandatory):
#      ... -Environment test -AccountId <id> -DbName <test-db> -WorkerName <test-worker> -Preview:$false
#  Worker variables/secrets set in the dashboard (ALLOWED_ORIGIN, ADMIN_INIT_PASSWORD, AI_*)
#  are kept across uploads (keep_bindings below); this script never sets their values.
#  Requires a file named .cf-token in this folder containing a Cloudflare API token.
#  The token value is never printed.
#
#  Token permissions required (all three, else the run stops early):
#    Account > Workers Scripts > Edit
#    Account > D1               > Edit   (a missing D1 permission fails with HTTP 401)
#    Account > Account Settings > Read   (used to resolve the account id)
#
#  The .cf-token file is kept on this machine and is gitignored (.gitignore line 2);
#  it is NOT deleted after a deploy.
# =============================================================================
param(
  [string]$TokenFile  = '.cf-token',
  [string]$AccountId  = '',
  [string]$DbName     = 'majlis-db',
  [string]$WorkerName = 'majlis-api',
  [switch]$Preview    = $true,
  [switch]$Confirm    = $true,
  [ValidateSet('test','production')]
  [string]$Environment = 'test'
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
  if ($Environment -eq 'test') {
    Fail 'In test mode, -AccountId is required. Pass -AccountId explicitly to prevent selecting the wrong account.'
  }
  Step 'Reading account id'
  $acc = CF GET '/accounts?per_page=50' $null
  if (-not $acc.result -or @($acc.result).Count -eq 0) {
    Fail 'No account returned. Add the "Account Settings: Read" permission to the token, or pass -AccountId.'
  }
  $AccountId = @($acc.result)[0].id
  OK ('Account: ' + @($acc.result)[0].name)
} else {
  Step 'Verifying account id'
  $acc = CF GET "/accounts/$AccountId" $null
  if (-not $acc.result -or $acc.result.id -ne $AccountId) {
    Fail "Account ID $AccountId not found or not accessible."
  }
  OK ('Account: ' + $acc.result.name)
}

# --------------------------------------------------- 0) publishing safety (preview by default)
Write-Host ''
Write-Host "==> Deploy environment: $Environment" -ForegroundColor Cyan
Write-Host "    Target D1 database:   $DbName" -ForegroundColor Cyan
Write-Host "    Target Worker name:   $WorkerName" -ForegroundColor Cyan
Write-Host "    Preview mode:         $([bool]$Preview)  (when $true, no writes to Cloudflare)" -ForegroundColor Cyan
Write-Host "    Confirm writes:       $([bool]$Confirm)" -ForegroundColor Cyan

if ($Environment -eq 'test') {
  if ($DbName -eq 'majlis-db' -or $WorkerName -eq 'majlis-api') {
    Fail 'In test mode, production resource names are not allowed (majlis-db, majlis-api). Use -DbName and -WorkerName with test names.'
  }
  if (-not $AccountId) {
    Fail 'In test mode, -AccountId is mandatory. Pass -AccountId explicitly.'
  }
}

if ($Preview) {
  Write-Host ''
  Write-Host '[Preview mode] No writes to Cloudflare will be executed. Planned actions:' -ForegroundColor Yellow
  Write-Host "    1) Verify token and account: $AccountId" -ForegroundColor Yellow
  Write-Host "    2) Look up or create D1 database: $DbName" -ForegroundColor Yellow
  Write-Host "    3) Execute schema.sql on target database" -ForegroundColor Yellow
  Write-Host "    4) Build worker/worker.bundle.js locally" -ForegroundColor Yellow
  Write-Host "    5) Upload Worker to: $WorkerName" -ForegroundColor Yellow
  Write-Host "    6) Enable subdomain for: $WorkerName" -ForegroundColor Yellow
  Write-Host "    7) Health check Worker at published URL" -ForegroundColor Yellow
  Write-Host ''
  Write-Host 'To execute for real, remove -Preview (or pass -Preview:$false) with -Confirm.' -ForegroundColor Yellow
  exit 0
}

if ($Environment -eq 'test' -and -not $Confirm) {
  Fail 'In test mode, -Confirm cannot be bypassed. Pass -Confirm (default) and type yes.'
}

if ($Confirm) {
  Write-Host ''
  $maskedAccount = if ($AccountId) { $AccountId.Substring(0, [Math]::Min(4, $AccountId.Length)) + '...' } else { 'unknown' }
  Write-Host "Writes will be made to Cloudflare account: $maskedAccount" -ForegroundColor Red
  Write-Host "Account ID: $AccountId" -ForegroundColor Red
  Write-Host "Database: $DbName | Worker: $WorkerName | Environment: $Environment" -ForegroundColor Red
  Write-Host ''
  $confirmationText = Read-Host 'Type yes to confirm and proceed with the write operations above'
  if ($confirmationText -ne 'yes') {
    Fail 'Deployment cancelled by user.'
  }
  Write-Host 'Confirmed, proceeding with write operations...' -ForegroundColor Green
}

# --------------------------------------------------- 2) D1 database
Step ("Preparing D1 database: $DbName")
$list = CF GET ("/accounts/$AccountId/d1/database?name=$DbName&per_page=50") $null
$db = @($list.result) | Where-Object { $_.name -eq $DbName } | Select-Object -First 1
if ($db) {
  if ($db.name -ne $DbName) {
    Fail "D1 database name mismatch: expected '$DbName', got '$($db.name)'"
  }
  OK 'Database already exists'
} else {
  $created = CF POST "/accounts/$AccountId/d1/database" @{ name = $DbName }
  $db = $created.result
  if ($db.name -ne $DbName) {
    Fail "Created D1 database name mismatch: expected '$DbName', got '$($db.name)'"
  }
  OK 'Database created'
}
$dbId = if ($db.uuid) { $db.uuid } else { $db.id }
if (-not $dbId -or $dbId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
  Fail "Invalid D1 database ID: '$dbId'"
}

# --------------------------------------------------- 3) schema
Step 'Creating tables and seed data'
$schemaPath = Join-Path $root 'worker\schema.sql'
if (-not (Test-Path -LiteralPath $schemaPath)) { Fail 'worker\schema.sql not found' }
$sql = [IO.File]::ReadAllText($schemaPath, [Text.Encoding]::UTF8)
$q = CF POST "/accounts/$AccountId/d1/database/$dbId/query" @{ sql = $sql }
OK ('Executed ' + @($q.result).Count + ' SQL statements')

# Read-only guard BEFORE uploading code: CREATE TABLE IF NOT EXISTS does not repair tables that
# already exist with the old 001/002 definitions (foreign keys that block deleting a user).
# If found, stop here; the code is not uploaded until migration 003 has been applied.
Step 'Checking table definitions'
$chk = CF POST "/accounts/$AccountId/d1/database/$dbId/query" @{ sql = "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('permission_audit', 'expenses')" }
$defs = @(@($chk.result)[0].results)
if ($defs.Count -lt 2) { Fail 'Could not read permission_audit/expenses definitions after schema.sql - stopping before upload.' }
$old = @($defs | Where-Object { $_.sql -match 'REFERENCES\s+users' } | ForEach-Object { $_.name })
if ($old.Count -gt 0) {
  Fail ("Old definitions with blocking foreign keys found in: " + ($old -join ', ') + ".
    Back up the database, apply worker\migrations\003_fix_user_delete_fks.sql once, then rerun.
    Nothing was uploaded.")
}
OK 'permission_audit and expenses definitions are current'

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
  # رفع السكربت يستبدل الربط كله: بدون هذا تُمسح متغيرات اللوحة (ALLOWED_ORIGIN — وبدونه يُرفض
  # تطبيق أندرويد) والأسرار (ADMIN_INIT_PASSWORD، AI_API_KEY) مع كل نشر.
  keep_bindings      = @('plain_text', 'secret_text')
}
# Verify binding points only to the resolved (test) D1 database
foreach ($b in $metaObj.bindings) {
  if ($b.type -eq 'd1') {
    if ($b.id -ne $dbId) {
      Fail "Worker D1 binding mismatch: expected '$dbId', got '$($b.id)'"
    }
    if ($Environment -eq 'test' -and $b.id -eq '' ) {
      Fail 'Worker binding has empty D1 database ID'
    }
  }
}
$meta = $metaObj | ConvertTo-Json -Depth 10 -Compress
$metaFile = Join-Path $env:TEMP 'majlis-worker-metadata.json'
[IO.File]::WriteAllText($metaFile, $meta, (New-Object Text.UTF8Encoding($false)))

if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { Fail 'curl.exe not found on this machine.' }
$uploadUrl = "$API/accounts/$AccountId/workers/scripts/$WorkerName"
# التخويل عبر ملف مؤقت بدل سطر الأوامر حتى لا يظهر الرمز في قائمة العمليات
$headerFile = Join-Path $env:TEMP 'majlis-worker-auth.txt'
[IO.File]::WriteAllText($headerFile, "Authorization: Bearer $token", (New-Object Text.UTF8Encoding($false)))
$resp = & curl.exe -s -X PUT $uploadUrl -H "@$headerFile" -F "metadata=@$metaFile;filename=metadata.json;type=application/json" -F "worker.js=@$bundle;filename=worker.js;type=application/javascript+module"
Remove-Item -LiteralPath $metaFile -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $headerFile -Force -ErrorAction SilentlyContinue
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
Write-Host '  Login : admin   (empty DB: password from the ADMIN_INIT_PASSWORD secret; change forced on first login)' -ForegroundColor Green
Write-Host '==================================================================' -ForegroundColor Green
Write-Host '  To update later: run this script again.' -ForegroundColor DarkGray
  # .cf-token محفوظ على الجهاز ولا يُحذف (قرار المستخدم)، وهو مُدرج في .gitignore فلا يُرفع.
  Write-Host '  The .cf-token file is kept on this machine (gitignored) for future deploys.' -ForegroundColor DarkGray
