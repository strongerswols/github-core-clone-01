// Git smart-HTTP routes: info/refs advertisements, upload-pack (v0/v2),
// receive-pack (v0). The client negotiates v2 for upload-pack and v0 for
// receive-pack; both are answered from the same object store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  commitAncestors,
  computeFetchSet,
  decodePktLines,
  emptyPack,
  isAncestor,
  isObjectId,
  packetLines,
  parseCommit,
  parseTag,
  peelToCommit,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  sideband,
  writePack,
} from './git.ts';
import type { GitObject } from './git.ts';
import { notFound, type Repo, type Store } from './store.ts';
import { VIEWER, sendBytes, sendJson } from './util.ts';

const AGENT = 'github-core-clone-forge/1.0.0';

export interface GitContext {
  readonly store: Store;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly pathname: string;
  readonly search: URLSearchParams;
  readonly body: Buffer;
}

const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';

function json404(ctx: GitContext, message = 'Not Found'): void {
  sendJson(ctx.res, 404, { message });
}

function json400(ctx: GitContext, message: string): void {
  sendJson(ctx.res, 400, { message });
}

function repoFor(ctx: GitContext, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  const repo = ctx.store.getRepo(owner, name);
  return repo === undefined ? null : repo;
}

/** All refs of a repo, HEAD first, then sorted by name. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs: Array<{ name: string; oid: string }> = [];
  for (const [ref, oid] of repo.refs) refs.push({ name: ref, oid });
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/** The commit a tag ultimately points at (or null). */
function peelTag(store: Store, oid: string): string | null {
  return peelToCommit(oid, (id) => store.lookup(id));
}

function uploadPackV0Caps(): string {
  return [
    'side-band-64k',
    'multi_ack',
    'multi_ack_detailed',
    'thin-pack',
    'ofs-delta',
    'shallow',
    `agent=${AGENT}`,
    'symref=HEAD:refs/heads/main',
  ].join(' ');
}

function receivePackV0Caps(): string {
  return ['report-status', 'report-status-v2', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`].join(' ');
}

/** v0 upload-pack advertisement. */
function advertiseUploadV0(store: Store, repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), pktFlush()];
  const caps = uploadPackV0Caps();
  const mainTip = repo.refs.get('refs/heads/main');
  const headOid = mainTip === undefined ? ZERO_OID : peelTag(store, mainTip) ?? mainTip;
  parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
  for (const ref of sortedRefs(repo)) {
    parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
    const object = store.lookup(ref.oid);
    if (object !== undefined && object.type === 'tag') {
      const target = peelTag(store, ref.oid);
      if (target !== null) parts.push(pktLine(`${target} ${ref.name}^{}\n`));
    }
  }
  return Buffer.concat(parts);
}

/** v0 receive-pack advertisement. */
function advertiseReceiveV0(store: Store, repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), pktFlush()];
  parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${receivePackV0Caps()}\n`));
  const mainTip = repo.refs.get('refs/heads/main');
  const headOid = mainTip === undefined ? ZERO_OID : peelTag(store, mainTip) ?? mainTip;
  if (repo.refs.size > 0) parts.push(pktLine(`${headOid} HEAD\n`));
  for (const ref of sortedRefs(repo)) {
    parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
    const object = store.lookup(ref.oid);
    if (object !== undefined && object.type === 'tag') {
      const target = peelTag(store, ref.oid);
      if (target !== null) parts.push(pktLine(`${target} ${ref.name}^{}\n`));
    }
  }
  return Buffer.concat(parts);
}

/** v2 capability advertisement. */
function advertiseV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    pktFlush(),
  ]);
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(lines: readonly string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') args.peel = true;
    else if (text === 'symrefs') args.symrefs = true;
    else if (text === 'unborn') args.unborn = true;
    else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
  }
  return args;
}

function matchesPrefixes(name: string, prefixes: readonly string[]): boolean {
  if (prefixes.length === 0) return true;
  return prefixes.some((prefix) => name.startsWith(prefix));
}

/** Answer a v2 ls-refs request. */
function handleLsRefs(ctx: GitContext, repo: Repo, lines: readonly string[]): void {
  const store = ctx.store;
  const args = parseLsRefsArgs(lines);
  const out: Buffer[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  const headCommit = mainTip === undefined ? null : peelTag(store, mainTip);
  if (matchesPrefixes('HEAD', args.prefixes)) {
    if (headCommit !== null) {
      const symref = args.symrefs ? ' symref-target:refs/heads/main' : '';
      out.push(pktLine(`${headCommit} HEAD${symref}\n`));
    } else if (args.unborn) {
      out.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matchesPrefixes(ref.name, args.prefixes)) continue;
    let suffix = '';
    const object = store.lookup(ref.oid);
    if (args.peel && object !== undefined && object.type === 'tag') {
      const target = peelTag(store, ref.oid);
      if (target !== null) suffix += ` peeled:${target}`;
    }
    out.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
  }
  out.push(pktFlush());
  sendBytes(ctx.res, 200, Buffer.concat(out), UPLOAD_RESULT_CT);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [] };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number(text.slice(7).trim());
      if (Number.isFinite(n)) args.deepen = n;
    } else if (text.startsWith('deepen-since ')) {
      const n = Number(text.slice(13).trim());
      if (Number.isFinite(n)) args.deepenSince = n;
    } else if (text.startsWith('deepen-not ')) {
      args.deepenNot.push(text.slice(11).trim());
    }
  }
  return args;
}

