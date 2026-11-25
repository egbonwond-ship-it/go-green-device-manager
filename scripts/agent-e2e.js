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
  // The Go-Green VPN, pointed at a documentation address so the test tunnel never carries real traffic.
  const vpnKey = require('crypto').generateKeyPairSync('x25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const vpnEnv = { GGVPN_SERVER_PUBKEY: vpnKey, GGVPN_ENDPOINT: '192.0.2.1:51820', GGVPN_DNS: 'none', GGVPN_ROUTES: '10.99.0.0/24' };
  // GitHub's Windows machines run Windows Server, which task sequences normally skip.
  const server = spawn(process.execPath, [path.join(ROOT, 'dev-server.js')], { env: { ...process.env, ...vpnEnv, OSD_ALLOW_SERVER: '1', PORT: String(PORT) }, stdio: 'inherit' });
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
    console.log('Remote desktop reach:', JSON.stringify({ joinType: dev.joinType, domain: dev.domain, fqdn: dev.fqdn, ips: dev.ips, rdpPort: dev.rdpPort, tailscale: dev.tailscale }));
    assert.ok(['Domain', 'Hybrid', 'Entra', 'Workgroup'].includes(dev.joinType), 'domain or workgroup reported');
    assert.ok(dev.ips.length > 0, 'addresses reported');
    if (WIN) assert.ok(dev.rdpPort > 0, 'Remote Desktop port reported');

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

    // Remote desktop: Windows must turn Remote Desktop on and off; macOS may refuse without MDM, so log it.
    for (const type of ['remoteon', 'remoteoff']) {
      const rr = await api('POST', '/api/console/commands', { type, deviceIds: [dev.id] });
      if (!WIN && !MAC) { assert.equal(rr.commands[0].status, 'skipped', 'remote desktop is not managed on Linux'); break; }
      agent(WIN ? '-Run' : 'run');
      st = await api('GET', '/api/console/state');
      const rc = st.commands.find(c => c.runId === rr.runId);
      console.log(`Remote desktop ${type}:`, rc.status, rc.output, 'reported remoteOn =', st.devices[0].remoteOn);
      if (WIN) {
        assert.equal(rc.status, 'succeeded', `${type} succeeded`);
        assert.equal(st.devices[0].remoteOn, type === 'remoteon', 'remote desktop state reported');
      } else {
        assert.ok(['succeeded', 'failed'].includes(rc.status) && rc.output, 'Screen Sharing result reported');
        if (rc.status === 'succeeded') assert.equal(st.devices[0].remoteOn, type === 'remoteon');
      }
    }

    // Go-Green VPN: Windows and Linux set up a WireGuard tunnel with their own key; macOS uses an installer.
    for (const type of ['ggvpnon', 'ggvpnoff']) {
      const vr = await api('POST', '/api/console/commands', { type, deviceIds: [dev.id] });
      if (MAC) { assert.equal(vr.commands[0].status, 'skipped', 'Macs use a downloaded installer'); break; }
      agent(WIN ? '-Run' : 'run');
      st = await api('GET', '/api/console/state');
      const vc = st.commands.find(c => c.runId === vr.runId);
      const g = st.devices[0].ggvpn;
      console.log(`Go-Green VPN ${type}:`, vc.status, vc.output, JSON.stringify(g));
      assert.equal(vc.status, 'succeeded', `${type} succeeded`);
      if (type === 'ggvpnon') {
        assert.match(g.reported?.publicKey || '', /^[A-Za-z0-9+/]{43}=$/, 'device reports its own public key');
        assert.equal(g.reported.address, '10.99.0.100');
        assert.equal(g.reported.up, true, 'tunnel is up');
      } else assert.equal(g?.reported ?? null, null, 'tunnel removed');
    }

    // Uninstall through a deployment, too.
    await api('PUT', '/api/console/objects/deployment/dep-e2e', { doc: { id: 'dep-e2e', name: 'E2E install', kind: 'app', targetId: 'app-e2e', collectionId: 'c-all', action: 'Uninstall', enabled: true, respectMW: true, restart: 'Suppress', retryAt: Date.now() } });
    agent(WIN ? '-Run' : 'run');
    st = await api('GET', '/api/console/state');
    assert.ok(!st.devices[0].installed.includes('app-e2e'), 'test app removed');

    // Disk encryption: every agent reports it. GitHub's Windows machines run Windows Server without the
    // BitLocker feature, so turning it on must fail with a clear reason; Linux is report-only. (Not run
    // on the Mac, where it would set up FileVault on the test machine.)
    console.log('Disk encryption:', JSON.stringify(st.devices[0].encryption));
    assert.equal(st.devices[0].encryption?.kind, WIN ? 'BitLocker' : MAC ? 'FileVault' : 'LUKS', 'encryption reported');
    if (!MAC) {
      const er = await api('POST', '/api/console/commands', { type: 'encon', deviceIds: [dev.id] });
      if (WIN) {
        agent('-Run');
        st = await api('GET', '/api/console/state');
        const ec = st.commands.find(c => c.runId === er.runId);
        console.log('Turn on encryption:', ec.status, ec.output);
        assert.ok(ec.status === 'succeeded' || /BitLocker|TPM/.test(ec.output), 'turning BitLocker on succeeds or explains why not');
      } else assert.equal(er.commands[0].status, 'skipped', 'LUKS is report-only');
    }

    // Local update server: PCs in its collection get Windows Update pointed at it, and back again when
    // it's removed. (Installing WSUS itself takes too long for CI and needs Microsoft Update.)
    if (WIN) {
      const url = 'http://wsus.example.invalid:8530';
      await api('PUT', '/api/console/objects/updateServer/main', { doc: { id: 'main', deviceId: 'some-server', url, products: ['Windows 11'], classifications: ['Security Updates'], clientCollectionId: 'c-all' } });
      agent('-Run');
      st = await api('GET', '/api/console/state');
      console.log('Windows Update server:', st.devices[0].wuServer);
      assert.equal(st.devices[0].wuServer, url, 'PC pointed at the local update server');
      await api('DELETE', '/api/console/objects/updateServer/main');
      agent('-Run');
      st = await api('GET', '/api/console/state');
      assert.equal(st.devices[0].wuServer, null, 'setting removed again');
      assert.equal(st.devices[0].wsus, null, 'not an update server');
    }

    // Windows OS deployment: task sequences run step by step. This can't really upgrade the runner,
    // so it checks a readiness failure, a full run of the other steps, a PC already on the target
    // build, and an upgrade whose image can't be fetched.
    if (WIN) {
      console.log('Windows 11 readiness:', JSON.stringify(st.devices[0].osReady));
      assert.ok(st.devices[0].osReady && ['x64', 'arm64'].includes(st.devices[0].osReady.arch), 'Windows 11 readiness reported');
      await api('DELETE', '/api/console/objects/deployment/dep-e2e');
      const put = (kind, doc) => api('PUT', `/api/console/objects/${kind}/${doc.id}`, { doc });
      await put('osImage', { id: 'img-old', name: 'Old Windows', source: 'iso', build: 10240, url: 'https://example.com/old.iso' });
      await put('osImage', { id: 'img-missing', name: 'Missing', source: 'iso', build: 99999, url: '\\\\localhost\\ggt-no-such-share\\win.iso' });
      await put('taskSequence', { id: 'ts-ready', name: 'Needs a huge disk', steps: [{ type: 'readiness', minFreeGB: 100000 }, { type: 'restart' }] });
      await put('taskSequence', { id: 'ts-run', name: 'Full run', steps: [{ type: 'readiness', minFreeGB: 1 }, { type: 'bitlocker' }, { type: 'script', scriptId: 'net' }, { type: 'app', appId: 'app-e2e' }] });
      await put('taskSequence', { id: 'ts-done', name: 'Already upgraded', steps: [{ type: 'readiness', minFreeGB: 100000 }, { type: 'upgrade', imageId: 'img-old' }] });
      await put('taskSequence', { id: 'ts-fetch', name: 'Unreachable image', steps: [{ type: 'upgrade', imageId: 'img-missing' }] });
      for (const t of ['ts-ready', 'ts-run', 'ts-fetch', 'ts-done']) await put('deployment', { id: `dep-${t}`, name: t, kind: 'os', targetId: t, collectionId: 'c-all', enabled: true, respectMW: false, restart: 'Suppress' });
      agent('-Run');
      st = await api('GET', '/api/console/state');
      const ds = st.devices[0].depState;
      console.log('Task sequences:', JSON.stringify({ ready: ds['dep-ts-ready'], run: ds['dep-ts-run'], fetch: ds['dep-ts-fetch'], done: ds['dep-ts-done'] }));
      assert.equal(ds['dep-ts-ready']?.state, 'reqnotmet', 'readiness failure reported');
      assert.equal(ds['dep-ts-ready'].errorCode, 'NOT_READY');
      assert.equal(ds['dep-ts-run']?.state, 'success', 'task sequence ran every step');
      assert.ok(st.devices[0].installed.includes('app-e2e'), 'the task sequence installed the app');
      assert.equal(ds['dep-ts-fetch']?.state, 'error', 'unreachable image reported');
      assert.ok(['DOWNLOAD', '0x80070070'].includes(ds['dep-ts-fetch'].errorCode), `image error code ${ds['dep-ts-fetch'].errorCode}`);
      assert.equal(ds['dep-ts-done']?.state, 'success', 'a PC already on the target build counts as done');
      assert.match(ds['dep-ts-done'].message || '', /Already on Windows build/);
      // A finished task sequence doesn't run again.
      agent('-Run');
      st = await api('GET', '/api/console/state');
      assert.equal(st.devices[0].depState['dep-ts-run'].at, ds['dep-ts-run'].at, 'finished task sequence not rerun');
    }

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
