import * as S from '../store.js';
import { esc, badge, table, toast, confirmBox, modal, statusDot } from '../ui.js';
import { saveFile } from '../agent-setup.js';
import { addresses, route, suggestedUser, rdpFile, vncUrl, inDomain, sameNetwork, DEFAULT_PORT, JOIN_LABEL } from '../remote-connect.js';

// Remote desktop: turn Remote Desktop (Windows) or Screen Sharing (macOS) on or off through the
// agent, and connect from this computer with the app built into the OS. Works for devices in the
// domain and outside it (workgroup, Microsoft Entra joined, unbound Macs), on the office network,
// over the company VPN, over Tailscale, or through a Remote Desktop Gateway.
const SUPPORTED = ['Windows', 'macOS'];
const onMac = /Mac/i.test(navigator.platform || navigator.userAgent);
export { rdpFile };

const pending = d => S.state.commands.find(c => c.deviceId === d.id && c.type?.startsWith('remote') && (c.status === 'queued' || c.status === 'sent'));
const lastResult = d => S.state.commands.find(c => c.deviceId === d.id && c.type?.startsWith('remote') && c.status !== 'queued' && c.status !== 'sent');
const gateway = () => S.state.settings?.rdGateway || '';

function stateOf(d) {
  if (!SUPPORTED.includes(d.platform)) return { label: 'Not managed', tone: 'neutral' };
  const p = pending(d);
  if (p) return { label: p.type === 'remoteon' ? 'Turning on…' : 'Turning off…', tone: 'warn' };
  if (d.remoteOn === true) return { label: 'On', tone: 'good' };
  if (d.remoteOn === false) return { label: 'Off', tone: 'neutral' };
  return { label: 'Not reported', tone: 'neutral' };
}

function networkCell(d) {
  const join = d.joinType ? badge(JOIN_LABEL[d.joinType] || d.joinType, inDomain(d) ? 'good' : 'neutral') : '<span class="muted">—</span>';
  const dom = d.domain ? `<div class="small muted mono" style="margin-top:4px">${esc(d.domain)}</div>` : '';
  return join + dom;
}

function reachCell(d) {
  const same = sameNetwork(d, S.state.viewerIp);
  const ts = d.tailscale?.ips?.length || d.tailscale?.dnsName;
  const bits = [];
  if (same === true) bits.push(badge('Same network as you', 'good'));
  else if (same === false) bits.push(badge('Another network', 'warn'));
  if (ts) bits.push(badge('Tailscale', d.tailscale.online === false ? 'neutral' : 'good'));
  return bits.join(' ') || '<span class="muted">—</span>';
}

function addressCell(d) {
  const a = addresses(d);
  if (!a.length) return '<span class="muted">—</span>';
  return `<span class="mono">${esc(a.find(x => x.kind === 'lan')?.value || a[0].value)}</span>${a.length > 1 ? `<div class="small muted" style="margin-top:4px">+${a.length - 1} more</div>` : ''}`;
}

