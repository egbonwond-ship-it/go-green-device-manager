import * as S from '../store.js';
import { esc, fmtN, ago, badge, toast, modal, confirmBox } from '../ui.js';
import { scriptPicker } from './devices.js';

export default function scripts(el) {
  el.innerHTML = `<div class="page-head"><div><h1>Run scripts</h1><p class="muted">Run a PowerShell script on Windows devices, or a shell script on macOS and Linux, across a whole collection, and see each device’s output.</p></div>
    <div class="actions"><button class="btn" id="add">Add script</button></div></div>
    <div class="grid g2"><div class="card"><h3 style="margin-bottom:10px">Script library</h3><ul class="list" id="lib"></ul></div>
    <div class="stack"><div class="card"><h3 style="margin-bottom:10px">Run on a collection</h3><div class="form-grid"><label class="field wide">Collection<select id="col"></select></label></div>
      <p class="small muted" style="margin:10px 0">Each device runs it at its next check-in, within about 5 minutes when it’s online. Offline devices run it when they come back.</p><button class="btn primary" id="run">Choose script and run…</button></div>
      <div class="card"><h3 style="margin-bottom:10px">Recent runs</h3><ul class="list" id="runs"></ul></div></div></div>`;
  const draw = () => {
    el.querySelector('#lib').innerHTML = S.state.scripts.map(s => `<li><div class="grow"><b>${esc(s.name)}</b> <span class="chip">${s.lang === 'PowerShell' ? 'Windows · PowerShell' : 'macOS/Linux · shell'}</span><div class="console" style="margin-top:6px;max-height:80px">${esc(s.body)}</div></div><span class="row-actions"><button class="btn sm" data-ed="${s.id}">Edit</button> <button class="btn sm danger" data-del="${s.id}">Delete</button></span></li>`).join('') || '<li class="muted">No scripts yet.</li>';
    const sel = el.querySelector('#col'); const v = sel.value;
    sel.innerHTML = S.state.collections.map(c => `<option value="${c.id}">${esc(c.name)} (${S.members(c.id).length})</option>`).join('');
    if (v) sel.value = v;
    el.querySelector('#runs').innerHTML = S.state.scriptRuns.slice(0, 12).map(r => {
      const cmds = S.runCommands(r.id); const ok = cmds.filter(c => c.status === 'succeeded').length; const bad = cmds.filter(c => c.status === 'failed').length; const waiting = cmds.filter(c => c.status === 'queued' || c.status === 'sent').length;
      return `<li data-run="${r.id}" style="cursor:pointer"><span class="grow"><b>${esc(r.script)}</b><div class="sub">${ago(r.t)} · ${fmtN(r.count)} device${r.count === 1 ? '' : 's'}${r.by ? ` · ${esc(r.by)}` : ''}</div></span>${badge(`${ok} succeeded`, ok ? 'good' : 'neutral')}${bad ? ' ' + badge(`${bad} failed`, 'bad') : ''}${waiting ? ' ' + badge(`${waiting} waiting`, 'warn') : ''}</li>`;
    }).join('') || '<li class="muted">No scripts run yet.</li>';
  };
  el.querySelector('#run').addEventListener('click', () => {
    const ids = S.members(el.querySelector('#col').value).map(d => d.id);
    if (!ids.length) { toast('That collection has no devices.', true); return; }
    scriptPicker(ids);
  });
  el.querySelector('#add').addEventListener('click', () => editor());
  el.querySelector('#lib').addEventListener('click', e => {
    const ed = e.target.closest('[data-ed]'); if (ed) editor(S.byId('scripts', ed.dataset.ed));
    const d = e.target.closest('[data-del]'); if (d) confirmBox('Delete script?', 'Past results stay in the run history.', 'Delete', () => { S.deleteScript(d.dataset.del); toast('Script deleted'); }, true);
  });
  el.querySelector('#runs').addEventListener('click', e => { const li = e.target.closest('[data-run]'); if (li) showRun(li.dataset.run); });
  draw();
  return { refresh: draw };
}

function editor(s) {
  const x = s ? { ...s } : { name: '', lang: 'PowerShell', body: '' };
  modal(s ? 'Edit script' : 'Add script', `<div class="form-grid"><label class="field">Name<input id="n" value="${esc(x.name)}"></label>
    <label class="field">Runs on<select id="l"><option value="PowerShell" ${x.lang === 'PowerShell' ? 'selected' : ''}>Windows (PowerShell, as SYSTEM)</option><option value="Shell" ${x.lang === 'Shell' ? 'selected' : ''}>macOS and Linux (sh, as root)</option></select></label>
    <label class="field wide">Script<textarea id="b" rows="10" class="mono" spellcheck="false">${esc(x.body)}</textarea></label></div>
    <p class="small muted" style="margin-top:8px">Scripts run with full rights on every targeted device and stop after 10 minutes. Output is captured up to 64 KB.</p>`,
  [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: m => {
    x.name = m.querySelector('#n').value.trim(); x.lang = m.querySelector('#l').value; x.body = m.querySelector('#b').value;
    if (!x.name || !x.body.trim()) { toast('Give the script a name and some code.', true); return false; }
    S.saveScript(x); toast('Script saved');
  } }], { wide: true });
}

function showRun(runId) {
  const r = S.byId('scriptRuns', runId);
  const cmds = S.runCommands(runId);
  modal(r.script, cmds.map(c => `<div style="margin-bottom:10px"><b>${esc(c.deviceName)}</b> ${badge(c.status, c.status === 'succeeded' ? 'good' : c.status === 'failed' ? 'bad' : 'neutral')}${c.exitCode != null ? ` <span class="small muted">exit code ${c.exitCode}</span>` : ''}${c.output ? `<div class="console" style="margin-top:6px;max-height:260px">${esc(c.output)}</div>` : ''}</div>`).join('') || '<p class="muted">Results are older than the last 300 commands and no longer shown.</p>', [{ label: 'Close', cls: 'primary' }], { wide: true });
}
