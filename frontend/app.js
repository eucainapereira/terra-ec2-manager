/* ─────────────────────────────────────────────────────────────────
   app.js — TerraEC2 Dashboard v3 (OS Templates + Key Pair + RDP)
───────────────────────────────────────────────────────────────── */

const API = '';
let ws = null;
let instances = {};
let destroyTargetId = null;
let activeTerminalFilter = 'all';
let detailsInstanceId = null;
let tfFiles = {};
let activeTabName = 'connect';
let activeTfFile = 'main.tf';

// OS Presets — AMI is fetched at apply time via Terraform SSM data source
// (no hardcoded AMI IDs here — they go stale quickly)
const AMI_PRESETS = {
  'amazon-linux': {
    label: 'Amazon Linux 2023',
    icon: '🐧',
    user: 'ec2-user',
    isWindows: false,
    ssmManaged: true,  // uses AWS SSM data source in Terraform
  },
  'ubuntu': {
    label: 'Ubuntu 22.04 LTS',
    icon: '🟠',
    user: 'ubuntu',
    isWindows: false,
    ssmManaged: true,
  },
  'debian': {
    label: 'Debian 12',
    icon: '🌀',
    user: 'admin',
    isWindows: false,
    ssmManaged: false,  // no official SSM path — user provides AMI
    fallbackAmis: {
      'us-east-1': 'ami-04e914639d0cca79a',
      'us-east-2': 'ami-0d1f6a0e0c7a4eeea',
      'us-west-2': 'ami-0d95d2b5bd33b91a1',
      'sa-east-1': 'ami-09c3deee77e8f4fc6',
    }
  },
  'windows-2022': {
    label: 'Windows Server 2022',
    icon: '🪟',
    user: 'Administrator',
    isWindows: true,
    ssmManaged: true,
  },
  'windows-2019': {
    label: 'Windows Server 2019',
    icon: '🪟',
    user: 'Administrator',
    isWindows: true,
    ssmManaged: true,
  },
  'rhel': {
    label: 'RHEL 9',
    icon: '🔴',
    user: 'ec2-user',
    isWindows: false,
    ssmManaged: true,
  }
};


// Currently selected OS in the create form
let selectedOS = 'amazon-linux';
let selectedOsIsWindows = false;

// ── WebSocket ─────────────────────────────────────────────────────
function connectWS() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${protocol}://${location.host}`);
  ws.onopen = () => {
    document.getElementById('ws-status').className = 'ws-status connected';
    document.querySelector('.ws-label').textContent = 'Conectado';
  };
  ws.onclose = () => {
    document.getElementById('ws-status').className = 'ws-status';
    document.querySelector('.ws-label').textContent = 'Desconectado';
    setTimeout(connectWS, 3000);
  };
  ws.onmessage = (event) => handleWSMessage(JSON.parse(event.data));
}

function handleWSMessage(data) {
  if (data.type === 'log') {
    appendLog(data.id, data.line);
  } else if (data.type === 'instance_update') {
    instances[data.id] = { id: data.id, ...data.meta };
    renderTables();
    updateStats();
    if (detailsInstanceId === data.id) {
      const inst = instances[data.id];
      refreshConnectTab(inst);
    }
  } else if (data.type === 'instance_deleted') {
    delete instances[data.id];
    renderTables();
    updateStats();
    toast('Instância destruída com sucesso.', 'success');
    if (detailsInstanceId === data.id) closeModal('modal-details');
  }
}

// ── Terminal Logs ─────────────────────────────────────────────────
const terminalEl = document.getElementById('terminal-output');
const logLines = {};

function appendLog(id, line) {
  if (!logLines[id]) logLines[id] = [];
  logLines[id].push(line);
  if (activeTerminalFilter === 'all' || activeTerminalFilter === id) {
    const span = document.createElement('span');
    span.className = classifyLine(line);
    span.textContent = line + '\n';
    terminalEl.querySelector('.terminal-welcome')?.remove();
    terminalEl.appendChild(span);
    terminalEl.scrollTop = terminalEl.scrollHeight;
  }
}

function classifyLine(line) {
  const l = line.toLowerCase();
  if (l.includes('[error]') || l.includes('error') || l.includes('stderr')) return 'log-line-error';
  if (l.includes('apply complete') || l.includes('destroy complete') || l.includes('creation complete')) return 'log-line-apply';
  if (l.includes('plan:') || l.includes('will be created') || l.includes('terraform plan')) return 'log-line-plan';
  if (l.startsWith('▸') || l.includes('✅')) return 'log-line-header';
  return '';
}

