import * as S from '../store.js';
import { esc, fmtN, table, modal, toast, badge, fmtDay, fmtDate, ago, size, drawer, statusDot } from '../ui.js';
import { openDevice } from './devices.js';

export default function updates(el, { params }) {
  let tab = params.tab || 'all';
  const TABS = [['all', 'All updates'], ['groups', 'Update groups'], ['adr', 'Automatic deployment rules']];
  el.innerHTML = `<div class="page-head"><div><h1>Software updates</h1><p class="muted">Operating system, Microsoft, Linux and third-party patches: what each device needs, grouped and deployed in rings.</p></div>
    <div class="actions"><button class="btn" id="sync">Synchronize now</button><button class="btn primary" id="grp">Create update group</button></div></div>
    <div class="stats" id="st"></div><div class="tabs">${TABS.map(([k, l]) => `<button data-tab="${k}" aria-selected="${k === tab}">${l}</button>`).join('')}</div><div id="body"></div>`;
  let sel = new Set();
  let cur = null;
  const stats = () => {
    const devs = S.state.devices;
    const needCrit = devs.filter(d => d.missingUpdates.some(id => S.update(id).severity === 'Critical')).length;
    const full = devs.filter(d => !d.missingUpdates.length).length;
    const reboot = devs.filter(d => d.pendingRebootSince).length;
    const required = S.UPDATE_LIST.reduce((n, u) => n + S.updateStats(u).required, 0);
    el.querySelector('#st').innerHTML = `
      <div class="stat"><div class="stat-label">Fully patched devices</div><div class="stat-value">${Math.round(full / devs.length * 100)}%</div><div class="stat-sub">${fmtN(full)} of ${fmtN(devs.length)}</div></div>
      <div class="stat ${needCrit ? 'alert' : ''}"><div class="stat-label">Devices missing critical</div><div class="stat-value">${fmtN(needCrit)}</div></div>
      <div class="stat"><div class="stat-label">Required installs</div><div class="stat-value">${fmtN(required)}</div><div class="stat-sub">across ${S.UPDATE_LIST.length} updates</div></div>
      <div class="stat"><div class="stat-label">Restart pending</div><div class="stat-value">${fmtN(reboot)}</div></div>`;
  };
  const draw = () => {
    const b = el.querySelector('#body');
    el.querySelector('#grp').style.display = tab === 'all' ? '' : 'none';
    b.onclick = null;
    if (tab === 'all') {
      cur = table(b, {
        rows: () => S.UPDATE_LIST, search: u => `${u.kb} ${u.title} ${u.product} ${u.classification}`, onRow: u => openUpdate(u.id),
        tools: '<span class="spacer"></span><span class="small muted" id="selc"></span>',
        cols: [
          { key: 'x', label: '', render: u => `<input type="checkbox" data-u="${u.id}" ${sel.has(u.id) ? 'checked' : ''} aria-label="Select ${esc(u.kb)}">`, sort: u => sel.has(u.id) },
          { key: 'kb', label: 'ID', render: u => `<span class="mono">${esc(u.kb)}</span>` },
          { key: 'title', label: 'Title', render: u => `${esc(u.title)}${u.superseded ? ' <span class="chip">superseded</span>' : ''}<div class="small muted">${esc(u.product)} · ${esc(u.classification)}</div>` },
          { key: 'severity', label: 'Severity', render: u => `<span class="sev-${u.severity}">${u.severity}</span>` },
          { key: 'released', label: 'Released', render: u => fmtDay(Date.now() + u.released * 86400000) },
          { key: 'req', label: 'Required', num: true, render: u => fmtN(S.updateStats(u).required), sort: u => S.updateStats(u).required },
          { key: 'inst', label: 'Installed', num: true, render: u => fmtN(S.updateStats(u).installed), sort: u => S.updateStats(u).installed },
          { key: 'pct', label: 'Compliance', num: true, render: u => `${S.updateStats(u).pct}%`, sort: u => S.updateStats(u).pct },
        ],
      });
      b.querySelector('tbody').addEventListener('change', e => { const id = e.target.dataset.u; if (!id) return; e.target.checked ? sel.add(id) : sel.delete(id); selCount(); });
      selCount();
    } else if (tab === 'groups') {
      cur = table(b, {
        rows: () => S.state.updateGroups, search: g => g.name,
        cols: [
          { key: 'name', label: 'Update group', render: g => `<b>${esc(g.name)}</b><div class="small muted">${g.updateIds.map(id => S.update(id).kb).join(', ')}</div>` },
          { key: 'n', label: 'Updates', num: true, render: g => g.updateIds.length },
          { key: 'req', label: 'Devices needing', num: true, render: g => fmtN(S.state.devices.filter(d => g.updateIds.some(id => d.missingUpdates.includes(id))).length) },
          { key: 'deps', label: 'Deployments', render: g => S.state.deployments.filter(d => d.kind === 'updates' && d.targetId === g.id).map(d => `<a href="#/deployments/${d.id}">${esc(d.name)}</a>`).join('<br>') || '<span class="muted">None</span>' },
          { key: 'a', label: '', render: g => `<a class="btn sm" href="#/deployments?new=1&ug=${g.id}">Deploy</a>` },
        ],
      });
    } else {
      cur = table(b, {
        rows: () => S.state.adrs,
        cols: [
          { key: 'name', label: 'Rule', render: a => `<b>${esc(a.name)}</b><div class="small muted">${esc(a.criteria)}</div>` },
          { key: 'target', label: 'Adds to → collection', render: a => `${esc(S.byId('updateGroups', a.targetGroup)?.name)}<div class="small muted">→ ${esc(S.byId('collections', a.collectionId)?.name)}</div>` },
          { key: 'schedule', label: 'Schedule' },
          { key: 'lastRun', label: 'Last run', render: a => `${ago(a.lastRun)}<div class="small muted">${esc(a.lastResult)}</div>` },
          { key: 'enabled', label: 'State', render: a => a.enabled ? badge('Enabled', 'good') : badge('Disabled', 'neutral') },
          { key: 'x', label: '', render: a => `<span class="row-actions"><button class="btn sm" data-run="${a.id}">Run now</button> <button class="btn sm" data-tog="${a.id}">${a.enabled ? 'Disable' : 'Enable'}</button></span>` },
        ],
      });
      b.onclick = e => {
        const r = e.target.closest('[data-run]'); if (r) { S.runAdr(r.dataset.run); toast('Rule evaluated'); }
        const t = e.target.closest('[data-tog]'); if (t) S.toggleAdr(t.dataset.tog);
      };
    }
  };
  const selCount = () => { const s = el.querySelector('#selc'); if (s) s.textContent = sel.size ? `${sel.size} selected` : 'Tick updates, then create a group'; };
  el.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (!b) return; tab = b.dataset.tab; el.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', x === b)); draw(); });
  el.querySelector('#sync').addEventListener('click', () => { S.log('Software updates', 'Synchronization with Microsoft Update and third-party catalogues completed: 0 new updates'); S.save(); S.emit(); toast('Catalogue synchronized. No new updates since the last sync.'); });
  el.querySelector('#grp').addEventListener('click', () => {
    if (!sel.size) { toast('Tick one or more updates first.', true); return; }
    modal('Create update group', `<label class="field">Name<input id="gn" value="${new Date().toISOString().slice(0, 7)} custom group"></label><p class="small muted" style="margin-top:10px">${[...sel].map(id => esc(S.update(id).kb)).join(', ')}</p>`,
      [{ label: 'Cancel' }, { label: 'Create and deploy', cls: 'primary', onClick: m => { const g = S.createUpdateGroup(m.querySelector('#gn').value || 'Update group', [...sel]); sel = new Set(); location.hash = `#/deployments?new=1&ug=${g.id}`; } }]);
  });
  stats(); draw();
  return { refresh: () => { stats(); cur?.draw(); selCount(); } };
}

