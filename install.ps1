<#
.SYNOPSIS
  One-command Windows installer for the Virtual Lab platform (HO1a).
  Checks Docker, creates .env from .env.example with two fresh secrets
  (only when .env is absent), runs docker compose up -d --build and
  prints the health URL. Never prompts, never echoes a secret.

.DESCRIPTION
  Intent-level pseudocode (every path traced before implementation):
    Work next to this script, never in the caller's current directory.
    If the docker command cannot be found
        -> fail "Docker is not running or not installed", write nothing.
    Ask the daemon (docker info), discarding its output.
    If the daemon check exits non-zero
        -> fail "Docker is not running...", write nothing, no compose call.
    If .env exists but is a directory -> fail.
    If .env exists as a file -> leave it byte-for-byte untouched, say so;
        read it leniently and warn (by key name only, never a value) for
        each secret key that is missing, blank or still the placeholder;
        the run continues either way.
    Otherwise create it from .env.example:
        Read the template as bytes; remember a UTF-8 BOM if present;
        decode the rest as strict UTF-8 (invalid bytes -> fail closed).
        For each secret key require exactly one key line at column 0
        (zero or several -> fail closed, naming the key, no .env).
        Draw two independent CSPRNG secrets (32 bytes -> 64 lowercase
        hex); assert length, charset and inequality before any write.
        Splice the two values in without touching any other byte
        (line endings, comments and a missing final newline survive).
        Re-encode as UTF-8, restore the BOM if there was one, write a
        temp file beside .env, then move it onto .env without ever
        overwriting; always clean the temp file up.
    Read FRONTEND_PORT from .env (the last key line wins, dotenv style);
    warn if it is missing or not a port number, but never abort over it.
    If the environment sets FRONTEND_PORT to a valid port that differs
    from the .env value (or the .env value is invalid), print a NOTE
    with that URL - compose gives the environment precedence.
    For each secret key (DB_PASSWORD, ADMIN_TOKEN): if the process
    environment sets it to a non-empty value, print a NOTE naming the
    key only (never the value) - compose uses the environment value
    instead of the .env one.
    Run docker compose up -d --build, streaming its output to the console.
    If compose exits non-zero -> fail, KEEPING the new .env (the database
    volume may already be initialised with its password).
    Print the health URL and the first-build note; exit 0.

  Error handling: cmdlet errors abort ($ErrorActionPreference = 'Stop');
  every native docker call runs through one helper under 'Continue' and
  is judged by $LASTEXITCODE only (PowerShell 5.1 throws on redirected
  native stderr under 'Stop'). Failures print "FAILED: ..." and exit 1.

  This file is ASCII on purpose (Windows PowerShell 5.1 reads BOM-less
  files as ANSI). Compatible with Windows PowerShell 5.1 and pwsh 7.
  Secrets exist only in memory and in .env: never on a command line,
  in a message, in a log or in the docker argv.
#>

$ErrorActionPreference = 'Stop'

function Fail([string]$msg) { Write-Host "FAILED: $msg"; exit 1 }
function Step([string]$msg) { Write-Host "== $msg" }

# One place for every native docker call: 'Continue' locally so a native
# stderr line can never become a PowerShell exception; the exit code is
# the only verdict. Always call the bare name 'docker' (no .exe suffix),
# so a .cmd shim
# first on PATH resolves (real Docker Desktop and test fakes alike).
function Invoke-Docker {
    param([string[]]$DockerArgs, [switch]$ShowOutput)
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($ShowOutput) { & docker @DockerArgs | Out-Host }
        else { & docker @DockerArgs *> $null }
        return $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $saved }
}

# One CSPRNG draw: 32 random bytes formatted as 64 lowercase hex chars.
# The shape checks are internal invariants (a failure is a bug, not bad
# input); they abort before anything is written. The value is returned,
# never printed.
function New-Secret {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $hex = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    if ($hex.Length -ne 64 -or $hex -notmatch '^[0-9a-f]{64}$') {
        Fail 'internal error: secret generation produced an invalid value; nothing was written'
    }
    return $hex
}

# A key line is ^KEY= at column 0 (multiline). Indented, commented or
# export-prefixed lines are not key lines. Returns the last match's raw
# value (dotenv semantics: the last assignment wins), or $null.
function Get-EnvValue([string]$text, [string]$key) {
    $found = [regex]::Matches($text, '(?m)^' + $key + '=[^\r\n]*')
    if ($found.Count -eq 0) { return $null }
    $line = $found[$found.Count - 1].Value
    return $line.Substring($key.Length + 1)
}