function renderTerminalForFilter(filterId) {
  terminalEl.innerHTML = '';
  const lines = filterId === 'all'
    ? Object.values(logLines).flat()
    : (logLines[filterId] || []);
  if (!lines.length) {
    terminalEl.innerHTML = '<span class="terminal-welcome">Sem logs para exibir.</span>';
    return;
  }
  lines.forEach(line => {
    const span = document.createElement('span');
    span.className = classifyLine(line);
    span.textContent = line + '\n';
    terminalEl.appendChild(span);
  });
  terminalEl.scrollTop = terminalEl.scrollHeight;
}

// ── Load data ─────────────────────────────────────────────────────
async function loadInstances() {
  try {
    const data = await apiGet('/api/instances');
    instances = {};
    data.forEach(inst => instances[inst.id] = inst);
    renderTables();
    updateStats();
    updateTerminalFilter();
  } catch (e) { console.error('Erro:', e); }
}

async function loadCredentials() {
  try {
    const data = await apiGet('/api/credentials');
    const dot = document.getElementById('cred-status-dot');
    dot.className = data.configured ? 'cred-status configured' : 'cred-status';
    if (data.configured) document.getElementById('stat-regions').textContent = data.region || '—';
  } catch (_) {}
}

// ── API helpers ───────────────────────────────────────────────────
async function apiGet(url) {
  const res = await fetch(API + url);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
async function apiPost(url, body) {
  const res = await fetch(API + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); throw new Error(e.error); }
  return res.json();
}
async function apiDelete(url) {
  const res = await fetch(API + url, { method: 'DELETE' });
  if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); throw new Error(e.error); }
  return res.json();
}

// ── Render Tables ─────────────────────────────────────────────────
function renderTables() {
  const list = Object.values(instances);
  renderDashboardTable(list.slice(0, 5));
  renderInstancesTable(list);
}

function stateBadge(state) {
  const map = { running: ['badge-running','Rodando'], creating: ['badge-creating','Criando...'], destroying: ['badge-destroying','Destruindo...'], error: ['badge-error','Erro'] };
  const [cls, label] = map[state] || ['badge-creating', state];
  return `<span class="badge ${cls}">${label}</span>`;
}

function portsBadges(ports) {
  if (!ports || !ports.length) return '<span style="color:var(--text-muted)">—</span>';
  return ports.slice(0, 3).map(p => `<span class="port-badge">${p}</span>`).join('') +
    (ports.length > 3 ? `<span class="port-badge">+${ports.length - 3}</span>` : '');
}

function osBadge(inst) {
  const preset = AMI_PRESETS[inst.osType || 'amazon-linux'];
  const icon = preset ? preset.icon : '🐧';
  const label = preset ? preset.label : (inst.osType || 'Linux');
  const origin = inst.managedBy === 'aws' ? '<span style="color:#06b6d4; font-size:10px; margin-left:4px;">(AWS)</span>' : '<span style="color:#7c3aed; font-size:10px; margin-left:4px;">(TF)</span>';
  return `<span class="os-badge">${icon} ${label} ${origin}</span>`;
}

function actionButtons(inst) {
  const isAws = inst.managedBy === 'aws';
  return `<div class="action-group">
    <button class="btn-icon" title="Detalhes / Conectar" onclick="openDetails('${inst.id}')">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
    </button>
    ${isAws ? '' : `
    <button class="btn-icon plan" title="Terraform Plan" onclick="planInstance('${inst.id}')">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
    </button>
    <button class="btn-icon danger" title="Destruir" onclick="confirmDestroy('${inst.id}', '${escHtml(inst.name)}')">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
    </button>
    `}
  </div>`;
}

