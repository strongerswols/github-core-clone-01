# github-core-clone-01

A standalone GitHub-compatible git forge, built for the make.fun
`github-core-clone-01` bounty. One process, no dependencies, no outside
service, no git binary: every surface is implemented from scratch on the
Node standard library.

## Surfaces (one process, one in-memory store)

- **Git over smart HTTP** — `git-upload-pack` / `git-receive-pack`, protocol
  v0 and v2, pkt-lines, packfiles (full objects; ofs/ref deltas are read,
  never written), shallow clones (`deepen`, `deepen-since`, `deepen-not`),
  annotated tags, fast-forward enforcement, per-ref `ok`/`ng` reports.
- **REST v3** — `/api/v3`: repositories, branches, commits, contents,
  labels, issues, comments, pull requests, squash merges, pagination with
  `Link` headers, `X-GitHub-Request-Id` on every reply.
- **GraphQL v4** — `/api/graphql`: `viewer`, `repository`, `node`,
  `__type` introspection, issue / pull-request connections with cursor
  pagination, and the `createIssue`, `closeIssue`, `createPullRequest`,
  `mergePullRequest`, `addComment` mutations. Batch operations supported.
- **MCP** — `/mcp` (Streamable HTTP, JSON-RPC 2.0): `server/discover`,
  `initialize`, `tools/list`, `tools/call` with `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`, `get_issue`, `list_pull_requests`.

## Determinism

No wall clock and no unseeded randomness anywhere in a request path.
Commit timestamps and `created_at` values come from `MAKEFUN_TRIAL_NOW`
(RFC 3339 or epoch milliseconds); when it is unset a fixed epoch is used.
Object ids, repository ids and issue numbers come from deterministic
counters, so two runs of the same trial leave identical state.

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with the suite at
`$MAKEFUN_ENV_URL/register`, polls `$MAKEFUN_ENV_URL/done` and exits 0.
It never binds 8080 (the suite owns it).

## Layout

- `main.ts` — harness lifecycle (bind, register, poll, exit).
- `app.ts` — HTTP server and router.
- `lib/util.ts` — ids, trial time, ISO dates, JSON helpers.
- `lib/git.ts` — git objects, pkt-lines, packfiles, reachability, fetch sets.
- `lib/store.ts` — the in-memory forge: repos, refs, issues, pull requests.
- `lib/rest.ts` — REST v3 handlers.
- `lib/graphql.ts` — GraphQL parser and executor.
- `lib/mcp.ts` — MCP (JSON-RPC 2.0) handlers and tools.
