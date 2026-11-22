#!/usr/bin/env python3
"""Go-Green Device Manager agent for macOS and Linux (Python 3.6+, standard library only).

Install (as root):
    sudo python3 ggt-agent.py install --server https://<your-site> --token '<enrollment token>'
Uninstall:
    sudo python3 ggt-agent.py uninstall
One check-in now:
    sudo python3 /usr/local/lib/ggt-agent/ggt-agent.py run     (Linux)
    sudo python3 "/Library/Application Support/GGT Agent/ggt-agent.py" run     (macOS)

Every 5 minutes (systemd timer, cron or launchd) the agent collects inventory and security
settings, scans for OS updates every 6 hours, checks in, pulls its policy, runs queued scripts
and actions, installs or removes deployed software, installs approved updates and reports back.
"""
import argparse
import contextlib
import fcntl
import glob
import hashlib
import json
import os
import platform
import plistlib
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

AGENT_VERSION = '2.2.0'
IS_MAC = sys.platform == 'darwin'
OK_TYPES = ('Laptop', 'Desktop', 'Server', 'VM')

if IS_MAC:
    DEFAULT_HOME = '/Library/Application Support/GGT Agent'
    LOG_PATH_DEFAULT = '/Library/Logs/ggt-agent.log'
else:
    DEFAULT_HOME = '/usr/local/lib/ggt-agent'
    LOG_PATH_DEFAULT = '/var/log/ggt-agent.log'

HOME = DEFAULT_HOME
LOG_PATH = LOG_PATH_DEFAULT
CONFIG = {}


def now_ms():
    return int(time.time() * 1000)


def iso(ts=None):
    return datetime.fromtimestamp(ts if ts is not None else time.time(), tz=timezone.utc).isoformat()


def log(msg, level='info'):
    line = '%s [%s] %s' % (datetime.now().strftime('%Y-%m-%dT%H:%M:%S'), level, msg)
    print(line, flush=True)
    try:
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > 1024 * 1024:
            os.replace(LOG_PATH, LOG_PATH + '.1')
        with open(LOG_PATH, 'a') as f:
            f.write(line + '\n')
    except OSError:
        pass


def sh(cmd, timeout=120, shell=False, env=None):
    """Run a command. Returns (exit code, combined output). Never raises for a missing program."""
    try:
        p = subprocess.run(cmd, shell=shell, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout,
                           env=env, universal_newlines=True)
        return p.returncode, p.stdout or ''
    except subprocess.TimeoutExpired as e:
        out = e.output if isinstance(e.output, str) else (e.output or b'').decode('utf-8', 'replace')
        return -1, (out or '') + '\nStopped: timed out'
    except (OSError, ValueError) as e:
        return 127, str(e)


def out(cmd, timeout=60):
    code, text = sh(cmd, timeout=timeout)
    return text.strip() if code == 0 else ''


def read(path, default=''):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def write_json(path, obj, mode=0o600):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(obj, f, indent=2)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


# ------------------------------------------------------------------ server calls
class ApiError(Exception):
    def __init__(self, status, message):
        Exception.__init__(self, message)
        self.status = status


def api(method, path, body=None):
    headers = {'x-ggt-enroll-token': CONFIG['token'], 'User-Agent': 'ggt-agent/' + AGENT_VERSION}
    if CONFIG.get('deviceKey'):
        headers['x-ggt-device-key'] = CONFIG['deviceKey']
    data = None
    if body is not None:
        data = json.dumps(body).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(CONFIG['server'] + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            text = r.read().decode('utf-8')
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as e:
        raise ApiError(e.code, '%s %s failed (%s): %s' % (method, path, e.code, e.read().decode('utf-8', 'replace')[:300]))
    except urllib.error.URLError as e:
        raise ApiError(0, '%s %s failed: %s' % (method, path, e.reason))


# ------------------------------------------------------------------ inventory
def os_release():
    info = {}
    for line in read('/etc/os-release').splitlines():
        if '=' in line:
            k, v = line.split('=', 1)
            info[k] = v.strip().strip('"')
    return info


def mac_hardware():
    try:
        data = json.loads(out(['system_profiler', 'SPHardwareDataType', '-json'], timeout=60) or '{}')
        return (data.get('SPHardwareDataType') or [{}])[0]
    except ValueError:
        return {}


def primary_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))  # no packet is sent
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def all_ips():
    """Every IPv4 address (LAN, Wi-Fi, VPN, Tailscale), the primary one first."""
    if IS_MAC:
        found = re.findall(r'\binet (\d+\.\d+\.\d+\.\d+)', out(['ifconfig']))
    else:
        found = re.findall(r'\binet (\d+\.\d+\.\d+\.\d+)', out(['ip', '-4', '-o', 'addr', 'show']))
    first = primary_ip()
    ips = [first] if first else []
    for a in found:
        if a not in ips and not a.startswith(('127.', '169.254.')):
            ips.append(a)
    return ips[:16]