function escHtml(str) { return str?.replace(/'/g, "\\'") || ''; }

function renderDashboardTable(list) {
  const tbody = document.getElementById('dashboard-tbody');
  if (!list.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Nenhuma instância criada ainda.</td></tr>'; return; }
  tbody.innerHTML = list.map(inst => `<tr>
    <td><a class="instance-name-link" onclick="openDetails('${inst.id}')">${inst.name}</a><div class="instance-id">${inst.id.slice(0,8)}…</div></td>
    <td>${osBadge(inst)}</td>
    <td>${inst.instanceType}</td>
    <td>${inst.region}</td>
    <td>${inst.publicIp ? `<span class="ip-text">${inst.publicIp}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
    <td>${stateBadge(inst.state)}</td>
    <td>${actionButtons(inst)}</td>
  </tr>`).join('');
}

function renderInstancesTable(list) {
  const tbody = document.getElementById('instances-tbody');
  if (!list.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="9">Nenhuma instância criada ainda.</td></tr>'; return; }
  tbody.innerHTML = list.map(inst => {
    const date = inst.createdAt ? new Date(inst.createdAt).toLocaleString('pt-BR') : '—';
    const keyIcon = inst.keyPairSaved ? '🔑 Gerado' : (inst.keyName ? `📂 ${inst.keyName}` : '—');
    return `<tr>
      <td><a class="instance-name-link" onclick="openDetails('${inst.id}')">${inst.name}</a><div class="instance-id">${inst.id.slice(0,8)}…</div></td>
      <td>${osBadge(inst)}</td>
      <td>${inst.instanceType}</td>
      <td>${inst.region}</td>
      <td>${portsBadges(inst.ports)}</td>
      <td>${inst.publicIp ? `<span class="ip-text">${inst.publicIp}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td><span style="font-size:12px;color:var(--text-secondary)">${keyIcon}</span></td>
      <td>${stateBadge(inst.state)}</td>
      <td>${actionButtons(inst)}</td>
    </tr>`;
  }).join('');
}

function updateStats() {
  const list = Object.values(instances);
  document.getElementById('stat-total').textContent = list.length;
  document.getElementById('stat-running').textContent = list.filter(i => i.state === 'running').length;
  document.getElementById('stat-errors').textContent = list.filter(i => i.state === 'error').length;
}

function updateTerminalFilter() {
  const sel = document.getElementById('terminal-filter');
  const prev = sel.value;
  sel.innerHTML = '<option value="all">Todos os logs</option>';
  Object.values(instances).forEach(inst => {
    const opt = document.createElement('option');
    opt.value = inst.id; opt.textContent = inst.name;
    sel.appendChild(opt);
  });
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;

  const monSel = document.getElementById('monitor-filter');
  if (monSel) {
    const mPrev = monSel.value;
    monSel.innerHTML = '<option value="">Selecione uma instância...</option>';
    Object.values(instances).forEach(inst => {
      const opt = document.createElement('option');
      opt.value = inst.id; opt.textContent = inst.name;
      monSel.appendChild(opt);
    });
    if ([...monSel.options].some(o => o.value === mPrev)) monSel.value = mPrev;
  }

  // Monitor Selection List (V2 UI)
  const monList = document.getElementById('monitor-selection-list');
  if (monList) {
    if (Object.keys(instances).length === 0) {
      monList.innerHTML = '<div style="color:var(--text-muted); font-size:13px; padding:10px;">Nenhuma instância ativa.</div>';
    } else {
      monList.innerHTML = Object.values(instances).map(inst => `
        <div class="monitor-card ${inst.id === activeMonitorId ? 'active' : ''}" onclick="selectMonitorInstance('${inst.id}')">
          <div class="monitor-card-name">${inst.name}</div>
          <div class="monitor-card-status">
            <span class="ws-dot" style="background: ${inst.state === 'running' ? 'var(--green)' : 'var(--text-muted)'}"></span>
            ${inst.state}
          </div>
        </div>
      `).join('');
    }
  }
}

let activeMonitorId = null;
function selectMonitorInstance(id) {
  activeMonitorId = id;
  updateTerminalFilter(); 
  loadMetrics(id);
}
window.selectMonitorInstance = selectMonitorInstance;

// ── Details Modal (DevOps Panel) ──────────────────────────────────
async function openDetails(id) {
  const inst = instances[id];
  if (!inst) return;
  detailsInstanceId = id;

  document.getElementById('details-title').textContent = inst.name;
  document.getElementById('details-subtitle').textContent = `${inst.region} · ${inst.instanceType} · ${inst.ami}`;

  switchDetailsTab('connect');
  renderInfoGrid(inst);
  renderConnectTab(inst);

  document.getElementById('userdata-content').textContent = inst.userScript || '# Nenhum script configurado.';

  document.getElementById('btn-details-plan').onclick = () => { closeModal('modal-details'); planInstance(id); };
  document.getElementById('btn-details-destroy').onclick = () => { closeModal('modal-details'); confirmDestroy(id, inst.name); };

  openModal('modal-details');

  // Load tf files async
  document.getElementById('tf-code-content').textContent = 'Carregando arquivos Terraform...';
  tfFiles = {};
  try {
    tfFiles = await apiGet(`/api/instances/${id}/files`);
    showTfFile('main.tf');
  } catch {
    document.getElementById('tf-code-content').textContent = '# Arquivos .tf não encontrados.';
  }
}

function renderConnectTab(inst) {
  const isWindows = inst.isWindows || false;
  document.getElementById('linux-connect-panel').style.display = isWindows ? 'none' : 'block';
  document.getElementById('windows-connect-panel').style.display = isWindows ? 'block' : 'none';

  refreshConnectTab(inst);
  renderPortsBadges(inst.ports || []);
}

function refreshConnectTab(inst) {
  const isWindows = inst.isWindows || false;
  const ip = inst.publicIp || null;

  // Key pair download
  const hasPem = inst.keyPairSaved;
  const pemUrl = `/api/instances/${inst.id}/keypair`;
  const pemFilename = `${inst.name}-keypair.pem`;

  if (!isWindows) {
    const user = document.getElementById('ssh-user')?.value || 'ec2-user';
    const keyArg = (hasPem || inst.keyName) ? ` -i "${pemFilename}"` : '';
    document.getElementById('ssh-command').textContent = ip
      ? `ssh${keyArg} ${user}@${ip}`
      : 'Aguardando IP público...';
    document.getElementById('scp-command').textContent = ip
      ? `scp${keyArg} ./arquivo.txt ${user}@${ip}:~/`
      : 'Aguardando IP público...';

    // Key pair download box (Linux)
    const box = document.getElementById('keypair-download-box');
    if (hasPem) {
      box.style.display = 'flex';
      document.getElementById('keypair-filename').textContent = pemFilename;
      document.getElementById('btn-download-pem').href = pemUrl;
    } else {
      box.style.display = 'none';
    }
  } else {
    // Windows RDP
    document.getElementById('rdp-address').textContent = ip ? `${ip}:3389` : 'Aguardando IP público...';

    // Show/hide admin password block
    const pwBlock = document.getElementById('rdp-password-block');
    const winBox = document.getElementById('win-keypair-download-box');
    
    if (inst.adminPassword) {
      pwBlock.style.display = 'block';
      document.getElementById('rdp-password').textContent = inst.adminPassword;
      
      const pshCmd = ip
        ? `cmdkey /generic:TERMSRV/${ip} /user:Administrator /pass:"${inst.adminPassword}" ; mstsc /v:${ip}:3389`
        : 'Aguardando IP público...';
      document.getElementById('rdp-command').textContent = pshCmd;
      
      // Hide pem box if we have a password (or let it stay as fallback)
      winBox.style.display = hasPem ? 'flex' : 'none';
      if (hasPem) {
        document.getElementById('win-keypair-filename').textContent = pemFilename;
        document.getElementById('btn-win-download-pem').href = pemUrl;
      }
    } else {
      pwBlock.style.display = 'none';
      document.getElementById('rdp-command').textContent = ip ? `mstsc /v:${ip}:3389` : 'Aguardando IP público...';
      
      if (hasPem) {
        winBox.style.display = 'flex';
        document.getElementById('win-keypair-filename').textContent = pemFilename;
        document.getElementById('btn-win-download-pem').href = pemUrl;
      } else {
        winBox.style.display = 'none';
      }
    }

    // Open RDP button
    document.getElementById('btn-open-rdp').onclick = () => {
      if (!ip) { toast('IP público ainda não disponível.', 'error'); return; }
      window.open(`ms-rd:full address=s:${ip}:3389`, '_blank');
      // Fallback: copy mstsc command
      navigator.clipboard.writeText(`mstsc /v:${ip}:3389`)
        .then(() => toast('Comando copiado! Cole no PowerShell para conectar.', 'info'))
        .catch(() => {});
    };
  }
}

function renderPortsBadges(ports) {
  const el = document.getElementById('ports-badges');
  if (!ports.length) {
    el.innerHTML = '<span style="color:var(--text-muted);font-size:12px">Nenhuma porta configurada.</span>';
    return;
  }
  el.innerHTML = ports.map(p => `<span class="port-badge">TCP ${p}</span>`).join('');
}

function renderInfoGrid(inst) {
  const date = inst.createdAt ? new Date(inst.createdAt).toLocaleString('pt-BR') : '—';
  const preset = AMI_PRESETS[inst.osType || 'amazon-linux'];
  const items = [
    { label: 'Instance ID (AWS)', value: inst.instanceId || '—', highlight: !!inst.instanceId },
    { label: 'IP Público', value: inst.publicIp || '—', highlight: !!inst.publicIp },
    { label: 'Sistema Operacional', value: preset ? `${preset.icon} ${preset.label}` : inst.osType || '—' },
    { label: 'Tipo', value: inst.instanceType },
    { label: 'Região', value: inst.region },
    { label: 'AMI', value: inst.ami },
    { label: 'Key Pair', value: inst.keyPairSaved ? `🔑 ${inst.name}-keypair (gerado)` : (inst.keyName || '—') },
    { label: 'Status', value: inst.state },
    { label: 'Criado em', value: date },
  ];
  document.getElementById('info-grid').innerHTML = items.map(item => `
    <div class="info-item">
      <div class="info-item-label">${item.label}</div>
      <div class="info-item-value${item.highlight ? ' highlight' : ''}">${item.value}</div>
    </div>`).join('');
}

function showTfFile(filename) {
  activeTfFile = filename;
  document.querySelectorAll('.tf-file-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.file === filename));
  const content = tfFiles[filename];
  document.getElementById('tf-code-content').textContent =
    (content !== null && content !== undefined) ? content : `# Arquivo ${filename} não encontrado.`;
}

let cpuChart = null;
let networkChart = null;
let diskChart = null;
let healthChart = null;

function formatBytes(bytes) {
  if (bytes === 0) return { value: 0, unit: 'Bytes' };
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return {
    value: parseFloat((bytes / Math.pow(k, i)).toFixed(2)),
    unit: sizes[i]
  };
}

function getBestUnitForDataset(dataset) {
  const max = Math.max(...dataset.map(d => d.value), 0);
  return formatBytes(max).unit;
}

function convertToUnit(bytes, unit) {
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = sizes.indexOf(unit);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2));
}

function switchDetailsTab(tabName) {
  activeTabName = tabName;
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabName));
  document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === `tab-${tabName}`));
}

