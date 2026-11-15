// HTTP server and router: /healthz, git smart HTTP, REST v3, GraphQL, MCP.
// One process, one in-memory store. A failing request never kills the server.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGit } from './lib/git-routes.ts';
import { handleGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';
import { handleRest } from './lib/rest.ts';
import { Store } from './lib/store.ts';
import { readBody, sendJson, trialEpochSec } from './lib/util.ts';

export function createApp(): ReturnType<typeof createServer> {
  const store = new Store(trialEpochSec());
  const server = createServer((req, res) => {
    void handleRequest(store, req, res).catch((err: unknown) => {
      try {
        if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
        else res.end();
      } catch {
        // The socket is already gone; nothing left to do.
      }
    });
  });
  return server;
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let pathname: string;
  let search: URLSearchParams;
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
    search = url.searchParams;
  } catch {
    sendJson(res, 400, { message: 'bad request' });
    return;
  }
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  const host = req.headers.host ?? 'localhost';
  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const body = needsBody ? await readBody(req) : Buffer.alloc(0);

  // The suite's boot probe: no auth, no body.
  if (pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (handleGit({ store, req, res, method, pathname, search, body })) return;

  if (pathname.startsWith('/api/v3')) {
    handleRest({ store, req, res, method, pathname, search, body, host });
    return;
  }

  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    handleGraphQL({ store, req, res, body });
    return;
  }

  if (pathname === '/mcp') {
    handleMcp({ store, req, res, method, body });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
