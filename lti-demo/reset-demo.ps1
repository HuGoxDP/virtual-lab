<#
.SYNOPSIS
  Brings the LTI demo stand to a clean, demo-ready state with one command. Idempotent; never
  runs `down -v`, so the Moodle install, the certificates and the tool key stay.

.DESCRIPTION
  Moodle   : LAB101 loses every LTI activity (and with it the gradebook items and grades); the
             accounts teacher/student/student2 are re-seeded and enrolled; the tool registration is
             asserted Active, "Show in activity chooser", launch container "New window" (fixed if not).
  Platform : the two demo scenarios (demo-catalog.json) are created or updated, published, their
             archives uploaded, the category labels repaired; LTI sessions/states are purged
             (registrations and the tool key stay). Other catalog rows are reported, not touched.

  Needs: Docker Desktop with the stand up (`docker compose up -d` in this folder), curl.exe
  (ships with Windows 10+). Needs NO hosts entry and NO trusted CA: the platform is reached with
  `curl --resolve` and the stand CA. This file is ASCII on purpose (Windows PowerShell 5.1 reads
  BOM-less files as ANSI); every Ukrainian string lives in demo-catalog.json (UTF-8).

.PARAMETER ReleaseDir
  Folder with Circuits.zip and Molecules.zip (default: ..\..\ScenarioCreator\ReleaseScenarios).
#>
[CmdletBinding()]
param(
    [string]$ReleaseDir
)

$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
if (-not $ReleaseDir) { $ReleaseDir = Join-Path $PSScriptRoot '..\..\ScenarioCreator\ReleaseScenarios' }

function Fail([string]$msg) { Write-Host "FAILED: $msg" -ForegroundColor Red; exit 1 }
function Step([string]$msg) { Write-Host "== $msg" -ForegroundColor Cyan }

# --- settings (the stand's defaults, overridable from lti-demo/.env like the compose file) ---
$envFile = Join-Path $PSScriptRoot '.env'
$envMap = @{}
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile -Encoding UTF8) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') { $envMap[$Matches[1]] = $Matches[2].Trim('"') }
    }
}
function Setting([string]$name, [string]$default) { if ($envMap.ContainsKey($name)) { $envMap[$name] } else { $default } }
$token    = Setting 'LTI_PLATFORM_ADMIN_TOKEN' 'lti-demo-admin-token'
$base     = 'https://lab.lti.test'
$ca       = Join-Path $PSScriptRoot 'certs\ca.crt'
$tmp      = Join-Path ([IO.Path]::GetTempPath()) ('lti-reset-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null

foreach ($cmd in 'docker', 'curl.exe') {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Fail "$cmd not found on PATH" }
}
if (-not (Test-Path $ca)) { Fail "certs\ca.crt missing: run 'docker compose up -d' once" }

# --- platform API through curl.exe: JSON bodies go as UTF-8 files, answers come back as UTF-8 files ---
function Invoke-Api([string]$method, [string]$path, [string]$jsonBody, [string]$archive) {
    $out = Join-Path $tmp ([Guid]::NewGuid().ToString('N') + '.out')
    $curlArgs = @('-sS', '-o', $out, '-w', '%{http_code}', '-X', $method,
        '--resolve', 'lab.lti.test:443:127.0.0.1', '--cacert', $ca, '--ssl-no-revoke',
        '-H', "Authorization: Bearer $token")
    if ($jsonBody) {
        $bodyFile = Join-Path $tmp ([Guid]::NewGuid().ToString('N') + '.json')
        [IO.File]::WriteAllText($bodyFile, $jsonBody, (New-Object Text.UTF8Encoding($false)))
        $curlArgs += @('-H', 'Content-Type: application/json; charset=utf-8', '--data-binary', "@$bodyFile")
    }
    if ($archive) { $curlArgs += @('-F', "archive=@$archive;type=application/zip") }
    $code = [int](& curl.exe @curlArgs "$base$path")
    $text = if (Test-Path $out) { [IO.File]::ReadAllText($out, [Text.Encoding]::UTF8) } else { '' }
    $json = $null
    if ($text) { try { $json = $text | ConvertFrom-Json } catch { } }
    [pscustomobject]@{ Code = $code; Json = $json; Text = $text }
}
function Require-Ok($res, [string]$what) {
    if ($res.Code -lt 200 -or $res.Code -ge 300) { Fail "$what -> HTTP $($res.Code) $($res.Text)" }
}
function Invoke-Sql([string]$sql) {
    $o = & docker compose exec -T platform-db psql -U lab_user -d virtual_lab -v ON_ERROR_STOP=1 -tA -c $sql 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { Fail "psql: $o" }
    $o.Trim()
}