async function loadMetrics(id) {
  const inst = instances[id];
  if (!inst) return;

  const emptyEl = document.getElementById('page-metrics-empty');
  const loadingEl = document.getElementById('page-metrics-loading');
  const contentEl = document.getElementById('page-metrics-content');
  
  emptyEl.style.display = 'none';
  loadingEl.style.display = 'block';
  loadingEl.textContent = 'Carregando métricas do CloudWatch...';
  contentEl.style.display = 'none';

  try {
    const data = await apiGet(`/api/instances/${id}/metrics`);
    loadingEl.style.display = 'none';
    contentEl.style.display = 'flex';
    renderCharts(data);
  } catch (err) {
    loadingEl.textContent = 'Erro ao carregar métricas (Verifique credenciais AWS).';
    console.error(err);
  }
}

function renderCharts(data) {
  const ctxCpu = document.getElementById('pageCpuChart').getContext('2d');
  const ctxNet = document.getElementById('pageNetworkChart').getContext('2d');
  const ctxDisk = document.getElementById('pageDiskChart').getContext('2d');
  const ctxHealth = document.getElementById('pageHealthChart').getContext('2d');

  if (cpuChart) cpuChart.destroy();
  if (networkChart) networkChart.destroy();
  if (diskChart) diskChart.destroy();
  if (healthChart) healthChart.destroy();

  const timeLabels = data.cpu.map(d => {
    const dObj = new Date(d.timestamp);
    return dObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
  });

  Chart.defaults.color = '#a1a1aa';
  Chart.defaults.font.family = 'Inter, sans-serif';

  // --- CPU ---
  cpuChart = new Chart(ctxCpu, {
    type: 'line',
    data: {
      labels: timeLabels,
      datasets: [{
        label: 'CPU (%)',
        data: data.cpu.map(d => d.value),
        borderColor: '#7c3aed',
        backgroundColor: 'rgba(124, 58, 237, 0.1)',
        borderWidth: 2,
        fill: true,
        tension: 0.3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, suggestedMax: 100, ticks: { callback: v => v + '%' } } },
      plugins: { legend: { display: false } }
    }
  });

  // --- Network ---
  const netUnit = getBestUnitForDataset([...data.netIn, ...data.netOut]);
  document.getElementById('net-unit').textContent = `(${netUnit})`;

  networkChart = new Chart(ctxNet, {
    type: 'line',
    data: {
      labels: timeLabels,
      datasets: [
        {
          label: 'In (Download)',
          data: data.netIn.map(d => convertToUnit(d.value, netUnit)),
          borderColor: '#06b6d4',
          backgroundColor: 'rgba(6, 182, 212, 0.1)',
          borderWidth: 2,
          fill: true,
          tension: 0.3
        },
        {
          label: 'Out (Upload)',
          data: data.netOut.map(d => convertToUnit(d.value, netUnit)),
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          borderWidth: 2,
          fill: true,
          tension: 0.3
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true } },
      plugins: { legend: { position: 'top', labels: { boxWidth: 12 } } }
    }
  });

  // --- Disk ---
  const diskUnit = getBestUnitForDataset([...data.diskRead, ...data.diskWrite]);
  const hasDiskData = data.diskRead.some(d => d.value > 0) || data.diskWrite.some(d => d.value > 0);
  document.getElementById('disk-unit').textContent = hasDiskData ? `(${diskUnit})` : '(Sem dados EBS/Store)';

  diskChart = new Chart(ctxDisk, {
    type: 'line',
    data: {
      labels: timeLabels,
      datasets: [
        {
          label: 'Leitura',
          data: data.diskRead.map(d => convertToUnit(d.value, diskUnit)),
          borderColor: '#10b981',
          borderWidth: 2,
          tension: 0.3
        },
        {
          label: 'Escrita',
          data: data.diskWrite.map(d => convertToUnit(d.value, diskUnit)),
          borderColor: '#ef4444',
          borderWidth: 2,
          tension: 0.3
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true } },
      plugins: { legend: { position: 'top', labels: { boxWidth: 12 } } }
    }
  });

  // --- Health ---
  healthChart = new Chart(ctxHealth, {
    type: 'bar',
    data: {
      labels: timeLabels,
      datasets: [{
        label: 'Falhas de Status Check',
        data: data.health.map(d => d.value),
        backgroundColor: data.health.map(d => d.value > 0 ? '#ef4444' : '#10b981'),
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, suggestedMax: 1, ticks: { stepSize: 1 } } },
      plugins: { legend: { display: false } }
    }
  });
}

