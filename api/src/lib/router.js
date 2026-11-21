// API used by the Go-Green agent on each device (check-in, policy, status) plus a
// health endpoint for the console. Pure function so it runs under Azure Functions
// (src/functions/api.js) and the local dev server (dev-server.js) alike.
//
// Data is saved in Azure Cosmos DB when COSMOS_CONNECTION_STRING is set, otherwise in memory (lib/storage.js).
const crypto = require('crypto');
const { createStore } = require('./storage');

const VERSION = '1.1.0';
let db = createStore();
const stats = { checkins: 0, started: new Date().toISOString() };
const useStore = s => { db = s; };

// Policy the agent pulls: what to install, which updates to apply, which baselines to evaluate.
// In production this is computed from collections + deployments in the database.
const DEMO_POLICY = {
  pollIntervalSec: 300,
  deployments: [
    { id: 'dep-forti', kind: 'app', name: 'FortiClient VPN', version: '7.4.1', purpose: 'Required',
      install: 'msiexec /i FortiClientVPN.msi /qn', detection: { type: 'service', name: 'FortiClient VPN' },
      contentUrl: '/content/forticlient/7.4.1/FortiClientVPN.msi', sha256: null },
  ],
  updates: { approved: ['KB5046617', 'KB5046633', 'KB890830'], deadline: null, restart: 'suppress' },
  baselines: [
    { id: 'bl-sec', rules: ['enc', 'av', 'fw', 'defs'], remediate: true },
    { id: 'bl-corp', rules: ['lock', 'admin', 'usb', 'vpn'], remediate: true },
  ],
  maintenanceWindows: [{ days: 'Mon-Fri', start: '22:00', hours: 4, tz: 'Africa/Lagos' }],
};

function tokenOk(headers) {
  const expected = process.env.AGENT_ENROLL_TOKEN || 'demo-token';
  const got = String(headers['x-ggt-enroll-token'] || '');
  const a = Buffer.from(got), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const str = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;

function validateCheckin(b) {
  const errors = [];
  if (!str(b.name, 64)) errors.push('name is required (max 64 chars)');
  if (!['Windows', 'macOS', 'Linux'].includes(b.platform)) errors.push('platform must be Windows, macOS or Linux');
  if (!str(b.os, 100)) errors.push('os is required');
  if (b.software && !Array.isArray(b.software)) errors.push('software must be an array');
  if (b.software && b.software.length > 2000) errors.push('software list too long');
  if (b.updates && (typeof b.updates !== 'object' || !Array.isArray(b.updates.missing || []))) errors.push('updates.missing must be an array');
  return errors;
}

async function route_({ method, path, query = {}, body = {}, headers = {} }) {
  const route = `${method} ${path.replace(/\/+$/, '')}`;
  if (route === 'GET /api/health') {
    let devicesKnown = null, storageOk = true;
    try { devicesKnown = await db.countDevices(); } catch (e) { storageOk = false; console.error('storage', e.message); }
    return { status: storageOk ? 200 : 503, body: { status: storageOk ? 'ok' : 'storage-unavailable', version: VERSION, agentsCheckedIn: stats.checkins, devicesKnown, since: stats.started, storage: db.kind, ...(db.kind === 'memory' ? { databaseSettingsSeen: Object.keys(process.env).filter(k => /postgres|database|sql|cosmos|supabase/i.test(k)) } : {}) } };
  }
  if (path.startsWith('/api/agent/')) {
    if (!tokenOk(headers)) return { status: 401, body: { error: 'Missing or invalid x-ggt-enroll-token header' } };
    if (route === 'POST /api/agent/checkin') {
      const errors = validateCheckin(body || {});
      if (errors.length) return { status: 400, body: { error: 'Invalid check-in', details: errors } };
      const id = str(body.deviceId, 64) ? body.deviceId : crypto.randomUUID();
      const prev = await db.getDevice(id);
      await db.upsertDevice({
        id, deviceId: id, enrolled: prev?.enrolled || new Date().toISOString(), name: body.name, platform: body.platform, os: body.os, hardware: body.hardware || {},
        software: (body.software || []).slice(0, 2000), updates: body.updates || {}, compliance: body.compliance || {},
        lastSeen: new Date().toISOString(),
      });
      stats.checkins++;
      return { status: 200, body: { deviceId: id, nextCheckInSec: DEMO_POLICY.pollIntervalSec, policyUrl: `/api/agent/policy?deviceId=${encodeURIComponent(id)}` } };
    }
    if (route === 'GET /api/agent/policy') {
      if (!str(query.deviceId, 64) || !(await db.getDevice(query.deviceId))) return { status: 404, body: { error: 'Unknown device. Check in first.' } };
      return { status: 200, body: { deviceId: query.deviceId, issued: new Date().toISOString(), ...DEMO_POLICY } };
    }
    if (route === 'POST /api/agent/status') {
      const b = body || {};
      if (!str(b.deviceId, 64) || !(await db.getDevice(b.deviceId))) return { status: 404, body: { error: 'Unknown device' } };
      if (!str(b.deploymentId, 64) || !['success', 'inprogress', 'error', 'reqnotmet'].includes(b.state)) return { status: 400, body: { error: 'deploymentId and state (success|inprogress|error|reqnotmet) are required' } };
      await db.addStatus({ deviceId: b.deviceId, deploymentId: b.deploymentId, state: b.state, errorCode: str(b.errorCode, 20) ? b.errorCode : null, at: new Date().toISOString() });
      return { status: 202, body: { accepted: true } };
    }
    return { status: 404, body: { error: 'Not found' } };
  }
  if (route === 'GET /api/devices') {
    // Protected by staticwebapp.config.json (authenticated users only).
    const devices = await db.listDevices();
    return { status: 200, body: { storage: db.kind, devices: devices.map(({ software = [], ...d }) => ({ ...d, softwareCount: software.length })) } };
  }
  return { status: 404, body: { error: 'Not found' } };
}

async function handle(req) {
  try { return await route_(req); } catch (e) {
    console.error('api error', e && e.message);
    return { status: 503, body: { error: 'The device database is unavailable. The agent should retry later.' } };
  }
}

module.exports = { handle, useStore, _db: () => db };
