import * as S from '../store.js';
import { esc, badge, table, toast, confirmBox, statusDot, fmtN, ago } from '../ui.js';
import { saveFile } from '../agent-setup.js';
import { vpnConf, windowsVpnSetup } from '../vpn-installer.js';

// VPN: the company's VPNs side by side.
//   Go-Green VPN the company's own WireGuard server in Azure (vpn.go-greentechnologies.com), which
//                reaches the domain controllers. The agent sets it up on Windows and Linux; any other
//                computer, Macs included, gets a downloaded installer.
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

const pendingGg = d => S.state.commands.find(c => c.deviceId === d.id && c.type?.startsWith('ggvpn') && (c.status === 'queued' || c.status === 'sent'));
const lastGg = d => S.state.commands.find(c => c.deviceId === d.id && c.type?.startsWith('ggvpn') && c.status !== 'queued' && c.status !== 'sent');
export function ggvpnState(d) {
  const p = pendingGg(d);
  if (p) return { label: p.type === 'ggvpnon' ? 'Connecting…' : 'Disconnecting…', tone: 'warn', key: 'pending' };
  const g = d.ggvpn, r = g?.reported;
  if (g?.wanted) {
    if (r?.up && r.handshakeAgeSec != null && r.handshakeAgeSec < 300) return { label: 'Connected', tone: 'good', key: 'connected' };
    if (r?.up) return { label: 'Waiting for the server', tone: 'warn', key: 'waiting' };
    return { label: 'Not running', tone: 'bad', key: 'down' };
  }
  if (r?.up) return { label: 'On (not approved)', tone: 'warn', key: 'stray' };
  if (d.platform === 'macOS') return { label: 'Use a Mac installer', tone: 'neutral', key: 'mac' };
  return { label: 'Off', tone: 'neutral', key: 'off' };
}