// ── OS Template Selector ──────────────────────────────────────────
function generateSecurePassword() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let pass = '';
  for (let i = 0; i < 16; i++) pass += chars[Math.floor(Math.random() * chars.length)];
  return pass + 'Aa1!'; // Ensure complexity requirements are met
}

function selectOS(osKey) {
  selectedOS = osKey;
  const preset = AMI_PRESETS[osKey];
  selectedOsIsWindows = preset ? preset.isWindows : false;

  // Update card selection
  document.querySelectorAll('.os-card').forEach(card => {
    card.classList.toggle('active', card.dataset.os === osKey);
  });

  // Auto-fill AMI for current region
  fillAmiForRegion();

  // Show/hide user data section for Windows
  const udSection = document.getElementById('userdata-section');
  if (udSection) udSection.style.display = selectedOsIsWindows ? 'none' : 'block';
  
  // Toggle Windows Admin Password section
  const pwSection = document.getElementById('windows-password-section');
  if (pwSection) {
    pwSection.style.display = selectedOsIsWindows ? 'block' : 'none';
    if (selectedOsIsWindows) {
      document.getElementById('inst-admin-password').value = generateSecurePassword();
    }
  }

  // For Windows, suggest appropriate instance type but don't force it to avoid Free Tier errors
  if (selectedOsIsWindows) {
    const typeEl = document.getElementById('inst-type');
    if (typeEl && (typeEl.value === 't2.micro' || typeEl.value === 't3.micro')) {
      toast('💡 Aviso: Windows pode ficar lento em t2.micro/t3.micro (1GB RAM), mas é elegível para o Free Tier.', 'info');
    }
  }
}

