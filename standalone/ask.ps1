<#
  ask.ps1  向本机 Codex 投递任务并取回结果

  用法：
    .\ask.ps1 -Prompt "..."                              新开一次性会话 (run)
    .\ask.ps1 -Op resume -Thread <id|名称> -Prompt "..." 续接历史会话
    .\ask.ps1 -Op resume -Last -Prompt "..."             续接最近一个会话
    .\ask.ps1 -Op queue  -Thread <id|名称> -Message "..." 投递到已有会话
    .\ask.ps1 -Op codex  -Args agents,--help             透传任意 codex 参数
    .\ask.ps1 -Status                                     看桥的存活情况
#>
[CmdletBinding()]
param(
  [Parameter(Position=0)][string]$Prompt,
  [ValidateSet('run','resume','queue','codex')][string]$Op = 'run',
  [string]$Thread,
  [string]$Message,
  [string[]]$Args,
  [string]$Cwd,
  [string]$Model,
  [int]$TimeoutMs = 600000,
  [ValidateSet('auto','http','mailbox')][string]$Mode = 'auto',
  [int]$PollMs = 1500,
  [switch]$Last,
  [switch]$NoWait,
  [switch]$Status,
  [int]$TailLines = 30
)

$ErrorActionPreference = 'Stop'
$BridgeDir = $PSScriptRoot
if (-not $BridgeDir) { $BridgeDir = (Get-Location).Path }
$Inbox     = Join-Path $BridgeDir 'mailbox\inbox'
$Results   = Join-Path $BridgeDir 'mailbox\results'
$LogFile   = Join-Path $BridgeDir 'bridge.log'
$ConfigFile= Join-Path $BridgeDir 'bridge.config.json'

function Get-BridgeConfig {
  if (Test-Path $ConfigFile) {
    try { return Get-Content $ConfigFile -Raw | ConvertFrom-Json } catch {}
  }
  [pscustomobject]@{ port = 8787; host = '127.0.0.1' }
}

function Invoke-BridgeHealth {
  $cfg = Get-BridgeConfig
  try { return Invoke-RestMethod -Uri "http://$($cfg.host):$($cfg.port)/health" -TimeoutSec 3 } catch { return $null }
}

function Show-Status {
  $cfg  = Get-BridgeConfig
  $http = Invoke-BridgeHealth
  [pscustomobject]@{
    bridgeDir    = $BridgeDir
    configPort   = $cfg.port
    httpAlive    = [bool]$http
    httpNode     = if ($http) { $http.node } else { $null }
    ops          = if ($http) { ($http.ops -join ',') } else { $null }
    codexPath    = if ($http) { $http.codexPath } else { $null }
    resultsCount = @(Get-ChildItem $Results -Filter *.json -EA SilentlyContinue).Count
  } | Format-List
  if (Test-Path $LogFile) {
    Write-Host "--- bridge.log 末尾 $TailLines 行 ---"
    Get-Content $LogFile -Tail $TailLines
  } else { Write-Host '(还没有 bridge.log)' }
}

if ($Status) { Show-Status; return }

# 组装请求体
$body = [ordered]@{ op = $Op; timeoutMs = $TimeoutMs }
if ($Cwd)   { $body.cwd   = $Cwd }
if ($Model) { $body.model = $Model }
if ($Thread) { $body.thread = $Thread }
if ($Last)   { $body.last = $true }

switch ($Op) {
  'run'    { if (-not $Prompt) { Write-Error 'run 需要 -Prompt'; return }; $body.prompt = $Prompt }
  'resume' { if ($Prompt) { $body.prompt = $Prompt }
             if (-not $Thread -and -not $Last) { Write-Error 'resume 需要 -Thread 或 -Last'; return } }
  'queue'  { if (-not $Thread) { Write-Error 'queue 需要 -Thread'; return }
             if ($null -eq $Message) { Write-Error 'queue 需要 -Message'; return }
             $body.message = $Message }
  'codex'  { if (-not $Args) { Write-Error 'codex 需要 -Args'; return }; $body.args = @($Args) }
}

$cfg = Get-BridgeConfig
$id  = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), (Get-Random -Max 99999)
$body.id = $id

if ($Mode -eq 'auto') { $Mode = if (Invoke-BridgeHealth) { 'http' } else { 'mailbox' } }
Write-Host "[*] id=$id  op=$Op  mode=$Mode"

if ($Mode -eq 'http') {
  $uri = "http://$($cfg.host):$($cfg.port)/$Op"
  $json = $body | ConvertTo-Json -Depth 6 -Compress
  try {
    $r = Invoke-RestMethod -Uri $uri -Method Post -ContentType 'application/json; charset=utf-8' `
                           -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec ([int]($TimeoutMs/1000)+30)
    Write-Host "[*] status=$($r.status) exit=$($r.exitCode) ms=$($r.durationMs)"
    if ($r.stdout) { $r.stdout }
    if ($r.stderr) { Write-Host '--- stderr ---'; $r.stderr }
    return $r
  } catch {
    Write-Warning "HTTP 失败，回退 mailbox: $($_.Exception.Message)"
    $Mode = 'mailbox'
  }
}

# ---- mailbox 兜底 ----
New-Item -ItemType Directory -Force -Path $Inbox, $Results | Out-Null
$reqPath = Join-Path $Inbox "$id.json"
[IO.File]::WriteAllText($reqPath, ($body | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
Write-Host "[*] 已投入 $reqPath"
if ($NoWait) { return }

$resPath  = Join-Path $Results "$id.json"
$deadline = (Get-Date).AddMilliseconds($TimeoutMs + 60000)
while (-not (Test-Path $resPath)) {
  if ((Get-Date) -gt $deadline) { Write-Error '等待超时'; return }
  Start-Sleep -Milliseconds $PollMs
}
$r = $null
for ($i=0; $i -lt 20; $i++) {
  try { $r = Get-Content $resPath -Raw | ConvertFrom-Json; if ($r.id) { break } } catch {}
  Start-Sleep -Milliseconds 250
}
Write-Host "[*] status=$($r.status) exit=$($r.exitCode) ms=$($r.durationMs)"
if ($r.stdout) { $r.stdout }
if ($r.stderr) { Write-Host '--- stderr ---'; $r.stderr }
return $r