// Local runner: serves the static web app and the API on one port, without
// needing Azure Functions Core Tools. Production runs on Azure Static Web Apps.
//   npm start            -> http://localhost:4280
// Locally you're signed in as "local-admin" and agents use the token "dev-token",
// unless ADMIN_USERS / AGENT_ENROLL_TOKEN are set. Set GGT_DEV_USER= (empty) to test signed-out screens.
process.env.ADMIN_USERS ??= 'local-admin';
process.env.AGENT_ENROLL_TOKEN ??= 'dev-token';
const DEV_USER = process.env.GGT_DEV_USER ?? 'local-admin';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { handle } = require('./api/src/lib/router');

const PORT = Number(process.env.PORT) || 4280;
const APP_DIR = path.join(__dirname, 'app');
// Send the same security headers as Azure (staticwebapp.config.json), so CSP problems show up locally too.
const SECURITY = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'staticwebapp.config.json'), 'utf8')).globalHeaders || {};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.ps1': 'text/plain; charset=utf-8', '.py': 'text/plain; charset=utf-8' };
const principal = DEV_USER ? Buffer.from(JSON.stringify({ identityProvider: 'dev', userId: 'dev', userDetails: DEV_USER, userRoles: ['anonymous', 'authenticated'] })).toString('base64') : null;

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    const headers = { ...req.headers };
    delete headers['x-ms-client-principal']; // like Azure: clients can't set this themselves
    if (principal) headers['x-ms-client-principal'] = principal;
    const out = await handle({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers });
    res.writeHead(out.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(out.body));
  }
  if (url.pathname.startsWith('/.auth/')) { res.writeHead(302, { Location: '/login.html' }); return res.end(); }
  let file = path.normalize(path.join(APP_DIR, decodeURIComponent(url.pathname)));
  if (!file.startsWith(APP_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(APP_DIR, 'index.html');
  res.writeHead(200, { ...SECURITY, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`Go-Green Device Manager running at http://localhost:${PORT} (signed in as ${DEV_USER || 'nobody'})`);
});
