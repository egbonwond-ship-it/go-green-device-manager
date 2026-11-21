// Where the device manager keeps its data.
// - SUPABASE_URL + SUPABASE_SERVICE_KEY set: Supabase over its REST API (tables from db/supabase-setup.sql).
// - POSTGRES_URL set: any PostgreSQL database (tables are created in a private "ggt" schema on first use).
// - Neither: in memory, lost when the API restarts. Used by local runs and tests.
//
// Three kinds of data:
//   devices   one document per enrolled device (what its agent reported, plus admin tags)
//   statuses  history of deployment results reported by agents
//   objects   console configuration and activity, by kind: collection, app, deployment, updateGroup,
//             adr, baseline, maintenanceWindow, script, scriptRun, command, alert, log, site, settings
const MAX_STATUSES = 5000;

const matches = (doc, where = {}) => Object.entries(where).every(([k, v]) => String(doc?.[k]) === String(v));

function memoryStore() {
  const devices = new Map();
  const statuses = [];
  const objects = new Map(); // `${kind}/${id}` -> { doc, at }
  let clock = 0; // keeps "newest first" stable when two writes land in the same millisecond
  return {
    kind: 'memory',
    async getDevice(id) { return devices.get(id) || null; },
    async upsertDevice(d) { devices.set(d.id, d); return d; },
    async deleteDevice(id) { devices.delete(id); },
    async listDevices() { return [...devices.values()]; },
    async countDevices() { return devices.size; },
    async addStatus(s) { statuses.push(s); if (statuses.length > MAX_STATUSES) statuses.shift(); },
    async listStatuses(deviceId) { return statuses.filter(s => !deviceId || s.deviceId === deviceId).reverse(); },
    async getObject(kind, id) { return objects.get(`${kind}/${id}`)?.doc || null; },
    async putObject(kind, id, doc) { objects.set(`${kind}/${id}`, { kind, doc, at: ++clock }); return doc; },
    async putMany(kind, docs) { for (const d of docs) objects.set(`${kind}/${d.id}`, { kind, doc: d, at: ++clock }); },
    async deleteObject(kind, id) { objects.delete(`${kind}/${id}`); },
    async listObjects(kind, { where, limit = 1000 } = {}) {
      return [...objects.values()].filter(o => o.kind === kind && matches(o.doc, where)).sort((a, b) => b.at - a.at).slice(0, limit).map(o => o.doc);
    },
  };
}

function pgStore(url) {
  const { Pool } = require('pg');
  const ssl = /localhost|127\.0\.0\.1/.test(url) || /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ''), ssl, max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000 });
  let ready = null;
  const init = () => (ready ??= pool.query(`
CREATE SCHEMA IF NOT EXISTS ggt;
CREATE TABLE IF NOT EXISTS ggt.devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, last_seen TIMESTAMPTZ NOT NULL, doc JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS ggt.deployment_status (
  id BIGSERIAL PRIMARY KEY, device_id TEXT NOT NULL, deployment_id TEXT NOT NULL, state TEXT NOT NULL, error_code TEXT, at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS ix_status_device ON ggt.deployment_status (device_id, at DESC);
CREATE TABLE IF NOT EXISTS ggt.objects (
  kind TEXT NOT NULL, id TEXT NOT NULL, doc JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (kind, id));
CREATE INDEX IF NOT EXISTS ix_objects_kind ON ggt.objects (kind, updated_at DESC);`).catch(e => { ready = null; throw e; }));
  const q = async (text, params) => { await init(); return (await pool.query(text, params)).rows; };
  const toStatus = r => ({ deviceId: r.device_id, deploymentId: r.deployment_id, state: r.state, errorCode: r.error_code, at: new Date(r.at).toISOString() });
  return {
    kind: 'postgres',
    async getDevice(id) { const r = await q('SELECT doc FROM ggt.devices WHERE id = $1', [id]); return r[0] ? r[0].doc : null; },
    async upsertDevice(d) {
      await q(`INSERT INTO ggt.devices (id, name, platform, last_seen, doc) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, platform = EXCLUDED.platform, last_seen = EXCLUDED.last_seen, doc = EXCLUDED.doc`,
      [d.id, d.name, d.platform, d.lastSeen, JSON.stringify(d)]);
      return d;
    },
    async deleteDevice(id) { await q('DELETE FROM ggt.devices WHERE id = $1', [id]); },
    async listDevices() { return (await q('SELECT doc FROM ggt.devices ORDER BY last_seen DESC LIMIT 5000')).map(r => r.doc); },
    async countDevices() { return Number((await q('SELECT COUNT(*)::int AS n FROM ggt.devices'))[0].n); },
    async addStatus(s) { await q('INSERT INTO ggt.deployment_status (device_id, deployment_id, state, error_code, at) VALUES ($1, $2, $3, $4, $5)', [s.deviceId, s.deploymentId, s.state, s.errorCode, s.at]); },
    async listStatuses(deviceId) {
      const r = deviceId ? await q('SELECT * FROM ggt.deployment_status WHERE device_id = $1 ORDER BY at DESC LIMIT 500', [deviceId]) : await q('SELECT * FROM ggt.deployment_status ORDER BY at DESC LIMIT 500');
      return r.map(toStatus);
    },
    async getObject(kind, id) { const r = await q('SELECT doc FROM ggt.objects WHERE kind = $1 AND id = $2', [kind, id]); return r[0] ? r[0].doc : null; },
    async putObject(kind, id, doc) {
      await q(`INSERT INTO ggt.objects (kind, id, doc, updated_at) VALUES ($1, $2, $3, clock_timestamp())
        ON CONFLICT (kind, id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = EXCLUDED.updated_at`, [kind, id, JSON.stringify(doc)]);
      return doc;
    },
    async putMany(kind, docs) { for (const d of docs) await this.putObject(kind, d.id, d); },
    async deleteObject(kind, id) { await q('DELETE FROM ggt.objects WHERE kind = $1 AND id = $2', [kind, id]); },
    async listObjects(kind, { where = {}, limit = 1000 } = {}) {
      const params = [kind];
      const conds = Object.entries(where).map(([k, v]) => { params.push(k, String(v)); return `doc->>$${params.length - 1} = $${params.length}`; });
      params.push(limit);
      return (await q(`SELECT doc FROM ggt.objects WHERE kind = $1${conds.map(c => ` AND ${c}`).join('')} ORDER BY updated_at DESC LIMIT $${params.length}`, params)).map(r => r.doc);
    },
  };
}

