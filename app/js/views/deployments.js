import * as S from '../store.js';
import { esc, fmtN, table, modal, toast, badge, stackBar, fmtDate, statusDot, confirmBox } from '../ui.js';
import { openDevice } from './devices.js';

const LABEL = Object.fromEntries(S.STATUS.map(([k, l]) => [k, l]));
const KIND = { success: 'good', error: 'bad', inprogress: 'warn', reqnotmet: 'warn', unknown: 'neutral' };
const targetName = d => (d.kind === 'app' ? S.app(d.targetId)?.name : S.byId('updateGroups', d.targetId)?.name) || 'deleted item';

export default function deployments(el, { params, rest }) {
  if (rest[0]) return detail(el, rest[0]);
  el.innerHTML = `<div class="page-head"><div><h1>Deployments</h1><p class="muted">Applications and software updates sent to collections, with live results from each device.</p></div>
    <div class="actions"><button class="btn primary" id="new">New deployment</button></div></div><div id="tbl"></div>
    <div class="st-legend" style="margin-top:8px">${S.STATUS.map(([, l, c]) => `<span style="--c:${c}">${l}</span>`).join('')}</div>`;
  const t = table(el.querySelector('#tbl'), {
    rows: () => S.state.deployments, search: d => `${d.name} ${targetName(d)}`, onRow: d => { location.hash = `#/deployments/${d.id}`; },
    empty: 'No deployments yet.',
    cols: [
      { key: 'name', label: 'Deployment', render: d => `<b>${esc(d.name)}</b><div class="small muted">${d.kind === 'app' ? 'Application' : 'Software updates'} · ${esc(S.byId('collections', d.collectionId)?.name)}</div>` },
      { key: 'action', label: 'Action', render: d => `${d.kind === 'app' ? d.action : 'Install updates'}${d.enabled ? '' : ' <span class="chip">disabled</span>'}` },
      { key: 'status', label: 'Status', render: d => { const s = S.deploymentSummary(d); return `<div style="min-width:160px">${stackBar(s, S.STATUS)}<div class="small muted" style="margin-top:3px">${s.success}/${s.total} succeeded${s.error ? ` · <span style="color:var(--bad)">${s.error} errors</span>` : ''}</div></div>`; }, sort: d => S.deploymentSummary(d).pct },
      { key: 'pct', label: 'Success', num: true, render: d => S.deploymentSummary(d).pct + '%', sort: d => S.deploymentSummary(d).pct },
      { key: 'created', label: 'Created', render: d => fmtDate(d.created) },
    ],
  });
  el.querySelector('#new').addEventListener('click', () => wizard({}));
  if (params.new) wizard({ app: params.app, c: params.c, ug: params.ug });
  return { refresh: () => t.draw() };
}