function connect(d) {
  const list = addresses(d);
  if (!list.length) { toast(`${d.name} hasn’t reported an address yet.`, true); return; }
  const gw = gateway();
  const r = route(d, { viewerIp: S.state.viewerIp, gateway: gw });
  const win = d.platform === 'Windows';
  const entraDefault = win && d.joinType === 'Entra';
  const port = d.rdpPort || DEFAULT_PORT[d.platform];
  const opts = list.map(a => `<option value="${esc(a.value)}" ${a.value === r.address?.value ? 'selected' : ''}>${esc(a.label)}: ${esc(a.value)}</option>`).join('');
  const accountHelp = !win ? 'A user account on this Mac (its short name).'
    : inDomain(d) ? `A domain account, written ${esc(d.netbiosDomain || d.domain || 'DOMAIN')}\\name, that’s an administrator or in Remote Desktop Users on this PC.`
    : d.joinType === 'Entra' ? 'With Microsoft Entra sign-in you sign in with your work email in a browser window. Without it, type AzureAD\\you@company.com and your password.'
    : `This PC isn’t in the domain, so sign in with an account on the PC itself, written ${esc(d.name)}\\name (or .\\name). For a Microsoft account, type its email and password, not the PIN.`;
  const m = modal(`Connect to ${d.name}`, `<div class="form-grid">
      <label class="field wide">Connect to<select id="addr">${opts}<option value="">Another name or address…</option></select></label>
      <label class="field wide" id="otherRow" style="display:none">Name or address<input id="other" class="mono" placeholder="pc01.example.com or 203.0.113.10"></label>
      <label class="field">Port<input id="port" type="number" min="1" max="65535" value="${port}"></label>
      <label class="field">User name<input id="user" class="mono" value="${esc(suggestedUser(d))}" placeholder="${win ? 'DOMAIN\\name or PC\\name' : 'name'}"></label>
      ${win && gw ? `<label class="field check wide">Go through the Remote Desktop Gateway (${esc(gw)})<input type="checkbox" id="gw" ${r.gateway ? 'checked' : ''}></label>` : ''}
      ${win && (d.joinType === 'Entra' || d.joinType === 'Hybrid') ? `<label class="field check wide">Use Microsoft Entra sign-in<input type="checkbox" id="entra" ${entraDefault ? 'checked' : ''}></label>` : ''}
    </div>
    <p class="small ${r.warn ? '' : 'muted'}" id="why" style="margin-top:10px;${r.warn ? 'color:var(--warn)' : ''}">${esc(r.why)}</p>
    <p class="small muted" style="margin-top:6px">${accountHelp}</p>`,
  [{ label: 'Cancel' }, { label: win ? 'Download .rdp file' : 'Open Screen Sharing', cls: 'primary', onClick: el => {
    const val = id => el.querySelector('#' + id);
    let address = val('addr').value || val('other').value.trim();
    let p = Number(val('port').value) || port;
    const hp = address.match(/^([^:\s]+):(\d{1,5})$/); if (hp) { address = hp[1]; p = Number(hp[2]); }
    if (!/^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(address)) { toast('Type a computer name or IP address.', true); return false; }
    const o = { address, port: p, user: val('user').value.trim(), gateway: val('gw')?.checked ? gw : '', entra: !!val('entra')?.checked };
    if (win) {
      saveFile(`${d.name.replace(/[^\w.-]+/g, '-')}.rdp`, rdpFile(d, o), 'application/x-rdp');
      toast(onMac ? 'Open the .rdp file with Windows App (free in the Mac App Store).' : 'Open the downloaded .rdp file to connect.');
    } else {
      location.href = vncUrl(d, o);
      if (!onMac) toast('Opening a VNC viewer. Windows needs one installed, for example RealVNC Viewer.');
    }
  } }]);
  m.el.querySelector('#addr').addEventListener('change', e => { m.el.querySelector('#otherRow').style.display = e.target.value ? 'none' : ''; });
}