function supabaseStore(url, key) {
  const base = `${url.replace(/\/+$/, '')}/rest/v1`;
  const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const call = async (path, { method = 'GET', body, prefer } = {}) => {
    const res = await fetch(`${base}/${path}`, { method, headers: prefer ? { ...H, Prefer: prefer } : H, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) { const t = await res.text(); throw new Error(`Supabase ${res.status}: ${t.slice(0, 200)}`); }
    return res;
  };
  const json = async (path, opts) => { const r = await call(path, opts); const t = await r.text(); return t ? JSON.parse(t) : null; };
  const e = encodeURIComponent;
  const toStatus = r => ({ deviceId: r.device_id, deploymentId: r.deployment_id, state: r.state, errorCode: r.error_code, at: new Date(r.at).toISOString() });
  return {
    kind: 'supabase',
    async getDevice(id) { const r = await json(`ggt_devices?id=eq.${e(id)}&select=doc`); return r[0] ? r[0].doc : null; },
    async upsertDevice(d) {
      await call('ggt_devices?on_conflict=id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { id: d.id, name: d.name, platform: d.platform, last_seen: d.lastSeen, doc: d } });
      return d;
    },
    async deleteDevice(id) { await call(`ggt_devices?id=eq.${e(id)}`, { method: 'DELETE', prefer: 'return=minimal' }); },
    async listDevices() { return (await json('ggt_devices?select=doc&order=last_seen.desc&limit=5000')).map(r => r.doc); },
    async countDevices() {
      const r = await call('ggt_devices?select=id&limit=1', { prefer: 'count=exact' });
      const n = Number((r.headers.get('content-range') || '').split('/')[1]);
      return Number.isFinite(n) ? n : 0;
    },
    async addStatus(s) { await call('ggt_deployment_status', { method: 'POST', prefer: 'return=minimal', body: { device_id: s.deviceId, deployment_id: s.deploymentId, state: s.state, error_code: s.errorCode, at: s.at } }); },
    async listStatuses(deviceId) {
      const f = deviceId ? `device_id=eq.${e(deviceId)}&` : '';
      return (await json(`ggt_deployment_status?${f}select=*&order=at.desc&limit=500`)).map(toStatus);
    },
    async getObject(kind, id) { const r = await json(`ggt_objects?kind=eq.${e(kind)}&id=eq.${e(id)}&select=doc`); return r[0] ? r[0].doc : null; },
    async putObject(kind, id, doc) {
      await call('ggt_objects?on_conflict=kind,id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { kind, id, doc, updated_at: new Date().toISOString() } });
      return doc;
    },
    async putMany(kind, docs) {
      const at = new Date().toISOString();
      for (let i = 0; i < docs.length; i += 500) {
        await call('ggt_objects?on_conflict=kind,id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: docs.slice(i, i + 500).map(doc => ({ kind, id: doc.id, doc, updated_at: at })) });
      }
    },
    async deleteObject(kind, id) { await call(`ggt_objects?kind=eq.${e(kind)}&id=eq.${e(id)}`, { method: 'DELETE', prefer: 'return=minimal' }); },
    async listObjects(kind, { where = {}, limit = 1000 } = {}) {
      const f = Object.entries(where).map(([k, v]) => `&doc->>${e(k)}=eq.${e(String(v))}`).join('');
      return (await json(`ggt_objects?kind=eq.${e(kind)}${f}&select=doc&order=updated_at.desc&limit=${limit}`)).map(r => r.doc);
    },
  };
}

function createStore(env = process.env) {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) return supabaseStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  if (env.POSTGRES_URL) return pgStore(env.POSTGRES_URL);
  return memoryStore();
}

module.exports = { createStore, memoryStore };
