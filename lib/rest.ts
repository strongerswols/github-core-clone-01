// REST v3 handlers (/api/v3). Every reply is application/json and carries a
// non-empty X-GitHub-Request-Id; 4xx bodies are {"message": string}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit, parseTag } from './git.ts';
import {
  ForgeError,
  commentJson,
  issueJson,
  notFound,
  pullJson,
  repoJson,
  unprocessable,
  viewerUser,
} from './store.ts';
import type { Repo, Store } from './store.ts';
import { VIEWER, isAuthenticated, isoFromEpochSec, parseIdentity, parseJsonBody, sendJson, isRecord } from './util.ts';

export interface RestContext {
  readonly store: Store;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly pathname: string;
  readonly search: URLSearchParams;
  readonly body: Buffer;
  readonly host: string;
}

function requestIdHeader(ctx: RestContext): Record<string, string> {
  return { 'x-github-request-id': ctx.store.nextRequestId() };
}

function ok(ctx: RestContext, status: number, body: unknown, extra: Record<string, string> = {}): void {
  sendJson(ctx.res, status, body, { ...requestIdHeader(ctx), ...extra });
}

function fail(ctx: RestContext, err: ForgeError): void {
  sendJson(ctx.res, err.status, { message: err.message }, requestIdHeader(ctx));
}

function unauthorized(ctx: RestContext): void {
  sendJson(ctx.res, 401, { message: 'Requires authentication' }, requestIdHeader(ctx));
}

/** Parse the request body as JSON; 400 when it is malformed. */
function jsonBody(ctx: RestContext): Record<string, unknown> | null {
  const parsed = parseJsonBody(ctx.body);
  if (parsed === null) {
    sendJson(ctx.res, 400, { message: 'body is not valid JSON' }, requestIdHeader(ctx));
    return null;
  }
  if (!isRecord(parsed)) {
    sendJson(ctx.res, 400, { message: 'body must be a JSON object' }, requestIdHeader(ctx));
    return null;
  }
  return parsed;
}

function strField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === 'string' ? value : undefined;
}

function boolField(body: Record<string, unknown>, name: string): boolean | undefined {
  const value = body[name];
  return typeof value === 'boolean' ? value : undefined;
}

