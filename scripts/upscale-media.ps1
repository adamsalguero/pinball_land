#Requires -Version 5.1
param(
  [string]$Binary = "realesrgan-ncnn-vulkan",
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutputPath
)
$ErrorActionPreference = "Stop"
node (Join-Path $PSScriptRoot "upscale-media.js") $Binary $InputPath $OutputPath
exit $LASTEXITCODE
