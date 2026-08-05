<#
.SYNOPSIS
    aibridge P-1 host setup (plan §12, §7.1, §7.5). Prepares a Windows machine to run the Bridge.

.DESCRIPTION
    Idempotent - safe to re-run. Checks each prerequisite and only acts on what is missing, so a
    second developer on a second machine can run this once and get the same starting point without
    re-reading §12 by hand. Anything that cannot be automated (Telegram bot creation, the monthly
    spend limit, the interactive `claude` login) is reported at the end, not attempted here - see
    plans/telegram-claude-session-control-plan.md §4.1, §4.1.1, §7.5, §12 P-1/P-2/P-5.

.NOTES
    Must run elevated: LongPathsEnabled, the Defender exclusion, and the ssh-agent service all need
    HKLM/service-control access. Re-run in an elevated PowerShell if the admin check below fails.
#>

$ErrorActionPreference = 'Stop'
$results = @()

# An unhandled terminating error anywhere below drops straight back to the interactive prompt with
# no indication the script died mid-way - confirmed live 2026-08-04, looked exactly like a hang.
# This trap prints a clear failure banner (and the completed-so-far results table) instead. Steps
# already reported OK/CREATED/etc. above the failure point are genuinely done and safe to skip on
# the next run - only the step that threw needs attention.
trap {
    Write-Host ""
    Write-Host "== SETUP SCRIPT FAILED ==" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host "at: $($_.InvocationInfo.PositionMessage)" -ForegroundColor Red
    if ($results.Count -gt 0) {
        Write-Host ""
        Write-Host "Steps completed before the failure:" -ForegroundColor Yellow
        $results | Format-Table -AutoSize | Out-String | Write-Host
    }
    Write-Host "Fix the error above and re-run this script - completed steps are skipped automatically." -ForegroundColor Yellow
    exit 1
}

function Add-Result([string]$Item, [string]$Status, [string]$Detail = '') {
    $script:results += [pscustomobject]@{ Item = $Item; Status = $Status; Detail = $Detail }
}

# Several checks below (DISM's Get-WindowsCapability -Online in particular, plus bun install and
# any winget/ssh-keygen call) run for real seconds-to-tens-of-seconds with zero console output of
# their own - confirmed live 2026-08-04, indistinguishable from a hang without this. One line per
# step, printed before the work starts, is enough to show progress without spamming.
function Write-Step([string]$Text) {
    Write-Host "-> $Text" -ForegroundColor DarkGray
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).
    IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "Not running elevated. Re-run this script from an Administrator PowerShell - LongPathsEnabled, the Defender exclusion and the ssh-agent service all require it."
    exit 1
}

$repoRoot   = Split-Path -Parent $PSScriptRoot
$state      = Join-Path $env:LOCALAPPDATA 'aibridge'
$secrets    = Join-Path $env:APPDATA 'aibridge'
$worktrees  = 'C:\data\worktrees'
$pinnedClaudeVersion = '2.1.220'   # keep in sync with §2.4 / §12 P-4 - re-check on every Claude Code bump (§10.1)

Write-Host "== aibridge P-1 host setup ==" -ForegroundColor Cyan

# --- 1. Bun -----------------------------------------------------------------------------------
Write-Step "Checking for Bun..."
$bun = Get-Command bun -ErrorAction SilentlyContinue
if ($bun) {
    Add-Result 'Bun' 'OK' (& bun --version)
} else {
    Write-Host "Installing Bun..." -ForegroundColor Yellow
    try {
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            winget install --id Oven-sh.Bun --silent --accept-source-agreements --accept-package-agreements
        } else {
            powershell -Command "irm bun.sh/install.ps1 | iex"
        }
        Add-Result 'Bun' 'INSTALLED' 'Restart your shell (or re-run this script) so PATH picks it up, then re-run to verify.'
    } catch {
        Add-Result 'Bun' 'FAILED' $_.Exception.Message
    }
}

