# GO-Green Device Manager (`go-green-device-manager`)

A systems-management console for **Go-Green Technologies**: deploy software, manage updates, enforce compliance and monitor every laptop, desktop and server across the Lagos, Abuja, Port Harcourt, Ibadan and Kano sites. The feature set is inspired by enterprise tools like Microsoft Configuration Manager (SCCM); the design and code are original.

It is branded with the company's own logo (`app/logo-full.svg`, from go-greentechnologies.com), the site's **Space Grotesk** font and its greens (`#0d2b1d`, `#1a6b3c`, `#228a49`, `#62d37a`).

It runs as an **Azure Static Web App**:
- **Frontend** `app/`: plain HTML, CSS and JavaScript modules. No build step.
- **API** `api/`: Azure Functions (Node 20, v4 model) at `/api/*`, for the device agent to check in, fetch policy and report results.

> **Demo data.** Real device agents don't exist yet, so the console runs on a simulated estate of 260 devices. Agents "check in" every few seconds, deployments progress, settings drift and alerts fire. Everything you change is saved in your browser (Administration → Reset demo data starts over). See [Production backend](#production-backend) for what replaces the simulation.

## Features

| Area | What it does |
|---|---|
| Overview | Device count, online %, compliance per baseline, missing critical updates, deployment progress, open alerts, OS and site breakdown, recent activity. |
| Devices | Searchable, filterable inventory (site, OS, type, client health, compliance) with CSV export. Each device opens to hardware, network, agent and security details, installed software, updates, compliance per rule, deployment results and collections. Remote actions: sync policy, inventory, update scan, compliance evaluation, run script, restart, Wake-on-LAN. |
| Collections | Rule-based device groups (platform, OS, type, site, department, tag, health, manufacturer, name, installed app) with *all/any* matching and a live member preview. Built-in collections plus deployment rings (Pilot, Broad). |
| Software library | Applications with installer type, install command, detection method, platforms, size, install count, and content status on each site's distribution point. Add your own applications. |
| Deployments | 4-step wizard: software → collection → settings (Required/Available, available time, deadline, maintenance windows, restart behaviour) → review with an impact preview. Live per-device status (success, in progress, error, requirements not met, unknown), error code breakdown, retry failed, disable, delete. |
| Software updates | Catalogue of Windows, Server, .NET, Defender, Microsoft 365, macOS, Ubuntu and Chrome updates with required/installed counts per update. Tick updates to build an update group and deploy it. Automatic deployment rules (ADRs) for definitions and Patch Tuesday rings, with run now / enable / disable. |
| Compliance | Three baselines (Endpoint Security, OS Currency & Patching, Corporate Configuration) with per-rule pass/fail, compliance by site, the list of non-compliant devices, automatic remediation and "Remediate now". |
| Monitoring & alerts | Online/offline/inactive counts, alert feed with acknowledge, a health map with one square per device by site, highest CPU, lowest disk, distribution point health and status messages. |
| Run scripts | Approved PowerShell scripts (disk usage, clear temp, restart spooler, gpupdate, collect logs) run against a device or a whole collection with per-device output. |
| Reports | Missing critical updates, non-compliant by baseline, software inventory, deployment summary, hardware inventory, refresh candidates, inactive clients, Windows 11 readiness. All export to CSV. |
| Administration | Maintenance windows per collection, sites and boundaries, simulation on/off, reset demo data, API health. |

Dark mode follows the system setting, with a toggle in the top bar. The layout works on phones.

## Run it locally

You need Node.js 20 or newer. No dependencies are needed for the local server.

```bash
npm start            # http://localhost:4280 (static app + API, same headers as Azure)
npm test             # engine and API smoke tests
```

To use the real Azure Functions runtime instead: `npm i -g @azure/static-web-apps-cli azure-functions-core-tools@4`, `npm --prefix api install`, then `npm run swa`.

## Deploy to Azure Static Web Apps

1. Azure portal → **Create a resource → Static Web App**. Name `go-green-device-manager`, plan **Free** (or Standard for custom auth and SLA), region **West Europe**.
2. Deployment source: **Other** (this repo already has a workflow). After it's created, open **Manage deployment token** and copy it.
3. In GitHub → this repo → **Settings → Secrets and variables → Actions**, add `AZURE_STATIC_WEB_APPS_API_TOKEN` with that token.
4. Push to `main` (or run the workflow manually). `.github/workflows/azure-static-web-apps.yml` runs the tests and deploys `app/` and `api/`. Pull requests get their own staging URL.
5. In the Static Web App → **Environment variables**, set `AGENT_ENROLL_TOKEN` to a long random value. Agents must send it in the `x-ggt-enroll-token` header. Without it the API accepts only `demo-token`.
6. **Database (free).** Create an Azure SQL Database with the **free offer** (100,000 vCore seconds and 32 GB a month, set to pause when the free amount is used so it never bills), then set `SQL_CONNECTION_STRING` on the Static Web App:
   ```bash
   az sql server create -n <server> -g go-green-rg -l eastus2 --enable-ad-only-auth false -u ggtadmin -p '<strong password>'
   az sql server firewall-rule create -s <server> -g go-green-rg -n AllowAzureServices --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0
   az sql db create -s <server> -g go-green-rg -n ggt-devices --edition GeneralPurpose --compute-model Serverless --family Gen5 --capacity 2 --use-free-limit --free-limit-exhaustion-behavior AutoPause
   az staticwebapp appsettings set -n go-green-device-manager --setting-names SQL_CONNECTION_STRING="Server=tcp:<server>.database.windows.net,1433;Database=ggt-devices;User ID=ggtadmin;Password=<password>;Encrypt=true"
   ```
   **Or Supabase over its REST API (free, no database password):** run `db/supabase-setup.sql` once in Supabase's SQL editor, then set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (Project Settings → API → service_role key) on the Static Web App. The tables have Row Level Security on with no policies, so the public anon key can't reach them.

   **Or PostgreSQL / Supabase (free):** set `POSTGRES_URL` to the project's connection pooler URL (Supabase → Project Settings → Database → Connection string → Transaction pooler). The API creates a private `ggt` schema with `devices` and `deployment_status` tables on first use; it stays out of Supabase's public REST API.

   The API creates its `devices` and `deployment_status` tables on first use. The free Azure SQL database pauses when idle, so the first check-in after a quiet spell can take up to a minute. Azure Cosmos DB also works (`COSMOS_CONNECTION_STRING`, free tier). Without either setting, data is kept in memory and lost on restart. `/api/health` shows which storage is in use.

