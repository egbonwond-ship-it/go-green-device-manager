// Where agent data is kept.
// - POSTGRES_URL set: PostgreSQL, e.g. a free Supabase project (use its connection pooler URL).
// - SQL_CONNECTION_STRING set: Azure SQL Database (free offer: 100,000 vCore seconds and 32 GB a month).
// - COSMOS_CONNECTION_STRING set: Azure Cosmos DB (free tier: 1000 RU/s and 25 GB).
// - Neither: in memory, which is lost when the API restarts. Fine for local runs and tests.
const DB = process.env.COSMOS_DATABASE || 'ggt-devices';
const MAX_STATUSES = 5000;

function memoryStore() {
  const devices = new Map();
  const statuses = [];
  return {
    kind: 'memory',
    async getDevice(id) { return devices.get(id) || null; },
    async upsertDevice(d) { devices.set(d.id, d); return d; },
    async listDevices() { return [...devices.values()]; },
    async countDevices() { return devices.size; },
    async addStatus(s) { statuses.push(s); if (statuses.length > MAX_STATUSES) statuses.shift(); },
    async listStatuses(deviceId) { return statuses.filter(s => !deviceId || s.deviceId === deviceId); },
  };
}

function cosmosStore(conn) {
  const { CosmosClient } = require('@azure/cosmos');
  const client = new CosmosClient(conn);
  let ready = null;
  // Creates the database and containers on first use if they don't exist.
  // The database shares 1000 RU/s across containers, which the free tier covers.
  const init = () => (ready ??= (async () => {
    const { database } = await client.databases.createIfNotExists({ id: DB, throughput: 1000 });
    const { container: devices } = await database.containers.createIfNotExists({ id: 'devices', partitionKey: { paths: ['/id'] } });
    const { container: statuses } = await database.containers.createIfNotExists({ id: 'statuses', partitionKey: { paths: ['/deviceId'] }, defaultTtl: 60 * 60 * 24 * 90 });
    return { devices, statuses };
  })().catch(e => { ready = null; throw e; }));
  const strip = d => { if (!d) return null; const { _rid, _self, _etag, _attachments, _ts, ...rest } = d; return rest; };
  return {
    kind: 'cosmos',
    async getDevice(id) {
      const { devices } = await init();
      try { const { resource } = await devices.item(id, id).read(); return strip(resource); } catch (e) { if (e.code === 404) return null; throw e; }
    },
    async upsertDevice(d) { const { devices } = await init(); await devices.items.upsert(d); return d; },
    async listDevices() {
      const { devices } = await init();
      const { resources } = await devices.items.query('SELECT * FROM c ORDER BY c.lastSeen DESC OFFSET 0 LIMIT 1000').fetchAll();
      return resources.map(strip);
    },
    async countDevices() {
      const { devices } = await init();
      const { resources } = await devices.items.query('SELECT VALUE COUNT(1) FROM c').fetchAll();
      return resources[0] || 0;
    },
    async addStatus(s) { const { statuses } = await init(); await statuses.items.create({ id: `${s.deviceId}-${s.deploymentId}-${Date.now()}`, ...s }); },
    async listStatuses(deviceId) {
      const { statuses } = await init();
      const q = deviceId ? { query: 'SELECT * FROM c WHERE c.deviceId = @d ORDER BY c.at DESC', parameters: [{ name: '@d', value: deviceId }] } : 'SELECT TOP 500 * FROM c ORDER BY c.at DESC';
      const { resources } = await statuses.items.query(q).fetchAll();
      return resources.map(strip);
    },
  };
}

