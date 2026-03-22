#!/bin/bash
echo "[INFO] Reiniciando o servidor..."
bash "$(dirname "$0")/parar.sh"
echo "[INFO] Iniciando servidor novamente..."
bash "$(dirname "$0")/iniciar.sh"