# Value cleaning order: cut an unquoted inline comment (' #...'), trim
# whitespace, strip one pair of surrounding quotes.
function Get-CleanValue([string]$raw) {
    $value = $raw
    $comment = [regex]::Match($value, '\s+#')
    if ($comment.Success) { $value = $value.Substring(0, $comment.Index) }
    $value = $value.Trim()
    if ($value.Length -ge 2) {
        $first = $value.Substring(0, 1)
        $last = $value.Substring($value.Length - 1, 1)
        if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
            $value = $value.Substring(1, $value.Length - 2)
        }
    }
    return $value
}

# A port value is 1..65535 written as at most five digits. Anything else
# (empty, 0, 70000, abc) is not a port; callers warn, never abort (D9).
function Test-Port([string]$value) {
    if ($value -notmatch '^\d{1,5}$') { return $false }
    $number = [int]$value
    return ($number -ge 1 -and $number -le 65535)
}

$root = $PSScriptRoot
Push-Location -LiteralPath $root
try {
    # --- 1. Docker must be installed and the daemon must answer ---
    Step 'Checking Docker (docker info)'
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Fail "Docker is not running or not installed: the 'docker' command was not found on PATH. Install Docker Desktop, start it, then run install.cmd again."
    }
    $code = Invoke-Docker -DockerArgs @('info')
    if ($code -ne 0) {
        Fail 'Docker is not running. Start Docker Desktop, wait until it reports that the engine is running, then run install.cmd again.'
    }

    # --- 2. .env: create from the template only when absent ---
    $envPath = Join-Path $root '.env'
    if (Test-Path -LiteralPath $envPath -PathType Container) {
        Fail '.env exists but is a directory; move it away, then run install.cmd again'
    }
    # One lenient read of whatever .env is in place after step 2 (D7):
    # a BOM is honoured, invalid bytes become U+FFFD, the read never
    # fails; the values needed here are ASCII.
    $envText = $null
    if (Test-Path -LiteralPath $envPath -PathType Leaf) {
        # Read-only to this installer: never opened for writing, renamed
        # or deleted; bytes, timestamps and ACL stay as they are.
        Write-Host 'Found an existing .env; it was left unchanged (secrets are never regenerated).'
        $envText = [IO.File]::ReadAllText($envPath, [Text.Encoding]::UTF8)
        # Warn by key name only, never by value: a missing, blank or
        # placeholder secret must be pointed out, but the run continues
        # (compose still runs; secrets are never regenerated here).
        foreach ($key in 'DB_PASSWORD', 'ADMIN_TOKEN') {
            $rawSecret = Get-EnvValue $envText $key
            $secretValue = if ($null -eq $rawSecret) { '' } else { Get-CleanValue $rawSecret }
            if ($secretValue -eq '' -or $secretValue -eq 'change-me-before-deploying') {
                Write-Host "WARNING: $key in .env is missing, blank or still the placeholder; set a real value before exposing the platform (see docs/self-host.md)."
            }
        }
    }
    else {
        $examplePath = Join-Path $root '.env.example'
        if (-not (Test-Path -LiteralPath $examplePath -PathType Leaf)) {
            Fail '.env.example not found next to install.ps1 (broken checkout?); no .env was created'
        }
        $templateBytes = [IO.File]::ReadAllBytes($examplePath)
        $offset = 0
        $hasBom = ($templateBytes.Length -ge 3 -and $templateBytes[0] -eq 0xEF -and $templateBytes[1] -eq 0xBB -and $templateBytes[2] -eq 0xBF)
        if ($hasBom) { $offset = 3 }
        try {
            $text = (New-Object Text.UTF8Encoding($false, $true)).GetString($templateBytes, $offset, $templateBytes.Length - $offset)
        }
        catch {
            Fail '.env.example is not valid UTF-8; no .env was created'
        }

        # Exactly one key line per secret key; anything else is a broken
        # template and must fail closed, naming the key, with no .env.
        $splices = @()
        foreach ($key in 'DB_PASSWORD', 'ADMIN_TOKEN') {
            $found = [regex]::Matches($text, '(?m)^' + $key + '=[^\r\n]*')
            if ($found.Count -ne 1) {
                Fail ".env.example must contain exactly one $key= line at column 0 (found $($found.Count)); no .env was created"
            }
            $splices += [pscustomobject]@{ Index = $found[0].Index; Length = $found[0].Length; Key = $key }
        }

        # Two independent CSPRNG draws, asserted before use; they must differ.
        $dbSecret = New-Secret
        $adminSecret = New-Secret
        if ($dbSecret -eq $adminSecret) {
            Fail 'internal error: secret generation produced two equal values; nothing was written'
        }
        $secretByKey = @{ 'DB_PASSWORD' = $dbSecret; 'ADMIN_TOKEN' = $adminSecret }

        # Literal splice, back to front so earlier indexes stay valid.
        # [^\r\n]* stops before the line terminator, so endings survive.
        foreach ($s in ($splices | Sort-Object -Property Index -Descending)) {
            $replacement = $s.Key + '=' + $secretByKey[$s.Key]
            $text = $text.Substring(0, $s.Index) + $replacement + $text.Substring($s.Index + $s.Length)
        }

        $outBytes = (New-Object Text.UTF8Encoding($false)).GetBytes($text)
        if ($hasBom) { $outBytes = ([byte[]](0xEF, 0xBB, 0xBF)) + $outBytes }

        # Temp file in the same directory (ignored by .env.*), then a
        # non-overwriting move: .NET Framework File.Move refuses to
        # overwrite, and the re-check covers a .env created meanwhile.
        $tmpPath = Join-Path $root ('.env.install-' + [Guid]::NewGuid().ToString('N') + '.tmp')
        try {
            [IO.File]::WriteAllBytes($tmpPath, $outBytes)
            if (Test-Path -LiteralPath $envPath) {
                Fail '.env appeared while install was running; it was not overwritten'
            }
            [IO.File]::Move($tmpPath, $envPath)
        }
        catch {
            Fail 'could not create .env (is the folder writable? did .env appear meanwhile?); the existing file, if any, was not overwritten'
        }
        finally {
            # Cleanup must never mask the original outcome: a removal
            # failure (a lock, an ACL) is tolerated, not re-thrown.
            if (Test-Path -LiteralPath $tmpPath -PathType Leaf) {
                Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue
            }
        }
        Write-Host 'Created .env with a new DB_PASSWORD and ADMIN_TOKEN (values not shown; they are stored only in .env).'
        $envText = [IO.File]::ReadAllText($envPath, [Text.Encoding]::UTF8)
    }

    # --- 3. FRONTEND_PORT from .env (last key line wins) ---
    $port = $null
    $rawPort = Get-EnvValue $envText 'FRONTEND_PORT'
    if ($null -ne $rawPort) {
        $cleanPort = Get-CleanValue $rawPort
        if (Test-Port $cleanPort) { $port = [int]$cleanPort }
    }
    if ($null -eq $port) {
        Write-Host 'WARNING: FRONTEND_PORT in .env is missing or not a port number'
    }
    # Compose gives a process-environment variable precedence over .env;
    # a valid, different one deserves a NOTE with its own URL. The .env
    # URL line is still printed whenever the .env value is valid (D9).
    if ($env:FRONTEND_PORT -and (Test-Port $env:FRONTEND_PORT)) {
        $envPort = [int]$env:FRONTEND_PORT
        if ($null -eq $port -or $envPort -ne $port) {
            Write-Host "NOTE: FRONTEND_PORT is set in the environment ($envPort); compose uses it: http://localhost:$envPort/api/health"
        }
    }
    # Compose gives the process environment precedence over .env for the
    # secret keys too: a non-empty environment value silently wins. Name
    # the key only - never the value, no prompt, no secret echo.
    foreach ($key in 'DB_PASSWORD', 'ADMIN_TOKEN') {
        $envValue = [Environment]::GetEnvironmentVariable($key)
        if (-not [string]::IsNullOrEmpty($envValue)) {
            Write-Host "NOTE: $key is set in the environment; compose uses it instead of the .env value."
        }
    }

    # --- 4. compose up; a failure keeps the new .env (the database ---
    # --- volume may already be initialised with its password)      ---
    Step 'Starting the stack (docker compose up -d --build)'
    $code = Invoke-Docker -DockerArgs @('compose', 'up', '-d', '--build') -ShowOutput
    if ($code -ne 0) {
        Fail "docker compose up failed (exit $code). The .env file was kept; fix the problem, then run install.cmd again."
    }

    # --- 5. where to look once the first build finishes ---
    if ($null -ne $port) {
        Write-Host ''
        Write-Host "Health check: http://localhost:$port/api/health"
        Write-Host "Site: http://localhost:$port/"
        Write-Host 'The first start takes 2-5 minutes to build; until then the URL may not answer.'
    }
    Write-Host 'Done.'
}
catch {
    # Fail closed on anything unexpected. The message stays generic on
    # purpose: exception text can echo file content, and no secret may
    # ever reach the console.
    Fail 'unexpected error while installing; no secret was printed and any .env written above was kept'
}
finally {
    Pop-Location
}
exit 0