function detail(el, id) {
  let dep = S.byId('deployments', id);
  if (!dep) { el.innerHTML = '<p>Deployment not found. <a href="#/deployments">Back</a></p>'; return; }
  let filter = '';
  el.innerHTML = `<div class="page-head"><div><a class="small" href="#/deployments">← Deployments</a><h1>${esc(dep.name)}</h1>
    <p class="muted">${dep.kind === 'app' ? `${dep.action} application` : 'Software update group'} <b>${esc(targetName(dep))}</b> to <a href="#/collections/${dep.collectionId}">${esc(S.byId('collections', dep.collectionId)?.name)}</a></p></div>
    <div class="actions"><button class="btn" id="toggle"></button><button class="btn" id="retry">Retry failed</button><button class="btn danger" id="del">Delete</button></div></div>
    <div class="stats" id="sum"></div>
    <div class="grid g2" style="margin-bottom:16px"><div class="card"><h3 style="margin-bottom:10px">Settings</h3><div class="kv">
      <div><span>Installs from</span><b>${fmtDate(dep.availableAt || dep.created)}</b></div><div><span>Maintenance windows</span><b>${dep.respectMW ? 'Respected' : 'Ignored'}</b></div>
      <div><span>Restart</span><b>${dep.restart === 'Allow' ? 'Restart automatically when needed (5-minute warning)' : 'Don’t restart; flag the device as restart pending'}</b></div><div><span>Created by</span><b>${esc(dep.createdBy || '—')}</b></div></div></div>
      <div class="card"><h3 style="margin-bottom:10px">Errors</h3><div id="errs"></div></div></div>
    <div id="tbl"></div>`;
  const t = table(el.querySelector('#tbl'), {
    rows: () => Object.keys(dep.results).map(S.device).filter(d => d && (!filter || dep.results[d.id] === filter)),
    search: d => `${d.name} ${d.user || ''}`, onRow: d => openDevice(d.id),
    tools: `<select id="sf" aria-label="Filter by status"><option value="">All statuses</option>${S.STATUS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>`,
    cols: [
      { key: 'name', label: 'Device', render: d => `<span class="person">${statusDot(d)}<b>${esc(d.name)}</b></span>` },
      { key: 'site', label: 'Site' }, { key: 'os', label: 'OS' },
      { key: 's', label: 'Status', render: d => badge(LABEL[dep.results[d.id]], KIND[dep.results[d.id]]), sort: d => dep.results[d.id] },
      { key: 'e', label: 'Detail', render: d => { const e = dep.errors[d.id]; const s = dep.results[d.id]; const msg = dep.messages[d.id]; return e ? `<span class="mono">${esc(e)}</span> <span class="small">${esc(S.ERRORS[e] || '')}${msg ? ` ${esc(msg)}` : ''}</span>` : s === 'reqnotmet' ? '<span class="small">This application has no install method for the device’s platform</span>' : s === 'unknown' && !d.online ? '<span class="small muted">Waiting for the device to come online</span>' : msg ? `<span class="small muted">${esc(msg)}</span>` : s === 'unknown' ? '<span class="small muted">Waiting for the next check-in</span>' : ''; } },
    ],
  });
  el.querySelector('#sf').addEventListener('change', e => { filter = e.target.value; t.draw(); });
  const sum = () => {
    const s = S.deploymentSummary(dep);
    el.querySelector('#sum').innerHTML = S.STATUS.map(([k, l, c]) => `<div class="stat"><div class="stat-label"><span class="dot" style="background:${c}"></span> ${l}</div><div class="stat-value">${fmtN(s[k])}</div><div class="stat-sub">${s.total ? Math.round(s[k] / s.total * 100) : 0}%</div></div>`).join('');
    const errs = Object.values(dep.errors).reduce((m, e) => (m[e] = (m[e] || 0) + 1, m), {});
    el.querySelector('#errs').innerHTML = Object.keys(errs).length ? `<ul class="list">${Object.entries(errs).sort((a, b) => b[1] - a[1]).map(([e, n]) => `<li><span class="mono">${esc(e)}</span><span class="grow small">${esc(S.ERRORS[e] || '')}</span><b>${n}</b></li>`).join('')}</ul>` : '<p class="muted">No errors reported.</p>';
    el.querySelector('#toggle').textContent = dep.enabled ? 'Disable' : 'Enable';
    el.querySelector('#retry').disabled = !s.error;
  };
  sum();
  el.querySelector('#toggle').addEventListener('click', () => S.setDeploymentEnabled(id, !S.byId('deployments', id).enabled));
  el.querySelector('#retry').addEventListener('click', () => toast(`${S.retryFailed(id)} failed devices try again at their next check-in`));
  el.querySelector('#del').addEventListener('click', () => confirmBox('Delete deployment?', 'Devices stop receiving this deployment. Software already installed stays installed.', 'Delete', () => { S.deleteDeployment(id); location.hash = '#/deployments'; toast('Deployment deleted'); }, true));
  return { refresh: () => { dep = S.byId('deployments', id); if (!dep) { location.hash = '#/deployments'; return; } t.draw(); sum(); } };
}