export default function vpn(el) {
  el.innerHTML = `<div class="page-head"><div><h1>VPN</h1><p class="muted">The Go-Green VPN to the office network and domain, FortiClient, and Tailscale for remote desktop from anywhere.</p></div>
      <div class="actions"><button class="btn primary" id="joinAll">Join all to Tailscale</button></div></div>
    <div class="stats" id="sum"></div>
    <div id="ggsetup" style="margin-top:16px"></div>
    <div id="tbl" style="margin-top:16px"></div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card stack"><h3>Go-Green VPN installers</h3>
        <p class="small muted">For any Windows PC or Mac, enrolled or not. Each installer has its own key and can only be used on one computer. The key is in the download only, so keep the file private and delete it after installing. Revoke an installer and that computer drops off the VPN within a minute.</p>
        <div class="row-actions" style="flex-wrap:wrap;gap:8px">
          <label class="field" style="flex:1;min-width:180px">Computer name<input id="ggname" class="mono" autocomplete="off" placeholder="GGT-LAPTOP-02" maxlength="40"></label>
          <label class="field">For<select id="ggplat"><option value="Windows">Windows</option><option value="macOS">Mac</option></select></label>
        </div>
        <div class="row-actions"><button class="btn sm primary" id="ggmake">Create and download installer</button></div>
        <div id="ggclients"></div></div>
      <div class="card stack"><h3>How the Go-Green VPN works</h3>
        <p class="small muted">The VPN server in Azure, <span class="mono" id="ggep"></span>, connects computers to the office network and the domain controllers, so people can sign in with their go-greentechnologies.com accounts from anywhere.</p>
        <p class="small muted"><b>Connect</b> on an enrolled Windows or Linux device makes the agent install WireGuard, create the device’s own key (it never leaves the device) and start an always-on tunnel. Macs use an installer: install <b>WireGuard</b> from the Mac App Store, choose <b>Import Tunnel(s) from File</b>, pick the downloaded file and select <b>Activate</b>.</p>
        <p class="small muted" id="ggsync"></p></div>
    </div>
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
    const gg = ds.filter(d => ggvpnState(d).key === 'connected').length + (S.state.vpnClients || []).length;
    el.querySelector('#sum').innerHTML = tile('Go-Green VPN', gg, `${fmtN(ds.filter(d => ggvpnState(d).key === 'connected').length)} connected by agent, ${fmtN((S.state.vpnClients || []).length)} by installer`) + tile('On Tailscale', ts, `of ${fmtN(ds.length)} devices`) + tile('FortiClient installed', fi, `of ${fmtN(ds.length)} devices`) + tile('FortiClient connected now', fc, 'reported at last check-in');
  };
  const ggInfo = () => {
    const g = S.state.ggvpn || {};
    el.querySelector('#ggep').textContent = g.endpoint || 'vpn.go-greentechnologies.com:51820';
    el.querySelector('#ggsetup').innerHTML = g.configured && g.syncConfigured ? '' : `<div class="notice">The Go-Green VPN isn’t fully set up in the Device Manager yet. In Azure, add the application settings ${g.configured ? '' : '<span class="mono">GGVPN_SERVER_PUBKEY</span> (the VPN server’s public key) and '}<span class="mono">GGVPN_SYNC_TOKEN</span>, then install the peer sync on the VPN server (see <span class="mono">vpn-server/install.sh</span> in the repository).</div>`;
    el.querySelector('#ggsync').innerHTML = g.lastSync ? `The VPN server last picked up the list of computers ${ago(g.lastSync)} (${fmtN(g.lastSyncPeers || 0)} on it). It checks every minute.` : g.syncConfigured ? 'The VPN server hasn’t picked up the list of computers yet. Install the peer sync on it.' : '';
    el.querySelector('#ggmake').disabled = !g.configured;
    const cs = [...(S.state.vpnClients || [])].sort((a, b) => a.name.localeCompare(b.name));
    el.querySelector('#ggclients').innerHTML = cs.length ? `<div class="table-scroll"><table class="data plain small"><thead><tr><th>Computer</th><th>For</th><th>VPN address</th><th>Created</th><th></th></tr></thead><tbody>${cs.map(c => `<tr><td><b>${esc(c.name)}</b></td><td>${c.platform === 'macOS' ? 'Mac' : 'Windows'}</td><td class="mono">${esc(c.address)}</td><td>${ago(c.created)}${c.by ? `<div class="muted">${esc(c.by)}</div>` : ''}</td><td><button class="btn sm danger" data-revoke="${esc(c.id)}">Revoke</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="small muted">No installers yet.</p>';
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
    search: d => `${d.name} ${d.user || ''} ${d.ggvpn?.address || ''} ${ggvpnState(d).label} ${d.tailscale?.dnsName || ''} ${(d.tailscale?.ips || []).join(' ')} ${fortiState(d).label} ${tailscaleState(d).label}`,
    empty: 'No devices yet. Enrol devices first under Devices → Enrol devices.',
    cols: [
      { key: 'name', label: 'Device', render: d => `<span class="person">${statusDot(d)}<b>${esc(d.name)}</b></span><div class="small muted" style="margin-top:4px">${esc(d.os)}</div>` },
      { key: 'gg', label: 'Go-Green VPN', render: d => { const g = ggvpnState(d); const r = lastGg(d); return badge(g.label, g.tone) + (d.ggvpn?.address ? `<div class="small muted mono" style="margin-top:4px">${esc(d.ggvpn.address)}</div>` : '') + (r && r.status === 'failed' ? `<div class="small" style="color:var(--bad);margin-top:4px;max-width:320px">${esc(r.output || 'Failed')}</div>` : ''); }, sort: d => ggvpnState(d).label },
      { key: 'forti', label: 'FortiClient', render: d => { const f = fortiState(d); return badge(f.label, f.tone); }, sort: d => fortiState(d).label },
      { key: 'ts', label: 'Tailscale', render: d => { const s = tailscaleState(d); const r = lastVpn(d); return badge(s.label, s.tone) + (r && r.status === 'failed' ? `<div class="small" style="color:var(--bad);margin-top:4px;max-width:320px">${esc(r.output || 'Failed')}</div>` : ''); }, sort: d => tailscaleState(d).label },
      { key: 'tsaddr', label: 'Tailscale address', render: d => d.tailscale?.ips?.length || d.tailscale?.dnsName ? `<span class="mono">${esc(d.tailscale.ips?.[0] || '')}</span><div class="small muted mono" style="margin-top:4px">${esc(d.tailscale.dnsName || '')}</div>` : '<span class="muted">—</span>', sort: d => d.tailscale?.ips?.[0] || '' },
      { key: 'act', label: '', render: d => { const s = tailscaleState(d); const g = ggvpnState(d); return `<span class="row-actions" style="white-space:nowrap">${
          ['Windows', 'Linux'].includes(d.platform) ? (d.ggvpn?.wanted ? `<button class="btn sm" data-ggoff="${d.id}" ${g.key === 'pending' ? 'disabled' : ''}>Disconnect VPN</button>` : `<button class="btn sm primary" data-ggon="${d.id}" ${g.key === 'pending' || !S.state.ggvpn?.configured ? 'disabled' : ''}>Connect VPN</button>`) : ''}${s.key === 'connected' || s.key === 'stopped' ? `<button class="btn sm" data-leave="${d.id}">Leave</button>` : `<button class="btn sm primary" data-join="${d.id}" ${s.key === 'pending' || !S.state.tailscaleKey?.set ? 'disabled' : ''}>Join Tailscale</button>`}</span>`; }, sort: () => 0 },
    ],
  });

  const join = (ids, label) => S.devicesAction(ids, 'vpnjoin').then(r => { const n = r.commands.filter(c => c.status === 'queued').length; toast(`${label} will join Tailscale at ${n === 1 ? 'its' : 'their'} next check-in, within about 5 minutes.`); t.draw(); }).catch(() => {});
  el.querySelector('#tbl').addEventListener('click', e => {
    const g = e.target.closest('button[data-ggon],button[data-ggoff]');
    if (g) {
      const d = S.device(g.dataset.ggon || g.dataset.ggoff);
      if (g.dataset.ggon) return confirmBox(`Connect ${d.name} to the Go-Green VPN?`, `The agent installs WireGuard if needed, makes this device’s own VPN key and starts an always-on tunnel to the office network. ${esc(d.name)} can then reach the domain controllers from anywhere.`, 'Connect',
        () => S.deviceAction(d.id, 'ggvpnon').then(() => { toast(`${d.name} connects at its next check-in${d.online ? ', within about 5 minutes' : ' when it comes online'}.`); t.draw(); }).catch(() => {}));
      return confirmBox(`Disconnect ${d.name} from the Go-Green VPN?`, 'The VPN server stops accepting this device straight away, and the agent removes the tunnel at its next check-in.', 'Disconnect',
        () => S.deviceAction(d.id, 'ggvpnoff').then(() => { toast(`${d.name} is off the Go-Green VPN.`); t.draw(); }).catch(() => {}), true);
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

  el.querySelector('#ggmake').addEventListener('click', async () => {
    const name = el.querySelector('#ggname').value.trim(), platform = el.querySelector('#ggplat').value;
    if (!/^[A-Za-z0-9][\w.-]{0,39}$/.test(name)) { toast('Type the computer’s name: letters, numbers, dashes or dots.', true); return; }
    const btn = el.querySelector('#ggmake'); btn.disabled = true;
    try {
      const r = await S.createVpnClient(name, platform);
      const opts = { name: r.client.name, address: r.client.address, privateKey: r.privateKey, server: r.server };
      if (platform === 'Windows') saveFile(`GoGreenVPN-Setup-${r.client.name}.cmd`, windowsVpnSetup(opts), 'application/octet-stream');
      else saveFile(`GoGreenVPN-${r.client.name}.conf`, vpnConf(opts), 'application/octet-stream');
      el.querySelector('#ggname').value = '';
      toast(platform === 'Windows' ? `Downloaded the installer for ${r.client.name}. Copy it to that PC and double-click it.` : `Downloaded the VPN file for ${r.client.name}. Import it in the WireGuard app on that Mac.`);
    } catch { /* error shown already */ } finally { btn.disabled = !S.state.ggvpn?.configured; }
  });
  el.querySelector('#ggclients').addEventListener('click', e => {
    const b = e.target.closest('button[data-revoke]'); if (!b) return;
    const c = (S.state.vpnClients || []).find(x => x.id === b.dataset.revoke); if (!c) return;
    confirmBox(`Revoke the VPN installer for ${c.name}?`, `${esc(c.name)} drops off the Go-Green VPN within a minute and its installer stops working. You can create a new one afterwards.`, 'Revoke',
      () => S.revokeVpnClient(c.id).then(() => toast(`Revoked ${c.name}`)).catch(() => {}), true);
  });

  const all = () => { summary(); ggInfo(); keyInfo(); t.draw(); };
  summary(); ggInfo(); keyInfo();
  return { refresh: all };
}
