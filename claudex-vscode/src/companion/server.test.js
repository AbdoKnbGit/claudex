const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');

const {
  CompanionServer,
  buildToolList,
  dispatch,
  jsonRpcError,
  jsonRpcResult,
} = require('./server');

test('buildToolList exposes name/description/schema for each registered tool', () => {
  const tools = buildToolList({
    foo: { description: 'does foo', inputSchema: { type: 'object' } },
    bar: { handler: () => {} },
  });

  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, 'foo');
  assert.equal(tools[0].description, 'does foo');
  assert.deepEqual(tools[0].inputSchema, { type: 'object' });
  assert.equal(tools[1].name, 'bar');
});

test('dispatch returns the canonical initialize response', async () => {
  const reply = await dispatch(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { tools: {} },
  );
  assert.equal(reply.id, 1);
  assert.ok(reply.result.serverInfo.name);
  assert.ok(reply.result.capabilities.tools);
});

test('dispatch routes tools/call to the registered handler', async () => {
  const tools = {
    echo: {
      handler: async args => ({
        content: [{ type: 'text', text: args.value }],
      }),
    },
  };
  const reply = await dispatch(
    {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'echo', arguments: { value: 'hi' } },
    },
    { tools },
  );

  assert.equal(reply.id, 7);
  assert.equal(reply.result.content[0].text, 'hi');
});

test('dispatch surfaces handler exceptions as isError content (not protocol errors)', async () => {
  const tools = {
    blow: {
      handler: async () => {
        throw new Error('boom');
      },
    },
  };
  const reply = await dispatch(
    {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'blow', arguments: {} },
    },
    { tools },
  );

  assert.equal(reply.id, 9);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /boom/);
});

test('dispatch returns null for notifications/initialized', async () => {
  const reply = await dispatch(
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { tools: {} },
  );
  assert.equal(reply, null);
});

test('dispatch invokes onCliNotification for known CLI-side notifications', async () => {
  const seen = [];
  await dispatch(
    {
      jsonrpc: '2.0',
      method: 'ide_connected',
      params: { pid: 42 },
    },
    {
      tools: {},
      onCliNotification: (method, params) => seen.push([method, params]),
    },
  );
  assert.deepEqual(seen, [['ide_connected', { pid: 42 }]]);
});

test('dispatch returns method-not-found for unknown methods with id', async () => {
  const reply = await dispatch(
    { jsonrpc: '2.0', id: 3, method: 'mystery/thing' },
    { tools: {} },
  );
  assert.equal(reply.error.code, -32601);
});

test('jsonRpcError + jsonRpcResult helpers shape JSON-RPC 2.0 envelopes', () => {
  assert.deepEqual(jsonRpcError(1, -32700, 'Parse error'), {
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32700, message: 'Parse error' },
  });
  assert.deepEqual(jsonRpcResult(2, { ok: true }), {
    jsonrpc: '2.0',
    id: 2,
    result: { ok: true },
  });
});

test('CompanionServer enforces the X-Claude-Code-Ide-Authorization token', async () => {
  const server = new CompanionServer({
    tools: {
      ping: { handler: async () => ({ content: [{ type: 'text', text: 'pong' }] }) },
    },
  });
  await server.start();

  try {
    // Bad token -> connection rejected with 401.
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, ['mcp'], {
        headers: { 'X-Claude-Code-Ide-Authorization': 'wrong-token' },
      });
      ws.on('unexpected-response', (_req, res) => {
        try {
          assert.equal(res.statusCode, 401);
          ws.terminate();
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      ws.on('open', () => {
        ws.terminate();
        reject(new Error('expected 401, got open'));
      });
      ws.on('error', () => {
        // ws also fires error on the unexpected-response — already handled above.
      });
    });

    // Valid token -> tools/list works end-to-end.
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, ['mcp'], {
        headers: { 'X-Claude-Code-Ide-Authorization': server.authToken },
      });
      ws.on('open', () => {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
      });
      ws.on('message', raw => {
        try {
          const msg = JSON.parse(raw.toString());
          assert.equal(msg.id, 1);
          assert.ok(Array.isArray(msg.result.tools));
          assert.equal(msg.result.tools[0].name, 'ping');
          ws.close();
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      ws.on('error', reject);
    });
  } finally {
    await server.stop();
  }
});