/** The author timestamp of a commit (for deepen-since filtering). */
function commitTimestamp(store: Store, oid: string): number | null {
  const object = store.lookup(oid);
  if (object === undefined || object.type !== 'commit') return null;
  try {
    const author = parseCommit(object.data).author;
    const match = / (\d+) [+-]\d{4}$/.exec(author);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function handleFetchV2(ctx: GitContext, repo: Repo, lines: readonly string[]): void {
  const store = ctx.store;
  const args = parseFetchArgs(lines);
  const lookup = (oid: string): GitObject | undefined => store.lookup(oid);
  // deepen-not refs behave like extra haves.
  const extraHaves: string[] = [];
  for (const ref of args.deepenNot) {
    const tip = store.resolveRef(repo, ref);
    if (tip !== null) extraHaves.push(tip);
  }
  const haves = [...args.haves, ...extraHaves];
  let wants = args.wants;
  if (args.deepenSince !== null) {
    // Only commits at or after the cutoff may be sent.
    const cutoff = args.deepenSince;
    const gens = commitAncestors(wants, lookup);
    const kept = new Set<string>();
    for (const [oid] of gens) {
      const ts = commitTimestamp(store, oid);
      if (ts !== null && ts >= cutoff) kept.add(oid);
    }
    wants = wants.filter((w) => kept.has(w) || peelToCommit(w, lookup) !== null);
    // The fetch set below is computed from the filtered wants; commits older
    // than the cutoff are dropped by the depth-free BFS only when they are
    // not reachable, so re-filter the sent commits by timestamp here.
    const set = computeFetchSet(wants, haves, args.shallow, args.deepen, lookup);
    const filtered = new Map<string, GitObject>();
    for (const [oid, object] of set.objects) {
      if (object.type === 'commit') {
        const ts = commitTimestamp(store, oid);
        if (ts !== null && ts < cutoff) continue;
      }
      filtered.set(oid, object);
    }
    sendFetchResponse(ctx, repo, set, filtered, wants, haves);
    return;
  }
  const set = computeFetchSet(wants, haves, args.shallow, args.deepen, lookup);
  sendFetchResponse(ctx, repo, set, set.objects, wants, haves);
}

function sendFetchResponse(
  ctx: GitContext,
  repo: Repo,
  set: ReturnType<typeof computeFetchSet>,
  objects: Map<string, GitObject>,
  wants: readonly string[],
  haves: readonly string[],
): void {
  const store = ctx.store;
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  const acked = haves.filter((oid) => store.lookup(oid) !== undefined);
  if (acked.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const oid of acked) parts.push(pktLine(`ACK ${oid}\n`));
    parts.push(pktLine('ready\n'));
  }
  parts.push(pktDelim());
  parts.push(pktLine('shallow-info\n'));
  for (const oid of set.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of set.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktDelim());
  parts.push(pktLine('wanted-refs\n'));
  const wantSet = new Set(wants);
  for (const ref of sortedRefs(repo)) {
    if (wantSet.has(ref.oid)) parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
  }
  parts.push(pktDelim());
  parts.push(pktLine('packfile\n'));
  const packObjects = [...objects.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, object]) => object);
  const pack = objects.size === 0 ? emptyPack() : writePack(packObjects);
  parts.push(sideband(1, pack));
  parts.push(pktFlush());
  sendBytes(ctx.res, 200, Buffer.concat(parts), UPLOAD_RESULT_CT);
}

/** Answer a v0 fetch request. */
function handleFetchV0(ctx: GitContext, repo: Repo, lines: readonly string[]): void {
  const store = ctx.store;
  const lookup = (oid: string): GitObject | undefined => store.lookup(oid);
  const args = parseFetchArgs(lines);
  const set = computeFetchSet(args.wants, args.haves, args.shallow, args.deepen, lookup);
  const parts: Buffer[] = [];
  for (const oid of set.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of set.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const acked = args.haves.filter((oid) => store.lookup(oid) !== undefined);
  if (acked.length === 0) parts.push(pktLine('NAK\n'));
  else for (const oid of acked) parts.push(pktLine(`ACK ${oid}\n`));
  const packObjects = [...set.objects.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, object]) => object);
  const pack = set.objects.size === 0 ? emptyPack() : writePack(packObjects);
  parts.push(sideband(1, pack));
  parts.push(pktFlush());
  sendBytes(ctx.res, 200, Buffer.concat(parts), UPLOAD_RESULT_CT);
}

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/** Parse a receive-pack command list; null when the framing is invalid. */
function parsePushCommands(body: Buffer): { commands: PushCommand[]; packOffset: number } | null {
  const { packets, rawOffset } = decodePktLines(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.data.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    line = line.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length !== 3) return null;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) return null;
    commands.push({ oldOid, newOid, ref });
  }
  return { commands, packOffset: rawOffset };
}

