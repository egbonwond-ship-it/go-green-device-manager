// Generates realistic demo data for the device manager.
// Everything here stands in for what real device agents would report (see README → "Production backend").
// Deterministic: the same seed always produces the same estate.

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86400000;

export const SITES = [
  { code: 'LAG', name: 'Lagos HQ', weight: 0.42, subnet: '10.10', dp: 'GGT-LAG-DP01', tz: 'WAT' },
  { code: 'ABJ', name: 'Abuja', weight: 0.2, subnet: '10.20', dp: 'GGT-ABJ-DP01', tz: 'WAT' },
  { code: 'PHC', name: 'Port Harcourt', weight: 0.16, subnet: '10.30', dp: 'GGT-PHC-DP01', tz: 'WAT' },
  { code: 'IBD', name: 'Ibadan', weight: 0.12, subnet: '10.40', dp: 'GGT-IBD-DP01', tz: 'WAT' },
  { code: 'KAN', name: 'Kano', weight: 0.1, subnet: '10.50', dp: 'GGT-KAN-DP01', tz: 'WAT' },
];

export const DEPTS = ['Installations', 'Engineering', 'Sales', 'Finance', 'Operations', 'Customer Support', 'Security Systems', 'IT', 'Procurement', 'HR'];

// OS catalogue. family drives update/baseline applicability.
export const OS_LIST = [
  { name: 'Windows 11 24H2', family: 'win11', platform: 'Windows', build: '26100', supported: true },
  { name: 'Windows 11 23H2', family: 'win11', platform: 'Windows', build: '22631', supported: true },
  { name: 'Windows 10 22H2', family: 'win10', platform: 'Windows', build: '19045', supported: false },
  { name: 'Windows Server 2022', family: 'srv2022', platform: 'Windows', build: '20348', supported: true },
  { name: 'Windows Server 2019', family: 'srv2019', platform: 'Windows', build: '17763', supported: true },
  { name: 'macOS 15 Sequoia', family: 'macos', platform: 'macOS', build: '24.6', supported: true },
  { name: 'Ubuntu 24.04 LTS', family: 'ubuntu', platform: 'Linux', build: '24.04', supported: true },
  { name: 'Ubuntu 22.04 LTS', family: 'ubuntu', platform: 'Linux', build: '22.04', supported: true },
];

const FIRST = ['Adaeze', 'Tunde', 'Chiamaka', 'Emeka', 'Funmi', 'Ibrahim', 'Ngozi', 'Segun', 'Aisha', 'Kelechi', 'Bola', 'Uche', 'Halima', 'Femi', 'Zainab', 'Chidi', 'Yetunde', 'Musa', 'Ifeoma', 'Dayo', 'Amaka', 'Sani', 'Toyin', 'Obinna', 'Hauwa', 'Kunle', 'Nkechi', 'Babajide', 'Fatima', 'Gbenga'];
const LAST = ['Okafor', 'Adeyemi', 'Bello', 'Eze', 'Ogunleye', 'Musa', 'Nwosu', 'Balogun', 'Abubakar', 'Okeke', 'Afolabi', 'Danjuma', 'Obi', 'Lawal', 'Uzor', 'Adebayo', 'Ibekwe', 'Yusuf', 'Olawale', 'Chukwu'];

const HW = {
  Laptop: [['Dell', 'Latitude 5450'], ['Dell', 'Latitude 7450'], ['HP', 'EliteBook 840 G11'], ['Lenovo', 'ThinkPad T14 Gen 5'], ['Lenovo', 'ThinkPad E14 Gen 6'], ['Apple', 'MacBook Air 13" M3']],
  Desktop: [['Dell', 'OptiPlex 7020'], ['HP', 'ProDesk 400 G9'], ['Lenovo', 'ThinkCentre M70q']],
  Server: [['Dell', 'PowerEdge R650'], ['HPE', 'ProLiant DL360 Gen11']],
  VM: [['Microsoft', 'Hyper-V Virtual Machine'], ['VMware', 'VMware7,1']],
};
const CPUS = ['Intel Core Ultra 5 135U', 'Intel Core Ultra 7 165U', 'Intel Core i5-1345U', 'Intel Core i7-1365U', 'AMD Ryzen 5 PRO 7540U', 'Apple M3'];
const SRV_CPUS = ['Intel Xeon Silver 4314', 'Intel Xeon Gold 5418Y', 'AMD EPYC 9124'];