export default function remote(el) {
  el.innerHTML = `<div class="page-head"><div><h1>Remote desktop</h1><p class="muted">Connect to Windows PCs with Remote Desktop and to Macs with Screen Sharing, in the domain or outside it. Turn remote access on here and the device’s agent sets it up at its next check-in, within about 5 minutes.</p></div></div>
    <div class="notice info" style="margin-bottom:12px">On the office network or VPN, <b>Connect</b> uses the device’s domain name (or its local address for PCs outside the domain). When a device is on another network, it connects over <b>Tailscale</b> if the device has it${gateway() ? `, otherwise through the Remote Desktop Gateway <b>${esc(gateway())}</b>` : ''}. Remote access is never opened to the internet.</div>
    <div id="tbl"></div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><h3>Connecting to a Windows PC</h3><p class="small muted" style="margin-top:6px">Select <b>Connect</b> to download a Remote Desktop file and open it. On Windows it opens Remote Desktop Connection; on a Mac install <b>Windows App</b> from the App Store first. Windows Home editions can’t accept connections.</p>
        <p class="small muted" style="margin-top:6px"><b>In the domain:</b> sign in as DOMAIN\\name. <b>Workgroup PCs:</b> sign in with an account on that PC, as PC-NAME\\name. <b>Microsoft Entra joined PCs:</b> use Entra sign-in, or AzureAD\\you@company.com. The account must be an administrator or in the Remote Desktop Users group.</p></div>
      <div class="card"><h3>Connecting to a Mac</h3><p class="small muted" style="margin-top:6px">Select <b>Connect</b> to open Screen Sharing (built into macOS) and sign in with a user account on that Mac. From Windows, install a VNC viewer such as RealVNC Viewer. If macOS refuses to turn Screen Sharing on remotely, turn it on once in <b>System Settings → General → Sharing</b> on that Mac.</p></div>
      <div class="card"><h3>Devices outside the office</h3><p class="small muted" style="margin-top:6px">Install <b>Tailscale</b> on the devices and on your computer, signed in to the company’s Tailscale network. Join devices with one click on the <a href="#/vpn">VPN</a> page. The agent reports each device’s Tailscale address, and <b>Connect</b> uses it whenever the device isn’t on your network, even behind a home router.</p></div>
      <div class="card"><h3>Remote Desktop Gateway</h3><p class="small muted" style="margin-top:6px">If the company has a Remote Desktop Gateway, add its name under <b>Administration → Remote desktop</b>. Windows connections to devices on another network that don’t have Tailscale then go through it. A gateway reaches only devices on the office network.</p></div>
    </div>`;
  const rows = () => S.state.devices.filter(d => d.platform !== 'Linux' || d.remoteOn != null).sort((a, b) => a.name.localeCompare(b.name));
  const t = table(el.querySelector('#tbl'), {
    rows,
    search: d => `${d.name} ${d.user || ''} ${(d.ips || []).join(' ')} ${d.fqdn || ''} ${d.domain || ''} ${d.joinType || ''} ${d.os}`,
    empty: S.state.devices.length ? 'No Windows or Mac devices yet.' : 'No devices yet. Enrol devices first under Devices → Enrol devices.',
    cols: [
      { key: 'name', label: 'Device', render: d => `<span class="person">${statusDot(d)}<b>${esc(d.name)}</b></span><div class="small muted" style="margin-top:4px">${esc(d.os)}</div>` },
      { key: 'joinType', label: 'Domain', render: networkCell, sort: d => `${d.joinType || ''} ${d.domain || ''}` },
      { key: 'ip', label: 'Address', render: addressCell },
      { key: 'reach', label: 'Network', render: reachCell, sort: d => String(sameNetwork(d, S.state.viewerIp)) },
      { key: 'user', label: 'Signed-in user', render: d => d.user ? esc(d.user) : '<span class="muted">—</span>' },
      { key: 'remote', label: 'Remote access', render: d => { const s = stateOf(d); const r = lastResult(d); return badge(s.label, s.tone) + (r && r.status === 'failed' ? `<div class="small" style="color:var(--bad);margin-top:4px;max-width:320px">${esc(r.output || 'Failed')}</div>` : ''); }, sort: d => stateOf(d).label },
      { key: 'act', label: '', render: d => !SUPPORTED.includes(d.platform) ? '' : `<span class="row-actions" style="white-space:nowrap">
          <button class="btn sm primary" data-connect="${d.id}" ${d.remoteOn && addresses(d).length ? '' : 'disabled title="Turn remote access on first"'}>Connect</button>
          ${d.remoteOn ? `<button class="btn sm" data-off="${d.id}">Turn off</button>` : `<button class="btn sm" data-on="${d.id}" ${pending(d) ? 'disabled' : ''}>Turn on</button>`}</span>`, sort: () => 0 },
    ],
  });
  el.querySelector('#tbl').addEventListener('click', e => {
    const b = e.target.closest('button[data-connect],button[data-on],button[data-off]'); if (!b) return;
    const d = S.device(b.dataset.connect || b.dataset.on || b.dataset.off);
    if (b.dataset.connect) return connect(d);
    const on = !!b.dataset.on;
    const what = d.platform === 'Windows' ? 'Remote Desktop' : 'Screen Sharing';
    confirmBox(`${on ? 'Turn on' : 'Turn off'} ${what} on ${d.name}?`,
      on ? `The agent turns on ${what} and opens it in the firewall. Anyone who can reach ${esc(d.name)} on the network or over Tailscale and has an account on it can then sign in remotely.` : `The agent turns off ${what}. Open remote sessions end.`,
      on ? 'Turn on' : 'Turn off',
      () => S.deviceAction(d.id, on ? 'remoteon' : 'remoteoff').then(() => { toast(`${what} will turn ${on ? 'on' : 'off'} at ${d.name}’s next check-in${d.online ? ', within about 5 minutes' : ' when it comes online'}.`); t.draw(); }).catch(err => toast(err.message, true)),
      !on);
  });
  return { refresh: t.draw };
}