def join_info():
    """Active Directory binding (macOS dsconfigad, Linux realmd/sssd) and the name the device is reachable by."""
    short = socket.gethostname().split('.')[0]
    domain = ''
    if IS_MAC:
        m = re.search(r'Active Directory Domain\s*=\s*(\S+)', out(['dsconfigad', '-show']))
        domain = m.group(1) if m else ''
        local = out(['scutil', '--get', 'LocalHostName'])
        fqdn = '%s.%s' % (short, domain) if domain else ('%s.local' % local if local else None)
    else:
        m = re.search(r'^\s*domain-name:\s*(\S+)', out(['realm', 'list']), re.M) if shutil.which('realm') else None
        domain = m.group(1) if m else ''
        f = socket.getfqdn()
        fqdn = '%s.%s' % (short, domain) if domain else (f if '.' in f and not f.startswith('localhost') else None)
    return {'joinType': 'Domain' if domain else 'Workgroup', 'domain': domain or None, 'fqdn': fqdn.lower() if fqdn else None}


def find_tailscale():
    return shutil.which('tailscale') or next((p for p in ('/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/usr/bin/tailscale') if os.path.exists(p)), None)


def forti_connected():
    """FortiClient VPN is connected when its tunnel (ppp on macOS, ppp/fctvpn on Linux) has an address. None when FortiClient isn't installed."""
    installed = os.path.exists('/Applications/FortiClient.app') if IS_MAC else (os.path.exists('/opt/forticlient') or bool(shutil.which('openfortivpn')))
    if not installed:
        return None
    if IS_MAC:
        blocks = re.split(r'\n(?=\S)', out(['ifconfig']))
        return any(b.startswith('ppp') and '\tinet ' in b or b.startswith('ppp') and ' inet ' in b for b in blocks)
    return bool(re.search(r'\d+: (ppp\d+|fctvpn\w*|vpn\d+)\s+inet ', out(['ip', '-4', '-o', 'addr', 'show'])))


def join_tailscale(key):
    """Join the company's Tailscale network with the auth key the console sent, installing Tailscale on Linux if needed."""
    if not key:
        raise RuntimeError('No Tailscale auth key was sent. Save one on the VPN page.')
    exe = find_tailscale()
    if not exe and not IS_MAC:
        code, text = sh(['/bin/sh', '-c', 'curl -fsSL https://tailscale.com/install.sh | sh'], timeout=900)
        if code != 0:
            raise RuntimeError('Tailscale install failed: %s' % text[-500:])
        sh(['systemctl', 'enable', '--now', 'tailscaled'])
        exe = find_tailscale()
    if not exe:
        raise RuntimeError('Tailscale is not installed. Install the standalone Tailscale app for macOS (from pkgs.tailscale.com or the Software library), then try again.')
    code, text = sh([exe, 'up', '--authkey=' + key, '--hostname=' + socket.gethostname().split('.')[0].lower()], timeout=180)
    if code != 0:
        raise RuntimeError('tailscale up failed: %s' % text.replace(key, 'tskey-…')[-500:])
    t = tailscale() or {}
    return 'Joined Tailscale as %s (%s).' % (t.get('dnsName') or '?', ', '.join(t.get('ips') or []))


def leave_tailscale():
    exe = find_tailscale()
    if not exe:
        return 'Tailscale is not installed.'
    code, text = sh([exe, 'logout'], timeout=120)
    if code != 0:
        raise RuntimeError('tailscale logout failed: %s' % text[-500:])
    return 'Left the Tailscale network. Tailscale is still installed.'


def tailscale():
    """Tailscale (mesh VPN) address and MagicDNS name, so remote access works outside the office."""
    exe = find_tailscale()
    if not exe:
        return None
    try:
        j = json.loads(out([exe, 'status', '--json'], timeout=20) or '{}')
    except ValueError:
        return None
    me = j.get('Self') or {}
    if not me:
        return None
    return {'ips': [a for a in me.get('TailscaleIPs') or [] if re.match(r'^\d+\.\d+\.\d+\.\d+$', a)],
            'dnsName': (me.get('DNSName') or '').rstrip('.') or None, 'online': j.get('BackendState') == 'Running'}


def mac_address():
    if IS_MAC:
        iface = ''
        m = re.search(r'interface:\s*(\S+)', out(['route', '-n', 'get', 'default']))
        if m:
            iface = m.group(1)
        m = re.search(r'ether\s+([0-9a-f:]{17})', out(['ifconfig', iface or 'en0']))
        return m.group(1).upper() if m else None
    m = re.search(r'\bdev\s+(\S+)', out(['ip', 'route', 'get', '1.1.1.1']))
    if m:
        v = read('/sys/class/net/%s/address' % m.group(1))
        return v.upper() if v else None
    return None


def cpu_percent():
    if IS_MAC:
        total = 0.0
        for line in out(['ps', '-A', '-o', '%cpu']).splitlines()[1:]:
            try:
                total += float(line.strip())
            except ValueError:
                pass
        return min(100, round(total / max(1, os.cpu_count() or 1)))

    def sample():
        f = [int(x) for x in read('/proc/stat').splitlines()[0].split()[1:]]
        return sum(f), f[3] + (f[4] if len(f) > 4 else 0)
    try:
        t1, i1 = sample()
        time.sleep(0.5)
        t2, i2 = sample()
        return round(100 * (1 - (i2 - i1) / max(1, t2 - t1)))
    except (IndexError, ValueError):
        return None


