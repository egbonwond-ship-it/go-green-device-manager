import * as S from '../store.js';
import { esc, fmtN, table, modal, toast, badge, fmtDay, fmtDate, size, drawer, statusDot, confirmBox } from '../ui.js';
import { openDevice } from './devices.js';

const CLASSES = ['Security Updates', 'Critical Updates', 'Definition Updates', 'Update Rollups', 'Updates', 'Feature Packs', 'Drivers', 'Upgrades', 'macOS', 'Linux packages'];
const SEVS = ['Critical', 'Important', 'Moderate', 'Low'];

export default function updates(el, { params }) {
  let tab = params.tab || 'all';
  const TABS = [['all', 'All updates'], ['groups', 'Update groups'], ['adr', 'Automatic deployment rules']];
  el.innerHTML = `<div class="page-head"><div><h1>Software updates</h1><p class="muted">Windows, macOS and Linux updates each device’s agent found when it scanned: what each device needs, grouped and deployed in rings.</p></div>
    <div class="actions"><button class="btn" id="adrnew">New automatic rule</button><button class="btn primary" id="grp">Create update group</button></div></div>
    <div class="stats" id="st"></div><div class="tabs">${TABS.map(([k, l]) => `<button data-tab="${k}" aria-selected="${k === tab}">${l}</button>`).join('')}</div><div id="body"></div>`;
  let sel = new Set();
  let cur = null;
  const stats = () => {
    const devs = S.state.devices.filter(d => d.updatesScannedAt);
    const needCrit = devs.filter(d => d.missingUpdates.some(id => S.update(id).severity === 'Critical')).length;
    const full = devs.filter(d => !d.missingUpdates.length).length;
    const reboot = S.state.devices.filter(d => d.pendingRebootSince).length;
    const required = S.updateList().reduce((n, u) => n + S.updateStats(u).required, 0);
    el.querySelector('#st').innerHTML = `
      <div class="stat"><div class="stat-label">Fully patched devices</div><div class="stat-value">${devs.length ? Math.round(full / devs.length * 100) + '%' : '—'}</div><div class="stat-sub">${fmtN(full)} of ${fmtN(devs.length)} scanned</div></div>
      <div class="stat ${needCrit ? 'alert' : ''}"><div class="stat-label">Devices missing critical</div><div class="stat-value">${fmtN(needCrit)}</div></div>
      <div class="stat"><div class="stat-label">Required installs</div><div class="stat-value">${fmtN(required)}</div><div class="stat-sub">across ${S.updateList().length} updates</div></div>
      <div class="stat"><div class="stat-label">Restart pending</div><div class="stat-value">${fmtN(reboot)}</div></div>`;
  };
  const draw = () => {
    const b = el.querySelector('#body');
    el.querySelector('#grp').style.display = tab === 'all' ? '' : 'none';
    el.querySelector('#adrnew').style.display = tab === 'adr' ? '' : 'none';
    b.onclick = null;
    if (tab === 'all') {
      cur = table(b, {
        rows: () => S.updateList(), search: u => `${u.kb} ${u.title} ${u.product} ${u.classification}`, onRow: u => openUpdate(u.id),
        empty: 'No updates reported yet. Agents scan for updates every 6 hours and when you choose “Scan for updates” on a device.',
        tools: '<span class="spacer"></span><span class="small muted" id="selc"></span>',
        cols: [
          { key: 'x', label: '', render: u => `<input type="checkbox" data-u="${esc(u.id)}" ${sel.has(u.id) ? 'checked' : ''} aria-label="Select ${esc(u.kb)}">`, sort: u => sel.has(u.id) },
          { key: 'kb', label: 'ID', render: u => `<span class="mono">${esc(u.kb)}</span>` },
          { key: 'title', label: 'Title', render: u => `${esc(u.title)}<div class="small muted">${esc(u.product)} · ${esc(u.classification)}</div>` },
          { key: 'severity', label: 'Severity', render: u => `<span class="sev-${u.severity}">${u.severity}</span>` },
          { key: 'released', label: 'Released', render: u => u.released ? fmtDay(u.released) : '—', sort: u => u.released || 0 },
          { key: 'req', label: 'Required', num: true, render: u => fmtN(S.updateStats(u).required), sort: u => S.updateStats(u).required },
          { key: 'inst', label: 'Installed', num: true, render: u => fmtN(S.updateStats(u).installed), sort: u => S.updateStats(u).installed },
          { key: 'pct', label: 'Compliance', num: true, render: u => `${S.updateStats(u).pct}%`, sort: u => S.updateStats(u).pct },
        ],
      });
      b.querySelector('tbody').addEventListener('change', e => { const id = e.target.dataset.u; if (!id) return; e.target.checked ? sel.add(id) : sel.delete(id); selCount(); });
      selCount();
    } else if (tab === 'groups') {
      cur = table(b, {
        rows: () => S.state.updateGroups, search: g => g.name, empty: 'No update groups. Tick updates on the “All updates” tab to make one.',
        cols: [
          { key: 'name', label: 'Update group', render: g => `<b>${esc(g.name)}</b><div class="small muted">${g.updateIds.map(id => esc(S.update(id).kb)).join(', ')}</div>` },
          { key: 'n', label: 'Updates', num: true, render: g => g.updateIds.length },
          { key: 'req', label: 'Devices needing', num: true, render: g => fmtN(S.state.devices.filter(d => g.updateIds.some(id => d.missingUpdates.includes(id))).length) },
          { key: 'deps', label: 'Deployments', render: g => S.state.deployments.filter(d => d.kind === 'updates' && d.targetId === g.id).map(d => `<a href="#/deployments/${d.id}">${esc(d.name)}</a>`).join('<br>') || '<span class="muted">None</span>' },
          { key: 'a', label: '', render: g => `<span class="row-actions"><a class="btn sm" href="#/deployments?new=1&ug=${g.id}">Deploy</a> <button class="btn sm danger" data-delg="${g.id}">Delete</button></span>` },
        ],
      });
      b.onclick = e => {
        const d = e.target.closest('[data-delg]');
        if (d) confirmBox('Delete update group?', 'Deployments of this group must be deleted first.', 'Delete', () => { S.deleteUpdateGroup(d.dataset.delg).then(() => toast('Update group deleted')).catch(() => {}); }, true);
      };
    } else {
      cur = table(b, {
        rows: () => S.state.adrs,
        empty: 'No automatic rules. A rule approves matching updates for a collection as soon as devices report them, for example every critical security update after 3 days.',
        cols: [
          { key: 'name', label: 'Rule', render: a => `<b>${esc(a.name)}</b><div class="small muted">${esc(criteria(a))}</div>` },
          { key: 'col', label: 'Collection', render: a => esc(S.byId('collections', a.collectionId)?.name || '—') },
          { key: 'n', label: 'Devices with matching updates', num: true, render: a => fmtN(S.members(a.collectionId).filter(d => S.adrMatches(a, d).length).length) },
          { key: 'enabled', label: 'State', render: a => a.enabled ? badge('Enabled', 'good') : badge('Disabled', 'neutral') },
          { key: 'x', label: '', render: a => `<span class="row-actions"><button class="btn sm" data-tog="${a.id}">${a.enabled ? 'Disable' : 'Enable'}</button> <button class="btn sm" data-ed="${a.id}">Edit</button> <button class="btn sm danger" data-del="${a.id}">Delete</button></span>` },
        ],
      });
      b.onclick = e => {
        const t = e.target.closest('[data-tog]'); if (t) S.toggleAdr(t.dataset.tog);
        const ed = e.target.closest('[data-ed]'); if (ed) adrEditor(S.byId('adrs', ed.dataset.ed));
        const d = e.target.closest('[data-del]'); if (d) confirmBox('Delete rule?', 'Devices stop installing updates approved only by this rule.', 'Delete', () => { S.deleteAdr(d.dataset.del); toast('Rule deleted'); }, true);
      };
    }
  };
  const selCount = () => { const s = el.querySelector('#selc'); if (s) s.textContent = sel.size ? `${sel.size} selected` : 'Tick updates, then create a group'; };
  el.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (!b) return; tab = b.dataset.tab; el.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', x === b)); draw(); });
  el.querySelector('#adrnew').addEventListener('click', () => adrEditor());
  el.querySelector('#grp').addEventListener('click', () => {
    if (!sel.size) { toast('Tick one or more updates first.', true); return; }
    modal('Create update group', `<label class="field">Name<input id="gn" value="${new Date().toISOString().slice(0, 7)} updates"></label><p class="small muted" style="margin-top:10px">${[...sel].map(id => esc(S.update(id).kb)).join(', ')}</p>`,
      [{ label: 'Cancel' }, { label: 'Create and deploy', cls: 'primary', onClick: m => { const g = S.createUpdateGroup(m.querySelector('#gn').value || 'Update group', [...sel]); sel = new Set(); location.hash = `#/deployments?new=1&ug=${g.id}`; } }]);
  });
  stats(); draw();
  return { refresh: () => { stats(); cur?.draw(); selCount(); } };
}

