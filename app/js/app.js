import * as S from './store.js';
import { $ } from './ui.js';
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

const NAV = [
  ['Estate', [['overview', 'Overview', '◎', overview], ['devices', 'Devices', '▣', devices], ['collections', 'Collections', '⧉', collections]]],
  ['Deliver', [['library', 'Software library', '⬚', library], ['deployments', 'Deployments', '➜', deployments], ['updates', 'Software updates', '⟳', updates]]],
  ['Protect', [['compliance', 'Compliance', '✓', compliance], ['monitoring', 'Monitoring & alerts', '♥', monitoring], ['scripts', 'Run scripts', '›_', scripts]]],
  ['Insight', [['reports', 'Reports', '▤', reports], ['settings', 'Administration', '⚙', settings]]],
];
const PAGES = Object.fromEntries(NAV.flatMap(([, items]) => items.map(([id, label, , mod]) => [id, { label, mod }])));

S.load();
applyTheme();

const root = $('#root');
root.innerHTML = `<div class="shell">
  <nav class="side" id="side" aria-label="Main">
    <a class="brand" href="#/overview"><span class="logo-card"><img src="/logo-full.svg" alt="GO-Green Technologies"></span><span class="brand-sub">Device Manager</span></a>
    ${NAV.map(([g, items]) => `<div class="nav-group"><span>${g}</span><div class="nav">${items.map(([id, label, ico]) => `<a href="#/${id}" data-nav="${id}"><span class="ico">${ico}</span>${label}<span class="nav-count" data-count="${id}"></span></a>`).join('')}</div></div>`).join('')}
    <div style="margin-top:auto;padding:16px 10px 0;font-size:12px;color:var(--side-muted)">Demo estate · simulated agents<br>Data stays in this browser.</div>
  </nav>
  <div class="main">
    <header class="topbar">
      <button class="icon-btn menu-btn" id="menu" aria-label="Menu">☰</button>
      <input type="search" class="search-global" id="gsearch" placeholder="Find a device, user or IP…" aria-label="Find a device">
      <span class="spacer"></span>
      <span class="live hide-sm" id="live"></span>
      <button class="icon-btn" id="theme" title="Toggle dark mode" aria-label="Toggle dark mode"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button>
      <div class="who"><div class="meta"><b>IT Admin</b><span>GGT\\it.admin</span></div><span class="avatar">IT</span></div>
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
  $('#live').innerHTML = S.state.settings.simulate ? `<span class="dot on"></span>${on} of ${S.state.devices.length} devices online` : '<span class="dot off"></span>Simulation paused';
}
S.subscribe(() => { chrome(); try { current?.refresh?.(); } catch (e) { console.error(e); } });

$('#menu').addEventListener('click', () => $('#side').classList.toggle('open'));
$('#theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  try { localStorage.setItem('gg-dm-theme', dark ? 'light' : 'dark'); } catch { /* ignore */ }
  applyTheme(dark ? 'light' : 'dark');
});
$('#gsearch').addEventListener('keydown', e => { if (e.key === 'Enter') location.hash = `#/devices?q=${encodeURIComponent(e.target.value)}`; });

function applyTheme(force) {
  let t = force;
  if (!t) { try { t = localStorage.getItem('gg-dm-theme'); } catch { t = null; } }
  if (t) document.documentElement.dataset.theme = t;
}

route();
chrome();
setInterval(S.tick, 3000);
