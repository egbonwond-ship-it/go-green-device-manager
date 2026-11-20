// Where agent data is kept.
// - COSMOS_CONNECTION_STRING set: Azure Cosmos DB (free tier: 1000 RU/s and 25 GB at no cost).
// - Not set: in memory, which is lost when the API restarts. Fine for local runs and tests.
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

function createStore(env = process.env) {
  return env.COSMOS_CONNECTION_STRING ? cosmosStore(env.COSMOS_CONNECTION_STRING) : memoryStore();
}

module.exports = { createStore, memoryStore };
