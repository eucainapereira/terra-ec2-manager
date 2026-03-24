const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { EC2Client, DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand, RebootInstancesCommand } = require('@aws-sdk/client-ec2');
const { CloudWatchClient, GetMetricStatisticsCommand } = require('@aws-sdk/client-cloudwatch');
const terraformManager = require('./terraform-manager');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// In-memory store for credentials and instance metadata
let awsCredentials = null;
const instanceMeta = {}; // id -> { name, region, instanceType, ami, state, workspacePath, publicIp }

// Load persisted data if exists
const DATA_FILE = path.join(__dirname, 'data.json');
function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      awsCredentials = raw.credentials || null;
      Object.assign(instanceMeta, raw.instances || {});
    } catch (_) {}
  }
}
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ credentials: awsCredentials, instances: instanceMeta }, null, 2));
}
loadData();

// WebSocket broadcast helpers
const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

// Periodically poll AWS for instance status updates
async function pollInstanceStatus() {
  if (!awsCredentials) return;
  try {
    const ec2 = getEC2Client();
    if (!ec2) return;
    const response = await ec2.send(new DescribeInstancesCommand({}));
    
    for (const reservation of response.Reservations || []) {
      for (const inst of reservation.Instances || []) {
        // Find if this is a managed instance
        const id = Object.keys(instanceMeta).find(k => instanceMeta[k].instanceId === inst.InstanceId);
        if (id) {
          const meta = instanceMeta[id];
          const awsState = inst.State.Name === 'running' ? 'running' : inst.State.Name;
          const ip = inst.PublicIpAddress || null;
          
          let changed = false;
          if (meta.state !== awsState) {
            meta.state = awsState;
            changed = true;
          }
          if (ip && meta.publicIp !== ip) {
            meta.publicIp = ip;
            changed = true;
          }
          
          if (changed) {
            saveData();
            broadcast({ type: 'instance_update', id, meta });
          }
        }
      }
    }
  } catch (err) {
    // Silent catch for background polling
  }
}
setInterval(pollInstanceStatus, 15000); // Poll every 15 seconds

// ── API Routes ──────────────────────────────────────────────────────────────

// Save AWS credentials
app.post('/api/credentials', (req, res) => {
  const { accessKey, secretKey, region } = req.body;
  if (!accessKey || !secretKey || !region) {
    return res.status(400).json({ error: 'accessKey, secretKey e region são obrigatórios' });
  }
  awsCredentials = { accessKey, secretKey, region };
  saveData();
  res.json({ ok: true });
});

// Get credentials status (never returns actual keys)
app.get('/api/credentials', (req, res) => {
  res.json({ configured: !!awsCredentials, region: awsCredentials?.region || null });
});

// helper SDK providers
function getEC2Client() {
  if (!awsCredentials) return null;
  return new EC2Client({
    region: awsCredentials.region,
    credentials: { accessKeyId: awsCredentials.accessKey, secretAccessKey: awsCredentials.secretKey }
  });
}
function getCloudWatchClient(region) {
  if (!awsCredentials) return null;
  return new CloudWatchClient({
    region: region || awsCredentials.region,
    credentials: { accessKeyId: awsCredentials.accessKey, secretAccessKey: awsCredentials.secretKey }
  });
}

