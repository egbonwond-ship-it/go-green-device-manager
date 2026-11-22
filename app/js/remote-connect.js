// How to reach a device for remote desktop, and how to sign in to it. No DOM here, so the smoke
// test can check it in Node.
//
// Inside the domain: connect by the device's domain name so Windows can use Kerberos, and sign in
// as DOMAIN\user. Outside the domain (workgroup or Microsoft Entra joined PCs, Macs that aren't
// bound): connect by address and sign in as PC-NAME\user, AzureAD\user or with Entra sign-in.
// Outside the office: connect over Tailscale, or through a Remote Desktop Gateway if one is set.

const v4 = ip => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip || '');
const octets = ip => String(ip).split('.').map(Number);
export const isPrivate = ip => { if (!v4(ip)) return false; const [a, b] = octets(ip); return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); };
export const isMesh = ip => { if (!v4(ip)) return false; const [a, b] = octets(ip); return a === 100 && b >= 64 && b <= 127; }; // Tailscale's 100.64.0.0/10

export const DEFAULT_PORT = { Windows: 3389, macOS: 5900 };
export const inDomain = d => d.joinType === 'Domain' || d.joinType === 'Hybrid';
export const JOIN_LABEL = { Domain: 'Domain', Hybrid: 'Domain + Entra', Entra: 'Microsoft Entra', Workgroup: 'Workgroup' };

// Every way to reach the device, best first within each kind.
export function addresses(d) {
  const out = [], seen = new Set();
  const add = (value, kind, label) => { if (value && !seen.has(value.toLowerCase())) { seen.add(value.toLowerCase()); out.push({ value, kind, label }); } };
  const ts = d.tailscale || {};
  if (ts.dnsName) add(ts.dnsName, 'mesh', 'Tailscale name');
  for (const ip of ts.ips || []) add(ip, 'mesh', 'Tailscale address');
  if (d.fqdn) add(d.fqdn, 'name', inDomain(d) ? 'Domain name' : 'Network name');
  for (const ip of d.ips?.length ? d.ips : d.ip ? [d.ip] : []) add(ip, isMesh(ip) ? 'mesh' : isPrivate(ip) ? 'lan' : 'public', isMesh(ip) ? 'Mesh VPN address' : isPrivate(ip) ? 'Local network address' : 'Public address');
  return out;
}

// true: the browser and the device reach the internet from the same address, so they share a network.
// false: they're on different networks. null: not known (older agent, or a local run).
export function sameNetwork(d, viewerIp) {
  if (!viewerIp || !d.publicIp) return null;
  return viewerIp === d.publicIp;
}

// The address to use, and why, for this device as seen from this browser.
export function route(d, { viewerIp = null, gateway = '' } = {}) {
  const list = addresses(d);
  const first = kind => list.find(a => a.kind === kind);
  const local = (inDomain(d) && first('name')) || first('lan') || first('name') || first('public');
  const mesh = first('mesh');
  const same = sameNetwork(d, viewerIp);
  if (same !== false && local) return { address: local, gateway: false, why: same ? 'This device is on the same network as you.' : 'Connecting over the local network or VPN.' };
  if (mesh) return { address: mesh, gateway: false, why: d.tailscale?.online === false ? 'Using Tailscale. Tailscale reported it was not running on this device, so start it there if this fails.' : 'This device is on another network, so the connection goes over Tailscale.' };
  if (gateway && local) return { address: local, gateway: true, why: `This device is on another network, so the connection goes through the Remote Desktop Gateway ${gateway}.` };
  if (local) return { address: local, gateway: false, why: 'This device is on another network and doesn’t have Tailscale. Connect to the company VPN first, or install Tailscale on it.', warn: true };
  return { address: list[0] || null, gateway: false, why: '' };
}

const userPart = u => String(u || '').split('\\').pop().split('@')[0];

// The account to suggest at the sign-in prompt.
export function suggestedUser(d) {
  const u = d.user || '';
  const prefix = u.includes('\\') ? u.split('\\')[0] : '';
  const name = userPart(u);
  if (inDomain(d)) {
    if (prefix && prefix.toLowerCase() !== String(d.name).toLowerCase() && prefix !== 'AzureAD') return u;
    const dom = d.netbiosDomain || d.domain;
    return dom && name ? `${dom}\\${name}` : '';
  }
  if (d.platform === 'Windows' && d.joinType === 'Entra') return prefix === 'AzureAD' ? u : '';
  if (d.platform === 'Windows') return name ? `${d.name}\\${name}` : '';
  return name; // macOS: the short user name
}

// A .rdp file. opts: { address, port, user, gateway, entra }
export function rdpFile(d, opts = {}) {
  const host = opts.address || d.ip;
  const port = Number(opts.port) || DEFAULT_PORT.Windows;
  const lines = [
    `full address:s:${port === DEFAULT_PORT.Windows ? host : `${host}:${port}`}`,
    'prompt for credentials:i:1',
    'administrative session:i:0',
    'screen mode id:i:2',
    // 2: warn but allow when the PC's certificate can't be verified, which is normal outside the domain.
    'authentication level:i:2',
    'redirectclipboard:i:1',
  ];
  if (opts.user) lines.push(`username:s:${opts.user}`);
  if (opts.entra) lines.push('enablerdsaadauth:i:1');
  if (opts.gateway) lines.push(`gatewayhostname:s:${opts.gateway}`, 'gatewayusagemethod:i:1', 'gatewaycredentialssource:i:0', 'gatewayprofileusagemethod:i:1', 'promptcredentialonce:i:1');
  lines.push('');
  return lines.join('\r\n');
}

export function vncUrl(d, opts = {}) {
  const host = opts.address || d.ip;
  const port = Number(opts.port) || DEFAULT_PORT.macOS;
  const user = opts.user ? `${encodeURIComponent(opts.user)}@` : '';
  return `vnc://${user}${host.includes(':') ? `[${host}]` : host}${port === DEFAULT_PORT.macOS ? '' : `:${port}`}`;
}