def mem_info():
    """(total GB, used %)"""
    if IS_MAC:
        total = int(out(['sysctl', '-n', 'hw.memsize']) or 0)
        vm = out(['vm_stat'])
        page = int((re.search(r'page size of (\d+)', vm) or [0, 4096])[1])
        pages = dict((k.strip(), int(v.strip().rstrip('.'))) for k, v in re.findall(r'^"?([^:"]+)"?:\s+(\d+)\.?$', vm, re.M))
        used = (pages.get('Pages active', 0) + pages.get('Pages wired down', 0) + pages.get('Pages occupied by compressor', 0)) * page
        return round(total / 2 ** 30), (round(used / total * 100) if total else None)
    m = dict((k, int(v.split()[0])) for k, v in (l.split(':', 1) for l in read('/proc/meminfo').splitlines() if ':' in l))
    total = m.get('MemTotal', 0)
    avail = m.get('MemAvailable', m.get('MemFree', 0))
    return round(total / 2 ** 20), (round((1 - avail / total) * 100) if total else None)


def device_type(hw):
    if IS_MAC:
        name = hw.get('machine_name', '') or out(['sysctl', '-n', 'hw.model'])
        return 'Laptop' if 'Book' in name else 'Desktop'
    virt = out(['systemd-detect-virt'])
    if virt and virt != 'none':
        return 'VM'
    chassis = read('/sys/class/dmi/id/chassis_type')
    if chassis in ('8', '9', '10', '11', '14', '30', '31', '32'):
        return 'Laptop'
    if chassis in ('17', '23', '28', '29') or not (glob.glob('/usr/share/xsessions/*') or glob.glob('/usr/share/wayland-sessions/*')):
        return 'Server'
    return 'Desktop'


def console_user():
    if IS_MAC:
        u = out(['stat', '-f', '%Su', '/dev/console'])
        return u if u and u != 'root' else None
    for line in out(['who']).splitlines():
        u = line.split()[0] if line.split() else ''
        if u and u != 'root':
            return u
    return None


def inventory():
    hw = mac_hardware() if IS_MAC else {}
    ram, mem_pct = mem_info()
    st = os.statvfs('/System/Volumes/Data' if IS_MAC and os.path.exists('/System/Volumes/Data') else '/')
    size = st.f_blocks * st.f_frsize
    free = st.f_bavail * st.f_frsize
    if IS_MAC:
        ver = out(['sw_vers', '-productVersion'])
        os_name = 'macOS %s' % ver
        build = out(['sw_vers', '-buildVersion'])
        manufacturer = 'Apple'
        model = hw.get('machine_name') or out(['sysctl', '-n', 'hw.model'])
        serial = hw.get('serial_number', '')
        cpu = hw.get('chip_type') or hw.get('cpu_type') or out(['sysctl', '-n', 'machdep.cpu.brand_string'])
        m = re.search(r'sec = (\d+)', out(['sysctl', '-n', 'kern.boottime']))
        boot = int(m.group(1)) if m else None
    else:
        rel = os_release()
        os_name = rel.get('PRETTY_NAME') or ('%s %s' % (rel.get('NAME', 'Linux'), rel.get('VERSION_ID', ''))).strip()
        build = platform.release()
        manufacturer = read('/sys/class/dmi/id/sys_vendor')
        model = read('/sys/class/dmi/id/product_name')
        serial = read('/sys/class/dmi/id/product_serial')
        cpu = ''
        for line in read('/proc/cpuinfo').splitlines():
            if line.lower().startswith('model name'):
                cpu = line.split(':', 1)[1].strip()
                break
        try:
            boot = int(time.time() - float(read('/proc/uptime').split()[0]))
        except (IndexError, ValueError):
            boot = None
    return {
        'name': socket.gethostname().split('.')[0][:64], 'platform': 'macOS' if IS_MAC else 'Linux', 'os': os_name[:100], 'build': build,
        'type': device_type(hw), 'manufacturer': manufacturer, 'model': model, 'serial': serial, 'cpu': cpu,
        'ramGB': ram, 'diskGB': round(size / 1e9), 'diskFreePct': round(free / size * 100) if size else None,
        'ip': primary_ip(), 'mac': mac_address(), 'user': console_user(), 'lastBoot': iso(boot) if boot else None,
        'cpuPct': cpu_percent(), 'memPct': mem_pct, 'agentVersion': AGENT_VERSION,
        'ips': all_ips(), 'rdpPort': 5900 if IS_MAC else None, 'tailscale': tailscale(), 'fortiConnected': forti_connected(), **join_info(),
    }


def group_members(*names):
    members = set()
    try:
        import grp
        import pwd
        gids = {}
        for n in names:
            try:
                g = grp.getgrnam(n)
                members.update(g.gr_mem)
                gids[g.gr_gid] = n
            except KeyError:
                pass
        for p in pwd.getpwall():
            if p.pw_gid in gids:
                members.add(p.pw_name)
    except ImportError:
        pass
    return sorted(members)


