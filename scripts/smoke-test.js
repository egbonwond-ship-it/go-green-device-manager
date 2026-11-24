// Fast checks that run in CI before deploy: the API, sign-in rules, policy building and the
// collection rules shared with the console. No browser, no database and no dependencies needed.
const assert = require('assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

process.env.AGENT_ENROLL_TOKEN = 'test-token';
process.env.ADMIN_USERS = 'Admin-User, second@example.com';
const { handle, useStore } = require('../api/src/lib/router');
const { memoryStore } = require('../api/src/lib/storage');
const M = require('../api/src/lib/model');

const who = (user, roles = ['authenticated']) => ({ 'x-ms-client-principal': Buffer.from(JSON.stringify({ identityProvider: 'github', userId: 'x', userDetails: user, userRoles: roles })).toString('base64') });
const ADMIN = who('admin-user');
const call = (method, p, body, headers = ADMIN, query = {}) => handle({ method, path: p, body, headers, query });

(async () => {
  useStore(memoryStore());
  // ---------- health and sign-in
  let r = await call('GET', '/api/health', null, {});
  assert.equal(r.status, 200); assert.equal(r.body.storage, 'memory');
  assert.equal((await call('GET', '/api/console/state', null, {})).status, 401, 'signed-out users get 401');
  r = await call('GET', '/api/console/me', null, who('stranger'));
  assert.equal(r.body.admin, false);
  assert.equal((await call('GET', '/api/console/state', null, who('stranger'))).status, 403, 'non-admins get 403');
  assert.equal((await call('GET', '/api/console/state', null, who('second@example.com'))).status, 200, 'ADMIN_USERS is a case-insensitive list');
  assert.equal((await call('GET', '/api/console/state', null, who('someone', ['authenticated', 'admin']))).status, 200, 'the admin role also works');
  r = await call('GET', '/api/console/state');
  assert.equal(r.status, 200);
  assert.ok(r.body.collections.some(c => c.id === 'c-all') && r.body.baselines.length === 3 && r.body.scripts.length >= 5, 'built-in configuration created');
  assert.equal(r.body.devices.length, 0, 'no demo devices');
  assert.ok(r.body.apps.some(a => a.id === 'app-ggvpn-client' && a.windows.wingetId === 'WireGuard.WireGuard' && a.macos.command), 'the VPN client is in the software library');
  { // a console made before the VPN client existed gets it once; a deleted one stays deleted
    const s0 = memoryStore(); useStore(s0);
    await s0.putObject('settings', 'main', { id: 'main', approvedAdmins: [] });
    assert.ok((await call('GET', '/api/console/state')).body.apps.some(a => a.id === 'app-ggvpn-client'), 'added to an existing console');
    assert.equal((await call('DELETE', '/api/console/objects/app/app-ggvpn-client')).status, 200);
    assert.ok(!(await call('GET', '/api/console/state')).body.apps.some(a => a.id === 'app-ggvpn-client'), 'not added again after deletion');
    useStore(memoryStore()); r = await call('GET', '/api/console/state');
  }
  console.log('✓ sign-in: anonymous 401, non-admin 403, ADMIN_USERS and admin role');

  // ---------- agent enrollment
  const H = { 'x-ggt-enroll-token': 'test-token' };
  const report = { name: 'GGT-LAG-LT001', platform: 'Windows', os: 'Windows 11 Pro 24H2', build: '26100.2314', type: 'Laptop', serial: 'ABC123', ip: '10.10.4.20', ramGB: 16, diskGB: 512, diskFreePct: 40,
    security: { encrypted: true, avOn: true, fwOn: true, defsAgeDays: 0, screenLockMin: 10, usbBlocked: true, pendingReboot: false, localAdmins: ['GGT-LAG-LT001\\Administrator', 'GGT\\Domain Admins'] },
    software: [{ name: '7-Zip 24.08 (x64)', version: '24.08' }, { name: 'FortiClient VPN', version: '7.4.1' }],
    updates: { missing: [{ id: 'KB5046617', kb: 'KB5046617', title: '2026-11 Cumulative Update', classification: 'Security Updates', severity: 'Critical', released: new Date(Date.now() - 10 * 86400000).toISOString(), reboot: true }], installed: [{ id: 'KB5044284', kb: 'KB5044284', title: 'Update' }] } };
  assert.equal((await call('POST', '/api/agent/checkin', report, {})).status, 401, 'token required');
  assert.equal((await call('POST', '/api/agent/checkin', { name: 'X' }, H)).status, 400, 'validation');
  r = await call('POST', '/api/agent/checkin', report, H);
  assert.equal(r.status, 200); assert.ok(r.body.deviceKey, 'first check-in returns a device key');
  const id = r.body.deviceId, KEY = { ...H, 'x-ggt-device-key': r.body.deviceKey };
  assert.equal((await call('POST', '/api/agent/checkin', { ...report, deviceId: id }, H)).status, 403, 'device key required after enrollment');
  assert.equal((await call('POST', '/api/agent/checkin', { ...report, deviceId: id }, { ...H, 'x-ggt-device-key': 'wrong' })).status, 403);
  r = await call('POST', '/api/agent/checkin', { ...report, deviceId: id, security: { ...report.security, fwOn: false, localAdmins: [...report.security.localAdmins, 'GGT-LAG-LT001\\bob'] } }, KEY);
  assert.equal(r.status, 200); assert.equal(r.body.deviceKey, undefined);
  r = await call('POST', '/api/agent/checkin', { ...report }, H);
  assert.equal(r.body.deviceId, id, 'reinstalled agent with the same name and serial keeps its record');
  const KEY2 = { ...H, 'x-ggt-device-key': r.body.deviceKey };
  assert.equal((await call('GET', '/api/agent/policy', null, KEY, { deviceId: id })).status, 403, 'old key stops working after re-enrollment');
  console.log('✓ agent: token, validation, per-device key, re-enrollment');

  // ---------- console view of the device
  await call('PUT', '/api/console/objects/site/site-lag', { doc: { id: 'site-lag', name: 'Lagos HQ', code: 'LAG', subnets: '10.10.0.0/16' } });
  await call('PUT', '/api/console/objects/app/app-7z', { doc: { id: 'app-7z', name: '7-Zip', detectName: '7-Zip', platforms: ['Windows'], windows: { wingetId: '7zip.7zip' } } });
  r = await call('GET', '/api/console/state');
  const d = r.body.devices[0];
  assert.equal(d.site, 'Lagos HQ', 'site from IP range');
  assert.equal(d.osFamily, 'win11');
  assert.deepEqual(d.installed, ['app-7z'], 'library app detected');
  assert.equal(d.vpnInstalled, true);
  assert.deepEqual(d.missingUpdates, ['KB5046617']);
  assert.ok(r.body.updates.find(u => u.id === 'KB5046617').severity === 'Critical', 'update catalogue');
  assert.ok(r.body.alerts.some(a => /Firewall turned off/.test(a.title)) && r.body.alerts.some(a => /New local admin/.test(a.title)), 'alerts raised on changes');
  assert.equal(r.body.devices[0].keyHash, undefined, 'device key hash never leaves the server');
  console.log('✓ console: sites, detection, update catalogue, alerts');

  // ---------- configuration rules
  assert.equal((await call('PUT', '/api/console/objects/collection/c-all', { doc: { id: 'c-all', name: 'Hacked', rules: [] } })).status, 409, 'built-in collections are read-only');
  assert.equal((await call('PUT', '/api/console/objects/command/x', { doc: { id: 'x', name: 'x' } })).status, 404, 'commands cannot be written directly');
  await call('PUT', '/api/console/objects/collection/c-lag', { doc: { id: 'c-lag', name: 'Lagos laptops', match: 'all', rules: [{ field: 'site', op: 'is', value: 'Lagos HQ' }, { field: 'type', op: 'is', value: 'Laptop' }] } });
  await call('PUT', '/api/console/objects/deployment/dep1', { doc: { id: 'dep1', name: '7-Zip', kind: 'app', targetId: 'app-7z', collectionId: 'c-lag', action: 'Install', enabled: true, respectMW: true } });
  await call('PUT', '/api/console/objects/updateGroup/ug1', { doc: { id: 'ug1', name: 'Nov', updateIds: ['KB5046617', 'KB0000001'] } });
  await call('PUT', '/api/console/objects/deployment/dep2', { doc: { id: 'dep2', name: 'Nov updates', kind: 'updates', targetId: 'ug1', collectionId: 'c-all', enabled: true, respectMW: false } });
  await call('PUT', '/api/console/objects/adr/adr1', { doc: { id: 'adr1', name: 'Critical after 3 days', collectionId: 'c-all', enabled: true, severities: ['Critical'], delayDays: 3 } });
  await call('PUT', '/api/console/objects/baseline/bl-sec', { doc: { id: 'bl-sec', remediate: true, rules: [] } });
  assert.equal((await call('DELETE', '/api/console/objects/collection/c-lag')).status, 409, 'collections in use cannot be deleted');
  assert.equal((await call('DELETE', '/api/console/objects/app/app-7z')).status, 409, 'deployed apps cannot be deleted');
  r = await call('GET', '/api/console/state');
  assert.equal(r.body.baselines.find(b => b.id === 'bl-sec').rules.length, 4, 'baseline rules stay as built');
  // A maintenance window that is never open right now blocks the app deployment that respects windows.
  const closed = { id: 'mw1', name: 'Closed', collectionId: 'c-lag', days: 'Sat', start: '00:00', hours: 1, appliesTo: 'All deployments' };
  const isOpen = M.windowOpen(closed);
  await call('PUT', '/api/console/objects/maintenanceWindow/mw1', { doc: closed });

  r = await call('GET', '/api/agent/policy', null, KEY2, { deviceId: id });
  assert.equal(r.status, 200);
  const p = r.body;
  const app = p.deployments.find(x => x.id === 'dep1');
  assert.equal(app.app.wingetId, '7zip.7zip', 'app install method for the platform');
  assert.equal(app.allowedNow, isOpen, 'maintenance window respected');
  assert.deepEqual(p.deployments.find(x => x.id === 'dep2').updateIds, ['KB5046617'], 'only updates the device is missing');
  assert.deepEqual(p.deployments.find(x => x.id === 'adr1').updateIds, ['KB5046617'], 'automatic rule approves matching updates');
  assert.deepEqual(p.remediate.sort(), ['av', 'defs', 'fw'], 'remediation only for baselines with it on (USB rule skipped: not in that baseline)');
  console.log('✓ policy: collections, app methods, update groups, automatic rules, maintenance windows, remediation');

  // ---------- commands and results
  r = await call('POST', '/api/console/commands', { type: 'script', scriptId: 'df', deviceIds: [id] });
  assert.equal(r.body.commands[0].status, 'skipped', 'shell scripts are not sent to Windows');
  r = await call('POST', '/api/console/commands', { type: 'script', scriptId: 'disk', deviceIds: [id] });
  const cmdId = r.body.commands[0].id;
  r = await call('GET', '/api/agent/policy', null, KEY2, { deviceId: id });
  assert.equal(r.body.commands.length, 1); assert.ok(r.body.commands[0].body.includes('Get-Volume'));
  r = await call('GET', '/api/agent/policy', null, KEY2, { deviceId: id });
  assert.equal(r.body.commands.length, 0, 'a command is delivered once');
  assert.equal((await call('POST', '/api/agent/result', { deviceId: id, commandId: cmdId, status: 'succeeded', exitCode: 0, output: 'C 100 GB' }, KEY2)).status, 202);
  assert.equal((await call('POST', '/api/agent/status', { deviceId: id, deploymentId: 'dep1', state: 'error', errorCode: '1603', message: 'failed' }, KEY2)).status, 202);
  r = await call('GET', '/api/console/state');
  assert.equal(r.body.commands.find(c => c.id === cmdId).output, 'C 100 GB');
  assert.equal(r.body.devices[0].depState.dep1.state, 'error');
  assert.ok(r.body.alerts.some(a => /Deployment failed/.test(a.title)));
  r = await call('POST', '/api/console/alerts/ack', { all: true });
  assert.ok(r.body.acknowledged >= 3);
  r = await call('POST', '/api/console/commands', { type: 'remoteon', deviceIds: [id] });
  assert.equal(r.body.commands[0].status, 'queued', 'remote desktop command queued for Windows');
  r = await call('GET', '/api/agent/policy', null, KEY2, { deviceId: id });
  assert.equal(r.body.commands[0].type, 'remoteon');
  assert.equal((await call('POST', '/api/console/commands', { type: 'reboot-now', deviceIds: [id] })).status, 400, 'unknown command type rejected');
  console.log('✓ commands: platform check, single delivery, results, deployment status, alerts, remote desktop');

  // ---------- remote desktop inside and outside the domain
  const RC = await import(pathToFileURL(path.join(__dirname, '../app/js/remote-connect.js')));
  r = await call('POST', '/api/agent/checkin', { ...report, deviceId: id, joinType: 'Domain', domain: 'ggt.local', netbiosDomain: 'GGT', fqdn: 'GGT-LAG-LT001.ggt.local.', ips: ['10.10.4.20', '100.101.5.6', 'nonsense'], rdpPort: 3389, user: 'GGT\\ada', tailscale: { ips: ['100.101.5.6', 'fd7a:115c:a1e0::1'], dnsName: 'ggt-lag-lt001.tail1234.ts.net.', online: true } }, { ...KEY2, 'x-forwarded-for': '102.89.1.10:51234, 10.0.0.1' });
  assert.equal(r.status, 200);
  r = await call('GET', '/api/console/state', null, { ...ADMIN, 'x-forwarded-for': '102.89.1.10' });
  let rd = r.body.devices[0];
  assert.equal(r.body.viewerIp, '102.89.1.10'); assert.equal(rd.publicIp, '102.89.1.10', 'public address from the check-in, port stripped');
  assert.equal(rd.fqdn, 'ggt-lag-lt001.ggt.local'); assert.deepEqual(rd.ips, ['10.10.4.20', '100.101.5.6'], 'invalid addresses dropped');
  assert.equal(rd.tailscale.dnsName, 'ggt-lag-lt001.tail1234.ts.net');
  let rt = RC.route(rd, { viewerIp: '102.89.1.10' });
  assert.equal(rt.address.value, 'ggt-lag-lt001.ggt.local', 'same network + domain: connect by domain name (Kerberos)');
  assert.equal(RC.suggestedUser(rd), 'GGT\\ada');
  rt = RC.route(rd, { viewerIp: '41.58.0.9' });
  assert.equal(rt.address.value, 'ggt-lag-lt001.tail1234.ts.net', 'another network: connect over Tailscale');
  const wg = { ...rd, joinType: 'Workgroup', domain: 'WORKGROUP', fqdn: '', user: 'GGT-LAG-LT001\\ada', tailscale: null, ips: ['192.168.1.40'] };
  assert.equal(RC.route(wg, { viewerIp: '102.89.1.10' }).address.value, '192.168.1.40', 'workgroup PC: connect by address');
  assert.equal(RC.suggestedUser(wg), 'GGT-LAG-LT001\\ada', 'workgroup PC: sign in with a local account');
  assert.equal(RC.route(wg, { viewerIp: '41.58.0.9', gateway: 'rdg.example.com' }).gateway, true, 'another network without Tailscale: use the gateway');
  assert.equal(RC.route(wg, { viewerIp: '41.58.0.9' }).warn, true, 'no Tailscale or gateway: warn about VPN');
  assert.equal(RC.suggestedUser({ ...wg, joinType: 'Entra', user: 'AzureAD\\AdaObi' }), 'AzureAD\\AdaObi');
  let f = RC.rdpFile(wg, { address: 'ggt-lag-lt001.tail1234.ts.net', port: 3390, user: '.\\ada', entra: true, gateway: 'rdg.example.com' });
  assert.ok(f.includes('full address:s:ggt-lag-lt001.tail1234.ts.net:3390') && f.includes('username:s:.\\ada') && f.includes('enablerdsaadauth:i:1') && f.includes('gatewayhostname:s:rdg.example.com'));
  assert.ok(RC.rdpFile(wg).includes('full address:s:10.10.4.20\r\n'), 'default port left out');
  assert.equal(RC.vncUrl({ ip: '10.0.0.5' }, { user: 'ada', address: '100.64.0.2' }), 'vnc://ada@100.64.0.2');
  assert.equal((await call('PUT', '/api/console/objects/settings/main', { doc: { id: 'main', rdGateway: 'bad host!' } })).status, 400, 'gateway validated');
  r = await call('PUT', '/api/console/objects/settings/main', { doc: { id: 'main', rdGateway: 'https://RDG.example.com/' } });
  assert.equal(r.body.doc.rdGateway, 'rdg.example.com');
  console.log('✓ remote desktop: domain, workgroup, Entra, Tailscale, gateway');

  // ---------- VPN: Tailscale key stays private, FortiClient status
  assert.equal((await call('POST', '/api/console/commands', { type: 'vpnjoin', deviceIds: [id] })).status, 409, 'joining needs a saved key');
  assert.equal((await call('PUT', '/api/console/vpn/tailscale-key', { authKey: 'not-a-key' })).status, 400, 'key format checked');
  r = await call('PUT', '/api/console/vpn/tailscale-key', { authKey: 'tskey-auth-kAbc123CNTRL-SecretPart456' });
  assert.equal(r.status, 200); assert.equal(r.body.set, true);
  r = await call('GET', '/api/console/state');
  assert.equal(r.body.tailscaleKey.set, true);
  assert.ok(!JSON.stringify(r.body).includes('SecretPart456'), 'the key is never sent to the console');
  r = await call('POST', '/api/console/commands', { type: 'vpnjoin', deviceIds: [id] });
  assert.equal(r.body.commands[0].status, 'queued');
  r = await call('GET', '/api/agent/policy', null, KEY2, { deviceId: id });
  const join = r.body.commands.find(c => c.type === 'vpnjoin');
  assert.equal(join.authKey, 'tskey-auth-kAbc123CNTRL-SecretPart456', 'the key goes to the device in the join command');
  r = await call('GET', '/api/console/state');
  assert.ok(!JSON.stringify(r.body).includes('SecretPart456'), 'the key is not stored on the command');
  await call('POST', '/api/agent/checkin', { ...report, deviceId: id, fortiConnected: true }, KEY2);
  assert.equal((await call('GET', '/api/console/state')).body.devices[0].fortiConnected, true, 'FortiClient connection reported');
  r = await call('PUT', '/api/console/vpn/tailscale-key', { authKey: null });
  assert.equal(r.body.set, false, 'key removed');
  console.log('✓ VPN: Tailscale key private, join command, FortiClient status');

  // ---------- Go-Green VPN: addresses, keys, the VPN server's peer list
  const crypto = require('crypto');
  const wgPub = () => crypto.generateKeyPairSync('x25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  assert.equal((await call('POST', '/api/console/commands', { type: 'ggvpnon', deviceIds: [id] })).status, 409, 'needs the server key first');
  assert.equal((await call('POST', '/api/console/vpn/clients', { name: 'PC', platform: 'Windows' })).status, 409);
  process.env.GGVPN_SERVER_PUBKEY = wgPub();
  process.env.GGVPN_SYNC_TOKEN = 'sync-secret';
  r = await call('GET', '/api/console/state');
  assert.equal(r.body.ggvpn.configured, true); assert.equal(r.body.ggvpn.endpoint, 'vpn.go-greentechnologies.com:51820');
  r = await call('POST', '/api/console/commands', { type: 'ggvpnon', deviceIds: [id] });
  assert.equal(r.body.commands[0].status, 'queued');
  r = await call('GET', '/api/agent/policy', null, KEY2, { deviceId: id });
  const on = r.body.commands.find(c => c.type === 'ggvpnon');
  assert.equal(on.vpn.address, '10.99.0.100', 'first address in the pool');
  assert.equal(on.vpn.serverPublicKey, process.env.GGVPN_SERVER_PUBKEY);
  assert.deepEqual(on.vpn.routes, ['10.99.0.0/24', '172.16.29.0/24']);
  assert.equal((await call('GET', '/api/vpn/peers', null, {})).status, 401, 'peer list needs the sync token');
  r = await call('GET', '/api/vpn/peers', null, { 'x-ggt-vpn-token': 'sync-secret' });
  assert.equal(r.body.peers.length, 0, 'not listed until the device reports its key');
  const devPub = wgPub();
  await call('POST', '/api/agent/checkin', { ...report, deviceId: id, ggvpn: { publicKey: devPub, address: '10.99.0.100', up: true, handshakeAgeSec: 12 } }, KEY2);
  await call('POST', '/api/agent/checkin', { ...report, deviceId: id, ggvpn: { publicKey: 'junk', up: true } }, KEY2).then(x => assert.equal(x.status, 200));
  await call('POST', '/api/agent/checkin', { ...report, deviceId: id, ggvpn: { publicKey: devPub, address: '10.99.0.100', up: true, handshakeAgeSec: 12 } }, KEY2);
  r = await call('GET', '/api/vpn/peers', null, { 'x-ggt-vpn-token': 'sync-secret' });
  assert.deepEqual(r.body.peers.map(p => [p.address, p.publicKey]), [['10.99.0.100', devPub]], 'device listed with its own key');
  r = await call('GET', '/api/console/state');
  assert.equal(r.body.devices[0].ggvpn.wanted, true); assert.equal(r.body.devices[0].ggvpn.reported.up, true);
  assert.ok(r.body.ggvpn.lastSync, 'last sync recorded');
  // Installers: a key made once, returned once, never stored.
  r = await call('POST', '/api/console/vpn/clients', { name: 'GGT Laptop 02', platform: 'macOS' });
  assert.equal(r.status, 200); assert.equal(r.body.client.name, 'GGT-Laptop-02'); assert.equal(r.body.client.address, '10.99.0.101');
  assert.match(r.body.privateKey, /^[A-Za-z0-9+/]{43}=$/);
  const pk = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(r.body.privateKey, 'base64')]), format: 'der', type: 'pkcs8' });
  assert.equal(crypto.createPublicKey(pk).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'), r.body.client.publicKey, 'public key matches the private key');
  const secret = r.body.privateKey, clientId = r.body.client.id;
  assert.equal((await call('POST', '/api/console/vpn/clients', { name: 'ggt-laptop-02', platform: 'Windows' })).status, 409, 'one installer per name');
  assert.equal((await call('POST', '/api/console/vpn/clients', { name: 'x', platform: 'Linux' })).status, 400);
  r = await call('GET', '/api/console/state');
  assert.ok(!JSON.stringify(r.body).includes(secret), 'private key not stored');
  assert.equal(r.body.vpnClients.length, 1);
  r = await call('GET', '/api/vpn/peers', null, { 'x-ggt-vpn-token': 'sync-secret' });
  assert.equal(r.body.peers.length, 2);
  const V = await import(pathToFileURL(path.join(__dirname, '../app/js/vpn-installer.js')));
  const server = { publicKey: process.env.GGVPN_SERVER_PUBKEY, endpoint: 'vpn.example.com:51820', dns: ['172.16.29.10'], routes: ['10.99.0.0/24'] };
  const cmd = V.windowsVpnSetup({ name: 'PC', address: '10.99.0.101', privateKey: secret, server });
  const psLine = cmd.split('\r\n').find(l => l.startsWith('powershell.exe -NoProfile -ExecutionPolicy'));
  assert.ok(psLine.includes(`'PrivateKey = ${secret}'`) && !/(^|[^\\])"/.test(psLine.slice(psLine.indexOf('"') + 1, -1)), 'Windows installer: key inside, no stray quotes');
  assert.match(V.vpnConf({ address: '10.99.0.101', privateKey: secret, server }), /Address = 10\.99\.0\.101\/32\nDNS = 172\.16\.29\.10\n/);
  // Revoke and disconnect take peers off the list at once.
  assert.equal((await call('DELETE', `/api/console/vpn/clients/${clientId}`)).status, 200);
  await call('POST', '/api/console/commands', { type: 'ggvpnoff', deviceIds: [id] });
  r = await call('GET', '/api/vpn/peers', null, { 'x-ggt-vpn-token': 'sync-secret' });
  assert.equal(r.body.peers.length, 0, 'revoked and disconnected peers removed');
  r = await call('POST', '/api/console/commands', { type: 'ggvpnon', deviceIds: [id] });
  r = await call('GET', '/api/agent/policy', null, KEY2, { deviceId: id });
  assert.equal(r.body.commands.find(c => c.type === 'ggvpnon').vpn.address, '10.99.0.100', 'reconnecting keeps the same address');
  console.log('✓ Go-Green VPN: address pool, device keys, installers, peer sync, revoke');

  // ---------- console rule logic matches the server's
  const S = await import(pathToFileURL(path.join(__dirname, '../app/js/store.js')));
  const sample = M.deviceView({ id: 'a', name: 'GGT-ABJ-DT004', platform: 'Windows', os: 'Windows 10 Pro 22H2', build: '19045', type: 'Desktop', tags: ['pilot'], ip: '10.20.1.1', lastSeen: new Date().toISOString() }, { sites: [{ name: 'Abuja', code: 'ABJ', subnets: '10.20.0.0/16' }], apps: [], settings: {} });
  const rules = [
    { field: 'platform', op: 'is', value: 'windows' }, { field: 'tag', op: 'is', value: 'pilot' }, { field: 'tag', op: 'not', value: 'pilot' },
    { field: 'type', op: 'in', value: 'Laptop, Desktop' }, { field: 'name', op: 'starts', value: 'ggt-abj' }, { field: 'os', op: 'contains', value: '10' },
    { field: 'site', op: 'is', value: 'Abuja' }, { field: 'osFamily', op: 'is', value: 'win10' }, { field: 'health', op: 'is', value: 'Inactive' },
  ];
  for (const rule of rules) assert.equal(S.ruleMatch(sample, rule), M.ruleMatch(sample, rule), `rule ${JSON.stringify(rule)} agrees`);
  for (const match of ['all', 'any']) assert.equal(S.inCollection(sample, { match, rules }), M.inCollection(sample, { match, rules }));
  assert.equal(M.inCidr('10.20.5.5', '10.20.0.0/16'), true); assert.equal(M.inCidr('10.21.5.5', '10.20.0.0/16'), false);
  console.log('✓ console and server collection rules agree');

  // ---------- Windows OS deployment: images, task sequences, policy
  {
    useStore(memoryStore());
    let st = (await call('GET', '/api/console/state')).body;
    assert.ok(st.osImages.some(i => i.id === 'os-win11-latest' && i.source === 'assistant' && i.build === 26200), 'built-in Windows 11 image');
    const ts0 = st.taskSequences.find(t => t.id === 'ts-win11-upgrade');
    assert.deepEqual(ts0.steps.map(x => x.type), ['readiness', 'bitlocker', 'upgrade'], 'built-in upgrade task sequence');
    const put = (kind, doc) => call('PUT', `/api/console/objects/${kind}/${doc.id}`, { doc });
    assert.equal((await put('osImage', { id: 'img1', name: 'Bad', source: 'usb', build: 26100 })).status, 400, 'image source checked');
    assert.equal((await put('osImage', { id: 'img1', name: 'Bad', source: 'iso', build: 26100, url: 'http://x/win.iso' })).status, 400, 'ISO must be https or a share');
    assert.equal((await put('osImage', { id: 'img1', name: 'Bad', source: 'iso', build: 99, url: 'https://x/win.iso' })).status, 400, 'build checked');
    assert.equal((await put('osImage', { id: 'img1', name: 'Bad', source: 'iso', build: 26100, url: 'https://x/win.iso', sha256: 'abc' })).status, 400, 'SHA-256 checked');
    assert.equal((await put('osImage', { id: 'img-share', name: 'Share', source: 'iso', build: '26100', url: '\\\\GODC01\\Images\\Win11.iso' })).status, 200, 'network share accepted');
    r = await put('osImage', { id: 'img1', name: 'Windows 11 Pro 24H2', source: 'iso', build: 26100, architecture: 'x64', url: 'https://files.example.com/Win11_24H2.iso', sha256: 'A'.repeat(64) });
    assert.equal(r.status, 200); assert.equal(r.body.doc.build, 26100);
    assert.equal((await put('taskSequence', { id: 'ts1', name: 'Empty', steps: [] })).status, 400, 'steps required');
    assert.equal((await put('taskSequence', { id: 'ts1', name: 'Bad', steps: [{ type: 'format-disk' }] })).status, 400, 'step types checked');
    assert.equal((await put('taskSequence', { id: 'ts1', name: 'Bad', steps: [{ type: 'upgrade' }] })).status, 400, 'upgrade needs an image');
    await put('app', { id: 'app-7z', name: '7-Zip', version: '24', detectName: '7-Zip', platforms: ['Windows'], windows: { wingetId: '7zip.7zip' } });
    assert.equal((await put('taskSequence', { id: 'ts1', name: 'Finance to 24H2', steps: [{ type: 'readiness', win11: true, minFreeGB: 30 }, { type: 'script', scriptId: 'gpupdate' }, { type: 'upgrade', imageId: 'img1', dynamicUpdate: false }, { type: 'app', appId: 'app-7z' }, { type: 'restart' }] })).status, 200);
    await put('deployment', { id: 'dep-os', name: 'Win11', kind: 'os', targetId: 'ts1', collectionId: 'c-all', enabled: true, respectMW: false, restart: 'Allow' });
    assert.equal((await call('DELETE', '/api/console/objects/osImage/img1')).status, 409, 'images used by task sequences cannot be deleted');
    assert.equal((await call('DELETE', '/api/console/objects/taskSequence/ts1')).status, 409, 'deployed task sequences cannot be deleted');
    assert.equal((await call('DELETE', '/api/console/objects/script/gpupdate')).status, 409, 'scripts used by task sequences cannot be deleted');

    const H2 = { 'x-ggt-enroll-token': 'test-token' };
    const win = { name: 'GGT-W10-01', platform: 'Windows', os: 'Windows 10 Pro 22H2', build: '19045.5131', type: 'Desktop', serial: 'W10', ip: '10.1.1.1', agentVersion: '2.4.0', ramGB: 8, diskGB: 256,
      osReady: { tpm: '2.0', secureBoot: true, uefi: true, arch: 'x64', diskFreeGB: 120, junk: 'x' }, security: {} };
    r = await call('POST', '/api/agent/checkin', win, H2);
    const wk = { ...H2, 'x-ggt-device-key': r.body.deviceKey }, wid = r.body.deviceId;
    const old = await call('POST', '/api/agent/checkin', { ...win, name: 'GGT-OLD', serial: 'OLD', agentVersion: '2.3.0' }, H2);
    const srv = await call('POST', '/api/agent/checkin', { ...win, name: 'GGT-SRV', serial: 'SRV', os: 'Windows Server 2022 Standard', type: 'Server' }, H2);
    let pol = (await call('GET', '/api/agent/policy', null, wk, { deviceId: wid })).body;
    const od = pol.deployments.find(x => x.id === 'dep-os');
    assert.equal(od.kind, 'os'); assert.equal(od.targetBuild, 26100); assert.equal(od.restart, 'Allow');
    assert.deepEqual(od.taskSequence.steps.map(x => x.type), ['readiness', 'script', 'upgrade', 'app', 'restart']);
    assert.equal(od.taskSequence.steps[1].body, 'gpupdate /force', 'script body sent');
    assert.equal(od.taskSequence.steps[2].image.url, 'https://files.example.com/Win11_24H2.iso', 'image sent');
    assert.equal(od.taskSequence.steps[2].dynamicUpdate, false);
    assert.equal(od.taskSequence.steps[3].app.wingetId, '7zip.7zip', 'app step resolved for Windows');
    assert.equal(od.taskSequence.broken, null);
    for (const [who, label] of [[old, 'agents before 2.4.0'], [srv, 'Windows Server']]) {
      const k = { ...H2, 'x-ggt-device-key': who.body.deviceKey };
      assert.ok(!(await call('GET', '/api/agent/policy', null, k, { deviceId: who.body.deviceId })).body.deployments.some(x => x.kind === 'os'), `no task sequences for ${label}`);
    }
    assert.equal((await call('POST', '/api/agent/status', { deviceId: wid, deploymentId: 'dep-os', state: 'reqnotmet', errorCode: 'NOT_READY', message: 'Not ready: no TPM' }, wk)).status, 202);
    st = (await call('GET', '/api/console/state')).body;
    const dv = st.devices.find(d => d.id === wid);
    assert.deepEqual(dv.osReady, { tpm: '2.0', secureBoot: true, uefi: true, arch: 'x64', diskFreeGB: 120 }, 'readiness stored without extra fields');
    // The console marks results with the same rules as the server.
    const S = await import(pathToFileURL(path.join(__dirname, '../app/js/store.js')));
    for (const d of st.devices) assert.equal(S.osNotMet(d), M.osNotMet(d), `${d.name}: console and server agree on who can run task sequences`);
    assert.equal(S.win11Readiness(dv).ready, true);
    assert.deepEqual(S.win11Readiness({ ...dv, osReady: { tpm: '1.2', uefi: false, arch: 'x64' } }).problems, ['TPM 1.2', 'Legacy BIOS']);
    assert.equal(S.win11Readiness({ ...dv, osReady: null }).ready, null);
    console.log('✓ OS deployment: images, task sequences, checks, policy, agent version and Server excluded, readiness');
  }

  // ---------- storage outage
  useStore({ kind: 'broken', countDevices: async () => { throw new Error('down'); }, getDevice: async () => { throw new Error('down'); } });
  assert.equal((await call('GET', '/api/health', null, {})).status, 503);
  assert.equal((await call('GET', '/api/agent/policy', null, KEY2, { deviceId: id })).status, 503);
  console.log('✓ storage outage handled');
})().catch(e => { console.error(e); process.exit(1); });