function openUpdate(id) {
  const u = S.update(id);
  const s = S.updateStats(u);
  const need = S.state.devices.filter(d => d.missingUpdates.includes(id));
  const dr = drawer(`<span class="dev-icon">⟳</span><div class="grow"><h2>${esc(u.kb)}</h2><div class="muted small">${esc(u.title)}</div></div>`,
    `<div class="card" style="margin-bottom:12px"><div class="kv"><div><span>Product</span><b>${esc(u.product)}</b></div><div><span>Classification</span><b>${esc(u.classification)}</b></div><div><span>Severity</span><b class="sev-${u.severity}">${u.severity}</b></div>
    <div><span>Released</span><b>${fmtDate(Date.now() + u.released * 86400000)}</b></div><div><span>Download size</span><b>${size(u.sizeMB)}</b></div><div><span>Restart</span><b>${u.reboot ? 'May be required' : 'Not required'}</b></div>
    <div><span>Required on</span><b>${s.required} devices</b></div><div><span>Installed on</span><b>${s.installed} devices</b></div></div>
    <p class="muted small" style="margin-top:12px">Sample catalogue entry. In production this comes from Windows Server Update Services / Microsoft Update, the Ubuntu security notices feed and vendor catalogues.</p></div>
    <h3 style="margin-bottom:8px">Devices that need it (${need.length})</h3><ul class="list card">${need.slice(0, 80).map(d => `<li data-d="${d.id}" style="cursor:pointer">${statusDot(d)}<span class="grow">${esc(d.name)}</span><span class="small muted">${esc(d.site)}</span></li>`).join('') || '<li class="muted">None. Every applicable device has it.</li>'}</ul>`);
  dr.body.addEventListener('click', e => { const li = e.target.closest('[data-d]'); if (li) openDevice(li.dataset.d); });
}
