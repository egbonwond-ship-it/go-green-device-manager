import * as S from '../store.js';
import { esc, fmtN, table, modal, toast, badge, drawer, fmtDay, confirmBox } from '../ui.js';

const PLATFORMS = [['Windows', 'windows'], ['macOS', 'macos'], ['Linux', 'linux']];
// How the agent installs an app on one platform, in the order it tries them.
export function method(a, key) {
  const p = a[key] || {};
  if (key === 'windows' && p.wingetId) return `winget ${p.wingetId}`;
  if (key === 'linux' && p.package) return `package ${p.package}`;
  if (p.url) return `download ${/\.msi(\?|$)/i.test(p.url) ? 'MSI' : /\.pkg(\?|$)/i.test(p.url) ? 'PKG' : /\.dmg(\?|$)/i.test(p.url) ? 'DMG' : key === 'windows' ? 'EXE' : 'file'}`;
  if (p.command) return 'command';
  return null;
}

export default function library(el) {
  el.innerHTML = `<div class="page-head"><div><h1>Software library</h1><p class="muted">Applications you can deploy: how the agent installs them on each platform and how it detects that they’re installed.</p></div>
    <div class="actions"><button class="btn primary" id="new">Add application</button></div></div><div id="tbl"></div>`;
  const installs = a => S.state.devices.filter(d => d.installed.includes(a.id)).length;
  const t = table(el.querySelector('#tbl'), {
    rows: () => S.state.apps, search: a => `${a.name} ${a.publisher} ${a.category}`, onRow: a => openApp(a.id),
    empty: 'No applications yet. Add one, then deploy it to a collection.',
    cols: [
      { key: 'name', label: 'Application', render: a => `<b>${esc(a.name)}</b><div class="small muted">${esc(a.publisher || '')}</div>` },
      { key: 'version', label: 'Version', render: a => `<span class="mono">${esc(a.version || '')}</span>` },
      { key: 'category', label: 'Category' },
      { key: 'platforms', label: 'Installs with', render: a => a.platforms.map(p => `<span class="chip">${p}: ${esc(method(a, PLATFORMS.find(x => x[0] === p)[1]) || '—')}</span>`).join(' '), sort: a => a.platforms.join() },
      { key: 'detectName', label: 'Detected by name', render: a => `<span class="mono small">${esc(a.detectName)}</span>` },
      { key: 'inst', label: 'Installed on', num: true, render: a => fmtN(installs(a)), sort: installs },
    ],
  });
  el.querySelector('#new').addEventListener('click', () => editApp());
  return { refresh: () => t.draw() };
}

function openApp(id) {
  const a = S.app(id);
  const deps = S.state.deployments.filter(d => d.kind === 'app' && d.targetId === id);
  const dr = drawer(`<span class="dev-icon">⬚</span><div class="grow"><h2>${esc(a.name)}</h2><div class="muted small">${esc(a.publisher || '')} · version ${esc(a.version || '')}</div>
    <div class="actions-row"><a class="btn sm primary" href="#/deployments?new=1&app=${a.id}">Deploy</a><button class="btn sm" id="ed">Edit</button><button class="btn sm danger" id="rm">Delete</button></div></div>`,
  `<div class="card stack"><div class="kv"><div><span>Category</span><b>${esc(a.category || '—')}</b></div><div><span>Platforms</span><b>${a.platforms.join(', ')}</b></div><div><span>Added</span><b>${a.created ? fmtDay(a.created) : '—'}</b></div>
      <div><span>Detection</span><b>Installed programs list contains “${esc(a.detectName)}”</b></div></div>
    ${PLATFORMS.filter(([p]) => a.platforms.includes(p)).map(([p, k]) => { const x = a[k] || {}; return `<h3>${p}</h3><div class="console">${[
      x.wingetId && `winget install --id ${x.wingetId} --silent`, x.package && `install package ${x.package}`, x.url && `download ${x.url}${x.sha256 ? `\nsha256 ${x.sha256}` : ''}${x.args ? `\nrun with: ${x.args}` : ''}`,
      x.command && `command: ${x.command}`, x.uninstall && `uninstall: ${x.uninstall}`].filter(Boolean).map(esc).join('\n') || 'No install method'}</div>`; }).join('')}
    <h3>Deployments</h3><ul class="list">${deps.map(d => { const s = S.deploymentSummary(d); return `<li><a class="grow" href="#/deployments/${d.id}">${esc(d.name)}</a><span class="small muted">${s.pct}% of ${s.total}</span></li>`; }).join('') || '<li class="muted">Not deployed yet.</li>'}</ul></div>`);
  dr.el.querySelector('#ed').addEventListener('click', () => { dr.close(); editApp(a); });
  dr.el.querySelector('#rm').addEventListener('click', () => confirmBox('Delete application?', `Delete <b>${esc(a.name)}</b> from the library? Devices keep it installed.`, 'Delete', () => {
    if (deps.length) { toast('Delete the deployments of this application first.', true); return; }
    S.deleteApp(id).then(() => { dr.close(); toast('Application deleted'); }).catch(() => {});
  }, true));
}

