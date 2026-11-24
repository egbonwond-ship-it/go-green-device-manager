// Built-in configuration written to the database the first time the console opens.
// Admins can change all of it afterwards except the built-in collections.
module.exports = {
  settings: { id: 'main', approvedAdmins: ['Administrator', 'Domain Admins', 'root'], pollIntervalSec: 300, lowDiskPct: 10, rdGateway: '' },
  collections: [
    { id: 'c-all', name: 'All Systems', description: 'Every managed device.', builtIn: true, match: 'all', rules: [] },
    { id: 'c-wks', name: 'All Windows Workstations', description: 'Windows laptops and desktops.', builtIn: true, match: 'all', rules: [{ field: 'platform', op: 'is', value: 'Windows' }, { field: 'type', op: 'in', value: 'Laptop,Desktop' }] },
    { id: 'c-srv', name: 'All Servers', description: 'Physical servers and virtual machines.', builtIn: true, match: 'any', rules: [{ field: 'type', op: 'is', value: 'Server' }, { field: 'type', op: 'is', value: 'VM' }] },
    { id: 'c-mac', name: 'All macOS Devices', description: 'Macs.', builtIn: true, match: 'all', rules: [{ field: 'platform', op: 'is', value: 'macOS' }] },
    { id: 'c-lin', name: 'All Linux Devices', description: 'Linux servers and workstations.', builtIn: true, match: 'all', rules: [{ field: 'platform', op: 'is', value: 'Linux' }] },
  ],
  baselines: [
    {
      id: 'bl-sec', name: 'Endpoint Security Baseline', description: 'Disk encryption, antivirus, firewall and fresh definitions on every endpoint.', remediate: false,
      rules: [
        { id: 'enc', name: 'Disk encryption on (BitLocker / FileVault / LUKS)', severity: 'Critical', remediable: false },
        { id: 'av', name: 'Antivirus real-time protection on', severity: 'Critical', remediable: true },
        { id: 'fw', name: 'Host firewall on for all profiles', severity: 'Important', remediable: true },
        { id: 'defs', name: 'Antivirus definitions less than 3 days old', severity: 'Important', remediable: true },
      ],
    },
    {
      id: 'bl-os', name: 'OS Currency & Patching', description: 'Supported OS, no long-pending restarts, critical updates within 7 days.', remediate: false,
      rules: [
        { id: 'osok', name: 'Operating system is a supported release', severity: 'Critical', remediable: false },
        { id: 'reboot', name: 'No restart pending for more than 7 days', severity: 'Moderate', remediable: false },
        { id: 'crit', name: 'Critical updates installed within 7 days of release', severity: 'Critical', remediable: false },
      ],
    },
    {
      id: 'bl-corp', name: 'Go-Green Corporate Configuration', description: 'Screen lock, local admin control, USB storage block and VPN client present.', remediate: false,
      rules: [
        { id: 'lock', name: 'Screen locks after 10 minutes or less', severity: 'Important', remediable: true },
        { id: 'admin', name: 'Local administrators limited to approved accounts', severity: 'Critical', remediable: false },
        { id: 'usb', name: 'Removable USB storage blocked', severity: 'Moderate', remediable: true, workstationOnly: true },
        { id: 'vpn', name: 'FortiClient VPN installed', severity: 'Moderate', remediable: false, workstationOnly: true },
      ],
    },
  ],
  // Library applications added once to every console (on first open, or the first time after an upgrade).
  // Admins can edit or delete them; a deleted one isn't added again.
  apps: [
    {
      id: 'app-ggvpn-client', name: 'Go-Green VPN client (WireGuard)', publisher: 'WireGuard LLC', version: 'Latest', category: 'VPN', builtIn: true,
      detectName: 'WireGuard', platforms: ['Windows', 'macOS'],
      notes: 'Installs the WireGuard app that the Go-Green VPN uses. Then connect Windows PCs with Connect VPN on the VPN page; on a Mac, open a Mac installer from the VPN page in the WireGuard app.',
      windows: { wingetId: 'WireGuard.WireGuard' },
      macos: {
        // The Mac app is only on the App Store, which needs the signed-in user: open its page for them.
        command: 'u=$(stat -f %Su /dev/console); if [ -z "$u" ] || [ "$u" = root ]; then echo "Nobody is signed in to this Mac, so the App Store can\'t open."; exit 1; fi; ' +
          'launchctl asuser "$(id -u "$u")" sudo -u "$u" open "macappstore://apps.apple.com/app/id1451685025" && ' +
          'echo "Opened WireGuard in the App Store for $u. It shows as installed once they click Get."',
        uninstall: 'rm -rf /Applications/WireGuard.app',
      },
    },
  ],
  scripts: [
    { id: 'disk', name: 'Get disk usage', lang: 'PowerShell', builtIn: true, body: 'Get-Volume | Where-Object DriveLetter | Select-Object DriveLetter, FileSystemLabel, @{n="FreeGB";e={[math]::Round($_.SizeRemaining/1GB,1)}}, @{n="SizeGB";e={[math]::Round($_.Size/1GB,1)}} | Format-Table -AutoSize | Out-String -Width 200' },
    { id: 'temp', name: 'Clear temp files', lang: 'PowerShell', builtIn: true, body: '$before = (Get-PSDrive C).Free\nRemove-Item "$env:WINDIR\\Temp\\*" -Recurse -Force -ErrorAction SilentlyContinue\nGet-ChildItem C:\\Users -Directory | ForEach-Object { Remove-Item "$($_.FullName)\\AppData\\Local\\Temp\\*" -Recurse -Force -ErrorAction SilentlyContinue }\n"Freed {0:N2} GB" -f (((Get-PSDrive C).Free - $before) / 1GB)' },
    { id: 'spool', name: 'Restart print spooler', lang: 'PowerShell', builtIn: true, body: 'Restart-Service -Name Spooler -Force\nGet-Service Spooler | Format-Table -AutoSize | Out-String' },
    { id: 'gpupdate', name: 'Refresh group policy', lang: 'PowerShell', builtIn: true, body: 'gpupdate /force' },
    { id: 'net', name: 'Network configuration', lang: 'PowerShell', builtIn: true, body: 'ipconfig /all' },
    { id: 'df', name: 'Get disk usage (macOS/Linux)', lang: 'Shell', builtIn: true, body: 'df -h' },
    { id: 'uptime', name: 'Uptime and signed-in users (macOS/Linux)', lang: 'Shell', builtIn: true, body: 'uptime; echo; who' },
  ],
};
