param(
	[string]$GodotExecutablePath = $env:GODOT_EXECUTABLE_PATH,
	[string]$GodotProjectPath = $(if ($env:GODOT_PROJECT_PATH) { $env:GODOT_PROJECT_PATH } else { "D:\GodotProjects\example" }),
	[string]$PluginDir = $(if ($env:GODOT_DAEDALUS_PLUGIN_DIR) { $env:GODOT_DAEDALUS_PLUGIN_DIR } else { "D:\GodotProjects\example\addons\godot_daedalus" }),
	[int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 38180 }),
	[int]$StartupTimeoutSeconds = 20
)

$ErrorActionPreference = "Stop"
chcp 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if ([string]::IsNullOrWhiteSpace($GodotExecutablePath)) {
	$GodotExecutablePath = "D:\Godot_v4.7-stable_win64.exe\Godot_v4.7-stable_win64.exe"
}

if (-not (Test-Path -LiteralPath $GodotExecutablePath -PathType Leaf)) {
	throw "Godot executable was not found: $GodotExecutablePath"
}

if (-not (Test-Path -LiteralPath $GodotProjectPath -PathType Container)) {
	throw "Godot project was not found: $GodotProjectPath"
}

if (-not (Test-Path -LiteralPath $PluginDir -PathType Container)) {
	throw "Godot Daedalus plugin directory was not found: $PluginDir"
}

$backendUrl = "ws://localhost:$Port"
$logDir = Join-Path $env:TEMP "godot-daedalus-beta-smoke"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backendLog = Join-Path $logDir ("backend-{0}.stdout.log" -f $logStamp)
$backendErrorLog = Join-Path $logDir ("backend-{0}.stderr.log" -f $logStamp)

Write-Host "Starting backend on $backendUrl"
$env:PORT = [string]$Port
$backendProcess = Start-Process -FilePath (Get-Command node).Source `
	-ArgumentList @("--import", "tsx", "src/main.ts") `
	-WorkingDirectory (Get-Location).Path `
	-RedirectStandardOutput $backendLog `
	-RedirectStandardError $backendErrorLog `
	-PassThru `
	-WindowStyle Hidden

try {
	$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
	$healthy = $false
	while ((Get-Date) -lt $deadline) {
		$env:WS_URL = $backendUrl
		npm run --silent ping | Out-Null
		if ($LASTEXITCODE -eq 0) {
			$healthy = $true
			break
		}
		Start-Sleep -Milliseconds 500
	}

	if (-not $healthy) {
		throw "Backend did not become healthy before timeout. Logs: $backendLog ; $backendErrorLog"
	}

	Write-Host "Running Godot script checks"
	& $GodotExecutablePath --headless --path $GodotProjectPath --check-only --script "res://addons/godot_daedalus/scripts/main.gd"
	if ($LASTEXITCODE -ne 0) {
		throw "Godot main.gd check-only failed."
	}

	& $GodotExecutablePath --headless --path $GodotProjectPath --script "res://addons/godot_daedalus/tests/main_helpers_test.gd"
	if ($LASTEXITCODE -ne 0) {
		throw "main_helpers_test.gd failed."
	}

	& $GodotExecutablePath --headless --path $GodotProjectPath --script "res://addons/godot_daedalus/tests/rpc_methods_test.gd"
	if ($LASTEXITCODE -ne 0) {
		throw "rpc_methods_test.gd failed."
	}

	& $GodotExecutablePath --headless --path $GodotProjectPath --script "res://addons/godot_daedalus/tests/additional_context_item_test.gd"
	if ($LASTEXITCODE -ne 0) {
		throw "additional_context_item_test.gd failed."
	}

	$env:DAEDALUS_TEST_BACKEND_URL = $backendUrl
	& $GodotExecutablePath --headless --path $GodotProjectPath --script "res://addons/godot_daedalus/tests/backend_websocket_smoke_test.gd"
	if ($LASTEXITCODE -ne 0) {
		throw "backend_websocket_smoke_test.gd failed. Backend logs: $backendLog ; $backendErrorLog"
	}

	Write-Host "Beta smoke passed. Backend logs: $backendLog ; $backendErrorLog"
} finally {
	if ($backendProcess -ne $null -and -not $backendProcess.HasExited) {
		Stop-Process -Id $backendProcess.Id -Force
	}
	Remove-Item Env:\WS_URL -ErrorAction SilentlyContinue
	Remove-Item Env:\DAEDALUS_TEST_BACKEND_URL -ErrorAction SilentlyContinue
}
