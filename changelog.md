# Changelog (Registro de Alterações)

Todas as alterações notáveis neste projeto serão documentadas neste arquivo.

## [1.1.0] - 2024-03-24
### Adicionado
- **Controle Remoto de Instâncias**: Suporte para ações de **Iniciar**, **Parar** e **Reiniciar** diretamente pelo painel.
- **Monitoramento Avançado**:
    - Seleção de intervalo de tempo dinâmico (até 7 dias).
    - Seleção de granularidade/período customizado (1m, 5m, 15m, 1h).
    - Atualização automática (auto-refresh) em tempo real sincronizada com o período selecionado.
    - Novos gráficos de monitoramento para **IOPS de Disco** e **Saldo de Créditos de CPU**.
- **Gestão Granular de Grupos de Segurança**:
    - Controles independentes para portas de **Entrada** (Inbound) e **Saída** (Outbound).
    - Edição em tempo real das portas de segurança para instâncias já existentes gerenciadas pelo Terraform.
- **Sincronização em Tempo Real**: Mecanismo de monitoramento em segundo plano (polling) para atualizar estados das instâncias via WebSocket automaticamente.

### Alterado
- **Otimização do Terraform**: Processo de inicialização aprimorado para pular o `terraform init` redundante e remoção da flag `-upgrade` para maior resiliência contra falhas de conexão.
- **Melhorias de UI/UX**: Adição de etiquetas de status de transição (reiniciando, pendente) e layout de monitoramento aprimorado.
- **Templates de Infraestrutura**: Atualização na geração do `main.tf` para suportar blocos distintos de entrada/saída e descrições sanitizadas.

### Corrigido
- **Compatibilidade com API AWS**: Correção de restrição de caracteres ASCII em descrições de Security Groups.
- **Mapeamento de Credenciais SDK**: Ajuste no mapeamento de campos para o AWS SDK v3 (`accessKeyId`, `secretAccessKey`).

---

## [1.0.0] - 2024-03-22
### Adicionado
- **Gestão de Ciclo de Vida EC2**: Automação completa para criação e destruição de instâncias AWS EC2 via Terraform.
- **Suporte Multi-SO**: Templates otimizados para Amazon Linux 2023, Ubuntu, Debian, RHEL e Windows Server (2019/2022).
- **Arquitetura de VPC e Segurança**: Provisionamento automático de recursos de rede e regras essenciais de segurança.
- **Terminal ao Vivo**: Integração de logs de execução do Terraform em tempo real via WebSocket.
- **Descoberta de Instâncias**: Capacidade de monitorar e gerenciar instâncias AWS existentes não criadas pelo painel.
- **Key Pairs Automatizados**: Suporte nativo para gerar, salvar e baixar pares de chaves `.pem` para acesso SSH/RDP.
- **Monitoramento Inicial**: Integração básica com CloudWatch para métricas de CPU, Rede (Entrada/Saída) e Disco (Leitura/Escrita).
- **Dashboard DevOps**: Interface visual para gerenciamento de infraestrutura sem complexidade de linha de comando.

---
