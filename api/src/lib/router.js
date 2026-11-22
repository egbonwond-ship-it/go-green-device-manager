// The device manager's API. Pure function so it runs under Azure Functions (src/functions/api.js)
// and the local dev server (dev-server.js) alike.
//
//   /api/health          public status
//   /api/agent/*         the Go-Green agent on each device (enrollment token + per-device key)
//   /api/console/*       the web console (signed-in users listed in ADMIN_USERS)
const crypto = require('crypto');
const net = require('net');
const { createStore } = require('./storage');
const M = require('./model');
const DEFAULTS = require('./defaults');

const VERSION = '2.0.0';
let db = createStore();
const useStore = s => { db = s; ctxCache = null; };

// ---------- helpers ----------
const str = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;
const cut = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : v == null ? null : String(v).slice(0, max));
const num = (v, lo = -Infinity, hi = Infinity) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
const bool = v => (typeof v === 'boolean' ? v : null);
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : null);
const date = v => (v && !Number.isNaN(new Date(v).getTime()) ? new Date(v).toISOString() : null);
const newId = p => `${p}-${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const ID_RE = /^[\w.-]{1,64}$/;
const SEVERITIES = ['Critical', 'Important', 'Moderate', 'Low'];

// The caller's public address as Azure (or a proxy) saw it. Used to tell whether a device and the
// admin's browser are on the same network, so remote desktop can pick the right address.
function clientIp(headers = {}) {
  for (const h of ['x-azure-clientip', 'x-client-ip', 'x-forwarded-for']) {
    let v = String(headers[h] || '').split(',')[0].trim();
    if (!v) continue;
    const m4 = v.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/); if (m4) v = m4[1];
    const m6 = v.match(/^\[([^\]]+)\](?::\d+)?$/); if (m6) v = m6[1];
    if (net.isIP(v)) return v;
  }
  return null;
}
const ipList = v => (arr(v, 16) || []).filter(a => typeof a === 'string' && net.isIP(a)).map(a => a.slice(0, 45));
const host = v => (typeof v === 'string' && /^[A-Za-z0-9]([A-Za-z0-9.-]{0,252})$/.test(v.replace(/\.$/, '')) ? v.replace(/\.$/, '').toLowerCase() : null);
const JOIN_TYPES = ['Domain', 'Hybrid', 'Entra', 'Workgroup'];

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

async function log(source, message, level = 'info', by = null) {
  const id = newId('log');
  await db.putObject('log', id, { id, t: Date.now(), source, message: cut(message, 500), level, by });
}
async function alert(severity, title, detail, deviceId = null) {
  const id = newId('al');
  await db.putObject('alert', id, { id, t: Date.now(), severity, title: cut(title, 200), detail: cut(detail, 500), deviceId, ack: false });
}

// Console configuration, cached briefly per API instance so agent check-ins stay cheap.
let ctxCache = null;
const CTX_KINDS = { sites: 'site', apps: 'app', collections: 'collection', deployments: 'deployment', updateGroups: 'updateGroup', adrs: 'adr', baselines: 'baseline', maintenanceWindows: 'maintenanceWindow' };
async function loadCtx(fresh = false) {
  if (!fresh && ctxCache && Date.now() - ctxCache.at < 30000) return ctxCache.ctx;
  const ctx = {};
  await Promise.all(Object.entries(CTX_KINDS).map(async ([k, kind]) => { ctx[k] = await db.listObjects(kind); }));
  ctx.settings = (await db.getObject('settings', 'main')) || DEFAULTS.settings;
  ctxCache = { at: Date.now(), ctx };
  return ctx;
}

async function ensureDefaults() {
  if (await db.getObject('settings', 'main')) return false;
  await db.putMany('collection', DEFAULTS.collections);
  await db.putMany('baseline', DEFAULTS.baselines);
  await db.putMany('script', DEFAULTS.scripts);
  await db.putObject('settings', 'main', DEFAULTS.settings);
  await log('Setup', 'Created the built-in collections, compliance baselines and scripts');
  return true;
}

// ---------- sign-in (Azure Static Web Apps puts the signed-in user in x-ms-client-principal) ----------
function principal(headers) {
  const raw = headers['x-ms-client-principal'];
  if (!raw) return null;
  try { const p = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); return p && p.userDetails ? p : null; } catch { return null; }
}
const adminList = () => String(process.env.ADMIN_USERS || '').split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
const isAdmin = p => !!p && ((p.userRoles || []).includes('admin') || adminList().includes(String(p.userDetails).toLowerCase()));

// ---------- agent ----------
function sanitizeReport(b) {
  const s = b.security || {};
  return {
    name: cut(b.name, 64), platform: b.platform, os: cut(b.os, 100), build: cut(b.build, 40),
    type: ['Laptop', 'Desktop', 'Server', 'VM'].includes(b.type) ? b.type : 'Desktop',
    manufacturer: cut(b.manufacturer, 64), model: cut(b.model, 100), serial: cut(b.serial, 64), cpu: cut(b.cpu, 100),
    ramGB: num(b.ramGB, 0, 100000), diskGB: num(b.diskGB, 0, 1e7), diskFreePct: num(b.diskFreePct, 0, 100),
    ip: cut(b.ip, 45), mac: cut(b.mac, 40), user: cut(b.user, 100), lastBoot: date(b.lastBoot),
    cpuPct: num(b.cpuPct, 0, 100), memPct: num(b.memPct, 0, 100), agentVersion: cut(b.agentVersion, 20),
    // Remote desktop: how the device signs people in and every address it can be reached on.
    joinType: JOIN_TYPES.includes(b.joinType) ? b.joinType : null, domain: cut(b.domain, 255), netbiosDomain: cut(b.netbiosDomain, 64),
    fqdn: host(b.fqdn), ips: ipList(b.ips), rdpPort: num(b.rdpPort, 1, 65535),
    tailscale: b.tailscale && typeof b.tailscale === 'object' ? { ips: ipList(b.tailscale.ips), dnsName: host(b.tailscale.dnsName), online: bool(b.tailscale.online) } : null,
    security: {
      encrypted: bool(s.encrypted), avOn: bool(s.avOn), fwOn: bool(s.fwOn), defsAgeDays: num(s.defsAgeDays, 0, 10000),
      screenLockMin: num(s.screenLockMin, 0, 100000), usbBlocked: bool(s.usbBlocked), pendingReboot: bool(s.pendingReboot),
      localAdmins: arr(s.localAdmins, 100)?.map(a => cut(a, 120)) ?? null, remoteOn: bool(s.remoteOn),
    },
  };
}
const cleanUpdate = u => ({
  id: cut(u.id, 80), kb: cut(u.kb, 40), title: cut(u.title, 300), product: cut(u.product, 100), classification: cut(u.classification, 60),
  severity: SEVERITIES.includes(u.severity) ? u.severity : 'Low', sizeMB: num(u.sizeMB, 0, 1e6), reboot: !!u.reboot, released: date(u.released), installedAt: date(u.installedAt),
});

function validateCheckin(b) {
  const errors = [];
  if (!str(b.name, 64)) errors.push('name is required (max 64 chars)');
  if (!['Windows', 'macOS', 'Linux'].includes(b.platform)) errors.push('platform must be Windows, macOS or Linux');
  if (!str(b.os, 100)) errors.push('os is required');
  if (b.software != null && !Array.isArray(b.software)) errors.push('software must be an array');
  if (b.updates != null && (typeof b.updates !== 'object' || !Array.isArray(b.updates.missing || []) || !Array.isArray(b.updates.installed || []))) errors.push('updates.missing and updates.installed must be arrays');
  return errors;
}

async function deviceAuth(headers, deviceId) {
  if (!str(deviceId, 64)) return { error: { status: 400, body: { error: 'deviceId is required' } } };
  const doc = await db.getDevice(deviceId);
  if (!doc) return { error: { status: 404, body: { error: 'Unknown device. Enrol again.', reenrol: true } } };
  if (!safeEqual(sha(headers['x-ggt-device-key']), doc.keyHash)) return { error: { status: 403, body: { error: 'Device key does not match' } } };
  return { doc };
}

async function checkin(b, headers) {
  const errors = validateCheckin(b);
  if (errors.length) return { status: 400, body: { error: 'Invalid check-in', details: errors } };
  const now = new Date().toISOString();
  const r = sanitizeReport(b);
  let prev = null, deviceKey = null, id;
  if (b.deviceId) {
    const a = await deviceAuth(headers, b.deviceId);
    if (a.error) return a.error;
    prev = a.doc; id = prev.id;
  } else {
    // New enrollment. A device that lost its agent config (reinstall) keeps its record if name and serial match.
    const same = r.serial ? (await db.listDevices()).find(d => d.serial === r.serial && d.name === r.name) : null;
    prev = same || null;
    id = same ? same.id : crypto.randomUUID();
    deviceKey = crypto.randomBytes(32).toString('hex');
  }
  const ctx = await loadCtx();
  const doc = {
    ...(prev || {}), ...r, id, lastSeen: now, enrolled: prev?.enrolled || now,
    keyHash: deviceKey ? sha(deviceKey) : prev.keyHash,
    tags: prev?.tags || [], depState: prev?.depState || {},
    pendingRebootSince: r.security.pendingReboot ? (prev?.pendingRebootSince || now) : null,
    agentErrors: (arr(b.errors, 20) || []).map(e => cut(e, 300)),
    publicIp: clientIp(headers),
  };
  if (Array.isArray(b.software)) { doc.software = b.software.slice(0, 3000).map(s => ({ name: cut(s?.name, 200), version: cut(s?.version, 60), publisher: cut(s?.publisher, 100) })).filter(s => s.name); doc.softwareAt = now; }
  if (b.updates) doc.updates = { scannedAt: date(b.updates.scannedAt) || now, missing: (b.updates.missing || []).slice(0, 500).filter(u => u && str(u.id, 80)).map(cleanUpdate), installed: (b.updates.installed || []).slice(0, 1000).filter(u => u && str(u.id, 80)).map(cleanUpdate) };
  await db.upsertDevice(doc);

  // Alerts on changes that matter.
  const p = prev?.security || {}, s = doc.security;
  if (!prev) await log('Enrollment', `${doc.name} enrolled (${doc.os})`);
  if (p.fwOn === true && s.fwOn === false) await alert('Important', `Firewall turned off on ${doc.name}`, 'The host firewall is off on at least one profile.', id);
  if (p.avOn === true && s.avOn === false) await alert('Critical', `Real-time protection off on ${doc.name}`, 'Antivirus real-time protection was turned off.', id);
  if (Array.isArray(p.localAdmins) && Array.isArray(s.localAdmins)) {
    const added = (M.extraAdmins(s.localAdmins, ctx.settings.approvedAdmins) || []).filter(a => !p.localAdmins.includes(a));
    if (added.length) await alert('Important', `New local admin on ${doc.name}`, `Unapproved account added to Administrators: ${added.join(', ')}`, id);
  }
  const low = ctx.settings.lowDiskPct || 10;
  if (prev && (prev.diskFreePct ?? 100) >= low && doc.diskFreePct != null && doc.diskFreePct < low) await alert('Moderate', `Low disk space on ${doc.name}`, `Only ${doc.diskFreePct}% free on the system drive.`, id);
  for (const ev of arr(b.events, 50) || []) if (str(ev?.message, 500)) await log('Agent', `${doc.name}: ${ev.message}`, ['info', 'warn', 'error'].includes(ev.level) ? ev.level : 'info');

  return { status: 200, body: { deviceId: id, ...(deviceKey ? { deviceKey } : {}), nextCheckInSec: ctx.settings.pollIntervalSec || 300 } };
}

async function policy(query, headers) {
  const a = await deviceAuth(headers, query.deviceId);
  if (a.error) return a.error;
  const ctx = await loadCtx();
  const queued = await db.listObjects('command', { where: { deviceId: a.doc.id, status: 'queued' }, limit: 20 });
  if (queued.length) await db.putMany('command', queued.map(c => ({ ...c, status: 'sent', sentAt: Date.now() })));
  return { status: 200, body: M.buildPolicy(a.doc, ctx, queued) };
}

async function status(b, headers) {
  const a = await deviceAuth(headers, b.deviceId);
  if (a.error) return a.error;
  if (!str(b.deploymentId, 64) || !['success', 'inprogress', 'error', 'reqnotmet'].includes(b.state)) return { status: 400, body: { error: 'deploymentId and state (success|inprogress|error|reqnotmet) are required' } };
  const doc = a.doc;
  const prev = doc.depState?.[b.deploymentId];
  const entry = { state: b.state, errorCode: str(b.errorCode, 20) ? b.errorCode : null, message: cut(b.message, 300), at: new Date().toISOString() };
  doc.depState = { ...(doc.depState || {}), [b.deploymentId]: entry };
  await db.upsertDevice(doc);
  await db.addStatus({ deviceId: doc.id, deploymentId: b.deploymentId, state: b.state, errorCode: entry.errorCode, at: entry.at });
  if (b.state === 'error' && prev?.state !== 'error') {
    const dep = (await db.getObject('deployment', b.deploymentId)) || (await db.getObject('adr', b.deploymentId));
    await alert('Important', `Deployment failed on ${doc.name}`, `${dep?.name || b.deploymentId}: ${entry.errorCode || ''} ${entry.message || ''}`.trim(), doc.id);
    await log('Deployments', `${dep?.name || b.deploymentId} failed on ${doc.name}${entry.errorCode ? ` (${entry.errorCode})` : ''}`, 'error');
  }
  return { status: 202, body: { accepted: true } };
}

async function commandResult(b, headers) {
  const a = await deviceAuth(headers, b.deviceId);
  if (a.error) return a.error;
  const c = str(b.commandId, 80) ? await db.getObject('command', b.commandId) : null;
  if (!c || c.deviceId !== a.doc.id) return { status: 404, body: { error: 'Unknown command' } };
  await db.putObject('command', c.id, { ...c, status: b.status === 'succeeded' ? 'succeeded' : 'failed', exitCode: num(b.exitCode), output: cut(b.output, 65536) || '', finished: Date.now() });
  return { status: 202, body: { accepted: true } };
}

// ---------- console ----------
const EDITABLE = ['collection', 'app', 'deployment', 'updateGroup', 'adr', 'baseline', 'maintenanceWindow', 'script', 'site', 'settings'];
const publicDevice = ({ keyHash, ...d }) => d;

async function consoleState(user, headers) {
  await ensureDefaults();
  const ctx = await loadCtx(true);
  const [docs, scripts, alerts, logs, commands, scriptRuns] = await Promise.all([
    db.listDevices(), db.listObjects('script'), db.listObjects('alert', { limit: 200 }), db.listObjects('log', { limit: 300 }),
    db.listObjects('command', { limit: 300 }), db.listObjects('scriptRun', { limit: 50 }),
  ]);
  return {
    status: 200,
    body: {
      now: Date.now(), version: VERSION, storage: db.kind, user, viewerIp: clientIp(headers),
      enrollmentConfigured: Boolean(process.env.AGENT_ENROLL_TOKEN),
      devices: docs.map(d => M.deviceView(d, ctx)), updates: M.updateCatalogue(docs),
      ...ctx, scripts, alerts, log: logs, commands, scriptRuns,
    },
  };
}

async function putObject(kind, id, body, user) {
  if (!EDITABLE.includes(kind) || !ID_RE.test(id)) return { status: 404, body: { error: 'Not found' } };
  let doc = body?.doc;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.id !== id) return { status: 400, body: { error: 'Send {"doc": {...}} with doc.id matching the URL' } };
  if (JSON.stringify(doc).length > 100000) return { status: 413, body: { error: 'Too large' } };
  const existing = await db.getObject(kind, id);
  if (kind === 'collection' && existing?.builtIn) return { status: 409, body: { error: 'Built-in collections cannot be changed' } };
  if (kind === 'baseline') { if (!existing) return { status: 404, body: { error: 'Unknown baseline' } }; doc = { ...existing, remediate: !!doc.remediate }; }
  if (kind !== 'baseline' && kind !== 'settings' && !str(doc.name, 200)) return { status: 400, body: { error: 'name is required' } };
  if (kind === 'collection') doc.builtIn = false;
  if (kind === 'settings') doc = { ...DEFAULTS.settings, ...(existing || {}), ...doc, id: 'main' };
  if (kind === 'settings') {
    const gw = String(doc.rdGateway || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    if (gw && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}(:\d{1,5})?$/.test(gw)) return { status: 400, body: { error: 'rdGateway must be a host name, optionally with :port' } };
    doc.rdGateway = gw.toLowerCase();
  }
  await db.putObject(kind, id, doc);
  ctxCache = null;
  if (str(body.audit, 300)) await log(body.auditSource || 'Console', body.audit, 'info', user);
  return { status: 200, body: { doc } };
}

async function deleteObject(kind, id, query, user) {
  if (!EDITABLE.includes(kind) || ['baseline', 'settings'].includes(kind)) return { status: 404, body: { error: 'Not found' } };
  const existing = await db.getObject(kind, id);
  if (!existing) return { status: 404, body: { error: 'Not found' } };
  if (kind === 'collection') {
    if (existing.builtIn) return { status: 409, body: { error: 'Built-in collections cannot be deleted' } };
    const used = [...await db.listObjects('deployment', { where: { collectionId: id } }), ...await db.listObjects('adr', { where: { collectionId: id } }), ...await db.listObjects('maintenanceWindow', { where: { collectionId: id } })];
    if (used.length) return { status: 409, body: { error: 'Remove the deployments, rules and maintenance windows that use this collection first' } };
  }
  if (kind === 'app' || kind === 'updateGroup') {
    if ((await db.listObjects('deployment', { where: { targetId: id } })).length) return { status: 409, body: { error: 'Delete the deployments of this first' } };
  }
  await db.deleteObject(kind, id);
  ctxCache = null;
  if (str(query.audit, 300)) await log('Console', query.audit, 'info', user);
  return { status: 200, body: { deleted: true } };
}

const PLATFORMS_FOR = { PowerShell: ['Windows'], Shell: ['macOS', 'Linux'] };
const COMMAND_NAMES = { restart: 'Restart', inventory: 'Refresh inventory', updscan: 'Scan for updates', remoteon: 'Turn on remote desktop', remoteoff: 'Turn off remote desktop' };
const REMOTE_PLATFORMS = ['Windows', 'macOS'];
async function createCommands(b, user) {
  const ids = arr(b.deviceIds, 2000) || [];
  if (!ids.length) return { status: 400, body: { error: 'deviceIds is required' } };
  if (!['script', 'restart', 'inventory', 'updscan', 'remoteon', 'remoteoff'].includes(b.type)) return { status: 400, body: { error: 'type must be script, restart, inventory, updscan, remoteon or remoteoff' } };
  let script = null;
  if (b.type === 'script') { script = str(b.scriptId, 64) ? await db.getObject('script', b.scriptId) : null; if (!script) return { status: 404, body: { error: 'Unknown script' } }; }
  const devices = new Map((await db.listDevices()).map(d => [d.id, d]));
  const runId = newId('run');
  const now = Date.now();
  const cmds = ids.filter(id => devices.has(id)).map(id => {
    const d = devices.get(id);
    const c = { id: newId('cmd'), runId, deviceId: id, deviceName: d.name, type: b.type, name: script ? script.name : COMMAND_NAMES[b.type], created: now, by: user, status: 'queued' };
    if (script) {
      if (!(PLATFORMS_FOR[script.lang] || []).includes(d.platform)) return { ...c, status: 'skipped', output: `${script.lang} scripts don't run on ${d.platform}.` };
      return { ...c, lang: script.lang, body: script.body };
    }
    if (b.type.startsWith('remote') && !REMOTE_PLATFORMS.includes(d.platform)) return { ...c, status: 'skipped', output: `Remote desktop is managed on Windows and macOS only, not ${d.platform}.` };
    return c;
  });
  await db.putMany('command', cmds);
  await db.putObject('scriptRun', runId, { id: runId, t: now, type: b.type, script: script ? script.name : COMMAND_NAMES[b.type], count: cmds.length, by: user });
  await log(script ? 'Scripts' : b.type.startsWith('remote') ? 'Remote desktop' : 'Client notification', `${script ? `Ran “${script.name}”` : COMMAND_NAMES[b.type]} on ${cmds.length} device${cmds.length === 1 ? '' : 's'}`, 'info', user);
  return { status: 200, body: { runId, commands: cmds.map(({ body, ...c }) => c) } };
}

