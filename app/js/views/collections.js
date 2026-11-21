import * as S from '../store.js';
import { esc, fmtN, table, modal, toast, badge, statusDot, ago, confirmBox } from '../ui.js';
import { openDevice } from './devices.js';

const OPS = { is: 'is', not: 'is not', in: 'is one of', contains: 'contains', starts: 'starts with' };
export const ruleText = c => c.rules.length ? c.rules.map(r => `${S.FIELDS[r.field]?.label || r.field} ${OPS[r.op]} “${r.value}”`).join(c.match === 'any' ? ' or ' : ' and ') : 'All devices';

export default function collections(el, { rest }) {
  if (rest[0]) return detail(el, rest[0]);
  el.innerHTML = `<div class="page-head"><div><h1>Collections</h1><p class="muted">Groups of devices built from rules. Deployments, maintenance windows and reports target collections, and membership updates as inventory changes.</p></div>
    <div class="actions"><button class="btn primary" id="new">New collection</button></div></div><div id="tbl"></div>`;
  const t = table(el.querySelector('#tbl'), {
    rows: () => S.state.collections,
    search: c => c.name + ' ' + (c.description || ''),
    onRow: c => { location.hash = `#/collections/${c.id}`; },
    cols: [
      { key: 'name', label: 'Collection', render: c => `<b>${esc(c.name)}</b>${c.builtIn ? ' <span class="chip">built-in</span>' : ''}<div class="small muted">${esc(c.description || '')}</div>` },
      { key: 'rules', label: 'Membership rule', render: c => `<span class="small">${esc(ruleText(c))}</span>`, sort: c => c.rules.length },
      { key: 'members', label: 'Members', num: true, render: c => fmtN(S.members(c.id).length), sort: c => S.members(c.id).length },
      { key: 'deps', label: 'Deployments', num: true, render: c => S.state.deployments.filter(d => d.collectionId === c.id).length, sort: c => S.state.deployments.filter(d => d.collectionId === c.id).length },
    ],
  });
  el.querySelector('#new').addEventListener('click', () => editor());
  return { refresh: () => t.draw() };
}

function detail(el, id) {
  const c = S.byId('collections', id);
  if (!c) { el.innerHTML = '<p>Collection not found. <a href="#/collections">Back to collections</a></p>'; return; }
  el.innerHTML = `<div class="page-head"><div><a class="small" href="#/collections">← Collections</a><h1>${esc(c.name)}</h1><p class="muted">${esc(c.description || '')}</p></div>
    <div class="actions">${c.builtIn ? '' : '<button class="btn" id="edit">Edit rules</button><button class="btn danger" id="del">Delete</button>'}<a class="btn primary" href="#/deployments?new=1&c=${c.id}">Deploy to this collection</a></div></div>
    <div class="card" style="margin-bottom:16px"><div class="kv"><div><span>Membership rule</span><b>${esc(ruleText(c))}</b></div><div><span>Members</span><b id="cnt"></b></div><div><span>Maintenance windows</span><b>${S.state.maintenanceWindows.filter(m => m.collectionId === c.id).map(m => esc(m.name)).join(', ') || 'None'}</b></div><div><span>Deployments</span><b>${S.state.deployments.filter(d => d.collectionId === c.id).map(d => `<a href="#/deployments/${d.id}">${esc(d.name)}</a>`).join('<br>') || 'None'}</b></div><div><span>Update rules</span><b>${S.state.adrs.filter(a => a.collectionId === c.id).map(a => esc(a.name)).join('<br>') || 'None'}</b></div></div></div>
    <div id="tbl"></div>`;
  const t = table(el.querySelector('#tbl'), {
    rows: () => S.members(id), search: d => `${d.name} ${d.user || ''}`, onRow: d => openDevice(d.id),
    cols: [
      { key: 'name', label: 'Device', render: d => `<span class="person">${statusDot(d)}<b>${esc(d.name)}</b></span>` },
      { key: 'user', label: 'User', render: d => esc(d.user || '—') }, { key: 'os', label: 'OS' }, { key: 'site', label: 'Site' },
      { key: 'lastSeen', label: 'Last seen', render: d => d.online ? 'Online' : ago(d.lastSeen), sort: d => d.online ? Infinity : d.lastSeen },
      { key: 'c', label: 'Compliance', render: d => badge(S.deviceCompliant(d)), sort: d => S.deviceCompliant(d) },
    ],
  });
  const cnt = () => { el.querySelector('#cnt').textContent = fmtN(S.members(id).length); };
  cnt();
  el.querySelector('#edit')?.addEventListener('click', () => editor(c));
  el.querySelector('#del')?.addEventListener('click', () => confirmBox('Delete collection?', `Delete <b>${esc(c.name)}</b>? Devices are not affected.`, 'Delete', () => {
    if (!S.deleteCollection(id)) { toast('Remove the deployments, update rules and maintenance windows that use this collection first.', true); return; }
    toast('Collection deleted'); location.hash = '#/collections';
  }, true));
  return { refresh: () => { t.draw(); cnt(); } };
}

