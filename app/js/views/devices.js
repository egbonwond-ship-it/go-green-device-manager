import * as S from '../store.js';
import { windowsSetup, unixSetup, saveFile } from '../agent-setup.js';
import { esc, fmtN, ago, fmtDate, fmtDay, badge, table, drawer, modal, toast, meter, statusDot, ICON, downloadCsv, confirmBox } from '../ui.js';

const FILTERS = [
  ['site', 'All sites', d => d.site],
  ['os', 'All operating systems', d => d.os],
  ['type', 'All device types', d => d.type],
  ['health', 'Any client health', d => d.health],
  ['comp', 'Any compliance', d => S.deviceCompliant(d)],
];
const dash = '<span class="muted">—</span>';
const val = (v, fmt = x => esc(x)) => (v == null || v === '' ? dash : fmt(v));
const onOff = (v, on = 'On', off = 'Off') => (v == null ? '<span class="muted">Not reported</span>' : v ? on : `<span style="color:var(--bad)">${off}</span>`);

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
    empty: S.state.devices.length ? 'No devices match these filters.' : 'No devices yet. Select “Enrol devices” to install the agent.',
    cols: [
      { key: 'name', label: 'Device', render: d => `<span class="person">${statusDot(d)}<b>${esc(d.name)}</b></span>` },
      { key: 'user', label: 'Primary user', render: d => d.user ? esc(d.user) : dash },
      { key: 'os', label: 'Operating system' },
      { key: 'site', label: 'Site' },
      { key: 'type', label: 'Type' },
      { key: 'lastSeen', label: 'Last seen', render: d => d.online ? '<span style="color:var(--good)">Online</span>' : ago(d.lastSeen), sort: d => d.online ? Infinity : d.lastSeen },
      { key: 'comp', label: 'Compliance', render: d => badge(S.deviceCompliant(d)), sort: d => S.deviceCompliant(d) },
      { key: 'missing', label: 'Missing updates', num: true, render: d => d.updatesScannedAt ? (d.missingUpdates.length || '<span class="muted">0</span>') : '<span class="muted small">not scanned</span>', sort: d => d.missingUpdates.length },
    ],
  });
  if (params.q) { const i = el.querySelector('input[type=search]'); i.value = params.q; i.dispatchEvent(new Event('input')); }
  el.querySelectorAll('[data-f]').forEach(s => s.addEventListener('change', () => { f[s.dataset.f] = s.value; t.draw(); }));
  el.querySelector('#csv').addEventListener('click', () => downloadCsv('ggt-devices.csv',
    ['Name', 'User', 'Site', 'Type', 'OS', 'Build', 'Manufacturer', 'Model', 'Serial', 'CPU', 'RAM GB', 'Disk GB', 'Disk free %', 'IP', 'MAC', 'Online', 'Last seen', 'Client health', 'Compliance', 'Missing updates', 'Agent version', 'Tags'],
    rows().map(d => [d.name, d.user, d.site, d.type, d.os, d.build, d.manufacturer, d.model, d.serial, d.cpu, d.ramGB, d.diskGB, d.diskFreePct, d.ip, d.mac, d.online ? 'Yes' : 'No', new Date(d.lastSeen).toISOString(), d.health, S.deviceCompliant(d), d.missingUpdates.length, d.agentVersion, d.tags.join(' ')])));
  el.querySelector('#enrol').addEventListener('click', enrolHelp);
  if (params.enrol) enrolHelp();
  return { refresh: () => t.draw() };
}