// List all instances (Merge Local Terraform + AWS)
app.get('/api/instances', async (req, res) => {
  const localList = Object.entries(instanceMeta).map(([id, meta]) => ({ id, ...meta }));
  
  if (!awsCredentials) {
    return res.json(localList.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)));
  }

  try {
    const ec2 = getEC2Client();
    const command = new DescribeInstancesCommand({});
    const response = await ec2.send(command);
    
    const awsInstances = [];
    const localAwsIds = new Set(localList.map(i => i.instanceId).filter(Boolean));

    for (const reservation of response.Reservations || []) {
      for (const inst of reservation.Instances || []) {
        if (inst.State.Name === 'terminated') continue;
        
        // If managed by Terraform locally and already has instanceId, update IP and skip duplicate
        if (localAwsIds.has(inst.InstanceId)) {
          const localInst = localList.find(i => i.instanceId === inst.InstanceId);
          if (localInst && inst.PublicIpAddress && localInst.publicIp !== inst.PublicIpAddress) {
            localInst.publicIp = inst.PublicIpAddress;
            instanceMeta[localInst.id].publicIp = inst.PublicIpAddress;
            saveData();
          }
          continue;
        }

        const nameTag = inst.Tags?.find(t => t.Key === 'Name');
        const osTag = inst.Tags?.find(t => t.Key === 'OS');
        
        awsInstances.push({
          id: inst.InstanceId,
          instanceId: inst.InstanceId,
          name: nameTag ? nameTag.Value : (inst.InstanceId || 'AWS Instance'),
          region: awsCredentials.region,
          instanceType: inst.InstanceType,
          ami: inst.ImageId,
          keyName: inst.KeyName || null,
          state: inst.State.Name === 'running' ? 'running' : inst.State.Name,
          publicIp: inst.PublicIpAddress || null,
          isWindows: osTag ? osTag.Value === 'windows' : (inst.Platform === 'windows'),
          managedBy: 'aws',
          createdAt: inst.LaunchTime ? new Date(inst.LaunchTime).toISOString() : new Date().toISOString()
        });
      }
    }
    
    res.json([...localList, ...awsInstances].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)));
  } catch (err) {
    console.error('Error fetching AWS instances:', err);
    res.json(localList.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)));
  }
});

// Create a new instance
app.post('/api/instances/create', async (req, res) => {
  if (!awsCredentials) return res.status(400).json({ error: 'Configure as credenciais AWS primeiro.' });

  const { name, region, instanceType, ami, keyName, inboundPorts, outboundPorts, autoSecurityGroup, userScript, adminPassword, generateKeyPair, isWindows, osType, tags } = req.body;
  // SSM-managed OS types resolve the AMI via Terraform data source — no manual ami required
  const SSM_OS_TYPES = ['amazon-linux', 'ubuntu', 'windows-2022', 'windows-2019', 'rhel'];
  const isSSMManaged = SSM_OS_TYPES.includes(osType);
  if (!name || !region || !instanceType || (!ami && !isSSMManaged)) {
    return res.status(400).json({ error: 'name, region e instanceType são obrigatórios. ami é necessário para sistemas não-SSM.' });
  }
  const parsePorts = (p) => {
    if (Array.isArray(p)) return p.map(Number).filter(Boolean);
    if (typeof p === 'string') return p.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    return [];
  };

  const inPortList = parsePorts(inboundPorts);
  const outPortList = parsePorts(outboundPorts);

  // Windows: auto-add RDP port 3389 if not present in inbound
  if (isWindows && !inPortList.includes(3389)) inPortList.push(3389);

  const id = uuidv4();
  const workspacePath = path.join(__dirname, 'workspaces', id);
  fs.mkdirSync(workspacePath, { recursive: true });

  instanceMeta[id] = {
    name, region, instanceType, ami,
    keyName: generateKeyPair ? null : (keyName || null),
    generatedKeyName: generateKeyPair ? `${id}-keypair` : null,
    generateKeyPair: !!generateKeyPair,
    isWindows: !!isWindows,
    osType: osType || 'amazon-linux',
    inboundPorts: inPortList,
    outboundPorts: outPortList,
    autoSecurityGroup: !!autoSecurityGroup,
    userScript: userScript || null,
    adminPassword: adminPassword || null,
    keyPairSaved: false,
    state: 'creating',
    workspacePath,
    publicIp: null,
    createdAt: new Date().toISOString()
  };
  saveData();

  broadcast({ type: 'instance_update', id, meta: instanceMeta[id] });
  res.json({ id, ...instanceMeta[id] });

  // Run terraform in background
  terraformManager.applyInstance({
    id, workspacePath, credentials: awsCredentials,
    name, region, instanceType, ami,
    osType: osType || 'custom',
    keyName: generateKeyPair ? null : (keyName || null),
    generateKeyPair: !!generateKeyPair,
    isWindows: !!isWindows,
    inboundPorts: inPortList,
    outboundPorts: outPortList,
    autoSecurityGroup: !!autoSecurityGroup,
    userScript: userScript || null,
    adminPassword: adminPassword || null,
    tags
  }, (line) => {
    broadcast({ type: 'log', id, line });
  }).then((outputs) => {
    instanceMeta[id].state = 'running';
    instanceMeta[id].publicIp = outputs.public_ip || null;
    instanceMeta[id].instanceId = outputs.instance_id || null;
    if (outputs.keyPairSaved) {
      instanceMeta[id].keyPairSaved = true;
      instanceMeta[id].keyPairPath = outputs.keyPairPath;
    }
    saveData();
    broadcast({ type: 'instance_update', id, meta: instanceMeta[id] });
  }).catch((err) => {
    instanceMeta[id].state = 'error';
    saveData();
    broadcast({ type: 'instance_update', id, meta: instanceMeta[id] });
    broadcast({ type: 'log', id, line: `[ERROR] ${err.message}` });
  });
});