export function editor(c) {
  const draft = c ? JSON.parse(JSON.stringify(c)) : { name: '', description: '', match: 'all', rules: [{ field: 'platform', op: 'is', value: 'Windows' }] };
  const m = modal(c ? 'Edit collection' : 'New collection', `<div class="form-grid">
      <label class="field wide">Name <input id="n" value="${esc(draft.name)}" placeholder="e.g. Ring 0 · Pilot"></label>
      <label class="field wide">Description <input id="ds" value="${esc(draft.description || '')}"></label>
      <label class="field">Devices must match <select id="mt"><option value="all" ${draft.match === 'all' ? 'selected' : ''}>all rules</option><option value="any" ${draft.match === 'any' ? 'selected' : ''}>any rule</option></select></label></div>
    <h3 style="margin:16px 0 8px">Rules</h3><div id="rules"></div><button class="btn sm" id="add">+ Add rule</button>
    <div class="notice info" id="preview" style="margin-top:14px"></div>`,
  [{ label: 'Cancel' }, { label: 'Save collection', cls: 'primary', onClick: el => {
    read(el);
    if (!draft.name.trim()) { toast('Give the collection a name.', true); return false; }
    S.saveCollection(draft); toast('Collection saved');
    if (!c) location.hash = `#/collections/${draft.id}`;
  } }], { wide: true });
  const read = el => {
    draft.name = el.querySelector('#n').value; draft.description = el.querySelector('#ds').value; draft.match = el.querySelector('#mt').value;
    draft.rules = [...el.querySelectorAll('.rule-row')].map(r => ({ field: r.querySelector('.f').value, op: r.querySelector('.o').value, value: r.querySelector('.v').value }));
  };
  const drawRules = () => {
    m.el.querySelector('#rules').innerHTML = draft.rules.map((r, i) => {
      const vals = S.FIELDS[r.field].values?.();
      return `<div class="rule-row" data-i="${i}"><select class="f">${Object.entries(S.FIELDS).map(([k, f]) => `<option value="${k}" ${k === r.field ? 'selected' : ''}>${f.label}</option>`).join('')}</select>
      <select class="o">${Object.entries(OPS).map(([k, l]) => `<option value="${k}" ${k === r.op ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input class="v" value="${esc(r.value)}" list="vl${i}"><datalist id="vl${i}">${(vals || []).map(v => `<option value="${esc(v)}">`).join('')}</datalist>
      <button class="icon-btn" data-rm="${i}" aria-label="Remove rule">✕</button></div>`;
    }).join('') || '<p class="muted small">No rules: every device is a member.</p>';
    preview();
  };
  const preview = () => {
    read(m.el);
    const n = S.state.devices.filter(d => S.inCollection(d, draft)).length;
    m.el.querySelector('#preview').innerHTML = `<b>${fmtN(n)}</b> device${n === 1 ? '' : 's'} match these rules right now.`;
  };
  m.el.addEventListener('input', preview);
  m.el.addEventListener('change', e => { if (e.target.classList.contains('f')) { read(m.el); drawRules(); } else preview(); });
  m.el.addEventListener('click', e => {
    if (e.target.id === 'add') { read(m.el); draft.rules.push({ field: 'os', op: 'is', value: '' }); drawRules(); }
    const rm = e.target.closest('[data-rm]'); if (rm) { read(m.el); draft.rules.splice(+rm.dataset.rm, 1); drawRules(); }
  });
  drawRules();
}