`app/staticwebapp.config.json` sets the SPA fallback, Node 20 for the API, security headers (CSP, no framing), and restricts `GET /api/devices` to signed-in users. Add a custom domain under **Custom domains**.

## Agent API (included)

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Status, version, check-in count. Shown in Administration. |
| `POST /api/agent/checkin` | Agent sends name, platform, OS, hardware, software list, missing/installed updates and compliance results. Returns `deviceId` and when to check in next. |
| `GET /api/agent/policy?deviceId=` | Deployments, approved updates, baselines and maintenance windows for the device. |
| `POST /api/agent/status` | Deployment result per device: `success`, `inprogress`, `error` (+ error code) or `reqnotmet`. |
| `GET /api/devices` | Devices that have checked in (signed-in users only). |

Example check-in:
```bash
curl -X POST https://<app>.azurestaticapps.net/api/agent/checkin \
  -H "x-ggt-enroll-token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"GGT-LAG-LT042","platform":"Windows","os":"Windows 11 24H2","hardware":{"model":"Latitude 5450","ramGB":16},"software":[{"name":"7-Zip","version":"24.08"}],"updates":{"missing":["KB5046617"]}}'
```

## Production backend

The console and the API contract are ready; these pieces replace the simulation for a real estate:

1. **Device agent.** A small service on every device that checks in every 5 minutes, sends inventory, pulls policy, installs software, applies updates, evaluates baselines and reports results. Options:
   - Build it: a .NET Worker Service for Windows (WMI/CIM for inventory, Windows Update Agent API or `UsoClient` for patches, `msiexec`/winget for installs), a launchd daemon for macOS, a systemd service for Linux (`apt`, `unattended-upgrades`).
   - Or lean on Microsoft's agents and use this console as the Go-Green front end: **Microsoft Intune** (Graph API for devices, apps, compliance), **Azure Update Manager** + **Azure Arc** for servers, **Microsoft Defender for Endpoint** for security signals. This is usually faster and cheaper than writing an agent.
2. **Database.** Agent data is saved in **PostgreSQL/Supabase**, **Azure SQL** or **Azure Cosmos DB** (`api/src/lib/storage.js`). Next step: add console endpoints for collections and deployments and point the frontend at the API instead of `store.js`'s simulator; the data shapes already match.
3. **Content storage.** Installers in **Azure Blob Storage**, served to devices through short-lived SAS URLs, with **Azure Front Door** or a cache server per site as the "distribution point" for slow links.
4. **Background jobs.** Collection membership, ADR schedules, deadline enforcement and alerting run as timer-triggered functions. Static Web Apps' managed API supports HTTP triggers only, so use a separate **Azure Functions app** (linked via "Bring your own functions", Standard plan) or Azure Container Apps jobs.
5. **Real-time updates.** **Azure Web PubSub** or SignalR Service to push check-ins and alerts to the console, and to send "act now" notifications to agents.
6. **Sign-in and roles.** Static Web Apps authentication with **Microsoft Entra ID** (Standard plan for a custom tenant), with roles such as `admin`, `deployer`, `helpdesk`, `viewer` enforced in `staticwebapp.config.json` and in the API.
7. **Agent identity.** Replace the shared enrollment token with a per-device certificate or Entra workload identity after first enrollment, and sign installers and scripts.
8. **Update catalogue.** Microsoft Update Catalog / Windows Update for Business deployment service via Graph, Ubuntu USN feed, vendor feeds for third-party apps.
9. **Monitoring and audit.** Application Insights for the API, Log Analytics for agent logs, and an audit table for every admin action.

The update KB numbers, error codes and catalogue entries in the demo are illustrative sample data.

## Project layout

```
app/                     Static frontend (deployed as-is)
  index.html, styles.css, logo-full.svg, logo-mark.svg
  staticwebapp.config.json
  js/seed.js             Demo estate generator (stands in for agent data)
  js/store.js            State, rules, compliance, deployments, live simulation
  js/ui.js               Tables, modals, drawers, charts
  js/views/*.js          One file per page
api/                     Azure Functions API (agent check-in, policy, status; Azure SQL / Cosmos DB storage)
dev-server.js            Local server for app + API
scripts/smoke-test.js    CI tests
.github/workflows/       Test + deploy to Azure Static Web Apps
```
