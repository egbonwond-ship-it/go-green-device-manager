import * as S from '../store.js';
import { esc, fmtN, ago, badge, toast } from '../ui.js';
import { scriptPicker } from './devices.js';

export default function scripts(el) {
  el.innerHTML = `<div class="page-head"><div><h1>Run scripts</h1><p class="muted">Run an approved PowerShell script on a whole collection and see the output from each device within seconds.</p></div></div>
    <div class="grid g2"><div class="card"><h3 style="margin-bottom:10px">Approved scripts</h3><ul class="list">${S.SCRIPTS.map(s => `<li><div class="grow"><b>${esc(s.name)}</b><div class="console" style="margin-top:6px;max-height:80px">${esc(s.body)}</div></div></li>`).join('')}</ul></div>
    <div class="stack"><div class="card"><h3 style="margin-bottom:10px">Run on a collection</h3><div class="form-grid"><label class="field wide">Collection<select id="col">${S.state.collections.map(c => `<option value="${c.id}">${esc(c.name)} (${S.members(c.id).length})</option>`).join('')}</select></label></div>
      <p class="small muted" style="margin:10px 0">Only online Windows devices run it now. Offline devices run it at their next check-in.</p><button class="btn primary" id="run">Choose script and run…</button></div>
      <div class="card"><h3 style="margin-bottom:10px">Recent runs</h3><ul class="list" id="runs"></ul></div></div></div>`;
  const runs = () => { el.querySelector('#runs').innerHTML = S.state.scriptRuns.slice(0, 12).map(r => `<li><span class="grow"><b>${esc(r.script)}</b><div class="sub">${ago(r.t)} · ${fmtN(r.count)} devices</div></span>${badge(`${r.ok} succeeded`, r.ok ? 'good' : 'neutral')}</li>`).join('') || '<li class="muted">No scripts run yet.</li>'; };
  el.querySelector('#run').addEventListener('click', () => {
    const ids = S.members(el.querySelector('#col').value).map(d => d.id);
    if (ids.length > 60) toast(`Running on ${ids.length} devices; results below list each one.`);
    scriptPicker(ids);
  });
  runs();
  return { refresh: runs };
}