def security():
    s = {'encrypted': None, 'avOn': None, 'fwOn': None, 'defsAgeDays': None, 'screenLockMin': None, 'usbBlocked': None, 'pendingReboot': False, 'localAdmins': None, 'remoteOn': None}
    if IS_MAC:
        s['encrypted'] = 'FileVault is On' in out(['fdesetup', 'status'])
        s['fwOn'] = 'enabled' in out(['/usr/libexec/ApplicationFirewall/socketfilterfw', '--getglobalstate']).lower()
        m = out(['dscl', '.', '-read', '/Groups/admin', 'GroupMembership'])
        s['localAdmins'] = m.split(':', 1)[1].split() if ':' in m else None
        s['remoteOn'] = mac_screen_sharing_on()
        return s
    lsblk = out(['lsblk', '-rno', 'TYPE'])
    s['encrypted'] = 'crypt' in lsblk.split() if lsblk else None
    fw = None
    if shutil.which('ufw'):
        fw = 'Status: active' in out(['ufw', 'status'])
    if not fw and out(['systemctl', 'is-active', 'firewalld']) == 'active':
        fw = True
    if not fw and shutil.which('iptables'):
        rules = out(['iptables', '-S', 'INPUT'])
        if rules:
            fw = '-P INPUT DROP' in rules or '-P INPUT REJECT' in rules
    s['fwOn'] = fw
    conf = ''
    for f in glob.glob('/etc/modprobe.d/*.conf'):
        conf += read(f) + '\n'
    s['usbBlocked'] = bool(re.search(r'^\s*(blacklist\s+usb[-_]storage|install\s+usb[-_]storage\s+/bin/(true|false))', conf, re.M))
    s['pendingReboot'] = os.path.exists('/var/run/reboot-required')
    s['localAdmins'] = ['root'] + [m for m in group_members('sudo', 'wheel', 'admin') if m != 'root']
    return s


SCREEN_SHARING = 'system/com.apple.screensharing'


def mac_screen_sharing_on():
    """Screen Sharing is on when launchd has its service loaded (it then listens on port 5900)."""
    return sh(['launchctl', 'print', SCREEN_SHARING], timeout=20)[0] == 0


def set_screen_sharing(on):
    if not IS_MAC:
        raise RuntimeError('Remote desktop is managed on Windows and macOS only')
    if on:
        sh(['launchctl', 'enable', SCREEN_SHARING])
        sh(['launchctl', 'bootstrap', 'system', '/System/Library/LaunchDaemons/com.apple.screensharing.plist'])
    else:
        sh(['launchctl', 'bootout', SCREEN_SHARING])
        sh(['launchctl', 'disable', SCREEN_SHARING])
    if mac_screen_sharing_on() != on:
        raise RuntimeError('macOS did not allow the change. Turn Screen Sharing %s in System Settings > General > Sharing on this Mac.' % ('on' if on else 'off'))
    if not on:
        return 'Screen Sharing is off.'
    return 'Screen Sharing is on (port 5900). Sign in with a user account on this Mac that is allowed in System Settings > General > Sharing > Screen Sharing.'


def software():
    items = []
    if IS_MAC:
        for app in sorted(set(glob.glob('/Applications/*.app') + glob.glob('/Applications/*/*.app'))):
            info = {}
            try:
                with open(os.path.join(app, 'Contents', 'Info.plist'), 'rb') as f:
                    info = plistlib.load(f)
            except Exception:  # noqa: BLE001 - unreadable bundles are skipped
                pass
            items.append({'name': info.get('CFBundleName') or os.path.basename(app)[:-4], 'version': str(info.get('CFBundleShortVersionString', '')), 'publisher': str(info.get('CFBundleIdentifier', ''))})
    elif shutil.which('dpkg-query'):
        for line in out(['dpkg-query', '-W', '-f=${binary:Package}\t${Version}\t${Maintainer}\n']).splitlines():
            p = line.split('\t')
            if len(p) >= 2:
                items.append({'name': p[0], 'version': p[1], 'publisher': p[2] if len(p) > 2 else ''})
    elif shutil.which('rpm'):
        for line in out(['rpm', '-qa', '--qf', '%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\n']).splitlines():
            p = line.split('\t')
            if len(p) >= 2:
                items.append({'name': p[0], 'version': p[1], 'publisher': p[2] if len(p) > 2 else ''})
    items.sort(key=lambda x: x['name'].lower())
    return items[:3000]


def detected(name, sw):
    return bool(name) and any(name.lower() in s['name'].lower() for s in sw)


