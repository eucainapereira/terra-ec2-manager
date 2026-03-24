const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const TERRAFORM_BIN = 'terraform';

// ── Template generators ───────────────────────────────────────────

function generateProviderTf(credentials, region) {
  return `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

provider "aws" {
  region     = "${region}"
  access_key = "${credentials.accessKey}"
  secret_key = "${credentials.secretKey}"
}
`;
}

// ── AMI lookup via aws_ami data source (EC2 filters — no SSM permission needed) ──
// Uses ec2:DescribeImages which is included in basic Terraform IAM policies.
// Each entry: { owners: [...], filters: [{name, values}] }
const AMI_FILTERS = {
  'amazon-linux': {
    owners: ['"amazon"'],
    filters: [
      { name: 'name',                values: ['"al2023-ami-*-x86_64"'] },
      { name: 'virtualization-type', values: ['"hvm"'] },
      { name: 'state',               values: ['"available"'] },
    ]
  },
  'ubuntu': {
    owners: ['"099720109477"'],  // Canonical
    filters: [
      { name: 'name',                values: ['"ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"'] },
      { name: 'virtualization-type', values: ['"hvm"'] },
      { name: 'state',               values: ['"available"'] },
    ]
  },
  'debian': {
    owners: ['"136693071363"'],  // Debian official
    filters: [
      { name: 'name',                values: ['"debian-12-amd64-*"'] },
      { name: 'virtualization-type', values: ['"hvm"'] },
      { name: 'state',               values: ['"available"'] },
    ]
  },
  'windows-2022': {
    owners: ['"801119661308"'],  // Amazon Windows AMIs
    filters: [
      { name: 'name',                values: ['"Windows_Server-2022-English-Full-Base-*"'] },
      { name: 'virtualization-type', values: ['"hvm"'] },
      { name: 'state',               values: ['"available"'] },
    ]
  },
  'windows-2019': {
    owners: ['"801119661308"'],
    filters: [
      { name: 'name',                values: ['"Windows_Server-2019-English-Full-Base-*"'] },
      { name: 'virtualization-type', values: ['"hvm"'] },
      { name: 'state',               values: ['"available"'] },
    ]
  },
  'rhel': {
    owners: ['"309956199498"'],  // Red Hat
    filters: [
      { name: 'name',                values: ['"RHEL-9*x86_64*"'] },
      { name: 'virtualization-type', values: ['"hvm"'] },
      { name: 'state',               values: ['"available"'] },
    ]
  },
};

function generateAmiDataSource(osType) {
  const def = AMI_FILTERS[osType];
  if (!def) return null;
  const filterLines = def.filters
    .map(f => `  filter {\n    name   = "${f.name}"\n    values = [${f.values.join(', ')}]\n  }`)
    .join('\n');
  return `
# Fetches the latest official AMI via EC2 DescribeImages (no SSM permission needed)
data "aws_ami" "os" {
  most_recent = true
  owners      = [${def.owners.join(', ')}]
${filterLines}
}
`;
}

