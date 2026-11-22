import * as S from '../store.js';
import { esc, badge, table, toast, confirmBox, statusDot, fmtN, ago } from '../ui.js';

// VPN: the company's two VPNs side by side.
//   FortiClient  the office VPN. The agent reports whether it's installed and connected.
//   Tailscale    the mesh VPN remote desktop uses outside the office. The agent installs it and
//                joins the company's tailnet with the auth key saved here.
const pendingVpn = d => S.state.commands.find(c => c.deviceId === d.id && c.type?.startsWith('vpn') && (c.status === 'queued' || c.status === 'sent'));
const lastVpn = d => S.state.commands.find(c => c.deviceId === d.id && c.type?.startsWith('vpn') && c.status !== 'queued' && c.status !== 'sent');

export function fortiState(d) {
  if (d.fortiConnected === true) return { label: 'Connected', tone: 'good', key: 'connected' };
  if (d.vpnInstalled === true || d.fortiConnected === false) return { label: d.fortiConnected === false ? 'Not connected' : 'Installed', tone: 'neutral', key: 'installed' };
  if (d.vpnInstalled === false) return { label: 'Not installed', tone: d.platform === 'Linux' ? 'neutral' : 'warn', key: 'missing' };
  return { label: 'Not reported', tone: 'neutral', key: 'unknown' };
}

export function tailscaleState(d) {
  const p = pendingVpn(d);
  if (p) return { label: p.type === 'vpnjoin' ? 'Joining…' : 'Leaving…', tone: 'warn', key: 'pending' };
  const t = d.tailscale;
  if (t && (t.ips?.length || t.dnsName)) return t.online === false ? { label: 'Stopped', tone: 'warn', key: 'stopped' } : { label: 'Connected', tone: 'good', key: 'connected' };
  if (t) return { label: 'Installed, not joined', tone: 'neutral', key: 'installed' };
  return { label: 'Not installed', tone: 'neutral', key: 'missing' };
}