# --- 2. node-pty build toolchain (native module - §12 P-1) -----------------------------------
Write-Step "Checking for MSVC build tools (cl.exe)..."
$cl = Get-Command cl.exe -ErrorAction SilentlyContinue
if ($cl) {
    Add-Result 'MSVC build tools (cl.exe)' 'OK' $cl.Source
} else {
    Write-Host "MSVC build tools not found - installing Visual Studio Build Tools (C++ workload). This can take several minutes..." -ForegroundColor Yellow
    try {
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            winget install --id Microsoft.VisualStudio.2022.BuildTools --silent --accept-source-agreements --accept-package-agreements `
                --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
            Add-Result 'MSVC build tools (cl.exe)' 'INSTALLED' 'Open a new shell after this finishes; cl.exe is on a VS dev-environment PATH, not the plain user PATH.'
        } else {
            Add-Result 'MSVC build tools (cl.exe)' 'MISSING' 'winget not available - install Visual Studio Build Tools manually (Desktop development with C++ workload).'
        }
    } catch {
        Add-Result 'MSVC build tools (cl.exe)' 'FAILED' $_.Exception.Message
    }
}

Write-Step "Checking for Python (node-gyp dependency)..."
$python = Get-Command python -ErrorAction SilentlyContinue
if ($python) {
    Add-Result 'Python (node-gyp dependency)' 'OK' $python.Source
} else {
    Add-Result 'Python (node-gyp dependency)' 'MISSING' 'Install Python 3 and ensure it is on PATH.'
}

# --- 3. Defender exclusion for the worktree root (§7.1) ---------------------------------------
Write-Step "Checking Defender exclusion for $worktrees..."
if (-not (Test-Path $worktrees)) {
    New-Item -ItemType Directory -Path $worktrees -Force | Out-Null
}
$currentExclusions = (Get-MpPreference).ExclusionPath
if ($currentExclusions -contains $worktrees) {
    Add-Result 'Defender exclusion' 'OK' $worktrees
} else {
    try {
        Add-MpPreference -ExclusionPath $worktrees
        Add-Result 'Defender exclusion' 'ADDED' $worktrees
    } catch {
        Add-Result 'Defender exclusion' 'FAILED' $_.Exception.Message
    }
}

# --- 4. LongPathsEnabled (§7.1) ----------------------------------------------------------------
Write-Step "Checking LongPathsEnabled..."
$lpKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem'
$lp = (Get-ItemProperty -Path $lpKey -Name LongPathsEnabled -ErrorAction SilentlyContinue).LongPathsEnabled
if ($lp -eq 1) {
    Add-Result 'LongPathsEnabled' 'OK' ''
} else {
    Set-ItemProperty -Path $lpKey -Name LongPathsEnabled -Value 1 -Type DWord
    Add-Result 'LongPathsEnabled' 'SET' 'Was 0, set to 1.'
}

# --- 5. OpenSSH Authentication Agent service (§7.5) --------------------------------------------
# Get-WindowsCapability throws a terminating "Class not registered" COM error on some machines
# (most commonly: invoked from a 32-bit PowerShell host on 64-bit Windows, where the DISM provider
# isn't registered for WOW64 - confirmed live 2026-08-04, took the whole script down with it since
# -ErrorAction SilentlyContinue doesn't catch a terminating provider-init exception, only ordinary
# non-terminating error records). Wrapped so this one prerequisite degrades to a reported step
# instead of aborting everything after it - the ssh-agent service already ships in Windows 10+ by
# default in most cases, so this capability check is a nice-to-have, not load-bearing.
Write-Step "Checking OpenSSH.Client capability (this runs a DISM scan and can take 10-30s with no output)..."
try {
    $sshAgentCap = Get-WindowsCapability -Online -Name 'OpenSSH.Client*' -ErrorAction Stop
    if ($sshAgentCap -and $sshAgentCap.State -ne 'Installed') {
        Add-WindowsCapability -Online -Name $sshAgentCap.Name | Out-Null
    }
} catch {
    Add-Result 'OpenSSH.Client capability check' 'SKIPPED' "$($_.Exception.Message) - if this is 'Class not registered', re-run from a 64-bit PowerShell (System32\WindowsPowerShell, not SysWOW64), or install the capability manually via Settings -> Optional Features."
}

$svc = Get-Service ssh-agent -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.StartType -ne 'Automatic') {
        Set-Service ssh-agent -StartupType Automatic
    }
    if ($svc.Status -ne 'Running') {
        Start-Service ssh-agent
    }
    Add-Result 'ssh-agent service' 'OK' 'StartupType=Automatic, running'
} else {
    Add-Result 'ssh-agent service' 'MISSING' 'OpenSSH Client capability not available on this machine - install it manually.'
}

# --- 6. Fleet-only deploy key (§7.5 - dedicated, separately revocable) -------------------------
Write-Step "Checking fleet SSH deploy key..."
$sshDir = Join-Path $secrets 'ssh'
$fleetKey = Join-Path $sshDir 'aibridge-fleet'
if (-not (Test-Path $fleetKey)) {
    New-Item -ItemType Directory -Path $sshDir -Force | Out-Null
    ssh-keygen -t ed25519 -f $fleetKey -N '""' -C 'aibridge-fleet' -q
    Add-Result 'Fleet SSH key' 'GENERATED' "$fleetKey(.pub) - add the .pub as a deploy key on each registered repo's remote, then: ssh-add $fleetKey"
} else {
    $loaded = (ssh-add -l 2>$null) -join "`n"
    Add-Result 'Fleet SSH key' 'OK' "$fleetKey exists. Run 'ssh-add $fleetKey' if it is not already loaded in the agent."
}

# --- 7. git identity (§7.5 - required for commits made from a worktree) ------------------------
Write-Step "Checking git identity..."
$gitName = git config --global user.name
$gitEmail = git config --global user.email
if ($gitName -and $gitEmail) {
    Add-Result 'git identity' 'OK' "$gitName <$gitEmail>"
} else {
    Add-Result 'git identity' 'MISSING' 'Set git config --global user.name / user.email before running any session that commits.'
}

# --- 8. Workspace dependencies (bun install) -----------------------------------------------------
Write-Step "Installing workspace dependencies (bun install) - first run can take a minute..."
try {
    Push-Location $repoRoot
    & bun install
    Pop-Location
    Add-Result 'bun install' 'OK' $repoRoot
} catch {
    Pop-Location -ErrorAction SilentlyContinue
    Add-Result 'bun install' 'FAILED' $_.Exception.Message
}

# --- 9. Voice input: ffmpeg + whisper.cpp (self-hosted transcription) -------------------------
# Fully mechanical - nothing here needs a human, so it belongs in this script rather than a
# separate one-off. Voice input itself defaults to enabled (config.ts) - startWhisperServer warns
# once and no-ops rather than crash-looping if these prerequisites aren't installed yet, so running
# this step is what actually turns transcription on, not a separate .env edit.
Write-Step "Checking ffmpeg..."
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if ($ffmpeg) {
    Add-Result 'ffmpeg' 'OK' $ffmpeg.Source
} else {
    try {
        winget install --id Gyan.FFmpeg --silent --accept-source-agreements --accept-package-agreements
        Add-Result 'ffmpeg' 'INSTALLED' 'Restart your shell (or re-run this script) so PATH picks it up.'
    } catch {
        Add-Result 'ffmpeg' 'FAILED' $_.Exception.Message
    }
}

Write-Step "Checking whisper.cpp (voice transcription)..."
$voiceDir = Join-Path $state 'voice'
$whisperZip = Join-Path $voiceDir 'whisper-bin-x64.zip'
$whisperServerExe = Join-Path $voiceDir 'whisper-server.exe'
# medium: ~5GB RAM at runtime, comfortably faster than realtime on CPU, meaningfully better
# accuracy than small/base - see the voice-input design changelog entry for the full trade-off.
# Bump to ggml-large-v3-turbo.bin (same URL pattern) later if this machine has GPU headroom to spare.
$modelFile = Join-Path $voiceDir 'ggml-medium.bin'

New-Item -ItemType Directory -Path $voiceDir -Force | Out-Null

if (-not (Test-Path $whisperServerExe)) {
    try {
        Write-Host "Downloading whisper.cpp (whisper-bin-x64.zip)..." -ForegroundColor Yellow
        Invoke-WebRequest -Uri 'https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip' -OutFile $whisperZip
        Expand-Archive -Path $whisperZip -DestinationPath $voiceDir -Force
        Remove-Item $whisperZip -Force -ErrorAction SilentlyContinue
        if (Test-Path $whisperServerExe) {
            Add-Result 'whisper.cpp server' 'INSTALLED' $whisperServerExe
        } else {
            # Not independently confirmed which exact release asset bundles whisper-server.exe
            # alongside whisper-cli.exe (§10.0-style discipline: don't assert an unverified shape) -
            # if the release layout changed, this reports it instead of silently pointing at
            # nothing. Check $voiceDir manually and adjust WHISPER_SERVER_EXE in .env if needed.
            Add-Result 'whisper.cpp server' 'FAILED' "whisper-server.exe not found after extracting whisper-bin-x64.zip - check $voiceDir manually; the release layout may differ from what this script expects."
        }
    } catch {
        Add-Result 'whisper.cpp server' 'FAILED' $_.Exception.Message
    }
} else {
    Add-Result 'whisper.cpp server' 'OK' $whisperServerExe
}

if (-not (Test-Path $modelFile)) {
    try {
        Write-Host "Downloading the medium Whisper model (~1.5GB - this can take a while)..." -ForegroundColor Yellow
        Invoke-WebRequest -Uri 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin' -OutFile $modelFile
        Add-Result 'whisper model (medium)' 'DOWNLOADED' "$modelFile ($([math]::Round((Get-Item $modelFile).Length / 1MB)) MB)"
    } catch {
        Add-Result 'whisper model (medium)' 'FAILED' $_.Exception.Message
    }
} else {
    Add-Result 'whisper model (medium)' 'OK' $modelFile
}

# --- 10. $STATE and secrets directories (§7.5) ---------------------------------------------------
Write-Step "Checking state/secrets directories..."
New-Item -ItemType Directory -Path (Join-Path $state 'sessions') -Force | Out-Null
Add-Result 'State dir' 'OK' $state

New-Item -ItemType Directory -Path $secrets -Force | Out-Null
$envFile = Join-Path $secrets '.env'
$envValues = [ordered]@{ CONTROL_BOT_TOKEN = ''; FEED_BOT_TOKEN = ''; SUPERGROUP_CHAT_ID = '' }
$envExisted = Test-Path $envFile
if ($envExisted) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*)$' -and $envValues.Contains($Matches[1])) {
            $envValues[$Matches[1]] = $Matches[2].Trim()
        }
    }
}
$envBefore = [ordered]@{}
foreach ($k in $envValues.Keys) { $envBefore[$k] = $envValues[$k] }