export async function enrolHelp() {
  const origin = location.origin;
  const m = modal('Enrol devices', '<p class="muted">Loading the enrollment token…</p>', [{ label: 'Close', cls: 'primary' }], { wide: true });
  let token = null;
  try { token = (await S.enrollment()).token; } catch (e) { toast(e.message, true); }
  const tok = token ? esc(token) : '&lt;AGENT_ENROLL_TOKEN&gt;';
  const winCmd = `Invoke-WebRequest ${origin}/agent/ggt-agent.ps1 -OutFile $env:TEMP\\ggt-agent.ps1 -UseBasicParsing; powershell -ExecutionPolicy Bypass -File $env:TEMP\\ggt-agent.ps1 -Install -Server ${origin} -Token '${token || '<AGENT_ENROLL_TOKEN>'}'`;
  const nixCmd = `curl -fsSL ${origin}/agent/ggt-agent.py -o /tmp/ggt-agent.py && sudo python3 /tmp/ggt-agent.py install --server ${origin} --token '${token || '<AGENT_ENROLL_TOKEN>'}'`;
  const dl = (id, label) => token ? `<button class="btn primary" id="${id}">${label}</button>` : '';
  m.el.querySelector('.modal-body').innerHTML = `<p>Install the GO-Green agent on each computer. It checks in every 5 minutes, sends its inventory, installs what you deploy, applies updates and runs your scripts. The device appears here after its first check-in.</p>
    ${token ? '' : '<div class="notice" style="margin:10px 0">The server has no <span class="mono">AGENT_ENROLL_TOKEN</span> setting, so agents can’t enrol yet. Add it under the Static Web App’s Environment variables.</div>'}
    <h3 style="margin:14px 0 6px">Windows 10, 11 and Server 2016 or later</h3>
    <div class="actions" style="margin:6px 0">${dl('dl-win', 'Download Windows setup')}</div>
    <p class="small muted">Double-click <span class="mono">GoGreenAgentSetup.cmd</span> and select Yes at the administrator prompt. If SmartScreen warns about it, choose More info, then Run anyway. It installs to <span class="mono">C:\\ProgramData\\GGT Agent</span> and runs as SYSTEM from a scheduled task.</p>
    <p class="small muted" style="margin-top:6px">Or paste this into PowerShell opened as administrator. For many PCs, run it from Intune (platform script), a GPO startup script or your RMM tool.</p>
    <div class="console">${esc(winCmd)}</div><div class="actions" style="margin-top:6px"><button class="btn" id="cp-win">Copy command</button></div>
    <h3 style="margin:14px 0 6px">macOS and Linux</h3>
    <div class="actions" style="margin:6px 0">${dl('dl-nix', 'Download macOS / Linux setup')}</div>
    <p class="small muted">Then in Terminal run <span class="mono">sudo sh ~/Downloads/go-green-agent-setup.sh</span> and enter your password. Needs Python 3 (built into most Linux; on macOS the setup tells you how to add it). Runs as root from launchd or a systemd timer.</p>
    <p class="small muted" style="margin-top:6px">Or run this in Terminal:</p>
    <div class="console">${esc(nixCmd)}</div><div class="actions" style="margin-top:6px"><button class="btn" id="cp-nix">Copy command</button></div>
    <p class="small muted" style="margin-top:12px">The setup files and commands contain the enrollment token. Keep them private: anyone with it can enrol a device. To change it, set a new <span class="mono">AGENT_ENROLL_TOKEN</span> and reinstall the agents. To remove the agent, run the script with <span class="mono">-Uninstall</span> or <span class="mono">uninstall</span>.</p>`;
  const on = (id, fn) => m.el.querySelector('#' + id)?.addEventListener('click', fn);
  on('dl-win', () => saveFile('GoGreenAgentSetup.cmd', windowsSetup(origin, token)));
  on('dl-nix', () => saveFile('go-green-agent-setup.sh', unixSetup(origin, token)));
  const copy = text => navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Couldn’t copy. Select the text instead.', true));
  on('cp-win', () => copy(winCmd));
  on('cp-nix', () => copy(nixCmd));
}

