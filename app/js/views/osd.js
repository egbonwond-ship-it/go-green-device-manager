// Windows OS deployment: Windows versions across the estate, Windows images, and task sequences
// (ordered steps the agent runs, carrying on across restarts) that are deployed to collections.
import * as S from '../store.js';
import { esc, fmtN, table, modal, toast, badge, drawer, fmtDay, statusDot, confirmBox, barList } from '../ui.js';
import { openDevice } from './devices.js';

const SOURCES = { iso: 'Windows ISO', assistant: 'Windows 11 Installation Assistant' };
export const STEP_TYPES = [
  ['readiness', 'Check readiness'], ['bitlocker', 'Suspend BitLocker'], ['script', 'Run PowerShell script'],
  ['app', 'Install application'], ['upgrade', 'Upgrade Windows'], ['restart', 'Restart'],
];
const STEP_LABEL = Object.fromEntries(STEP_TYPES);
export function stepDetail(s) {
  switch (s.type) {
    case 'readiness': return [s.win11 ? 'Windows 11 hardware: TPM 2.0, UEFI, 4 GB memory, 64 GB disk' : '', s.minFreeGB ? `at least ${s.minFreeGB} GB free` : ''].filter(Boolean).join('; ') || 'No checks set';
    case 'bitlocker': return 'So the PC restarts without asking for the BitLocker recovery key';
    case 'script': return S.byId('scripts', s.scriptId)?.name || 'Deleted script';
    case 'app': return S.app(s.appId)?.name || 'Deleted application';
    case 'upgrade': { const i = S.osImage(s.imageId); return i ? `${i.name} (build ${i.build}). Apps, files and settings stay.${s.ignoreCompat ? ' Ignores compatibility warnings.' : ''}` : 'Deleted image'; }
    case 'restart': return '5-minute warning, then the sequence carries on after the restart';
    default: return '';
  }
}
const isWin = d => d.platform === 'Windows' && !/server/i.test(d.os);
const readyBadge = d => { const r = S.win11Readiness(d); return r.ready === null ? badge('Unknown', 'neutral') : r.ready ? badge('Ready', 'good') : badge('Not ready', 'bad'); };
const osDeps = () => S.state.deployments.filter(d => d.kind === 'os');

