$ErrorActionPreference = 'Stop'

Stop-Process -Name QQ -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
pnpm build

$env:QQNT_BRIDGE_PACKET_ADDON = Join-Path $PSScriptRoot 'dist\qqnt_packet.win32-x64-msvc.node'
Start-Process -FilePath 'Y:\Program Files\Tencent\QQNT\QQ.exe' -ArgumentList '--enable-logging'
