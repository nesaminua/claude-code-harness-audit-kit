$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'Node.js 18+ is required: https://nodejs.org'
  exit 1
}

node (Join-Path $PSScriptRoot 'install.js') @args
exit $LASTEXITCODE
