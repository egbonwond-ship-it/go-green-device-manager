import * as S from '../store.js';
import { esc, badge, table, toast, confirmBox, modal, statusDot, fmtN, ago, size } from '../ui.js';

// VPN: the GO-Green VPN (WireGuard on vpn.go-greentechnologies.com, into the lab network), FortiClient and Tailscale.
//   FortiClient  the office VPN. The agent reports whether it's installed and connected.
//   Tailscale    the mesh VPN remote desktop uses outside the office. The agent installs it and
//                joins the company's tailnet with the auth key saved here.
const pendingVpn = d => S.state.commands.find(c => c.deviceId === d.id && c.type?.startsWith('vpn') && (c.status === 'queued' || c.status === 'sent'));
const lastVpn = d => S.state.commands.find(c => c.deviceId === d.id && c.type?.startsWith('vpn') && c.status !== 'queued' && c.status !== 'sent');
const pendingWg = d => S.state.commands.find(c => c.deviceId === d.id && c.type?.startsWith('wg') && (c.status === 'queued' || c.status === 'sent'));
const lastWg = d => S.state.commands.find(c => c.deviceId === d.id && c.type?.startsWith('wg') && c.status !== 'queued' && c.status !== 'sent');
const HANDSHAKE_OK = 3 * 60 * 1000;
const bytes = n => (n == null ? '—' : size(Math.max(0, Math.round(n / 1048576 * 10) / 10)));

