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

  // ---------- storage outage
  useStore({ kind: 'broken', countDevices: async () => { throw new Error('down'); }, getDevice: async () => { throw new Error('down'); } });
  assert.equal((await call('GET', '/api/health', null, {})).status, 503);
  assert.equal((await call('GET', '/api/agent/policy', null, KEY2, { deviceId: id })).status, 503);
  console.log('✓ storage outage handled');
})().catch(e => { console.error(e); process.exit(1); });
