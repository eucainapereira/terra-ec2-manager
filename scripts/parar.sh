#!/bin/bash
echo "[INFO] Parando processos Node.js..."
pkill -f "node server.js" || killall node
if [ $? -eq 0 ]; then
    echo "[SUCCESS] Servidor parado com sucesso."
else
    echo "[INFO] Nenhum servidor Node.js em execucao."
fi
sleep 1