const TABS = ['Summary', 'Software', 'Updates', 'Compliance', 'Deployments', 'Collections'];
export function openDevice(id) {
  let tab = 'Summary';
  let detail = null;
  const d0 = S.device(id);
  if (!d0) return;
  const dr = drawer(`<span class="dev-icon">${ICON[d0.type] || ICON.Desktop}</span><div class="grow" id="dh"></div>`, '');
  const head = () => {
    const d = S.device(id);
    if (!d) { dr.close(); return; }
    dr.el.querySelector('#dh').innerHTML = `<h2>${esc(d.name)}</h2><div class="muted small">${esc(d.os)} · ${esc([d.manufacturer, d.model].filter(Boolean).join(' ') || d.type)} · ${esc(d.site)}${d.user ? ` · ${esc(d.user)}` : ''}</div>
      <div style="margin-top:6px">${d.online ? badge('Online') : badge(d.health === 'Inactive' ? 'Inactive' : 'Offline')} ${badge(d.health)} ${badge(S.deviceCompliant(d))} ${d.pendingRebootSince ? badge('Restart pending', 'warn') : ''}</div>
      <div class="actions-row">
        <button class="btn sm" data-a="inventory">Refresh inventory</button><button class="btn sm" data-a="updscan">Scan for updates</button>
        <button class="btn sm" data-a="script">Run script…</button><button class="btn sm" data-a="tags">Tags…</button>
        <button class="btn sm danger" data-a="restart">Restart…</button><button class="btn sm danger" data-a="retire">Retire…</button>
      </div>
      <div class="tabs" style="margin:14px 0 -17px">${TABS.map(t => `<button data-t="${t}" aria-selected="${t === tab}">${t}</button>`).join('')}</div>`;
  };
  const body = () => {
    const d = S.device(id);
    if (!d) return;
    if (tab === 'Software') { dr.body.innerHTML = software(d, detail); if (!detail) S.deviceDetail(id).then(r => { detail = r; if (tab === 'Software') body(); }).catch(e => toast(e.message, true)); wireSoftware(); return; }
    const sec = { Summary: summary, Updates: updatesTab, Compliance: complianceTab, Deployments: deploymentsTab, Collections: collectionsTab }[tab];
    dr.body.innerHTML = sec(d);
  };
  const wireSoftware = () => {
    const q = dr.body.querySelector('#swq');
    q?.addEventListener('input', () => { const v = q.value.toLowerCase(); dr.body.querySelectorAll('tbody tr[data-n]').forEach(tr => { tr.style.display = tr.dataset.n.includes(v) ? '' : 'none'; }); });
  };
  const render = () => { head(); body(); };
  dr.head.addEventListener('click', e => {
    const t = e.target.closest('[data-t]');
    if (t) { tab = t.dataset.t; render(); return; }
    const a = e.target.closest('[data-a]');
    if (!a) return;
    const d = S.device(id);
    const act = a.dataset.a;
    if (act === 'script') return scriptPicker([id]);
    if (act === 'tags') return tagEditor(d);
    if (act === 'retire') return confirmBox(`Retire ${esc(d.name)}?`, 'Removes the device and its history from the console. If its agent is still installed it enrols again at its next check-in, so uninstall the agent first.', 'Retire', () => { S.retireDevice(id).then(() => { dr.close(); toast(`${d.name} retired`); }).catch(() => {}); }, true);
    if (act === 'restart') return modal(`Restart ${d.name}?`, `<p>${d.platform === 'Windows' ? 'Signed-in users get a 5-minute warning, then Windows restarts.' : 'The device restarts in 5 minutes.'} It happens at the device’s next check-in (within about 5 minutes if it’s online).</p>`, [{ label: 'Cancel' }, { label: 'Restart', cls: 'primary danger', onClick: () => { S.deviceAction(id, 'restart').then(() => toast(`Restart queued for ${d.name}`)).catch(() => {}); } }]);
    S.deviceAction(id, act).then(() => toast(`${a.textContent} queued. ${d.name} runs it at its next check-in.`)).catch(() => {});
  });
  render();
  const off = S.subscribe(() => { if (!document.body.contains(dr.el)) return off(); head(); if (tab !== 'Software') body(); });
}