try {
    # --- 1. the stand must be up and healthy ---
    Step 'Waiting for the stand'
    $deadline = (Get-Date).AddMinutes(8)
    foreach ($c in 'LtiDemoMoodleDb', 'LtiDemoMoodle', 'LtiDemoPlatformDb', 'LtiDemoPlatformApi') {
        do {
            $st = (& docker inspect -f '{{.State.Health.Status}}' $c 2>$null | Out-String).Trim()
            if ($st -eq 'healthy') { break }
            if ((Get-Date) -gt $deadline) { Fail "$c is '$st', not healthy (docker compose up -d; docker compose ps)" }
            Start-Sleep -Seconds 5
        } while ($true)
    }
    do {
        $h = Invoke-Api 'GET' '/api/health' $null $null
        if ($h.Code -eq 200) { break }
        if ((Get-Date) -gt $deadline) { Fail "platform health answered $($h.Code) $($h.Text)" }
        Start-Sleep -Seconds 3
    } while ($true)
    Write-Host '   moodle, platform-api and the proxy answer'

    # --- 2. Moodle ---
    Step 'Moodle: accounts and course (seed.php, idempotent)'
    $o = & docker compose exec -T -u daemon moodle php /docker-entrypoint-init.d/10-seed.php 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $o -notmatch 'seed done') { Fail "seed.php: $o" }

    Step 'Moodle: LAB101 emptied of LTI activities, tool settings asserted'
    & docker compose cp (Join-Path $PSScriptRoot 'moodle\reset.php') moodle:/tmp/reset-demo.php 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail 'docker compose cp reset.php' }
    $raw = & docker compose exec -T -u daemon moodle php /tmp/reset-demo.php 2>&1 | Out-String
    $m = @{}
    foreach ($line in $raw -split "`r?`n") { if ($line -match '^([A-Z_]+)=(.*)$') { $m[$Matches[1]] = $Matches[2] } }
    if ($m.ContainsKey('ERROR')) { Fail "Moodle: $($m['ERROR'])" }
    if ($LASTEXITCODE -ne 0 -or -not $m.ContainsKey('USERS_ENROLLED')) { Fail "reset.php: $raw" }
    if ($m['LTI_ACTIVITIES'] -ne '0' -or $m['LTI_GRADE_ITEMS'] -ne '0' -or $m['LTI_GRADES'] -ne '0') { Fail "course not clean: $raw" }
    if ($m['TOOL_STATE'] -ne 'Active' -or $m['TOOL_IN_CHOOSER'] -ne 'yes' -or $m['TOOL_LAUNCH'] -ne 'new window') { Fail "tool settings wrong: $raw" }
    if ($m['USERS_ENROLLED'] -ne 'teacher,student,student2') { Fail "accounts not ready: $($m['USERS_ENROLLED'])" }
    Write-Host "   removed $($m['DELETED_ACTIVITIES']) LTI activit(ies); tool '$($m['TOOL_NAME'])' fixed: $($m['TOOL_FIXED'])"

    # --- 3. platform catalog ---
    Step 'Platform: demo scenarios'
    $catalog = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'demo-catalog.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
    $existing = Invoke-Api 'GET' '/api/admin/scenarios' $null $null
    Require-Ok $existing 'GET /api/admin/scenarios'
    $have = @($existing.Json.scenarios | ForEach-Object { $_.id })
    foreach ($s in $catalog.scenarios) {
        $zip = (Resolve-Path (Join-Path $ReleaseDir $s.archive) -ErrorAction SilentlyContinue)
        if (-not $zip) { Fail "archive not found: $(Join-Path $ReleaseDir $s.archive) (use -ReleaseDir)" }
        if ($s.category -notmatch '^[a-z0-9-]+$') { Fail "bad category slug '$($s.category)'" }
        $fields = [ordered]@{
            title = $s.title; description = $s.description; fullDescription = $s.fullDescription
            category = $s.category; categoryLabel = $s.categoryLabel; version = $s.version
        }
        if ($have -contains $s.id) {
            $r = Invoke-Api 'PUT' "/api/catalog/$($s.id)" ($fields | ConvertTo-Json) $null
            Require-Ok $r "PUT $($s.id)"
        } else {
            $r = Invoke-Api 'POST' '/api/catalog' (([ordered]@{ id = $s.id } + $fields) | ConvertTo-Json) $null
            Require-Ok $r "POST $($s.id)"
        }
        $r = Invoke-Api 'POST' "/api/scenarios/$($s.id)/archive" $null $zip.Path
        Require-Ok $r "archive $($s.id)"
        # Release 2: a new row is a draft and approving needs an archive, so publish AFTER the upload
        # (PUT isPublished is approve; on a row that is already published it changes nothing).
        $r = Invoke-Api 'PUT' "/api/catalog/$($s.id)" '{"isPublished":true}' $null
        Require-Ok $r "publish $($s.id)"
        # The API keeps a stored category label as is (ON CONFLICT DO NOTHING), so repair it in SQL.
        # The text travels as hex of its UTF-8 bytes: no console code page can mangle it.
        $hex = ([Text.Encoding]::UTF8.GetBytes($s.categoryLabel) | ForEach-Object { $_.ToString('x2') }) -join ''
        [void](Invoke-Sql "UPDATE categories SET label = convert_from(decode('$hex','hex'),'UTF8'), is_visible = true WHERE slug = '$($s.category)'")
        Write-Host "   $($s.id): published, archive $($s.archive) uploaded"
    }
    $extra = @($have | Where-Object { $catalog.scenarios.id -notcontains $_ })
    if ($extra.Count) { Write-Host "   note: other catalog rows left alone: $($extra -join ', ')" -ForegroundColor Yellow }

    Step 'Platform: LTI sessions and states purged (registrations and the tool key stay)'
    [void](Invoke-Sql 'DELETE FROM lti_sessions; DELETE FROM lti_states;')
    $regs = Invoke-Sql 'SELECT count(*) FROM lti_registrations'
    if ([int]$regs -lt 1) { Write-Host '   WARNING: no LTI registration on the platform: register the tool again (docs/lti-demo.md)' -ForegroundColor Yellow }

    # --- 4. verify the public catalog, read as UTF-8 ---
    Step 'Verifying GET /api/catalog'
    $pub = Invoke-Api 'GET' '/api/catalog' $null $null
    Require-Ok $pub 'GET /api/catalog'
    $bad = @()
    foreach ($s in $catalog.scenarios) {
        $item = $pub.Json.scenarios | Where-Object { $_.id -eq $s.id }
        if (-not $item -or $item.title -ne $s.title -or $item.categoryLabel -ne $s.categoryLabel) { $bad += $s.id }
    }
    if ($bad.Count) { Fail "catalog titles/labels differ for: $($bad -join ', ')" }
    foreach ($item in $pub.Json.scenarios) { Write-Host ("   {0,-18} {1}  [{2}]" -f $item.id, $item.title, $item.categoryLabel) }

    # --- summary ---
    Write-Host ''
    Write-Host 'DEMO STAND READY' -ForegroundColor Green
    Write-Host '  Moodle    https://moodle.lti.test   (course LAB101, no LTI activities, tool Active, in chooser, New window)'
    Write-Host '  Platform  https://lab.lti.test      (admin token in lti-demo/.env or the default; catalog: electric-circuits [graded], molecules)'
    Write-Host '  Accounts  teacher / Teacher#2026lti   student, student2 / Student#2026lti   admin / Admin#2026lti  (defaults)'
    Write-Host '  Hosts entry and CA trust are one-time steps on this PC (docs/lti-demo.md); this script does not check them.'
    Write-Host '  Cheat sheet: docs/lti-demo-cheatsheet.md'
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
