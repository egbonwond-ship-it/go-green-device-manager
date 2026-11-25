// Windows Update Manager: a local update server (WSUS) on one of your Windows Servers. It
// synchronizes with Microsoft Update (its upstream), downloads the updates you approve, and PCs in a
// chosen collection get their updates from it instead of each downloading from the internet.
import * as S from '../store.js';
import { esc, fmtN, table, toast, badge, statusDot, fmtDate, ago, confirmBox } from '../ui.js';

// Names as Microsoft Update lists them (must match api/src/lib/router.js).
const PRODUCTS = [
  ['Windows 11', 'Windows 11'], ['Windows 10, version 1903 and later', 'Windows 10'],
  ['Microsoft Server operating system-21H2', 'Windows Server 2022'], ['Microsoft Server Operating System-24H2', 'Windows Server 2025'],
  ['Microsoft Defender Antivirus', 'Microsoft Defender Antivirus'], ['Microsoft 365 Apps/Office 2019/Office LTSC', 'Microsoft 365 Apps and Office'], ['Microsoft Edge', 'Microsoft Edge'],
];
const CLASSES = ['Critical Updates', 'Security Updates', 'Definition Updates', 'Updates', 'Update Rollups', 'Feature Packs', 'Service Packs', 'Upgrades', 'Drivers', 'Tools'];
const DEFAULTS = { port: 8530, contentDir: 'C:\\WSUS', products: ['Windows 11', 'Windows 10, version 1903 and later', 'Microsoft Defender Antivirus'], classifications: ['Critical Updates', 'Security Updates', 'Definition Updates', 'Update Rollups', 'Updates'], languages: ['en'], syncTime: '02:00', clientCollectionId: '' };

const servers = () => S.state.devices.filter(d => d.platform === 'Windows' && /server/i.test(d.os));
const srv = () => { const us = S.updateServer(); return us ? S.device(us.deviceId) : null; };
const serverUrl = us => us.url || (srv() ? `http://${srv().fqdn || srv().name}:${us.port || 8530}` : '');
const pendingCmd = () => S.state.commands.find(c => c.type?.startsWith('wsus') && (c.status === 'queued' || c.status === 'sent'));
const lastCmd = () => S.state.commands.find(c => c.type?.startsWith('wsus') && !['queued', 'sent'].includes(c.status));

function stateOf() {
  const us = S.updateServer(), d = srv(), w = d?.wsus;
  if (!us) return ['Not set up', 'neutral'];
  if (pendingCmd()) return [`${pendingCmd().name}…`, 'warn'];
  if (!w?.installed) return ['Not installed yet', 'warn'];
  if (w.error) return ['Problem', 'bad'];
  if (w.syncing) return ['Synchronizing', 'warn'];
  if (w.lastSyncResult && !/Succeeded/i.test(w.lastSyncResult)) return [`Last sync: ${w.lastSyncResult}`, 'bad'];
  return ['Ready', 'good'];
}

