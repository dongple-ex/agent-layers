<#
.SYNOPSIS
  Bootstrap agent-layers on a Windows machine (Windows PowerShell 5.1 or PowerShell 7).

.DESCRIPTION
  Installs git and Node.js with winget when they are missing, installs the agent-layers CLI,
  registers your setup repository and shows a dry-run plan. Nothing is written into agent
  folders unless you pass -Apply.

.EXAMPLE
  # Download, read, then run (recommended over piping to iex):
  Invoke-RestMethod https://raw.githubusercontent.com/dongple-ex/agent-layers/main/install/install.ps1 -OutFile install-agent-layers.ps1
  notepad .\install-agent-layers.ps1
  powershell -ExecutionPolicy Bypass -File .\install-agent-layers.ps1 -Repo https://github.com/you/my-agent-layers.git

.PARAMETER Repo
  Git URL (or local folder) of your setup repository. Empty creates a new repository from the template.

.PARAMETER Package
  npm package spec of the CLI, for example "agent-layers" (default), "agent-layers@0.1.0" or "github:dongple-ex/agent-layers#v0.1.0".

.PARAMETER InstallAgents
  Also install Claude Code, Codex and GitHub Copilot CLI with winget.

.PARAMETER Apply
  Run "agent-layers apply" at the end (you are still asked to confirm).
#>
param(
  [string]$Repo = '',
  [string]$Package = 'agent-layers',
  [switch]$InstallAgents,
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'

function Test-Command([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-Checked([string]$File, [string[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$File $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

function Install-WingetPackage([string]$Id) {
  Write-Host "Installing $Id with winget..."
  Invoke-Checked 'winget' @('install', '--id', $Id, '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements')
}

function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

if (-not (Test-Command 'winget')) {
  throw 'winget is required. Install "App Installer" from the Microsoft Store and run this script again.'
}
if (-not (Test-Command 'git')) {
  Install-WingetPackage 'Git.Git'
}
if (-not (Test-Command 'node')) {
  Install-WingetPackage 'OpenJS.NodeJS.LTS'
}
Update-SessionPath

$nodeMajor = [int]((& node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 18) {
  throw "Node.js 18.17 or newer is required (found $(& node --version))."
}

if ($InstallAgents) {
  foreach ($id in @('Anthropic.ClaudeCode', 'OpenAI.Codex', 'GitHub.Copilot')) {
    Install-WingetPackage $id
  }
  Write-Host 'Gemini CLI has no winget package; install it with "npm install -g @google/gemini-cli" if you need it.'
  Update-SessionPath
}

Write-Host "Installing the agent-layers CLI ($Package)..."
Invoke-Checked 'npm' @('install', '--global', $Package)
Update-SessionPath

if ($Repo) {
  Invoke-Checked 'agent-layers' @('init', '--from', $Repo)
} else {
  Invoke-Checked 'agent-layers' @('init')
}

& agent-layers doctor
& agent-layers secrets check
& agent-layers plan

if ($Apply) {
  & agent-layers apply
} else {
  Write-Host ''
  Write-Host 'Review the plan above, store missing secrets with "agent-layers secrets set <name>",'
  Write-Host 'then run "agent-layers apply".'
}
