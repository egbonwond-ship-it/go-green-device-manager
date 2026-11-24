#!/usr/bin/env python3
"""Keeps the GO-Green VPN server's WireGuard peers in step with the Device Manager.

Runs every minute (ggt-vpn-sync.timer). Reports every peer's last handshake and traffic to
POST <GGT_DM_URL>/api/vpn/sync and adds or removes the peers the Device Manager manages.
Peers written by hand in /etc/wireguard/wg0.conf are reported but never changed.
Settings in /etc/ggt-vpn-sync.env: GGT_DM_URL, VPN_SYNC_TOKEN (and optional GGT_VPN_ENDPOINT,
GGT_VPN_ALLOWED_IPS, GGT_VPN_DNS for the client configs the Device Manager hands out).
"""
import json, os, re, subprocess, sys, tempfile, urllib.request

IFACE = 'wg0'
CONF = '/etc/wireguard/%s.conf' % IFACE
STATE = '/var/lib/ggt-vpn-sync/managed.json'


def env():
    vals = {}
    with open('/etc/ggt-vpn-sync.env') as f:
        for line in f:
            m = re.match(r'^\s*([A-Z_]+)\s*=\s*"?([^"\n]*)"?\s*$', line)
            if m:
                vals[m.group(1)] = m.group(2)
    return vals


def wg(*args, stdin=None):
    return subprocess.run(['wg'] + list(args), input=stdin, capture_output=True, text=True, check=True).stdout


def hand_peers():
    """Public key -> name for peers in wg0.conf (name from the '# ...' comment in the [Peer] block)."""
    names, name, out = {}, None, {}
    for line in open(CONF):
        s = line.strip()
        if s.lower() == '[peer]':
            name = None
        elif s.startswith('#'):
            name = re.sub(r'\s*\(.*\)\s*$', '', s.lstrip('# ').strip()) or name
        else:
            m = re.match(r'(?i)^PublicKey\s*=\s*(\S+)', s)
            if m:
                out[m.group(1)] = name
    return out


def main():
    e = env()
    url = e['GGT_DM_URL'].rstrip('/') + '/api/vpn/sync'
    hand = hand_peers()
    try:
        managed = set(json.load(open(STATE)))
    except (OSError, ValueError):
        managed = set()
    lines = wg('show', IFACE, 'dump').splitlines()
    server_pub = lines[0].split('\t')[1]
    live, peers = {}, []
    for l in lines[1:]:
        pub, _psk, ep, ips, hs, rx, tx, _ka = l.split('\t')
        live[pub] = ips
        peers.append({'publicKey': pub, 'name': hand.get(pub), 'allowedIps': [] if ips == '(none)' else ips.split(','),
                      'endpoint': None if ep == '(none)' else ep, 'latestHandshake': int(hs) * 1000 or None,
                      'rx': int(rx), 'tx': int(tx), 'managed': pub in managed})
    body = {'publicKey': server_pub, 'endpoint': e.get('GGT_VPN_ENDPOINT', 'vpn.go-greentechnologies.com:51820'),
            'allowedIps': e.get('GGT_VPN_ALLOWED_IPS', '10.99.0.0/24, 172.16.29.0/24'),
            'dns': e.get('GGT_VPN_DNS', '172.16.29.10, 172.16.29.11, go-greentechnologies.com'), 'peers': peers}
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST',
                                 headers={'Content-Type': 'application/json', 'x-ggt-vpn-token': e['VPN_SYNC_TOKEN'], 'User-Agent': 'ggt-vpn-sync'})
    with urllib.request.urlopen(req, timeout=30) as r:
        want = json.load(r).get('peers') or []

    hand_ips = {ip.split('/')[0] for pub in hand for ip in live.get(pub, '').split(',') if ip}
    desired = {}
    for p in want:
        pub, ip, psk = p.get('publicKey', ''), p.get('ip', ''), p.get('presharedKey', '')
        if not re.match(r'^[A-Za-z0-9+/]{43}=$', pub) or not re.match(r'^10\.99\.0\.\d{1,3}$', ip) or pub in hand or ip in hand_ips:
            continue
        desired[pub] = (ip, psk, p.get('name') or '')
    for pub, (ip, psk, name) in desired.items():
        if pub in managed and live.get(pub) == ip + '/32':
            continue
        with tempfile.NamedTemporaryFile('w', delete=True) as f:
            os.chmod(f.name, 0o600); f.write(psk + '\n'); f.flush()
            wg('set', IFACE, 'peer', pub, 'preshared-key', f.name, 'allowed-ips', ip + '/32')
        print('added %s %s' % (ip, name))
    for pub in managed - set(desired):
        if pub in live and pub not in hand:
            wg('set', IFACE, 'peer', pub, 'remove')
            print('removed %s' % pub[:8])
    os.makedirs(os.path.dirname(STATE), mode=0o700, exist_ok=True)
    with open(STATE, 'w') as f:
        json.dump(sorted(desired), f)


if __name__ == '__main__':
    try:
        main()
    except Exception as ex:  # report and try again next minute; peers stay as they are
        print('sync failed: %s' % ex, file=sys.stderr)
        sys.exit(1)
