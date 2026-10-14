#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root
node (Join-Path $PSScriptRoot "download-starter-media.js")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