export const APPS = [
  { id: 'app-m365', name: 'Microsoft 365 Apps for enterprise', publisher: 'Microsoft', version: '16.0.18129', type: 'Click-to-Run', sizeMB: 3150, category: 'Productivity', platforms: ['Windows', 'macOS'], detection: 'Registry: HKLM\\SOFTWARE\\Microsoft\\Office\\ClickToRun\\Configuration VersionToReport ≥ 16.0.18129', install: 'setup.exe /configure ggt-m365.xml', prevalence: 0.93 },
  { id: 'app-chrome', name: 'Google Chrome', publisher: 'Google', version: '131.0.6778.86', type: 'MSI', sizeMB: 118, category: 'Browser', platforms: ['Windows', 'macOS', 'Linux'], detection: 'MSI product code {B6D2D0F6-…}', install: 'msiexec /i googlechromestandaloneenterprise64.msi /qn', prevalence: 0.82 },
  { id: 'app-firefox', name: 'Mozilla Firefox ESR', publisher: 'Mozilla', version: '128.5.0', type: 'MSI', sizeMB: 64, category: 'Browser', platforms: ['Windows', 'macOS', 'Linux'], detection: 'File: %ProgramFiles%\\Mozilla Firefox\\firefox.exe ≥ 128.5.0', install: 'msiexec /i FirefoxSetup128.5.0esr.msi /qn', prevalence: 0.21 },
  { id: 'app-reader', name: 'Adobe Acrobat Reader', publisher: 'Adobe', version: '24.004.20272', type: 'EXE', sizeMB: 412, category: 'Productivity', platforms: ['Windows', 'macOS'], detection: 'Registry: Uninstall key DisplayVersion ≥ 24.004', install: 'AcroRdrDCx64.exe /sAll /rs /msi EULA_ACCEPT=YES', prevalence: 0.74 },
  { id: 'app-7zip', name: '7-Zip', publisher: 'Igor Pavlov', version: '24.08', type: 'MSI', sizeMB: 2, category: 'Utilities', platforms: ['Windows'], detection: 'MSI product code', install: 'msiexec /i 7z2408-x64.msi /qn', prevalence: 0.55 },
  { id: 'app-zoom', name: 'Zoom Workplace', publisher: 'Zoom Video Communications', version: '6.2.11', type: 'MSI', sizeMB: 96, category: 'Communication', platforms: ['Windows', 'macOS'], detection: 'MSI product code', install: 'msiexec /i ZoomInstallerFull.msi /qn ZoomAutoUpdate=0', prevalence: 0.48 },
  { id: 'app-3cx', name: '3CX Desktop App', publisher: '3CX', version: '20.0.2', type: 'MSI', sizeMB: 140, category: 'Communication', platforms: ['Windows', 'macOS'], detection: 'MSI product code', install: 'msiexec /i 3CXDesktopApp-20.0.2.msi /qn', prevalence: 0.66 },
  { id: 'app-forti', name: 'FortiClient VPN', publisher: 'Fortinet', version: '7.4.1', type: 'MSI', sizeMB: 120, category: 'Security', platforms: ['Windows', 'macOS'], detection: 'Service: FortiClient VPN present', install: 'msiexec /i FortiClientVPN.msi /qn', prevalence: 0.71 },
  { id: 'app-pvsyst', name: 'PVsyst', publisher: 'PVsyst SA', version: '8.0.4', type: 'EXE', sizeMB: 820, category: 'Solar engineering', platforms: ['Windows'], detection: 'File: %ProgramFiles%\\PVsyst8.0\\PVsyst.exe exists', install: 'PVsyst8.0.4_Setup.exe /S', prevalence: 0.0, depts: ['Engineering', 'Installations'], deptPrev: 0.8 },
  { id: 'app-ivms', name: 'Hikvision iVMS-4200', publisher: 'Hikvision', version: '3.11.1', type: 'EXE', sizeMB: 640, category: 'CCTV', platforms: ['Windows'], detection: 'Registry: Uninstall key iVMS-4200', install: 'iVMS-4200V3.11.1_E.exe /S', prevalence: 0.0, depts: ['Security Systems', 'Operations'], deptPrev: 0.85 },
  { id: 'app-vscode', name: 'Visual Studio Code', publisher: 'Microsoft', version: '1.95.3', type: 'EXE', sizeMB: 98, category: 'Developer', platforms: ['Windows', 'macOS', 'Linux'], detection: 'File: Code.exe ≥ 1.95', install: 'VSCodeSetup-x64.exe /VERYSILENT /MERGETASKS=!runcode', prevalence: 0.0, depts: ['IT', 'Engineering'], deptPrev: 0.7 },
  { id: 'app-npp', name: 'Notepad++', publisher: 'Notepad++ Team', version: '8.7.1', type: 'EXE', sizeMB: 6, category: 'Utilities', platforms: ['Windows'], detection: 'File: notepad++.exe ≥ 8.7.1', install: 'npp.8.7.1.Installer.x64.exe /S', prevalence: 0.3 },
  { id: 'app-sage', name: 'Sage 50 Accounting', publisher: 'Sage', version: '2025.1', type: 'EXE', sizeMB: 1100, category: 'Finance', platforms: ['Windows'], detection: 'Registry: Uninstall key Sage 50', install: 'Sage50Setup.exe /quiet', prevalence: 0.0, depts: ['Finance', 'Procurement'], deptPrev: 0.9 },
  { id: 'app-anydesk', name: 'AnyDesk', publisher: 'AnyDesk Software', version: '8.1.0', type: 'MSI', sizeMB: 7, category: 'Remote support', platforms: ['Windows', 'macOS'], detection: 'MSI product code', install: 'msiexec /i AnyDesk.msi /qn', prevalence: 0.18 },
];

