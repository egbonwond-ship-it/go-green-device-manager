import * as S from '../store.js';
import { esc, fmtN, ago, fmtDate, fmtDay, badge, table, drawer, modal, toast, meter, statusDot, ICON, downloadCsv, size } from '../ui.js';

const FILTERS = [
  ['site', 'All sites', d => d.site],
  ['os', 'All operating systems', d => d.os],
  ['type', 'All device types', d => d.type],
  ['health', 'Any client health', d => d.health],
  ['comp', 'Any compliance', d => S.deviceCompliant(d)],
];

export default function devices(el, { params }) {
  const f = { site: params.site || '', os: params.os || '', type: params.type || '', health: params.health || '', comp: params.comp || '' };
  const rows = () => S.state.devices.filter(d => FILTERS.every(([k, , get]) => !f[k] || get(d) === f[k]));
  el.innerHTML = `<div class="page-head"><div><h1>Devices</h1><p class="muted">Inventory reported by the Go-Green agent on each device. Select a device for details and remote actions.</p></div>
    <div class="actions"><button class="btn" id="csv">Export CSV</button><button class="btn primary" id="enrol">Enrol devices</button></div></div>
    <div class="filters" style="margin-bottom:12px">${FILTERS.map(([k, label, get]) => `<select data-f="${k}" aria-label="${label}"><option value="">${label}</option>${[...new Set(S.state.devices.map(get))].sort().map(v => `<option ${f[k] === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`).join('')}</div>
    <div id="tbl"></div>`;
  const t = table(el.querySelector('#tbl'), {
    rows,
    search: d => `${d.name} ${d.user || ''} ${d.ip} ${d.serial} ${d.model}`,
    onRow: d => openDevice(d.id),
    cols: [
      { key: 'name', label: 'Device', render: d => `<span class="person">${statusDot(d)}<b>${esc(d.name)}</b></span>` },
      { key: 'user', label: 'Primary user', render: d => d.user ? esc(d.user) : '<span class="muted">—</span>' },
      { key: 'os', label: 'Operating system' },
      { key: 'site', label: 'Site' },
      { key: 'type', label: 'Type' },
      { key: 'lastSeen', label: 'Last seen', render: d => d.online ? '<span style="color:var(--good)">Online</span>' : ago(d.lastSeen), sort: d => d.online ? Infinity : d.lastSeen },
      { key: 'comp', label: 'Compliance', render: d => badge(S.deviceCompliant(d)), sort: d => S.deviceCompliant(d) },
      { key: 'missing', label: 'Missing updates', num: true, render: d => d.missingUpdates.length || '<span class="muted">0</span>', sort: d => d.missingUpdates.length },
    ],
  });
  if (params.q) { const i = el.querySelector('input[type=search]'); i.value = params.q; i.dispatchEvent(new Event('input')); }
  el.querySelectorAll('[data-f]').forEach(s => s.addEventListener('change', () => { f[s.dataset.f] = s.value; t.draw(); }));
  el.querySelector('#csv').addEventListener('click', () => downloadCsv('ggt-devices.csv',
    ['Name', 'User', 'Site', 'Department', 'Type', 'OS', 'Manufacturer', 'Model', 'Serial', 'CPU', 'RAM GB', 'Disk GB', 'Disk free %', 'IP', 'MAC', 'Online', 'Last seen', 'Client health', 'Compliance', 'Missing updates'],
    rows().map(d => [d.name, d.user, d.site, d.dept, d.type, d.os, d.manufacturer, d.model, d.serial, d.cpu, d.ramGB, d.diskGB, d.diskFreePct, d.ip, d.mac, d.online ? 'Yes' : 'No', new Date(d.lastSeen).toISOString(), d.health, S.deviceCompliant(d), d.missingUpdates.length])));
  el.querySelector('#enrol').addEventListener('click', enrolHelp);
  return { refresh: () => t.draw() };
}

function enrolHelp() {
  modal('Enrol devices', `<p>Devices join the console when the Go-Green agent is installed and checks in. In this demo the estate is simulated.</p>
    <p><b>Windows</b> (Intune, GPO startup script, or manually as admin):</p>
    <div class="console">msiexec /i GGTAgent.msi /qn ENROLL_URL=https://&lt;your-app&gt;.azurestaticapps.net/api/agent ENROLL_TOKEN=&lt;site token&gt;</div>
    <p style="margin-top:12px"><b>macOS / Linux</b>:</p>
    <div class="console">sudo ./ggt-agent install --url https://&lt;your-app&gt;.azurestaticapps.net/api/agent --token &lt;site token&gt;</div>
    <p class="muted small" style="margin-top:12px">The agent and its check-in API contract are described in the README under “Production backend”. The <span class="mono">/api/agent/checkin</span> endpoint in this repo accepts the inventory payload so you can test an agent against it.</p>`, [{ label: 'Close', cls: 'primary' }], { wide: true });
}

const TABS = ['Summary', 'Software', 'Updates', 'Compliance', 'Deployments', 'Collections'];
export function openDevice(id) {
  let tab = 'Summary';
  const d0 = S.device(id);
  const dr = drawer(`<span class="dev-icon">${ICON[d0.type]}</span><div class="grow" id="dh"></div>`, '');
  const head = () => {
    const d = S.device(id);
    dr.el.querySelector('#dh').innerHTML = `<h2>${esc(d.name)}</h2><div class="muted small">${esc(d.os)} · ${esc(d.manufacturer)} ${esc(d.model)} · ${esc(d.site)}${d.user ? ` · ${esc(d.user)}` : ''}</div>
      <div style="margin-top:6px">${d.online ? badge('Online') : badge(d.health === 'Inactive' ? 'Inactive' : 'Offline')} ${badge(d.health)} ${badge(S.deviceCompliant(d))} ${d.pendingRebootSince ? badge('Restart pending', 'warn') : ''}</div>
      <div class="actions-row">
        <button class="btn sm" data-a="policy">Sync policy</button><button class="btn sm" data-a="hwinv">Hardware inventory</button>
        <button class="btn sm" data-a="updscan">Scan for updates</button><button class="btn sm" data-a="eval">Evaluate compliance</button>
        <button class="btn sm" data-a="script">Run script…</button>${d.online ? '<button class="btn sm danger" data-a="restart">Restart…</button>' : '<button class="btn sm" data-a="wake">Wake up</button>'}
      </div>
      <div class="tabs" style="margin:14px 0 -17px">${TABS.map(t => `<button data-t="${t}" aria-selected="${t === tab}">${t}</button>`).join('')}</div>`;
  };
  const body = () => {
    const d = S.device(id);
    const sec = { Summary: summary, Software: software, Updates: updatesTab, Compliance: complianceTab, Deployments: deploymentsTab, Collections: collectionsTab }[tab];
    dr.body.innerHTML = sec(d);
  };
  const render = () => { head(); body(); };
  dr.head.addEventListener('click', e => {
    const t = e.target.closest('[data-t]');
    if (t) { tab = t.dataset.t; render(); return; }
    const a = e.target.closest('[data-a]');
    if (!a) return;
    const d = S.device(id);
    if (a.dataset.a === 'script') return scriptPicker([id]);
    if (a.dataset.a === 'restart') return modal(`Restart ${d.name}?`, `<p>${d.user ? `${esc(d.user)} gets a 15-minute countdown before the restart.` : 'The server restarts immediately.'}</p>`, [{ label: 'Cancel' }, { label: 'Restart', cls: 'primary danger', onClick: () => { S.deviceAction(id, 'restart'); toast(`Restart sent to ${d.name}`); } }]);
    const r = S.deviceAction(id, a.dataset.a);
    toast(r === 'queued' ? `${d.name} is offline. Queued for next check-in.` : `${a.textContent} sent to ${d.name}`);
  });
  render();
  const off = S.subscribe(() => { if (!document.body.contains(dr.el)) return off(); head(); if (tab === 'Summary' || tab === 'Deployments') body(); });
}

function kv(pairs) { return `<div class="kv">${pairs.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>`; }
function summary(d) {
  const used = d.diskGB * (100 - d.diskFreePct) / 100;
  return `<div class="grid g3" style="margin-bottom:16px">
    <div class="card"><div class="stat-label">CPU</div><div class="stat-value" style="font-size:20px">${d.online ? d.cpuPct + '%' : '—'}</div>${meter(d.online ? d.cpuPct : 0)}</div>
    <div class="card"><div class="stat-label">Memory</div><div class="stat-value" style="font-size:20px">${d.online ? d.memPct + '%' : '—'}</div>${meter(d.online ? d.memPct : 0)}</div>
    <div class="card"><div class="stat-label">System drive</div><div class="stat-value" style="font-size:20px">${d.diskFreePct}% free</div>${meter(100 - d.diskFreePct)}<div class="small muted">${used.toFixed(0)} of ${d.diskGB} GB used</div></div></div>
  <div class="card stack"><h3>Hardware</h3>${kv([['Manufacturer', esc(d.manufacturer)], ['Model', esc(d.model)], ['Serial number', `<span class="mono">${esc(d.serial)}</span>`], ['Processor', esc(d.cpu)], ['Memory', `${d.ramGB} GB`], ['Storage', `${d.diskGB} GB`]])}
  <h3>Operating system & network</h3>${kv([['OS', esc(d.os)], ['Build', esc(d.build)], ['Last boot', fmtDate(d.lastBoot)], ['IP address', `<span class="mono">${esc(d.ip)}</span>`], ['MAC address', `<span class="mono">${esc(d.mac)}</span>`], ['Site', esc(d.site)]])}
  <h3>Management</h3>${kv([['Agent version', esc(d.agentVersion)], ['Last check-in', d.online ? 'Online now' : fmtDate(d.lastSeen)], ['Enrolled', fmtDay(d.enrolled)], ['Department', esc(d.dept)], ['Primary user', esc(d.user || '—')], ['Tags', d.tags.map(t => `<span class="chip">${esc(t)}</span>`).join('') || '—']])}
  <h3>Security</h3>${kv([['Disk encryption', d.encrypted ? 'On' : '<span style="color:var(--bad)">Off</span>'], ['Antivirus real-time', d.avOn ? 'On' : '<span style="color:var(--bad)">Off</span>'], ['Firewall', d.fwOn ? 'On' : '<span style="color:var(--bad)">Off</span>'], ['Definitions age', `${d.defsAgeDays} day${d.defsAgeDays === 1 ? '' : 's'}`], ['Screen lock', d.screenLockMin ? `${d.screenLockMin} min` : 'Never'], ['USB storage', d.usbBlocked ? 'Blocked' : 'Allowed']])}</div>`;
}
function software(d) {
  const apps = d.installed.map(S.app).filter(Boolean);
  return `<div class="card table-card"><div class="table-scroll"><table class="data plain"><thead><tr><th>Application</th><th>Publisher</th><th>Version</th><th>Category</th></tr></thead><tbody>
    ${apps.map(a => `<tr><td><b>${esc(a.name)}</b></td><td>${esc(a.publisher)}</td><td class="mono">${esc(a.version)}</td><td>${esc(a.category)}</td></tr>`).join('') || '<tr><td class="empty" colspan="4">No managed applications detected.</td></tr>'}
  </tbody></table></div></div><p class="muted small" style="margin-top:8px">Shows applications in the Go-Green software library. A production agent also reports every entry in Add/Remove Programs.</p>`;
}
function updatesTab(d) {
  const row = (id, missing) => { const u = S.update(id); return `<tr><td><span class="mono">${esc(u.kb)}</span></td><td>${esc(u.title)}</td><td class="sev-${u.severity}">${u.severity}</td><td>${missing ? badge('Required', 'bad') : badge('Installed', 'good')}</td></tr>`; };
  return `<div class="card table-card"><div class="table-scroll"><table class="data plain"><thead><tr><th>ID</th><th>Update</th><th>Severity</th><th>State</th></tr></thead><tbody>
    ${d.missingUpdates.map(id => row(id, true)).join('')}${d.installedUpdates.map(id => row(id, false)).join('')}
    ${!d.missingUpdates.length && !d.installedUpdates.length ? '<tr><td class="empty" colspan="4">No applicable updates in the catalogue.</td></tr>' : ''}
  </tbody></table></div></div>`;
}
function complianceTab(d) {
  return S.state.baselines.map(b => {
    const c = S.compliance(d, b);
    return `<div class="card" style="margin-bottom:12px"><div class="card-title"><h3>${esc(b.name)}</h3>${badge(c.state)}</div><ul class="list">${b.rules.map(r => { const v = S.evalRule(d, r); return `<li><div class="grow">${esc(r.name)}<div class="sub">${r.severity}${r.remediable ? ' · auto-remediable' : ''}</div></div>${v === null ? badge('Not applicable', 'neutral') : v ? badge('Compliant') : badge('Non-compliant')}</li>`; }).join('')}</ul></div>`;
  }).join('');
}
function deploymentsTab(d) {
  const deps = S.state.deployments.filter(x => x.results[d.id]);
  const label = Object.fromEntries(S.STATUS.map(([k, l]) => [k, l]));
  return `<ul class="list card">${deps.map(x => { const s = x.results[d.id]; const err = x.errors[d.id]; return `<li><div class="grow"><a href="#/deployments/${x.id}"><b>${esc(x.name)}</b></a><div class="sub">${x.purpose} · ${fmtDay(x.created)}${err ? ` · <span class="mono">${err}</span> ${esc(S.ERRORS[err])}` : ''}</div></div>${badge(label[s], s === 'success' ? 'good' : s === 'error' ? 'bad' : s === 'inprogress' ? 'warn' : 'neutral')}</li>`; }).join('') || '<li class="muted">Not targeted by any deployment.</li>'}</ul>`;
}
function collectionsTab(d) {
  return `<ul class="list card">${S.deviceCollections(d).map(c => `<li><div class="grow"><a href="#/collections/${c.id}"><b>${esc(c.name)}</b></a><div class="sub">${esc(c.description || '')}</div></div><span class="muted small">${fmtN(S.members(c.id).length)} members</span></li>`).join('')}</ul>`;
}

export function scriptPicker(ids) {
  const m = modal('Run script', `<div class="form-grid"><label class="field wide">Script<select id="sc">${S.SCRIPTS.map(s => `<option value="${s.id}">${esc(s.name)} (${s.lang})</option>`).join('')}</select></label></div>
    <div class="console" id="body" style="margin-top:12px"></div><p class="muted small" style="margin-top:8px">Runs on ${ids.length} device${ids.length === 1 ? '' : 's'}. Scripts must be approved by a second admin before first use in production.</p><div id="out"></div>`,
  [{ label: 'Close' }, { label: 'Run', cls: 'primary', onClick: el => {
    const res = S.runScript(el.querySelector('#sc').value, ids);
    el.querySelector('#out').innerHTML = `<h3 style="margin:14px 0 8px">Results</h3>` + res.map(r => `<div style="margin-bottom:10px"><b>${esc(r.device)}</b> ${badge(r.status, r.status === 'Succeeded' ? 'good' : 'warn')}<div class="console" style="margin-top:6px">${esc(r.output)}</div></div>`).join('');
    return false;
  } }], { wide: true });
  const show = () => { m.el.querySelector('#body').textContent = S.SCRIPTS.find(s => s.id === m.el.querySelector('#sc').value).body; };
  m.el.querySelector('#sc').addEventListener('change', show);
  show();
}
