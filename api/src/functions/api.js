const { app } = require('@azure/functions');
const { handle } = require('../lib/router');

// One HTTP function serves every /api/* route; routing happens in lib/router.js.
app.http('api', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: '{*path}',
  handler: async (request) => {
    const url = new URL(request.url);
    let body = {};
    if (request.method === 'POST') { try { body = await request.json(); } catch { body = {}; } }
    const out = await handle({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      headers: Object.fromEntries(request.headers.entries()),
    });
    return { status: out.status, jsonBody: out.body, headers: { 'Cache-Control': 'no-store' } };
  },
});
