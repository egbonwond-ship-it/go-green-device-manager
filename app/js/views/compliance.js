import * as S from '../store.js';
import { esc, fmtN, table, toast, badge, ring, barList, statusDot, ago, downloadCsv, modal } from '../ui.js';
import { openDevice } from './devices.js';

export default function compliance(el, { params }) {
  let bid = params.b || S.state.baselines[0].id;
  el.innerHTML = `<div class="page-head"><div><h1>Compliance</h1><p class="muted">Configuration baselines every device is checked against, using what its agent reports. With remediation on, the agent fixes the settings it can.</p></div>
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
        <div class="small"><b>${fmtN(s['Non-compliant'])}</b> non-compliant · <b>${fmtN(s.Unknown)}</b> unknown</div><div class="small muted">Checked at every agent check-in</div></div></div></button>`;
    }).join('');
  };
  const rules = () => {
    const x = b();
    el.querySelector('#rules').innerHTML = `<div class="card-title"><h3>Rules in ${esc(x.name)}</h3><span><label class="small"><input type="checkbox" id="rem" ${x.remediate ? 'checked' : ''}> Remediate automatically</label></span></div>
      <ul class="list">${x.rules.map(r => { const s = S.ruleSummary(r); const p = s.pass + s.fail ? Math.round(s.pass / (s.pass + s.fail) * 100) : 100; return `<li><div class="grow">${esc(r.name)}<div class="sub"><span class="sev-${r.severity}">${r.severity}</span>${r.remediable ? ' · agent can fix' : ' · needs manual action'}</div></div><span class="small ${s.fail ? '' : 'muted'}">${s.fail ? `<b style="color:var(--bad)">${s.fail}</b> failing` : 'all pass'}</span><span class="progress"><span style="width:${p}%"></span></span></li>`; }).join('')}</ul>`;
    el.querySelector('#rem').onchange = e => {
      const on = e.target.checked;
      if (!on) { S.setRemediate(bid, false); toast('Remediation off. Agents only report.'); return; }
      e.target.checked = false;
      modal(`Remediate ${x.name} automatically?`, `<p>At their next check-in, agents change these settings on every device that fails them:</p><ul style="margin:8px 0 0 18px">${x.rules.filter(r => r.remediable).map(r => `<li>${esc(r.name)}</li>`).join('')}</ul><p class="small muted" style="margin-top:10px">Turning on the firewall can block inbound connections that servers rely on. Try it on a pilot collection first if you’re unsure.</p>`,
        [{ label: 'Cancel' }, { label: 'Turn on', cls: 'primary', onClick: () => { S.setRemediate(bid, true); toast('Remediation on'); } }]);
    };
  };
  const sites = () => {
    const x = b();
    const by = {};
    for (const d of S.state.devices) { const c = S.compliance(d, x).state; if (c === 'Unknown') continue; by[d.site] ??= [0, 0]; by[d.site][1]++; if (c === 'Compliant') by[d.site][0]++; }
    el.querySelector('#sites').innerHTML = `<div class="card-title"><h3>Compliance by site</h3></div>${!Object.keys(by).length ? '<p class="muted small">No evaluated devices yet.</p>' : barList(Object.entries(by).map(([k, [c, n]]) => [k, Math.round(c / n * 100)]).sort((a, b) => a[1] - b[1]), { max: 100, fmt: v => v + '%' })}`;
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
