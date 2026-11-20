// State, persistence, rule evaluation and the live simulation that stands in for device agents.
import { generate, APPS, UPDATES, BASELINES, SITES } from './seed.js';

const KEY = 'gg-dm-state-v1';
const DAY = 86400000;
const listeners = new Set();
export let state;

export const ERRORS = {
  '0x80070070': 'Not enough disk space to install',
  '0x87D00324': 'Application was not detected after installation completed',
  '0x80240022': 'Windows Update agent operation failed',
  '0x87D00607': 'Content not found on the distribution point',
  '0x80070643': 'Fatal error during installation (installer exit code 1603)',
};

function fresh() {
  const g = generate();
  return {
    ...g,
    apps: APPS.map(a => ({ ...a, created: g.generatedAt - 90 * DAY, content: Object.fromEntries(SITES.map(s => [s.dp, 'Distributed'])) })),
    baselines: BASELINES.map(b => ({ ...b, rules: b.rules.map(r => ({ ...r })) })),
    deployments: [],
    alerts: [],
    log: [],
    scriptRuns: [],
    settings: { simulate: true },
    seq: 1,
  };
}

export function load() {
  let s = null;
  try { const raw = localStorage.getItem(KEY); if (raw) s = JSON.parse(raw); } catch { s = null; }
  if (!s || !s.devices) { s = fresh(); state = s; seedHistory(); save(); } else state = s;
  return state;
}
let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage unavailable: demo still works in memory */ } }, 300);
}
export function reset() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  state = fresh(); seedHistory(); save(); emit();
}
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit() { listeners.forEach(fn => fn()); }
const nid = p => `${p}${state.seq++}`;

export function log(source, message, level = 'info') {
  state.log.unshift({ t: Date.now(), source, message, level });
  if (state.log.length > 300) state.log.length = 300;
}
export function alert(severity, title, detail, deviceId) {
  state.alerts.unshift({ id: nid('al'), t: Date.now(), severity, title, detail, deviceId, ack: false });
  if (state.alerts.length > 150) state.alerts.length = 150;
}

// ---------- lookups ----------
export const byId = (list, id) => state[list].find(x => x.id === id);
export const device = id => byId('devices', id);
export const app = id => byId('apps', id);
export const update = id => UPDATES.find(u => u.id === id);
export const UPDATE_LIST = UPDATES;

// ---------- collections ----------
export const FIELDS = {
  platform: { label: 'Platform', values: () => ['Windows', 'macOS', 'Linux'] },
  os: { label: 'Operating system', values: () => uniq(state.devices.map(d => d.os)) },
  osFamily: { label: 'OS family', values: () => uniq(state.devices.map(d => d.osFamily)) },
  type: { label: 'Device type', values: () => ['Laptop', 'Desktop', 'Server', 'VM'] },
  site: { label: 'Site', values: () => SITES.map(s => s.name) },
  dept: { label: 'Department', values: () => uniq(state.devices.map(d => d.dept)) },
  tag: { label: 'Tag', values: () => uniq(state.devices.flatMap(d => d.tags)) },
  health: { label: 'Client health', values: () => ['Healthy', 'Needs attention', 'Inactive'] },
  manufacturer: { label: 'Manufacturer', values: () => uniq(state.devices.map(d => d.manufacturer)) },
  name: { label: 'Device name', values: null },
  app: { label: 'Installed application', values: () => state.apps.map(a => a.name) },
};
const uniq = a => [...new Set(a)].sort();

function ruleMatch(d, r) {
  const v = String(r.value ?? '').trim();
  let actual;
  if (r.field === 'tag') actual = d.tags;
  else if (r.field === 'app') actual = d.installed.map(id => app(id)?.name);
  else actual = [d[r.field]];
  const has = x => actual.some(a => String(a).toLowerCase() === x.toLowerCase());
  switch (r.op) {
    case 'is': return has(v);
    case 'not': return !has(v);
    case 'in': return v.split(',').map(s => s.trim()).filter(Boolean).some(has);
    case 'contains': return actual.some(a => String(a).toLowerCase().includes(v.toLowerCase()));
    case 'starts': return actual.some(a => String(a).toLowerCase().startsWith(v.toLowerCase()));
    default: return false;
  }
}
export function inCollection(d, c) {
  if (!c) return false;
  if (c.direct) { if (c.direct.includes(d.id)) return true; if (!c.rules.length) return false; }
  if (!c.rules.length) return true;
  return c.match === 'any' ? c.rules.some(r => ruleMatch(d, r)) : c.rules.every(r => ruleMatch(d, r));
}
export const members = cid => { const c = byId('collections', cid); return state.devices.filter(d => inCollection(d, c)); };
export const deviceCollections = d => state.collections.filter(c => inCollection(d, c));