function strArrayField(body: Record<string, unknown>, name: string): string[] {
  const value = body[name];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/** Paginate a list; returns the page and a Link header value (or null). */
function paginate<T>(
  ctx: RestContext,
  items: readonly T[],
): { page: T[]; link: string | null } {
  const perPageRaw = Number(ctx.search.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) ? Math.max(1, Math.min(100, Math.floor(perPageRaw))) : 30;
  const pageRaw = Number(ctx.search.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.floor(pageRaw)) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const sliced = items.slice(start, start + perPage);
  const urlFor = (p: number): string => {
    const params = new URLSearchParams();
    for (const [key, value] of ctx.search) {
      if (key !== 'page' && key !== 'per_page') params.set(key, value);
    }
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `http://${ctx.host}${ctx.pathname}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page < totalPages) {
    links.push(`<${urlFor(page + 1)}>; rel="next"`);
    links.push(`<${urlFor(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${urlFor(page - 1)}>; rel="prev"`);
    links.push(`<${urlFor(1)}>; rel="first"`);
  }
  return { page: [...sliced], link: links.length === 0 ? null : links.join(', ') };
}

function requireRepo(ctx: RestContext, owner: string, name: string): Repo {
  if (owner !== VIEWER.login) throw notFound(`repository ${owner}/${name} does not exist`);
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) throw notFound(`repository ${owner}/${name} does not exist`);
  return repo;
}

function commitJson(store: Store, sha: string): Record<string, unknown> {
  const object = store.lookup(sha);
  if (object === undefined || object.type !== 'commit') throw notFound(`commit ${sha} does not exist`);
  const commit = parseCommit(object.data);
  const author = parseIdentity(commit.author);
  const committer = parseIdentity(commit.committer);
  return {
    sha,
    commit: {
      message: commit.message,
      author: { name: author.name, email: author.email, date: isoFromEpochSec(author.timestamp) },
      committer: { name: committer.name, email: committer.email, date: isoFromEpochSec(committer.timestamp) },
    },
    parents: commit.parents.map((p) => ({ sha: p })),
  };
}

/** Handle one /api/v3 request; true when the path belonged to REST. */
export function handleRest(ctx: RestContext): boolean {
  if (!ctx.pathname.startsWith('/api/v3')) return false;
  if (!isAuthenticated(ctx.req)) {
    unauthorized(ctx);
    return true;
  }
  try {
    routeRest(ctx);
  } catch (err) {
    if (err instanceof ForgeError) fail(ctx, err);
    else {
      sendJson(ctx.res, 500, { message: err instanceof Error ? err.message : 'internal error' }, requestIdHeader(ctx));
    }
  }
  return true;
}

function routeRest(ctx: RestContext): void {
  const { method, pathname } = ctx;
  const rest = pathname.slice('/api/v3'.length);
  const parts = rest.split('/').filter((p) => p !== '');

  // GET /api/v3/ — root.
  if (parts.length === 0) {
    if (method !== 'GET') throw new ForgeError(405, 'Method Not Allowed');
    ok(ctx, 200, {
      current_user_url: `http://${ctx.host}/api/v3/user`,
      rate_limit_url: `http://${ctx.host}/api/v3/rate_limit`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // GET /api/v3/meta
  if (parts.length === 1 && parts[0] === 'meta') {
    if (method !== 'GET') throw new ForgeError(405, 'Method Not Allowed');
    ok(ctx, 200, { installed_version: '1.0.0' });
    return;
  }

  // GET /api/v3/user, POST /api/v3/user/repos, GET /api/v3/user/repos
  if (parts[0] === 'user') {
    if (parts.length === 1 && method === 'GET') {
      ok(ctx, 200, viewerUser());
      return;
    }
    if (parts.length === 2 && parts[1] === 'repos') {
      if (method === 'POST') {
        const body = jsonBody(ctx);
        if (body === null) return;
        const name = strField(body, 'name');
        if (name === undefined || name === '') throw unprocessable('name is required');
        const repo = ctx.store.createRepo(
          VIEWER.login,
          name,
          strField(body, 'description') ?? '',
          boolField(body, 'private') ?? false,
        );
        ok(ctx, 201, repoJson(repo, ctx.host));
        return;
      }
      if (method === 'GET') {
        const repos = ctx.store.listRepos(VIEWER.login);
        const { page, link } = paginate(ctx, repos);
        ok(ctx, 200, page.map((repo) => repoJson(repo, ctx.host)), link === null ? {} : { link });
        return;
      }
    }
    throw notFound();
  }

  // /api/v3/repos/{owner}/{name}/...
  if (parts[0] === 'repos' && parts.length >= 3) {
    const owner = parts[1] as string;
    const name = parts[2] as string;
    routeRepo(ctx, owner, name, parts.slice(3));
    return;
  }

  throw notFound();
}

function routeRepo(ctx: RestContext, owner: string, name: string, tail: string[]): void {
  const { method } = ctx;
  const store = ctx.store;

  // /repos/{o}/{r}
  if (tail.length === 0) {
    if (method === 'GET') {
      const repo = requireRepo(ctx, owner, name);
      ok(ctx, 200, repoJson(repo, ctx.host));
      return;
    }
    if (method === 'PATCH') {
      const repo = requireRepo(ctx, owner, name);
      const body = jsonBody(ctx);
      if (body === null) return;
      const description = strField(body, 'description');
      if (description !== undefined) repo.description = description;
      const isPrivate = boolField(body, 'private');
      if (isPrivate !== undefined) repo.private = isPrivate;
      ok(ctx, 200, repoJson(repo, ctx.host));
      return;
    }
    if (method === 'DELETE') {
      requireRepo(ctx, owner, name);
      store.deleteRepo(owner, name);
      ctx.res.writeHead(204, requestIdHeader(ctx));
      ctx.res.end();
      return;
    }
    throw new ForgeError(405, 'Method Not Allowed');
  }

  const section = tail[0] as string;
  const repo = requireRepo(ctx, owner, name);

  if (section === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches = store.listBranches(repo);
      ok(ctx, 200, branches.map((b) => ({ name: b.name, commit: { sha: b.sha } })));
      return;
    }
    if (tail.length >= 2 && method === 'GET') {
      const branchName = tail.slice(1).join('/');
      const branch = store.listBranches(repo).find((b) => b.name === branchName);
      if (branch === undefined) throw notFound(`branch ${branchName} does not exist`);
      ok(ctx, 200, { name: branch.name, commit: { sha: branch.sha } });
      return;
    }
    throw new ForgeError(405, 'Method Not Allowed');
  }

  if (section === 'commits') {
    if (tail.length === 1 && method === 'GET') {
      const ref = ctx.search.get('sha') ?? repo.defaultBranch;
      const shas = store.listCommits(repo, ref);
      ok(ctx, 200, shas.map((sha) => commitJson(store, sha)));
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      ok(ctx, 200, commitJson(store, tail[1] as string));
      return;
    }
    throw new ForgeError(405, 'Method Not Allowed');
  }

  if (section === 'contents') {
    routeContents(ctx, repo, tail.slice(1));
    return;
  }

  if (section === 'labels') {
    if (tail.length === 1 && method === 'GET') {
      ok(ctx, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
      return;
    }
    if (tail.length === 1 && method === 'POST') {
      const body = jsonBody(ctx);
      if (body === null) return;
      const labelName = strField(body, 'name');
      if (labelName === undefined || labelName === '') throw unprocessable('name is required');
      const label = store.createLabel(repo, labelName, strField(body, 'color') ?? 'ededed');
      ok(ctx, 201, { name: label.name, color: label.color });
      return;
    }
    throw new ForgeError(405, 'Method Not Allowed');
  }

  if (section === 'issues') {
    routeIssues(ctx, repo, tail.slice(1));
    return;
  }

  if (section === 'pulls') {
    routePulls(ctx, repo, tail.slice(1));
    return;
  }

  if (section === 'git') {
    routeGitData(ctx, repo, tail.slice(1));
    return;
  }

  throw notFound();
}

function routeContents(ctx: RestContext, repo: Repo, tail: string[]): void {
  const { method } = ctx;
  const store = ctx.store;
  const path = tail.join('/');
  const ref = ctx.search.get('ref') ?? repo.defaultBranch;

  if (method === 'GET') {
    const file = store.getFileAtRef(repo, ref, path);
    if (file !== null) {
      ok(ctx, 200, {
        type: 'file',
        encoding: 'base64',
        size: file.data.length,
        name: path.split('/').pop() ?? path,
        path,
        content: file.data.toString('base64'),
        sha: file.oid,
      });
      return;
    }
    const dir = store.getDirAtRef(repo, ref, path);
    if (dir !== null) {
      ok(ctx, 200, dir);
      return;
    }
    throw notFound(`no file or directory at ${path}`);
  }

  if (method === 'PUT') {
    const body = jsonBody(ctx);
    if (body === null) return;
    const contentB64 = strField(body, 'content');
    if (contentB64 === undefined) throw unprocessable('content is required');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      throw unprocessable('content is not valid base64');
    }
    const message = strField(body, 'message') ?? `Update ${path}`;
    const branch = strField(body, 'branch');
    const sha = strField(body, 'sha');
    const result = store.putContents(repo, path, content, message, branch, sha);
    ok(ctx, result.created ? 201 : 200, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: result.blobOid,
        size: content.length,
        encoding: 'base64',
        content: contentB64,
      },
      commit: { sha: result.commitOid, message },
    });
    return;
  }

  if (method === 'DELETE') {
    const body = jsonBody(ctx);
    if (body === null) return;
    const sha = strField(body, 'sha');
    if (sha === undefined) throw unprocessable('sha is required');
    const message = strField(body, 'message') ?? `Delete ${path}`;
    const branch = strField(body, 'branch');
    const commitOid = store.deleteContents(repo, path, message, branch, sha);
    ok(ctx, 200, { content: null, commit: { sha: commitOid, message } });
    return;
  }

  throw new ForgeError(405, 'Method Not Allowed');
}

function routeIssues(ctx: RestContext, repo: Repo, tail: string[]): void {
  const { method } = ctx;
  const store = ctx.store;

  // /issues
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = jsonBody(ctx);
      if (body === null) return;
      const title = strField(body, 'title');
      if (title === undefined || title === '') throw unprocessable('title is required');
      const issue = store.createIssue(repo, title, strField(body, 'body') ?? '', strArrayField(body, 'labels'));
      ok(ctx, 201, issueJson(repo, issue));
      return;
    }
    if (method === 'GET') {
      const stateParam = ctx.search.get('state') ?? 'open';
      const state = stateParam === 'all' ? 'all' : stateParam === 'closed' ? 'closed' : 'open';
      const direction = ctx.search.get('direction') === 'asc' ? 'asc' : 'desc';
      const issues = store.listIssues(repo, state, direction);
      const { page, link } = paginate(ctx, issues);
      ok(ctx, 200, page.map((issue) => issueJson(repo, issue)), link === null ? {} : { link });
      return;
    }
    throw new ForgeError(405, 'Method Not Allowed');
  }

  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) throw notFound();

  // /issues/{n}/comments
  if (tail.length === 2 && tail[1] === 'comments') {
    const issue = store.getIssue(repo, number);
    if (issue === undefined) throw notFound(`issue ${number} does not exist`);
    if (method === 'GET') {
      ok(ctx, 200, issue.comments.map((c) => commentJson(repo, issue, c)));
      return;
    }
    if (method === 'POST') {
      const body = jsonBody(ctx);
      if (body === null) return;
      const commentBody = strField(body, 'body');
      if (commentBody === undefined) throw unprocessable('body is required');
      const comment = store.addComment(repo, number, commentBody);
      ok(ctx, 201, commentJson(repo, issue, comment));
      return;
    }
    throw new ForgeError(405, 'Method Not Allowed');
  }

  // /issues/{n}
  if (tail.length === 1) {
    if (method === 'GET') {
      const issue = store.getIssue(repo, number);
      if (issue !== undefined) {
        ok(ctx, 200, issueJson(repo, issue));
        return;
      }
      // GitHub also serves pull requests as issues.
      const pr = store.getPull(repo, number);
      if (pr !== undefined) {
        ok(ctx, 200, {
          id: pr.id,
          number: pr.number,
          title: pr.title,
          body: pr.body,
          state: pr.state === 'open' ? 'open' : 'closed',
          labels: [],
          user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
          comments: 0,
          pull_request: {},
          created_at: pr.createdAt,
          updated_at: pr.updatedAt,
        });
        return;
      }
      throw notFound(`issue ${number} does not exist`);
    }
    if (method === 'PATCH') {
      const body = jsonBody(ctx);
      if (body === null) return;
      const issue = store.getIssue(repo, number);
      if (issue === undefined) throw notFound(`issue ${number} does not exist`);
      const state = strField(body, 'state');
      if (state === 'open' || state === 'closed') store.setIssueState(repo, number, state);
      const title = strField(body, 'title');
      if (title !== undefined) issue.title = title;
      const bodyText = strField(body, 'body');
      if (bodyText !== undefined) issue.body = bodyText;
      if (body.labels !== undefined) {
        const labels = strArrayField(body, 'labels');
        for (const label of labels) {
          if (!repo.labels.has(label)) throw unprocessable(`label ${label} does not exist`);
        }
        issue.labels = labels;
      }
      ok(ctx, 200, issueJson(repo, issue));
      return;
    }
    throw new ForgeError(405, 'Method Not Allowed');
  }

  throw notFound();
}

