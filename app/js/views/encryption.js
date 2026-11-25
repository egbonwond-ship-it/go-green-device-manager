// Disk encryption: BitLocker (Windows), FileVault (macOS) and LUKS (Linux) on every device's system
// drive. Turn encryption on or off through the agent; recovery keys the agent saves when it turns
// BitLocker or FileVault on can be read here one device at a time (each view is logged).
import * as S from '../store.js';
import { esc, fmtN, badge, table, toast, confirmBox, modal, statusDot, fmtDate } from '../ui.js';

const busy = d => S.state.commands.find(c => c.deviceId === d.id && c.type?.startsWith('enc') && (c.status === 'queued' || c.status === 'sent'));
const lastResult = d => S.state.commands.find(c => c.deviceId === d.id && c.type?.startsWith('enc') && !['queued', 'sent'].includes(c.status));
const keysOf = d => (S.state.recoveryKeys || []).filter(k => k.deviceId === d.id);
const STATUS = {
  on: ['On', 'good'], off: ['Off', 'bad'], suspended: ['Suspended', 'warn'], encrypting: ['Encrypting', 'warn'],
  decrypting: ['Decrypting', 'warn'], paused: ['Paused', 'warn'], pending: ['Turns on at next logout', 'warn'],
};

function statusOf(d) {
  const p = busy(d);
  if (p) return { label: p.type === 'encon' ? 'Turning on…' : 'Turning off…', tone: 'warn', key: 'busy' };
  const e = d.encryption;
  if (e?.status && STATUS[e.status]) {
    const [l, t] = STATUS[e.status];
    return { label: e.percent != null && ['encrypting', 'decrypting', 'paused'].includes(e.status) ? `${l} ${e.percent}%` : l, tone: t, key: e.status };
  }
  if (d.encrypted === true) return { label: 'On', tone: 'good', key: 'on' };
  if (d.encrypted === false) return { label: 'Off', tone: 'bad', key: 'off' };
  return { label: 'Not reported', tone: 'neutral', key: 'unknown' };
}
const canOn = d => d.platform !== 'Linux' && d.encryption?.available !== false;
const canOff = d => d.platform === 'Windows' && d.encryption?.available !== false;
const KIND = { Windows: 'BitLocker', macOS: 'FileVault', Linux: 'LUKS' };

