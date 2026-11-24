import * as S from '../store.js';
import { esc, fmtN, pct, ago, ring, barList, stackBar, badge } from '../ui.js';

export default function overview(el) {
  const render = () => {
    const st = S.state, devs = st.devices;
    const active = devs.filter(d => d.health !== 'Inactive');
    const online = devs.filter(d => d.online).length;
    const comp = active.map(S.deviceCompliant);
    const compliant = comp.filter(c => c === 'Compliant').length;
    const missingCrit = devs.filter(d => d.missingUpdates.some(id => S.update(id).severity === 'Critical')).length;
    const runningDeps = st.deployments.filter(d => { const s = S.deploymentSummary(d); return s.inprogress + s.unknown > 0; }).length;
    const openAlerts = st.alerts.filter(a => !a.ack);
    const needs = devs.filter(d => d.health !== 'Healthy').length;
    const pending = devs.filter(d => d.pendingRebootSince).length;

    const byOs = Object.entries(devs.reduce((m, d) => (m[d.os] = (m[d.os] || 0) + 1, m), {})).sort((a, b) => b[1] - a[1]);
    const bySite = Object.entries(devs.reduce((m, d) => (m[d.site] = (m[d.site] || 0) + 1, m), {})).sort((a, b) => b[1] - a[1]);

    el.innerHTML = `
    <div class="page-head"><div><h1>Overview</h1><p class="muted">Health of every Go-Green device${devs.length ? ` across ${new Set(devs.map(d => d.site)).size} site${new Set(devs.map(d => d.site)).size === 1 ? '' : 's'}` : ''}, from what each agent reports.</p></div>
      <div class="actions"><a class="btn" href="#/deployments?new=1">New deployment</a><a class="btn primary" href="#/reports">Reports</a></div></div>
    ${devs.length ? '' : `<div class="notice info" style="margin-bottom:16px"><b>No devices yet.</b> Install the Go-Green agent on a computer and it appears here within a few minutes. <a href="#/devices?enrol=1">How to enrol devices</a></div>`}
    <div class="stats">
      <a class="stat" href="#/devices"><div class="stat-label">Managed devices</div><div class="stat-value">${fmtN(devs.length)}</div><div class="stat-sub">${fmtN(online)} online now (${pct(online, devs.length)}%)</div></a>
      <a class="stat" href="#/compliance"><div class="stat-label">Compliant</div><div class="stat-value">${pct(compliant, active.length)}%</div><div class="stat-sub">${fmtN(compliant)} of ${fmtN(active.length)} active devices</div></a>
      <a class="stat ${missingCrit ? 'alert' : ''}" href="#/updates"><div class="stat-label">Missing critical updates</div><div class="stat-value">${fmtN(missingCrit)}</div><div class="stat-sub">${fmtN(pending)} waiting for a restart</div></a>
      <a class="stat" href="#/deployments"><div class="stat-label">Deployments running</div><div class="stat-value">${runningDeps}</div><div class="stat-sub">${st.deployments.length} in total</div></a>
      <a class="stat ${openAlerts.some(a => a.severity === 'Critical') ? 'alert' : ''}" href="#/monitoring"><div class="stat-label">Open alerts</div><div class="stat-value">${openAlerts.length}</div><div class="stat-sub">${needs} clients need attention</div></a>
    </div>
    <div class="grid g3">
      ${st.baselines.map(b => { const s = S.baselineSummary(b); return `<a class="card" href="#/compliance?b=${b.id}" style="color:inherit;text-decoration:none"><div class="card-title"><h3>${esc(b.name)}</h3></div>
        <div class="ring-row">${ring(s.pct, 'compliant', s.pct < 70 ? '#d9483b' : s.pct < 90 ? '#e0a526' : null)}
        <ul class="legend"><li><i style="background:#2f9e5a"></i>Compliant<b>${s.Compliant}</b></li><li><i style="background:#d9483b"></i>Non-compliant<b>${s['Non-compliant']}</b></li><li><i style="background:#a9b5ad"></i>Unknown<b>${s.Unknown}</b></li></ul></div></a>`; }).join('')}
    </div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><div class="card-title"><h3>Deployment status</h3><a class="small" href="#/deployments">All deployments</a></div>
        <ul class="list">${st.deployments.slice(0, 6).map(d => { const s = S.deploymentSummary(d); return `<li><div class="grow"><a href="#/deployments/${d.id}"><b>${esc(d.name)}</b></a><div class="sub">${d.kind === 'app' ? d.action : d.kind === 'os' ? 'Windows upgrade' : 'Updates'} · ${s.total} devices · ${s.pct}% success${s.error ? ` · <span style="color:var(--bad)">${s.error} errors</span>` : ''}</div><div style="margin-top:6px">${stackBar(s, S.STATUS)}</div></div></li>`; }).join('') || '<li class="muted">No deployments yet.</li>'}</ul>
        <div class="st-legend">${S.STATUS.map(([, l, c]) => `<span style="--c:${c}">${l}</span>`).join('')}</div></div>
      <div class="card"><div class="card-title"><h3>Open alerts</h3><a class="small" href="#/monitoring">Monitoring</a></div>
        <ul class="list feed">${openAlerts.slice(0, 7).map(a => `<li><span class="t">${ago(a.t)}</span><div class="grow"><b>${esc(a.title)}</b><div class="sub">${esc(a.detail)}</div></div>${badge(a.severity)}</li>`).join('') || '<li class="muted">No open alerts.</li>'}</ul></div>
    </div>
    <div class="grid g3" style="margin-top:16px">
      <div class="card"><div class="card-title"><h3>Operating systems</h3></div>${byOs.length ? barList(byOs.map(([k, v]) => [k, v, `#/devices?os=${encodeURIComponent(k)}`])) : '<p class="muted small">No devices yet.</p>'}</div>
      <div class="card"><div class="card-title"><h3>Devices by site</h3></div>${bySite.length ? barList(bySite.map(([k, v]) => [k, v, `#/devices?site=${encodeURIComponent(k)}`])) : '<p class="muted small">Sites come from Administration → Sites & boundaries.</p>'}</div>
      <div class="card"><div class="card-title"><h3>Recent activity</h3></div><ul class="list feed">${st.log.slice(0, 6).map(l => `<li><span class="t">${ago(l.t)}</span><div class="grow small">${esc(l.message)}</div></li>`).join('') || '<li class="muted">Nothing yet.</li>'}</ul></div>
    </div>`;
    el.querySelectorAll('[data-href]').forEach(r => r.addEventListener('click', () => { location.hash = r.dataset.href; }));
  };
  render();
  return { refresh: render };
}