// Updates use illustrative KB numbers and titles (sample data, not the real Microsoft catalogue).
export const UPDATES = [
  { id: 'u1', kb: 'KB5046617', title: '2026-11 Cumulative Update for Windows 11 Version 24H2 for x64', product: 'Windows 11', families: ['win11'], classification: 'Security Updates', severity: 'Critical', released: -9, sizeMB: 712, reboot: true, missRate: 0.46 },
  { id: 'u2', kb: 'KB5046633', title: '2026-11 Cumulative Update for Windows 11 Version 23H2 for x64', product: 'Windows 11', families: ['win11'], classification: 'Security Updates', severity: 'Critical', released: -9, sizeMB: 688, reboot: true, missRate: 0.3 },
  { id: 'u3', kb: 'KB5046613', title: '2026-11 Cumulative Update for Windows 10 Version 22H2 for x64', product: 'Windows 10', families: ['win10'], classification: 'Security Updates', severity: 'Critical', released: -9, sizeMB: 655, reboot: true, missRate: 0.58 },
  { id: 'u4', kb: 'KB5046612', title: '2026-11 Cumulative Update for Windows Server 2022', product: 'Windows Server 2022', families: ['srv2022'], classification: 'Security Updates', severity: 'Critical', released: -9, sizeMB: 540, reboot: true, missRate: 0.5 },
  { id: 'u5', kb: 'KB5046615', title: '2026-11 Cumulative Update for Windows Server 2019', product: 'Windows Server 2019', families: ['srv2019'], classification: 'Security Updates', severity: 'Critical', released: -9, sizeMB: 498, reboot: true, missRate: 0.55 },
  { id: 'u6', kb: 'KB5045935', title: '2026-11 .NET Framework 3.5 and 4.8.1 Cumulative Update', product: '.NET Framework', families: ['win11', 'win10', 'srv2022'], classification: 'Security Updates', severity: 'Important', released: -9, sizeMB: 74, reboot: false, missRate: 0.34 },
  { id: 'u7', kb: 'KB890830', title: 'Windows Malicious Software Removal Tool x64 - v5.131', product: 'Windows', families: ['win11', 'win10', 'srv2022', 'srv2019'], classification: 'Update Rollups', severity: 'Moderate', released: -9, sizeMB: 78, reboot: false, missRate: 0.22 },
  { id: 'u8', kb: 'KB2267602', title: 'Security Intelligence Update for Microsoft Defender Antivirus - 1.421.x', product: 'Microsoft Defender', families: ['win11', 'win10', 'srv2022', 'srv2019'], classification: 'Definition Updates', severity: 'Moderate', released: -1, sizeMB: 2, reboot: false, missRate: 0.12 },
  { id: 'u9', kb: 'KB5044284', title: '2026-10 Cumulative Update for Windows 11 Version 24H2 for x64', product: 'Windows 11', families: ['win11'], classification: 'Security Updates', severity: 'Critical', released: -37, sizeMB: 690, reboot: true, missRate: 0.06, superseded: true },
  { id: 'u10', kb: 'KB5046740', title: 'Microsoft 365 Apps Update - Monthly Enterprise Channel 2410', product: 'Microsoft 365 Apps', families: ['win11', 'win10'], classification: 'Security Updates', severity: 'Important', released: -6, sizeMB: 240, reboot: false, missRate: 0.38 },
  { id: 'u11', kb: 'FU-24H2', title: 'Feature update to Windows 11, version 24H2', product: 'Windows 11', families: ['win10'], classification: 'Upgrades', severity: 'Low', released: -60, sizeMB: 4100, reboot: true, missRate: 1.0 },
  { id: 'u12', kb: 'MAC-15.6.1', title: 'macOS Sequoia 15.6.1', product: 'macOS', families: ['macos'], classification: 'Security Updates', severity: 'Important', released: -12, sizeMB: 1800, reboot: true, missRate: 0.4 },
  { id: 'u13', kb: 'USN-7120-1', title: 'Linux kernel security update (USN-7120-1)', product: 'Ubuntu', families: ['ubuntu'], classification: 'Security Updates', severity: 'Critical', released: -5, sizeMB: 120, reboot: true, missRate: 0.5 },
  { id: 'u14', kb: 'USN-7101-1', title: 'OpenSSL vulnerabilities (USN-7101-1)', product: 'Ubuntu', families: ['ubuntu'], classification: 'Security Updates', severity: 'Important', released: -14, sizeMB: 4, reboot: false, missRate: 0.25 },
  { id: 'u15', kb: 'CHR-131', title: 'Google Chrome 131.0.6778.86 security update', product: 'Google Chrome', families: ['win11', 'win10', 'macos'], classification: 'Third-party', severity: 'Important', released: -4, sizeMB: 118, reboot: false, missRate: 0.31, needsApp: 'app-chrome' },
];