# --- 10a. Guided Telegram setup (P-2) - prompts for whatever's still missing, walks through the
# manual @BotFather/supergroup steps first since nothing here can be scripted, then offers to
# auto-detect the chat id (the one value with no UI anywhere that just shows it to you) via a live
# getUpdates call once both tokens are known. Only asks for what's missing - a second run with a
# fully-populated .env skips this section entirely. -----------------------------------------------
if ($envValues['CONTROL_BOT_TOKEN'] -and $envValues['FEED_BOT_TOKEN'] -and $envValues['SUPERGROUP_CHAT_ID']) {
    Add-Result 'Telegram secrets' 'OK' $envFile
} else {
    Write-Host ""
    Write-Host "== Telegram setup (P-2) ==" -ForegroundColor Cyan
    Write-Host "You need a Telegram supergroup with Topics enabled, and two bots. If you haven't done this yet:"
    Write-Host "  1. In Telegram, message @BotFather -> /newbot -> create the CONTROL bot (polls for commands)."
    Write-Host "  2. /newbot again -> create the FEED bot (send-only, posts the activity feed)."
    Write-Host "  3. Create a new group, enable Topics in its group settings (turns it into a forum supergroup)."
    Write-Host "  4. Add both bots to the group; promote the CONTROL bot to admin with 'Manage Topics' permission."
    Write-Host ""

    if (-not $envValues['CONTROL_BOT_TOKEN']) {
        $envValues['CONTROL_BOT_TOKEN'] = Read-Host "Paste the CONTROL bot's token from @BotFather (blank to skip and fill in later)"
    }
    if (-not $envValues['FEED_BOT_TOKEN']) {
        $envValues['FEED_BOT_TOKEN'] = Read-Host "Paste the FEED bot's token from @BotFather (blank to skip and fill in later)"
    }

    if (-not $envValues['SUPERGROUP_CHAT_ID']) {
        if ($envValues['CONTROL_BOT_TOKEN']) {
            Write-Host ""
            Write-Host "To auto-detect the chat id: send any message in the supergroup right now (e.g. 'hello'), then press Enter." -ForegroundColor Yellow
            Read-Host "Press Enter once you've sent a message in the group" | Out-Null
            try {
                $updates = Invoke-RestMethod -Uri "https://api.telegram.org/bot$($envValues['CONTROL_BOT_TOKEN'])/getUpdates" -Method Get
                $chatIds = $updates.result | ForEach-Object { $_.message.chat.id } | Where-Object { $_ } | Select-Object -Unique
                if ($chatIds.Count -eq 1) {
                    $envValues['SUPERGROUP_CHAT_ID'] = [string]$chatIds[0]
                    Write-Host "Detected chat id: $($chatIds[0])" -ForegroundColor Green
                } elseif ($chatIds.Count -gt 1) {
                    Write-Host "Found multiple chat ids ($($chatIds -join ', ')) - the bot is in more than one chat." -ForegroundColor Yellow
                    $envValues['SUPERGROUP_CHAT_ID'] = Read-Host "Paste the correct one"
                } else {
                    Write-Host "No messages seen yet - the bot may not be added to the group, or Telegram hasn't delivered the update." -ForegroundColor Yellow
                    $envValues['SUPERGROUP_CHAT_ID'] = Read-Host "Paste the SUPERGROUP_CHAT_ID manually (blank to skip and fill in later)"
                }
            } catch {
                Write-Host "getUpdates call failed: $($_.Exception.Message)" -ForegroundColor Yellow
                $envValues['SUPERGROUP_CHAT_ID'] = Read-Host "Paste the SUPERGROUP_CHAT_ID manually (blank to skip and fill in later)"
            }
        } else {
            $envValues['SUPERGROUP_CHAT_ID'] = Read-Host "Paste the SUPERGROUP_CHAT_ID manually (blank to skip and fill in later)"
        }
    }

    if ($envValues['CONTROL_BOT_TOKEN'] -and $envValues['FEED_BOT_TOKEN'] -and $envValues['SUPERGROUP_CHAT_ID']) {
        Add-Result 'Telegram secrets' 'COMPLETE' $envFile
    } else {
        Add-Result 'Telegram secrets' 'INCOMPLETE' "Fill in the remaining blank value(s) in $envFile before starting the Bridge."
    }
}