export default function encryption(el) {
  let sel = new Set();
  let filter = '';
  el.innerHTML = `<div class="page-head"><div><h1>Disk encryption</h1><p class="muted">BitLocker on Windows, FileVault on Macs and LUKS on Linux: see which devices are encrypted, and turn encryption on or off through the agent. Recovery keys are saved here when the agent turns encryption on.</p></div>
    <div class="actions"><button class="btn" id="off" disabled>Turn off</button><button class="btn primary" id="on" disabled>Turn on</button></div></div>
    <div class="stats" id="st"></div><div id="tbl"></div>
    <div class="notice info small" style="margin-top:12px"><b>Windows:</b> needs Windows Pro, Enterprise or Education and a TPM. The agent adds a recovery password, saves it here first, then encrypts the used space with XTS-AES 256 while the PC stays usable. Turning off decrypts in the background.
      <b>Mac:</b> macOS asks the signed-in user for their password the next time they log out, then encrypts; the recovery key is saved here afterwards. Turning FileVault off needs the user’s password, so they do it in System Settings.
      <b>Linux:</b> LUKS is set up when Linux is installed, so it’s reported only.</div>`;
  const stats = () => {
    const ds = S.state.devices;
    const n = k => ds.filter(d => statusOf(d).key === k).length;
    el.querySelector('#st').innerHTML = `
      <div class="stat"><div class="stat-label">Encrypted</div><div class="stat-value">${fmtN(n('on'))}</div><div class="stat-sub">of ${fmtN(ds.length)} devices</div></div>
      <div class="stat ${n('off') ? 'alert' : ''}"><div class="stat-label">Not encrypted</div><div class="stat-value">${fmtN(n('off') + n('suspended'))}</div><div class="stat-sub">${n('suspended') ? `${n('suspended')} suspended` : 'Off or suspended'}</div></div>
      <div class="stat"><div class="stat-label">In progress</div><div class="stat-value">${fmtN(n('encrypting') + n('decrypting') + n('paused') + n('pending') + n('busy'))}</div></div>
      <div class="stat"><div class="stat-label">Recovery keys saved</div><div class="stat-value">${fmtN(new Set((S.state.recoveryKeys || []).map(k => k.deviceId)).size)}</div><div class="stat-sub">devices</div></div>`;
  };
  const t = table(el.querySelector('#tbl'), {
    rows: () => S.state.devices.filter(d => !filter || statusOf(d).key === filter || (filter === 'off' && statusOf(d).key === 'suspended')),
    search: d => `${d.name} ${d.user || ''} ${d.os}`, empty: 'No devices enrolled yet.',
    tools: `<select id="ef" aria-label="Filter by encryption"><option value="">All devices</option><option value="on">Encrypted</option><option value="off">Not encrypted</option><option value="encrypting">Encrypting</option><option value="unknown">Not reported</option></select><span class="spacer"></span><span class="small muted" id="selc"></span>`,
    cols: [
      { key: 'x', label: '', render: d => `<input type="checkbox" data-d="${esc(d.id)}" ${sel.has(d.id) ? 'checked' : ''} aria-label="Select ${esc(d.name)}">`, sort: d => sel.has(d.id) },
      { key: 'name', label: 'Device', render: d => `<span class="person">${statusDot(d)}<b>${esc(d.name)}</b></span><div class="small muted">${esc(d.os)}</div>` },
      { key: 'kind', label: 'Encryption', render: d => esc(d.encryption?.kind || KIND[d.platform] || '—'), sort: d => d.platform },
      { key: 'status', label: 'Status', render: d => { const s = statusOf(d); const r = lastResult(d); return `${badge(s.label, s.tone)}${d.encryption?.note && !d.encryption.available ? `<div class="small muted">${esc(d.encryption.note)}</div>` : ''}${r?.status === 'failed' && !busy(d) ? `<div class="small" style="color:var(--bad)">${esc(r.output)}</div>` : ''}`; }, sort: d => statusOf(d).key },
      { key: 'method', label: 'Method and protectors', render: d => d.encryption?.method || d.encryption?.protectors?.length ? `${esc(d.encryption.method || '')}<div class="small muted">${esc((d.encryption.protectors || []).join(', '))}</div>` : '<span class="muted">—</span>' },
      { key: 'key', label: 'Recovery key', render: d => keysOf(d).length ? `<button class="btn sm" data-key="${esc(d.id)}">Show key</button>` : '<span class="small muted">Not saved</span>', sort: d => keysOf(d).length },
      { key: 'act', label: '', render: d => { const s = statusOf(d).key; return s === 'busy' ? '' : s === 'off' || s === 'suspended' || s === 'unknown' ? (canOn(d) ? `<button class="btn sm primary" data-on="${esc(d.id)}">Turn on</button>` : '') : s === 'on' && canOff(d) ? `<button class="btn sm" data-off="${esc(d.id)}">Turn off</button>` : ''; } },
    ],
  });
  const selCount = () => {
    el.querySelector('#selc').textContent = sel.size ? `${sel.size} selected` : '';
    el.querySelector('#on').disabled = el.querySelector('#off').disabled = !sel.size;
  };
  const tbl = el.querySelector('#tbl');
  tbl.addEventListener('change', e => {
    if (e.target.id === 'ef') { filter = e.target.value; t.draw(); return; }
    const id = e.target.dataset.d;
    if (id) { if (e.target.checked) sel.add(id); else sel.delete(id); selCount(); }
  });
  tbl.addEventListener('click', e => {
    const b = e.target.closest('[data-on],[data-off],[data-key]');
    if (!b) return;
    if (b.dataset.key) showKeys(S.device(b.dataset.key));
    else if (b.dataset.on) turnOn([b.dataset.on]);
    else turnOff([b.dataset.off]);
  });
  el.querySelector('#on').addEventListener('click', () => turnOn([...sel]));
  el.querySelector('#off').addEventListener('click', () => turnOff([...sel]));
  const done = r => { const n = r.commands.filter(c => c.status === 'queued').length; const skipped = r.commands.filter(c => c.status === 'skipped'); toast(`${n} device${n === 1 ? '' : 's'} pick this up at the next check-in (within 5 minutes)${skipped.length ? `. ${skipped.length} skipped: ${skipped[0].output}` : ''}`, !n); sel = new Set(); selCount(); };
  function turnOn(ids) {
    const ds = ids.map(S.device).filter(Boolean);
    confirmBox('Turn on disk encryption?', `Turn on encryption on <b>${ds.length === 1 ? esc(ds[0].name) : `${ds.length} devices`}</b>? Windows PCs encrypt in the background and their recovery key is saved here first. On a Mac, the user is asked for their password when they next log out.`, 'Turn on',
      () => S.devicesAction(ids, 'encon').then(done).catch(() => {}));
  }
  function turnOff(ids) {
    const ds = ids.map(S.device).filter(Boolean);
    confirmBox('Turn off disk encryption?', `Decrypt <b>${ds.length === 1 ? esc(ds[0].name) : `${ds.length} devices`}</b>? Anyone with the disk can then read its data. Do this only to fix a problem, and turn it back on afterwards. (Macs are skipped: the user turns FileVault off in System Settings.)`, 'Turn off',
      () => S.devicesAction(ids, 'encoff').then(done).catch(() => {}), true);
  }
  selCount(); stats();
  return { refresh: () => { stats(); t.draw(); } };
}

function showKeys(d) {
  const m = modal(`Recovery key: ${d.name}`, '<p class="muted small">Loading…</p>', [{ label: 'Close' }]);
  S.recoveryKeys(d.id).then(r => {
    m.el.querySelector('.modal-body').innerHTML = `<p class="small muted">Give this to the user only to unlock this device when it asks for its recovery key. Viewing it is recorded in the activity log.</p>
      ${r.keys.map(k => `<div class="card" style="margin-top:10px;padding:12px"><div class="small muted">${esc(k.kind)}${k.volume ? ` · ${esc(k.volume)}` : ''} · saved ${fmtDate(k.at)}</div>
        ${k.kind === 'BitLocker' ? `<div class="small muted">Key ID <span class="mono">${esc(k.keyId.replace(/[{}]/g, '').slice(0, 8))}</span> (the first 8 characters the PC shows)</div>` : ''}
        <div class="mono" style="font-size:16px;margin-top:6px;word-break:break-all;user-select:all">${esc(k.password)}</div></div>`).join('') || '<p class="muted">No recovery key saved.</p>'}`;
  }).catch(() => m.close());
}
