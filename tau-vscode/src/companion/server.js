const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const AUTH_HEADER = 'x-claude-code-ide-authorization';
const SUBPROTOCOL = 'mcp';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = {
  name: 'claudex-ide',
  version: '0.5.6',
};

/**
 * Tool registry passed to the server. Shape:
 *   {
 *     [toolName]: {
 *       description: string,
 *       inputSchema: object,            // JSON schema (loose ok — CLI ignores)
 *       handler: async (args) => { content: [...] }
 *     }
 *   }
 */

function buildToolList(tools) {
  return Object.entries(tools).map(([name, def]) => ({
    name,
    description: def.description || '',
    inputSchema: def.inputSchema || { type: 'object', properties: {} },
  }));
}

function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id,
    error: data ? { code, message, data } : { code, message },
  };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/**
 * Dispatch a single inbound MCP message. Returns the response object, or null
 * for notifications (no `id`).
 */
async function dispatch(message, ctx) {
  if (!message || typeof message !== 'object') {
    return jsonRpcError(null, -32600, 'Invalid Request');
  }
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  try {
    if (method === 'initialize') {
      return jsonRpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          logging: {},
        },
        serverInfo: SERVER_INFO,
      });
    }

    if (method === 'notifications/initialized' || method === 'initialized') {
      return null;
    }

    if (method === 'ping') {
      return jsonRpcResult(id, {});
    }

    if (method === 'tools/list') {
      return jsonRpcResult(id, { tools: buildToolList(ctx.tools) });
    }

    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const def = ctx.tools[name];
      if (!def) {
        return jsonRpcError(id, -32601, `Unknown tool: ${name}`);
      }
      try {
        const result = await def.handler(args);
        return jsonRpcResult(id, result);
      } catch (e) {
        return jsonRpcResult(id, {
          isError: true,
          content: [
            { type: 'text', text: e && e.message ? e.message : String(e) },
          ],
        });
      }
    }

    // CLI-side notifications we silently accept (no response).
    if (
      method === 'ide_connected' ||
      method === 'experiment_gates' ||
      method === 'set_permission_mode' ||
      method === 'log_event' ||
      method === 'file_updated'
    ) {
      if (ctx.onCliNotification) {
        try {
          ctx.onCliNotification(method, params);
        } catch (_) {
          // swallow
        }
      }
      return null;
    }

    if (isNotification) {
      return null;
    }
    return jsonRpcError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    if (isNotification) {
      return null;
    }
    return jsonRpcError(
      id,
      -32603,
      err && err.message ? err.message : 'Internal error',
    );
  }
}

class CompanionServer {
  constructor({ tools, log, onCliNotification }) {
    this._tools = tools || {};
    this._log = log || (() => {});
    this._onCliNotification = onCliNotification || null;
    this._authToken = null;
    this._port = null;
    this._wss = null;
    /** @type {Set<import('ws').WebSocket>} */
    this._clients = new Set();
  }

  get port() {
    return this._port;
  }
  get authToken() {
    return this._authToken;
  }

  async start() {
    this._authToken = crypto.randomBytes(32).toString('base64url');

    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: '127.0.0.1',
        port: 0,
        handleProtocols: protocols => {
          // Accept the `mcp` subprotocol if offered. CLI side asks for it.
          if (protocols && typeof protocols.has === 'function') {
            return protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false;
          }
          if (Array.isArray(protocols)) {
            return protocols.includes(SUBPROTOCOL) ? SUBPROTOCOL : false;
          }
          return false;
        },
        verifyClient: (info, cb) => {
          const headerValue =
            info.req.headers[AUTH_HEADER] ||
            info.req.headers[AUTH_HEADER.toUpperCase()];
          if (!headerValue || headerValue !== this._authToken) {
            cb(false, 401, 'Unauthorized');
            return;
          }
          cb(true);
        },
      });

      wss.on('listening', () => {
        const addr = wss.address();
        this._port = typeof addr === 'object' && addr ? addr.port : null;
        this._wss = wss;
        this._log(`Companion server listening on ws://127.0.0.1:${this._port}`);
        resolve();
      });

      wss.on('error', err => {
        this._log(`Companion server error: ${err && err.message}`);
        if (!this._port) {
          reject(err);
        }
      });

      wss.on('connection', socket => this._onConnection(socket));
    });
  }

  async stop() {
    const wss = this._wss;
    this._wss = null;
    if (!wss) return;

    for (const socket of this._clients) {
      try {
        socket.close(1001, 'extension deactivating');
      } catch (_) {
        // ignore
      }
    }
    this._clients.clear();

    await new Promise(resolve => {
      wss.close(() => resolve());
    });
    this._log('Companion server stopped');
  }

  _onConnection(socket) {
    this._clients.add(socket);
    socket.on('close', () => this._clients.delete(socket));
    socket.on('error', err => {
      this._log(`socket error: ${err && err.message}`);
    });
    socket.on('message', raw => this._onMessage(socket, raw));
  }

  async _onMessage(socket, raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (_) {
      socket.send(JSON.stringify(jsonRpcError(null, -32700, 'Parse error')));
      return;
    }

    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const msg of messages) {
      const response = await dispatch(msg, {
        tools: this._tools,
        onCliNotification: this._onCliNotification,
      });
      if (response) {
        try {
          socket.send(JSON.stringify(response));
        } catch (e) {
          this._log(`send failed: ${e && e.message}`);
        }
      }
    }
  }

  /** Push an unsolicited notification to every connected CLI. */
  notify(method, params) {
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    for (const socket of this._clients) {
      try {
        socket.send(payload);
      } catch (_) {
        // ignore
      }
    }
  }
}

module.exports = {
  AUTH_HEADER,
  CompanionServer,
  PROTOCOL_VERSION,
  SUBPROTOCOL,
  SERVER_INFO,
  buildToolList,
  dispatch,
  jsonRpcError,
  jsonRpcResult,
};
