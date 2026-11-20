// Fast checks that run in CI before deploy: the data engine and the agent API.
// No browser and no dependencies needed.
const assert = require('assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { handle, _store } = require('../api/src/lib/router');

(async () => {
  // Front-end engine (ES modules) in Node with a stub localStorage.
  const mem = {};
  global.localStorage = { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = v; }, removeItem: k => { delete mem[k]; } };
  const S = await import(pathToFileURL(path.join(__dirname, '../app/js/store.js')));
  const st = S.load();
  assert.ok(st.devices.length >= 200, 'demo estate generated');
  assert.equal(new Set(st.devices.map(d => d.name)).size, st.devices.length, 'device names are unique');
  assert.equal(S.members('c-all').length, st.devices.length, 'All Systems has every device');
  const srv = S.members('c-srv');
  assert.ok(srv.length > 0 && srv.every(d => d.type === 'Server' || d.type === 'VM'), 'server collection rule');
  for (const b of st.baselines) { const s = S.baselineSummary(b); assert.equal(s.Compliant + s['Non-compliant'] + s.Unknown, st.devices.length); }
  const dep = S.createDeployment({ kind: 'app', targetId: 'app-7zip', collectionId: 'c-wks', purpose: 'Required' });
  const sum = S.deploymentSummary(dep);
  assert.equal(sum.total, S.members('c-wks').length, 'deployment targets every member');
  for (let i = 0; i < 40; i++) S.tick();
  assert.ok(S.deploymentSummary(dep).success > sum.success, 'simulation makes progress');
  console.log('✓ engine: estate, collections, compliance, deployments, simulation');

  // Agent API
  let r = await handle({ method: 'GET', path: '/api/health' });
  assert.equal(r.status, 200);
  r = await handle({ method: 'POST', path: '/api/agent/checkin', body: { name: 'X' }, headers: {} });
  assert.equal(r.status, 401, 'token required');
  const H = { 'x-ggt-enroll-token': 'demo-token' };
  r = await handle({ method: 'POST', path: '/api/agent/checkin', body: { name: 'X' }, headers: H });
  assert.equal(r.status, 400, 'validation');
  r = await handle({ method: 'POST', path: '/api/agent/checkin', headers: H, body: { name: 'GGT-LAG-LT999', platform: 'Windows', os: 'Windows 11 24H2', software: [{ name: '7-Zip', version: '24.08' }], updates: { missing: ['KB5046617'] } } });
  assert.equal(r.status, 200); const id = r.body.deviceId;
  r = await handle({ method: 'GET', path: '/api/agent/policy', query: { deviceId: id }, headers: H });
  assert.equal(r.status, 200); assert.ok(r.body.deployments.length);
  r = await handle({ method: 'POST', path: '/api/agent/status', headers: H, body: { deviceId: id, deploymentId: 'dep-forti', state: 'success' } });
  assert.equal(r.status, 202); assert.equal(_store.statuses.length, 1);
  console.log('✓ api: health, token check, validation, check-in, policy, status');
})().catch(e => { console.error(e); process.exit(1); });