function fillAmiForRegion() {
  const region = document.getElementById('inst-region')?.value;
  const preset = AMI_PRESETS[selectedOS];
  const amiEl = document.getElementById('inst-ami');
  const hintEl = document.getElementById('ami-hint');
  if (!preset || !amiEl) return;

  if (preset.ssmManaged) {
    // AMI is fetched at apply time by Terraform SSM data source — no need to specify
    amiEl.value = 'auto';
    amiEl.readOnly = true;
    amiEl.style.color = 'var(--text-muted)';
    if (hintEl) hintEl.textContent = `✅ ${preset.label} — AMI mais recente obtido automaticamente pelo Terraform via EC2 DescribeImages`;
  } else {
    // Debian: use fallback AMI for the region if available
    amiEl.readOnly = false;
    amiEl.style.color = '';
    const fallback = preset.fallbackAmis?.[region] || '';
    amiEl.value = fallback;
    if (hintEl) hintEl.textContent = fallback
      ? `📌 AMI de referência para ${region} — verifique no Marketplace se ainda é atual`
      : 'Insira o AMI ID manualmente para esta região';
  }
}

// ── Clipboard helper ──────────────────────────────────────────────
function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const span = btn.querySelector('span:last-of-type');
    btn.classList.add('copied');
    if (span && span.textContent !== 'Copiar') return;
    if (span) span.textContent = 'Copiado!';
    setTimeout(() => { btn.classList.remove('copied'); if (span) span.textContent = 'Copiar'; }, 1500);
  }).catch(() => toast('Erro ao copiar', 'error'));
}

