@echo off
title Parar Servidor - TerraEC2 Manager
echo [INFO] Parando todos os processos Node.js...
taskkill /f /im node.exe >nul 2>&1
if %errorlevel% equ 0 (
    echo [SUCCESS] Servidor parado com sucesso.
) else (
    echo [INFO] Nenhum servidor Node.js em execucao.
)
timeout /t 2 >nul
exit
