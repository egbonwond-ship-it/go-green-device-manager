# GO-Green Device Manager (`go-green-device-manager`)

A systems-management console for **Go-Green Technologies**: deploy software, manage updates, enforce compliance and monitor every Windows, macOS and Linux computer. The feature set is inspired by enterprise tools like Microsoft Configuration Manager (SCCM); the design and code are original.

It's branded with the company's logo (`app/logo-full.svg`), the site's **Space Grotesk** font and its greens (`#0d2b1d`, `#1a6b3c`, `#228a49`, `#62d37a`).

It runs as an **Azure Static Web App**:
- **Console** `app/`: plain HTML, CSS and JavaScript modules. No build step.
- **API** `api/`: Azure Functions (Node 20) at `/api/*`. Data is kept in **Supabase** (or any PostgreSQL).
- **Agent** `app/agent/`: `ggt-agent.ps1` for Windows and `ggt-agent.py` for macOS and Linux, served from the site so devices can download it.

Everything the console shows comes from agents on real devices. There is no demo data.

## How it works

```
 device ── every 5 min ──► POST /api/agent/checkin   inventory, security settings, software, updates
   (agent)                 GET  /api/agent/policy    deployments, approved updates, remediation, scripts
                           POST /api/agent/status    result per deployment
                           POST /api/agent/result    script output
 admin ── browser ───────► /api/console/*            console data and changes (signed-in admins only)
```

| Area | What it does |
|---|---|
| Overview | Device count, online %, compliance per baseline, missing critical updates, deployments, open alerts, OS and site breakdown, activity. |
| Devices | Inventory from each agent: hardware, OS, network, security settings, every installed program, updates, compliance, deployments and collections. Actions: refresh inventory, scan for updates, run script, tags, restart, retire. CSV export. |
| Collections | Rule-based device groups (platform, OS, type, site, tag, health, manufacturer, name, user, installed app). |
| Software library | Applications with how to install them per platform (winget ID, MSI/EXE/PKG/DMG/DEB/RPM URL with SHA-256, package name, or a command) and how to detect them. |
| Deployments | Install or uninstall an application, or install an update group, on a collection: install time, maintenance windows, restart behaviour. Live per-device results and error codes; retry failed. |
| Remote desktop | Turn Remote Desktop (Windows) or Screen Sharing (macOS) on or off through the agent, see which devices accept connections, and connect: a `.rdp` file for Windows PCs, `vnc://` for Macs. Works on the office network or VPN. |
| Software updates | Every update agents report (Windows Update, macOS softwareupdate, apt, dnf/yum) with required and installed counts. Update groups, and automatic deployment rules that approve matching updates for a collection as devices find them. |
| Compliance | Three baselines (Endpoint Security, OS Currency & Patching, Corporate Configuration). Per-rule results, compliance by site, non-compliant devices. Optional automatic remediation by the agent. |
| Monitoring & alerts | Online/offline/inactive, alerts (firewall or antivirus turned off, new local admin, low disk, failed deployment) with acknowledge, health map by site, CPU and disk, activity log. |
| Run scripts | PowerShell (Windows) and shell (macOS/Linux) script library; run on a device or a collection and read each device's output. |
| Reports | Missing critical updates, devices without an update scan, non-compliant by baseline, software inventory, deployment summary, hardware, refresh candidates, inactive clients, Windows 11 readiness. CSV export. |
| Administration | Maintenance windows, sites and IP ranges, approved local administrators, agent enrollment, server status. |

## Sign-in

Static Web Apps' built-in sign-in protects the whole console (Microsoft or GitHub accounts). Only accounts listed in the **`ADMIN_USERS`** setting can see or change anything; everyone else sees "No access yet". `ADMIN_USERS` is a comma-separated list of GitHub usernames and/or Microsoft account emails. The agent endpoints and `/api/health` are the only public routes.

## Settings (Azure portal → Static Web App → Environment variables)

| Setting | Purpose |
|---|---|
| `ADMIN_USERS` | Who may use the console, e.g. `egbonwond-ship-it, it@go-greentechnologies.com`. |
| `AGENT_ENROLL_TOKEN` | Long random secret agents must present. Shown to admins in **Devices → Enrol devices**. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Supabase project URL and service-role key. Run `db/supabase-setup.sql` once in the SQL editor first. |
| `POSTGRES_URL` | Alternative to Supabase: any PostgreSQL connection string (tables are created in a `ggt` schema). |

Without a database setting the API keeps data in memory, which is lost on restart (fine for local runs only). `/api/health` reports which storage is in use.

## Enrol devices

The easiest way: in the console open **Devices → Enrol devices** and select **Download Windows setup** or **Download macOS / Linux setup**. The file has this site's address and the enrollment token built in (keep it private). On Windows double-click `GoGreenAgentSetup.cmd` and approve the administrator prompt; on macOS or Linux run `sudo sh ~/Downloads/go-green-agent-setup.sh`. Or use the commands below.

