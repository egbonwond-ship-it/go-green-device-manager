// Console state: loaded from the API (/api/console/state), kept fresh by polling, and changed
// through the API. Rule evaluation (collections, compliance, deployment results) runs here on
// the data the agents reported. Collection rules match api/src/lib/model.js.
const DAY = 86400000;
const POLL_MS = 30000;
const listeners = new Set();
export let state = null;
export const DEFAULT_STATE = { devices: [], updates: [], apps: [], collections: [], deployments: [], updateGroups: [], adrs: [], baselines: [], maintenanceWindows: [], scripts: [], sites: [], alerts: [], log: [], commands: [], scriptRuns: [], settings: { approvedAdmins: [] } };

// Error codes agents commonly report (Windows Installer, Windows Update and the agent itself).
export const ERRORS = {
  '0x80070070': 'Not enough disk space to install',
  '0x80070643': 'Fatal error during installation (installer exit code 1603)',
  '0x80070652': 'Another installation is already in progress (1618)',
  '0x80240022': 'Windows Update operation failed',
  '0x8024402C': 'Windows Update could not reach the update server',
  '0x80240438': 'Windows Update service could not be reached',
  '1603': 'Fatal error during installation',
  '1618': 'Another installation is already in progress',
  '1619': 'Installer package could not be opened',
  'NOT_DETECTED': 'Installer finished but the app was not detected afterwards',
  'NO_METHOD': 'No install method for this platform in the software library',
  'DOWNLOAD': 'Installer download failed',
  'HASH': 'Installer file did not match its SHA-256',
  'WINGET': 'winget is not available on this device',
  'TIMEOUT': 'Installer did not finish within 60 minutes',
};

// ---------- API ----------
export class ApiError extends Error { constructor(status, message, body) { super(message); this.status = status; this.body = body; } }
export async function api(method, path, body) {
  let r;
  try {
    r = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new ApiError(0, 'Cannot reach the server. Check your connection.'); }
  // Signed out: Static Web Apps redirects to the sign-in page, which isn't JSON.
  if (!(r.headers.get('content-type') || '').includes('application/json')) throw new ApiError(401, 'Signed out');
  const j = await r.json();
  if (!r.ok) throw new ApiError(r.status, j.error || `Request failed (${r.status})`, j);
  return j;
}
let errorHandler = e => console.error(e);
export const onError = fn => { errorHandler = fn; };
// Change something on the server. Local state is updated first so the screen responds at once;
// if the server refuses, the error is shown and the console reloads what the server has.
function send(method, path, body) {
  return api(method, path, body).catch(e => { errorHandler(e); refresh(); throw e; });
}
const put = (kind, doc, audit) => send('PUT', `/api/console/objects/${kind}/${encodeURIComponent(doc.id)}`, { doc, audit });
const del = (kind, id, audit) => send('DELETE', `/api/console/objects/${kind}/${encodeURIComponent(id)}?audit=${encodeURIComponent(audit || '')}`);
const quiet = p => p.catch(() => {}); // errors already reported by send()