export const BASELINES = [
  {
    id: 'bl-sec', name: 'Endpoint Security Baseline', description: 'Disk encryption, antivirus, firewall and fresh definitions on every endpoint.', remediate: true, evalEveryH: 4,
    rules: [
      { id: 'enc', name: 'Disk encryption enabled (BitLocker / FileVault / LUKS)', severity: 'Critical', remediable: false },
      { id: 'av', name: 'Antivirus real-time protection on', severity: 'Critical', remediable: true },
      { id: 'fw', name: 'Host firewall enabled on all profiles', severity: 'Important', remediable: true },
      { id: 'defs', name: 'AV definitions less than 3 days old', severity: 'Important', remediable: true },
    ],
  },
  {
    id: 'bl-os', name: 'OS Currency & Patching', description: 'Supported OS, no long-pending restarts, critical updates within 7 days.', remediate: false, evalEveryH: 12,
    rules: [
      { id: 'osok', name: 'Operating system is a supported release', severity: 'Critical', remediable: false },
      { id: 'reboot', name: 'No restart pending for more than 7 days', severity: 'Moderate', remediable: false },
      { id: 'crit', name: 'Critical security updates installed within 7 days of release', severity: 'Critical', remediable: false },
    ],
  },
  {
    id: 'bl-corp', name: 'Go-Green Corporate Configuration', description: 'Screen lock, local admin control, USB storage block and VPN client present.', remediate: true, evalEveryH: 24,
    rules: [
      { id: 'lock', name: 'Screen locks after 10 minutes or less', severity: 'Important', remediable: true },
      { id: 'admin', name: 'Local Administrators limited to approved accounts', severity: 'Critical', remediable: true },
      { id: 'usb', name: 'Removable USB storage blocked', severity: 'Moderate', remediable: true, workstationOnly: true },
      { id: 'vpn', name: 'FortiClient VPN installed', severity: 'Moderate', remediable: true, workstationOnly: true },
    ],
  },
];

