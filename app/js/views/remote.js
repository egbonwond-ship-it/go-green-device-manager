import * as S from '../store.js';
import { esc, ago, badge, table, toast, confirmBox, statusDot } from '../ui.js';
import { saveFile } from '../agent-setup.js';

// Remote desktop: turn Remote Desktop (Windows) or Screen Sharing (macOS) on or off through the
// agent, and connect from this computer with the app built into the OS. Connections go straight
// from your computer to the device, so they work on the same network or over the company VPN.
const SUPPORTED = ['Windows', 'macOS'];
const onMac = /Mac/i.test(navigator.platform || navigator.userAgent);

const pending = d => S.state.commands.find(c => c.deviceId === d.id && c.type?.startsWith('remote') && (c.status === 'queued' || c.status === 'sent'));
const lastResult = d => S.state.commands.find(c => c.deviceId === d.id && c.type?.startsWith('remote') && c.status !== 'queued' && c.status !== 'sent');

function stateOf(d) {
  if (!SUPPORTED.includes(d.platform)) return { label: 'Not managed', tone: 'neutral' };
  const p = pending(d);
  if (p) return { label: p.type === 'remoteon' ? 'Turning on…' : 'Turning off…', tone: 'warn' };
  if (d.remoteOn === true) return { label: 'On', tone: 'good' };
  if (d.remoteOn === false) return { label: 'Off', tone: 'neutral' };
  return { label: 'Not reported', tone: 'neutral' };
}

export function rdpFile(d) {
  return [
    `full address:s:${d.ip}`,
    'prompt for credentials:i:1',
    'administrative session:i:0',
    'screen mode id:i:2',
    'authentication level:i:2',
    'redirectclipboard:i:1',
    '',
  ].join('\r\n');
}

function connect(d) {
  if (!d.ip) { toast(`${d.name} hasn’t reported an IP address yet.`, true); return; }
  if (d.platform === 'Windows') {
    saveFile(`${d.name.replace(/[^\w.-]+/g, '-')}.rdp`, rdpFile(d), 'application/x-rdp');
    toast(onMac ? 'Open the .rdp file with Windows App (free in the Mac App Store).' : 'Open the downloaded .rdp file to connect.');
  } else {
    location.href = `vnc://${d.ip}`;
    if (!onMac) toast('Opening a VNC viewer. Windows needs one installed, for example RealVNC Viewer.');
  }
}

export default function remote(el) {
  el.innerHTML = `<div class="page-head"><div><h1>Remote desktop</h1><p class="muted">Connect to Windows PCs with Remote Desktop and to Macs with Screen Sharing. Turn remote access on here and the device’s agent sets it up at its next check-in, within about 5 minutes.</p></div></div>
    <div class="notice" style="margin-bottom:12px">Your computer connects straight to the device’s IP address, so it has to be on the same office network or connected to the company VPN. You sign in with an account on that device. Remote access isn’t exposed to the internet.</div>
    <div id="tbl"></div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><h3>Connecting to a Windows PC</h3><p class="small muted" style="margin-top:6px">Select <b>Connect</b> to download a Remote Desktop file and open it. On Windows it opens Remote Desktop Connection; on a Mac install <b>Windows App</b> from the App Store first. Sign in with a Windows account that’s an administrator or in the Remote Desktop Users group. Windows Home editions can’t accept connections.</p></div>
      <div class="card"><h3>Connecting to a Mac</h3><p class="small muted" style="margin-top:6px">Select <b>Connect</b> to open Screen Sharing (built into macOS) and sign in with a user account on that Mac. From Windows, install a VNC viewer such as RealVNC Viewer. If macOS refuses to turn Screen Sharing on remotely, turn it on once in <b>System Settings → General → Sharing</b> on that Mac.</p></div>
    </div>`;
  const rows = () => S.state.devices.filter(d => d.platform !== 'Linux' || d.remoteOn != null).sort((a, b) => a.name.localeCompare(b.name));
  const t = table(el.querySelector('#tbl'), {
    rows,
    search: d => `${d.name} ${d.user || ''} ${d.ip} ${d.os}`,
    empty: S.state.devices.length ? 'No Windows or Mac devices yet.' : 'No devices yet. Enrol devices first under Devices → Enrol devices.',
    cols: [
      { key: 'name', label: 'Device', render: d => `<span class="person">${statusDot(d)}<b>${esc(d.name)}</b></span>` },
      { key: 'os', label: 'Operating system' },
      { key: 'ip', label: 'IP address', render: d => d.ip ? `<span class="mono">${esc(d.ip)}</span>` : '<span class="muted">—</span>' },
      { key: 'user', label: 'Signed-in user', render: d => d.user ? esc(d.user) : '<span class="muted">—</span>' },
      { key: 'remote', label: 'Remote access', render: d => { const s = stateOf(d); const r = lastResult(d); return badge(s.label, s.tone) + (r && r.status === 'failed' ? `<div class="small" style="color:var(--bad);margin-top:4px;max-width:320px">${esc(r.output || 'Failed')}</div>` : ''); }, sort: d => stateOf(d).label },
      { key: 'act', label: '', render: d => !SUPPORTED.includes(d.platform) ? '' : `<span class="row-actions" style="white-space:nowrap">
          <button class="btn sm primary" data-connect="${d.id}" ${d.remoteOn && d.ip ? '' : 'disabled title="Turn remote access on first"'}>Connect</button>
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
      on ? `The agent turns on ${what} and opens it in the firewall. Anyone on the network with an account on ${esc(d.name)} can then sign in remotely.` : `The agent turns off ${what}. Open remote sessions end.`,
      on ? 'Turn on' : 'Turn off',
      () => S.deviceAction(d.id, on ? 'remoteon' : 'remoteoff').then(() => { toast(`${what} will turn ${on ? 'on' : 'off'} at ${d.name}’s next check-in${d.online ? ', within about 5 minutes' : ' when it comes online'}.`); t.draw(); }).catch(err => toast(err.message, true)),
      !on);
  });
  return { refresh: t.draw };
}