// Update security group ports for an existing instance
app.post('/api/instances/:id/update-ports', async (req, res) => {
  const { id } = req.params;
  const meta = instanceMeta[id];
  if (!meta) return res.status(404).json({ error: 'Instância não encontrada' });
  if (!awsCredentials) return res.status(400).json({ error: 'Configure as credenciais AWS primeiro.' });
  if (meta.managedBy === 'aws') return res.status(403).json({ error: 'Não é possível editar portas de instâncias não gerenciadas pelo Terraform' });

  const { inboundPorts, outboundPorts } = req.body;
  
  const parsePorts = (p) => {
    if (Array.isArray(p)) return p.map(Number).filter(Boolean);
    if (typeof p === 'string') return p.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    return [];
  };

  const inPortList = parsePorts(inboundPorts);
  const outPortList = parsePorts(outboundPorts);

  // Windows: ensure RDP port 3389 is preserved in inbound
  if (meta.isWindows && !inPortList.includes(3389)) inPortList.push(3389);

  // Update metadata
  meta.inboundPorts = inPortList;
  meta.outboundPorts = outPortList;
  meta.state = 'creating'; // Reuse 'creating' state for updates to show progress
  saveData();

  broadcast({ type: 'instance_update', id, meta });
  res.json({ ok: true });

  // Apply changes via Terraform
  terraformManager.applyInstance({
    ...meta,
    id,
    credentials: awsCredentials,
    inboundPorts: inPortList,
    outboundPorts: outPortList
  }, (line) => {
    broadcast({ type: 'log', id, line });
  }).then((outputs) => {
    meta.state = 'running';
    if (outputs.public_ip) meta.publicIp = outputs.public_ip;
    saveData();
    broadcast({ type: 'instance_update', id, meta });
  }).catch((err) => {
    meta.state = 'error';
    saveData();
    broadcast({ type: 'instance_update', id, meta });
    broadcast({ type: 'log', id, line: `[ERROR] ${err.message}` });
  });
});

