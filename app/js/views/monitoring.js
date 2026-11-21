import * as S from '../store.js';
import { esc, fmtN, ago, badge, meter, fmtDate } from '../ui.js';
import { openDevice } from './devices.js';

export default function monitoring(el) {
  let sev = '', showAck = false;
  el.innerHTML = `<div class="page-head"><div><h1>Monitoring & alerts</h1><p class="muted">Check-ins, resource use and alerts from every agent.</p></div>
    <div class="actions"><button class="btn" id="ackall">Acknowledge all</button></div></div>
    <div class="stats" id="st"></div>
    <div class="grid g2"><div class="card"><div class="card-title"><h3>Alerts</h3><span class="filters"><select id="sev" aria-label="Severity"><option value="">All severities</option><option>Critical</option><option>Important</option><option>Moderate</option></select><label class="small"><input type="checkbox" id="ack"> Show acknowledged</label></span></div><ul class="list feed" id="alerts"></ul></div>
      <div class="card"><div class="card-title"><h3>Device health map</h3><span class="small muted">One square per device</span></div><div id="heat"></div>
        <div class="st-legend"><span style="--c:#2f9e5a">Healthy & online</span><span style="--c:#e0a526">Needs attention</span><span style="--c:#d9483b">CPU over 90% or disk under 8% free</span><span style="--c:#a9b5ad">Offline</span></div></div></div>
    <div class="grid g3" style="margin-top:16px"><div class="card"><h3 style="margin-bottom:8px">Highest CPU</h3><ul class="list" id="cpu"></ul></div>
      <div class="card"><h3 style="margin-bottom:8px">Lowest disk space</h3><ul class="list" id="disk"></ul></div>
      <div class="card"><h3 style="margin-bottom:8px">Not reporting</h3><ul class="list" id="dps"></ul></div></div>
    <div class="card" style="margin-top:16px"><div class="card-title"><h3>Status messages</h3><span class="small muted">Newest first</span></div><ul class="list feed" id="log"></ul></div>`;
  const render = () => {
    const devs = S.state.devices;
    const online = devs.filter(d => d.online);
    const hot = online.filter(d => d.cpuPct > 90 || (d.diskFreePct != null && d.diskFreePct < 8));
    const open = S.state.alerts.filter(a => !a.ack);
    el.querySelector('#st').innerHTML = `
      <div class="stat"><div class="stat-label">Online now</div><div class="stat-value">${fmtN(online.length)}</div><div class="stat-sub">of ${fmtN(devs.length)} devices</div></div>
      <div class="stat"><div class="stat-label">Offline (< 14 days)</div><div class="stat-value">${fmtN(devs.filter(d => !d.online && d.health !== 'Inactive').length)}</div></div>
      <div class="stat"><div class="stat-label">Inactive clients</div><div class="stat-value">${fmtN(devs.filter(d => d.health === 'Inactive').length)}</div><div class="stat-sub">no check-in for 14+ days</div></div>
      <div class="stat ${hot.length ? 'alert' : ''}"><div class="stat-label">Under pressure</div><div class="stat-value">${hot.length}</div><div class="stat-sub">CPU or disk critical</div></div>
      <div class="stat ${open.some(a => a.severity === 'Critical') ? 'alert' : ''}"><div class="stat-label">Open alerts</div><div class="stat-value">${open.length}</div></div>`;
    const al = S.state.alerts.filter(a => (showAck || !a.ack) && (!sev || a.severity === sev));
    el.querySelector('#alerts').innerHTML = al.slice(0, 40).map(a => `<li style="${a.ack ? 'opacity:.55' : ''}"><span class="t">${ago(a.t)}</span><div class="grow"><b>${esc(a.title)}</b><div class="sub">${esc(a.detail)}</div>
      <div style="margin-top:4px">${a.deviceId ? `<button class="btn sm" data-dev="${a.deviceId}">Open device</button> ` : ''}${a.ack ? '' : `<button class="btn sm" data-ack="${a.id}">Acknowledge</button>`}</div></div>${badge(a.severity)}</li>`).join('') || '<li class="muted">No alerts match.</li>';
    const groups = [...new Set(devs.map(d => d.site))].sort();
    el.querySelector('#heat').innerHTML = (groups.length ? '' : '<p class="muted small">No devices yet.</p>') + groups.map(site => {
      const ds = devs.filter(d => d.site === site);
      return `<div style="margin-bottom:10px"><div class="small" style="margin-bottom:4px"><b>${esc(site)}</b> <span class="muted">${ds.filter(d => d.online).length}/${ds.length} online</span></div><div class="heat">${ds.map(d => {
        const c = !d.online ? 'off' : (d.cpuPct > 90 || (d.diskFreePct != null && d.diskFreePct < 8)) ? 'bad' : d.health !== 'Healthy' ? 'warn' : 'ok';
        return `<i class="${c}" data-dev="${d.id}" title="${esc(d.name)} · ${d.online ? `CPU ${d.cpuPct ?? '?'}% · disk ${d.diskFreePct ?? '?'}% free` : 'offline'}"></i>`;
      }).join('')}</div></div>`;
    }).join('');
    const row = (d, v, p) => `<li data-dev="${d.id}" style="cursor:pointer"><div class="grow"><b class="small">${esc(d.name)}</b>${meter(p)}</div><span class="small" style="min-width:44px;text-align:right">${v}</span></li>`;
    el.querySelector('#cpu').innerHTML = online.filter(d => d.cpuPct != null).sort((a, b) => b.cpuPct - a.cpuPct).slice(0, 6).map(d => row(d, d.cpuPct + '%', d.cpuPct)).join('') || '<li class="muted">No online devices.</li>';
    el.querySelector('#disk').innerHTML = devs.filter(d => d.health !== 'Inactive' && d.diskFreePct != null).sort((a, b) => a.diskFreePct - b.diskFreePct).slice(0, 6).map(d => row(d, d.diskFreePct + '% free', 100 - d.diskFreePct)).join('') || '<li class="muted">No devices yet.</li>';
    el.querySelector('#dps').innerHTML = devs.filter(d => !d.online).sort((a, b) => a.lastSeen - b.lastSeen).slice(0, 6).map(d => `<li data-dev="${d.id}" style="cursor:pointer"><div class="grow"><b class="small">${esc(d.name)}</b><div class="sub">${esc(d.site)} · last seen ${ago(d.lastSeen)}</div></div>${badge(d.health)}</li>`).join('') || '<li class="muted">Every device is checking in.</li>';
    el.querySelector('#log').innerHTML = (S.state.log.slice(0, 30).map(l => `<li><span class="t" title="${fmtDate(l.t)}">${ago(l.t)}</span><span class="chip">${esc(l.source)}</span><div class="grow small" style="${l.level === 'error' ? 'color:var(--bad)' : l.level === 'warn' ? 'color:var(--warn)' : ''}">${esc(l.message)}${l.by ? ` <span class="muted">· ${esc(l.by)}</span>` : ''}</div></li>`).join('')) || '<li class="muted">No activity yet.</li>';
  };
  el.addEventListener('click', e => {
    const a = e.target.closest('[data-ack]'); if (a) return S.ackAlert(a.dataset.ack);
    const d = e.target.closest('[data-dev]'); if (d) openDevice(d.dataset.dev);
  });
  el.querySelector('#ackall').addEventListener('click', () => S.ackAll());
  el.querySelector('#sev').addEventListener('change', e => { sev = e.target.value; render(); });
  el.querySelector('#ack').addEventListener('change', e => { showAck = e.target.checked; render(); });
  render();
  return { refresh: render };
}
