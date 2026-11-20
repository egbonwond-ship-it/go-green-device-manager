// Small DOM helpers shared by every page.
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const fmtN = n => Number(n).toLocaleString('en-NG');
export const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);

export function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export const fmtDate = t => new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const fmtDay = t => new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
export const size = mb => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);

export function badge(text, kind) {
  const k = kind || ({ Compliant: 'good', Healthy: 'good', Success: 'good', Online: 'good', Succeeded: 'good', Distributed: 'good',
    'Non-compliant': 'bad', Error: 'bad', Critical: 'bad', Offline: 'neutral', Inactive: 'neutral', Unknown: 'neutral',
    'Needs attention': 'warn', Important: 'warn', 'In progress': 'warn', Moderate: 'neutral', Low: 'neutral' }[text] || 'neutral');
  return `<span class="badge ${k}">${esc(text)}</span>`;
}

export function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3700);
}

// Modal: returns {el, close}. body is HTML. buttons: [{label, cls, onClick(el) -> false keeps open}]
export function modal(title, body, buttons = [], { wide = false } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-x aria-label="Close">✕</button></div>
    <div class="modal-body">${body}</div>
    ${buttons.length ? `<div class="modal-foot">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-b="${i}">${esc(b.label)}</button>`).join('')}</div>` : ''}
  </div>`;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('click', e => {
    if (e.target === back || e.target.closest('[data-x]')) return close();
    const b = e.target.closest('[data-b]');
    if (b) { const r = buttons[+b.dataset.b].onClick?.(back); if (r !== false) close(); }
  });
  document.body.append(back);
  setTimeout(() => $('input,select,textarea', back)?.focus(), 30);
  return { el: back, close };
}

export function confirmBox(title, text, okLabel, onOk, danger = false) {
  return modal(title, `<p>${text}</p>`, [{ label: 'Cancel' }, { label: okLabel, cls: danger ? 'primary danger' : 'primary', onClick: onOk }]);
}

