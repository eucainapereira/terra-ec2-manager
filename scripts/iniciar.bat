@echo off
title Servidor Local - TerraEC2 Manager
echo [INFO] Iniciando o servidor backend...
echo [INFO] Dashboard disponivel em http://localhost:3000
echo.
cd ..\backend
node server.js
pause