$envChanged = (-not $envExisted) -or ($envValues['CONTROL_BOT_TOKEN'] -ne $envBefore['CONTROL_BOT_TOKEN']) `
    -or ($envValues['FEED_BOT_TOKEN'] -ne $envBefore['FEED_BOT_TOKEN']) `
    -or ($envValues['SUPERGROUP_CHAT_ID'] -ne $envBefore['SUPERGROUP_CHAT_ID'])
if ($envChanged) {
    @"
# aibridge secrets - mode-restricted directory, never committed (see plan §4.1, §5.4, §7.5).
CONTROL_BOT_TOKEN=$($envValues['CONTROL_BOT_TOKEN'])
FEED_BOT_TOKEN=$($envValues['FEED_BOT_TOKEN'])
SUPERGROUP_CHAT_ID=$($envValues['SUPERGROUP_CHAT_ID'])
"@ | Set-Content -Path $envFile -Encoding utf8
}

# --- 11. repos.toml, seeded with this repo itself (§7.5) -----------------------------------------
Write-Step "Checking repos.toml..."
$reposToml = Join-Path $state 'repos.toml'
if (-not (Test-Path $reposToml)) {
    $repoPathToml = $repoRoot -replace '\\', '\\'
    @"
[aibridge]
path  = '$repoPathToml'
base  = "main"
model = "sonnet"
"@ | Set-Content -Path $reposToml -Encoding utf8
    Add-Result 'repos.toml' 'CREATED' "$reposToml (registered: aibridge -> $repoRoot)"
} else {
    Add-Result 'repos.toml' 'OK' $reposToml
}