export default function osd(el, { params }) {
  let tab = params.tab || 'versions';
  const TABS = [['versions', 'Windows versions'], ['ts', 'Task sequences'], ['images', 'Windows images']];
  el.innerHTML = `<div class="page-head"><div><h1>Operating systems</h1><p class="muted">Upgrade Windows on managed PCs: Windows images, task sequences that check, prepare and upgrade each PC (carrying on across restarts), and deployments of them to collections.</p></div>
    <div class="actions"><button class="btn" id="img">Add Windows image</button><button class="btn" id="tsn">New task sequence</button><a class="btn primary" href="#/deployments?new=1&kind=os">Deploy</a></div></div>
    <div class="stats" id="st"></div><div class="tabs">${TABS.map(([k, l]) => `<button data-tab="${k}" aria-selected="${k === tab}">${l}</button>`).join('')}</div><div id="body"></div>`;
  const stats = () => {
    const win = S.state.devices.filter(isWin);
    const w10 = win.filter(d => d.osFamily === 'win10');
    const ready = w10.filter(d => S.win11Readiness(d).ready === true).length;
    const running = osDeps().reduce((n, d) => n + S.deploymentSummary(d).inprogress, 0);
    el.querySelector('#st').innerHTML = `
      <div class="stat"><div class="stat-label">Windows PCs</div><div class="stat-value">${fmtN(win.length)}</div><div class="stat-sub">${fmtN(win.length - w10.length)} on Windows 11</div></div>
      <div class="stat ${w10.length ? 'alert' : ''}"><div class="stat-label">Still on Windows 10</div><div class="stat-value">${fmtN(w10.length)}</div><div class="stat-sub">Out of support since October 2025</div></div>
      <div class="stat"><div class="stat-label">Windows 10 PCs ready for 11</div><div class="stat-value">${fmtN(ready)}</div><div class="stat-sub">TPM 2.0, UEFI, memory and disk</div></div>
      <div class="stat"><div class="stat-label">Upgrades in progress</div><div class="stat-value">${fmtN(running)}</div><div class="stat-sub">${fmtN(osDeps().length)} OS deployment${osDeps().length === 1 ? '' : 's'}</div></div>`;
  };
  let cur = null;
  const draw = () => {
    const b = el.querySelector('#body');
    if (tab === 'versions') {
      b.innerHTML = '<div class="grid g2" style="margin-bottom:16px"><div class="card"><h3 style="margin-bottom:10px">Windows versions</h3><div id="vers"></div></div><div class="card"><h3 style="margin-bottom:10px">How upgrades work</h3><ol class="small" style="margin:0;padding-left:18px;line-height:1.7"><li>Pick or add a <b>Windows image</b>: Microsoft’s Installation Assistant (newest Windows 11, nothing to host) or your own ISO on https or a network share.</li><li>Use the built-in <b>Upgrade to Windows 11</b> task sequence, or make your own with scripts and apps before or after the upgrade.</li><li><b>Deploy</b> it to a pilot collection first. Each PC’s agent checks its hardware, runs Windows setup in the background, then restarts (or waits for the user) and reports the new build.</li></ol></div></div><div id="tbl"></div>';
      const win = S.state.devices.filter(isWin);
      const counts = {};
      for (const d of win) { const rel = /\b\d\dH\d\b/.exec(d.os); const k = `Windows ${d.osFamily === 'win11' ? '11' : '10'}${rel ? ` ${rel[0]}` : ''}`; counts[k] = (counts[k] || 0) + 1; }
      b.querySelector('#vers').innerHTML = win.length ? barList(Object.entries(counts).sort((x, y) => y[1] - x[1])) : '<p class="muted">No Windows PCs enrolled yet.</p>';
      cur = table(b.querySelector('#tbl'), {
        rows: () => S.state.devices.filter(isWin), search: d => `${d.name} ${d.os} ${d.user || ''} ${d.model}`, onRow: d => openDevice(d.id),
        empty: 'No Windows PCs enrolled yet.',
        cols: [
          { key: 'name', label: 'Device', render: d => `<span class="person">${statusDot(d)}<b>${esc(d.name)}</b></span><div class="small muted">${esc(d.user || '')}</div>` },
          { key: 'os', label: 'Windows', render: d => `${esc(d.os)}<div class="small muted mono">${esc(d.build)}</div>` },
          { key: 'ready', label: 'Windows 11 hardware', render: d => { const r = S.win11Readiness(d); return `${readyBadge(d)}${r.problems.length ? `<div class="small muted">${esc(r.problems.join(', '))}</div>` : ''}`; }, sort: d => String(S.win11Readiness(d).ready) },
          { key: 'tpm', label: 'TPM', render: d => esc(d.osReady?.tpm == null ? '—' : d.osReady.tpm === '0' ? 'None' : d.osReady.tpm) },
          { key: 'sb', label: 'Secure Boot', render: d => (d.osReady?.secureBoot == null ? '—' : d.osReady.secureBoot ? 'On' : d.osReady.uefi ? 'Off' : 'Legacy BIOS') },
          { key: 'agentVersion', label: 'Agent', render: d => `<span class="mono small">${esc(d.agentVersion)}</span>` },
        ],
      });
    } else if (tab === 'images') {
      cur = table(b, {
        rows: () => S.state.osImages, search: i => `${i.name} ${i.version}`, onRow: i => openImage(i.id), empty: 'No Windows images yet. Add one.',
        cols: [
          { key: 'name', label: 'Image', render: i => `<b>${esc(i.name)}</b><div class="small muted">${esc(i.version || '')}</div>` },
          { key: 'build', label: 'Build', num: true, render: i => `<span class="mono">${esc(i.build)}</span>` },
          { key: 'source', label: 'Source', render: i => esc(SOURCES[i.source]) },
          { key: 'architecture', label: 'Architecture', render: i => esc(i.architecture || 'x64') },
          { key: 'uses', label: 'Task sequences', num: true, render: i => fmtN(usesOf(i.id).length), sort: i => usesOf(i.id).length },
        ],
      });
    } else {
      cur = table(b, {
        rows: () => S.state.taskSequences, search: t => `${t.name} ${t.description || ''}`, onRow: t => openTs(t.id), empty: 'No task sequences yet. Make one.',
        cols: [
          { key: 'name', label: 'Task sequence', render: t => `<b>${esc(t.name)}</b><div class="small muted">${esc(t.description || '')}</div>` },
          { key: 'steps', label: 'Steps', render: t => t.steps.map(s => `<span class="chip">${esc(STEP_LABEL[s.type])}</span>`).join(' '), sort: t => t.steps.length },
          { key: 'target', label: 'Upgrades to', render: t => { const b2 = S.tsTargetBuild(t); return b2 ? `build <span class="mono">${b2}</span>` : '<span class="muted">No upgrade</span>'; } },
          { key: 'deps', label: 'Deployments', num: true, render: t => fmtN(depsOf(t.id).length), sort: t => depsOf(t.id).length },
        ],
      });
    }
  };
  el.querySelector('.tabs').addEventListener('click', e => { const t = e.target.closest('[data-tab]'); if (!t) return; tab = t.dataset.tab; el.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', x.dataset.tab === tab)); draw(); });
  el.querySelector('#img').addEventListener('click', () => editImage());
  el.querySelector('#tsn').addEventListener('click', () => editTs());
  stats(); draw();
  return { refresh: () => { stats(); cur?.draw(); } };
}

const usesOf = imageId => S.state.taskSequences.filter(t => t.steps.some(s => s.type === 'upgrade' && s.imageId === imageId));
const depsOf = tsId => osDeps().filter(d => d.targetId === tsId);

function openImage(id) {
  const i = S.osImage(id);
  const uses = usesOf(id);
  const dr = drawer(`<span class="dev-icon">⊞</span><div class="grow"><h2>${esc(i.name)}</h2><div class="muted small">${esc(SOURCES[i.source])} · build ${esc(i.build)}</div>
    <div class="actions-row"><button class="btn sm" id="ed">Edit</button><button class="btn sm danger" id="rm">Delete</button></div></div>`,
  `<div class="card stack">${i.notes ? `<p class="small muted">${esc(i.notes)}</p>` : ''}<div class="kv">
    <div><span>Version</span><b>${esc(i.version || '—')}</b></div><div><span>Build</span><b class="mono">${esc(i.build)}</b></div>
    <div><span>Architecture</span><b>${esc(i.architecture || 'x64')}</b></div><div><span>Added</span><b>${i.created ? fmtDay(i.created) : '—'}</b></div>
    ${i.source === 'iso' ? `<div><span>ISO</span><b class="mono small" style="word-break:break-all">${esc(i.url)}</b></div><div><span>SHA-256</span><b class="mono small" style="word-break:break-all">${esc(i.sha256 || 'Not set')}</b></div>` : ''}</div>
    <p class="small muted">PCs count as upgraded once they report build ${esc(i.build)} or later.</p>
    <h3>Used by</h3><ul class="list">${uses.map(t => `<li class="grow">${esc(t.name)}</li>`).join('') || '<li class="muted">No task sequences.</li>'}</ul></div>`);
  dr.el.querySelector('#ed').addEventListener('click', () => { dr.close(); editImage(i); });
  dr.el.querySelector('#rm').addEventListener('click', () => confirmBox('Delete image?', `Delete <b>${esc(i.name)}</b>? PCs already upgraded stay as they are.`, 'Delete', () => {
    if (uses.length) { toast('Remove it from its task sequences first.', true); return; }
    S.deleteOsImage(id).then(() => { dr.close(); toast('Image deleted'); }).catch(() => {});
  }, true));
}

function editImage(i) {
  const x = i ? { ...i } : { source: 'iso', architecture: 'x64', build: 26100, version: '24H2' };
  const f = (k, label, v, ph = '', wide = false) => `<label class="field ${wide ? 'wide' : ''}">${label}<input id="${k}" value="${esc(v ?? '')}" placeholder="${esc(ph)}"></label>`;
  const m = modal(i ? 'Edit Windows image' : 'Add Windows image', `<div class="form-grid">
    ${f('name', 'Name <span class="req">*</span>', x.name, 'e.g. Windows 11 Pro 24H2 (English)', true)}
    <label class="field">Source<select id="source"><option value="iso" ${x.source === 'iso' ? 'selected' : ''}>Windows ISO (fixed version)</option><option value="assistant" ${x.source === 'assistant' ? 'selected' : ''}>Windows 11 Installation Assistant (latest)</option></select></label>
    <label class="field">Architecture<select id="architecture"><option value="x64" ${x.architecture !== 'arm64' ? 'selected' : ''}>x64</option><option value="arm64" ${x.architecture === 'arm64' ? 'selected' : ''}>ARM64</option></select></label>
    ${f('version', 'Version', x.version, '24H2')}${f('build', 'Build number <span class="req">*</span>', x.build, '26100')}
    <div class="wide" id="isof">${f('url', 'ISO location <span class="req">*</span>', x.url, 'https://…/Win11_24H2.iso or \\\\GODC01\\Images\\Win11_24H2.iso', true)}${f('sha256', 'ISO SHA-256 (recommended)', x.sha256, '64 hex characters', true)}</div>
    ${f('notes', 'Notes', x.notes, '', true)}</div>
    <div class="notice info small" id="hint" style="margin-top:12px"></div>`,
  [{ label: 'Cancel' }, { label: i ? 'Save' : 'Add image', cls: 'primary', onClick: el => {
    const v = k => el.querySelector(`#${k}`).value.trim();
    const out = { ...(i || {}), name: v('name'), source: v('source'), architecture: v('architecture'), version: v('version'), build: Number(v('build')), notes: v('notes') };
    if (out.source === 'iso') { out.url = v('url'); out.sha256 = v('sha256'); } else { delete out.url; delete out.sha256; }
    if (!out.name || !(out.build >= 10240)) { toast('A name and a Windows build number (e.g. 26100) are required.', true); return false; }
    if (out.source === 'iso' && !/^https:\/\//i.test(out.url) && !/^\\\\[^\\]+\\/.test(out.url)) { toast('The ISO location must start with https:// or be a network share like \\\\server\\share\\Win11.iso', true); return false; }
    if (out.sha256 && !/^[A-Fa-f0-9]{64}$/.test(out.sha256)) { toast('The SHA-256 must be 64 hex characters.', true); return false; }
    S.saveOsImage(out).then(() => toast(i ? 'Image saved' : 'Image added. Use it in a task sequence’s Upgrade Windows step.')).catch(() => {});
  } }], { wide: true });
  const sync = () => {
    const iso = m.el.querySelector('#source').value === 'iso';
    m.el.querySelector('#isof').style.display = iso ? '' : 'none';
    m.el.querySelector('#hint').innerHTML = iso
      ? 'Download the ISO from Microsoft (or your volume licensing site) and host it on HTTPS storage such as Azure Blob Storage, or on a network share PCs can read (the agent reads it as the computer account, so give <b>Domain Computers</b> read access). Get the SHA-256 with <span class="mono">Get-FileHash Win11.iso</span>. Each PC downloads it once (about 6 GB). Use the same edition and language as the PCs, or setup refuses to keep their apps and files.'
      : 'Microsoft’s assistant downloads the newest Windows 11 release itself, on x64 PCs only. Set the build to the oldest release you’re happy with (25H2 is 26200); PCs on that build or later count as done. The assistant restarts the PC itself when it’s ready.';
  };
  m.el.querySelector('#source').addEventListener('change', sync);
  sync();
}

function openTs(id) {
  const t = S.taskSequence(id);
  const deps = depsOf(id);
  const dr = drawer(`<span class="dev-icon">⊞</span><div class="grow"><h2>${esc(t.name)}</h2><div class="muted small">${t.steps.length} step${t.steps.length === 1 ? '' : 's'}${t.builtIn ? ' · built in' : ''}</div>
    <div class="actions-row"><a class="btn sm primary" href="#/deployments?new=1&ts=${esc(t.id)}">Deploy</a><button class="btn sm" id="ed">Edit</button><button class="btn sm" id="cp">Duplicate</button><button class="btn sm danger" id="rm">Delete</button></div></div>`,
  `<div class="card stack">${t.description ? `<p class="small muted">${esc(t.description)}</p>` : ''}
    <ol class="list">${t.steps.map((s, n) => `<li><span class="chip">${n + 1}</span><div class="grow"><b>${esc(STEP_LABEL[s.type])}</b><div class="sub">${esc(stepDetail(s))}</div></div></li>`).join('')}</ol>
    <h3>Deployments</h3><ul class="list">${deps.map(d => { const s = S.deploymentSummary(d); return `<li><a class="grow" href="#/deployments/${d.id}">${esc(d.name)}</a><span class="small muted">${s.pct}% of ${s.total}</span></li>`; }).join('') || '<li class="muted">Not deployed yet.</li>'}</ul></div>`);
  dr.el.querySelector('#ed').addEventListener('click', () => { dr.close(); editTs(t); });
  dr.el.querySelector('#cp').addEventListener('click', () => { dr.close(); const { id: _, builtIn, created, ...rest } = JSON.parse(JSON.stringify(t)); editTs({ ...rest, name: `${t.name} (copy)` }, true); });
  dr.el.querySelector('#rm').addEventListener('click', () => confirmBox('Delete task sequence?', `Delete <b>${esc(t.name)}</b>?`, 'Delete', () => {
    if (deps.length) { toast('Delete its deployments first.', true); return; }
    S.deleteTaskSequence(id).then(() => { dr.close(); toast('Task sequence deleted'); }).catch(() => {});
  }, true));
}

function editTs(t, copy = false) {
  const editing = t && !copy;
  const x = t ? JSON.parse(JSON.stringify(t)) : { name: '', description: '', steps: [{ type: 'readiness', win11: true, minFreeGB: 25 }, { type: 'bitlocker' }, { type: 'upgrade', imageId: S.state.osImages[0]?.id || '', dynamicUpdate: true }] };
  const scripts = S.state.scripts.filter(s => s.lang === 'PowerShell');
  const apps = S.state.apps.filter(a => a.platforms.includes('Windows'));
  const opts = (list, val, label) => list.map(o => `<option value="${esc(o.id)}" ${o.id === val ? 'selected' : ''}>${esc(label(o))}</option>`).join('');
  const fields = (s, n) => {
    switch (s.type) {
      case 'readiness': return `<label class="field check">Windows 11 hardware<input type="checkbox" data-s="${n}" data-k="win11" ${s.win11 ? 'checked' : ''}></label><label class="field">Free disk space (GB)<input type="number" min="0" max="500" data-s="${n}" data-k="minFreeGB" value="${esc(s.minFreeGB ?? 25)}"></label>`;
      case 'script': return `<label class="field wide">PowerShell script<select data-s="${n}" data-k="scriptId">${opts(scripts, s.scriptId, o => o.name)}</select></label>`;
      case 'app': return `<label class="field wide">Application<select data-s="${n}" data-k="appId">${opts(apps, s.appId, o => `${o.name} ${o.version || ''}`)}</select></label>`;
      case 'upgrade': return `<label class="field wide">Windows image<select data-s="${n}" data-k="imageId">${opts(S.state.osImages, s.imageId, o => `${o.name} (build ${o.build})`)}</select></label>
        <label class="field check">Get the latest setup fixes and drivers (Dynamic Update)<input type="checkbox" data-s="${n}" data-k="dynamicUpdate" ${s.dynamicUpdate !== false ? 'checked' : ''}></label>
        <label class="field check">Ignore compatibility warnings<input type="checkbox" data-s="${n}" data-k="ignoreCompat" ${s.ignoreCompat ? 'checked' : ''}></label>`;
      default: return `<p class="small muted wide" style="margin:0">${esc(stepDetail(s))}</p>`;
    }
  };
  const m = modal(editing ? 'Edit task sequence' : 'New task sequence', `<div class="form-grid">
    <label class="field wide">Name <span class="req">*</span><input id="tname" value="${esc(x.name)}" placeholder="e.g. Upgrade finance PCs to Windows 11"></label>
    <label class="field wide">Description<input id="tdesc" value="${esc(x.description || '')}"></label></div>
    <h3 style="margin:16px 0 6px">Steps</h3><p class="small muted">The agent runs these in order and stops at the first one that fails. After an upgrade or restart step it carries on once the PC has restarted.</p>
    <div id="steps"></div><div style="margin-top:8px;display:flex;gap:8px;align-items:center"><select id="addt" aria-label="Step to add">${STEP_TYPES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select><button class="btn sm" id="add" type="button">Add step</button></div>`,
  [{ label: 'Cancel' }, { label: editing ? 'Save' : 'Create task sequence', cls: 'primary', onClick: () => {
    read();
    x.name = m.el.querySelector('#tname').value.trim(); x.description = m.el.querySelector('#tdesc').value.trim();
    if (!x.name) { toast('Give the task sequence a name.', true); return false; }
    if (!x.steps.length) { toast('Add at least one step.', true); return false; }
    const missing = x.steps.find(s => (s.type === 'upgrade' && !s.imageId) || (s.type === 'script' && !s.scriptId) || (s.type === 'app' && !s.appId));
    if (missing) { toast(`Pick the ${missing.type === 'upgrade' ? 'image' : missing.type === 'script' ? 'script' : 'application'} for the “${STEP_LABEL[missing.type]}” step.`, true); return false; }
    if (copy) delete x.id;
    S.saveTaskSequence(x).then(() => toast(editing ? 'Task sequence saved' : 'Task sequence created. Deploy it to a pilot collection next.')).catch(() => {});
  } }], { wide: true });
  const box = m.el.querySelector('#steps');
  const read = () => box.querySelectorAll('[data-s]').forEach(i => { const s = x.steps[+i.dataset.s]; s[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.type === 'number' ? Number(i.value) : i.value; });
  const render = () => {
    box.innerHTML = x.steps.map((s, n) => `<div class="card" style="margin-bottom:8px;padding:12px"><div style="display:flex;gap:8px;align-items:center;margin-bottom:8px"><span class="chip">${n + 1}</span><b class="grow" style="flex:1">${esc(STEP_LABEL[s.type])}</b>
      <button class="btn sm" type="button" data-mv="${n}" data-d="-1" ${n ? '' : 'disabled'} aria-label="Move up">↑</button><button class="btn sm" type="button" data-mv="${n}" data-d="1" ${n < x.steps.length - 1 ? '' : 'disabled'} aria-label="Move down">↓</button><button class="btn sm danger" type="button" data-rm="${n}" aria-label="Remove step">✕</button></div>
      <div class="form-grid">${fields(s, n)}</div></div>`).join('') || '<p class="muted small">No steps yet.</p>';
  };
  box.addEventListener('click', e => {
    const mv = e.target.closest('[data-mv]'), rm = e.target.closest('[data-rm]');
    if (!mv && !rm) return;
    read();
    if (mv) { const a = +mv.dataset.mv, b = a + Number(mv.dataset.d); [x.steps[a], x.steps[b]] = [x.steps[b], x.steps[a]]; }
    else x.steps.splice(+rm.dataset.rm, 1);
    render();
  });
  m.el.querySelector('#add').addEventListener('click', () => {
    read();
    const type = m.el.querySelector('#addt').value;
    const s = { type };
    if (type === 'readiness') Object.assign(s, { win11: true, minFreeGB: 25 });
    if (type === 'upgrade') Object.assign(s, { imageId: S.state.osImages[0]?.id || '', dynamicUpdate: true });
    if (type === 'script') s.scriptId = scripts[0]?.id || '';
    if (type === 'app') s.appId = apps[0]?.id || '';
    x.steps.push(s); render();
  });
  render();
}
