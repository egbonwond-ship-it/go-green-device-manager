import * as S from '../store.js';
import { esc, modal, toast, confirmBox, badge } from '../ui.js';
import { enrolHelp } from './devices.js';

const STORAGE = { supabase: 'Supabase', postgres: 'PostgreSQL', memory: 'memory only (lost on restart)' };

export default function settings(el) {
  el.innerHTML = `<div class="page-head"><div><h1>Administration</h1><p class="muted">Maintenance windows, sites, approved administrators and agent enrollment.</p></div>
    <div class="actions"><button class="btn primary" id="enrol">Enrol devices</button></div></div>
    <div class="card" style="margin-bottom:16px"><div class="card-title"><h3>Maintenance windows</h3><button class="btn sm primary" id="addmw">Add window</button></div><p class="small muted" style="margin-bottom:8px">Deployments that respect maintenance windows install only inside them, on devices in the window’s collection. Times are West Africa Time (WAT).</p><div id="mw"></div></div>
    <div class="grid g2"><div class="card"><div class="card-title"><h3>Sites & boundaries</h3><button class="btn sm" id="addsite">Add site</button></div><p class="small muted" style="margin-bottom:8px">A device belongs to the site whose IP range contains its address. Others show as “Unassigned”.</p><ul class="list" id="sites"></ul></div>
      <div class="stack"><div class="card stack"><h3>Approved local administrators</h3><p class="small muted">Accounts allowed in the local Administrators group (Windows) or admin/sudo groups (macOS/Linux). Any other member fails the “Local administrators” compliance rule and raises an alert when added. One per line; names match with or without a DOMAIN\\ prefix.</p>
        <textarea id="admins" rows="5" class="mono"></textarea><div><button class="btn sm primary" id="saveadm">Save list</button></div></div>
        <div class="card stack"><h3>Server</h3><div id="api" class="small"></div></div></div></div>`;
  const mw = () => {
    el.querySelector('#mw').innerHTML = `<div class="table-scroll"><table class="data plain"><thead><tr><th>Name</th><th>Collection</th><th>Days</th><th>Start (WAT)</th><th>Duration</th><th>Applies to</th><th></th></tr></thead><tbody>
      ${S.state.maintenanceWindows.map(m => `<tr><td><b>${esc(m.name)}</b></td><td>${esc(S.byId('collections', m.collectionId)?.name || '—')}</td><td>${esc(m.days)}</td><td>${esc(m.start)}</td><td>${m.hours} h</td><td>${esc(m.appliesTo)}</td><td class="row-actions"><button class="btn sm danger" data-del="${m.id}">Remove</button></td></tr>`).join('') || '<tr><td class="empty" colspan="7">No maintenance windows. Deployments install as soon as devices receive them.</td></tr>'}
    </tbody></table></div>`;
  };
  const sites = () => {
    el.querySelector('#sites').innerHTML = S.state.sites.map(s => `<li><div class="grow"><b>${esc(s.name)}</b> <span class="chip">${esc(s.code)}</span><div class="sub mono">${esc(s.subnets)}</div></div><span class="small muted">${S.state.devices.filter(d => d.site === s.name).length} devices</span><button class="btn sm danger" data-delsite="${s.id}">Remove</button></li>`).join('') || '<li class="muted">No sites yet.</li>';
  };
  const server = () => {
    const st = S.state;
    el.querySelector('#api').innerHTML = `<div class="kv"><div><span>API</span><b>${badge('Connected', 'good')} version ${esc(st.version)}</b></div><div><span>Database</span><b>${esc(STORAGE[st.storage] || st.storage)}</b></div>
      <div><span>Signed in as</span><b>${esc(st.user)}</b></div><div><span>Agent enrollment</span><b>${st.enrollmentConfigured ? badge('Ready', 'good') : badge('AGENT_ENROLL_TOKEN not set', 'bad')}</b></div>
      <div><span>Enrolled devices</span><b>${st.devices.length}</b></div><div><span>Console admins</span><b>Set by the ADMIN_USERS setting in Azure</b></div></div>`;
  };
  const admins = () => { const t = el.querySelector('#admins'); if (document.activeElement !== t) t.value = (S.state.settings.approvedAdmins || []).join('\n'); };
  const all = () => { mw(); sites(); server(); admins(); };
  all();
  el.querySelector('#enrol').addEventListener('click', enrolHelp);
  el.querySelector('#mw').addEventListener('click', e => { const b = e.target.closest('[data-del]'); if (b) { S.deleteMaintenanceWindow(b.dataset.del); mw(); } });
  el.querySelector('#sites').addEventListener('click', e => { const b = e.target.closest('[data-delsite]'); if (b) confirmBox('Remove site?', 'Its devices show as Unassigned. Collections that use this site name stop matching them.', 'Remove', () => S.deleteSite(b.dataset.delsite), true); });
  el.querySelector('#saveadm').addEventListener('click', () => {
    const list = [...new Set(el.querySelector('#admins').value.split(/\n|,/).map(s => s.trim()).filter(Boolean))];
    S.saveSettings({ approvedAdmins: list }, `Approved local administrators: ${list.join(', ') || 'none'}`); toast('Approved administrators saved');
  });
  el.querySelector('#addsite').addEventListener('click', () => modal('Add site', `<div class="form-grid">
      <label class="field">Name<input id="n" placeholder="Lagos HQ"></label><label class="field">Code<input id="c" placeholder="LAG" maxlength="8"></label>
      <label class="field wide">IP ranges (CIDR, comma separated)<input id="r" class="mono" placeholder="10.10.0.0/16, 192.168.1.0/24"></label></div>`,
  [{ label: 'Cancel' }, { label: 'Add', cls: 'primary', onClick: m => {
    const v = id => m.querySelector('#' + id).value.trim();
    const ranges = v('r').split(/[,\s]+/).filter(Boolean);
    if (!v('n') || !ranges.length) { toast('Give the site a name and at least one IP range.', true); return false; }
    if (ranges.some(r => !/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(r))) { toast('Write IP ranges like 10.10.0.0/16.', true); return false; }
    S.saveSite({ name: v('n'), code: (v('c') || v('n').slice(0, 3)).toUpperCase(), subnets: ranges.join(', ') }); toast('Site added');
  } }]));
  el.querySelector('#addmw').addEventListener('click', () => modal('Add maintenance window', `<div class="form-grid">
      <label class="field wide">Name<input id="n" placeholder="e.g. Servers · Sunday early"></label>
      <label class="field">Collection<select id="c">${S.state.collections.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      <label class="field">Days<select id="d"><option>Mon–Fri</option><option>Mon–Sat</option><option>Every day</option><option>Sat</option><option>Sun</option></select></label>
      <label class="field">Start (WAT)<input id="s" type="time" value="22:00"></label>
      <label class="field">Duration (hours)<input id="h" type="number" min="1" max="24" value="3"></label>
      <label class="field">Applies to<select id="a"><option>All deployments</option><option>Software updates only</option><option>Applications only</option></select></label></div>`,
  [{ label: 'Cancel' }, { label: 'Add', cls: 'primary', onClick: m => {
    const v = id => m.querySelector('#' + id).value;
    if (!v('n').trim()) { toast('Name the window.', true); return false; }
    S.addMaintenanceWindow({ name: v('n').trim(), collectionId: v('c'), days: v('d'), start: v('s'), hours: Math.min(24, Math.max(1, +v('h') || 1)), appliesTo: v('a') }); mw(); toast('Maintenance window added');
  } }]));
  return { refresh: all };
}
