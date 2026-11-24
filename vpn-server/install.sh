#!/bin/sh
# Install the Go-Green VPN peer sync on the VPN server (Ubuntu, WireGuard on wg0).
#   sudo CONSOLE_URL=https://<device manager> SYNC_TOKEN=<GGVPN_SYNC_TOKEN> sh install.sh
# Peers added this way aren't written to wg0.conf; the timer adds them again within a minute of a restart.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run as root.' >&2; exit 1; }
: "${CONSOLE_URL:?set CONSOLE_URL}" "${SYNC_TOKEN:?set SYNC_TOKEN}"
dir=$(cd "$(dirname "$0")" && pwd)
install -m 0755 "$dir/ggt-vpn-sync.py" /usr/local/sbin/ggt-vpn-sync
umask 077
printf 'CONSOLE_URL=%s\nSYNC_TOKEN=%s\nWG_IF=%s\n' "$CONSOLE_URL" "$SYNC_TOKEN" "${WG_IF:-wg0}" > /etc/ggt-vpn-sync.env
cat > /etc/systemd/system/ggt-vpn-sync.service <<'UNIT'
[Unit]
Description=Sync Go-Green VPN peers from the Device Manager
After=network-online.target wg-quick@wg0.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/ggt-vpn-sync
UNIT
cat > /etc/systemd/system/ggt-vpn-sync.timer <<'UNIT'
[Unit]
Description=Sync Go-Green VPN peers every minute

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=5s

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now ggt-vpn-sync.timer
/usr/local/sbin/ggt-vpn-sync && echo 'Go-Green VPN sync installed and run once.'
