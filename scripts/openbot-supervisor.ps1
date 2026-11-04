# OpenBot - supervisor de la pila local (Windows).
#
# Un solo proceso vigila todo lo que debe estar arriba y lo repara solo:
#   Docker -> contenedores -> servidor (3001) -> app (3010) -> worker de rutinas -> puente Telegram.
#
# Cuando algo falta, delega en scripts/start.sh (que ya es idempotente: arranca solo lo que
# falta y verifica identidad en cada puerto). No duplica esa logica: la usa como reconciliador.
#
# Se detiene con el archivo .logs\supervisor.stop (lo crea cierra-openbot.cmd) y arranca de
# nuevo con start-openbot.cmd o al iniciar sesion (carpeta Inicio / scripts\openbot-autostart.cmd).
#
# Uso:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\openbot-supervisor.ps1
#       ( -Once para una sola pasada, util al depurar )

param([switch]$Once)

$ErrorActionPreference = 'Continue'

$Root = Split-Path -Parent $PSScriptRoot
$Logs = Join-Path $Root '.logs'
$LogPath = Join-Path $Logs 'supervisor.log'
$StopFile = Join-Path $Logs 'supervisor.stop'
$BridgeLog = Join-Path $Logs 'telegram-bridge.log'
$Bash = 'C:\Program Files\Git\bin\bash.exe'
$DockerDesktop = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'

New-Item -ItemType Directory -Force -Path $Logs | Out-Null
$env:Path = (Join-Path $env:USERPROFILE '.bun\bin') +
  ';C:\Program Files\Docker\Docker\resources\bin;' + $env:Path

function Write-Log {
  param([string]$Msg)
  try {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Msg
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
  } catch { }
}

function Rotate-Log {
  param([string]$Path, [int]$MaxMB = 20)
  try {
    if ((Test-Path $Path) -and ((Get-Item $Path).Length -gt ($MaxMB * 1MB))) {
      $dest = '{0}.{1}' -f $Path, (Get-Date -Format 'yyyyMMdd-HHmmss')
      Move-Item -Path $Path -Destination $dest -Force
    }
  } catch { }
}

function Get-Setting {
  param([string]$Name, [string]$Default)
  try {
    $envFile = Join-Path $Root '.env'
    $hit = Select-String -Path $envFile -Pattern ('^' + $Name + '=') -ErrorAction SilentlyContinue |
      Select-Object -Last 1
    if (-not $hit) { return $Default }
    $value = $hit.Line.Substring($Name.Length + 1).Trim()
    if ($value.Length -ge 2) {
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
          ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }
    if ($value -eq '') { return $Default }
    return $value
  } catch { return $Default }
}

function Get-Http {
  param([string]$Url, [int]$TimeoutSec = 8)
  try {
    return (Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec).Content
  } catch { return $null }
}

# Ejecuta un comando y devuelve salida y codigo, con timeout. Start-Process -PassThru deja
# ExitCode vacio en este Windows 5.1, y con el se creia que Docker estaba caido estando arriba.
function Invoke-Native {
  param([string]$FileName, [string]$Arguments, [int]$TimeoutMs = 20000)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FileName
  $psi.Arguments = $Arguments
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  try {
    [void]$proc.Start()
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit($TimeoutMs)) {
      try { $proc.Kill() } catch { }
      return $null
    }
    return [pscustomobject]@{ Exit = $proc.ExitCode; Out = $outTask.Result; Err = $errTask.Result }
  } catch { return $null }
}

function Test-Docker {
  $r = Invoke-Native 'docker' 'info --format "{{.ServerVersion}}"' 15000
  return ($null -ne $r -and $r.Exit -eq 0)
}

function Ensure-Docker {
  if (Test-Docker) { return $true }
  Write-Log 'docker no responde; iniciando Docker Desktop'
  if (Test-Path $DockerDesktop) { Start-Process -FilePath $DockerDesktop | Out-Null }
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 5
    if (Test-Docker) {
      Write-Log 'docker arriba'
      return $true
    }
  }
  Write-Log 'docker no arranco en 5 minutos; reintento luego'
  return $false
}