function generateMainTf({ id, name, instanceType, ami, osType, keyName, generateKeyPair, inboundPorts, outboundPorts, autoSecurityGroup, userScript, adminPassword, isWindows }) {
  let inPorts = inboundPorts && inboundPorts.length > 0 ? inboundPorts : [];
  let outPorts = outboundPorts && outboundPorts.length > 0 ? outboundPorts : [];
  
  if (autoSecurityGroup) {
    const defaultIn = isWindows ? [3389, 80, 443] : [22, 80, 443];
    inPorts = [...new Set([...inPorts, ...defaultIn])];
    // Auto-SG usually allows all outbound
    if (outPorts.length === 0) outPorts = [0];
  }

  const effectiveKeyName = generateKeyPair ? `${id}-keypair` : keyName;

  // tls_private_key + aws_key_pair if auto-generating
  const keyPairResource = generateKeyPair ? `
resource "tls_private_key" "keypair" {
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "keypair" {
  key_name   = "${id}-keypair"
  public_key = tls_private_key.keypair.public_key_openssh
}
` : '';

  const hasInbound = inPorts.length > 0;
  const allowAllOutbound = outPorts.length === 0 || outPorts.includes(0);

  const sgResource = `
resource "aws_security_group" "sg" {
  name        = "${name}-sg"
  description = "Security group for ${name} managed by TerraEC2"

${inPorts.map(p => `  ingress {
    from_port   = ${p}
    to_port     = ${p}
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Port ${p}"
  }`).join('\n\n')}

${allowAllOutbound ? `  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound"
  }` : outPorts.map(p => `  egress {
    from_port   = ${p}
    to_port     = ${p}
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Porta de saida ${p}"
  }`).join('\n\n')}

  tags = {
    Name      = "${name}-sg"
    ManagedBy = "terraform-dashboard"
  }
}
`;

  // Use aws_ami data source for known OS types (only needs ec2:DescribeImages)
  const amiDataBlock = generateAmiDataSource(osType);
  const amiRef = amiDataBlock ? 'data.aws_ami.os.id' : `"${ami}"`;

  // If Windows and an admin password was provided, inject it via user_data
  let finalUserScript = userScript || '';
  if (isWindows && adminPassword) {
    const pwScript = `<powershell>\nnet user Administrator "${adminPassword}"\n</powershell>`;
    finalUserScript = finalUserScript ? `${pwScript}\n${finalUserScript}` : pwScript;
  }

  const userDataBlock = finalUserScript
    ? `  user_data = base64encode(<<-EOF\n${finalUserScript}\nEOF\n  )`
    : '';

  const sgRef = `  vpc_security_group_ids = [aws_security_group.sg.id]\n`;
  const keyRef = effectiveKeyName
    ? `  key_name      = ${generateKeyPair ? 'aws_key_pair.keypair.key_name' : `"${effectiveKeyName}"`}\n`
    : '';

  return `${amiDataBlock || ''}${keyPairResource}${sgResource}
resource "aws_instance" "ec2" {
  ami           = ${amiRef}
  instance_type = "${instanceType}"
${keyRef}${sgRef}${userDataBlock ? userDataBlock + '\n' : ''}
  tags = {
    Name      = "${name}"
    ManagedBy = "terraform-dashboard"
    OS        = "${isWindows ? 'windows' : 'linux'}"
  }
}
`;
}

function generateOutputsTf(generateKeyPair, hasSG) {
  return `output "instance_id" {
  value = aws_instance.ec2.id
}

output "public_ip" {
  value = aws_instance.ec2.public_ip
}

output "private_ip" {
  value = aws_instance.ec2.private_ip
}
${generateKeyPair ? `
output "private_key_pem" {
  value     = tls_private_key.keypair.private_key_pem
  sensitive = true
}
` : ''}${hasSG ? `
output "security_group_id" {
  value = aws_security_group.sg.id
}
` : ''}`;
}

function writeTerraformFiles({ id, workspacePath, credentials, region, name, instanceType, ami, osType, keyName, generateKeyPair, inboundPorts, outboundPorts, autoSecurityGroup, userScript, adminPassword, isWindows }) {
  fs.writeFileSync(path.join(workspacePath, 'provider.tf'), generateProviderTf(credentials, region));
  fs.writeFileSync(path.join(workspacePath, 'main.tf'), generateMainTf({ id, name, instanceType, ami, osType, keyName, generateKeyPair, inboundPorts, outboundPorts, autoSecurityGroup, userScript, adminPassword, isWindows }));
  fs.writeFileSync(path.join(workspacePath, 'outputs.tf'), generateOutputsTf(generateKeyPair, true));
}

// ── Terraform runner ─────────────────────────────────────────────

function runTerraform(args, workspacePath, onLog) {
  return new Promise((resolve, reject) => {
    onLog(`\n▸ Executando: terraform ${args.join(' ')}\n`);
    const proc = spawn(TERRAFORM_BIN, args, {
      cwd: workspacePath,
      shell: true,
      env: { ...process.env, TF_INPUT: '0', TF_CLI_ARGS: '-no-color' }
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => {
      const txt = data.toString();
      stdout += txt;
      txt.split('\n').forEach(line => onLog(line));
    });
    proc.stderr.on('data', (data) => {
      const txt = data.toString();
      stderr += txt;
      txt.split('\n').forEach(line => onLog('[stderr] ' + line));
    });
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`terraform ${args[0]} falhou com código ${code}.\n${stderr}`));
    });
    proc.on('error', (err) => reject(new Error(`Não foi possível iniciar o terraform: ${err.message}`)));
  });
}