export async function load() {
  const s = await api('GET', '/api/console/state');
  state = { ...DEFAULT_STATE, ...s };
  hydrate();
  return state;
}
let polling = null, inflight = null;
export function refresh() {
  if (inflight) return inflight;
  inflight = api('GET', '/api/console/state').then(s => { state = { ...DEFAULT_STATE, ...s }; hydrate(); emit(); })
    .catch(e => { if (e.status === 401 || e.status === 403) errorHandler(e); })
    .finally(() => { inflight = null; });
  return inflight;
}
export function startPolling() {
  clearInterval(polling);
  polling = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit() { listeners.forEach(fn => fn()); }
const nid = p => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
// Kept for views that write and then redraw.
export function save() {}

function hydrate() {
  for (const d of state.deployments) computeResults(d);
}

// ---------- lookups ----------
export const byId = (list, id) => state[list].find(x => x.id === id);
export const device = id => byId('devices', id);
export const app = id => byId('apps', id);
const unknownUpdate = id => ({ id, kb: id, title: id, product: '', classification: 'Updates', severity: 'Low', released: null, sizeMB: null, reboot: false });
export const update = id => state.updates.find(u => u.id === id) || unknownUpdate(id);
export const updateList = () => state.updates;
export const siteNames = () => [...state.sites.map(s => s.name), 'Unassigned'];

// ---------- collections ----------
export const FIELDS = {
  platform: { label: 'Platform', values: () => ['Windows', 'macOS', 'Linux'] },
  os: { label: 'Operating system', values: () => uniq(state.devices.map(d => d.os)) },
  osFamily: { label: 'OS family', values: () => uniq(state.devices.map(d => d.osFamily)) },
  type: { label: 'Device type', values: () => ['Laptop', 'Desktop', 'Server', 'VM'] },
  site: { label: 'Site', values: siteNames },
  tag: { label: 'Tag', values: () => uniq(state.devices.flatMap(d => d.tags)) },
  health: { label: 'Client health', values: () => ['Healthy', 'Needs attention', 'Inactive'] },
  manufacturer: { label: 'Manufacturer', values: () => uniq(state.devices.map(d => d.manufacturer)) },
  name: { label: 'Device name', values: null },
  user: { label: 'Primary user', values: () => uniq(state.devices.map(d => d.user).filter(Boolean)) },
  app: { label: 'Installed application', values: () => state.apps.map(a => a.name) },
};
const uniq = a => [...new Set(a.filter(x => x != null && x !== ''))].sort();
const lc = s => String(s ?? '').toLowerCase();

function fieldValues(d, field) {
  if (field === 'tag') return d.tags || [];
  if (field === 'app') return (d.installed || []).map(id => app(id)?.name).filter(Boolean);
  return [d[field]];
}
export function ruleMatch(d, r) {
  const v = String(r.value ?? '').trim();
  const actual = fieldValues(d, r.field);
  const has = x => actual.some(a => lc(a) === lc(x));
  switch (r.op) {
    case 'is': return has(v);
    case 'not': return !has(v);
    case 'in': return v.split(',').map(s => s.trim()).filter(Boolean).some(has);
    case 'contains': return actual.some(a => lc(a).includes(lc(v)));
    case 'starts': return actual.some(a => lc(a).startsWith(lc(v)));
    default: return false;
  }
}
export function inCollection(d, c) {
  if (!c) return false;
  const rules = c.rules || [];
  if (c.direct && c.direct.includes(d.id)) return true;
  if (!rules.length) return !(c.direct && c.direct.length);
  return c.match === 'any' ? rules.some(r => ruleMatch(d, r)) : rules.every(r => ruleMatch(d, r));
}
export const members = cid => { const c = byId('collections', cid); return state.devices.filter(d => inCollection(d, c)); };
export const deviceCollections = d => state.collections.filter(c => inCollection(d, c));

// ---------- compliance ----------
const isWorkstation = d => d.type === 'Laptop' || d.type === 'Desktop';
const orNull = v => (v === undefined ? null : v);
// true = passes, false = fails, null = not applicable or not reported by this device's agent.
export function evalRule(d, rule) {
  if (rule.workstationOnly && !isWorkstation(d)) return null;
  const now = Date.now();
  switch (rule.id) {
    case 'enc': return orNull(d.encrypted);
    case 'av': return orNull(d.avOn);
    case 'fw': return orNull(d.fwOn);
    case 'defs': return d.defsAgeDays == null ? null : d.defsAgeDays < 3;
    case 'osok': return d.osFamily !== 'win10';
    case 'reboot': return !d.pendingRebootSince || now - d.pendingRebootSince < 7 * DAY;
    case 'crit': return d.updatesScannedAt ? !d.missingUpdates.some(id => { const u = update(id); return u.severity === 'Critical' && u.released && now - u.released > 7 * DAY; }) : null;
    case 'lock': return d.screenLockMin == null ? null : d.screenLockMin > 0 && d.screenLockMin <= 10;
    case 'admin': return d.extraAdmins == null ? null : !d.extraAdmins;
    case 'usb': return orNull(d.usbBlocked);
    case 'vpn': return d.platform === 'Linux' ? null : orNull(d.vpnInstalled);
    default: return null;
  }
}
export function compliance(d, b) {
  if (d.health === 'Inactive') return { state: 'Unknown', failing: [] };
  const failing = b.rules.filter(r => evalRule(d, r) === false);
  return { state: failing.length ? 'Non-compliant' : 'Compliant', failing };
}
export function deviceCompliant(d) {
  const res = state.baselines.map(b => compliance(d, b).state);
  if (res.includes('Unknown')) return 'Unknown';
  return res.includes('Non-compliant') ? 'Non-compliant' : 'Compliant';
}
export function baselineSummary(b) {
  const out = { Compliant: 0, 'Non-compliant': 0, Unknown: 0 };
  for (const d of state.devices) out[compliance(d, b).state]++;
  const known = out.Compliant + out['Non-compliant'];
  out.pct = known ? Math.round(out.Compliant / known * 100) : 0;
  return out;
}
export function ruleSummary(rule) {
  let pass = 0, fail = 0;
  for (const d of state.devices) { if (d.health === 'Inactive') continue; const r = evalRule(d, rule); if (r === true) pass++; else if (r === false) fail++; }
  return { pass, fail };
}
export function setRemediate(baselineId, on) {
  const b = byId('baselines', baselineId);
  b.remediate = on; emit();
  return quiet(put('baseline', b, `${on ? 'Turned on' : 'Turned off'} automatic remediation for ${b.name}`));
}

// ---------- updates ----------
export function updateStats(u) {
  let required = 0, installed = 0;
  for (const d of state.devices) {
    if (d.missingUpdates.includes(u.id)) required++;
    else if (d.installedUpdates.includes(u.id)) installed++;
  }
  const applicable = required + installed;
  return { required, installed, applicable, pct: applicable ? Math.round(installed / applicable * 100) : 100 };
}
export function createUpdateGroup(name, updateIds) {
  const g = { id: nid('ug'), name, updateIds, created: Date.now() };
  state.updateGroups.push(g); emit();
  quiet(put('updateGroup', g, `Created update group “${name}” with ${updateIds.length} updates`));
  return g;
}
export function deleteUpdateGroup(id) {
  const g = byId('updateGroups', id);
  return del('updateGroup', id, `Deleted update group ${g.name}`).then(() => { state.updateGroups = state.updateGroups.filter(x => x.id !== id); emit(); });
}
export function saveAdr(r) {
  const isNew = !r.id;
  if (isNew) { r.id = nid('adr'); r.created = Date.now(); state.adrs.push(r); }
  emit();
  return quiet(put('adr', r, `${isNew ? 'Created' : 'Changed'} automatic deployment rule ${r.name}`));
}
export function toggleAdr(id) { const a = byId('adrs', id); a.enabled = !a.enabled; emit(); return quiet(put('adr', a, `${a.enabled ? 'Enabled' : 'Disabled'} rule ${a.name}`)); }
export function deleteAdr(id) { const a = byId('adrs', id); state.adrs = state.adrs.filter(x => x.id !== id); emit(); return quiet(del('adr', id, `Deleted rule ${a.name}`)); }
// Updates an automatic deployment rule would approve for one device right now.
export function adrMatches(r, d) {
  const now = Date.now();
  return d.missingUpdates.map(update).filter(u =>
    (!r.classifications?.length || r.classifications.includes(u.classification)) &&
    (!r.severities?.length || r.severities.includes(u.severity)) &&
    (!r.delayDays || (u.released || 0) <= now - r.delayDays * DAY));
}

// ---------- deployments ----------
export const STATUS = [
  ['success', 'Success', '#2f9e5a'], ['inprogress', 'In progress', '#4a90d9'], ['error', 'Error', '#d9483b'],
  ['reqnotmet', 'Requirements not met', '#e0a526'], ['unknown', 'Unknown', '#a9b5ad'],
];
// Result per device: what detection shows now first, then what the agent last reported.
function computeResults(dep) {
  dep.results = {}; dep.errors = {}; dep.messages = {};
  const targeted = members(dep.collectionId);
  const ids = new Set(targeted.map(d => d.id));
  for (const d of state.devices) if (d.depState?.[dep.id] && !ids.has(d.id)) targeted.push(d);
  for (const d of targeted) {
    const st = d.depState?.[dep.id];
    let s = null;
    if (dep.kind === 'app') {
      const a = app(dep.targetId);
      if (a && !a.platforms.includes(d.platform)) s = 'reqnotmet';
      else if (a) { const has = d.installed.includes(a.id); if (dep.action === 'Uninstall' ? !has : has) s = 'success'; }
    } else {
      const g = byId('updateGroups', dep.targetId);
      if (d.updatesScannedAt && !(g?.updateIds || []).some(id => d.missingUpdates.includes(id))) s = 'success';
    }
    if (!s) s = st && ['error', 'inprogress'].includes(st.state) ? st.state : 'unknown';
    dep.results[d.id] = s;
    if (s === 'error') { dep.errors[d.id] = st.errorCode || 'Error'; dep.messages[d.id] = st.message || ''; }
    else if (st?.message) dep.messages[d.id] = st.message;
  }
}
export function createDeployment(o) {
  const dep = { id: nid('dep'), created: Date.now(), createdBy: state.user, enabled: true, respectMW: true, restart: 'Suppress', action: 'Install', ...o };
  const target = dep.kind === 'app' ? app(dep.targetId) : byId('updateGroups', dep.targetId);
  const col = byId('collections', dep.collectionId);
  dep.name = dep.name || `${target.name} → ${col.name}`;
  const { results, errors, messages, ...doc } = dep;
  state.deployments.unshift(dep);
  computeResults(dep); emit();
  quiet(put('deployment', doc, `Deployed ${target.name} to ${col.name} (${Object.keys(dep.results).length} devices)`));
  return dep;
}
const depDoc = ({ results, errors, messages, ...doc }) => doc;
export function deploymentSummary(dep) {
  if (!dep.results) computeResults(dep);
  const c = { success: 0, inprogress: 0, error: 0, reqnotmet: 0, unknown: 0 };
  for (const s of Object.values(dep.results)) c[s]++;
  c.total = Object.keys(dep.results).length;
  c.pct = c.total ? Math.round(c.success / c.total * 100) : 0;
  return c;
}
export function retryFailed(depId) {
  const dep = byId('deployments', depId);
  const n = Object.values(dep.results).filter(s => s === 'error').length;
  dep.retryAt = Date.now(); emit();
  quiet(put('deployment', depDoc(dep), `Retrying ${n} failed device${n === 1 ? '' : 's'} for ${dep.name}`));
  return n;
}
export function setDeploymentEnabled(depId, on) {
  const dep = byId('deployments', depId);
  dep.enabled = on; emit();
  return quiet(put('deployment', depDoc(dep), `${on ? 'Enabled' : 'Disabled'} ${dep.name}`));
}
export function deleteDeployment(depId) {
  const dep = byId('deployments', depId);
  state.deployments = state.deployments.filter(d => d.id !== depId); emit();
  return quiet(del('deployment', depId, `Deleted deployment ${dep.name}`));
}

// ---------- scripts and device actions ----------
export const scriptsFor = platform => state.scripts.filter(s => (s.lang === 'PowerShell') === (platform === 'Windows'));
export async function runScript(scriptId, deviceIds) {
  const r = await send('POST', '/api/console/commands', { type: 'script', scriptId, deviceIds });
  refresh();
  return r;
}
export function deviceAction(id, action) {
  return send('POST', '/api/console/commands', { type: action, deviceIds: [id] }).then(r => { refresh(); return r; });
}
export function devicesAction(ids, action) {
  return send('POST', '/api/console/commands', { type: action, deviceIds: ids }).then(r => { refresh(); return r; });
}
export function saveTailscaleKey(authKey) {
  return send('PUT', '/api/console/vpn/tailscale-key', { authKey }).then(r => { state.tailscaleKey = r; emit(); refresh(); return r; });
}
export const runCommands = runId => state.commands.filter(c => c.runId === runId);
export function saveScript(s) {
  const isNew = !s.id;
  if (isNew) { s.id = nid('sc'); state.scripts.push(s); }
  emit();
  return quiet(put('script', s, `${isNew ? 'Added' : 'Changed'} script ${s.name}`));
}
export function deleteScript(id) { const s = byId('scripts', id); state.scripts = state.scripts.filter(x => x.id !== id); emit(); return quiet(del('script', id, `Deleted script ${s.name}`)); }

// ---------- devices ----------
export function setTags(id, tags) {
  device(id).tags = tags; hydrate(); emit();
  return quiet(send('PUT', `/api/console/devices/${encodeURIComponent(id)}`, { tags }));
}
export const deviceDetail = id => api('GET', `/api/console/devices/${encodeURIComponent(id)}`);
export function retireDevice(id) {
  return send('DELETE', `/api/console/devices/${encodeURIComponent(id)}`).then(() => { state.devices = state.devices.filter(d => d.id !== id); hydrate(); emit(); });
}
export const enrollment = () => api('GET', '/api/console/enrollment');

// ---------- library, collections, sites, maintenance windows, settings ----------
export function saveApp(a) {
  const isNew = !a.id;
  if (isNew) { a.id = nid('app'); a.created = Date.now(); state.apps.push(a); } else Object.assign(app(a.id), a);
  hydrate(); emit();
  quiet(put('app', isNew ? a : app(a.id), `${isNew ? 'Added' : 'Changed'} application ${a.name} ${a.version}`));
  return a;
}
export function deleteApp(id) {
  const a = app(id);
  return del('app', id, `Deleted application ${a.name}`).then(() => { state.apps = state.apps.filter(x => x.id !== id); emit(); });
}
export function saveCollection(c) {
  const isNew = !c.id;
  if (isNew) { c.id = nid('c'); state.collections.push(c); } else Object.assign(byId('collections', c.id), c);
  hydrate(); emit();
  quiet(put('collection', isNew ? c : byId('collections', c.id), `Saved collection ${c.name} (${members(c.id).length} members)`));
  return c;
}
export function deleteCollection(id) {
  const c = byId('collections', id);
  if ([...state.deployments, ...state.adrs, ...state.maintenanceWindows].some(d => d.collectionId === id)) return false;
  state.collections = state.collections.filter(x => x.id !== id); emit();
  quiet(del('collection', id, `Deleted collection ${c.name}`));
  return true;
}
export function addMaintenanceWindow(mw) { const m = { id: nid('mw'), ...mw }; state.maintenanceWindows.push(m); emit(); return quiet(put('maintenanceWindow', m, `Added maintenance window ${mw.name}`)); }
export function deleteMaintenanceWindow(id) { const m = byId('maintenanceWindows', id); state.maintenanceWindows = state.maintenanceWindows.filter(x => x.id !== id); emit(); return quiet(del('maintenanceWindow', id, `Removed maintenance window ${m.name}`)); }
export function saveSite(s) { const isNew = !s.id; if (isNew) { s.id = nid('site'); state.sites.push(s); } emit(); return quiet(put('site', s, `${isNew ? 'Added' : 'Changed'} site ${s.name}`).then(() => refresh())); }
export function deleteSite(id) { const s = byId('sites', id); state.sites = state.sites.filter(x => x.id !== id); emit(); return quiet(del('site', id, `Removed site ${s.name}`).then(() => refresh())); }
export function saveSettings(patch, audit) { state.settings = { ...state.settings, ...patch, id: 'main' }; emit(); return quiet(put('settings', state.settings, audit).then(() => refresh())); }
export function ackAlert(id) { const a = byId('alerts', id); if (a) a.ack = true; emit(); return quiet(send('POST', '/api/console/alerts/ack', { ids: [id] })); }
export function ackAll() { state.alerts.forEach(a => { a.ack = true; }); emit(); return quiet(send('POST', '/api/console/alerts/ack', { all: true })); }