# ------------------------------------------------------------------ updates
def update_scan():
    missing = []
    if IS_MAC:
        code, text = sh(['softwareupdate', '-l'], timeout=900)
        for m in re.finditer(r'\* Label: (.+)\n\s*Title: ([^,]+), Version: ([^,]+), Size: (\d+)KiB, Recommended: (\w+), (?:Action: (\w+))?', text):
            label = m.group(1).strip()
            missing.append({'id': 'MAC:' + label, 'kb': label, 'title': m.group(2).strip() + ' ' + m.group(3).strip(), 'product': 'macOS', 'classification': 'macOS',
                            'severity': 'Important' if m.group(5) == 'YES' else 'Low', 'sizeMB': round(int(m.group(4)) / 1024), 'reboot': m.group(6) == 'restart'})
    elif shutil.which('apt-get'):
        sh(['apt-get', 'update', '-qq'], timeout=600, env=dict(os.environ, DEBIAN_FRONTEND='noninteractive'))
        for line in out(['apt', 'list', '--upgradable'], timeout=300).splitlines():
            m = re.match(r'^([^/]+)/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from: ([^\]]+)\]', line)
            if not m:
                continue
            sec = '-security' in m.group(2)
            missing.append({'id': 'APT:' + m.group(1), 'kb': m.group(1), 'title': '%s %s (installed %s)' % (m.group(1), m.group(3), m.group(4)), 'product': os_release().get('NAME', 'Linux'),
                            'classification': 'Security Updates' if sec else 'Linux packages', 'severity': 'Important' if sec else 'Low', 'reboot': m.group(1).startswith('linux-image')})
    elif shutil.which('dnf') or shutil.which('yum'):
        tool = 'dnf' if shutil.which('dnf') else 'yum'
        security_pkgs = set(l.split()[-1].rsplit('-', 2)[0] for l in out([tool, '-q', 'updateinfo', 'list', '--security'], timeout=600).splitlines() if l.strip())
        code, text = sh([tool, '-q', 'check-update'], timeout=600)
        for line in text.splitlines():
            p = line.split()
            if len(p) == 3 and '.' in p[0] and not line.startswith(' '):
                name = p[0].rsplit('.', 1)[0]
                sec = name in security_pkgs
                missing.append({'id': 'RPM:' + name, 'kb': name, 'title': '%s %s' % (name, p[1]), 'product': os_release().get('NAME', 'Linux'),
                                'classification': 'Security Updates' if sec else 'Linux packages', 'severity': 'Important' if sec else 'Low', 'reboot': name.startswith('kernel')})
    return {'scannedAt': iso(), 'missing': missing, 'installed': []}


def install_updates(ids):
    names = [i.split(':', 1)[1] for i in ids if ':' in i]
    if not names:
        return {'ok': True, 'message': 'Nothing to install'}
    if IS_MAC:
        code, text = sh(['softwareupdate', '-i'] + names, timeout=7200)
    elif shutil.which('apt-get'):
        code, text = sh(['apt-get', 'install', '-y', '--only-upgrade', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold'] + names,
                        timeout=7200, env=dict(os.environ, DEBIAN_FRONTEND='noninteractive'))
    else:
        code, text = sh(['dnf' if shutil.which('dnf') else 'yum', '-y', 'upgrade'] + names, timeout=7200)
    tail = ' '.join(text.strip().splitlines()[-3:])
    return {'ok': code == 0, 'code': None if code == 0 else str(code), 'reboot': os.path.exists('/var/run/reboot-required') or 'restart' in text.lower(), 'message': tail[:280]}


# ------------------------------------------------------------------ software deployments
def download(url, sha256):
    d = os.path.join(HOME, 'cache')
    os.makedirs(d, exist_ok=True)
    name = os.path.basename(urllib.parse.urlparse(url).path) or 'installer'
    path = os.path.join(d, name)
    try:
        with urllib.request.urlopen(url, timeout=3600) as r, open(path, 'wb') as f:
            shutil.copyfileobj(r, f)
    except (urllib.error.URLError, OSError) as e:
        return None, {'ok': False, 'code': 'DOWNLOAD', 'message': str(e)[:280]}
    if sha256:
        h = hashlib.sha256()
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(1 << 20), b''):
                h.update(chunk)
        if h.hexdigest().lower() != sha256.lower():
            os.remove(path)
            return None, {'ok': False, 'code': 'HASH', 'message': 'SHA-256 mismatch'}
    return path, None


def pkg_tool():
    if shutil.which('apt-get'):
        return 'apt-get'
    return 'dnf' if shutil.which('dnf') else 'yum'


def install_app(dep, sw):
    a = dep.get('app') or {}
    env = dict(os.environ, DEBIAN_FRONTEND='noninteractive')
    if dep.get('action') == 'Uninstall':
        if a.get('uninstall'):
            code, text = sh(a['uninstall'], shell=True, timeout=3600)
        elif a.get('package') and not IS_MAC:
            code, text = sh([pkg_tool(), 'remove', '-y', a['package']], timeout=3600, env=env)
        elif IS_MAC:
            apps = [p for p in glob.glob('/Applications/*.app') if a.get('detectName', '').lower() in os.path.basename(p).lower()]
            if not apps:
                return {'ok': True, 'message': 'Not installed'}
            for p in apps:
                shutil.rmtree(p, ignore_errors=True)
            code, text = 0, 'Removed ' + ', '.join(apps)
        else:
            return {'ok': False, 'code': 'NO_METHOD', 'message': 'Add an uninstall command in the software library'}
    elif a.get('package') and not IS_MAC:
        code, text = sh([pkg_tool(), 'install', '-y', a['package']], timeout=3600, env=env)
    elif a.get('url'):
        path, err = download(a['url'], a.get('sha256'))
        if err:
            return err
        low = path.lower()
        if low.endswith('.pkg'):
            code, text = sh(['installer', '-pkg', path, '-target', '/'], timeout=3600)
        elif low.endswith('.dmg'):
            mnt = tempfile.mkdtemp(prefix='ggt-')
            code, text = sh(['hdiutil', 'attach', '-nobrowse', '-quiet', '-mountpoint', mnt, path], timeout=600)
            if code == 0:
                pkgs = glob.glob(os.path.join(mnt, '*.pkg'))
                apps = glob.glob(os.path.join(mnt, '*.app'))
                if pkgs:
                    code, text = sh(['installer', '-pkg', pkgs[0], '-target', '/'], timeout=3600)
                elif apps:
                    dest = os.path.join('/Applications', os.path.basename(apps[0]))
                    shutil.rmtree(dest, ignore_errors=True)
                    code, text = sh(['cp', '-R', apps[0], '/Applications/'], timeout=1800)
                else:
                    code, text = 1, 'No .pkg or .app in the disk image'
                sh(['hdiutil', 'detach', '-quiet', mnt], timeout=120)
        elif low.endswith('.deb'):
            code, text = sh(['apt-get', 'install', '-y', path], timeout=3600, env=env)
        elif low.endswith('.rpm'):
            code, text = sh([pkg_tool(), 'install', '-y', path], timeout=3600)
        else:
            code, text = 1, 'Unsupported installer type: ' + os.path.basename(path)
        try:
            os.remove(path)
        except OSError:
            pass
    elif a.get('command'):
        code, text = sh(a['command'], shell=True, timeout=3600)
    else:
        return {'ok': False, 'code': 'NO_METHOD', 'message': 'No install method for this platform'}
    if code == -1:
        return {'ok': False, 'code': 'TIMEOUT', 'message': 'Timed out'}
    tail = ' '.join(text.strip().splitlines()[-3:])[:280]
    return {'ok': code == 0, 'code': None if code == 0 else str(code), 'message': 'Exit code %s. %s' % (code, tail)}