export default function wsus(el, { params }) {
  let tab = params.tab || (S.updateServer() ? 'updates' : 'settings');
  let sel = new Set();
  const TABS = [['updates', 'Updates'], ['pcs', 'PCs'], ['settings', 'Settings']];
  el.innerHTML = `<div class="page-head"><div><h1>Windows Update Manager</h1><p class="muted">A local update server (WSUS) on one of your Windows Servers. It connects to Microsoft Update, downloads the updates you approve once, and the PCs you choose install them from it over the local network.</p></div>
    <div class="actions"><button class="btn" id="sync">Sync now</button><button class="btn primary" id="setup">Set up server</button></div></div>
    <div class="stats" id="st"></div><div class="tabs">${TABS.map(([k, l]) => `<button data-tab="${k}" aria-selected="${k === tab}">${l}</button>`).join('')}</div><div id="body"></div>`;
  let cur = null;
  const stats = () => {
    const us = S.updateServer(), d = srv(), w = d?.wsus;
    const [label, tone] = stateOf();
    const url = us ? serverUrl(us) : '';
    const using = url ? S.state.devices.filter(x => x.wuServer && x.wuServer.toLowerCase() === url.toLowerCase()).length : 0;
    const needed = (w?.updates || []).filter(u => !u.approved && !u.declined).length;
    const r = lastCmd();
    el.querySelector('#st').innerHTML = `
      <div class="stat"><div class="stat-label">Update server</div><div class="stat-value" style="font-size:18px">${badge(label, tone)}</div><div class="stat-sub">${d ? `${esc(d.name)}${url ? ` · <span class="mono">${esc(url)}</span>` : ''}` : 'Pick a Windows Server in Settings'}</div></div>
      <div class="stat"><div class="stat-label">Last sync with Microsoft</div><div class="stat-value" style="font-size:18px">${w?.lastSync ? ago(new Date(w.lastSync).getTime()) : '—'}</div><div class="stat-sub">${w?.lastSyncResult ? esc(w.lastSyncResult) : 'Not synced yet'}${w?.nextSync ? ` · next ${fmtDate(new Date(w.nextSync).getTime())}` : ''}</div></div>
      <div class="stat"><div class="stat-label">PCs using it</div><div class="stat-value">${fmtN(using)}</div><div class="stat-sub">${w?.computers != null ? `${fmtN(w.computers)} reporting to WSUS` : '&nbsp;'}</div></div>
      <div class="stat ${needed ? 'alert' : ''}"><div class="stat-label">Needed, not approved</div><div class="stat-value">${fmtN(needed)}</div><div class="stat-sub">${w?.freeGB != null ? `${fmtN(w.freeGB)} GB free for updates` : '&nbsp;'}</div></div>
      ${r?.status === 'failed' ? `<div class="notice wide" style="grid-column:1/-1;color:var(--bad)">${esc(r.name)} failed: ${esc(r.output)}</div>` : w?.error ? `<div class="notice wide" style="grid-column:1/-1">${esc(w.error)}</div>` : ''}`;
    el.querySelector('#sync').disabled = !w?.installed || !!pendingCmd();
    el.querySelector('#setup').disabled = !us || !!pendingCmd();
    el.querySelector('#setup').textContent = w?.installed ? 'Apply settings' : 'Set up server';
  };
  const draw = () => {
    const b = el.querySelector('#body');
    const us = S.updateServer(), w = srv()?.wsus;
    if (tab === 'updates') {
      cur = table(b, {
        rows: () => srv()?.wsus?.updates || [], search: u => `${u.kb} ${u.title} ${u.classification}`,
        empty: !us ? 'Set up the update server on the Settings tab first.' : !w?.installed ? 'The server isn’t installed yet.' : w.updatesAt ? 'No PC reporting to the server needs an update.' : 'The server lists updates PCs need after its first sync, about hourly.',
        tools: '<span class="spacer"></span><span class="small muted" id="selc"></span><button class="btn sm" id="dec" disabled>Decline</button><button class="btn sm primary" id="app" disabled>Approve and download</button>',
        cols: [
          { key: 'x', label: '', render: u => (u.approved || u.declined ? '' : `<input type="checkbox" data-u="${esc(u.id)}" ${sel.has(u.id) ? 'checked' : ''} aria-label="Select ${esc(u.kb || u.title)}">`), sort: u => sel.has(u.id) },
          { key: 'kb', label: 'Update', render: u => `<b>${esc(u.kb || '')}</b> ${esc(u.title)}<div class="small muted">${esc(u.classification || '')}${u.released ? ` · ${fmtDate(new Date(u.released).getTime())}` : ''}</div>` },
          { key: 'severity', label: 'Severity', render: u => (u.severity ? badge(u.severity) : '<span class="muted">—</span>') },
          { key: 'needed', label: 'Needed by', num: true, render: u => fmtN(u.needed) },
          { key: 'installed', label: 'Installed on', num: true, render: u => fmtN(u.installed) },
          { key: 'approved', label: 'Status', render: u => (u.declined ? badge('Declined', 'neutral') : u.approved ? badge('Approved', 'good') : badge('Not approved', 'warn')), sort: u => (u.declined ? 2 : u.approved ? 1 : 0) },
        ],
      });
      const selc = () => { b.querySelector('#selc').textContent = sel.size ? `${sel.size} selected` : ''; b.querySelector('#app').disabled = b.querySelector('#dec').disabled = !sel.size || !!pendingCmd(); };
      b.onchange = e => { const id = e.target.dataset.u; if (id) { if (e.target.checked) sel.add(id); else sel.delete(id); selc(); } };
      b.onclick = e => {
        if (e.target.id === 'app') act('wsusapprove');
        if (e.target.id === 'dec') confirmBox('Decline updates?', `Decline ${sel.size} update${sel.size === 1 ? '' : 's'}? PCs won’t get them from this server.`, 'Decline', () => act('wsusdecline'), true);
      };
      const act = type => S.wsusAction(type, [...sel]).then(() => { toast(type === 'wsusapprove' ? 'Approved. The server downloads them from Microsoft at its next check-in, then PCs install them.' : 'Declining at the server’s next check-in.'); sel = new Set(); cur.draw(); selc(); }).catch(() => {});
      selc();
    } else if (tab === 'pcs') {
      const col = us?.clientCollectionId ? S.byId('collections', us.clientCollectionId) : null;
      const url = us ? serverUrl(us) : '';
      b.innerHTML = `<div class="notice info small" style="margin-bottom:12px">${col ? `Windows PCs in <a href="#/collections/${esc(col.id)}">${esc(col.name)}</a> get Windows Update pointed at <span class="mono">${esc(url)}</span> at their next check-in. PCs leaving the collection go back to Microsoft Update. A domain Group Policy for Windows Update wins over this.` : 'No collection is set, so PCs keep getting updates from Microsoft directly. Choose a collection on the Settings tab.'}</div><div id="tbl"></div>`;
      b.onchange = b.onclick = null;
      cur = table(b.querySelector('#tbl'), {
        rows: () => S.state.devices.filter(d => d.platform === 'Windows' && (d.wuServer || (col && S.inCollection(d, col)))), search: d => `${d.name} ${d.wuServer || ''}`,
        empty: 'No PCs use the update server yet.',
        cols: [
          { key: 'name', label: 'PC', render: d => `<span class="person">${statusDot(d)}<b>${esc(d.name)}</b></span><div class="small muted">${esc(d.os)}</div>` },
          { key: 'wuServer', label: 'Gets updates from', render: d => (d.wuServer ? `<span class="mono small">${esc(d.wuServer)}</span>` : 'Microsoft Update') },
          { key: 's', label: '', render: d => { const inCol = col && S.inCollection(d, col) && d.id !== us.deviceId; const ok = d.wuServer && url && d.wuServer.toLowerCase() === url.toLowerCase(); return inCol ? (ok ? badge('Using this server', 'good') : badge('Switching at next check-in', 'warn')) : d.wuServer && !ok ? badge('Another update server', 'neutral') : ''; } },
          { key: 'updatesScannedAt', label: 'Last update scan', render: d => (d.updatesScannedAt ? ago(d.updatesScannedAt) : '—') },
        ],
      });
    } else settings(b);
  };
  function settings(b) {
    b.onchange = b.onclick = null;
    const x = { ...DEFAULTS, ...(S.updateServer() || {}) };
    const list = servers();
    const chk = (name, items, val) => items.map(([v, l]) => `<label style="font-weight:400"><input type="checkbox" name="${name}" value="${esc(v)}" ${val.includes(v) ? 'checked' : ''}> ${esc(l)}</label>`).join('');
    b.innerHTML = `<div class="card stack"><div class="form-grid">
      <label class="field wide">Server that runs the update service <span class="req">*</span><select id="dev">${list.length ? list.map(d => `<option value="${esc(d.id)}" ${d.id === x.deviceId ? 'selected' : ''}>${esc(d.name)} (${esc(d.os)})</option>`).join('') : '<option value="">No Windows Server has the agent yet</option>'}</select></label>
      <label class="field">Folder for downloaded updates<input id="dir" class="mono" value="${esc(x.contentDir)}"></label>
      <label class="field">Port<input id="port" type="number" min="1" max="65535" value="${esc(x.port)}"></label>
      <label class="field">Daily sync with Microsoft (Lagos time)<input id="time" type="time" value="${esc(x.syncTime)}"></label>
      <label class="field">Languages<input id="lang" value="${esc(x.languages.join(', '))}" placeholder="en"></label>
      <div class="field wide">Products<div style="display:flex;gap:6px 16px;flex-wrap:wrap">${chk('prod', PRODUCTS, x.products)}</div></div>
      <div class="field wide">Classifications<div style="display:flex;gap:6px 16px;flex-wrap:wrap">${chk('cls', CLASSES.map(c => [c, c]), x.classifications)}</div></div>
      <label class="field wide">PCs that get updates from this server<select id="col"><option value="">None yet (PCs keep using Microsoft Update)</option>${S.state.collections.map(c => `<option value="${esc(c.id)}" ${c.id === x.clientCollectionId ? 'selected' : ''}>${esc(c.name)} (${S.members(c.id).length})</option>`).join('')}</select></label>
      <label class="field wide">Address PCs use (optional)<input id="url" class="mono" value="${esc(x.url || '')}" placeholder="Default: http://<server name>:${esc(x.port)}"></label></div>
      <div class="notice info small">Needs Windows Server 2016 or later with the agent installed, internet access to Microsoft Update, and plenty of disk (allow 50–100 GB for Windows 10/11 updates). Installing WSUS on a domain controller works but isn’t recommended; a small member server is better. The first sync takes 30–90 minutes. Start with a pilot collection.</div>
      <div><button class="btn primary" id="save">Save settings</button></div></div>`;
    b.querySelector('#save').addEventListener('click', () => {
      const v = id => b.querySelector(`#${id}`).value.trim();
      const doc = { deviceId: v('dev'), contentDir: v('dir'), port: Number(v('port')) || 8530, syncTime: v('time') || '02:00', languages: v('lang').split(/[,\s]+/).filter(Boolean),
        products: [...b.querySelectorAll('[name=prod]:checked')].map(i => i.value), classifications: [...b.querySelectorAll('[name=cls]:checked')].map(i => i.value),
        clientCollectionId: v('col'), url: v('url') };
      if (!doc.deviceId) { toast('Install the agent on a Windows Server first, then pick it here.', true); return; }
      if (!doc.products.length || !doc.classifications.length) { toast('Pick at least one product and one classification.', true); return; }
      const installed = srv()?.id === doc.deviceId && srv()?.wsus?.installed;
      S.saveUpdateServer(doc).then(() => toast(installed ? 'Saved. Select “Apply settings” to send them to the server.' : 'Saved. Select “Set up server” to install WSUS on it.')).catch(() => {});
    });
  }
  el.querySelector('.tabs').addEventListener('click', e => { const t = e.target.closest('[data-tab]'); if (!t) return; tab = t.dataset.tab; el.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', x.dataset.tab === tab)); draw(); });
  el.querySelector('#sync').addEventListener('click', () => S.wsusAction('wsussync').then(() => toast('The server starts synchronizing at its next check-in.')).catch(() => {}));
  el.querySelector('#setup').addEventListener('click', () => {
    const d = srv();
    const installed = d?.wsus?.installed;
    confirmBox(installed ? 'Apply settings to the update server?' : 'Set up the update server?', installed ? `Send the products, classifications and sync time to <b>${esc(d?.name)}</b> and start a sync.` : `Install the WSUS role on <b>${esc(d?.name)}</b>, connect it to Microsoft Update and start the first sync? This takes a while and uses disk space on the server.`, installed ? 'Apply' : 'Set up',
      () => S.wsusAction('wsussetup').then(r => { const c = r.commands[0]; toast(c.status === 'skipped' ? c.output : 'The server starts at its next check-in (within 5 minutes).', c.status === 'skipped'); }).catch(() => {}));
  });
  stats(); draw();
  return { refresh: () => { stats(); if (tab !== 'settings') cur?.draw(); } };
}