function routePulls(ctx: RestContext, repo: Repo, tail: string[]): void {
  const { method } = ctx;
  const store = ctx.store;

  // /pulls
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = jsonBody(ctx);
      if (body === null) return;
      const title = strField(body, 'title');
      const head = strField(body, 'head');
      const base = strField(body, 'base');
      if (title === undefined || title === '') throw unprocessable('title is required');
      if (head === undefined || head === '') throw unprocessable('head is required');
      if (base === undefined || base === '') throw unprocessable('base is required');
      const pr = store.createPullRequest(repo, head, base, title, strField(body, 'body') ?? '');
      ok(ctx, 201, pullJson(repo, pr));
      return;
    }
    if (method === 'GET') {
      const stateParam = ctx.search.get('state') ?? 'open';
      const state = stateParam === 'all' ? 'all' : stateParam === 'closed' ? 'closed' : 'open';
      const pulls = store.listPulls(repo, state);
      const { page, link } = paginate(ctx, pulls);
      ok(ctx, 200, page.map((pr) => pullJson(repo, pr)), link === null ? {} : { link });
      return;
    }
    throw new ForgeError(405, 'Method Not Allowed');
  }

  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) throw notFound();
  const pr = store.getPull(repo, number);

  // /pulls/{n}/files
  if (tail.length === 2 && tail[1] === 'files') {
    if (method !== 'GET') throw new ForgeError(405, 'Method Not Allowed');
    if (pr === undefined) throw notFound(`pull request ${number} does not exist`);
    ok(ctx, 200, store.pullRequestFiles(repo, pr));
    return;
  }

  // /pulls/{n}/merge
  if (tail.length === 2 && tail[1] === 'merge') {
    if (method !== 'PUT') throw new ForgeError(405, 'Method Not Allowed');
    if (pr === undefined) throw notFound(`pull request ${number} does not exist`);
    const result = store.mergePullRequest(repo, pr);
    ok(ctx, 200, {
      sha: result.sha,
      merged: true,
      message: `Merge pull request #${number} from ${repo.owner}/${pr.headRef}`,
    });
    return;
  }

  // /pulls/{n}
  if (tail.length === 1) {
    if (method === 'GET') {
      if (pr === undefined) throw notFound(`pull request ${number} does not exist`);
      ok(ctx, 200, pullJson(repo, pr));
      return;
    }
    if (method === 'PATCH') {
      if (pr === undefined) throw notFound(`pull request ${number} does not exist`);
      const body = jsonBody(ctx);
      if (body === null) return;
      const state = strField(body, 'state');
      if (state === 'closed' && !pr.merged) {
        pr.state = 'closed';
        pr.updatedAt = store.nowIso();
      }
      const title = strField(body, 'title');
      if (title !== undefined) pr.title = title;
      const bodyText = strField(body, 'body');
      if (bodyText !== undefined) pr.body = bodyText;
      ok(ctx, 200, pullJson(repo, pr));
      return;
    }
    throw new ForgeError(405, 'Method Not Allowed');
  }

  throw notFound();
}