function Get-Containers {
  $r = Invoke-Native 'docker' 'ps --format "{{.Names}}|{{.Status}}"' 20000
  if ($null -eq $r -or $r.Exit -ne 0) { return @() }
  return @($r.Out -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
}

function Test-Server {
  $c = Get-Http 'http://127.0.0.1:3001/api/copilotkit/info' 10
  if ($null -eq $c) { return $false }
  return ($c -match 'licenseStatus')
}

function Test-App {
  $c = Get-Http 'http://127.0.0.1:3010/' 8
  if ($null -eq $c) { return $false }
  return ($c -match '<title>OpenBot')
}

function Test-Health {
  param([int]$Port)
  $c = Get-Http ('http://127.0.0.1:' + $Port + '/health') 6
  return ($null -ne $c)
}

function Get-Worker {
  $procs = Get-CimInstance Win32_Process -Filter "Name like 'bun%'" -ErrorAction SilentlyContinue
  return @($procs | Where-Object {
      $_.CommandLine -and ($_.CommandLine -like '*worker/src/index.ts*' -or
        $_.CommandLine -like '*worker\src\index.ts*')
    })
}

function Get-Bridge {
  $procs = Get-CimInstance Win32_Process -Filter "Name like 'bun%'" -ErrorAction SilentlyContinue
  return @($procs | Where-Object { $_.CommandLine -and $_.CommandLine -like '*telegram-bridge*' })
}

function Start-Bridge {
  Rotate-Log -Path $BridgeLog -MaxMB 25
  $cmd = 'cmd.exe /c set "PATH=%USERPROFILE%\.bun\bin;%PATH%" && cd /d "' + $Root +
    '" && start "" /b bun bridge\telegram-bridge.ts >> .logs\telegram-bridge.log 2>&1'
  try {
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
    Write-Log ('puente: arrancado (pid ' + $r.ProcessId + ')')
  } catch {
    Write-Log ('puente: no pude arrancarlo: ' + $_.Exception.Message)
  }
}

function Start-App {
  # start.sh se detiene en su verificacion de licencia si la nube de CopilotKit responde
  # 'unknown' (paso transitorio al arrancar). El servidor y el worker ya quedaron arriba,
  # asi que la app se levanta igual, con su mismo comando de desarrollo.
  Rotate-Log -Path (Join-Path $Logs 'app.log') -MaxMB 10
  $cmd = 'cmd.exe /c set "PATH=%USERPROFILE%\.bun\bin;%PATH%" && cd /d "' + $Root +
    '\app" && start "" /b bun run dev --port 3010 --strictPort >> ..\.logs\app.log 2>&1'
  try {
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
    Write-Log ('app: arrancada (pid ' + $r.ProcessId + ')')
  } catch {
    Write-Log ('app: no pude arrancarla: ' + $_.Exception.Message)
  }
}

function Update-Bridge {
  $bridge = @(Get-Bridge)
  if ($bridge.Count -eq 0) {
    Write-Log 'puente: no esta; arrancando'
    Start-Bridge
    return
  }
  if ((Test-Path $BridgeLog) -and
    (((Get-Date) - (Get-Item $BridgeLog).LastWriteTime).TotalMinutes -gt 15)) {
    $age = [int]((Get-Date) - (Get-Item $BridgeLog).LastWriteTime).TotalMinutes
    Write-Log ('puente sin latido hace ' + $age + ' min; reiniciando')
    $bridge | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 3
    Start-Bridge
    return
  }
  if ($bridge.Count -gt 1) {
    Write-Log ('hay ' + $bridge.Count + ' puentes; dejo uno')
    $bridge | Sort-Object CreationDate -Descending | Select-Object -Skip 1 |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
}

function Test-WithRetry {
  param([scriptblock]$Check, [int]$Attempts = 2, [int]$WaitSec = 4)
  for ($i = 0; $i -lt $Attempts; $i++) {
    if (& $Check) { return $true }
    if ($i -lt ($Attempts - 1)) { Start-Sleep -Seconds $WaitSec }
  }
  return $false
}

function Get-Problems {
  $problems = New-Object System.Collections.ArrayList
  if (-not (Test-Docker)) {
    [void]$problems.Add('docker')
    return @($problems)
  }
  $rows = Get-Containers
  foreach ($name in $script:Required) {
    $row = $rows | Where-Object { $_ -like ($name + '|*') } | Select-Object -First 1
    if (-not $row) {
      [void]$problems.Add('falta:' + $name)
      continue
    }
    if (($row -notmatch '\|Up ') -or ($row -match 'unhealthy')) {
      [void]$problems.Add('caido:' + $name)
    }
  }
  if (-not (Test-WithRetry { Test-Server })) { [void]$problems.Add('servidor') }
  if (-not (Test-WithRetry { Test-App })) { [void]$problems.Add('app') }
  foreach ($port in $script:HealthPorts) {
    if (-not (Test-WithRetry { Test-Health $port })) { [void]$problems.Add('health:' + $port) }
  }
  if (-not (Get-Worker)) { [void]$problems.Add('worker') }
  return @($problems)
}

function Invoke-Stack {
  param([string]$Why)
  Write-Log ('reconciliando (' + $Why + '): scripts/start.sh')
  Rotate-Log -Path (Join-Path $Logs 'stack.log') -MaxMB 10
  $out = Join-Path $Logs 'stack.log'
  $err = Join-Path $Logs 'stack.err.log'
  try {
    $p = Start-Process -FilePath $Bash -ArgumentList 'scripts/start.sh' -WorkingDirectory $Root `
      -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    if (-not $p.WaitForExit(900000)) {
      try { $p.Kill() } catch { }
      Write-Log 'start.sh no termino en 15 minutos; lo detuve'
      return $false
    }
    # El codigo de salida de Start-Process puede venir vacio: el log de start.sh dice "Ready."
    $ok = $false
    try {
      $text = Get-Content $out -Raw -ErrorAction SilentlyContinue
      if ($text -match 'Ready\. http') { $ok = $true }
    } catch { }
    Write-Log ('start.sh termino; listo=' + $ok)
    return $ok
  } catch {
    Write-Log ('start.sh fallo: ' + $_.Exception.Message)
    return $false
  }
}

# --- instancia unica -------------------------------------------------------
$mutex = New-Object System.Threading.Mutex($false, 'Local\OpenBotSupervisor')
$owner = $false
try { $owner = $mutex.WaitOne(0) } catch { $owner = $false }
if (-not $owner) { exit 0 }

Rotate-Log -Path $LogPath -MaxMB 10
Write-Log '--- supervisor iniciando ---'

if (Test-Path $StopFile) {
  Write-Log 'hay .logs\supervisor.stop; no arranco'
  exit 0
}

# --- que debe estar arriba, segun .env -------------------------------------
$botProvider = (Get-Setting 'BOT_PROVIDER' 'openai').ToLower()
$oneEach = (Get-Setting 'OPENBOT_ONE_COMPUTER_EACH' 'true').ToLower()
$script:Required = @('opbt-postgres-1', 'opbt-agent-computer-1', 'codepath-qdrant', 'opbt-agent-langgraph-1')
if (($oneEach -ne 'false') -and ($oneEach -ne '0')) { $script:Required += 'opbt-supervisor-1' }
if ($botProvider -ne 'anthropic') { $script:Required += 'opbt-agent-bot-1' }
$script:HealthPorts = @(4100)
if ($botProvider -ne 'anthropic') { $script:HealthPorts += 4200 }
$script:HealthPorts += 4201

$cooldownUntil = (Get-Date).AddSeconds(30)
if ($Once) { $cooldownUntil = Get-Date }
$backoff = 45
$tick = 0
$state = 'iniciando'

while ($true) {
  if (Test-Path $StopFile) {
    Write-Log 'detenido por .logs\supervisor.stop'
    break
  }
  $tick++
  try {
    if (-not (Ensure-Docker)) {
      $state = 'docker'
    } elseif ((Get-Date) -lt $cooldownUntil) {
      $state = 'espera'
    } else {
      $problems = @(Get-Problems)
      if ($problems.Count -gt 0) {
        Write-Log ('problemas: ' + ($problems -join ', '))
        $ok = Invoke-Stack ($problems -join ', ')
        # start.sh puede quedarse en su verificacion de licencia (arriba el servidor y el
        # worker, pero no la app). Si la app sigue sin responder, se levanta igual.
        if (-not (Test-WithRetry { Test-App } 1 1)) { Start-App }
        if ($ok) {
          $backoff = 45
          $state = 'reparado'
        } else {
          $backoff = [Math]::Min($backoff * 2, 900)
          $state = 'fallo'
          Write-Log ('reintento en ' + $backoff + ' s')
        }
        $cooldownUntil = (Get-Date).AddSeconds($backoff)
      } else {
        # Todo arriba: el puente es lo unico que se vigila aparte (vive fuera de start.sh).
        Update-Bridge
        $state = 'ok'
      }
    }

    if (($tick % 30) -eq 0) {
      Write-Log ('latido: ' + $state)
      Rotate-Log -Path $LogPath -MaxMB 10
    }
  } catch {
    Write-Log ('error: ' + $_.Exception.Message)
  }

  if ($Once) { break }
  Start-Sleep -Seconds 20
}

Write-Log '--- supervisor fuera ---'