async function ensureInit(workspacePath, onLog) {
  const dotTerraform = path.join(workspacePath, '.terraform');
  if (fs.existsSync(dotTerraform)) {
    // Already initiated, skip to save time and avoid network issues
    return;
  }
  onLog('▸ Inicializando workspace do Terraform...');
  await runTerraform(['init'], workspacePath, onLog);
}

function parseOutputs(outputJson) {
  try {
    const parsed = JSON.parse(outputJson);
    const result = {};
    for (const [key, val] of Object.entries(parsed)) {
      result[key] = val.value;
    }
    return result;
  } catch (_) { return {}; }
}

// Read generated .tf files from a workspace
function readWorkspaceFiles(workspacePath) {
  const files = ['provider.tf', 'main.tf', 'outputs.tf'];
  const result = {};
  for (const f of files) {
    const fp = path.join(workspacePath, f);
    result[f] = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : null;
  }
  return result;
}

// Get path to saved .pem key pair for a workspace
function getKeyPairPath(workspacePath) {
  return path.join(workspacePath, 'keypair.pem');
}

function saveKeyPem(workspacePath, pemContent) {
  const pemPath = getKeyPairPath(workspacePath);
  fs.writeFileSync(pemPath, pemContent, { mode: 0o600 });
  return pemPath;
}

// ── Public API ────────────────────────────────────────────────────

async function applyInstance({ id, workspacePath, credentials, name, region, instanceType, ami, osType, keyName, generateKeyPair, inboundPorts, outboundPorts, autoSecurityGroup, userScript, adminPassword, isWindows }, onLog) {
  writeTerraformFiles({ id, workspacePath, credentials, region, name, instanceType, ami, osType, keyName, generateKeyPair, inboundPorts, outboundPorts, autoSecurityGroup, userScript, adminPassword, isWindows });

  await ensureInit(workspacePath, onLog);
  await runTerraform(['apply', '-auto-approve'], workspacePath, onLog);

  const outputRaw = await runTerraform(['output', '-json'], workspacePath, onLog);
  const outputs = parseOutputs(outputRaw);

  if (generateKeyPair && outputs.private_key_pem) {
    const pemPath = saveKeyPem(workspacePath, outputs.private_key_pem);
    onLog(`\n✅ Chave privada salva em: ${pemPath}\n`);
    outputs.keyPairSaved = true;
    outputs.keyPairPath = pemPath;
  }
  return outputs;
}


async function planInstance({ id, workspacePath, credentials, name, region, instanceType, ami, osType, keyName, generateKeyPair, inboundPorts, outboundPorts, autoSecurityGroup, userScript, adminPassword, isWindows }, onLog) {
  writeTerraformFiles({ id, workspacePath, credentials, region, name, instanceType, ami, osType, keyName, generateKeyPair, inboundPorts, outboundPorts, autoSecurityGroup, userScript, adminPassword, isWindows });
  await ensureInit(workspacePath, onLog);
  await runTerraform(['plan'], workspacePath, onLog);
}

async function destroyInstance({ id, workspacePath, credentials, name, region, instanceType, ami, osType, keyName, generateKeyPair, inboundPorts, outboundPorts, autoSecurityGroup, userScript, adminPassword, isWindows }, onLog) {
  if (!fs.existsSync(workspacePath)) {
    onLog('[WARN] Workspace não encontrado, nada para destruir.');
    return;
  }
  
  // Regenerate files before destroying to fix syntax errors from older versions
  writeTerraformFiles({ id, workspacePath, credentials, region, name, instanceType, ami, osType, keyName, generateKeyPair, inboundPorts, outboundPorts, autoSecurityGroup, userScript, adminPassword, isWindows });
  
  await ensureInit(workspacePath, onLog);
  await runTerraform(['destroy', '-auto-approve'], workspacePath, onLog);
}

module.exports = { applyInstance, planInstance, destroyInstance, readWorkspaceFiles, getKeyPairPath };
