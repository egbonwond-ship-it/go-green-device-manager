import * as S from '../store.js';
import { esc, modal, toast, confirmBox, badge } from '../ui.js';
import { SITES } from '../seed.js';

export default function settings(el) {
  el.innerHTML = `<div class="page-head"><div><h1>Administration</h1><p class="muted">Maintenance windows, sites and distribution points, and the demo environment.</p></div></div>
    <div class="card" style="margin-bottom:16px"><div class="card-title"><h3>Maintenance windows</h3><button class="btn sm primary" id="addmw">Add window</button></div><div id="mw"></div></div>
    <div class="grid g2"><div class="card"><h3 style="margin-bottom:10px">Sites & boundaries</h3><ul class="list">${SITES.map(s => `<li><div class="grow"><b>${s.name}</b><div class="sub">Boundary <span class="mono">${s.subnet}.0.0/16</span> · distribution point <span class="mono">${s.dp}</span></div></div><span class="small muted">${S.state.devices.filter(d => d.siteCode === s.code).length} devices</span></li>`).join('')}</ul></div>
      <div class="card stack"><h3>Demo environment</h3>
        <p class="small">This console runs on a simulated estate of ${S.state.devices.length} devices. Agents check in every few seconds, deployments progress, settings drift and alerts fire, so you can try every feature. Your changes are saved in this browser only.</p>
        <label class="small"><input type="checkbox" id="sim" ${S.state.settings.simulate ? 'checked' : ''}> Run live simulation</label>
        <div><button class="btn danger" id="reset">Reset demo data</button></div>
        <h3>Backend API</h3><div id="api" class="small muted">Checking /api/health…</div></div></div>`;
  const mw = () => {
    el.querySelector('#mw').innerHTML = `<div class="table-scroll"><table class="data plain"><thead><tr><th>Name</th><th>Collection</th><th>Days</th><th>Start (WAT)</th><th>Duration</th><th>Applies to</th><th></th></tr></thead><tbody>
      ${S.state.maintenanceWindows.map(m => `<tr><td><b>${esc(m.name)}</b></td><td>${esc(S.byId('collections', m.collectionId)?.name || '—')}</td><td>${esc(m.days)}</td><td>${esc(m.start)}</td><td>${m.hours} h</td><td>${esc(m.appliesTo)}</td><td class="row-actions"><button class="btn sm danger" data-del="${m.id}">Remove</button></td></tr>`).join('') || '<tr><td class="empty" colspan="7">No maintenance windows. Required deployments install as soon as they are due.</td></tr>'}
    </tbody></table></div>`;
  };
  mw();
  el.querySelector('#mw').addEventListener('click', e => { const b = e.target.closest('[data-del]'); if (b) { S.deleteMaintenanceWindow(b.dataset.del); mw(); } });
  el.querySelector('#addmw').addEventListener('click', () => modal('Add maintenance window', `<div class="form-grid">
      <label class="field wide">Name<input id="n" placeholder="e.g. Abuja servers · Saturday"></label>
      <label class="field">Collection<select id="c">${S.state.collections.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      <label class="field">Days<select id="d"><option>Mon–Fri</option><option>Mon–Sat</option><option>Every day</option><option>Sat</option><option>Sun</option></select></label>
      <label class="field">Start<input id="s" type="time" value="22:00"></label>
      <label class="field">Duration (hours)<input id="h" type="number" min="1" max="24" value="3"></label>
      <label class="field">Applies to<select id="a"><option>All deployments</option><option>Software updates only</option><option>Task sequences only</option></select></label></div>`,
  [{ label: 'Cancel' }, { label: 'Add', cls: 'primary', onClick: m => {
    const v = id => m.querySelector('#' + id).value;
    if (!v('n').trim()) { toast('Name the window.', true); return false; }
    S.addMaintenanceWindow({ name: v('n'), collectionId: v('c'), days: v('d'), start: v('s'), hours: +v('h') || 1, appliesTo: v('a') }); mw(); toast('Maintenance window added');
  } }]));
  el.querySelector('#sim').addEventListener('change', e => { S.state.settings.simulate = e.target.checked; S.save(); S.emit(); });
  el.querySelector('#reset').addEventListener('click', () => confirmBox('Reset demo data?', 'This regenerates the demo estate and removes every deployment, collection and change you made in this browser.', 'Reset', () => { S.reset(); toast('Demo data reset'); location.hash = '#/overview'; }, true));
  fetch('/api/health').then(r => r.ok ? r.json() : Promise.reject(r.status)).then(j => {
    const where = { 'azure-sql': 'saved in Azure SQL Database', cosmos: 'saved in Azure Cosmos DB' }[j.storage] || 'kept in memory only (lost on restart)';
    el.querySelector('#api').innerHTML = `${badge('Connected', 'good')} Azure Functions API ${esc(j.version)} · ${esc(j.devicesKnown ?? 0)} enrolled agent${j.devicesKnown === 1 ? '' : 's'}, ${where}. The console screens still show the simulated estate.`;
  }).catch(() => { el.querySelector('#api').innerHTML = `${badge('Not deployed', 'neutral')} The API runs when the app is deployed to Azure Static Web Apps or started with <span class="mono">swa start</span>.`; });
}