export default function vpn(el) {
  el.innerHTML = `<div class="page-head"><div><h1>VPN</h1><p class="muted">FortiClient, the office VPN, and Tailscale, which lets you reach devices anywhere, including for remote desktop.</p></div>
      <div class="actions"><button class="btn primary" id="joinAll">Join all to Tailscale</button></div></div>
    <div class="stats" id="sum"></div>
    <div id="tbl" style="margin-top:16px"></div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card stack"><h3>Tailscale auth key</h3><div id="key" class="small"></div>
        <p class="small muted">Create a <b>reusable</b>, <b>pre-approved</b> auth key in the Tailscale admin console (Settings → Keys), ideally tagged, for example <span class="mono">tag:ggt-device</span>, so devices don’t expire with a person’s account. The agent uses it to join devices; it’s sent only to the device being joined and can’t be read back here.</p>
        <label class="field">New auth key<input id="tskey" type="password" class="mono" autocomplete="off" placeholder="tskey-auth-…"></label>
        <div class="row-actions"><button class="btn sm primary" id="savekey">Save key</button><button class="btn sm danger" id="delkey">Remove key</button></div></div>
      <div class="card stack"><h3>How the two VPNs work together</h3>
        <p class="small muted"><b>FortiClient</b> connects a device to the office network. The <b>Corporate Configuration</b> baseline checks it’s installed on every workstation; deploy it from the Software library.</p>
        <p class="small muted"><b>Tailscale</b> gives each device a private address that works behind any home router. <b>Join</b> installs Tailscale on Windows and Linux if needed (macOS needs the standalone Tailscale app first) and connects it. Install Tailscale on your own computer too, then <b>Remote desktop → Connect</b> uses it whenever a device isn’t on your network.</p>
        <p class="small muted"><b>Leave</b> signs the device out of Tailscale. Remove the machine in the Tailscale admin console if it shouldn’t come back.</p></div>
    </div>`;

  const rows = () => [...S.state.devices].sort((a, b) => a.name.localeCompare(b.name));
  const summary = () => {
    const ds = S.state.devices;
    const ts = ds.filter(d => tailscaleState(d).key === 'connected').length;
    const fi = ds.filter(d => ['connected', 'installed'].includes(fortiState(d).key)).length;
    const fc = ds.filter(d => fortiState(d).key === 'connected').length;
    const tile = (label, v, sub) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${fmtN(v)}</div><div class="stat-sub">${sub}</div></div>`;
    el.querySelector('#sum').innerHTML = tile('On Tailscale', ts, `of ${fmtN(ds.length)} devices`) + tile('FortiClient installed', fi, `of ${fmtN(ds.length)} devices`) + tile('FortiClient connected now', fc, 'reported at last check-in');
  };
  const keyInfo = () => {
    const k = S.state.tailscaleKey || { set: false };
    el.querySelector('#key').innerHTML = k.set
      ? `${badge('Key saved', 'good')} <span class="muted">${k.source === 'env' ? 'set by TAILSCALE_AUTH_KEY in Azure' : `saved ${k.setAt ? ago(k.setAt) : ''}${k.by ? ` by ${esc(k.by)}` : ''}`}</span>`
      : badge('No key yet. Joining needs one.', 'warn');
    const env = k.source === 'env';
    el.querySelector('#tskey').disabled = env; el.querySelector('#savekey').disabled = env; el.querySelector('#delkey').disabled = env || !k.set;
    el.querySelector('#joinAll').disabled = !k.set;
  };

  const t = table(el.querySelector('#tbl'), {
    rows,
    search: d => `${d.name} ${d.user || ''} ${d.tailscale?.dnsName || ''} ${(d.tailscale?.ips || []).join(' ')} ${fortiState(d).label} ${tailscaleState(d).label}`,
    empty: 'No devices yet. Enrol devices first under Devices → Enrol devices.',
    cols: [
      { key: 'name', label: 'Device', render: d => `<span class="person">${statusDot(d)}<b>${esc(d.name)}</b></span><div class="small muted" style="margin-top:4px">${esc(d.os)}</div>` },
      { key: 'forti', label: 'FortiClient', render: d => { const f = fortiState(d); return badge(f.label, f.tone); }, sort: d => fortiState(d).label },
      { key: 'ts', label: 'Tailscale', render: d => { const s = tailscaleState(d); const r = lastVpn(d); return badge(s.label, s.tone) + (r && r.status === 'failed' ? `<div class="small" style="color:var(--bad);margin-top:4px;max-width:320px">${esc(r.output || 'Failed')}</div>` : ''); }, sort: d => tailscaleState(d).label },
      { key: 'tsaddr', label: 'Tailscale address', render: d => d.tailscale?.ips?.length || d.tailscale?.dnsName ? `<span class="mono">${esc(d.tailscale.ips?.[0] || '')}</span><div class="small muted mono" style="margin-top:4px">${esc(d.tailscale.dnsName || '')}</div>` : '<span class="muted">—</span>', sort: d => d.tailscale?.ips?.[0] || '' },
      { key: 'act', label: '', render: d => { const s = tailscaleState(d); return `<span class="row-actions" style="white-space:nowrap">${s.key === 'connected' || s.key === 'stopped' ? `<button class="btn sm" data-leave="${d.id}">Leave</button>` : `<button class="btn sm primary" data-join="${d.id}" ${s.key === 'pending' || !S.state.tailscaleKey?.set ? 'disabled' : ''}>Join Tailscale</button>`}</span>`; }, sort: () => 0 },
    ],
  });

  const join = (ids, label) => S.devicesAction(ids, 'vpnjoin').then(r => { const n = r.commands.filter(c => c.status === 'queued').length; toast(`${label} will join Tailscale at ${n === 1 ? 'its' : 'their'} next check-in, within about 5 minutes.`); t.draw(); }).catch(() => {});
  el.querySelector('#tbl').addEventListener('click', e => {
    const b = e.target.closest('button[data-join],button[data-leave]'); if (!b) return;
    const d = S.device(b.dataset.join || b.dataset.leave);
    if (b.dataset.join) return confirmBox(`Join ${d.name} to Tailscale?`, `The agent installs Tailscale if needed and joins it to the company’s Tailscale network with the saved key. People on that network can then reach ${esc(d.name)}.`, 'Join', () => join([d.id], d.name));
    confirmBox(`Take ${d.name} off Tailscale?`, 'The agent signs the device out of Tailscale. Remote desktop from outside the office stops working for it.', 'Leave',
      () => S.deviceAction(d.id, 'vpnleave').then(() => { toast(`${d.name} will leave Tailscale at its next check-in.`); t.draw(); }).catch(() => {}), true);
  });
  el.querySelector('#joinAll').addEventListener('click', () => {
    const ids = S.state.devices.filter(d => ['missing', 'installed'].includes(tailscaleState(d).key)).map(d => d.id);
    if (!ids.length) { toast('Every device is already on Tailscale.'); return; }
    confirmBox(`Join ${ids.length} device${ids.length === 1 ? '' : 's'} to Tailscale?`, 'Every device that isn’t on Tailscale yet installs it if needed and joins the company’s Tailscale network.', 'Join all', () => join(ids, `${ids.length} device${ids.length === 1 ? '' : 's'}`));
  });
  el.querySelector('#savekey').addEventListener('click', () => {
    const v = el.querySelector('#tskey').value.trim();
    if (!/^tskey-/.test(v)) { toast('Paste a Tailscale auth key. It starts with tskey-.', true); return; }
    S.saveTailscaleKey(v).then(() => { el.querySelector('#tskey').value = ''; toast('Tailscale key saved'); }).catch(() => {});
  });
  el.querySelector('#delkey').addEventListener('click', () => confirmBox('Remove the Tailscale key?', 'Devices already on Tailscale stay on it. New devices can’t be joined until you save a key again.', 'Remove',
    () => S.saveTailscaleKey(null).then(() => toast('Tailscale key removed')).catch(() => {}), true));

  const all = () => { summary(); keyInfo(); t.draw(); };
  summary(); keyInfo();
  return { refresh: all };
}