// ---------- compliance ----------
const isWorkstation = d => d.type === 'Laptop' || d.type === 'Desktop';
export function evalRule(d, rule) {
  if (rule.workstationOnly && !isWorkstation(d)) return null;
  const now = Date.now();
  switch (rule.id) {
    case 'enc': return d.encrypted;
    case 'av': return d.avOn;
    case 'fw': return d.fwOn;
    case 'defs': return d.defsAgeDays < 3;
    case 'osok': return d.osFamily !== 'win10';
    case 'reboot': return !d.pendingRebootSince || now - d.pendingRebootSince < 7 * DAY;
    case 'crit': return !d.missingUpdates.some(id => { const u = update(id); return u && u.severity === 'Critical' && u.classification === 'Security Updates' && -u.released > 7; });
    case 'lock': return d.screenLockMin > 0 && d.screenLockMin <= 10;
    case 'admin': return !d.extraAdmins;
    case 'usb': return d.usbBlocked;
    case 'vpn': return d.platform === 'Linux' ? null : d.installed.includes('app-forti');
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
// Fixes what an agent could fix on its own (remediable rules).
function remediate(d, rule) {
  switch (rule.id) {
    case 'av': d.avOn = true; break;
    case 'fw': d.fwOn = true; break;
    case 'defs': d.defsAgeDays = 0; break;
    case 'lock': d.screenLockMin = 10; break;
    case 'admin': d.extraAdmins = false; break;
    case 'usb': d.usbBlocked = true; break;
    case 'vpn': if (!d.installed.includes('app-forti')) d.installed.push('app-forti'); break;
    default: return false;
  }
  return true;
}
export function remediateNow(baselineId) {
  const b = byId('baselines', baselineId);
  let n = 0;
  for (const d of state.devices) {
    if (!d.online) continue;
    for (const r of b.rules) if (r.remediable && evalRule(d, r) === false && remediate(d, r)) n++;
  }
  log('Compliance', `${b.name}: remediated ${n} setting${n === 1 ? '' : 's'} on online devices`);
  save(); emit();
  return n;
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
  state.updateGroups.push(g);
  log('Software updates', `Created update group “${name}” with ${updateIds.length} updates`);
  save(); emit();
  return g;
}

// ---------- deployments ----------
export const STATUS = [
  ['success', 'Success', '#2f9e5a'], ['inprogress', 'In progress', '#4a90d9'], ['error', 'Error', '#d9483b'],
  ['reqnotmet', 'Requirements not met', '#e0a526'], ['unknown', 'Unknown', '#a9b5ad'],
];
function initialState(dep, d) {
  if (dep.kind === 'app') {
    const a = app(dep.targetId);
    if (!a.platforms.includes(d.platform)) return 'reqnotmet';
    const has = d.installed.includes(a.id);
    if (dep.action === 'Install' && has) return 'success';
    if (dep.action === 'Uninstall' && !has) return 'success';
  } else {
    const g = byId('updateGroups', dep.targetId);
    if (!g.updateIds.some(id => d.missingUpdates.includes(id))) return 'success';
  }
  return 'unknown';
}
export function createDeployment(o) {
  const dep = {
    id: nid('dep'), created: Date.now(), createdBy: 'GGT\\it.admin', results: {}, errors: {}, enabled: true,
    respectMW: true, restart: 'Suppress', purpose: 'Required', action: 'Install', ...o,
  };
  const target = dep.kind === 'app' ? app(dep.targetId) : byId('updateGroups', dep.targetId);
  dep.name = dep.name || `${target.name} → ${byId('collections', dep.collectionId).name}`;
  for (const d of members(dep.collectionId)) dep.results[d.id] = initialState(dep, d);
  state.deployments.unshift(dep);
  log('Deployments', `Deployed ${target.name} to ${byId('collections', dep.collectionId).name} (${dep.purpose}, ${Object.keys(dep.results).length} devices)`);
  save(); emit();
  return dep;
}
export function deploymentSummary(dep) {
  const c = { success: 0, inprogress: 0, error: 0, reqnotmet: 0, unknown: 0 };
  for (const s of Object.values(dep.results)) c[s]++;
  c.total = Object.keys(dep.results).length;
  c.pct = c.total ? Math.round(c.success / c.total * 100) : 0;
  return c;
}
export function retryFailed(depId) {
  const dep = byId('deployments', depId);
  let n = 0;
  for (const [id, s] of Object.entries(dep.results)) if (s === 'error') { dep.results[id] = 'unknown'; delete dep.errors[id]; n++; }
  log('Deployments', `Retrying ${n} failed device${n === 1 ? '' : 's'} for ${dep.name}`);
  save(); emit();
  return n;
}
export function deleteDeployment(depId) {
  const dep = byId('deployments', depId);
  state.deployments = state.deployments.filter(d => d.id !== depId);
  log('Deployments', `Deleted deployment ${dep.name}`);
  save(); emit();
}
function complete(dep, d) {
  if (dep.kind === 'app') {
    const a = app(dep.targetId);
    if (dep.action === 'Install') { if (!d.installed.includes(a.id)) d.installed.push(a.id); }
    else d.installed = d.installed.filter(x => x !== a.id);
  } else {
    const g = byId('updateGroups', dep.targetId);
    for (const id of g.updateIds) {
      if (!d.missingUpdates.includes(id)) continue;
      d.missingUpdates = d.missingUpdates.filter(x => x !== id);
      d.installedUpdates.push(id);
      const u = update(id);
      if (u.reboot) { if (dep.restart === 'Allow') d.lastBoot = Date.now(); else if (!d.pendingRebootSince) d.pendingRebootSince = Date.now(); }
    }
  }
}

// ---------- device actions ----------
export const SCRIPTS = [
  { id: 'disk', name: 'Get disk usage', lang: 'PowerShell', body: 'Get-Volume | Where DriveLetter | Select DriveLetter, SizeRemaining, Size' },
  { id: 'temp', name: 'Clear temp files', lang: 'PowerShell', body: 'Remove-Item "$env:WINDIR\\Temp\\*","$env:TEMP\\*" -Recurse -Force -ErrorAction SilentlyContinue' },
  { id: 'spool', name: 'Restart print spooler', lang: 'PowerShell', body: 'Restart-Service -Name Spooler -Force; Get-Service Spooler' },
  { id: 'gpupdate', name: 'Refresh group policy', lang: 'PowerShell', body: 'gpupdate /force' },
  { id: 'logs', name: 'Collect agent logs', lang: 'PowerShell', body: 'Compress-Archive "$env:ProgramData\\GGT Agent\\Logs" "\\\\GGT-LAG-DP01\\Logs$\\$env:COMPUTERNAME.zip"' },
];
export function runScript(scriptId, deviceIds) {
  const s = SCRIPTS.find(x => x.id === scriptId);
  const out = [];
  for (const id of deviceIds) {
    const d = device(id);
    if (!d.online) { out.push({ device: d.name, status: 'Offline', output: 'Device is offline. The script will run at next check-in.' }); continue; }
    if (d.platform !== 'Windows') { out.push({ device: d.name, status: 'Not run', output: 'PowerShell scripts target Windows devices.' }); continue; }
    let o = '';
    if (s.id === 'disk') { const used = d.diskGB * (100 - d.diskFreePct) / 100; o = `DriveLetter SizeRemaining      Size\n----------- -------------      ----\nC           ${(d.diskGB - used).toFixed(1)} GB      ${d.diskGB} GB`; }
    if (s.id === 'temp') { const freed = (0.3 + Math.random() * 3.5).toFixed(2); d.diskFreePct = Math.min(95, d.diskFreePct + 1 + Math.round(Math.random() * 3)); o = `Removed ${Math.floor(400 + Math.random() * 6000)} files, freed ${freed} GB`; }
    if (s.id === 'spool') o = 'Status   Name     DisplayName\n------   ----     -----------\nRunning  Spooler  Print Spooler';
    if (s.id === 'gpupdate') o = 'Updating policy...\n\nComputer Policy update has completed successfully.\nUser Policy update has completed successfully.';
    if (s.id === 'logs') o = `Uploaded ${d.name}.zip (${(1 + Math.random() * 9).toFixed(1)} MB) to \\\\GGT-LAG-DP01\\Logs$`;
    out.push({ device: d.name, status: 'Succeeded', output: o });
  }
  state.scriptRuns.unshift({ id: nid('sr'), t: Date.now(), script: s.name, count: deviceIds.length, ok: out.filter(o => o.status === 'Succeeded').length });
  log('Scripts', `Ran “${s.name}” on ${deviceIds.length} device${deviceIds.length === 1 ? '' : 's'}`);
  save(); emit();
  return out;
}
export function deviceAction(id, action) {
  const d = device(id);
  const msgs = {
    policy: `Machine policy retrieval requested on ${d.name}`,
    hwinv: `Hardware inventory cycle requested on ${d.name}`,
    swinv: `Software inventory cycle requested on ${d.name}`,
    eval: `Compliance evaluation requested on ${d.name}`,
    updscan: `Software update scan requested on ${d.name}`,
    restart: `Restart requested on ${d.name}`,
    wake: `Wake-on-LAN packet sent to ${d.name}`,
  };
  if (!d.online && action !== 'wake') { log('Client notification', `${msgs[action]}: device offline, queued for next check-in`, 'warn'); save(); emit(); return 'queued'; }
  if (action === 'restart') { d.lastBoot = Date.now(); d.pendingRebootSince = null; }
  if (action === 'wake') { d.online = true; d.lastSeen = Date.now(); if (d.health === 'Inactive') d.health = 'Healthy'; }
  if (action === 'eval') { /* evaluation is live */ }
  if (action === 'policy') d.lastSeen = Date.now();
  log('Client notification', msgs[action]);
  save(); emit();
  return 'ok';
}
export function setTags(id, tags) { device(id).tags = tags; save(); emit(); }

// ---------- library, collections, maintenance windows ----------
export function addApp(a) {
  const x = { id: nid('app-'), created: Date.now(), prevalence: 0, content: Object.fromEntries(SITES.map(s => [s.dp, 'In progress'])), ...a };
  state.apps.push(x);
  log('Software library', `Added application ${a.name} ${a.version}; distributing content to ${SITES.length} distribution points`);
  save(); emit();
  return x;
}
export function saveCollection(c) {
  if (c.id) Object.assign(byId('collections', c.id), c);
  else { c.id = nid('c-'); state.collections.push(c); }
  log('Collections', `Saved collection ${c.name} (${members(c.id).length} members)`);
  save(); emit();
  return c;
}
export function deleteCollection(id) {
  const c = byId('collections', id);
  if (state.deployments.some(d => d.collectionId === id)) return false;
  state.collections = state.collections.filter(x => x.id !== id);
  log('Collections', `Deleted collection ${c.name}`);
  save(); emit();
  return true;
}
export function addMaintenanceWindow(mw) { state.maintenanceWindows.push({ id: nid('mw'), ...mw }); log('Maintenance windows', `Added ${mw.name}`); save(); emit(); }
export function deleteMaintenanceWindow(id) { state.maintenanceWindows = state.maintenanceWindows.filter(m => m.id !== id); save(); emit(); }
export function toggleAdr(id) { const a = byId('adrs', id); a.enabled = !a.enabled; log('Software updates', `${a.enabled ? 'Enabled' : 'Disabled'} rule ${a.name}`); save(); emit(); }
export function runAdr(id) {
  const a = byId('adrs', id);
  a.lastRun = Date.now(); a.lastResult = 'Success: evaluated, deployment refreshed';
  const existing = state.deployments.find(d => d.kind === 'updates' && d.targetId === a.targetGroup && d.collectionId === a.collectionId);
  if (!existing) createDeployment({ kind: 'updates', targetId: a.targetGroup, collectionId: a.collectionId, purpose: 'Required', name: `${a.name} (ADR)` });
  log('Software updates', `Ran rule ${a.name}`);
  save(); emit();
}
export function ackAlert(id) { const a = byId('alerts', id); if (a) a.ack = true; save(); emit(); }
export function ackAll() { state.alerts.forEach(a => a.ack = true); save(); emit(); }

// ---------- simulation ----------
const chance = p => Math.random() < p;
const pickOne = arr => arr[Math.floor(Math.random() * arr.length)];

export function tick() {
  if (!state.settings.simulate) return;
  const now = Date.now();
  const devs = state.devices;
  // heartbeats & metrics
  for (const d of devs) {
    if (d.health === 'Inactive') continue;
    if (d.online) {
      d.lastSeen = now;
      d.cpuPct = clamp(d.cpuPct + Math.round((Math.random() - 0.5) * 14), 1, 99);
      d.memPct = clamp(d.memPct + Math.round((Math.random() - 0.5) * 6), 15, 97);
      if (chance(0.002)) { d.online = false; if (d.type === 'Server' && d.tags.includes('critical-server')) alert('Critical', `${d.name} stopped responding`, `No heartbeat from critical server at ${d.site}.`, d.id); }
    } else if (chance(0.01)) { d.online = true; d.lastSeen = now; d.cpuPct = 10; d.memPct = 40; if (d.health === 'Needs attention' && chance(0.5)) d.health = 'Healthy'; }
  }
  // occasional drift that compliance should catch
  if (chance(0.06)) {
    const d = pickOne(devs.filter(x => x.online && x.platform === 'Windows'));
    const what = pickOne(['fw', 'av', 'admin', 'disk']);
    if (what === 'fw' && d.fwOn) { d.fwOn = false; alert('Important', `Firewall turned off on ${d.name}`, 'Endpoint Security Baseline will flag and remediate this at next evaluation.', d.id); }
    if (what === 'av' && d.avOn) { d.avOn = false; alert('Critical', `Real-time protection disabled on ${d.name}`, 'Antivirus real-time protection was turned off.', d.id); }
    if (what === 'admin' && !d.extraAdmins) { d.extraAdmins = true; alert('Important', `New local admin on ${d.name}`, 'An unapproved account was added to Administrators.', d.id); }
    if (what === 'disk' && d.diskFreePct > 8) { d.diskFreePct = 3 + Math.floor(Math.random() * 4); alert('Moderate', `Low disk space on ${d.name}`, `Only ${d.diskFreePct}% free on C:. Installs may fail with 0x80070070.`, d.id); }
  }
  // auto-remediation for baselines that have it on
  for (const b of state.baselines) {
    if (!b.remediate) continue;
    for (const r of b.rules) {
      if (!r.remediable) continue;
      for (const d of devs) if (d.online && evalRule(d, r) === false && chance(0.04)) { remediate(d, r); log('Compliance', `Remediated “${r.name}” on ${d.name}`); }
    }
  }
  // deployments progress
  for (const dep of state.deployments) {
    if (!dep.enabled) continue;
    const isAvail = dep.purpose === 'Available';
    let finished = 0, failed = 0;
    for (const [id, s] of Object.entries(dep.results)) {
      const d = device(id);
      if (!d || !d.online) continue;
      if (s === 'unknown' && chance(isAvail ? 0.03 : 0.3)) dep.results[id] = 'inprogress';
      else if (s === 'inprogress' && chance(0.25)) {
        const size = dep.kind === 'app' ? app(dep.targetId).sizeMB : 600;
        let err = null;
        if (d.diskFreePct < 8 && size > 50) err = '0x80070070';
        else if (chance(0.035)) err = pickOne(dep.kind === 'app' ? ['0x87D00324', '0x80070643', '0x87D00607'] : ['0x80240022', '0x80070643']);
        if (err) { dep.results[id] = 'error'; dep.errors[id] = err; failed++; }
        else { dep.results[id] = 'success'; complete(dep, d); finished++; }
      }
    }
    if (failed) log('Deployments', `${dep.name}: ${failed} device${failed > 1 ? 's' : ''} failed`, 'error');
    const sum = deploymentSummary(dep);
    if (!dep.doneLogged && sum.inprogress === 0 && sum.unknown === 0) { dep.doneLogged = true; log('Deployments', `${dep.name} finished: ${sum.success} succeeded, ${sum.error} failed`); }
  }
  save();
  emit();
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// A few weeks of realistic history so the console isn't empty on first open.
function seedHistory() {
  const now = Date.now();
  const mk = (o, ageMs, progress) => {
    const dep = createDeployment(o);
    dep.created = now - ageMs;
    for (const id of Object.keys(dep.results)) {
      if (dep.results[id] !== 'unknown') continue;
      const d = device(id);
      const x = Math.random();
      if (!d.online && x < 0.7) continue;
      if (x < progress) {
        if (d.diskFreePct < 8 || Math.random() < 0.03) { dep.results[id] = 'error'; dep.errors[id] = d.diskFreePct < 8 ? '0x80070070' : '0x80070643'; }
        else { dep.results[id] = 'success'; complete(dep, d); }
      } else if (x < progress + 0.08) dep.results[id] = 'inprogress';
    }
  };
  mk({ kind: 'app', targetId: 'app-forti', collectionId: 'c-wks', purpose: 'Required', name: 'FortiClient VPN 7.4.1 · All workstations' }, 21 * DAY, 0.97);
  mk({ kind: 'app', targetId: 'app-3cx', collectionId: 'c-wks', purpose: 'Available', name: '3CX Desktop App · Software Center' }, 30 * DAY, 0.5);
  mk({ kind: 'app', targetId: 'app-pvsyst', collectionId: 'c-eng', purpose: 'Required', name: 'PVsyst 8.0.4 · Engineering & Installations' }, 6 * DAY, 0.8);
  mk({ kind: 'updates', targetId: 'ug-2611', collectionId: 'c-pilot', purpose: 'Required', restart: 'Allow', name: '2026-11 Patch Tuesday · Pilot ring' }, 8 * DAY, 0.95);
  mk({ kind: 'updates', targetId: 'ug-2611', collectionId: 'c-broad', purpose: 'Required', name: '2026-11 Patch Tuesday · Broad ring' }, 1 * DAY, 0.35);
  mk({ kind: 'updates', targetId: 'ug-defs', collectionId: 'c-all', purpose: 'Required', name: 'Defender definitions (ADR)' }, 10 * 3600000, 0.75);
  mk({ kind: 'app', targetId: 'app-ivms', collectionId: 'c-field', purpose: 'Required', name: 'Hikvision iVMS-4200 · Field laptops' }, 2 * DAY, 0.45);
  state.log = [];
  const sample = [
    ['Deployments', 'Defender definitions (ADR): definitions 1.421.x published to all distribution points', 'info', 0.4],
    ['Software updates', 'Synchronization with Microsoft Update completed: 14 new, 3 superseded, 0 expired', 'info', 3],
    ['Compliance', 'Endpoint Security Baseline evaluated on 238 devices', 'info', 4],
    ['Distribution points', 'GGT-KAN-DP01: content validation finished, 0 hash mismatches', 'info', 6],
    ['Deployments', '2026-11 Patch Tuesday · Broad ring created by ADR “Patch Tuesday · Broad ring”', 'info', 24],
    ['Client health', '11 clients have not reported for more than 14 days and are marked inactive', 'warn', 26],
  ];
  for (const [s, m, l, h] of sample) state.log.push({ t: now - h * 3600000, source: s, message: m, level: l });
  const al = [
    ['Critical', 'Windows 10 reached end of support', 'Devices on Windows 10 no longer get security fixes. Deploy the 24H2 feature update to “Windows 10 (upgrade to 11)”.', null, 30],
    ['Important', 'Deployment errors above 5%', '2026-11 Patch Tuesday · Broad ring has error rate above threshold on some devices.', null, 5],
  ];
  state.alerts = al.map(([severity, title, detail, deviceId, h]) => ({ id: nid('al'), t: now - h * 3600000, severity, title, detail, deviceId, ack: false }));
  const lowDisk = state.devices.filter(d => d.diskFreePct < 8 && d.online).slice(0, 3);
  for (const d of lowDisk) state.alerts.push({ id: nid('al'), t: now - Math.random() * 20 * 3600000, severity: 'Moderate', title: `Low disk space on ${d.name}`, detail: `${d.diskFreePct}% free on the system drive.`, deviceId: d.id, ack: false });
  state.alerts.sort((a, b) => b.t - a.t);
}
