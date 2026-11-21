import * as S from '../store.js';
import { esc, downloadCsv, fmtDay, ago } from '../ui.js';

const REPORTS = [
  { id: 'crit', name: 'Devices missing critical updates', desc: 'Every device with at least one critical update outstanding.',
    head: ['Device', 'User', 'Site', 'OS', 'Missing critical', 'Last seen'],
    rows: () => S.state.devices.filter(d => d.missingUpdates.some(id => S.update(id).severity === 'Critical')).map(d => [d.name, d.user || '', d.site, d.os, d.missingUpdates.filter(id => S.update(id).severity === 'Critical').map(id => S.update(id).kb).join(' '), d.online ? 'Online' : ago(d.lastSeen)]) },
  { id: 'notscanned', name: 'Devices without an update scan', desc: 'Devices whose agent hasn’t reported an update scan in the last 2 days.',
    head: ['Device', 'Site', 'OS', 'Last scan', 'Last seen'],
    rows: () => S.state.devices.filter(d => !d.updatesScannedAt || Date.now() - d.updatesScannedAt > 2 * 86400000).map(d => [d.name, d.site, d.os, d.updatesScannedAt ? ago(d.updatesScannedAt) : 'Never', d.online ? 'Online' : ago(d.lastSeen)]) },
  { id: 'nc', name: 'Non-compliant devices by baseline', desc: 'Failing rules per device for every baseline.',
    head: ['Device', 'Site', 'Baseline', 'Failing rules'],
    rows: () => S.state.devices.flatMap(d => S.state.baselines.map(b => [d, b, S.compliance(d, b)]).filter(([, , c]) => c.state === 'Non-compliant').map(([d, b, c]) => [d.name, d.site, b.name, c.failing.map(r => r.name).join('; ')])) },
  { id: 'sw', name: 'Software inventory', desc: 'How many devices have each library application installed.',
    head: ['Application', 'Version', 'Publisher', 'Installed on', 'Windows', 'macOS', 'Linux'],
    rows: () => S.state.apps.map(a => { const ds = S.state.devices.filter(d => d.installed.includes(a.id)); return [a.name, a.version, a.publisher, ds.length, ds.filter(d => d.platform === 'Windows').length, ds.filter(d => d.platform === 'macOS').length, ds.filter(d => d.platform === 'Linux').length]; }).sort((a, b) => b[3] - a[3]) },
  { id: 'dep', name: 'Deployment summary', desc: 'Success, error and in-progress counts for every deployment.',
    head: ['Deployment', 'Action', 'Created', 'Targeted', 'Success', 'In progress', 'Error', 'Requirements not met', 'Unknown', 'Success %'],
    rows: () => S.state.deployments.map(d => { const s = S.deploymentSummary(d); return [d.name, d.kind === 'app' ? d.action : 'Install updates', fmtDay(d.created), s.total, s.success, s.inprogress, s.error, s.reqnotmet, s.unknown, s.pct + '%']; }) },
  { id: 'hw', name: 'Hardware inventory', desc: 'Manufacturer, model, CPU, memory and storage of every device.',
    head: ['Device', 'Type', 'Manufacturer', 'Model', 'Serial', 'CPU', 'RAM GB', 'Disk GB', 'Disk free %'],
    rows: () => S.state.devices.map(d => [d.name, d.type, d.manufacturer, d.model, d.serial, d.cpu, d.ramGB, d.diskGB, d.diskFreePct]) },
  { id: 'lowmem', name: 'Hardware refresh candidates', desc: 'Workstations with 8 GB RAM or under 10% free disk.',
    head: ['Device', 'User', 'Model', 'RAM GB', 'Disk free %'],
    rows: () => S.state.devices.filter(d => (d.type === 'Laptop' || d.type === 'Desktop') && ((d.ramGB != null && d.ramGB <= 8) || (d.diskFreePct != null && d.diskFreePct < 10))).map(d => [d.name, d.user || '', d.model, d.ramGB, d.diskFreePct]) },
  { id: 'inactive', name: 'Inactive and unhealthy clients', desc: 'Devices that stopped reporting or whose agent needs repair.',
    head: ['Device', 'Site', 'Client health', 'Last seen', 'Agent version', 'Agent problems'],
    rows: () => S.state.devices.filter(d => d.health !== 'Healthy').map(d => [d.name, d.site, d.health, ago(d.lastSeen), d.agentVersion, d.agentErrors.join('; ')]) },
  { id: 'win10', name: 'Windows 11 upgrade readiness', desc: 'Windows 10 devices (out of support since October 2025) and whether they have at least 8 GB of memory. Also check TPM 2.0 and CPU support.',
    head: ['Device', 'User', 'Model', 'RAM GB', 'Ready'],
    rows: () => S.state.devices.filter(d => d.osFamily === 'win10').map(d => [d.name, d.user || '', d.model, d.ramGB, d.ramGB >= 8 ? 'Yes' : 'No']) },
];

export default function reports(el, { params }) {
  const r = REPORTS.find(x => x.id === params.r);
  if (!r) {
    el.innerHTML = `<div class="page-head"><div><h1>Reports</h1><p class="muted">Ready-made reports on patching, compliance, software and hardware. Each one exports to CSV for Excel or Power BI.</p></div></div>
      <div class="grid g3">${REPORTS.map(x => `<a class="card" href="#/reports?r=${x.id}"><h3>${esc(x.name)}</h3><p class="small muted" style="margin-top:6px">${esc(x.desc)}</p><div class="small" style="margin-top:8px"><b>${x.rows().length}</b> rows</div></a>`).join('')}</div>`;
    return;
  }
  const draw = () => {
    const rows = r.rows();
    el.innerHTML = `<div class="page-head"><div><a class="small" href="#/reports">← Reports</a><h1>${esc(r.name)}</h1><p class="muted">${esc(r.desc)} Generated ${new Date().toLocaleString('en-GB')}.</p></div>
      <div class="actions"><button class="btn primary" id="csv">Export CSV</button></div></div>
      <div class="card table-card"><div class="table-scroll"><table class="data plain"><thead><tr>${r.head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.slice(0, 500).map(row => `<tr>${row.map(c => `<td class="${typeof c === 'number' ? 'num' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('') || `<tr><td class="empty" colspan="${r.head.length}">No rows.</td></tr>`}</tbody></table></div>
      <div class="table-tools" style="border-top:1px solid var(--line);border-bottom:0"><span class="small muted">${rows.length} rows${rows.length > 500 ? ' (first 500 shown; the CSV has all)' : ''}</span></div></div>`;
    el.querySelector('#csv').addEventListener('click', () => downloadCsv(`ggt-${r.id}-${new Date().toISOString().slice(0, 10)}.csv`, r.head, r.rows()));
  };
  draw();
}
