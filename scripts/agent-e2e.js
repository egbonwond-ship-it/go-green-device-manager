// End-to-end test of the real agent against a local server, on whatever OS this runs on.
// CI runs it on Windows, macOS and Ubuntu (.github/workflows/azure-static-web-apps.yml).
//   node scripts/agent-e2e.js            (needs admin/root rights for the agent: uses sudo on macOS/Linux)
// It enrols this machine, deploys a small test app, runs a script, and checks every result
// comes back through the API the console uses.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ggt-agent-'));
const ROOT = path.join(__dirname, '..');
const SCAN = process.env.E2E_UPDATE_SCAN === '1';

function agent(...args) {
  let cmd, argv;
  if (WIN) {
    cmd = 'powershell.exe';
    argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'app/agent/ggt-agent.ps1'), ...args, '-AgentDir', HOME, ...(SCAN ? [] : ['-SkipUpdateScan'])];
  } else {
    const py = ['python3', path.join(ROOT, 'app/agent/ggt-agent.py'), ...args, '--home', HOME, ...(SCAN ? [] : ['--skip-update-scan'])];
    const root = process.getuid && process.getuid() === 0;
    [cmd, ...argv] = root ? py : ['sudo', '-E', ...py];
  }
  console.log(`$ ${cmd} ${argv.join(' ')}`);
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 30 * 60000 });
  process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
  assert.equal(r.status, 0, `agent exited with ${r.status}`);
}
async function api(method, p, body, retry = true) {
  let r;
  try {
    r = await fetch(BASE + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    // The agent runs synchronously and can take longer than the server's keep-alive timeout,
    // so the first request afterwards may land on a socket the server already closed.
    if (retry) return api(method, p, body, false);
    throw e;
  }
  const j = await r.json();
  assert.ok(r.ok, `${method} ${p} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
}

// A tiny "application" each platform can install and the agent can detect.
const TEST_APP = {
  id: 'app-e2e', name: 'GGT Test App', version: '1.0', publisher: 'Go-Green QA', detectName: 'GGT Test App', platforms: ['Windows', 'macOS', 'Linux'],
  windows: {
    command: "New-Item 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\GGTTestApp' -Force | Out-Null; Set-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\GGTTestApp' -Name DisplayName -Value 'GGT Test App'; Set-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\GGTTestApp' -Name DisplayVersion -Value '1.0'",
    uninstall: "Remove-Item 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\GGTTestApp' -Force",
  },
  macos: {
    command: "mkdir -p '/Applications/GGT Test App.app/Contents' && /usr/libexec/PlistBuddy -c 'Add :CFBundleName string GGT Test App' -c 'Add :CFBundleShortVersionString string 1.0' '/Applications/GGT Test App.app/Contents/Info.plist'",
    uninstall: "rm -rf '/Applications/GGT Test App.app'",
  },
  // Linux inventory comes from the package database, so register a real (empty) package.
  linux: {
    command: 'if command -v dpkg-deb >/dev/null; then d=$(mktemp -d); mkdir -p $d/DEBIAN; printf "Package: ggt-test-app\\nVersion: 1.0\\nArchitecture: all\\nMaintainer: GGT Test App <qa@example.com>\\nDescription: GGT Test App\\n" > $d/DEBIAN/control; dpkg-deb --build $d /tmp/ggt-test-app.deb && dpkg -i /tmp/ggt-test-app.deb; else exit 1; fi',
    uninstall: 'dpkg -r ggt-test-app',
  },
};
TEST_APP.detectName = process.platform === 'linux' ? 'ggt-test-app' : 'GGT Test App';

(async () => {
  const server = spawn(process.execPath, [path.join(ROOT, 'dev-server.js')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'inherit' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/health'); break; } catch { await new Promise(r => setTimeout(r, 200)); } }
    await api('GET', '/api/console/state'); // creates the built-in collections and scripts

    agent(WIN ? '-Install' : 'install', ...(WIN ? ['-Server', BASE, '-Token', 'dev-token', '-NoSchedule'] : ['--server', BASE, '--token', 'dev-token', '--no-schedule']));
    let st = await api('GET', '/api/console/state');
    assert.equal(st.devices.length, 1, 'device enrolled');
    const dev = st.devices[0];
    console.log('Enrolled:', JSON.stringify({ name: dev.name, os: dev.os, type: dev.type, cpu: dev.cpu, ramGB: dev.ramGB, diskFreePct: dev.diskFreePct, ip: dev.ip, fwOn: dev.fwOn, encrypted: dev.encrypted, admins: dev.localAdmins, software: dev.softwareCount }));
    assert.equal(dev.platform, WIN ? 'Windows' : MAC ? 'macOS' : 'Linux');
    assert.ok(dev.os && dev.os !== 'Unknown', 'OS reported');
    assert.ok(dev.ramGB > 0 && dev.diskGB > 0, 'hardware reported');
    assert.ok(dev.softwareCount > 0, 'software inventory reported');
    assert.ok(dev.online, 'online');

    // Deploy the test app to All Systems and run a script.
    await api('PUT', '/api/console/objects/app/app-e2e', { doc: TEST_APP });
    await api('PUT', '/api/console/objects/deployment/dep-e2e', { doc: { id: 'dep-e2e', name: 'E2E install', kind: 'app', targetId: 'app-e2e', collectionId: 'c-all', action: 'Install', enabled: true, respectMW: true, restart: 'Suppress' } });
    const script = st.scripts.find(s => s.id === (WIN ? 'disk' : 'df'));
    const run = await api('POST', '/api/console/commands', { type: 'script', scriptId: script.id, deviceIds: [dev.id] });
    agent(WIN ? '-Run' : 'run');

    st = await api('GET', '/api/console/state');
    const d2 = st.devices[0];
    const cmd = st.commands.find(c => c.runId === run.runId);
    console.log('Script result:', cmd.status, JSON.stringify(cmd.output).slice(0, 300));
    assert.equal(cmd.status, 'succeeded', 'script ran');
    assert.ok(cmd.output.length > 0, 'script output captured');
    console.log('Deployment state:', JSON.stringify(d2.depState['dep-e2e']));
    assert.equal(d2.depState['dep-e2e']?.state, 'success', 'test app installed');
    assert.ok(d2.installed.includes('app-e2e'), 'test app detected in inventory');

    // Uninstall through a deployment, too.
    await api('PUT', '/api/console/objects/deployment/dep-e2e', { doc: { id: 'dep-e2e', name: 'E2E install', kind: 'app', targetId: 'app-e2e', collectionId: 'c-all', action: 'Uninstall', enabled: true, respectMW: true, restart: 'Suppress', retryAt: Date.now() } });
    agent(WIN ? '-Run' : 'run');
    st = await api('GET', '/api/console/state');
    assert.ok(!st.devices[0].installed.includes('app-e2e'), 'test app removed');

    if (SCAN) {
      const d3 = st.devices[0];
      console.log('Update scan:', d3.updatesScannedAt ? `${d3.missingUpdates.length} missing, ${d3.installedUpdates.length} installed` : 'not reported', JSON.stringify(st.updates.slice(0, 3)));
      assert.ok(d3.updatesScannedAt || d3.agentErrors.length, 'update scan reported or its failure explained');
    }
    console.log(`✓ agent end to end on ${process.platform}`);
  } finally {
    server.kill();
    if (!WIN) spawnSync('sudo', ['rm', '-rf', HOME]); else fs.rmSync(HOME, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