function tagEditor(d) {
  modal(`Tags for ${d.name}`, `<label class="field">Tags (comma separated)<input id="tg" value="${esc(d.tags.join(', '))}" placeholder="pilot, field, finance"></label>
    <p class="small muted" style="margin-top:8px">Use tags in collection rules, for example a “Pilot” ring of devices tagged <span class="mono">pilot</span>.</p>`,
  [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: m => {
    const tags = [...new Set(m.querySelector('#tg').value.split(',').map(t => t.trim().toLowerCase()).filter(Boolean))];
    S.setTags(d.id, tags).then(() => toast('Tags saved'));
  } }]);
}

function kv(pairs) { return `<div class="kv">${pairs.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>`; }
function summary(d) {
  const used = d.diskGB != null && d.diskFreePct != null ? d.diskGB * (100 - d.diskFreePct) / 100 : null;
  const pctCard = (label, v) => `<div class="card"><div class="stat-label">${label}</div><div class="stat-value" style="font-size:20px">${d.online && v != null ? v + '%' : '—'}</div>${meter(d.online && v != null ? v : 0)}</div>`;
  return `${d.agentErrors.length ? `<div class="notice" style="margin-bottom:12px"><b>Agent problems at last check-in:</b><br>${d.agentErrors.map(esc).join('<br>')}</div>` : ''}
  <div class="grid g3" style="margin-bottom:16px">${pctCard('CPU', d.cpuPct)}${pctCard('Memory', d.memPct)}
    <div class="card"><div class="stat-label">System drive</div><div class="stat-value" style="font-size:20px">${d.diskFreePct != null ? d.diskFreePct + '% free' : '—'}</div>${meter(d.diskFreePct != null ? 100 - d.diskFreePct : 0)}<div class="small muted">${used != null ? `${used.toFixed(0)} of ${d.diskGB} GB used` : ''}</div></div></div>
  <div class="card stack"><h3>Hardware</h3>${kv([['Manufacturer', val(d.manufacturer)], ['Model', val(d.model)], ['Serial number', val(d.serial, v => `<span class="mono">${esc(v)}</span>`)], ['Processor', val(d.cpu)], ['Memory', val(d.ramGB, v => `${v} GB`)], ['Storage', val(d.diskGB, v => `${v} GB`)]])}
  <h3>Operating system & network</h3>${kv([['OS', esc(d.os)], ['Build', val(d.build)], ['Last boot', val(d.lastBoot, fmtDate)], ['IP address', val(d.ip, v => `<span class="mono">${esc(v)}</span>`)], ['MAC address', val(d.mac, v => `<span class="mono">${esc(v)}</span>`)], ['Site', esc(d.site)]])}
  <h3>Management</h3>${kv([['Agent version', val(d.agentVersion)], ['Last check-in', d.online ? `Online (${ago(d.lastSeen)})` : fmtDate(d.lastSeen)], ['Enrolled', val(d.enrolled, fmtDay)], ['Primary user', val(d.user)], ['Tags', d.tags.map(t => `<span class="chip">${esc(t)}</span>`).join('') || '—'], ['Update scan', d.updatesScannedAt ? ago(d.updatesScannedAt) : 'Not yet']])}
  <h3>Security</h3>${kv([['Disk encryption', onOff(d.encrypted)], ['Antivirus real-time', onOff(d.avOn)], ['Firewall', onOff(d.fwOn)], ['Definitions age', d.defsAgeDays == null ? '<span class="muted">Not reported</span>' : `${d.defsAgeDays} day${d.defsAgeDays === 1 ? '' : 's'}`], ['Screen lock', d.screenLockMin == null ? '<span class="muted">Not reported</span>' : d.screenLockMin ? `${d.screenLockMin} min` : '<span style="color:var(--bad)">Not set</span>'], ['USB storage', onOff(d.usbBlocked, 'Blocked', 'Allowed')],
    ['Local administrators', d.localAdmins ? d.localAdmins.map(a => `<span class="chip" ${d.unapprovedAdmins.includes(a) ? 'style="border-color:var(--bad);color:var(--bad)" title="Not in the approved list"' : ''}>${esc(a)}</span>`).join('') || '—' : '<span class="muted">Not reported</span>']])}</div>`;
}
function software(d, detail) {
  const managed = d.installed.map(S.app).filter(Boolean);
  const all = detail?.device?.software;
  return `<div class="card" style="margin-bottom:12px"><h3 style="margin-bottom:8px">From the software library</h3><ul class="list">${managed.map(a => `<li><b class="grow">${esc(a.name)}</b><span class="small muted">${esc(a.publisher || '')}</span></li>`).join('') || '<li class="muted">No library applications detected.</li>'}</ul></div>
  <div class="card table-card"><div class="table-tools"><input type="search" id="swq" placeholder="Search ${all ? fmtN(all.length) : ''} installed programs…" aria-label="Search software"><span class="small muted">${d.softwareAt ? `Inventory ${ago(d.softwareAt)}` : ''}</span></div><div class="table-scroll"><table class="data plain"><thead><tr><th>Program</th><th>Publisher</th><th>Version</th></tr></thead><tbody>
    ${all ? (all.slice().sort((a, b) => a.name.localeCompare(b.name)).map(s => `<tr data-n="${esc(s.name.toLowerCase())}"><td>${esc(s.name)}</td><td>${esc(s.publisher || '')}</td><td class="mono">${esc(s.version || '')}</td></tr>`).join('') || '<tr><td class="empty" colspan="3">No software reported yet.</td></tr>') : '<tr><td class="empty" colspan="3">Loading…</td></tr>'}
  </tbody></table></div></div>`;
}
function updatesTab(d) {
  if (!d.updatesScannedAt) return '<div class="card"><p class="muted">This device hasn’t finished an update scan yet. Use “Scan for updates”, or wait for the agent’s next scan (every 6 hours).</p></div>';
  const row = (id, missing) => { const u = S.update(id); return `<tr><td><span class="mono">${esc(u.kb)}</span></td><td>${esc(u.title)}<div class="small muted">${esc(u.classification)}</div></td><td class="sev-${u.severity}">${u.severity}</td><td>${missing ? badge('Required', 'bad') : badge('Installed', 'good')}</td></tr>`; };
  return `<p class="small muted" style="margin-bottom:8px">Last scan ${ago(d.updatesScannedAt)}.</p><div class="card table-card"><div class="table-scroll"><table class="data plain"><thead><tr><th>ID</th><th>Update</th><th>Severity</th><th>State</th></tr></thead><tbody>
    ${d.missingUpdates.map(id => row(id, true)).join('')}${d.installedUpdates.map(id => row(id, false)).join('')}
    ${!d.missingUpdates.length && !d.installedUpdates.length ? '<tr><td class="empty" colspan="4">No updates reported.</td></tr>' : ''}
  </tbody></table></div></div>`;
}
function complianceTab(d) {
  return S.state.baselines.map(b => {
    const c = S.compliance(d, b);
    return `<div class="card" style="margin-bottom:12px"><div class="card-title"><h3>${esc(b.name)}</h3>${badge(c.state)}</div><ul class="list">${b.rules.map(r => { const v = S.evalRule(d, r); return `<li><div class="grow">${esc(r.name)}<div class="sub">${r.severity}${r.remediable ? ' · agent can fix' : ''}</div></div>${v === null ? badge('Not applicable', 'neutral') : v ? badge('Compliant') : badge('Non-compliant')}</li>`; }).join('')}</ul></div>`;
  }).join('');
}
function deploymentsTab(d) {
  const deps = S.state.deployments.filter(x => x.results?.[d.id]);
  const label = Object.fromEntries(S.STATUS.map(([k, l]) => [k, l]));
  return `<ul class="list card">${deps.map(x => { const s = x.results[d.id]; const err = x.errors[d.id]; const msg = x.messages[d.id]; return `<li><div class="grow"><a href="#/deployments/${x.id}"><b>${esc(x.name)}</b></a><div class="sub">${fmtDay(x.created)}${err ? ` · <span class="mono">${esc(err)}</span> ${esc(S.ERRORS[err] || '')}` : ''}${msg ? ` · ${esc(msg)}` : ''}</div></div>${badge(label[s], s === 'success' ? 'good' : s === 'error' ? 'bad' : s === 'inprogress' ? 'warn' : 'neutral')}</li>`; }).join('') || '<li class="muted">Not targeted by any deployment.</li>'}</ul>`;
}
function collectionsTab(d) {
  return `<ul class="list card">${S.deviceCollections(d).map(c => `<li><div class="grow"><a href="#/collections/${c.id}"><b>${esc(c.name)}</b></a><div class="sub">${esc(c.description || '')}</div></div><span class="muted small">${fmtN(S.members(c.id).length)} members</span></li>`).join('')}</ul>`;
}

