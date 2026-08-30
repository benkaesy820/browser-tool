#!/usr/bin/env pwsh
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
node (Join-Path $scriptDir 'browser-tool.mjs') @args