# --- 12. Claude Code version pin (§12 P-4) -------------------------------------------------------
Write-Step "Checking Claude Code version..."
$claude = Get-Command claude -ErrorAction SilentlyContinue
if ($claude) {
    $ver = (& claude --version) 2>$null
    if ($ver -match [regex]::Escape($pinnedClaudeVersion)) {
        Add-Result 'Claude Code version' 'OK' $ver
    } else {
        Add-Result 'Claude Code version' 'MISMATCH' "Found '$ver', plan is pinned to $pinnedClaudeVersion - re-run the §12 P-4 protocol probe on a version bump."
    }
} else {
    Add-Result 'Claude Code CLI' 'MISSING' 'Install Claude Code and log in interactively once (§7.5) before the Bridge can spawn sessions.'
}

# --- Report --------------------------------------------------------------------------------------
Write-Host ""
Write-Host "== Result =="  -ForegroundColor Cyan
$results | Format-Table -AutoSize | Out-String | Write-Host

$manual = @(
    "channelsEnabled (§4.1): confirm it is ON for whatever claude.ai org this machine's 'claude' login belongs to (Admin settings -> Claude Code -> Channels)."
    "Monthly spend limit (P-5): set under claude.ai Settings -> Usage before any unattended run."
    "Claude Code login: run 'claude' once interactively and complete the browser login, as the account the Bridge will run as."
    "Fleet SSH deploy key: add the .pub (see 'Fleet SSH key' above) as a deploy key on every repo registered in $reposToml."
)
if (-not ($envValues['CONTROL_BOT_TOKEN'] -and $envValues['FEED_BOT_TOKEN'] -and $envValues['SUPERGROUP_CHAT_ID'])) {
    $manual += "Telegram secrets: fill in the remaining blank value(s) in $envFile - re-run this script and it will prompt for just those."
}
if (-not (Test-Path $whisperServerExe)) {
    $manual += "Voice input: enabled by default, but whisper-server.exe wasn't installed above (see the 'whisper.cpp server' result) - the Bridge will warn once and skip it until this is fixed. Set VOICE_ENABLED=false in $envFile to silence the warning instead."
}
Write-Host "== Still needs a human (cannot be scripted) ==" -ForegroundColor Yellow
$manual | ForEach-Object { Write-Host "- $_" }
Write-Host ""
Write-Host "Once secrets + Claude Code login are in place, start the Bridge with: bash scripts/dev-bridge.sh start" -ForegroundColor Cyan