// ── Instance Actions ──────────────────────────────────────────────
async function planInstance(id) {
  const inst = instances[id];
  if (!inst) return;
  switchPage('terminal');
  toast(`Executando terraform plan para "${inst.name}"…`, 'info');
  try { await apiPost(`/api/instances/${id}/plan`, {}); }
  catch (e) { toast(e.message, 'error'); }
}

function confirmDestroy(id, name) {
  destroyTargetId = id;
  document.getElementById('destroy-name').textContent = name;
  openModal('modal-destroy');
}

async function destroyInstance() {
  if (!destroyTargetId) return;
  closeModal('modal-destroy');
  const id = destroyTargetId;
  const name = instances[id]?.name || id;
  switchPage('terminal');
  toast(`Destruindo "${name}"…`, 'info');
  try { await apiDelete(`/api/instances/${id}`); }
  catch (e) { toast(e.message, 'error'); }
  destroyTargetId = null;
}

// ── Create Instance ───────────────────────────────────────────────
async function createInstance(action = 'apply') {
  const name = document.getElementById('inst-name').value.trim();
  const region = document.getElementById('inst-region').value;
  const instanceType = document.getElementById('inst-type').value;
  const amiField = document.getElementById('inst-ami').value.trim();
  const ports = document.getElementById('inst-ports').value.trim();
  const userScript = document.getElementById('inst-userdata').value.trim();
  const adminPassword = document.getElementById('inst-admin-password').value.trim();

  const preset = AMI_PRESETS[selectedOS];
  const isSSM = preset?.ssmManaged;

  // For SSM-managed OSes, AMI is auto-resolved — no manual entry needed
  const ami = isSSM ? '' : amiField;

  if (!name) { toast('Preencha o Nome da instância.', 'error'); return; }
  if (!isSSM && !ami) { toast('Preencha o AMI ID ou selecione um sistema operacional com AMI automático.', 'error'); return; }

  // Key pair mode
  const mode = document.querySelector('input[name="keypair-mode"]:checked')?.value || 'generate';
  const generateKeyPair = mode === 'generate';
  const keyName = mode === 'existing' ? document.getElementById('inst-key').value.trim() : null;

  closeModal('modal-create');
  switchPage('terminal');

  toast(`${action === 'plan' ? 'Planejando' : 'Criando'} instância "${name}" (${preset?.label || selectedOS})…`, 'info');

  try {
    await apiPost('/api/instances/create', {
      name, region, instanceType,
      ami,  // empty string for SSM OSes — Terraform uses data source instead
      keyName: keyName || undefined,
      generateKeyPair,
      isWindows: selectedOsIsWindows,
      osType: selectedOS,
      ports: ports || undefined,
      userScript: userScript || undefined,
      adminPassword: selectedOsIsWindows ? adminPassword : undefined
    });
    if (generateKeyPair && action === 'apply') {
      toast(`Chave .pem será gerada pelo Terraform — disponível para download após criação!`, 'info');
    }
  } catch (e) { toast(e.message, 'error'); }
}