def remediate(ids, sec):
    done, errors = [], []
    if IS_MAC and 'fw' in ids and sec.get('fwOn') is False:
        code, text = sh(['/usr/libexec/ApplicationFirewall/socketfilterfw', '--setglobalstate', 'on'])
        (done if code == 0 else errors).append('Turned the firewall on' if code == 0 else 'Firewall: ' + text.strip()[:200])
    return done, errors


def request_restart():
    log('Restarting in 5 minutes')
    sh(['shutdown', '-r', '+5', 'Go-Green IT: restarting in 5 minutes to finish updates. Save your work.'], timeout=30)


# ------------------------------------------------------------------ one cycle
def send_status(dep_id, state, code=None, message=None):
    try:
        api('POST', '/api/agent/status', {'deviceId': CONFIG['deviceId'], 'deploymentId': dep_id, 'state': state, 'errorCode': code, 'message': message})
    except ApiError as e:
        log(str(e), 'warn')


def checkin(inv, sec, sw, upd, events, errors):
    body = dict(inv)
    body['security'] = sec
    if CONFIG.get('deviceId'):
        body['deviceId'] = CONFIG['deviceId']
    if sw is not None:
        body['software'] = sw
    if upd is not None:
        body['updates'] = upd
    body['events'] = [{'level': 'info', 'message': e} for e in events]
    body['errors'] = errors
    try:
        r = api('POST', '/api/agent/checkin', body)
    except ApiError as e:
        if e.status == 404 and CONFIG.get('deviceId'):
            log('The server no longer knows this device. Enrolling again.', 'warn')
            CONFIG['deviceId'] = CONFIG['deviceKey'] = None
            body.pop('deviceId', None)
            r = api('POST', '/api/agent/checkin', body)
        else:
            raise
    if r.get('deviceKey'):
        CONFIG['deviceId'], CONFIG['deviceKey'] = r['deviceId'], r['deviceKey']
        write_json(os.path.join(HOME, 'config.json'), CONFIG)
        log('Enrolled as device %s' % r['deviceId'])
    return r