export function wgState(d) {
  const p = pendingWg(d);
  if (p) return { label: p.type === 'wgjoin' ? 'Connecting…' : 'Disconnecting…', tone: 'warn', key: 'pending' };
  const w = d.wireguard;
  if (w?.active && w.address) return { label: 'Connected', tone: 'good', key: 'connected' };
  if (w?.tunnel) return { label: 'Set up, not connected', tone: 'warn', key: 'stopped' };
  if (w?.installed) return { label: 'WireGuard installed', tone: 'neutral', key: 'installed' };
  return { label: 'Not set up', tone: 'neutral', key: 'missing' };
}

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
  el.innerHTML = `<div class="page-head"><div><h1>VPN</h1><p class="muted">The GO-Green VPN connects devices anywhere to the company network and domain controllers. FortiClient is the office VPN, and Tailscale lets you reach devices anywhere for remote desktop.</p></div>
      <div class="actions"><button class="btn" id="wgManual">Config for a Mac or phone</button><button class="btn" id="joinAll">Join all to Tailscale</button></div></div>
    <div class="stats" id="sum"></div>
    <div class="card stack" style="margin-top:16px"><h3>GO-Green VPN server</h3><div id="wgsrv" class="small"></div>
      <div id="wgpeers"></div></div>
    <div id="tbl" style="margin-top:16px"></div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card stack"><h3>Tailscale auth key</h3><div id="key" class="small"></div>
        <p class="small muted">Create a <b>reusable</b>, <b>pre-approved</b> auth key in the Tailscale admin console (Settings → Keys), ideally tagged, for example <span class="mono">tag:ggt-device</span>, so devices don’t expire with a person’s account. The agent uses it to join devices; it’s sent only to the device being joined and can’t be read back here.</p>
        <label class="field">New auth key<input id="tskey" type="password" class="mono" autocomplete="off" placeholder="tskey-auth-…"></label>
        <div class="row-actions"><button class="btn sm primary" id="savekey">Save key</button><button class="btn sm danger" id="delkey">Remove key</button></div></div>
      <div class="card stack"><h3>How the VPNs work together</h3>
        <p class="small muted"><b>GO-Green VPN</b> (WireGuard to <span class="mono">vpn.go-greentechnologies.com</span>) gives each device a <span class="mono">10.99.0.x</span> address and reaches the company network <span class="mono">172.16.29.0/24</span>, including the domain controllers, so laptops can join the domain and sign in from anywhere. <b>Connect</b> installs WireGuard on Windows and Linux and starts an always-on tunnel; Macs and phones use the WireGuard app with a config from <b>Config for a Mac or phone</b>. Each device gets its own key; <b>Disconnect</b> removes it from the server.</p>
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
    const wg = ds.filter(d => wgState(d).key === 'connected').length;
    el.querySelector('#sum').innerHTML = tile('On GO-Green VPN', wg, `of ${fmtN(ds.length)} devices`) + tile('On Tailscale', ts, `of ${fmtN(ds.length)} devices`) + tile('FortiClient installed', fi, `of ${fmtN(ds.length)} devices`) + tile('FortiClient connected now', fc, 'reported at last check-in');
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

  const server = () => {
    const v = S.state.vpn || {}, srv = v.server;
    const stale = !srv || Date.now() - srv.at > 5 * 60 * 1000;
    el.querySelector('#wgsrv').innerHTML = srv
      ? `${badge(stale ? 'Not reporting' : 'Online', stale ? 'bad' : 'good')} <span class="muted"><span class="mono">${esc(srv.endpoint)}</span> · last report ${ago(srv.at)}</span>`
      : badge('Not connected to the Device Manager yet', 'warn');
    el.querySelector('#wgManual').disabled = !srv;
    const peers = (srv?.peers || []).map(p => ({ ...p, mine: (v.peers || []).find(x => x.id === p.managedBy) }));
    for (const p of v.peers || []) if (!p.onServer) peers.push({ name: p.name, allowedIps: [`${p.ip}/32`], mine: p, waiting: true });
    const rowsHtml = peers.sort((a, b) => (a.allowedIps?.[0] || '').localeCompare(b.allowedIps?.[0] || '', undefined, { numeric: true })).map(p => {
      const hs = p.latestHandshake ? Date.now() - p.latestHandshake : null;
      const st = p.waiting ? badge('Being added…', 'warn') : hs != null && hs < HANDSHAKE_OK ? badge('Connected', 'good') : badge(hs != null ? `Last seen ${ago(p.latestHandshake)}` : 'Never connected', 'neutral');
      const lab = (p.allowedIps || []).some(a => !a.endsWith('/32'));
      const kind = p.mine ? (p.mine.kind === 'manual' ? 'Mac or phone config' : 'Device (agent)') : lab ? 'Lab network gateway' : 'Set up on the server';
      return `<tr><td><b>${esc(p.mine?.name || p.name || 'Unnamed')}</b><div class="small muted">${esc(kind)}</div></td><td class="mono small">${(p.allowedIps || []).map(esc).join('<br>')}</td><td>${st}</td>
        <td class="small muted">${p.rx != null ? `↓ ${bytes(p.tx)} ↑ ${bytes(p.rx)}` : '—'}</td>
        <td>${p.mine?.kind === 'manual' ? `<button class="btn sm danger" data-rmpeer="${esc(p.mine.id)}">Remove</button>` : ''}</td></tr>`;
    }).join('');
    el.querySelector('#wgpeers').innerHTML = srv
      ? `<div class="table-scroll"><table class="data plain"><thead><tr><th>Name</th><th>VPN address / network</th><th>Status</th><th>Traffic</th><th></th></tr></thead><tbody>${rowsHtml || '<tr><td colspan="5" class="muted">No peers yet.</td></tr>'}</tbody></table></div>`
      : '<p class="small muted">The VPN server reports to the Device Manager every minute once its sync service is set up (VPN_SYNC_TOKEN). Until then devices can’t be connected from here.</p>';
  };

  const t = table(el.querySelector('#tbl'), {
    rows,
    search: d => `${d.name} ${d.user || ''} ${d.tailscale?.dnsName || ''} ${(d.tailscale?.ips || []).join(' ')} ${fortiState(d).label} ${tailscaleState(d).label}`,
    empty: 'No devices yet. Enrol devices first under Devices → Enrol devices.',
    cols: [
      { key: 'name', label: 'Device', render: d => `<span class="person">${statusDot(d)}<b>${esc(d.name)}</b></span><div class="small muted" style="margin-top:4px">${esc(d.os)}</div>` },
      { key: 'wg', label: 'GO-Green VPN', render: d => { const s = wgState(d); const r = lastWg(d); return badge(s.label, s.tone) + (d.wireguard?.address ? `<div class="small muted mono" style="margin-top:4px">${esc(d.wireguard.address)}</div>` : '') + (r && (r.status === 'failed' || r.status === 'skipped') ? `<div class="small" style="color:var(--bad);margin-top:4px;max-width:320px">${esc(r.output || 'Failed')}</div>` : ''); }, sort: d => wgState(d).label },
      { key: 'forti', label: 'FortiClient', render: d => { const f = fortiState(d); return badge(f.label, f.tone); }, sort: d => fortiState(d).label },
      { key: 'ts', label: 'Tailscale', render: d => { const s = tailscaleState(d); const r = lastVpn(d); return badge(s.label, s.tone) + (r && r.status === 'failed' ? `<div class="small" style="color:var(--bad);margin-top:4px;max-width:320px">${esc(r.output || 'Failed')}</div>` : ''); }, sort: d => tailscaleState(d).label },
      { key: 'tsaddr', label: 'Tailscale address', render: d => d.tailscale?.ips?.length || d.tailscale?.dnsName ? `<span class="mono">${esc(d.tailscale.ips?.[0] || '')}</span><div class="small muted mono" style="margin-top:4px">${esc(d.tailscale.dnsName || '')}</div>` : '<span class="muted">—</span>', sort: d => d.tailscale?.ips?.[0] || '' },
      { key: 'act', label: '', render: d => { const s = tailscaleState(d); const w = wgState(d); return `<span class="row-actions" style="white-space:nowrap">${w.key === 'connected' || w.key === 'stopped' ? `<button class="btn sm" data-wgleave="${d.id}">Disconnect VPN</button>` : `<button class="btn sm primary" data-wgjoin="${d.id}" ${w.key === 'pending' || !S.state.vpn?.server ? 'disabled' : ''}>Connect VPN</button>`}${s.key === 'connected' || s.key === 'stopped' ? `<button class="btn sm" data-leave="${d.id}">Leave</button>` : `<button class="btn sm primary" data-join="${d.id}" ${s.key === 'pending' || !S.state.tailscaleKey?.set ? 'disabled' : ''}>Join Tailscale</button>`}</span>`; }, sort: () => 0 },
    ],
  });

  const join = (ids, label) => S.devicesAction(ids, 'vpnjoin').then(r => { const n = r.commands.filter(c => c.status === 'queued').length; toast(`${label} will join Tailscale at ${n === 1 ? 'its' : 'their'} next check-in, within about 5 minutes.`); t.draw(); }).catch(() => {});
  el.querySelector('#tbl').addEventListener('click', e => {
    const w = e.target.closest('button[data-wgjoin],button[data-wgleave]');
    if (w) {
      const d = S.device(w.dataset.wgjoin || w.dataset.wgleave);
      if (w.dataset.wgjoin) return confirmBox(`Connect ${d.name} to the GO-Green VPN?`, `The agent installs WireGuard if needed and sets up an always-on tunnel to vpn.go-greentechnologies.com with a key made just for ${esc(d.name)}. It can then reach the company network and domain controllers from anywhere.`, 'Connect',
        () => S.deviceAction(d.id, 'wgjoin').then(r => { const c = r.commands[0]; toast(c?.status === 'skipped' ? c.output : `${d.name} will connect at its next check-in, within about 5 minutes.`, c?.status === 'skipped'); t.draw(); }).catch(() => {}));
      return confirmBox(`Disconnect ${d.name} from the GO-Green VPN?`, 'The agent removes the tunnel and the device’s key is deleted from the VPN server. Outside the office it can no longer reach the company network.', 'Disconnect',
        () => S.deviceAction(d.id, 'wgleave').then(() => { toast(`${d.name} will disconnect at its next check-in.`); t.draw(); }).catch(() => {}), true);
    }
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

  el.querySelector('#wgpeers').addEventListener('click', e => {
    const b = e.target.closest('button[data-rmpeer]'); if (!b) return;
    const p = (S.state.vpn?.peers || []).find(x => x.id === b.dataset.rmpeer);
    confirmBox(`Remove ${p?.name || 'this config'} from the GO-Green VPN?`, 'Its key is deleted from the VPN server within a minute. The device can’t connect again until you make it a new config.', 'Remove',
      () => S.vpnRemovePeer(b.dataset.rmpeer).then(() => toast('Removed. The VPN server drops it within a minute.')).catch(() => {}), true);
  });
  el.querySelector('#wgManual').addEventListener('click', () => {
    modal('GO-Green VPN config for a Mac or phone', `<p class="small muted">Makes a key for one Mac, iPhone, iPad or Android device and downloads its config file. The file contains the device’s private key and can’t be downloaded again, so keep it private (AirDrop or USB, not email).</p>
      <label class="field">Device name<input id="wgname" maxlength="40" placeholder="e.g. GGT-MAC-02"></label>
      <p class="small muted">On the device, install <b>WireGuard</b> from the App Store (or Google Play), choose <b>Import tunnel(s) from file</b>, pick the downloaded file, then <b>Activate</b>. On a Mac, turn on <b>On-Demand</b> in the tunnel’s settings to keep it always on.</p>`,
      [{ label: 'Cancel' }, { label: 'Make and download', cls: 'primary', onClick: m => {
        const name = m.querySelector('#wgname').value.trim();
        if (!/^[A-Za-z0-9._ -]{1,40}$/.test(name)) { toast('Give the device a name (letters, numbers, dots, dashes).', true); return false; }
        S.vpnManualConfig(name).then(r => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([r.config], { type: 'application/octet-stream' }));
          a.download = `GoGreenVPN-${r.name.replace(/[^A-Za-z0-9._-]+/g, '-')}.conf`;
          a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
          toast(`Downloaded the config for ${r.name} (${r.ip}). It works within a minute.`);
        }).catch(() => {});
      } }]);
  });

  const all = () => { summary(); keyInfo(); server(); t.draw(); };
  summary(); keyInfo(); server();
  return { refresh: all };
}
