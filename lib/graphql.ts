// GraphQL v4: a minimal parser and executor for the shapes gh and
// github-mcp-server send (operations, variables, aliases, inline fragments,
// inline input objects, lists, enums). Unknown fields are reported with the
// field named, as the suite requires.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { decodeGlobalId, globalId, type Issue, type PullRequest, type Repo, type Store } from './store.ts';
import { VIEWER, isAuthenticated, sendJson } from './util.ts';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenKind =
  | 'braceL' | 'braceR' | 'parenL' | 'parenR' | 'bracketL' | 'bracketR'
  | 'colon' | 'comma' | 'bang' | 'equals' | 'dollar' | 'spread'
  | 'name' | 'string' | 'int' | 'float';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[_A-Za-z]/.test(c);
  const isNameChar = (c: string): boolean => /[_0-9A-Za-z]/.test(c);
  while (i < input.length) {
    const c = input[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    const single: Record<string, TokenKind> = {
      '{': 'braceL', '}': 'braceR', '(': 'parenL', ')': 'parenR',
      '[': 'bracketL', ']': 'bracketR', ':': 'colon', ',': 'comma',
      '!': 'bang', '=': 'equals', '$': 'dollar',
    };
    if (single[c] !== undefined) {
      tokens.push({ kind: single[c] as TokenKind, value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        const ch = input[j] as string;
        if (ch === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u' && j + 5 < input.length) {
            out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += map[esc] ?? esc;
            j += 2;
          }
        } else {
          out += ch;
          j += 1;
        }
      }
      if (j >= input.length) throw new Error('unterminated string in GraphQL document');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type GqlValue =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly values: readonly GqlValue[] }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, GqlValue>> };

export interface GqlField {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Readonly<Record<string, GqlValue>>;
  readonly selections: readonly GqlSelection[] | null;
}

export interface GqlFragment {
  readonly kind: 'fragment';
  readonly typeCondition: string | null;
  readonly selections: readonly GqlSelection[];
}

export type GqlSelection = GqlField | GqlFragment;

export interface GqlOperation {
  readonly kind: 'query' | 'mutation';
  readonly name: string | null;
  /** Declared variable defaults ($x: Type = default). */
  readonly defaults: Readonly<Record<string, GqlValue>>;
  readonly selections: readonly GqlSelection[];
}

export interface GqlDocument {
  readonly operations: readonly GqlOperation[];
}

class Parser {
  private pos = 0;
  private readonly tokens: readonly Token[];
  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | null {
    return this.tokens[this.pos] ?? null;
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expect(kind: TokenKind, what: string): Token {
    const token = this.next();
    if (token.kind !== kind) throw new Error(`expected ${what} in GraphQL document, got ${token.value}`);
    return token;
  }

  private accept(kind: TokenKind): Token | null {
    const token = this.peek();
    if (token !== null && token.kind === kind) {
      this.pos += 1;
      return token;
    }
    return null;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    while (this.peek() !== null) {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new Error('empty GraphQL document');
    return { operations };
  }

  private parseOperation(): GqlOperation {
    const token = this.peek();
    if (token !== null && token.kind === 'braceL') {
      return { kind: 'query', name: null, defaults: {}, selections: this.parseSelectionSet() };
    }
    const kindToken = this.next();
    if (kindToken.kind !== 'name' || (kindToken.value !== 'query' && kindToken.value !== 'mutation')) {
      throw new Error(`expected query or mutation, got ${kindToken.value}`);
    }
    let name: string | null = null;
    const next = this.peek();
    if (next !== null && next.kind === 'name') {
      name = this.next().value;
    }
    const defaults: Record<string, GqlValue> = {};
    if (this.accept('parenL') !== null) {
      while (this.peek() !== null && this.peek()?.kind !== 'parenR') {
        this.expect('dollar', '$');
        const varName = this.expect('name', 'variable name').value;
        this.expect('colon', ':');
        this.parseType();
        if (this.accept('equals') !== null) defaults[varName] = this.parseValue();
        else defaults[varName] = { kind: 'null' };
      }
      this.expect('parenR', ')');
    }
    return { kind: kindToken.value as 'query' | 'mutation', name, defaults, selections: this.parseSelectionSet() };
  }

  /** Skip a type annotation (Name, [Type], Type!, ...). */
  private parseType(): void {
    if (this.accept('bracketL') !== null) {
      this.parseType();
      this.expect('bracketR', ']');
    } else {
      this.expect('name', 'type name');
    }
    this.accept('bang');
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('braceL', '{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== null && this.peek()?.kind !== 'braceR') {
      selections.push(this.parseSelection());
    }
    this.expect('braceR', '}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    if (this.accept('spread') !== null) {
      let typeCondition: string | null = null;
      const on = this.peek();
      if (on !== null && on.kind === 'name' && on.value === 'on') {
        this.next();
        typeCondition = this.expect('name', 'type condition').value;
      }
      return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
    }
    const first = this.expect('name', 'field name').value;
    let alias: string | null = null;
    let name = first;
    if (this.accept('colon') !== null) {
      alias = first;
      name = this.expect('name', 'field name').value;
    }
    const args: Record<string, GqlValue> = {};
    if (this.accept('parenL') !== null) {
      while (this.peek() !== null && this.peek()?.kind !== 'parenR') {
        const argName = this.expect('name', 'argument name').value;
        this.expect('colon', ':');
        args[argName] = this.parseValue();
      }
      this.expect('parenR', ')');
    }
    let selections: GqlSelection[] | null = null;
    if (this.peek() !== null && this.peek()?.kind === 'braceL') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    switch (token.kind) {
      case 'dollar':
        return { kind: 'variable', name: this.expect('name', 'variable name').value };
      case 'string':
        return { kind: 'string', value: token.value };
      case 'int':
        return { kind: 'int', value: Number(token.value) };
      case 'float':
        return { kind: 'float', value: Number(token.value) };
      case 'bracketL': {
        const values: GqlValue[] = [];
        while (this.peek() !== null && this.peek()?.kind !== 'bracketR') values.push(this.parseValue());
        this.expect('bracketR', ']');
        return { kind: 'list', values };
      }
      case 'braceL': {
        const fields: Record<string, GqlValue> = {};
        while (this.peek() !== null && this.peek()?.kind !== 'braceR') {
          const key = this.expect('name', 'object key').value;
          this.expect('colon', ':');
          fields[key] = this.parseValue();
        }
        this.expect('braceR', '}');
        return { kind: 'object', fields };
      }
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      default:
        throw new Error(`unexpected token ${token.value} in GraphQL value`);
    }
  }
}

/** Parse a GraphQL document string. */
export function parseDocument(query: string): GqlDocument {
  return new Parser(lex(query)).parseDocument();
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

type Source = Record<string, unknown> & { readonly __typename: string };

interface ExecCtx {
  readonly store: Store;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly defaults: Readonly<Record<string, GqlValue>>;
  readonly errors: Array<{ message: string }>;
}

function isSource(value: unknown): value is Source {
  return typeof value === 'object' && value !== null && typeof (value as Source).__typename === 'string';
}

function isNodeType(typename: string): boolean {
  return typename === 'Repository' || typename === 'Issue' || typename === 'PullRequest' || typename === 'IssueComment';
}

/** Resolve a parsed value against the operation's variables and defaults. */
function resolveValue(value: GqlValue, ctx: ExecCtx): unknown {
  switch (value.kind) {
    case 'variable': {
      if (value.name in ctx.variables) return ctx.variables[value.name];
      const fallback = ctx.defaults[value.name];
      return fallback === undefined ? null : resolveValue(fallback, ctx);
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((item) => resolveValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value.fields)) out[key] = resolveValue(item, ctx);
      return out;
    }
  }
}

function resolveArgs(field: GqlField, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = resolveValue(value, ctx);
  return out;
}

// -- source builders ---------------------------------------------------------

function repoSource(repo: Repo): Source {
  return { __typename: 'Repository', repo };
}

function issueSource(repo: Repo, issue: Issue): Source {
  return { __typename: 'Issue', repo, issue };
}

function prSource(repo: Repo, pr: PullRequest): Source {
  return { __typename: 'PullRequest', repo, pr };
}

function userSource(login: string): Source {
  return { __typename: 'User', login };
}

function pageInfoSource(hasNextPage: boolean, startCursor: string | null, endCursor: string | null): Source {
  return {
    __typename: 'PageInfo',
    hasNextPage,
    hasPreviousPage: false,
    startCursor,
    endCursor,
  };
}

function issueCursor(number: number): string {
  return Buffer.from(`issue:${number}`, 'utf8').toString('base64url');
}

function prCursor(number: number): string {
  return Buffer.from(`pr:${number}`, 'utf8').toString('base64url');
}

function fileCursor(path: string): string {
  return Buffer.from(`file:${path}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, prefix: string): string | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith(`${prefix}:`)) return null;
    return text.slice(prefix.length + 1);
  } catch {
    return null;
  }
}

// -- connections -------------------------------------------------------------

function issuesConnection(
  repo: Repo,
  args: Record<string, unknown>,
): Source {
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : 30;
  const after = typeof args.after === 'string' ? args.after : null;
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
  const orderBy = (args.orderBy ?? null) as { field?: unknown; direction?: unknown } | null;
  const direction = orderBy !== null && orderBy.direction === 'DESC' ? 'desc' : 'asc';
  let issues = [...repo.issues.values()];
  if (states !== null && states.length > 0) {
    const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : s === 'CLOSED' ? 'closed' : s.toLowerCase())));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  issues.sort((a, b) => (direction === 'desc' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
  if (after !== null) {
    const afterNumber = decodeCursor(after, 'issue');
    if (afterNumber !== null) {
      const index = issues.findIndex((issue) => issue.number === Number(afterNumber));
      if (index >= 0) issues = issues.slice(index + 1);
    }
  }
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > first;
  const nodes = page.map((issue) => issueSource(repo, issue));
  return {
    __typename: 'IssueConnection',
    nodes,
    pageInfo: pageInfoSource(
      hasNextPage,
      page.length === 0 ? null : issueCursor(page[0]?.number ?? 0),
      page.length === 0 ? null : issueCursor(page[page.length - 1]?.number ?? 0),
    ),
    totalCount: issues.length,
  };
}

function pullRequestsConnection(repo: Repo, args: Record<string, unknown>): Source {
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : 30;
  const after = typeof args.after === 'string' ? args.after : null;
  let pulls = [...repo.pulls.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  if (after !== null) {
    const afterNumber = decodeCursor(after, 'pr');
    if (afterNumber !== null) {
      const index = pulls.findIndex((pr) => pr.number === Number(afterNumber));
      if (index >= 0) pulls = pulls.slice(index + 1);
    }
  }
  const page = pulls.slice(0, first);
  const hasNextPage = pulls.length > first;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pr) => prSource(repo, pr)),
    pageInfo: pageInfoSource(
      hasNextPage,
      page.length === 0 ? null : prCursor(page[0]?.number ?? 0),
      page.length === 0 ? null : prCursor(page[page.length - 1]?.number ?? 0),
    ),
    totalCount: pulls.length,
  };
}

function filesConnection(repo: Repo, pr: PullRequest, args: Record<string, unknown>, store: Store): Source {
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : 30;
  const files = store.pullRequestFiles(repo, pr);
  const page = files.slice(0, first);
  return {
    __typename: 'PullRequestFileConnection',
    nodes: page.map((file) => ({
      __typename: 'PullRequestFile',
      path: file.filename,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      status: file.status,
    })),
    pageInfo: pageInfoSource(
      files.length > first,
      page.length === 0 ? null : fileCursor(page[0]?.filename ?? ''),
      page.length === 0 ? null : fileCursor(page[page.length - 1]?.filename ?? ''),
    ),
    totalCount: files.length,
  };
}

// -- node resolution ---------------------------------------------------------

function nodeFromId(store: Store, id: string): Source | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const repo = store.getRepoById(Number(decoded.parts[0]));
    return repo === undefined ? null : repoSource(repo);
  }
  if (decoded.kind === 'Issue') {
    const repo = store.getRepoById(Number(decoded.parts[0]));
    const issue = repo === undefined ? undefined : repo.issues.get(Number(decoded.parts[1]));
    return repo === undefined || issue === undefined ? null : issueSource(repo, issue);
  }
  if (decoded.kind === 'PullRequest') {
    const repo = store.getRepoById(Number(decoded.parts[0]));
    const pr = repo === undefined ? undefined : repo.pulls.get(Number(decoded.parts[1]));
    return repo === undefined || pr === undefined ? null : prSource(repo, pr);
  }
  if (decoded.kind === 'IssueComment') {
    const repo = store.getRepoById(Number(decoded.parts[0]));
    const issue = repo === undefined ? undefined : repo.issues.get(Number(decoded.parts[1]));
    const comment = issue === undefined ? undefined : issue.comments.find((c) => c.id === Number(decoded.parts[2]));
    if (repo === undefined || issue === undefined || comment === undefined) return null;
    return { __typename: 'IssueComment', repo, issue, comment };
  }
  return null;
}

// -- __type introspection ----------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'comments', 'url'],
  PullRequest: [
    'id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files',
    'title', 'body', 'createdAt', 'updatedAt',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt',
  ],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'LABEL', 'WIKI', 'PROJECT', 'TEAM'],
};

function typeSource(name: string): Source | null {
  const fields = TYPE_FIELDS[name];
  const enums = TYPE_ENUM_VALUES[name];
  if (fields === undefined && enums === undefined) return null;
  return {
    __typename: '__Type',
    name,
    fields: fields === undefined ? null : fields.map((f) => ({ __typename: '__Field', name: f })),
    enumValues: enums === undefined ? null : enums.map((e) => ({ __typename: '__EnumValue', name: e })),
  };
}

// -- resolvers ---------------------------------------------------------------

type Resolver = (source: Source, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userSource(VIEWER.login),
    repository: (_source, args, ctx) => {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      if (owner !== VIEWER.login) return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo === undefined ? null : repoSource(repo);
    },
    node: (_source, args, ctx) => nodeFromId(ctx.store, String(args.id ?? '')),
    __type: (_source, args) => typeSource(String(args.name ?? '')),
  },
  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded === null || decoded.kind !== 'Repository' ? undefined : ctx.store.getRepoById(Number(decoded.parts[0]));
      if (repo === undefined) throw new Error('repository not found');
      const issue = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __typename: 'CreateIssuePayload', issue: issueSource(repo, issue) };
    },
    closeIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      const repo = decoded === null || decoded.kind !== 'Issue' ? undefined : ctx.store.getRepoById(Number(decoded.parts[0]));
      const issue = repo === undefined ? undefined : repo.issues.get(Number(decoded?.parts[1]));
      if (repo === undefined || issue === undefined) throw new Error('issue not found');
      ctx.store.setIssueState(repo, issue.number, 'closed');
      return { __typename: 'CloseIssuePayload', issue: issueSource(repo, issue) };
    },
    createPullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded === null || decoded.kind !== 'Repository' ? undefined : ctx.store.getRepoById(Number(decoded.parts[0]));
      if (repo === undefined) throw new Error('repository not found');
      const pr = ctx.store.createPullRequest(
        repo,
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
        String(input.title ?? ''),
        String(input.body ?? ''),
      );
      return { __typename: 'CreatePullRequestPayload', pullRequest: prSource(repo, pr) };
    },
    mergePullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      const repo = decoded === null || decoded.kind !== 'PullRequest' ? undefined : ctx.store.getRepoById(Number(decoded.parts[0]));
      const pr = repo === undefined ? undefined : repo.pulls.get(Number(decoded?.parts[1]));
      if (repo === undefined || pr === undefined) throw new Error('pull request not found');
      ctx.store.mergePullRequest(repo, pr);
      return { __typename: 'MergePullRequestPayload', pullRequest: prSource(repo, pr) };
    },
    addComment: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      const repo = decoded === null || decoded.kind !== 'Issue' ? undefined : ctx.store.getRepoById(Number(decoded.parts[0]));
      const issue = repo === undefined ? undefined : repo.issues.get(Number(decoded?.parts[1]));
      if (repo === undefined || issue === undefined) throw new Error('issue not found');
      const comment = ctx.store.addComment(repo, issue.number, String(input.body ?? ''));
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', repo, issue, comment },
        },
      };
    },
  },
  Repository: {
    id: (source) => globalId('Repository', (source.repo as Repo).id),
    databaseId: (source) => (source.repo as Repo).id,
    name: (source) => (source.repo as Repo).name,
    nameWithOwner: (source) => `${(source.repo as Repo).owner}/${(source.repo as Repo).name}`,
    owner: (source) => userSource((source.repo as Repo).owner),
    defaultBranchRef: (source) => {
      const repo = source.repo as Repo;
      return repo.refs.has('refs/heads/main') ? { __typename: 'Ref', name: 'main' } : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (source) => (source.repo as Repo).description,
    url: (source) => `https://github.example/${(source.repo as Repo).owner}/${(source.repo as Repo).name}`,
    createdAt: (source) => (source.repo as Repo).createdAt,
    issue: (source, args) => {
      const repo = source.repo as Repo;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : issueSource(repo, issue);
    },
    issues: (source, args) => issuesConnection(source.repo as Repo, args),
    pullRequests: (source, args) => pullRequestsConnection(source.repo as Repo, args),
    pullRequest: (source, args) => {
      const repo = source.repo as Repo;
      const pr = repo.pulls.get(Number(args.number));
      return pr === undefined ? null : prSource(repo, pr);
    },
  },
  Issue: {
    id: (source) => globalId('Issue', (source.repo as Repo).id, (source.issue as Issue).number),
    number: (source) => (source.issue as Issue).number,
    title: (source) => (source.issue as Issue).title,
    state: (source) => ((source.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (source) => (source.issue as Issue).body,
    createdAt: (source) => (source.issue as Issue).createdAt,
    updatedAt: (source) => (source.issue as Issue).updatedAt,
    author: () => userSource(VIEWER.login),
    url: (source) => `https://github.example/${(source.repo as Repo).owner}/${(source.repo as Repo).name}/issues/${(source.issue as Issue).number}`,
    comments: (source) => [],
  },
  PullRequest: {
    id: (source) => globalId('PullRequest', (source.repo as Repo).id, (source.pr as PullRequest).number),
    number: (source) => (source.pr as PullRequest).number,
    headRefName: (source) => (source.pr as PullRequest).headRef,
    baseRefName: (source) => (source.pr as PullRequest).baseRef,
    mergeable: (source, _args, ctx) => ctx.store.mergeableState(source.pr as PullRequest),
    state: (source) => {
      const pr = source.pr as PullRequest;
      if (pr.merged) return 'MERGED';
      return pr.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (source) => (source.pr as PullRequest).merged,
    title: (source) => (source.pr as PullRequest).title,
    body: (source) => (source.pr as PullRequest).body,
    createdAt: (source) => (source.pr as PullRequest).createdAt,
    updatedAt: (source) => (source.pr as PullRequest).updatedAt,
    files: (source, args, ctx) => filesConnection(source.repo as Repo, source.pr as PullRequest, args, ctx.store),
  },
  IssueConnection: {
    nodes: (source) => source.nodes as Source[],
    pageInfo: (source) => source.pageInfo as Source,
    totalCount: (source) => source.totalCount as number,
  },
  PullRequestConnection: {
    nodes: (source) => source.nodes as Source[],
    pageInfo: (source) => source.pageInfo as Source,
    totalCount: (source) => source.totalCount as number,
  },
  PullRequestFileConnection: {
    nodes: (source) => source.nodes as Source[],
    pageInfo: (source) => source.pageInfo as Source,
    totalCount: (source) => source.totalCount as number,
  },
  PageInfo: {
    hasNextPage: (source) => source.hasNextPage as boolean,
    hasPreviousPage: (source) => source.hasPreviousPage as boolean,
    startCursor: (source) => source.startCursor as string | null,
    endCursor: (source) => source.endCursor as string | null,
  },
  User: {
    login: (source) => source.login as string,
    id: () => VIEWER.id,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
  },
  Ref: {
    name: (source) => source.name as string,
  },
  PullRequestFile: {
    path: (source) => source.path as string,
    additions: (source) => source.additions as number,
    deletions: (source) => source.deletions as number,
    changes: (source) => source.changes as number,
    status: (source) => source.status as string,
  },
  CreateIssuePayload: { issue: (source) => source.issue as Source },
  CloseIssuePayload: { issue: (source) => source.issue as Source },
  CreatePullRequestPayload: { pullRequest: (source) => source.pullRequest as Source },
  MergePullRequestPayload: { pullRequest: (source) => source.pullRequest as Source },
  AddCommentPayload: { commentEdge: (source) => source.commentEdge as Source },
  IssueCommentEdge: {
    node: (source) => source.node as Source,
    cursor: () => null,
  },
  IssueComment: {
    id: (source) => globalId('IssueComment', (source.repo as Repo).id, (source.issue as Issue).number, (source.comment as { id: number }).id),
    body: (source) => (source.comment as { body: string }).body,
    createdAt: (source) => (source.comment as { createdAt: string }).createdAt,
    author: () => userSource(VIEWER.login),
  },
  __Type: {
    name: (source) => source.name as string,
    fields: (source) => (source.fields ?? null) as Source[] | null,
    enumValues: (source) => (source.enumValues ?? null) as Source[] | null,
    kind: () => 'OBJECT',
    description: () => null,
  },
  __Field: {
    name: (source) => source.name as string,
    description: () => null,
    args: () => [],
    type: () => null,
  },
  __EnumValue: {
    name: (source) => source.name as string,
    description: () => null,
  },
};

// -- validation --------------------------------------------------------------

const FIELDS: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  Repository: new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt']),
  Issue: new Set(['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'comments', 'url']),
  PullRequest: new Set(['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'createdAt', 'updatedAt']),
  IssueConnection: new Set(['nodes', 'pageInfo', 'totalCount']),
  PullRequestConnection: new Set(['nodes', 'pageInfo', 'totalCount']),
  PullRequestFileConnection: new Set(['nodes', 'pageInfo', 'totalCount']),
  PageInfo: new Set(['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']),
  User: new Set(['login', 'id', 'name', 'email']),
  Ref: new Set(['name']),
  PullRequestFile: new Set(['path', 'additions', 'deletions', 'changes', 'status']),
  CreateIssuePayload: new Set(['issue', 'clientMutationId']),
  CloseIssuePayload: new Set(['issue', 'clientMutationId']),
  CreatePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  MergePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  AddCommentPayload: new Set(['commentEdge', 'clientMutationId']),
  IssueCommentEdge: new Set(['node', 'cursor']),
  IssueComment: new Set(['id', 'body', 'createdAt', 'author']),
  __Type: new Set(['name', 'fields', 'enumValues', 'kind', 'description']),
  __Field: new Set(['name', 'description', 'args', 'type']),
  __EnumValue: new Set(['name', 'description']),
  Node: new Set(['id']),
};

const FIELD_TYPE: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
  Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest' },
  Issue: { author: 'User' },
  PullRequest: { files: 'PullRequestFileConnection' },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
  PullRequestFileConnection: { nodes: 'PullRequestFile', pageInfo: 'PageInfo' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
  IssueComment: { author: 'User' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
};

function validateSelections(selections: readonly GqlSelection[], typename: string, errors: string[]): void {
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      const child = sel.typeCondition ?? typename;
      validateSelections(sel.selections, child, errors);
      continue;
    }
    if (sel.name === '__typename') continue;
    const fields = FIELDS[typename];
    if (fields === undefined || !fields.has(sel.name)) {
      errors.push(`Cannot query field "${sel.name}" on type "${typename}"`);
      continue;
    }
    if (sel.selections !== null) {
      const childType = FIELD_TYPE[typename]?.[sel.name];
      if (childType !== undefined) validateSelections(sel.selections, childType, errors);
    }
  }
}

// -- execution ---------------------------------------------------------------

function resolveField(source: Source, field: GqlField, ctx: ExecCtx): unknown {
  const resolver = RESOLVERS[source.__typename]?.[field.name];
  if (resolver === undefined) {
    throw new Error(`Cannot query field "${field.name}" on type "${source.__typename}"`);
  }
  return resolver(source, resolveArgs(field, ctx), ctx);
}

function executeSelections(
  selections: readonly GqlSelection[],
  source: Source,
  ctx: ExecCtx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition !== null && sel.typeCondition !== source.__typename) {
        if (!(sel.typeCondition === 'Node' && isNodeType(source.__typename))) continue;
      }
      Object.assign(out, executeSelections(sel.selections, source, ctx));
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[key] = source.__typename;
      continue;
    }
    let value: unknown;
    try {
      value = resolveField(source, sel, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : 'field error' });
      out[key] = null;
      continue;
    }
    if (sel.selections !== null && value !== null && value !== undefined) {
      if (Array.isArray(value)) {
        out[key] = value.map((item) => (isSource(item) ? executeSelections(sel.selections as readonly GqlSelection[], item, ctx) : item));
      } else if (isSource(value)) {
        out[key] = executeSelections(sel.selections, value, ctx);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value === undefined ? null : value;
    }
  }
  return out;
}

export interface GqlResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

export function executeOperation(
  operation: GqlOperation,
  variables: Readonly<Record<string, unknown>>,
  store: Store,
): GqlResult {
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const validationErrors: string[] = [];
  validateSelections(operation.selections, rootType, validationErrors);
  if (validationErrors.length > 0) {
    return { data: null, errors: validationErrors.map((message) => ({ message })) };
  }
  const ctx: ExecCtx = { store, variables, defaults: operation.defaults, errors: [] };
  const root: Source = { __typename: rootType };
  const data = executeSelections(operation.selections, root, ctx);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface GraphqlContext {
  readonly store: Store;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly body: Buffer;
}

export function handleGraphQL(ctx: GraphqlContext): boolean {
  if (!isAuthenticated(ctx.req)) {
    sendJson(ctx.res, 401, { message: 'Requires authentication' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    sendJson(ctx.res, 400, { errors: [{ message: 'body is not valid JSON' }] });
    return true;
  }
  const operations = Array.isArray(parsed) ? parsed : [parsed];
  const results: GqlResult[] = operations.map((operation) => {
    if (typeof operation !== 'object' || operation === null || typeof (operation as Record<string, unknown>).query !== 'string') {
      return { data: null, errors: [{ message: 'query is required' }] };
    }
    const record = operation as Record<string, unknown>;
    const variables = (record.variables ?? {}) as Readonly<Record<string, unknown>>;
    try {
      const document = parseDocument(record.query as string);
      let chosen = document.operations[0] as GqlOperation | undefined;
      if (typeof record.operationName === 'string') {
        chosen = document.operations.find((op) => op.name === record.operationName) ?? chosen;
      }
      if (chosen === undefined) return { data: null, errors: [{ message: 'no operation in document' }] };
      return executeOperation(chosen, variables, ctx.store);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
    }
  });
  sendJson(ctx.res, 200, Array.isArray(parsed) ? results : (results[0] as GqlResult));
  return true;
}
