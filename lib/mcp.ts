// MCP over Streamable HTTP (JSON-RPC 2.0, plain JSON answers, no SSE):
// server/discover, initialize, tools/list, tools/call. Every call needs the
// trial token; unknown tools and missing arguments answer JSON-RPC -32602.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ForgeError, issueJson, pullJson, repoJson } from './store.ts';
import type { Store } from './store.ts';
import { VIEWER, isAuthenticated, sendJson } from './util.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];

export interface McpContext {
  readonly store: Store;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly body: Buffer;
}

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, Record<string, unknown>>;
    readonly required: string[];
  };
  readonly run: (store: Store, args: Record<string, unknown>) => unknown;
}

function strArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value === 'string' && value !== '') return value;
  throw new ForgeError(-32602, `missing required argument: ${name}`);
}

function optStrArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function intArg(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1) throw new ForgeError(-32602, `missing required argument: ${name}`);
  return n;
}

/** Split "owner/repo" out of owner/repo args (or a full_name arg). */
function ownerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = optStrArg(args, 'owner');
  let repo = optStrArg(args, 'repo');
  if ((owner === undefined || repo === undefined) && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) {
      owner = owner ?? (parts[0] as string);
      repo = repo ?? (parts[1] as string);
    }
  }
  if (owner === undefined) throw new ForgeError(-32602, 'missing required argument: owner');
  if (repo === undefined) throw new ForgeError(-32602, 'missing required argument: repo');
  return { owner, repo };
}

function getRepoOrThrow(store: Store, owner: string, repo: string): NonNullable<ReturnType<Store['getRepo']>> {
  if (owner !== VIEWER.login) throw new ForgeError(404, `repository ${owner}/${repo} does not exist`);
  const found = store.getRepo(owner, repo);
  if (found === undefined) throw new ForgeError(404, `repository ${owner}/${repo} does not exist`);
  return found;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
      },
      required: ['name'],
    },
    run: (store, args) => {
      const repo = store.createRepo(
        VIEWER.login,
        strArg(args, 'name'),
        optStrArg(args, 'description') ?? '',
        args.private === true,
      );
      return repoJson(repo, 'localhost');
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
    run: (store, args) => {
      const { owner, repo } = ownerRepo(args);
      return repoJson(getRepoOrThrow(store, owner, repo), 'localhost');
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (store, args) => {
      const { owner, repo } = ownerRepo(args);
      const found = getRepoOrThrow(store, owner, repo);
      const issue = store.createIssue(found, strArg(args, 'title'), optStrArg(args, 'body') ?? '', []);
      return issueJson(found, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
    run: (store, args) => {
      const { owner, repo } = ownerRepo(args);
      const found = getRepoOrThrow(store, owner, repo);
      const state = optStrArg(args, 'state');
      const list = store.listIssues(found, state === 'closed' ? 'closed' : state === 'all' ? 'all' : 'open', 'desc');
      return list.map((issue) => issueJson(found, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (store, args) => {
      const { owner, repo } = ownerRepo(args);
      const found = getRepoOrThrow(store, owner, repo);
      const pr = store.createPullRequest(
        found,
        strArg(args, 'head'),
        strArg(args, 'base'),
        strArg(args, 'title'),
        optStrArg(args, 'body') ?? '',
      );
      return pullJson(found, pr);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (store, args) => {
      const { owner, repo } = ownerRepo(args);
      const found = getRepoOrThrow(store, owner, repo);
      const number = intArg(args, 'pull_number');
      const pr = found.pulls.get(number);
      if (pr === undefined) throw new ForgeError(404, `pull request ${number} does not exist`);
      const result = store.mergePullRequest(found, pr);
      return { number: pr.number, merged: true, sha: result.sha, state: 'closed' };
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
    run: (store, args) => {
      const { owner, repo } = ownerRepo(args);
      const found = getRepoOrThrow(store, owner, repo);
      const number = intArg(args, 'issue_number');
      const issue = found.issues.get(number);
      if (issue === undefined) throw new ForgeError(404, `issue ${number} does not exist`);
      return issueJson(found, issue);
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
    run: (store, args) => {
      const { owner, repo } = ownerRepo(args);
      const found = getRepoOrThrow(store, owner, repo);
      const state = optStrArg(args, 'state');
      const list = store.listPulls(found, state === 'closed' ? 'closed' : state === 'all' ? 'all' : 'open');
      return list.map((pr) => pullJson(found, pr));
    },
  },
];

function toolListJson(): Array<Record<string, unknown>> {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

function rpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(res: ServerResponse, status: number, id: unknown, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

/** Handle one /mcp request; true when the path belonged to MCP. */
export function handleMcp(ctx: McpContext): boolean {
  if (ctx.method !== 'POST') {
    sendJson(ctx.res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    rpcError(ctx.res, 400, null, -32700, 'Parse error: body is not valid JSON');
    return true;
  }
  if (!isAuthenticated(ctx.req)) {
    sendJson(ctx.res, 401, { message: 'Requires authentication' });
    return true;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    rpcError(ctx.res, 400, null, -32600, 'Invalid Request');
    return true;
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id ?? null;
  const method = request.method;
  if (typeof method !== 'string') {
    rpcError(ctx.res, 400, id, -32600, 'Invalid Request: method is required');
    return true;
  }
  // A notification (no id) is answered with 202 and no body.
  if (id === null || id === undefined) {
    ctx.res.writeHead(202);
    ctx.res.end();
    return true;
  }

  if (method === 'server/discover') {
    rpcResult(ctx.res, id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
    return true;
  }

  if (method === 'initialize') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    rpcResult(ctx.res, id, {
      protocolVersion: offered !== null && SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return true;
  }

  if (method === 'ping') {
    rpcResult(ctx.res, id, {});
    return true;
  }

  if (method === 'tools/list') {
    rpcResult(ctx.res, id, { tools: toolListJson() });
    return true;
  }

  if (method === 'tools/call') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const name = params.name;
    if (typeof name !== 'string' || name === '') {
      rpcError(ctx.res, 200, id, -32602, 'tools/call needs a tool name');
      return true;
    }
    const tool = TOOLS.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (tool === undefined) {
      rpcError(ctx.res, 200, id, -32602, `unknown tool ${name}`);
      return true;
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = tool.run(ctx.store, args);
      rpcResult(ctx.res, id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      });
    } catch (err) {
      if (err instanceof ForgeError && err.status === -32602) {
        rpcError(ctx.res, 200, id, -32602, err.message);
      } else if (err instanceof ForgeError) {
        rpcResult(ctx.res, id, {
          content: [{ type: 'text', text: err.message }],
          isError: true,
        });
      } else {
        rpcResult(ctx.res, id, {
          content: [{ type: 'text', text: err instanceof Error ? err.message : 'tool error' }],
          isError: true,
        });
      }
    }
    return true;
  }

  rpcError(ctx.res, 200, id, -32601, `method not found: ${method}`);
  return true;
}