async function route_({ method, path, query = {}, body = {}, headers = {} }) {
  path = path.replace(/\/+$/, '');
  const route = `${method} ${path}`;
  if (route === 'GET /api/health') {
    try { await db.countDevices(); } catch (e) { console.error('storage', e.message); return { status: 503, body: { status: 'storage-unavailable', version: VERSION, storage: db.kind } }; }
    return { status: 200, body: { status: 'ok', version: VERSION, storage: db.kind } };
  }

  if (path.startsWith('/api/agent/')) {
    const token = process.env.AGENT_ENROLL_TOKEN;
    if (!token) return { status: 503, body: { error: 'Enrollment is not set up on the server (AGENT_ENROLL_TOKEN)' } };
    if (!safeEqual(headers['x-ggt-enroll-token'], token)) return { status: 401, body: { error: 'Missing or invalid x-ggt-enroll-token header' } };
    if (route === 'POST /api/agent/checkin') return checkin(body || {}, headers);
    if (route === 'GET /api/agent/policy') return policy(query, headers);
    if (route === 'POST /api/agent/status') return status(body || {}, headers);
    if (route === 'POST /api/agent/result') return commandResult(body || {}, headers);
    return { status: 404, body: { error: 'Not found' } };
  }

  if (path.startsWith('/api/console/')) {
    const p = principal(headers);
    if (!p) return { status: 401, body: { error: 'Sign in first' } };
    const user = `${p.userDetails}`;
    if (route === 'GET /api/console/me') return { status: 200, body: { user, provider: p.identityProvider, admin: isAdmin(p), adminConfigured: adminList().length > 0 } };
    if (!isAdmin(p)) return { status: 403, body: { error: `${user} is not a Device Manager admin`, user } };
    if (route === 'GET /api/console/state') return consoleState(user, headers);
    if (route === 'GET /api/console/enrollment') return { status: 200, body: { token: process.env.AGENT_ENROLL_TOKEN || null } };
    if (route === 'POST /api/console/commands') return createCommands(body || {}, user);
    if (route === 'POST /api/console/alerts/ack') {
      const all = await db.listObjects('alert', { where: { ack: false }, limit: 1000 });
      const pick = body?.all ? all : all.filter(a => (body?.ids || []).includes(a.id));
      await db.putMany('alert', pick.map(a => ({ ...a, ack: true, ackBy: user })));
      return { status: 200, body: { acknowledged: pick.length } };
    }
    let m = /^\/api\/console\/devices\/([\w-]{1,64})$/.exec(path);
    if (m) {
      const doc = await db.getDevice(m[1]);
      if (!doc) return { status: 404, body: { error: 'Unknown device' } };
      if (method === 'GET') return { status: 200, body: { device: publicDevice(doc), statuses: await db.listStatuses(doc.id) } };
      if (method === 'PUT') {
        const tags = (arr(body?.tags, 30) || []).filter(t => str(t, 40)).map(t => t.trim().toLowerCase());
        await db.upsertDevice({ ...doc, tags: [...new Set(tags)] });
        return { status: 200, body: { tags } };
      }
      if (method === 'DELETE') {
        await db.deleteDevice(doc.id);
        await log('Devices', `Retired ${doc.name}. It re-enrols if its agent checks in again.`, 'warn', user);
        return { status: 200, body: { deleted: true } };
      }
    }
    m = /^\/api\/console\/objects\/(\w+)\/([\w.-]{1,64})$/.exec(path);
    if (m && method === 'PUT') return putObject(m[1], m[2], body, user);
    if (m && method === 'DELETE') return deleteObject(m[1], m[2], query, user);
    return { status: 404, body: { error: 'Not found' } };
  }
  return { status: 404, body: { error: 'Not found' } };
}

async function handle(req) {
  try { return await route_(req); } catch (e) {
    console.error('api error', e && e.message);
    return { status: 503, body: { error: 'The device database is unavailable. Try again shortly.' } };
  }
}

module.exports = { handle, useStore, _db: () => db, VERSION };