function sqlStore(conn) {
  const sql = require('mssql');
  let poolP = null;
  // The free database pauses when idle; the first connection after a pause can take up to a minute
  // or fail with error 40613 while it resumes, so allow a long connect and retry.
  const pool = () => (poolP ??= new sql.ConnectionPool(conn.includes('Connection Timeout') ? conn : `${conn.replace(/;?$/, ';')}Connection Timeout=60`)
    .connect().then(async p => {
      await p.request().batch(`
IF OBJECT_ID('dbo.devices') IS NULL CREATE TABLE dbo.devices (
  id NVARCHAR(64) NOT NULL PRIMARY KEY, name NVARCHAR(64) NOT NULL, platform NVARCHAR(16) NOT NULL,
  last_seen DATETIME2 NOT NULL, doc NVARCHAR(MAX) NOT NULL);
IF OBJECT_ID('dbo.deployment_status') IS NULL CREATE TABLE dbo.deployment_status (
  id BIGINT IDENTITY(1,1) PRIMARY KEY, device_id NVARCHAR(64) NOT NULL, deployment_id NVARCHAR(64) NOT NULL,
  state NVARCHAR(16) NOT NULL, error_code NVARCHAR(20) NULL, at DATETIME2 NOT NULL,
  INDEX ix_status_device (device_id, at));`);
      return p;
    })
    .catch(e => { poolP = null; throw e; }));
  const q = async (text, params = {}, tries = 3) => {
    try {
      const req = (await pool()).request();
      for (const [k, [type, v]] of Object.entries(params)) req.input(k, type, v);
      return (await req.query(text)).recordset || [];
    } catch (e) {
      const transient = [40613, 40197, 40501, 49918, 49919, 49920].includes(e.number) || e.code === 'ETIMEOUT' || e.code === 'ESOCKET';
      if (transient && tries > 1) { poolP = null; await new Promise(r => setTimeout(r, 5000)); return q(text, params, tries - 1); }
      throw e;
    }
  };
  const S = v => [sql.NVarChar(sql.MAX), v];
  const toStatus = r => ({ deviceId: r.device_id, deploymentId: r.deployment_id, state: r.state, errorCode: r.error_code, at: new Date(r.at).toISOString() });
  return {
    kind: 'azure-sql',
    async getDevice(id) { const r = await q('SELECT doc FROM dbo.devices WHERE id = @id', { id: S(id) }); return r[0] ? JSON.parse(r[0].doc) : null; },
    async upsertDevice(d) {
      await q(`MERGE dbo.devices WITH (HOLDLOCK) AS t USING (SELECT @id AS id) AS s ON t.id = s.id
        WHEN MATCHED THEN UPDATE SET name = @name, platform = @platform, last_seen = @seen, doc = @doc
        WHEN NOT MATCHED THEN INSERT (id, name, platform, last_seen, doc) VALUES (@id, @name, @platform, @seen, @doc);`,
      { id: S(d.id), name: S(d.name), platform: S(d.platform), seen: [sql.DateTime2, new Date(d.lastSeen)], doc: S(JSON.stringify(d)) });
      return d;
    },
    async listDevices() { return (await q('SELECT TOP 1000 doc FROM dbo.devices ORDER BY last_seen DESC')).map(r => JSON.parse(r.doc)); },
    async countDevices() { return (await q('SELECT COUNT(*) AS n FROM dbo.devices'))[0].n; },
    async addStatus(s) {
      await q('INSERT INTO dbo.deployment_status (device_id, deployment_id, state, error_code, at) VALUES (@d, @dep, @st, @err, @at)',
        { d: S(s.deviceId), dep: S(s.deploymentId), st: S(s.state), err: S(s.errorCode), at: [sql.DateTime2, new Date(s.at)] });
    },
    async listStatuses(deviceId) {
      const r = deviceId
        ? await q('SELECT TOP 500 * FROM dbo.deployment_status WHERE device_id = @d ORDER BY at DESC', { d: S(deviceId) })
        : await q('SELECT TOP 500 * FROM dbo.deployment_status ORDER BY at DESC');
      return r.map(toStatus);
    },
  };
}

function pgStore(url) {
  const { Pool } = require('pg');
  const ssl = /localhost|127\.0\.0\.1/.test(url) || /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ''), ssl, max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000 });
  let ready = null;
  // Own schema, not "public": Supabase's auto-generated REST API only exposes "public",
  // so device data can't be read with the project's anon key.
  const init = () => (ready ??= pool.query(`
CREATE SCHEMA IF NOT EXISTS ggt;
CREATE TABLE IF NOT EXISTS ggt.devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, last_seen TIMESTAMPTZ NOT NULL, doc JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS ggt.deployment_status (
  id BIGSERIAL PRIMARY KEY, device_id TEXT NOT NULL, deployment_id TEXT NOT NULL, state TEXT NOT NULL, error_code TEXT, at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS ix_status_device ON ggt.deployment_status (device_id, at DESC);`).catch(e => { ready = null; throw e; }));
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
    async listDevices() { return (await q('SELECT doc FROM ggt.devices ORDER BY last_seen DESC LIMIT 1000')).map(r => r.doc); },
    async countDevices() { return Number((await q('SELECT COUNT(*)::int AS n FROM ggt.devices'))[0].n); },
    async addStatus(s) { await q('INSERT INTO ggt.deployment_status (device_id, deployment_id, state, error_code, at) VALUES ($1, $2, $3, $4, $5)', [s.deviceId, s.deploymentId, s.state, s.errorCode, s.at]); },
    async listStatuses(deviceId) {
      const r = deviceId ? await q('SELECT * FROM ggt.deployment_status WHERE device_id = $1 ORDER BY at DESC LIMIT 500', [deviceId]) : await q('SELECT * FROM ggt.deployment_status ORDER BY at DESC LIMIT 500');
      return r.map(toStatus);
    },
  };
}

function createStore(env = process.env) {
  if (env.POSTGRES_URL) return pgStore(env.POSTGRES_URL);
  if (env.SQL_CONNECTION_STRING) return sqlStore(env.SQL_CONNECTION_STRING);
  if (env.COSMOS_CONNECTION_STRING) return cosmosStore(env.COSMOS_CONNECTION_STRING);
  return memoryStore();
}

module.exports = { createStore, memoryStore };