const CMD_BADGE = { queued: ['Waiting for check-in', 'neutral'], sent: ['Running', 'warn'], succeeded: ['Succeeded', 'good'], failed: ['Failed', 'bad'], skipped: ['Not run', 'neutral'] };
export function scriptPicker(ids) {
  if (!S.state.scripts.length) { toast('Add a script on the Run scripts page first.', true); return; }
  let runId = null, timer = null;
  const m = modal('Run script', `<div class="form-grid"><label class="field wide">Script<select id="sc">${S.state.scripts.map(s => `<option value="${s.id}">${esc(s.name)} (${s.lang === 'PowerShell' ? 'Windows' : 'macOS/Linux'})</option>`).join('')}</select></label></div>
    <div class="console" id="body" style="margin-top:12px"></div><p class="muted small" style="margin-top:8px">Runs as SYSTEM (Windows) or root (macOS/Linux) on ${ids.length} device${ids.length === 1 ? '' : 's'} at each one’s next check-in, usually within 5 minutes. Output appears below.</p><div id="out"></div>`,
  [{ label: 'Close', onClick: () => { clearInterval(timer); } }, { label: 'Run', cls: 'primary', onClick: el => {
    const btn = el.querySelector('.modal-foot .btn.primary');
    btn.disabled = true;
    S.runScript(el.querySelector('#sc').value, ids).then(r => {
      runId = r.runId; btn.textContent = 'Sent'; draw();
      timer = setInterval(() => { if (!document.body.contains(el)) return clearInterval(timer); S.refresh().then(draw); }, 5000);
    }).catch(() => { btn.disabled = false; });
    return false;
  } }], { wide: true });
  const draw = () => {
    const cmds = S.runCommands(runId);
    m.el.querySelector('#out').innerHTML = `<h3 style="margin:14px 0 8px">Results</h3>` + (cmds.map(c => { const [l, k] = CMD_BADGE[c.status] || [c.status, 'neutral']; return `<div style="margin-bottom:10px"><b>${esc(c.deviceName)}</b> ${badge(l, k)}${c.exitCode != null ? ` <span class="small muted">exit code ${c.exitCode}</span>` : ''}${c.output ? `<div class="console" style="margin-top:6px;max-height:260px">${esc(c.output)}</div>` : ''}</div>`; }).join('') || '<p class="muted small">Sending…</p>');
  };
  const show = () => { m.el.querySelector('#body').textContent = S.state.scripts.find(s => s.id === m.el.querySelector('#sc').value).body; };
  m.el.querySelector('#sc').addEventListener('change', show);
  show();
}
