#!/bin/bash
echo "[INFO] Iniciando o servidor backend..."
echo "[INFO] Dashboard disponivel em http://localhost:3000"
echo ""
cd "$(dirname "$0")/../backend"
node server.js