// Drawer for detail panes. Returns {el, close, body}.
export function drawer(headHtml, bodyHtml) {
  const back = document.createElement('div');
  back.className = 'drawer-back';
  const el = document.createElement('aside');
  el.className = 'drawer';
  el.setAttribute('role', 'dialog');
  el.innerHTML = `<div class="drawer-head">${headHtml}<button class="icon-btn" data-x aria-label="Close">✕</button></div><div class="drawer-body">${bodyHtml}</div>`;
  const close = () => { back.remove(); el.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape' && !document.querySelector('.modal-back')) close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('click', close);
  el.querySelector('[data-x]').addEventListener('click', close);
  document.body.append(back, el);
  return { el, close, body: el.querySelector('.drawer-body'), head: el.querySelector('.drawer-head') };
}

export function stackBar(sum, statuses) {
  const t = sum.total || 1;
  return `<div class="stack-bar" title="${statuses.map(([k, l]) => `${l}: ${sum[k]}`).join(' · ')}">${statuses.map(([k]) => `<span class="st-${k}" style="width:${sum[k] / t * 100}%"></span>`).join('')}</div>`;
}

export function ring(p, label, color) {
  return `<div class="ring" style="--p:${p};${color ? `--c:${color}` : ''}"><div><span><b>${p}%</b><br><small>${esc(label)}</small></span></div></div>`;
}

export function barList(rows, { max, fmt = fmtN } = {}) {
  const m = max ?? Math.max(1, ...rows.map(r => r[1]));
  return `<div class="barlist">${rows.map(([label, v, href]) => `<div class="barrow" ${href ? `data-href="${esc(href)}" style="cursor:pointer"` : ''}><span class="bar-label" title="${esc(label)}">${esc(label)}</span><span class="bar-track"><span class="bar-fill" style="width:${v / m * 100}%"></span></span><span class="bar-value">${fmt(v)}</span></div>`).join('')}</div>`;
}

export function meter(p) {
  return `<div class="meter ${p >= 90 ? 'hot' : p >= 75 ? 'warm' : ''}"><span style="width:${p}%"></span></div>`;
}

// Client-side table with search + sort + paging. cols: [{key, label, render?(row), sort?(row), num?}]
export function table(container, { cols, rows, onRow, search, pageSize = 25, empty = 'Nothing to show.', tools = '', id }) {
  const st = { q: '', sort: null, dir: 1, page: 0 };
  const draw = () => {
    let data = rows();
    if (st.q && search) { const q = st.q.toLowerCase(); data = data.filter(r => search(r).toLowerCase().includes(q)); }
    if (st.sort) { const c = cols.find(c => c.key === st.sort); const f = c.sort || (r => r[c.key]); data = [...data].sort((a, b) => { const x = f(a), y = f(b); return (x > y ? 1 : x < y ? -1 : 0) * st.dir; }); }
    const pages = Math.max(1, Math.ceil(data.length / pageSize));
    st.page = Math.min(st.page, pages - 1);
    const slice = data.slice(st.page * pageSize, st.page * pageSize + pageSize);
    container.querySelector('tbody').innerHTML = slice.length ? slice.map((r, i) => `<tr data-i="${i}">${cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('') : `<tr><td class="empty" colspan="${cols.length}">${esc(empty)}</td></tr>`;
    container.querySelector('.pager').innerHTML = data.length > pageSize ? `<span class="muted small">${st.page * pageSize + 1}–${Math.min(data.length, (st.page + 1) * pageSize)} of ${fmtN(data.length)}</span><button class="btn sm" data-p="-1" ${st.page ? '' : 'disabled'}>Previous</button><button class="btn sm" data-p="1" ${st.page < pages - 1 ? '' : 'disabled'}>Next</button>` : `<span class="muted small">${fmtN(data.length)} item${data.length === 1 ? '' : 's'}</span>`;
    container._slice = slice;
    container.querySelectorAll('th[data-k]').forEach(th => { th.querySelector('i').textContent = st.sort === th.dataset.k ? (st.dir > 0 ? '▲' : '▼') : ''; });
  };
  container.innerHTML = `<div class="card table-card">
    <div class="table-tools">${search ? `<input type="search" placeholder="Search…" aria-label="Search" ${id ? `id="${id}"` : ''}>` : ''}${tools}</div>
    <div class="table-scroll"><table class="data ${onRow ? '' : 'plain'}"><thead><tr>${cols.map(c => `<th data-k="${c.key}" class="${c.num ? 'num' : ''}" style="cursor:pointer">${esc(c.label)} <i class="small"></i></th>`).join('')}</tr></thead><tbody></tbody></table></div>
    <div class="table-tools pager" style="border-top:1px solid var(--line);border-bottom:0;justify-content:flex-end"></div>
  </div>`;
  container.querySelector('input[type=search]')?.addEventListener('input', e => { st.q = e.target.value; st.page = 0; draw(); });
  container.querySelector('thead').addEventListener('click', e => { const th = e.target.closest('th'); if (!th) return; st.dir = st.sort === th.dataset.k ? -st.dir : 1; st.sort = th.dataset.k; draw(); });
  container.querySelector('.pager').addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (b) { st.page += +b.dataset.p; draw(); } });
  container.querySelector('tbody').addEventListener('click', e => { const tr = e.target.closest('tr[data-i]'); if (tr && onRow && !e.target.closest('button,a,input')) onRow(container._slice[+tr.dataset.i]); });
  draw();
  return { draw, state: st };
}

export function downloadCsv(name, header, rows) {
  const q = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [header, ...rows].map(r => r.map(q).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export const ICON = { Laptop: '💻', Desktop: '🖥️', Server: '🗄️', VM: '☁️' };
export function statusDot(d) {
  return d.online ? '<span class="dot on" title="Online"></span>' : d.health === 'Inactive' ? '<span class="dot off" title="Inactive"></span>' : '<span class="dot warn" title="Offline"></span>';
}