// ── Save Credentials ──────────────────────────────────────────────
async function saveCredentials() {
  const accessKey = document.getElementById('cred-access-key').value.trim();
  const secretKey = document.getElementById('cred-secret-key').value.trim();
  const region = document.getElementById('cred-region').value;
  if (!accessKey || !secretKey) { toast('Preencha Access Key e Secret Key.', 'error'); return; }
  try {
    await apiPost('/api/credentials', { accessKey, secretKey, region });
    closeModal('modal-credentials');
    toast('Credenciais salvas!', 'success');
    loadCredentials();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Navigation ────────────────────────────────────────────────────
function switchPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.add('active');
  document.getElementById(`nav-${page}`)?.classList.add('active');
  const titles = { dashboard: 'Dashboard', instances: 'Instâncias', terminal: 'Terminal ao Vivo', monitor: 'Monitoramento AWS' };
  document.getElementById('page-title').textContent = titles[page] || page;
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function toast(msg, type = 'info') {
  const icons = { success: '✓', error: '✕', info: '●' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

// ── Event Wiring ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  connectWS();
  loadInstances();
  loadCredentials();

  // Init OS selector — fill AMI on load
  fillAmiForRegion();

  // Nav
  document.querySelectorAll('[data-page]').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); switchPage(el.dataset.page); });
  });

  // Open modals
  document.getElementById('btn-new-instance').addEventListener('click', () => openModal('modal-create'));
  document.getElementById('btn-new-instance-2').addEventListener('click', () => openModal('modal-create'));
  document.getElementById('btn-credentials').addEventListener('click', () => openModal('modal-credentials'));

  // Close modals
  document.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => closeModal(btn.dataset.close)));
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(overlay.id); });
  });

  // Create
  document.getElementById('btn-apply-create').addEventListener('click', () => createInstance('apply'));
  document.getElementById('btn-plan-create').addEventListener('click', () => createInstance('plan'));

  // Credentials
  document.getElementById('btn-save-credentials').addEventListener('click', saveCredentials);

  // Destroy
  document.getElementById('btn-confirm-destroy').addEventListener('click', destroyInstance);

  // Terminal
  document.getElementById('terminal-filter').addEventListener('change', e => {
    activeTerminalFilter = e.target.value;
    renderTerminalForFilter(activeTerminalFilter);
  });
  document.getElementById('btn-clear-terminal').addEventListener('click', () => {
    terminalEl.innerHTML = '<span class="terminal-welcome">Terminal limpo.</span>';
    Object.keys(logLines).forEach(k => delete logLines[k]);
  });

  // Monitor (V2 uses cards, so monitor-filter is gone from HTML)
  const monFilter = document.getElementById('monitor-filter');
  if (monFilter) {
    monFilter.addEventListener('change', e => {
      const id = e.target.value;
      if (id) {
        loadMetrics(id);
      } else {
        document.getElementById('page-metrics-empty').style.display = 'block';
        document.getElementById('page-metrics-content').style.display = 'none';
        document.getElementById('page-metrics-loading').style.display = 'none';
      }
    });
  }

  // Mobile menu
  document.getElementById('menu-toggle').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));

  // ── OS card selection ──────────────────────────────────────────
  document.querySelectorAll('.os-card').forEach(card => {
    card.addEventListener('click', () => selectOS(card.dataset.os));
  });

  // Region change → refill AMI
  document.getElementById('inst-region').addEventListener('change', fillAmiForRegion);

  // Key pair mode radios
  document.querySelectorAll('input[name="keypair-mode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const showField = radio.value === 'existing' && radio.checked;
      document.getElementById('existing-key-field').style.display = showField ? 'block' : 'none';
    });
  });

  // ── Details Modal ──────────────────────────────────────────────

  // Tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchDetailsTab(btn.dataset.tab));
  });

  // SSH user select → update command
  document.getElementById('ssh-user').addEventListener('change', () => {
    if (detailsInstanceId) refreshConnectTab(instances[detailsInstanceId]);
  });

  // Copy SSH
  document.getElementById('btn-copy-ssh').addEventListener('click', e => {
    const text = document.getElementById('ssh-command').textContent;
    copyToClipboard(text, e.currentTarget);
    toast('Comando SSH copiado!', 'success');
  });

  // All [data-copy-target] buttons
  document.querySelectorAll('[data-copy-target]').forEach(btn => {
    btn.addEventListener('click', e => {
      const el = document.getElementById(e.currentTarget.dataset.copyTarget);
      if (!el) return;
      copyToClipboard(el.textContent, e.currentTarget);
      toast('Copiado!', 'success');
    });
  });

  // TF file tabs
  document.querySelectorAll('.tf-file-btn').forEach(btn => {
    btn.addEventListener('click', () => showTfFile(btn.dataset.file));
  });

  // Copy TF code
  document.getElementById('btn-copy-tf').addEventListener('click', e => {
    copyToClipboard(document.getElementById('tf-code-content').textContent, e.currentTarget);
    toast('Arquivo copiado!', 'success');
  });

  // Copy User Data
  document.getElementById('btn-copy-userdata').addEventListener('click', e => {
    copyToClipboard(document.getElementById('userdata-content').textContent, e.currentTarget);
    toast('Script copiado!', 'success');
  });
});