def cycle(skip_scan=False):
    state_path = os.path.join(HOME, 'state.json')
    state = read_json(state_path)
    deps = state.get('deps', {})
    now = now_ms()
    errors = []
    events = list(state.get('pendingEvents') or [])

    inv, sec, sw = inventory(), security(), software()
    sw_hash = hashlib.sha256('\n'.join('%s|%s' % (s['name'], s['version']) for s in sw).encode()).hexdigest()
    send_sw = state.get('forceInventory') or sw_hash != state.get('softwareHash') or now - state.get('softwareAt', 0) > 86400000
    upd = None
    # A new device checks in before its first (slow) update scan, so it shows in the console at once.
    if not CONFIG.get('deviceId'):
        checkin(inv, sec, sw, None, events, errors)
        events = []
    if not skip_scan and (state.get('forceScan') or now - state.get('lastScan', 0) > 6 * 3600000):
        try:
            log('Scanning for updates')
            upd = update_scan()
            state['lastScan'], state['forceScan'] = now, False
            log('%d updates missing' % len(upd['missing']))
        except Exception as e:  # noqa: BLE001 - reported to the console
            errors.append('Update scan failed: %s' % e)
    checkin(inv, sec, sw if send_sw else None, upd, events, errors)
    if send_sw:
        state.update(softwareHash=sw_hash, softwareAt=now, forceInventory=False)
    state['pendingEvents'] = []
    new_events = []
    policy = api('GET', '/api/agent/policy?deviceId=' + urllib.parse.quote(CONFIG['deviceId']))
    changed = False

    for c in policy.get('commands') or []:
        log('Running command %s %s' % (c.get('type'), c.get('name') or ''))
        res = {'status': 'succeeded', 'exitCode': 0, 'output': ''}
        t = c.get('type')
        if t == 'script':
            if c.get('lang') != 'Shell':
                res = {'status': 'failed', 'exitCode': None, 'output': '%s scripts run on Windows only' % c.get('lang')}
            else:
                code, text = sh(['/bin/sh', '-c', c.get('body') or ''], timeout=600)
                res = {'status': 'succeeded' if code == 0 else 'failed', 'exitCode': code, 'output': text[-60000:]}
        elif t == 'restart':
            request_restart()
            res['output'] = 'Restart scheduled in 5 minutes'
        elif t == 'inventory':
            state['forceInventory'] = changed = True
            res['output'] = 'Inventory sent'
        elif t == 'updscan':
            state['forceScan'] = changed = True
            res['output'] = 'Update scan started'
        elif t in ('remoteon', 'remoteoff'):
            try:
                res['output'] = set_screen_sharing(t == 'remoteon')
                changed = True
            except Exception as e:  # noqa: BLE001 - reported to the console
                res = {'status': 'failed', 'exitCode': None, 'output': str(e)}
        elif t in ('vpnjoin', 'vpnleave'):
            try:
                res['output'] = join_tailscale(c.get('authKey')) if t == 'vpnjoin' else leave_tailscale()
                state['forceInventory'] = changed = True
            except Exception as e:  # noqa: BLE001 - reported to the console
                res = {'status': 'failed', 'exitCode': None, 'output': str(e)}
        else:
            res = {'status': 'failed', 'exitCode': None, 'output': 'Unknown command %s' % t}
        try:
            api('POST', '/api/agent/result', {'deviceId': CONFIG['deviceId'], 'commandId': c['id'], 'status': res['status'], 'exitCode': res['exitCode'], 'output': res['output']})
        except ApiError as e:
            log(str(e), 'warn')

    if policy.get('remediate'):
        done, errs = remediate(policy['remediate'], sec)
        new_events += done + ['Remediation failed: ' + e for e in errs]
        changed = changed or bool(done)

    restart = False
    for d in policy.get('deployments') or []:
        prev = deps.get(d['id'], {})
        if d['kind'] == 'app':
            want = d.get('action') != 'Uninstall'
            if detected((d.get('app') or {}).get('detectName'), sw) == want:
                if prev.get('state') != 'success':
                    send_status(d['id'], 'success', None, 'Detected')
                    deps[d['id']] = {'state': 'success', 'at': now}
                continue
        if not d.get('allowedNow'):
            continue
        if prev.get('state') == 'error' and prev.get('at', 0) > (d.get('retryAt') or 0) and now - prev.get('at', 0) < 86400000:
            continue
        send_status(d['id'], 'inprogress')
        log('Deployment %s: starting' % d.get('name'))
        try:
            if d['kind'] == 'app':
                res = install_app(d, sw)
                sw = software()
                if res['ok'] and detected(d['app'].get('detectName'), sw) != (d.get('action') != 'Uninstall'):
                    res = {'ok': False, 'code': 'NOT_DETECTED', 'message': res.get('message')}
            else:
                res = install_updates(d.get('updateIds') or [])
                state['forceScan'] = True
        except Exception as e:  # noqa: BLE001 - reported to the console
            res = {'ok': False, 'code': 'ERROR', 'message': str(e)[:280]}
        changed = True
        send_status(d['id'], 'success' if res['ok'] else 'error', res.get('code'), res.get('message'))
        deps[d['id']] = {'state': 'success' if res['ok'] else 'error', 'at': now_ms()}
        log('Deployment %s: %s' % (d.get('name'), 'succeeded' if res['ok'] else 'failed %s %s' % (res.get('code'), res.get('message'))))
        if res.get('reboot') and d.get('restart') == 'Allow':
            restart = True

    if changed:
        upd2 = None
        if state.get('forceScan') and not skip_scan:
            try:
                upd2 = update_scan()
                state['lastScan'], state['forceScan'] = now_ms(), False
            except Exception as e:  # noqa: BLE001
                errors.append('Update scan failed: %s' % e)
        try:
            checkin(inventory(), security(), software(), upd2, new_events, errors)
            new_events = []
            state.update(softwareAt=now_ms(), forceInventory=False)
        except ApiError as e:
            log(str(e), 'warn')
    if restart:
        request_restart()
    state['pendingEvents'] = new_events
    state['deps'] = deps
    write_json(state_path, state)


# ------------------------------------------------------------------ install / uninstall
SYSTEMD_SERVICE = """[Unit]
Description=Go-Green Device Manager agent
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=%s %s run
TimeoutStartSec=3h
"""
SYSTEMD_TIMER = """[Unit]
Description=Run the Go-Green Device Manager agent every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
RandomizedDelaySec=30
Persistent=true

[Install]
WantedBy=timers.target
"""
LAUNCHD_LABEL = 'com.go-green.ggt-agent'
LAUNCHD_PLIST = '/Library/LaunchDaemons/%s.plist' % LAUNCHD_LABEL