function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }
function weighted(r, items, key = 'weight') {
  let x = r() * items.reduce((s, i) => s + i[key], 0);
  for (const i of items) { if ((x -= i[key]) <= 0) return i; }
  return items[items.length - 1];
}

export function generate(seed = 20261120, count = 260) {
  const r = rng(seed);
  const now = Date.now();
  const devices = [];
  const counters = {};
  for (let i = 0; i < count; i++) {
    const site = weighted(r, SITES);
    // device type mix
    const tr = r();
    let type = tr < 0.6 ? 'Laptop' : tr < 0.85 ? 'Desktop' : tr < 0.93 ? 'Server' : 'VM';
    let os;
    if (type === 'Server' || type === 'VM') {
      const o = r();
      os = o < 0.55 ? OS_LIST[3] : o < 0.82 ? OS_LIST[4] : o < 0.93 ? OS_LIST[6] : OS_LIST[7];
    } else {
      const o = r();
      os = o < 0.52 ? OS_LIST[0] : o < 0.72 ? OS_LIST[1] : o < 0.88 ? OS_LIST[2] : o < 0.97 ? OS_LIST[5] : OS_LIST[6];
    }
    let [manufacturer, model] = pick(r, HW[type]);
    if (os.platform === 'macOS') { manufacturer = 'Apple'; model = r() < 0.6 ? 'MacBook Air 13" M3' : 'MacBook Pro 14" M3'; type = 'Laptop'; }
    else if (manufacturer === 'Apple') { [manufacturer, model] = ['Dell', 'Latitude 5450']; }
    const isServer = type === 'Server' || type === 'VM';
    const prefix = isServer ? 'SRV' : type === 'Laptop' ? 'LT' : 'DT';
    const key = site.code + prefix;
    counters[key] = (counters[key] || 0) + 1;
    const name = `GGT-${site.code}-${prefix}${String(counters[key]).padStart(3, '0')}`;
    const dept = isServer ? 'IT' : pick(r, DEPTS);
    const user = isServer ? null : `${pick(r, FIRST)} ${pick(r, LAST)}`;
    const ram = isServer ? pick(r, [32, 64, 128]) : pick(r, [8, 16, 16, 16, 32]);
    const disk = isServer ? pick(r, [480, 960, 1920]) : pick(r, [256, 512, 512, 1024]);
    // activity: most online, some stale, a few inactive (> 14 days)
    const ar = r();
    const lastSeen = ar < 0.78 ? now - Math.floor(r() * 10 * 60000) : ar < 0.95 ? now - Math.floor((1 + r() * 70) * 3600000) : now - Math.floor((15 + r() * 40) * DAY);
    const online = now - lastSeen < 15 * 60000;
    const health = now - lastSeen > 14 * DAY ? 'Inactive' : r() < 0.06 ? 'Needs attention' : 'Healthy';
    const tags = [];
    if (r() < 0.08 || (dept === 'IT' && !isServer)) tags.push('pilot');
    if (type === 'Laptop' && ['Installations', 'Security Systems', 'Sales'].includes(dept)) tags.push('field');
    if (isServer && r() < 0.4) tags.push('critical-server');
    if (dept === 'Finance') tags.push('sensitive-data');

    const d = {
      id: 'd' + (i + 1), name, site: site.name, siteCode: site.code, dept, user, type,
      os: os.name, osFamily: os.family, platform: os.platform, build: os.build,
      manufacturer, model, serial: (manufacturer.slice(0, 2) + Math.floor(r() * 1e8).toString(36)).toUpperCase(),
      cpu: isServer ? pick(r, SRV_CPUS) : os.platform === 'macOS' ? 'Apple M3' : pick(r, CPUS.slice(0, 5)),
      ramGB: ram, diskGB: disk, diskFreePct: Math.round(4 + r() * 70),
      ip: `${site.subnet}.${Math.floor(r() * 16) + (isServer ? 1 : 32)}.${Math.floor(r() * 250) + 2}`,
      mac: Array.from({ length: 6 }, () => Math.floor(r() * 256).toString(16).padStart(2, '0')).join(':').toUpperCase(),
      lastSeen, online, health, tags,
      agentVersion: r() < 0.85 ? '5.2.3' : '5.1.8',
      cpuPct: online ? Math.round(3 + r() * (isServer ? 70 : 45)) : 0,
      memPct: online ? Math.round(25 + r() * 60) : 0,
      lastBoot: now - Math.floor(r() * (isServer ? 40 : 12) * DAY),
      pendingRebootSince: r() < 0.14 ? now - Math.floor(r() * 16 * DAY) : null,
      enrolled: now - Math.floor((30 + r() * 700) * DAY),
      // security signals that feed compliance
      encrypted: r() > (type === 'Desktop' ? 0.16 : 0.06) || isServer && r() > 0.3,
      avOn: r() > 0.04,
      fwOn: r() > 0.05,
      defsAgeDays: r() < 0.88 ? Math.floor(r() * 2) : 3 + Math.floor(r() * 9),
      screenLockMin: r() < 0.9 ? pick(r, [5, 10, 10]) : pick(r, [15, 30, 0]),
      extraAdmins: r() < 0.09,
      usbBlocked: r() > 0.12,
      installed: [], missingUpdates: [], installedUpdates: [],
    };
    if (!d.online && d.health !== 'Inactive' && now - lastSeen > 3 * DAY) d.health = 'Needs attention';
    // software inventory
    for (const a of APPS) {
      if (!a.platforms.includes(d.platform)) continue;
      if (isServer && !['app-7zip', 'app-npp', 'app-chrome'].includes(a.id)) continue;
      const p = a.depts ? (a.depts.includes(dept) ? a.deptPrev : 0.02) : a.prevalence;
      if (r() < p) d.installed.push(a.id);
    }
    // updates
    for (const u of UPDATES) {
      if (!u.families.includes(d.osFamily)) continue;
      if (u.needsApp && !d.installed.includes(u.needsApp)) continue;
      const stale = !d.online ? 0.25 : 0;
      if (r() < Math.min(1, u.missRate + stale)) d.missingUpdates.push(u.id); else d.installedUpdates.push(u.id);
    }
    devices.push(d);
  }

  const collections = [
    { id: 'c-all', name: 'All Systems', description: 'Every managed device.', builtIn: true, match: 'all', rules: [] },
    { id: 'c-wks', name: 'All Windows Workstations', description: 'Windows 10 and 11 laptops and desktops.', builtIn: true, match: 'all', rules: [{ field: 'platform', op: 'is', value: 'Windows' }, { field: 'type', op: 'in', value: 'Laptop,Desktop' }] },
    { id: 'c-srv', name: 'All Servers', description: 'Physical servers and virtual machines.', builtIn: true, match: 'any', rules: [{ field: 'type', op: 'is', value: 'Server' }, { field: 'type', op: 'is', value: 'VM' }] },
    { id: 'c-mac', name: 'All macOS Devices', description: 'MacBooks.', builtIn: true, match: 'all', rules: [{ field: 'platform', op: 'is', value: 'macOS' }] },
    { id: 'c-lin', name: 'All Linux Devices', description: 'Ubuntu servers and workstations.', builtIn: true, match: 'all', rules: [{ field: 'platform', op: 'is', value: 'Linux' }] },
    { id: 'c-pilot', name: 'Ring 0 · Pilot', description: 'IT and volunteer devices that get updates first.', match: 'all', rules: [{ field: 'tag', op: 'is', value: 'pilot' }] },
    { id: 'c-broad', name: 'Ring 1 · Broad workstations', description: 'Workstations outside the pilot ring.', match: 'all', rules: [{ field: 'type', op: 'in', value: 'Laptop,Desktop' }, { field: 'tag', op: 'not', value: 'pilot' }] },
    { id: 'c-field', name: 'Field engineer laptops', description: 'Installations, security systems and sales laptops that spend most days on customer sites.', match: 'all', rules: [{ field: 'tag', op: 'is', value: 'field' }] },
    { id: 'c-lagos', name: 'Lagos HQ', description: 'Every device at the Lagos head office.', match: 'all', rules: [{ field: 'site', op: 'is', value: 'Lagos HQ' }] },
    { id: 'c-win10', name: 'Windows 10 (upgrade to 11)', description: 'Devices still on Windows 10, which is out of support.', match: 'all', rules: [{ field: 'osFamily', op: 'is', value: 'win10' }] },
    { id: 'c-eng', name: 'Engineering & Installations', description: 'Solar design and installation teams.', match: 'any', rules: [{ field: 'dept', op: 'is', value: 'Engineering' }, { field: 'dept', op: 'is', value: 'Installations' }] },
    { id: 'c-fin', name: 'Finance (sensitive data)', description: 'Finance devices with stricter controls.', match: 'all', rules: [{ field: 'tag', op: 'is', value: 'sensitive-data' }] },
  ];

  const updateGroups = [
    { id: 'ug-2611', name: '2026-11 Patch Tuesday · Workstations', updateIds: ['u1', 'u2', 'u3', 'u6', 'u7', 'u10'], created: now - 8 * DAY },
    { id: 'ug-2611s', name: '2026-11 Patch Tuesday · Servers', updateIds: ['u4', 'u5', 'u6', 'u7'], created: now - 8 * DAY },
    { id: 'ug-defs', name: 'Defender definitions (ADR)', updateIds: ['u8'], created: now - 1 * DAY },
    { id: 'ug-3p', name: 'Third-party & Linux security', updateIds: ['u12', 'u13', 'u14', 'u15'], created: now - 3 * DAY },
  ];

  const adrs = [
    { id: 'adr1', name: 'Defender definitions · daily', criteria: 'Classification = Definition Updates, Product = Microsoft Defender', targetGroup: 'ug-defs', collectionId: 'c-all', schedule: 'Every day 06:00 WAT', enabled: true, lastRun: now - 10 * 3600000, lastResult: 'Success: 1 update added' },
    { id: 'adr2', name: 'Patch Tuesday · Pilot ring', criteria: 'Classification = Security Updates, Released last 1 day, Superseded = No', targetGroup: 'ug-2611', collectionId: 'c-pilot', schedule: '2nd Tuesday + 1 day, 22:00 WAT', enabled: true, lastRun: now - 8 * DAY, lastResult: 'Success: 6 updates added' },
    { id: 'adr3', name: 'Patch Tuesday · Broad ring', criteria: 'Same as pilot, after 7 days without errors in the pilot', targetGroup: 'ug-2611', collectionId: 'c-broad', schedule: '2nd Tuesday + 8 days, 22:00 WAT', enabled: true, lastRun: now - 1 * DAY, lastResult: 'Success: deployment created' },
  ];

  const maintenanceWindows = [
    { id: 'mw1', name: 'Workstations · weeknights', collectionId: 'c-wks', days: 'Mon–Fri', start: '22:00', hours: 4, appliesTo: 'All deployments' },
    { id: 'mw2', name: 'Servers · Sunday early', collectionId: 'c-srv', days: 'Sun', start: '01:00', hours: 3, appliesTo: 'Software updates only' },
    { id: 'mw3', name: 'Field laptops · lunch', collectionId: 'c-field', days: 'Mon–Sat', start: '12:30', hours: 1, appliesTo: 'All deployments' },
  ];

  return { devices, collections, updateGroups, adrs, maintenanceWindows, generatedAt: now };
}