function editApp(a) {
  const x = a ? JSON.parse(JSON.stringify(a)) : { platforms: ['Windows'], windows: {}, macos: {}, linux: {}, category: 'Line of business' };
  const f = (k, label, v, ph = '', wide = false) => `<label class="field ${wide ? 'wide' : ''}">${label}<input id="${k}" value="${esc(v || '')}" placeholder="${esc(ph)}" ${k.includes('.') ? 'class="mono"' : ''}></label>`;
  modal(a ? 'Edit application' : 'Add application', `<div class="form-grid">
    ${f('name', 'Name <span class="req">*</span>', x.name, 'e.g. 7-Zip')}${f('publisher', 'Publisher', x.publisher)}
    ${f('version', 'Version', x.version, '24.08')}${f('category', 'Category', x.category)}
    ${f('detectName', 'Detect by installed-program name <span class="req">*</span>', x.detectName, 'Text in the name shown in Add/Remove Programs, e.g. 7-Zip', true)}
    <div class="field wide">Platforms<div style="display:flex;gap:14px;font-weight:400">${PLATFORMS.map(([p]) => `<label><input type="checkbox" value="${p}" ${x.platforms.includes(p) ? 'checked' : ''}> ${p}</label>`).join('')}</div></div></div>
    <h3 style="margin:16px 0 6px">Windows</h3><p class="small muted">Use a winget ID (easiest), or an installer URL. MSI files install with <span class="mono">msiexec /i … /qn</span>; for EXE files give the silent switches.</p><div class="form-grid">
    ${f('windows.wingetId', 'winget ID', x.windows?.wingetId, '7zip.7zip')}${f('windows.url', 'Installer URL (https)', x.windows?.url, 'https://…/setup.msi')}
    ${f('windows.args', 'Installer arguments (EXE)', x.windows?.args, '/S')}${f('windows.sha256', 'Installer SHA-256 (recommended)', x.windows?.sha256)}
    ${f('windows.command', 'Or a PowerShell command', x.windows?.command, '', true)}${f('windows.uninstall', 'Uninstall command (PowerShell)', x.windows?.uninstall, 'Optional. winget apps uninstall automatically', true)}</div>
    <h3 style="margin:16px 0 6px">macOS</h3><div class="form-grid">${f('macos.url', '.pkg URL (https)', x.macos?.url)}${f('macos.sha256', 'SHA-256', x.macos?.sha256)}
    ${f('macos.command', 'Or a shell command', x.macos?.command, '', true)}${f('macos.uninstall', 'Uninstall command', x.macos?.uninstall, '', true)}</div>
    <h3 style="margin:16px 0 6px">Linux</h3><div class="form-grid">${f('linux.package', 'Package name (apt / dnf)', x.linux?.package, 'p7zip-full')}${f('linux.command', 'Or a shell command', x.linux?.command)}
    ${f('linux.uninstall', 'Uninstall command', x.linux?.uninstall, 'Optional. Packages uninstall automatically', true)}</div>
    <p class="muted small" style="margin-top:12px">Host installers on HTTPS storage you control, such as Azure Blob Storage, and add the SHA-256 so devices refuse a changed file.</p>`,
  [{ label: 'Cancel' }, { label: a ? 'Save' : 'Add application', cls: 'primary', onClick: el => {
    const v = id => el.querySelector(`[id="${id}"]`).value.trim();
    const platforms = [...el.querySelectorAll('input[type=checkbox]:checked')].map(c => c.value);
    const out = { ...(a || {}), name: v('name'), publisher: v('publisher'), version: v('version'), category: v('category'), detectName: v('detectName'), platforms };
    for (const [, k] of PLATFORMS) {
      out[k] = {};
      el.querySelectorAll(`[id^="${k}."]`).forEach(i => { if (i.value.trim()) out[k][i.id.split('.')[1]] = i.value.trim(); });
    }
    if (!out.name || !out.detectName || !platforms.length) { toast('Name, detection name and a platform are required.', true); return false; }
    const missing = PLATFORMS.filter(([p, k]) => platforms.includes(p) && !method(out, k)).map(([p]) => p);
    if (missing.length) { toast(`Add an install method for ${missing.join(' and ')}.`, true); return false; }
    const bad = PLATFORMS.flatMap(([, k]) => [out[k].url]).filter(u => u && !/^https:\/\//i.test(u));
    if (bad.length) { toast('Installer URLs must start with https://', true); return false; }
    S.saveApp(out); toast(a ? 'Application saved' : 'Application added. Deploy it to a collection next.');
  } }], { wide: true });
}
