#!/bin/bash
# Installs the Device Manager sync on the GO-Green VPN server (Ubuntu, WireGuard wg0). Run as root:
#   GGT_DM_URL=https://<device-manager> VPN_SYNC_TOKEN=<same as the Static Web App setting> bash install.sh
# Expects ggt-vpn-sync.py next to it.
set -euo pipefail
: "${GGT_DM_URL:?}" "${VPN_SYNC_TOKEN:?}"
install -m 755 "$(dirname "$0")/ggt-vpn-sync.py" /usr/local/sbin/ggt-vpn-sync
umask 077
printf 'GGT_DM_URL=%s\nVPN_SYNC_TOKEN=%s\n' "$GGT_DM_URL" "$VPN_SYNC_TOKEN" >/etc/ggt-vpn-sync.env
cat >/etc/systemd/system/ggt-vpn-sync.service <<'U'
[Unit]
Description=Sync GO-Green VPN peers with the Device Manager
After=network-online.target wg-quick@wg0.service
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/ggt-vpn-sync
U
cat >/etc/systemd/system/ggt-vpn-sync.timer <<'U'
[Unit]
Description=Sync GO-Green VPN peers with the Device Manager every minute
[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=5s
[Install]
WantedBy=timers.target
U
systemctl daemon-reload
systemctl enable --now ggt-vpn-sync.timer
systemctl start ggt-vpn-sync.service || true