def schedule(script):
    py = sys.executable or '/usr/bin/python3'
    if IS_MAC:
        with open(LAUNCHD_PLIST, 'wb') as f:
            plistlib.dump({'Label': LAUNCHD_LABEL, 'ProgramArguments': [py, script, 'run'], 'StartInterval': 300, 'RunAtLoad': True,
                           'StandardOutPath': '/dev/null', 'StandardErrorPath': '/dev/null'}, f)
        os.chmod(LAUNCHD_PLIST, 0o644)
        sh(['launchctl', 'unload', LAUNCHD_PLIST])
        sh(['launchctl', 'load', '-w', LAUNCHD_PLIST])
        return 'launchd (%s)' % LAUNCHD_LABEL
    if shutil.which('systemctl') and os.path.isdir('/run/systemd/system'):
        with open('/etc/systemd/system/ggt-agent.service', 'w') as f:
            f.write(SYSTEMD_SERVICE % (py, script))
        with open('/etc/systemd/system/ggt-agent.timer', 'w') as f:
            f.write(SYSTEMD_TIMER)
        sh(['systemctl', 'daemon-reload'])
        sh(['systemctl', 'enable', '--now', 'ggt-agent.timer'])
        return 'systemd timer ggt-agent.timer'
    with open('/etc/cron.d/ggt-agent', 'w') as f:
        f.write('*/5 * * * * root %s %s run >/dev/null 2>&1\n' % (py, script))
    return 'cron (/etc/cron.d/ggt-agent)'


def unschedule():
    if IS_MAC:
        sh(['launchctl', 'unload', LAUNCHD_PLIST])
        if os.path.exists(LAUNCHD_PLIST):
            os.remove(LAUNCHD_PLIST)
        return
    sh(['systemctl', 'disable', '--now', 'ggt-agent.timer'])
    for f in ('/etc/systemd/system/ggt-agent.service', '/etc/systemd/system/ggt-agent.timer', '/etc/cron.d/ggt-agent'):
        if os.path.exists(f):
            os.remove(f)
    sh(['systemctl', 'daemon-reload'])


@contextlib.contextmanager
def run_lock(wait):
    """One agent run at a time (scheduled runs and a manual install or run)."""
    f = open(os.path.join(HOME, 'run.lock'), 'a')
    try:
        try:
            fcntl.flock(f, fcntl.LOCK_EX if wait else fcntl.LOCK_EX | fcntl.LOCK_NB)
            got = True
        except BlockingIOError:
            got = False
        yield got
    finally:
        f.close()


def main():
    global HOME, LOG_PATH, CONFIG
    ap = argparse.ArgumentParser(description='Go-Green Device Manager agent')
    ap.add_argument('command', choices=['install', 'uninstall', 'run'])
    ap.add_argument('--server')
    ap.add_argument('--token')
    ap.add_argument('--home', help='agent folder (default %s)' % DEFAULT_HOME)
    ap.add_argument('--no-schedule', action='store_true', help='install without the 5-minute schedule (testing)')
    ap.add_argument('--skip-update-scan', action='store_true')
    a = ap.parse_args()
    if a.home:
        HOME = a.home
        LOG_PATH = os.path.join(HOME, 'agent.log')
    elif os.geteuid() != 0:
        sys.exit('Run as root (sudo).')
    cfg_path = os.path.join(HOME, 'config.json')

    if a.command == 'install':
        if not a.server or not a.token:
            sys.exit('install needs --server and --token')
        server = a.server.rstrip('/')
        if not re.match(r'^https://', server) and not re.match(r'^http://(localhost|127\.0\.0\.1)(:\d+)?$', server):
            sys.exit('Server must be an https:// address.')
        os.makedirs(HOME, exist_ok=True)
        os.chmod(HOME, 0o700)
        target = os.path.join(HOME, 'ggt-agent.py')
        if os.path.abspath(__file__) != os.path.abspath(target):
            shutil.copyfile(__file__, target)
        os.chmod(target, 0o700)
        old = read_json(cfg_path)
        CONFIG = {'server': server, 'token': a.token, 'deviceId': None, 'deviceKey': None}
        if old.get('server') == server and old.get('deviceId'):
            CONFIG['deviceId'], CONFIG['deviceKey'] = old['deviceId'], old.get('deviceKey')
        write_json(cfg_path, CONFIG)
        # Check in before scheduling, so a scheduled run (launchd starts one at once) can't
        # enrol at the same time and replace this run's device key.
        log('Installed agent %s in %s. Checking in now.' % (AGENT_VERSION, HOME))
        with run_lock(wait=True):
            cycle(a.skip_update_scan)
        log('First check-in done. The device now shows in the Device Manager.')
        if not a.no_schedule:
            log('Scheduled with ' + schedule(target))
        return
    if a.command == 'uninstall':
        unschedule()
        shutil.rmtree(HOME, ignore_errors=True)
        print('GGT Agent removed. Retire the device in the Device Manager to remove its record.')
        return
    CONFIG = read_json(cfg_path)
    if not CONFIG.get('server') or not CONFIG.get('token'):
        sys.exit('Not installed. Run: ggt-agent.py install --server https://<site> --token <token>')
    try:
        with run_lock(wait=False) as got:
            if not got:
                log('Another agent run is still in progress; skipping this one.')
                return
            cycle(a.skip_update_scan)
    except Exception as e:  # noqa: BLE001 - logged for the admin
        log(str(e), 'error')
        sys.exit(1)


if __name__ == '__main__':
    main()