// Instance control actions: Start
app.post('/api/instances/:id/start', async (req, res) => {
  const { id } = req.params;
  const meta = instanceMeta[id];
  const instanceId = meta ? meta.instanceId : id; // Handle both managed and discovered IDs
  if (!instanceId) return res.status(404).json({ error: 'ID da instância AWS não encontrado.' });
  if (!awsCredentials) return res.status(400).json({ error: 'Configure as credenciais AWS primeiro.' });

  try {
    const ec2 = getEC2Client();
    if (!ec2) return res.status(400).json({ error: 'Configure as credenciais AWS primeiro.' });
    await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
    if (meta) {
      meta.state = 'pending';
      saveData();
      broadcast({ type: 'instance_update', id, meta });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Instance control actions: Stop
app.post('/api/instances/:id/stop', async (req, res) => {
  const { id } = req.params;
  const meta = instanceMeta[id];
  const instanceId = meta ? meta.instanceId : id;
  if (!instanceId) return res.status(404).json({ error: 'ID da instância AWS não encontrado.' });
  if (!awsCredentials) return res.status(400).json({ error: 'Configure as credenciais AWS primeiro.' });

  try {
    const ec2 = getEC2Client();
    if (!ec2) return res.status(400).json({ error: 'Configure as credenciais AWS primeiro.' });
    await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
    if (meta) {
      meta.state = 'stopping';
      saveData();
      broadcast({ type: 'instance_update', id, meta });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Instance control actions: Reboot
app.post('/api/instances/:id/reboot', async (req, res) => {
  const { id } = req.params;
  const meta = instanceMeta[id];
  const instanceId = meta ? meta.instanceId : id;
  if (!instanceId) return res.status(404).json({ error: 'ID da instância AWS não encontrado.' });
  if (!awsCredentials) return res.status(400).json({ error: 'Configure as credenciais AWS primeiro.' });

  try {
    const ec2 = getEC2Client();
    if (!ec2) return res.status(400).json({ error: 'Configure as credenciais AWS primeiro.' });
    await ec2.send(new RebootInstancesCommand({ InstanceIds: [instanceId] }));
    if (meta) {
      meta.state = 'rebooting';
      saveData();
      broadcast({ type: 'instance_update', id, meta });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get terraform plan for an instance (preview)
app.post('/api/instances/:id/plan', async (req, res) => {
  const { id } = req.params;
  const meta = instanceMeta[id];
  if (!meta) return res.status(404).json({ error: 'Instância não encontrada' });
  if (!awsCredentials) return res.status(400).json({ error: 'Configure as credenciais AWS primeiro.' });

  res.json({ ok: true, message: 'Plan iniciado — acompanhe no terminal ao vivo.' });

  terraformManager.planInstance({
    id,
    workspacePath: meta.workspacePath,
    credentials: awsCredentials,
    name: meta.name,
    region: meta.region,
    instanceType: meta.instanceType,
    ami: meta.ami,
    osType: meta.osType || 'custom',
    keyName: meta.keyName,
    generateKeyPair: meta.generateKeyPair || false,
    isWindows: meta.isWindows || false,
    inboundPorts: meta.inboundPorts || [],
    outboundPorts: meta.outboundPorts || [],
    autoSecurityGroup: meta.autoSecurityGroup || false,
    userScript: meta.userScript || null
  }, (line) => {
    broadcast({ type: 'log', id, line });
  }).catch((err) => {
    broadcast({ type: 'log', id, line: `[ERROR] ${err.message}` });
  });
});

// Destroy an instance
app.delete('/api/instances/:id', async (req, res) => {
  const { id } = req.params;
  const meta = instanceMeta[id];
  if (!meta) return res.status(404).json({ error: 'Instância não encontrada' });

  instanceMeta[id].state = 'destroying';
  saveData();
  broadcast({ type: 'instance_update', id, meta: instanceMeta[id] });
  res.json({ ok: true });

  terraformManager.destroyInstance({
    ...meta,
    credentials: awsCredentials
  }, (line) => {
    broadcast({ type: 'log', id, line });
  }).then(() => {
    delete instanceMeta[id];
    saveData();
    broadcast({ type: 'instance_deleted', id });
  }).catch((err) => {
    console.error('🔥 ERROR IN DESTROY:', err.stack);
    instanceMeta[id].state = 'error';
    saveData();
    broadcast({ type: 'instance_update', id, meta: instanceMeta[id] });
    broadcast({ type: 'log', id, line: `[ERROR] ${err.message}` });
  });
});

// Download .pem key pair for an instance
app.get('/api/instances/:id/keypair', (req, res) => {
  const { id } = req.params;
  const meta = instanceMeta[id];
  if (!meta) return res.status(404).json({ error: 'Inst\u00e2ncia n\u00e3o encontrada' });
  const pemPath = terraformManager.getKeyPairPath(meta.workspacePath);
  if (!require('fs').existsSync(pemPath)) {
    return res.status(404).json({ error: 'Arquivo .pem n\u00e3o encontrado para esta inst\u00e2ncia.' });
  }
  res.download(pemPath, `${meta.name}-keypair.pem`);
});

// Get generated .tf files for an instance
app.get('/api/instances/:id/files', (req, res) => {
  const { id } = req.params;
  const meta = instanceMeta[id];
  if (!meta) return res.status(404).json({ error: 'Instância não encontrada (AWS ou Local)' });
  if (meta.managedBy === 'aws') return res.status(404).json({ error: 'Arquivos .tf não existem para instâncias externas da AWS.' });
  const files = terraformManager.readWorkspaceFiles(meta.workspacePath);
  res.json(files);
});

// Get CloudWatch metrics
app.get('/api/instances/:id/metrics', async (req, res) => {
  const { id } = req.params;
  const { period, duration } = req.query;
  const meta = instanceMeta[id];
  
  const actualInstanceId = meta?.instanceId || id;
  const region = meta?.region || awsCredentials?.region;

  if (!awsCredentials) return res.status(400).json({ error: 'Configure as credenciais AWS primeiro.' });
  if (!actualInstanceId || (actualInstanceId === id && !actualInstanceId.startsWith('i-'))) {
    return res.status(400).json({ error: 'ID de instância AWS indisponível.' });
  }

  try {
    const cw = getCloudWatchClient(region);
    const endTime = new Date();
    const durationMins = parseInt(duration) || 120; // Default to 2h
    const startTime = new Date(endTime.getTime() - durationMins * 60 * 1000);
    const periodSecs = parseInt(period) || 300; // Default to 5m

    const getMetric = async (metricName) => {
      let stat = 'Average';
      if (metricName.includes('Network') || metricName.includes('Disk') || metricName.includes('EBS')) stat = 'Sum';
      if (metricName.includes('StatusCheckFailed') || metricName.includes('CPUCreditBalance')) stat = 'Maximum';

      const command = new GetMetricStatisticsCommand({
        Namespace: 'AWS/EC2',
        MetricName: metricName,
        Dimensions: [{ Name: 'InstanceId', Value: actualInstanceId }],
        StartTime: startTime,
        EndTime: endTime,
        Period: periodSecs,
        Statistics: [stat]
      });
      const data = await cw.send(command).catch(err => {
        console.warn(`Metric ${metricName} fetch failed:`, err.message);
        return { Datapoints: [] };
      });
      return data.Datapoints.sort((a, b) => new Date(a.Timestamp) - new Date(b.Timestamp)).map(dp => ({
        timestamp: dp.Timestamp,
        value: dp[stat] || 0
      }));
    };

    const mergeMetrics = (datasets) => {
      const merged = {};
      datasets.forEach(ds => {
        ds.forEach(dp => {
          const ts = new Date(dp.timestamp).getTime();
          if (!merged[ts]) merged[ts] = { timestamp: dp.timestamp, value: 0 };
          merged[ts].value += dp.value;
        });
      });
      return Object.values(merged).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    };

    const [cpu, netIn, netOut, diskRead, diskWrite, ebsRead, ebsWrite, health, diskReadOps, diskWriteOps, ebsReadOps, ebsWriteOps, cpuCredits] = await Promise.all([
      getMetric('CPUUtilization'),
      getMetric('NetworkIn'),
      getMetric('NetworkOut'),
      getMetric('DiskReadBytes'),
      getMetric('DiskWriteBytes'),
      getMetric('EBSReadBytes'),
      getMetric('EBSWriteBytes'),
      getMetric('StatusCheckFailed'),
      getMetric('DiskReadOps'),
      getMetric('DiskWriteOps'),
      getMetric('EBSReadOps'),
      getMetric('EBSWriteOps'),
      getMetric('CPUCreditBalance')
    ]);

    res.json({ 
      cpu, 
      netIn, 
      netOut, 
      diskRead: mergeMetrics([diskRead, ebsRead]), 
      diskWrite: mergeMetrics([diskWrite, ebsWrite]),
      diskIopsRead: mergeMetrics([diskReadOps, ebsReadOps]),
      diskIopsWrite: mergeMetrics([diskWriteOps, ebsWriteOps]),
      cpuCredits,
      health 
    });
  } catch (err) {
    console.error('CloudWatch metrics error:', err);
    res.status(500).json({ error: 'Erro ao buscar métricas do CloudWatch' });
  }
});

// Serve frontend for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 EC2 Terraform Dashboard running at http://localhost:${PORT}\n`);
});
