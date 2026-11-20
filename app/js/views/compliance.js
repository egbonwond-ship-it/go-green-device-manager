import * as S from '../store.js';
import { esc, fmtN, table, toast, badge, ring, barList, statusDot, ago, downloadCsv } from '../ui.js';
import { openDevice } from './devices.js';

export default function compliance(el, { params }) {
  let bid = params.b || S.state.baselines[0].id;
  el.innerHTML = `<div class="page-head"><div><h1>Compliance</h1><p class="muted">Configuration baselines every device is checked against. Remediable settings are fixed by the agent automatically when remediation is on.</p></div>
    <div class="actions"><button class="btn" id="csv">Export non-compliant</button></div></div>
    <div class="grid g3" id="cards"></div>
    <div class="grid g2" style="margin-top:16px"><div class="card" id="rules"></div><div class="card" id="sites"></div></div>
    <h2 style="margin:20px 0 10px" id="nch"></h2><div id="tbl"></div>`;
  const b = () => S.byId('baselines', bid);
  const cards = () => {
    el.querySelector('#cards').innerHTML = S.state.baselines.map(x => {
      const s = S.baselineSummary(x);
      return `<button class="card" data-b="${x.id}" style="text-align:left;cursor:pointer;${x.id === bid ? 'border-color:var(--brand);box-shadow:0 0 0 2px var(--brand-soft)' : ''}">
        <div class="card-title"><h3>${esc(x.name)}</h3>${x.remediate ? badge('Auto-remediate', 'good') : badge('Report only', 'neutral')}</div>
        <div class="ring-row">${ring(s.pct, 'compliant', s.pct < 70 ? '#d9483b' : s.pct < 90 ? '#e0a526' : null)}<div><p class="small muted">${esc(x.description)}</p>
        <div class="small"><b>${fmtN(s['Non-compliant'])}</b> non-compliant · <b>${fmtN(s.Unknown)}</b> unknown</div><div class="small muted">Evaluated every ${x.evalEveryH} h</div></div></div></button>`;
    }).join('');
  };
  const rules = () => {
    const x = b();
    el.querySelector('#rules').innerHTML = `<div class="card-title"><h3>Rules in ${esc(x.name)}</h3><span><label class="small" style="margin-right:8px"><input type="checkbox" id="rem" ${x.remediate ? 'checked' : ''}> Remediate automatically</label><button class="btn sm primary" id="now">Remediate now</button></span></div>
      <ul class="list">${x.rules.map(r => { const s = S.ruleSummary(r); const p = s.pass + s.fail ? Math.round(s.pass / (s.pass + s.fail) * 100) : 100; return `<li><div class="grow">${esc(r.name)}<div class="sub"><span class="sev-${r.severity}">${r.severity}</span>${r.remediable ? ' · agent can fix' : ' · needs manual action'}</div></div><span class="small ${s.fail ? '' : 'muted'}">${s.fail ? `<b style="color:var(--bad)">${s.fail}</b> failing` : 'all pass'}</span><span class="progress"><span style="width:${p}%"></span></span></li>`; }).join('')}</ul>`;
    el.querySelector('#rem').onchange = e => { x.remediate = e.target.checked; S.log('Compliance', `${x.remediate ? 'Turned on' : 'Turned off'} automatic remediation for ${x.name}`); S.save(); S.emit(); };
    el.querySelector('#now').onclick = () => { const n = S.remediateNow(bid); toast(n ? `Fixed ${n} settings on online devices.` : 'Nothing remediable is failing on online devices.'); };
  };
  const sites = () => {
    const x = b();
    const by = {};
    for (const d of S.state.devices) { const c = S.compliance(d, x).state; if (c === 'Unknown') continue; by[d.site] ??= [0, 0]; by[d.site][1]++; if (c === 'Compliant') by[d.site][0]++; }
    el.querySelector('#sites').innerHTML = `<div class="card-title"><h3>Compliance by site</h3></div>${barList(Object.entries(by).map(([k, [c, n]]) => [k, Math.round(c / n * 100)]).sort((a, b) => a[1] - b[1]), { max: 100, fmt: v => v + '%' })}`;
  };
  const nonCompliant = () => S.state.devices.filter(d => S.compliance(d, b()).state === 'Non-compliant');
  const t = table(el.querySelector('#tbl'), {
    rows: nonCompliant, search: d => `${d.name} ${d.user || ''}`, onRow: d => openDevice(d.id), empty: 'Every evaluated device is compliant.',
    cols: [
      { key: 'name', label: 'Device', render: d => `<span class="person">${statusDot(d)}<b>${esc(d.name)}</b></span>` },
      { key: 'user', label: 'User', render: d => esc(d.user || '—') }, { key: 'site', label: 'Site' },
      { key: 'f', label: 'Failing rules', render: d => S.compliance(d, b()).failing.map(r => `<span class="chip">${esc(r.name)}</span>`).join(''), sort: d => S.compliance(d, b()).failing.length },
      { key: 'lastSeen', label: 'Last seen', render: d => d.online ? 'Online' : ago(d.lastSeen), sort: d => d.online ? Infinity : d.lastSeen },
    ],
  });
  const head = () => { el.querySelector('#nch').textContent = `Non-compliant devices · ${b().name} (${nonCompliant().length})`; };
  const all = () => { cards(); rules(); sites(); head(); t.draw(); };
  el.querySelector('#cards').addEventListener('click', e => { const c = e.target.closest('[data-b]'); if (c) { bid = c.dataset.b; all(); } });
  el.querySelector('#csv').addEventListener('click', () => downloadCsv(`ggt-noncompliant-${bid}.csv`, ['Device', 'User', 'Site', 'OS', 'Failing rules'], nonCompliant().map(d => [d.name, d.user, d.site, d.os, S.compliance(d, b()).failing.map(r => r.name).join('; ')])));
  all();
  return { refresh: () => { cards(); sites(); head(); t.draw(); if (!el.querySelector('#rules').contains(document.activeElement)) rules(); } };
}
