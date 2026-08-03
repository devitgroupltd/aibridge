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

function Add-Result([string]$Item, [string]$Status, [string]$Detail = '') {
    $script:results += [pscustomobject]@{ Item = $Item; Status = $Status; Detail = $Detail }
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

$python = Get-Command python -ErrorAction SilentlyContinue
if ($python) {
    Add-Result 'Python (node-gyp dependency)' 'OK' $python.Source
} else {
    Add-Result 'Python (node-gyp dependency)' 'MISSING' 'Install Python 3 and ensure it is on PATH.'
}

# --- 3. Defender exclusion for the worktree root (§7.1) ---------------------------------------
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
$lpKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem'
$lp = (Get-ItemProperty -Path $lpKey -Name LongPathsEnabled -ErrorAction SilentlyContinue).LongPathsEnabled
if ($lp -eq 1) {
    Add-Result 'LongPathsEnabled' 'OK' ''
} else {
    Set-ItemProperty -Path $lpKey -Name LongPathsEnabled -Value 1 -Type DWord
    Add-Result 'LongPathsEnabled' 'SET' 'Was 0, set to 1.'
}

# --- 5. OpenSSH Authentication Agent service (§7.5) --------------------------------------------
$sshAgentCap = Get-WindowsCapability -Online -Name 'OpenSSH.Client*' -ErrorAction SilentlyContinue
if ($sshAgentCap -and $sshAgentCap.State -ne 'Installed') {
    Add-WindowsCapability -Online -Name $sshAgentCap.Name | Out-Null
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
$gitName = git config --global user.name
$gitEmail = git config --global user.email
if ($gitName -and $gitEmail) {
    Add-Result 'git identity' 'OK' "$gitName <$gitEmail>"
} else {
    Add-Result 'git identity' 'MISSING' 'Set git config --global user.name / user.email before running any session that commits.'
}

# --- 8. $STATE and secrets directories (§7.5) ---------------------------------------------------
New-Item -ItemType Directory -Path (Join-Path $state 'sessions') -Force | Out-Null
Add-Result 'State dir' 'OK' $state

New-Item -ItemType Directory -Path $secrets -Force | Out-Null
$envFile = Join-Path $secrets '.env'
if (-not (Test-Path $envFile)) {
    @'
# aibridge secrets - mode-restricted directory, never committed (see plan §4.1, §5.4, §7.5).
# Fill these in once the Telegram supergroup + two bots exist (P-2).
CONTROL_BOT_TOKEN=
FEED_BOT_TOKEN=
SUPERGROUP_CHAT_ID=
'@ | Set-Content -Path $envFile -Encoding utf8
    Add-Result 'Secrets .env template' 'CREATED' $envFile
} else {
    Add-Result 'Secrets .env' 'OK' $envFile
}

# --- 9. repos.toml, seeded with this repo itself (§7.5) -----------------------------------------
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

# --- 10. Claude Code version pin (§12 P-4) -------------------------------------------------------
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
    "Telegram (P-2): create a supergroup, enable Topics, create two bots via @BotFather, promote the control bot to admin with can_manage_topics, add both tokens + the chat id to $envFile."
    "channelsEnabled (§4.1): confirm it is ON for whatever claude.ai org this machine's 'claude' login belongs to (Admin settings -> Claude Code -> Channels)."
    "Monthly spend limit (P-5): set under claude.ai Settings -> Usage before any unattended run."
    "Claude Code login: run 'claude' once interactively and complete the browser login, as the account the Bridge will run as."
)
Write-Host "== Still needs a human (cannot be scripted) ==" -ForegroundColor Yellow
$manual | ForEach-Object { Write-Host "- $_" }