**Windows 10/11, Server 2016+** (PowerShell as administrator; runs every 5 minutes as SYSTEM from the scheduled task `\Go-Green\GGT Agent`):
```powershell
Invoke-WebRequest https://<site>/agent/ggt-agent.ps1 -OutFile $env:TEMP\ggt-agent.ps1 -UseBasicParsing
powershell -ExecutionPolicy Bypass -File $env:TEMP\ggt-agent.ps1 -Install -Server https://<site> -Token '<AGENT_ENROLL_TOKEN>'
```
**macOS / Linux** (Python 3; launchd, a systemd timer or cron):
```bash
curl -fsSL https://<site>/agent/ggt-agent.py -o /tmp/ggt-agent.py
sudo python3 /tmp/ggt-agent.py install --server https://<site> --token '<AGENT_ENROLL_TOKEN>'
```
Uninstall with `-Uninstall` / `uninstall`, then retire the device in the console. Intune, Group Policy or an RMM tool can run the same commands across many PCs.

The first check-in gives each device its own key (stored in the agent's config, readable only by SYSTEM/root); the server keeps only a hash. A reinstalled agent with the same computer name and serial number keeps its device record.

What the agent reports and does:
- **Inventory:** name, OS and build, type (laptop, desktop, server, VM), manufacturer, model, serial, CPU, memory, disk, IP and MAC, signed-in user, last boot, CPU and memory use, and installed programs (sent when they change, at least daily).
- **Security:** disk encryption (BitLocker, FileVault, LUKS), antivirus real-time protection and definition age (Microsoft Defender or Windows Security Center), firewall, screen-lock timeout, local administrators, USB storage block, pending restart.
- **Updates:** scans every 6 hours, or when asked, and installs approved updates.
- **Remote desktop:** turns Remote Desktop (with Network Level Authentication and its firewall rules) or macOS Screen Sharing on or off when asked, and reports whether it's on. Newer macOS versions may only allow Screen Sharing to be turned on in System Settings.
- **Remediation** (only for baselines where you turn it on): firewall, Defender real-time protection and definitions, screen lock, USB storage block on Windows; firewall on macOS.

## Run locally

Node.js 20 or newer. No dependencies are needed for the local server.

```bash
npm start            # http://localhost:4280, signed in as "local-admin", agent token "dev-token"
npm test             # API, sign-in, policy and rule tests
npm run test:agent   # runs the real agent on this machine against a local server (needs admin/sudo)
```
Then enrol your own machine against `http://localhost:4280` with the commands above (`-Token dev-token`).

CI (`.github/workflows/azure-static-web-apps.yml`) runs the tests, then runs the agent end to end on real **Windows, macOS and Ubuntu** machines (enrol, inventory, deploy and remove an app, run a script, install and remove the schedule) before deploying.

## Deploy

1. Azure portal → Static Web App `go-green-device-manager` (Free plan). Copy the deployment token into the GitHub secret `AZURE_STATIC_WEB_APPS_API_TOKEN`.
2. Set the environment variables above.
3. Push to `main`. The workflow tests and deploys `app/` and `api/`. Pull requests get a staging URL.

`app/staticwebapp.config.json` requires sign-in for everything except the agent routes, `/api/health`, the sign-in page and the agent downloads, and sets security headers (CSP, HSTS, no framing).

## Limits and next steps

- **Distribution:** installers download straight from the URL in the software library. Host them on HTTPS storage you control (for example Azure Blob Storage) and set the SHA-256.
- **Timing:** agents act at their next check-in (within about 5 minutes). There is no instant push.
- **Roles:** every admin can do everything. Separate roles (helpdesk, viewer) need the Standard plan's custom roles or more checks in `api/src/lib/router.js`.
- **History:** the activity log, alerts and command results are kept in the database without automatic pruning.
- **Signing:** the agent scripts aren't code-signed. If your PCs enforce AllSigned, sign `ggt-agent.ps1` with your code-signing certificate.

## Project layout

```
app/                       Console (deployed as-is)
  index.html, login.html, styles.css, logo-*.svg, staticwebapp.config.json
  js/store.js              Console state from the API, collection and compliance rules
  js/ui.js                 Tables, modals, drawers, charts
  js/agent-setup.js        Downloadable agent setup files (Windows .cmd, macOS/Linux .sh)
  js/views/*.js            One file per page (remote.js: Remote desktop)
  agent/ggt-agent.ps1      Windows agent
  agent/ggt-agent.py       macOS and Linux agent
api/src/lib/router.js      API routes, sign-in check, agent auth
api/src/lib/model.js       Device records, collections, maintenance windows, agent policy
api/src/lib/storage.js     Supabase / PostgreSQL / memory storage
api/src/lib/defaults.js    Built-in collections, baselines and scripts
db/supabase-setup.sql      Tables for Supabase
dev-server.js              Local server for console + API
scripts/smoke-test.js      API tests
scripts/agent-e2e.js       Real agent end-to-end test
```
