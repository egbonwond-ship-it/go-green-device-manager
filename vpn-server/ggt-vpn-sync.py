#!/usr/bin/env python3
"""Keep the Go-Green VPN server's WireGuard peers in step with the Device Manager.

Runs every minute from a systemd timer on the VPN server (see install.sh). It asks the Device
Manager for the computers that should be on the VPN (GET /api/vpn/peers) and adds, updates or
removes those peers on the WireGuard interface. It only ever removes peers it added itself, so
peers set up by hand (the lab gateway, the first laptops) are never touched, and it never adds a
peer whose address another peer already routes.

Settings come from /etc/ggt-vpn-sync.env:
  CONSOLE_URL=https://<device manager>
  SYNC_TOKEN=<same as GGVPN_SYNC_TOKEN in Azure>
  WG_IF=wg0
"""
import ipaddress
import json
import os
import re
import subprocess
import sys
import urllib.request

ENV_FILE = '/etc/ggt-vpn-sync.env'
STATE_FILE = '/var/lib/ggt-vpn-sync/managed.json'
KEY = re.compile(r'^[A-Za-z0-9+/]{43}=$')
POOL = ipaddress.ip_network('10.99.0.0/24')


def env():
    cfg = {}
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                cfg[k.strip()] = v.strip().strip('"\'')
    return cfg


def wg(*args):
    return subprocess.run(['wg', *args], capture_output=True, text=True, check=True).stdout


def current_peers(iface):
    """{public key: [allowed ips]} for every peer on the interface."""
    peers = {}
    for line in wg('show', iface, 'allowed-ips').splitlines():
        parts = line.split()
        if parts:
            peers[parts[0]] = [p for p in parts[1:] if p != '(none)']
    return peers


def main():
    cfg = env()
    iface = cfg.get('WG_IF', 'wg0')
    req = urllib.request.Request(cfg['CONSOLE_URL'].rstrip('/') + '/api/vpn/peers',
                                 headers={'x-ggt-vpn-token': cfg['SYNC_TOKEN'], 'User-Agent': 'ggt-vpn-sync'})
    with urllib.request.urlopen(req, timeout=30) as r:
        wanted = json.load(r).get('peers') or []

    try:
        with open(STATE_FILE) as f:
            managed = json.load(f)
    except (OSError, ValueError):
        managed = {}

    now = current_peers(iface)
    # Addresses routed to peers this script doesn't manage (hand-made peers) are off limits.
    taken = set()
    for key, ips in now.items():
        if key not in managed:
            for ip in ips:
                taken.add(ipaddress.ip_network(ip, strict=False))

    keep = {}
    for p in wanted:
        key, addr = p.get('publicKey', ''), p.get('address', '')
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            continue
        if not KEY.match(key) or ip not in POOL or key in now and key not in managed:
            continue
        if any(ip in n for n in taken):
            print('skip %s: %s is already routed to another peer' % (p.get('name'), addr), file=sys.stderr)
            continue
        cidr = '%s/32' % ip
        if now.get(key) != [cidr]:
            wg('set', iface, 'peer', key, 'allowed-ips', cidr)
            print('added %s %s' % (p.get('name'), cidr))
        keep[key] = {'name': p.get('name'), 'address': str(ip)}

    for key, info in managed.items():
        if key not in keep and key in now:
            wg('set', iface, 'peer', key, 'remove')
            print('removed %s %s' % (info.get('name'), info.get('address')))

    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE + '.tmp', 'w') as f:
        json.dump(keep, f)
    os.replace(STATE_FILE + '.tmp', STATE_FILE)


if __name__ == '__main__':
    main()