function handleReceivePack(ctx: GitContext, repo: Repo): void {
  const store = ctx.store;
  const parsed = parsePushCommands(ctx.body);
  if (parsed === null) {
    json400(ctx, 'malformed receive-pack request');
    return;
  }
  const { commands, packOffset } = parsed;
  const report: string[] = [];
  // Store the pushed objects first: unpack succeeds even when a ref is refused.
  if (packOffset < ctx.body.length) {
    try {
      const objects = readPack(ctx.body.subarray(packOffset));
      store.putObjects(objects.values());
    } catch (err) {
      report.push(`unpack ${err instanceof Error ? err.message : 'pack error'}`);
      const parts = [sideband(1, Buffer.from(`${report.join('')}\n`, 'utf8')), pktFlush()];
      sendBytes(ctx.res, 200, Buffer.concat(parts), RECEIVE_RESULT_CT);
      return;
    }
  }
  report.push('unpack ok');
  const lookup = (oid: string): GitObject | undefined => store.lookup(oid);
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    let reason: string | null = null;
    if (command.newOid === ZERO_OID && command.oldOid === ZERO_OID) {
      reason = 'non-fast-forward';
    } else if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined || current !== command.oldOid) reason = 'non-fast-forward';
    } else if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        reason = 'non-fast-forward';
      } else if (command.ref.startsWith('refs/heads/') && peelToCommit(command.newOid, lookup) === null) {
        reason = 'object is not a commit';
      }
    } else {
      // Update.
      if (current === undefined || current !== command.oldOid) {
        reason = 'non-fast-forward';
      } else if (command.ref.startsWith('refs/heads/') && peelToCommit(command.newOid, lookup) === null) {
        reason = 'object is not a commit';
      } else if (command.oldOid !== command.newOid) {
        if (!isAncestor(command.oldOid, command.newOid, lookup)) reason = 'non-fast-forward';
      }
    }
    if (reason !== null) {
      report.push(`ng ${command.ref} ${reason}`);
      continue;
    }
    if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
    else repo.refs.set(command.ref, command.newOid);
    report.push(`ok ${command.ref}`);
  }
  const parts: Buffer[] = [];
  for (const line of report) parts.push(sideband(1, Buffer.from(`${line}\n`, 'utf8')));
  parts.push(pktFlush());
  sendBytes(ctx.res, 200, Buffer.concat(parts), RECEIVE_RESULT_CT);
}

/** Route one git smart-HTTP request; true when the path was a git route. */
export function handleGit(ctx: GitContext): boolean {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(ctx.pathname);
  if (match === null) return false;
  const owner = decodeURIComponent(match[1] as string);
  const name = decodeURIComponent(match[2] as string);
  const endpoint = match[3] as string;
  {
    const store = ctx.store;
    const repo = repoFor(ctx, owner, name);
    if (repo === null) {
      json404(ctx, `repository ${owner}/${name} does not exist`);
      return true;
    }
    if (endpoint === 'info/refs') {
      if (ctx.method !== 'GET') {
        json400(ctx, 'info/refs takes GET');
        return true;
      }
      const service = ctx.search.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        json400(ctx, 'info/refs needs service=git-upload-pack or git-receive-pack');
        return true;
      }
      const wantsV2 = ctx.req.headers['git-protocol'] === 'version=2';
      if (service === 'git-receive-pack' || !wantsV2) {
        const body = service === 'git-receive-pack' ? advertiseReceiveV0(store, repo) : advertiseUploadV0(store, repo);
        sendBytes(ctx.res, 200, body, service === 'git-receive-pack' ? RECEIVE_AD_CT : UPLOAD_AD_CT);
      } else {
        sendBytes(ctx.res, 200, advertiseV2(), UPLOAD_AD_CT);
      }
      return true;
    }
    if (endpoint === 'git-upload-pack') {
      if (ctx.method !== 'POST') {
        json400(ctx, 'git-upload-pack takes POST');
        return true;
      }
      const wantsV2 = ctx.req.headers['git-protocol'] === 'version=2';
      const { packets } = decodePktLines(ctx.body);
      const lines = packetLines(packets);
      if (lines.length === 0) {
        json400(ctx, 'empty upload-pack request');
        return true;
      }
      const first = (lines[0] as string).replace(/\n$/, '');
      if (wantsV2 && first === 'command=ls-refs') {
        handleLsRefs(ctx, repo, lines.slice(1));
        return true;
      }
      if (wantsV2 && first === 'command=fetch') {
        handleFetchV2(ctx, repo, lines.slice(1));
        return true;
      }
      if (!wantsV2) {
        handleFetchV0(ctx, repo, lines);
        return true;
      }
      json400(ctx, `unknown upload-pack command ${first}`);
      return true;
    }
    // git-receive-pack
    if (ctx.method !== 'POST') {
      json400(ctx, 'git-receive-pack takes POST');
      return true;
    }
    handleReceivePack(ctx, repo);
    return true;
  }
}