export function wizard(pre) {
  if (!S.state.apps.length && !S.state.updateGroups.length) { toast('Add an application to the software library or create an update group first.', true); return; }
  const w = { step: 0, kind: pre.ug || !S.state.apps.length ? 'updates' : 'app', targetId: pre.app || pre.ug || '', collectionId: pre.c || '', action: 'Install', respectMW: true, restart: 'Suppress', availableAt: '', name: '' };
  const firstTarget = () => (w.kind === 'app' ? S.state.apps[0]?.id : S.state.updateGroups[0]?.id) || '';
  if (!w.targetId) w.targetId = firstTarget();
  if (!w.collectionId) w.collectionId = 'c-all';
  const STEPS = ['Software', 'Collection', 'Settings', 'Review'];
  const local = t => new Date(t - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  w.availableAt = local(Date.now());
  const m = modal('New deployment', '<div id="wz"></div>', [{ label: 'Cancel' }, { label: 'Back', cls: 'left', onClick: () => { save(); w.step = Math.max(0, w.step - 1); draw(); return false; } }, { label: 'Next', cls: 'primary', onClick: () => next() }], { wide: true });
  const body = m.el.querySelector('#wz');
  const save = () => body.querySelectorAll('[data-w]').forEach(i => { w[i.dataset.w] = i.type === 'checkbox' ? i.checked : i.value; });
  const next = () => {
    save();
    if (w.step === 0 && !w.targetId) { toast(w.kind === 'app' ? 'Add an application to the library first.' : 'Create an update group first.', true); return false; }
    if (w.step < 3) { w.step++; draw(); return false; }
    const dep = S.createDeployment({ kind: w.kind, targetId: w.targetId, collectionId: w.collectionId, action: w.kind === 'app' ? w.action : 'Install', respectMW: w.respectMW, restart: w.restart, availableAt: new Date(w.availableAt).getTime(), name: w.name.trim() });
    toast('Deployment created. Devices pick it up at their next check-in.');
    location.hash = `#/deployments/${dep.id}`;
  };
  const draw = () => {
    const foot = m.el.querySelectorAll('.modal-foot .btn');
    foot[1].style.visibility = w.step ? 'visible' : 'hidden';
    foot[2].textContent = w.step === 3 ? 'Deploy' : 'Next';
    const head = `<div class="steps">${STEPS.map((s, i) => `<span class="${i === w.step ? 'on' : i < w.step ? 'done' : ''}">${i + 1}. ${s}</span>`).join('')}</div>`;
    const sel = (k, opts) => `<select data-w="${k}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(w[k]) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    let h = '';
    if (w.step === 0) {
      h = `<div class="form-grid"><label class="field">What are you deploying?${sel('kind', [['app', 'Application'], ['updates', 'Software update group']])}</label>
        <label class="field">${w.kind === 'app' ? 'Application' : 'Update group'}${sel('targetId', w.kind === 'app' ? S.state.apps.map(a => [a.id, `${a.name} ${a.version}`]) : S.state.updateGroups.map(g => [g.id, `${g.name} (${g.updateIds.length} updates)`]))}</label>
        ${w.kind === 'app' ? `<label class="field">Action${sel('action', [['Install', 'Install'], ['Uninstall', 'Uninstall']])}</label>` : ''}</div>`;
    } else if (w.step === 1) {
      h = `<div class="form-grid"><label class="field wide">Target collection${sel('collectionId', S.state.collections.map(c => [c.id, `${c.name} (${S.members(c.id).length} devices)`]))}</label></div>
        <div class="notice info" style="margin-top:12px">Tip: make a small pilot collection (for example devices tagged <span class="mono">pilot</span>), deploy there first, check results, then deploy to everyone.</div>`;
    } else if (w.step === 2) {
      h = `<div class="form-grid"><label class="field">Install from<input type="datetime-local" data-w="availableAt" value="${w.availableAt}"></label>
        <label class="field">Restart behaviour${sel('restart', [['Suppress', 'Don’t restart; mark restart pending'], ['Allow', 'Restart when needed, with a 5-minute warning']])}</label>
        <label class="field check">Install only during maintenance windows<input type="checkbox" data-w="respectMW" ${w.respectMW ? 'checked' : ''}></label>
        <label class="field wide">Deployment name (optional)<input data-w="name" value="${esc(w.name)}" placeholder="Generated from the software and collection"></label></div>`;
    } else {
      const target = w.kind === 'app' ? S.app(w.targetId) : S.byId('updateGroups', w.targetId);
      const devs = S.members(w.collectionId);
      let notMet = 0, already = 0;
      if (w.kind === 'app') for (const d of devs) { if (!target.platforms.includes(d.platform)) notMet++; else if (d.installed.includes(target.id) === (w.action === 'Install')) already++; }
      else for (const d of devs) if (d.updatesScannedAt && !target.updateIds.some(u => d.missingUpdates.includes(u))) already++;
      const mws = S.state.maintenanceWindows.filter(x => x.collectionId === w.collectionId);
      h = `<div class="kv"><div><span>Software</span><b>${esc(target.name)}</b></div><div><span>Collection</span><b>${esc(S.byId('collections', w.collectionId).name)}</b></div>
        <div><span>Action</span><b>${w.kind === 'app' ? w.action : 'Install updates'}</b></div><div><span>Installs from</span><b>${new Date(w.availableAt).toLocaleString('en-GB')}</b></div></div>
        <div class="stats" style="margin-top:16px"><div class="stat"><div class="stat-label">Targeted devices</div><div class="stat-value">${devs.length}</div></div>
        <div class="stat"><div class="stat-label">Will install</div><div class="stat-value">${devs.length - notMet - already}</div></div>
        <div class="stat"><div class="stat-label">Already compliant</div><div class="stat-value">${already}</div></div>
        <div class="stat"><div class="stat-label">Requirements not met</div><div class="stat-value">${notMet}</div></div></div>
        ${w.respectMW && mws.length ? `<div class="notice info">Maintenance window: ${mws.map(x => `${esc(x.name)} (${x.days} ${x.start}, ${x.hours} h)`).join('; ')}.</div>` : ''}
        ${devs.length > 50 ? '<div class="notice" style="margin-top:8px">This targets more than 50 devices. Consider a pilot deployment first.</div>' : ''}`;
    }
    body.innerHTML = head + h;
  };
  body.addEventListener('change', e => { if (e.target.dataset.w === 'kind') { save(); w.targetId = firstTarget(); draw(); } });
  draw();
}
