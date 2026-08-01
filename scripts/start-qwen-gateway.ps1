[CmdletBinding()]
param(
    [string]$ApiKey = "",
    [string]$ListenAddress = "127.0.0.1",
    [ValidateRange(1, 65535)]
    [int]$Port = 8765,
    [ValidateSet("auto", "headed", "headless")]
    [string]$BrowserMode = "auto",
    [string]$Model = "",
    [switch]$ForceLogin,
    [switch]$Install
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$gatewayEntry = Join-Path $repoRoot "dist\qwen-gateway.js"

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Description,
        [Parameter(Mandatory = $true)]
        [scriptblock]$Action
    )

    Write-Host "`n==> $Description" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed (exit code $LASTEXITCODE)."
    }
}

function New-RandomApiKey {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    }
    finally {
        $rng.Dispose()
    }
    return ([BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
}

Push-Location $repoRoot
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw "Node.js was not found. Install Node.js 20 or newer and reopen this window."
    }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw "npm was not found. Install the Node.js distribution that includes npm."
    }

    Write-Host "Node: $(node --version)" -ForegroundColor DarkGray
    Write-Host "npm:  $(npm --version)" -ForegroundColor DarkGray

    $dependenciesReady =
        (Test-Path (Join-Path $repoRoot "node_modules\esbuild")) -and
        (Test-Path (Join-Path $repoRoot "node_modules\playwright"))
    if ($Install -or -not $dependenciesReady) {
        Invoke-Checked "Installing dependencies" { npm install --no-package-lock }
    }
    else {
        Write-Host "`n==> Dependencies already exist; skipping npm install" -ForegroundColor DarkGray
    }

    Invoke-Checked "Building the Qwen gateway" { npm run build }

    if ($ForceLogin) {
        Invoke-Checked "Opening Qwen sign-in" { node $gatewayEntry login }
    }
    else {
        Write-Host "`n==> Checking Qwen sign-in" -ForegroundColor Cyan
        & node $gatewayEntry status
        if ($LASTEXITCODE -ne 0) {
            Invoke-Checked "Opening Qwen sign-in" { node $gatewayEntry login }
        }
    }

    $dataDir = $env:QWEN_GATEWAY_DATA_DIR
    if ([string]::IsNullOrWhiteSpace($dataDir)) {
        $dataDir = Join-Path $env:USERPROFILE ".qwen-astrbot-gateway"
    }
    elseif (-not [IO.Path]::IsPathRooted($dataDir)) {
        $dataDir = Join-Path $repoRoot $dataDir
    }
    [IO.Directory]::CreateDirectory($dataDir) | Out-Null

    $keyFile = Join-Path $dataDir "gateway-api-key.txt"
    if ([string]::IsNullOrWhiteSpace($ApiKey)) {
        if (-not [string]::IsNullOrWhiteSpace($env:QWEN_GATEWAY_API_KEY)) {
            $ApiKey = $env:QWEN_GATEWAY_API_KEY
        }
        elseif (Test-Path $keyFile) {
            $ApiKey = (Get-Content $keyFile -Raw).Trim()
        }
        else {
            $ApiKey = New-RandomApiKey
        }
    }
    if ([string]::IsNullOrWhiteSpace($ApiKey)) {
        throw "The gateway API key cannot be empty."
    }
    Set-Content -Path $keyFile -Value $ApiKey -Encoding ASCII -NoNewline

    if ([string]::IsNullOrWhiteSpace($Model)) {
        Write-Host "`nSelect the Qwen model for this start:" -ForegroundColor Cyan
        Write-Host "  1. Qwen3.8 Max Preview (qwen3.8-max-preview)"
        Write-Host "  2. Qwen3.7 Plus (qwen3.7-plus)"
        Write-Host "  3. Qwen3.7 Max (qwen3.7-max)"
        Write-Host "  4. Custom model ID"
        $selection = (Read-Host "Choice [1]").Trim()
        switch ($selection) {
            ""  { $Model = "qwen3.8-max-preview" }
            "1" { $Model = "qwen3.8-max-preview" }
            "2" { $Model = "qwen3.7-plus" }
            "3" { $Model = "qwen3.7-max" }
            "4" { $Model = (Read-Host "Custom model ID").Trim() }
            default { throw "Unknown model choice: $selection" }
        }
    }
    if ($Model -notmatch '^[a-zA-Z0-9._/-]+$') {
        throw "The model ID contains invalid characters: $Model"
    }

    $env:QWEN_GATEWAY_API_KEY = $ApiKey
    $env:QWEN_GATEWAY_HOST = $ListenAddress
    $env:QWEN_GATEWAY_PORT = [string]$Port
    $env:QWEN_GATEWAY_BROWSER_MODE = $BrowserMode
    $env:QWEN_GATEWAY_MODEL = $Model

    $astrBotHost = if ($ListenAddress -eq "0.0.0.0") {
        "<Windows host IP>"
    }
    else {
        $ListenAddress
    }

    Write-Host "`n============================================================" -ForegroundColor Green
    Write-Host "Configure AstrBot's OpenAI provider with:" -ForegroundColor Green
    Write-Host "  API Base URL: http://${astrBotHost}:$Port/v1"
    Write-Host "  API Key:      $ApiKey"
    Write-Host "  Model:        qwen-selected"
    Write-Host "  Selected Qwen: $Model"
    Write-Host "  Health check: http://${astrBotHost}:$Port/health"
    Write-Host "============================================================`n" -ForegroundColor Green
    Write-Host "The API key is saved at: $keyFile" -ForegroundColor DarkGray
    Write-Host "Press Ctrl+C to stop the gateway.`n" -ForegroundColor Yellow

    & node $gatewayEntry serve
    if ($LASTEXITCODE -ne 0) {
        throw "The gateway stopped with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
