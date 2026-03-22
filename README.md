# 🚀 TerraEC2 Manager — Dashboard Terraform para AWS

![Terraform](https://img.shields.io/badge/terraform-%235835CC.svg?style=for-the-badge&logo=terraform&logoColor=white)
![AWS](https://img.shields.io/badge/AWS-%23FF9900.svg?style=for-the-badge&logo=amazon-aws&logoColor=white)
![NodeJS](https://img.shields.io/badge/node.js-6DA55F?style=for-the-badge&logo=node.js&logoColor=white)
![JavaScript](https://img.shields.io/badge/javascript-%23323330.svg?style=for-the-badge&logo=javascript&logoColor=%23F7DF1E)

Desenvolvido com auxílio de IA **TerraEC2 Manager** é uma interface visual para gerenciar a criação, monitoramento e destruição de instâncias EC2 na AWS utilizando **Terraform**. Desenvolvido para automação e otimização de código para simplificar o fluxo DevOps, permitindo que você suba infraestrutura com um clique e acompanhe algumas métricas em tempo real.

---

## ✨ Funcionalidades

- **Templates de OS**: Escolha entre Amazon Linux, Ubuntu, Windows Server, RHEL e Debian.
- **Gerenciamento de Chaves**: Geração automática de Key Pairs (.pem) com download direto.
- **Monitoramento Live**: Gráficos em tempo real de CPU, Rede (I/O), Disco (EBS) e Saúde via CloudWatch.
- **Terminal Integrado**: Acompanhe o `terraform plan`, `apply` e `destroy` ao vivo no dashboard.
- **Auto-Configuração**: Injeção de senhas para Windows e scripts User Data para Linux.

---

## 🛠️ Tecnologias

- **Backend**: Node.js, Express, WebSocket.
- **Infraestrutura**: Terraform, AWS SDK v3.
- **Frontend**: Vanilla JS (ES6+), Chart.js, CSS3 Moderno (Glassmorphism & Dark Mode).
- **Monitoramento**: AWS CloudWatch.

---

## 🚀 Como Rodar Localmente

### Pré-requisitos
1. **Terraform CLI** instalado e no PATH do sistema.
2. **Node.js** instalado.
3. Credenciais da AWS (Access Key / Secret Key).

### Instalação

1. Clone o repositório:
```bash
git clone https://github.com/seu-usuario/terra-ec2-manager.git
cd terra-ec2-manager
```

2. Instale as dependências do backend:
```bash
cd backend
npm install
```

3. Inicie o servidor:
- **Windows**: Utilize os arquivos na pasta `scripts/`:
  - `iniciar.bat`: Inicia o servidor Node.js.
  - `parar.bat`: Para o servidor Node.js.
  - `reiniciar.bat`: Reinicia o servidor.
- **Linux/macOS**: Utilize os arquivos `.sh` na pasta `scripts/`:
  - Primeiro, dê permissão de execução: `chmod +x scripts/*.sh`
  - `./scripts/iniciar.sh`: Inicia o servidor.
  - `./scripts/parar.sh`: Para o servidor.
  - `./scripts/reiniciar.sh`: Reinicia o servidor.
- **Manual (Qualquer OS)**:
```bash
node server.js
```

4. Acesse no navegador:
[http://localhost:3000](http://localhost:3000)

---

## 📁 Estrutura do Projeto

```text
├── backend/          # Servidor Node.js e Gerenciador Terraform
├── frontend/         # Interface Dashboard (HTML/CSS/JS)
├── scripts/          # Atalhos de execução
├── .gitignore
└── README.md
```

---

## 🛡️ Segurança
O projeto está configurado para **não subir** credenciais AWS ou arquivos de estado do Terraform (`data.json`, `terraform.tfstate`). Certifique-se de configurar suas chaves na interface do Dashboard após iniciar.

---

## Créditos ##
Cainã Pereira


