import * as S from './store.js';
import { $, esc, toast } from './ui.js';
import overview from './views/overview.js';
import devices from './views/devices.js';
import collections from './views/collections.js';
import library from './views/library.js';
import deployments from './views/deployments.js';
import updates from './views/updates.js';
import compliance from './views/compliance.js';
import monitoring from './views/monitoring.js';
import scripts from './views/scripts.js';
import reports from './views/reports.js';
import settings from './views/settings.js';
import remote from './views/remote.js';

const NAV = [
  ['Estate', [['overview', 'Overview', '◎', overview], ['devices', 'Devices', '▣', devices], ['collections', 'Collections', '⧉', collections]]],
  ['Deliver', [['library', 'Software library', '⬚', library], ['deployments', 'Deployments', '➜', deployments], ['updates', 'Software updates', '⟳', updates], ['remote', 'Remote desktop', '▭', remote]]],
  ['Protect', [['compliance', 'Compliance', '✓', compliance], ['monitoring', 'Monitoring & alerts', '♥', monitoring], ['scripts', 'Run scripts', '›_', scripts]]],
  ['Insight', [['reports', 'Reports', '▤', reports], ['settings', 'Administration', '⚙', settings]]],
];
const PAGES = Object.fromEntries(NAV.flatMap(([, items]) => items.map(([id, label, , mod]) => [id, { label, mod }])));

function applyTheme(force) {
  let t = force;
  if (!t) { try { t = localStorage.getItem('gg-dm-theme'); } catch { t = null; } }
  if (t) document.documentElement.dataset.theme = t;
}

applyTheme();
const root = $('#root');

// Screens shown before the console when the visitor isn't an admin.
function gate(title, html) {
  root.innerHTML = `<div class="gate"><div class="card stack"><img src="/logo-full.svg" alt="GO-Green Technologies" style="height:44px;align-self:flex-start"><h1>${title}</h1>${html}</div></div>`;
}
async function boot() {
  let me;
  try { me = await S.api('GET', '/api/console/me'); } catch (e) {
    if (e.status === 401) { location.href = '/login.html'; return; }
    gate('Can’t reach the server', `<p>${esc(e.message)}</p><p><a class="btn primary" href="/">Try again</a></p>`); return;
  }
  if (!me.admin) {
    gate('No access yet', `<p>You’re signed in as <b>${esc(me.user)}</b> (${esc(me.provider)}), but this account isn’t a Device Manager admin.</p>
      <p class="small muted">An Azure admin adds it to the <span class="mono">ADMIN_USERS</span> setting: Azure portal → Static Web App <b>go-green-device-manager</b> → Environment variables. Separate several accounts with commas.${me.adminConfigured ? '' : ' No admins are set up yet.'}</p>
      <p><a class="btn" href="/.auth/logout?post_logout_redirect_uri=/login.html">Sign out</a></p>`);
    return;
  }
  try { await S.load(); } catch (e) {
    gate('Can’t load the console', `<p>${esc(e.message)}</p><p><a class="btn primary" href="/">Try again</a></p>`); return;
  }
  start(me);
}

function start(me) {
root.innerHTML = `<div class="shell">
  <nav class="side" id="side" aria-label="Main">
    <a class="brand" href="#/overview"><span class="logo-card"><img src="/logo-full.svg" alt="GO-Green Technologies"></span><span class="brand-sub">Device Manager</span></a>
    ${NAV.map(([g, items]) => `<div class="nav-group"><span>${g}</span><div class="nav">${items.map(([id, label, ico]) => `<a href="#/${id}" data-nav="${id}"><span class="ico">${ico}</span>${label}<span class="nav-count" data-count="${id}"></span></a>`).join('')}</div></div>`).join('')}
    <div style="margin-top:auto;padding:16px 10px 0;font-size:12px;color:var(--side-muted)">Go-Green Technologies<br>IT systems management</div>
  </nav>
  <div class="main">
    <header class="topbar">
      <button class="icon-btn menu-btn" id="menu" aria-label="Menu">☰</button>
      <input type="search" class="search-global" id="gsearch" placeholder="Find a device, user or IP…" aria-label="Find a device">
      <span class="spacer"></span>
      <span class="live hide-sm" id="live"></span>
      <button class="icon-btn" id="theme" title="Toggle dark mode" aria-label="Toggle dark mode"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button>
      <div class="who"><div class="meta"><b>${esc(me.user)}</b><span><a href="/.auth/logout?post_logout_redirect_uri=/login.html">Sign out</a></span></div><span class="avatar">${esc(me.user.slice(0, 2).toUpperCase())}</span></div>
    </header>
    <main class="content" id="page"></main>
  </div>
</div>`;

const style = document.createElement('style');
style.textContent = `.nav-count{margin-left:auto;font-size:11px;background:#d9483b;color:#fff;border-radius:99px;padding:0 7px;font-weight:700}.nav-count:empty{display:none}`;
document.head.append(style);

let current = null;
function route() {
  const [path, qs] = (location.hash.replace(/^#\/?/, '') || 'overview').split('?');
  const [id, ...rest] = path.split('/');
  const page = PAGES[id] || PAGES.overview;
  const params = Object.fromEntries(new URLSearchParams(qs || ''));
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === (PAGES[id] ? id : 'overview')));
  document.title = `${page.label} · GO-Green Device Manager`;
  const el = $('#page');
  el.innerHTML = '';
  current = page.mod(el, { params, rest }) || null;
  $('#side').classList.remove('open');
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

function chrome() {
  const open = S.state.alerts.filter(a => !a.ack).length;
  $('[data-count="monitoring"]').textContent = open || '';
  const on = S.state.devices.filter(d => d.online).length;
  $('#live').innerHTML = `<span class="dot ${on ? 'on' : 'off'}"></span>${on} of ${S.state.devices.length} devices online`;
}
S.subscribe(() => { chrome(); try { current?.refresh?.(); } catch (e) { console.error(e); } });

$('#menu').addEventListener('click', () => $('#side').classList.toggle('open'));
$('#theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  try { localStorage.setItem('gg-dm-theme', dark ? 'light' : 'dark'); } catch { /* ignore */ }
  applyTheme(dark ? 'light' : 'dark');
});
$('#gsearch').addEventListener('keydown', e => { if (e.key === 'Enter') location.hash = `#/devices?q=${encodeURIComponent(e.target.value)}`; });

S.onError(e => {
  if (e.status === 401) { location.href = '/login.html'; return; }
  toast(e.message, true);
});
route();
chrome();
S.startPolling();
}

boot();
