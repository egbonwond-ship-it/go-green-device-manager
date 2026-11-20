import * as S from '../store.js';
import { esc, fmtN, table, modal, toast, badge, size, drawer, fmtDay } from '../ui.js';
import { SITES } from '../seed.js';

export default function library(el) {
  el.innerHTML = `<div class="page-head"><div><h1>Software library</h1><p class="muted">Applications packaged for deployment, with how to install them and how to detect that they are installed.</p></div>
    <div class="actions"><button class="btn primary" id="new">Add application</button></div></div><div id="tbl"></div>`;
  const installs = a => S.state.devices.filter(d => d.installed.includes(a.id)).length;
  const t = table(el.querySelector('#tbl'), {
    rows: () => S.state.apps, search: a => `${a.name} ${a.publisher} ${a.category}`, onRow: a => openApp(a.id),
    cols: [
      { key: 'name', label: 'Application', render: a => `<b>${esc(a.name)}</b><div class="small muted">${esc(a.publisher)}</div>` },
      { key: 'version', label: 'Version', render: a => `<span class="mono">${esc(a.version)}</span>` },
      { key: 'type', label: 'Installer' }, { key: 'category', label: 'Category' },
      { key: 'platforms', label: 'Platforms', render: a => a.platforms.map(p => `<span class="chip">${p}</span>`).join(''), sort: a => a.platforms.join() },
      { key: 'sizeMB', label: 'Size', num: true, render: a => size(a.sizeMB) },
      { key: 'inst', label: 'Installed on', num: true, render: a => fmtN(installs(a)), sort: installs },
      { key: 'content', label: 'Content', render: a => contentBadge(a), sort: a => contentState(a) },
    ],
  });
  el.querySelector('#new').addEventListener('click', addApp);
  return { refresh: () => t.draw() };
}

const contentState = a => Object.values(a.content).every(v => v === 'Distributed') ? 'Distributed' : 'In progress';
const contentBadge = a => { const n = Object.values(a.content).filter(v => v === 'Distributed').length; return n === SITES.length ? badge('Distributed') : badge(`${n}/${SITES.length} DPs`, 'warn'); };

// content distribution to distribution points finishes a few seconds after adding an app
S.subscribe(() => {
  for (const a of S.state.apps) for (const dp of Object.keys(a.content)) if (a.content[dp] !== 'Distributed' && Math.random() < 0.3) a.content[dp] = 'Distributed';
});

function openApp(id) {
  const a = S.app(id);
  const deps = S.state.deployments.filter(d => d.kind === 'app' && d.targetId === id);
  drawer(`<span class="dev-icon">⬚</span><div class="grow"><h2>${esc(a.name)}</h2><div class="muted small">${esc(a.publisher)} · version ${esc(a.version)} · ${esc(a.type)}</div>
    <div class="actions-row"><a class="btn sm primary" href="#/deployments?new=1&app=${a.id}">Deploy</a></div></div>`,
  `<div class="card stack"><h3>Deployment type</h3><div class="kv"><div><span>Installer</span><b>${esc(a.type)}</b></div><div><span>Content size</span><b>${size(a.sizeMB)}</b></div><div><span>Platforms</span><b>${a.platforms.join(', ')}</b></div><div><span>Added</span><b>${fmtDay(a.created)}</b></div></div>
    <div><div class="stat-label">Install command</div><div class="console" style="margin-top:4px">${esc(a.install)}</div></div>
    <div><div class="stat-label">Detection method</div><div class="console" style="margin-top:4px">${esc(a.detection)}</div></div>
    <h3>Content on distribution points</h3><ul class="list">${Object.entries(a.content).map(([dp, s]) => `<li><span class="grow mono">${dp}</span><span class="muted small">${SITES.find(x => x.dp === dp)?.name}</span>${badge(s)}</li>`).join('')}</ul>
    <h3>Deployments</h3><ul class="list">${deps.map(d => { const s = S.deploymentSummary(d); return `<li><a class="grow" href="#/deployments/${d.id}">${esc(d.name)}</a><span class="small muted">${s.pct}% of ${s.total}</span></li>`; }).join('') || '<li class="muted">Not deployed yet.</li>'}</ul></div>`);
}

function addApp() {
  modal('Add application', `<div class="form-grid">
    <label class="field">Name <span class="req">*</span><input id="name" placeholder="e.g. SolarEdge SetApp"></label>
    <label class="field">Publisher<input id="pub"></label>
    <label class="field">Version <span class="req">*</span><input id="ver" placeholder="1.0.0"></label>
    <label class="field">Installer type<select id="type"><option>MSI</option><option>EXE</option><option>MSIX</option><option>Script</option><option>PKG (macOS)</option><option>DEB (Linux)</option></select></label>
    <label class="field">Category<input id="cat" value="Line of business"></label>
    <label class="field">Content size (MB)<input id="size" type="number" min="1" value="50"></label>
    <label class="field wide">Install command <span class="req">*</span><input id="cmd" class="mono" placeholder="msiexec /i setup.msi /qn"></label>
    <label class="field wide">Detection method<input id="det" placeholder="MSI product code, file version or registry key"></label>
    <div class="field wide">Platforms<div style="display:flex;gap:14px;font-weight:400">${['Windows', 'macOS', 'Linux'].map(p => `<label><input type="checkbox" value="${p}" ${p === 'Windows' ? 'checked' : ''}> ${p}</label>`).join('')}</div></div>
  </div><p class="muted small" style="margin-top:12px">In production the installer files are uploaded to Azure Blob Storage and replicated to each site’s distribution point.</p>`,
  [{ label: 'Cancel' }, { label: 'Add application', cls: 'primary', onClick: el => {
    const v = id => el.querySelector('#' + id).value.trim();
    const platforms = [...el.querySelectorAll('input[type=checkbox]:checked')].map(c => c.value);
    if (!v('name') || !v('ver') || !v('cmd') || !platforms.length) { toast('Name, version, install command and a platform are required.', true); return false; }
    S.addApp({ name: v('name'), publisher: v('pub') || 'Go-Green Technologies', version: v('ver'), type: v('type'), category: v('cat'), sizeMB: +v('size') || 1, install: v('cmd'), detection: v('det') || 'Not set', platforms });
    toast('Application added. Distributing content to distribution points.');
  } }], { wide: true });
}