const criteria = a => [a.classifications?.length ? a.classifications.join(', ') : 'Any classification', a.severities?.length ? a.severities.join('/') : 'any severity', a.delayDays ? `${a.delayDays} days after release` : 'as soon as found', a.respectMW ? 'in maintenance windows' : 'any time'].join(' · ');

function adrEditor(a) {
  const x = a ? { ...a } : { name: '', collectionId: 'c-all', classifications: ['Security Updates', 'Critical Updates'], severities: ['Critical', 'Important'], delayDays: 3, restart: 'Suppress', respectMW: true, enabled: true };
  const known = [...new Set([...CLASSES, ...S.updateList().map(u => u.classification)])];
  const checks = (name, opts, on) => `<div style="display:flex;flex-wrap:wrap;gap:6px 14px;font-weight:400">${opts.map(o => `<label><input type="checkbox" name="${name}" value="${esc(o)}" ${on.includes(o) ? 'checked' : ''}> ${esc(o)}</label>`).join('')}</div>`;
  modal(a ? 'Edit automatic rule' : 'New automatic deployment rule', `<div class="form-grid">
    <label class="field wide">Name<input id="n" value="${esc(x.name)}" placeholder="e.g. Security updates · all workstations"></label>
    <label class="field">Collection<select id="c">${S.state.collections.map(c => `<option value="${c.id}" ${c.id === x.collectionId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
    <label class="field">Wait after release (days)<input id="dl" type="number" min="0" max="90" value="${x.delayDays || 0}"></label>
    <div class="field wide">Classifications (none ticked = all)${checks('cls', known, x.classifications || [])}</div>
    <div class="field wide">Severities (none ticked = all)${checks('sev', SEVS, x.severities || [])}</div>
    <label class="field">Restart behaviour<select id="r"><option value="Suppress" ${x.restart !== 'Allow' ? 'selected' : ''}>Don’t restart; mark restart pending</option><option value="Allow" ${x.restart === 'Allow' ? 'selected' : ''}>Restart when needed, with a 5-minute warning</option></select></label>
    <label class="field check">Install only during maintenance windows<input type="checkbox" id="mw" ${x.respectMW ? 'checked' : ''}></label></div>
    <p class="small muted" style="margin-top:10px">Devices in the collection install every missing update that matches, at their next check-in. New updates are picked up automatically as devices find them.</p>`,
  [{ label: 'Cancel' }, { label: 'Save rule', cls: 'primary', onClick: m => {
    const v = id => m.querySelector('#' + id);
    x.name = v('n').value.trim(); x.collectionId = v('c').value; x.delayDays = Math.max(0, +v('dl').value || 0);
    x.classifications = [...m.querySelectorAll('[name=cls]:checked')].map(i => i.value);
    x.severities = [...m.querySelectorAll('[name=sev]:checked')].map(i => i.value);
    x.restart = v('r').value; x.respectMW = v('mw').checked;
    if (!x.name) { toast('Name the rule.', true); return false; }
    S.saveAdr(x); toast('Rule saved. Devices apply it at their next check-in.');
  } }], { wide: true });
}

function openUpdate(id) {
  const u = S.update(id);
  const s = S.updateStats(u);
  const need = S.state.devices.filter(d => d.missingUpdates.includes(id));
  const dr = drawer(`<span class="dev-icon">⟳</span><div class="grow"><h2>${esc(u.kb)}</h2><div class="muted small">${esc(u.title)}</div></div>`,
    `<div class="card" style="margin-bottom:12px"><div class="kv"><div><span>Product</span><b>${esc(u.product)}</b></div><div><span>Classification</span><b>${esc(u.classification)}</b></div><div><span>Severity</span><b class="sev-${u.severity}">${u.severity}</b></div>
    <div><span>Released</span><b>${u.released ? fmtDate(u.released) : '—'}</b></div><div><span>Download size</span><b>${u.sizeMB != null ? size(u.sizeMB) : '—'}</b></div><div><span>Restart</span><b>${u.reboot ? 'May be required' : 'Not required'}</b></div>
    <div><span>Required on</span><b>${s.required} devices</b></div><div><span>Installed on</span><b>${s.installed} devices</b></div></div></div>
    <h3 style="margin-bottom:8px">Devices that need it (${need.length})</h3><ul class="list card">${need.slice(0, 200).map(d => `<li data-d="${d.id}" style="cursor:pointer">${statusDot(d)}<span class="grow">${esc(d.name)}</span><span class="small muted">${esc(d.site)}</span></li>`).join('') || '<li class="muted">None. Every device that reported it has it.</li>'}</ul>`);
  dr.body.addEventListener('click', e => { const li = e.target.closest('[data-d]'); if (li) openDevice(li.dataset.d); });
}