function routeGitData(ctx: RestContext, repo: Repo, tail: string[]): void {
  const { method } = ctx;
  const store = ctx.store;

  // /git/refs
  if (tail.length === 1 && tail[0] === 'refs') {
    if (method === 'GET') {
      const prefix = ctx.search.get('prefix') ?? '';
      ok(ctx, 200, store.listRefs(repo, prefix).map((r) => ({ ref: r.ref, object: { sha: r.sha } })));
      return;
    }
    if (method === 'POST') {
      const body = jsonBody(ctx);
      if (body === null) return;
      const ref = strField(body, 'ref');
      const sha = strField(body, 'sha');
      if (ref === undefined || ref === '') throw unprocessable('ref is required');
      if (sha === undefined || sha === '') throw unprocessable('sha is required');
      store.createRef(repo, ref, sha);
      ok(ctx, 201, { ref, object: { sha } });
      return;
    }
    throw new ForgeError(405, 'Method Not Allowed');
  }

  // /git/refs/heads/{branch...} or /git/refs/tags/{tag...}
  if (tail.length >= 3 && tail[0] === 'refs' && (tail[1] === 'heads' || tail[1] === 'tags')) {
    const ref = `refs/${tail[1] as string}/${tail.slice(2).join('/')}`;
    if (method === 'GET') {
      const sha = store.refTip(repo, ref);
      if (sha === undefined) throw notFound(`ref ${ref} does not exist`);
      ok(ctx, 200, { ref, object: { sha } });
      return;
    }
    if (method === 'PATCH') {
      const body = jsonBody(ctx);
      if (body === null) return;
      const sha = strField(body, 'sha');
      if (sha === undefined || sha === '') throw unprocessable('sha is required');
      store.updateRef(repo, ref, sha);
      ok(ctx, 200, { ref, object: { sha } });
      return;
    }
    if (method === 'DELETE') {
      if (!store.deleteRef(repo, ref)) throw notFound(`ref ${ref} does not exist`);
      ctx.res.writeHead(204, requestIdHeader(ctx));
      ctx.res.end();
      return;
    }
    throw new ForgeError(405, 'Method Not Allowed');
  }

  // /git/refs/{kind} — list refs under a namespace.
  if (tail.length === 2 && tail[0] === 'refs') {
    if (method !== 'GET') throw new ForgeError(405, 'Method Not Allowed');
    const prefix = `refs/${tail[1] as string}/`;
    ok(ctx, 200, store.listRefs(repo, prefix).map((r) => ({ ref: r.ref, object: { sha: r.sha } })));
    return;
  }

  throw notFound();
}

/** Kept for callers that need a tag's target (used by git routes). */
export function tagTarget(store: Store, tagOid: string): string | null {
  const object = store.lookup(tagOid);
  if (object === undefined || object.type !== 'tag') return null;
  const tag = parseTag(object.data);
  return tag.object;
}
