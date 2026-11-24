// Turns what agents report into the device records the console shows, works out collection
// membership and maintenance windows, and builds the policy each agent pulls.
// The console (app/js/store.js) has the same collection-rule logic; scripts/smoke-test.js checks they agree.
const DAY = 86400000;
const ONLINE_MS = 15 * 60000;

const lc = s => String(s ?? '').toLowerCase();
const uniq = a => [...new Set(a)];

function osFamily(platform, os, build) {
  if (platform === 'Windows') {
    if (/server/i.test(os)) { const m = /20\d\d/.exec(os); return m ? `srv${m[0]}` : 'server'; }
    return parseInt(build, 10) >= 22000 || /windows 11/i.test(os) ? 'win11' : 'win10';
  }
  if (platform === 'macOS') return 'macos';
  const m = /^([a-z]+)/i.exec(os || '');
  return m ? m[1].toLowerCase() : 'linux';
}

function ipToInt(ip) {
  const p = String(ip || '').split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function inCidr(ip, cidr) {
  const [net, bits = '32'] = String(cidr || '').split('/');
  const a = ipToInt(ip), n = ipToInt(net), b = Number(bits);
  if (a === null || n === null || !(b >= 0 && b <= 32)) return false;
  const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
  return ((a & mask) >>> 0) === ((n & mask) >>> 0);
}
const siteFor = (ip, sites) => sites.find(s => String(s.subnets || s.subnet || '').split(/[,\s]+/).filter(Boolean).some(c => inCidr(ip, c)));

const accountName = a => lc(a).split('\\').pop();
function extraAdmins(admins, approved) {
  if (!Array.isArray(admins)) return null;
  const ok = new Set(approved.map(accountName));
  return admins.filter(a => !ok.has(accountName(a)));
}

const ms = v => (v ? new Date(v).getTime() || null : null);

// One device as the console sees it. `doc` is the stored record; ctx has sites, apps and settings.
function deviceView(doc, ctx, now = Date.now()) {
  const sec = doc.security || {};
  const lastSeen = ms(doc.lastSeen) || 0;
  const age = now - lastSeen;
  const site = siteFor(doc.ip, ctx.sites || []);
  const software = Array.isArray(doc.software) ? doc.software : [];
  const extras = extraAdmins(sec.localAdmins, ctx.settings?.approvedAdmins || []);
  const v = {
    id: doc.id, name: doc.name, platform: doc.platform, os: doc.os || 'Unknown', build: doc.build || '',
    osFamily: osFamily(doc.platform, doc.os, doc.build),
    type: ['Laptop', 'Desktop', 'Server', 'VM'].includes(doc.type) ? doc.type : 'Desktop',
    manufacturer: doc.manufacturer || '', model: doc.model || '', serial: doc.serial || '', cpu: doc.cpu || '',
    ramGB: doc.ramGB ?? null, diskGB: doc.diskGB ?? null, diskFreePct: doc.diskFreePct ?? null,
    ip: doc.ip || '', mac: doc.mac || '', user: doc.user || null,
    joinType: doc.joinType || null, domain: doc.domain || '', netbiosDomain: doc.netbiosDomain || '', fqdn: doc.fqdn || '',
    ips: Array.isArray(doc.ips) && doc.ips.length ? doc.ips : doc.ip ? [doc.ip] : [], publicIp: doc.publicIp || '', rdpPort: doc.rdpPort || null,
    tailscale: doc.tailscale || null,
    ggvpn: doc.ggvpnWanted || doc.ggvpn ? { wanted: !!doc.ggvpnWanted, address: doc.ggvpnAddr || null, reported: doc.ggvpn || null } : null,
    fortiConnected: doc.fortiConnected ?? null,
    lastBoot: ms(doc.lastBoot), cpuPct: doc.cpuPct ?? null, memPct: doc.memPct ?? null, agentVersion: doc.agentVersion || '',
    enrolled: ms(doc.enrolled), lastSeen, online: age < ONLINE_MS,
    health: age > 14 * DAY ? 'Inactive' : age > 3 * DAY || (doc.agentErrors || []).length ? 'Needs attention' : 'Healthy',
    agentErrors: doc.agentErrors || [],
    tags: doc.tags || [], site: site ? site.name : 'Unassigned', siteCode: site ? site.code : '',
    encrypted: sec.encrypted ?? null, avOn: sec.avOn ?? null, fwOn: sec.fwOn ?? null, defsAgeDays: sec.defsAgeDays ?? null,
    screenLockMin: sec.screenLockMin ?? null, usbBlocked: sec.usbBlocked ?? null, remoteOn: sec.remoteOn ?? null,
    localAdmins: sec.localAdmins || null, extraAdmins: extras === null ? null : extras.length > 0, unapprovedAdmins: extras || [],
    pendingRebootSince: ms(doc.pendingRebootSince),
    softwareCount: software.length, softwareAt: ms(doc.softwareAt),
    vpnInstalled: software.length ? software.some(s => /forticlient/i.test(s.name || '')) : null,
    installed: (ctx.apps || []).filter(a => a.detectName && software.some(s => lc(s.name).includes(lc(a.detectName)))).map(a => a.id),
    missingUpdates: (doc.updates?.missing || []).map(u => u.id),
    installedUpdates: (doc.updates?.installed || []).map(u => u.id),
    updatesScannedAt: ms(doc.updates?.scannedAt),
    depState: doc.depState || {},
    osReady: doc.osReady || null,
  };
  return v;
}

// Every update any device reported, with how it was described.
function updateCatalogue(docs) {
  const cat = new Map();
  for (const d of docs) {
    for (const u of [...(d.updates?.missing || []), ...(d.updates?.installed || [])]) {
      const prev = cat.get(u.id) || {};
      cat.set(u.id, {
        id: u.id, kb: u.kb || prev.kb || u.id, title: u.title || prev.title || u.id,
        product: u.product || prev.product || d.platform, classification: u.classification || prev.classification || 'Updates',
        severity: u.severity || prev.severity || 'Low', released: ms(u.released) || prev.released || null,
        sizeMB: u.sizeMB ?? prev.sizeMB ?? null, reboot: u.reboot ?? prev.reboot ?? false,
      });
    }
  }
  return [...cat.values()];
}

// ---------- collections (same logic as app/js/store.js) ----------
function fieldValues(d, field, appsById) {
  if (field === 'tag') return d.tags || [];
  if (field === 'app') return (d.installed || []).map(id => appsById[id]?.name).filter(Boolean);
  return [d[field]];
}
function ruleMatch(d, r, appsById = {}) {
  const v = String(r.value ?? '').trim();
  const actual = fieldValues(d, r.field, appsById);
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
function inCollection(d, c, appsById = {}) {
  if (!c) return false;
  const rules = c.rules || [];
  if (c.direct && c.direct.includes(d.id)) return true;
  if (!rules.length) return !(c.direct && c.direct.length);
  return c.match === 'any' ? rules.some(r => ruleMatch(d, r, appsById)) : rules.every(r => ruleMatch(d, r, appsById));
}

// ---------- maintenance windows (times are West Africa Time, UTC+1, no daylight saving) ----------
const DAYSETS = { 'Mon–Fri': [1, 2, 3, 4, 5], 'Mon–Sat': [1, 2, 3, 4, 5, 6], 'Every day': [0, 1, 2, 3, 4, 5, 6], Sat: [6], Sun: [0] };
function windowOpen(mw, now = Date.now()) {
  const wat = now + 3600000;
  const [h, m] = String(mw.start || '00:00').split(':').map(Number);
  const days = DAYSETS[mw.days] || [];
  for (const back of [0, 1]) {
    const d = new Date(wat - back * DAY);
    d.setUTCHours(h || 0, m || 0, 0, 0);
    if (!days.includes(d.getUTCDay())) continue;
    const start = d.getTime();
    if (wat >= start && wat < start + (Number(mw.hours) || 1) * 3600000) return true;
  }
  return false;
}

const isWorkstation = d => d.type === 'Laptop' || d.type === 'Desktop';

// ---------- Windows OS deployment (same logic as app/js/store.js) ----------
// Task sequences run on Windows 10/11 PCs (not Windows Server) whose agent is new enough to run them;
// older agents would mistake an OS deployment for something else.
const OS_AGENT_MIN = '2.4.0';
const verAtLeast = (v, min) => {
  const a = String(v || '0').split('.').map(Number), b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; }
  return true;
};
const buildNumber = d => parseInt(String(d.build || '').split('.')[0], 10) || 0;
// Why a task sequence can't run on a device, or null when it can.
function osNotMet(d) {
  if (d.platform !== 'Windows') return 'Windows PCs only';
  if (/server/i.test(d.os || '')) return 'Windows Server isn’t upgraded by task sequences';
  if (!verAtLeast(d.agentVersion, OS_AGENT_MIN)) return `Needs agent ${OS_AGENT_MIN} or later. Reinstall the agent from Devices → Enrol devices.`;
  return null;
}
// The Windows build a task sequence upgrades to (its last upgrade step), or null if it doesn't upgrade.
function tsTargetBuild(ts, images) {
  const up = (ts?.steps || []).filter(s => s.type === 'upgrade').pop();
  const img = up && (images || []).find(i => i.id === up.imageId);
  return img ? Number(img.build) || null : null;
}
const PLATFORM_KEY = { Windows: 'windows', macOS: 'macos', Linux: 'linux' };

// What one agent should do now.
function buildPolicy(doc, ctx, commands = [], now = Date.now()) {
  const appsById = Object.fromEntries((ctx.apps || []).map(a => [a.id, a]));
  const view = deviceView(doc, ctx, now);
  const colIds = new Set((ctx.collections || []).filter(c => inCollection(view, c, appsById)).map(c => c.id));
  const windows = (ctx.maintenanceWindows || []).filter(m => colIds.has(m.collectionId));
  const allowedNow = kind => {
    const ws = windows.filter(m => m.appliesTo === 'All deployments' || (kind === 'updates' ? m.appliesTo === 'Software updates only' : m.appliesTo === 'Applications only'));
    return !ws.length || ws.some(w => windowOpen(w, now));
  };
  const catalogue = new Map((doc.updates?.missing || []).map(u => [u.id, u]));
  const deployments = [];
  for (const d of ctx.deployments || []) {
    if (d.enabled === false || !colIds.has(d.collectionId) || (d.availableAt && d.availableAt > now)) continue;
    const base = { id: d.id, name: d.name, kind: d.kind, restart: d.restart || 'Suppress', retryAt: d.retryAt || 0, allowedNow: !d.respectMW || allowedNow(d.kind) };
    if (d.kind === 'app') {
      const a = appsById[d.targetId];
      if (!a || !(a.platforms || []).includes(doc.platform)) continue;
      deployments.push({ ...base, action: d.action || 'Install', app: { id: a.id, name: a.name, version: a.version, detectName: a.detectName, ...(a[PLATFORM_KEY[doc.platform]] || {}) } });
    } else if (d.kind === 'os') {
      const ts = (ctx.taskSequences || []).find(x => x.id === d.targetId);
      // OSD_ALLOW_SERVER=1 lets task sequences reach Windows Server too. Only the CI test sets it,
      // because GitHub's Windows machines run Windows Server.
      const why = osNotMet(doc);
      if (!ts || (why && !(process.env.OSD_ALLOW_SERVER === '1' && doc.platform === 'Windows' && /server/i.test(doc.os || '') && verAtLeast(doc.agentVersion, OS_AGENT_MIN)))) continue;
      const steps = [];
      let broken = null;
      for (const st of ts.steps || []) {
        if (st.type === 'readiness') steps.push({ type: 'readiness', win11: !!st.win11, minFreeGB: Number(st.minFreeGB) || 0 });
        else if (st.type === 'bitlocker' || st.type === 'restart') steps.push({ type: st.type });
        else if (st.type === 'script') {
          const sc = (ctx.scripts || []).find(x => x.id === st.scriptId && x.lang === 'PowerShell');
          if (!sc) { broken = 'A Run PowerShell step’s script was deleted'; break; }
          steps.push({ type: 'script', name: sc.name, body: sc.body });
        } else if (st.type === 'app') {
          const a = appsById[st.appId];
          if (!a || !(a.platforms || []).includes('Windows')) { broken = 'An Install application step’s application was deleted or has no Windows install method'; break; }
          steps.push({ type: 'app', app: { id: a.id, name: a.name, version: a.version, detectName: a.detectName, ...(a.windows || {}) } });
        } else if (st.type === 'upgrade') {
          const img = (ctx.osImages || []).find(x => x.id === st.imageId);
          if (!img) { broken = 'The Upgrade Windows step’s image was deleted'; break; }
          steps.push({ type: 'upgrade', image: { id: img.id, name: img.name, build: Number(img.build) || 0, architecture: img.architecture || 'x64', source: img.source, url: img.url || null, sha256: img.sha256 || null }, dynamicUpdate: st.dynamicUpdate !== false, ignoreCompat: !!st.ignoreCompat });
        }
      }
      deployments.push({ ...base, action: 'Install', taskSequence: { id: ts.id, name: ts.name, steps, broken }, targetBuild: tsTargetBuild(ts, ctx.osImages) });
    } else if (d.kind === 'updates') {
      const g = (ctx.updateGroups || []).find(x => x.id === d.targetId);
      const ids = (g?.updateIds || []).filter(id => catalogue.has(id));
      if (ids.length) deployments.push({ ...base, action: 'Install', updateIds: ids });
    }
  }
  for (const r of ctx.adrs || []) {
    if (!r.enabled || !colIds.has(r.collectionId)) continue;
    const ids = [...catalogue.values()].filter(u =>
      (!r.classifications?.length || r.classifications.includes(u.classification)) &&
      (!r.severities?.length || r.severities.includes(u.severity)) &&
      (!r.delayDays || (ms(u.released) || 0) <= now - r.delayDays * DAY)).map(u => u.id);
    if (ids.length) deployments.push({ id: r.id, name: r.name, kind: 'updates', action: 'Install', restart: r.restart || 'Suppress', retryAt: r.retryAt || 0, allowedNow: !r.respectMW || allowedNow('updates'), updateIds: ids });
  }
  const remediate = uniq((ctx.baselines || []).filter(b => b.remediate).flatMap(b => b.rules.filter(r => r.remediable && (!r.workstationOnly || isWorkstation(view))).map(r => r.id)));
  return {
    deviceId: doc.id, issued: new Date(now).toISOString(),
    pollIntervalSec: ctx.settings?.pollIntervalSec || 300,
    deployments, remediate,
    settings: { screenLockMin: 10 },
    commands: commands.map(c => ({ id: c.id, type: c.type, lang: c.lang, body: c.body, name: c.name, ...(c.authKey ? { authKey: c.authKey } : {}), ...(c.vpn ? { vpn: c.vpn } : {}) })),
  };
}

module.exports = { osNotMet, tsTargetBuild, buildNumber, verAtLeast, OS_AGENT_MIN, deviceView, updateCatalogue, ruleMatch, inCollection, windowOpen, buildPolicy, osFamily, inCidr, extraAdmins, ONLINE_MS };
