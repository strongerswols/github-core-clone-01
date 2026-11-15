// The forge's in-memory store: repositories, refs, git objects, issues,
// pull requests. Everything the three API surfaces share lives here, so a
// repository created over MCP reads back identically over REST and GraphQL.

import {
  EMPTY_TREE_OID,
  buildCommit,
  buildTag,
  buildTree,
  buildTreeFromFlat,
  commitAncestors,
  flattenTree,
  hashObject,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
} from './git.ts';
import type { GitObject, GitObjectType } from './git.ts';
import { VIEWER, VIEWER_IDENTITY, isoFromEpochSec } from './util.ts';

export interface Label {
  readonly name: string;
  readonly color: string;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly comments: Comment[];
  readonly createdSeq: number;
  readonly createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  headSha: string;
  baseSha: string;
  readonly createdSeq: number;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  /** refname -> tip oid (refs/heads/*, refs/tags/*). */
  readonly refs: Map<string, string>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, PullRequest>;
  readonly labels: Map<string, Label>;
  nextNumber: number;
  readonly createdAt: string;
}

export class ForgeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function notFound(message = 'Not Found'): ForgeError {
  return new ForgeError(404, message);
}

export function unprocessable(message: string): ForgeError {
  return new ForgeError(422, message);
}

export function conflict(message: string): ForgeError {
  return new ForgeError(409, message);
}

/** One changed file in a pull-request diff. */
export interface DiffFile {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

function countLines(content: Buffer): number {
  if (content.length === 0) return 0;
  const text = content.toString('utf8');
  const lines = text.split('\n');
  // A trailing newline does not start a new line.
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** A simple line diff: common prefix/suffix, the rest added/removed. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}

export class Store {
  /** All git objects, content-addressed (shared across repos: oids are global). */
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextIssueId = 6000;
  private nextPrId = 7000;
  private nextCommentId = 8000;
  private sequence = 0;
  /** The trial's fixed "now" (epoch seconds) for commits and created_at. */
  readonly epochSec: number;
  reqCounter = 0;

  constructor(epochSec: number) {
    this.epochSec = epochSec;
    this.objects.set(EMPTY_TREE_OID, { type: 'tree', data: Buffer.alloc(0) });
  }

  nextRequestId(): string {
    this.reqCounter += 1;
    return `req-${this.reqCounter}`;
  }

  nowIso(): string {
    return isoFromEpochSec(this.epochSec);
  }

  // -- objects ---------------------------------------------------------------

  lookup(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putObjects(objects: Iterable<GitObject>): void {
    for (const object of objects) {
      const oid = hashObject(object.type, object.data);
      if (!this.objects.has(oid)) this.objects.set(oid, { type: object.type, data: object.data });
    }
  }

  // -- repos -----------------------------------------------------------------

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) {
      if (repo.id === id) return repo;
    }
    return undefined;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    if (this.repos.has(this.repoKey(owner, name))) {
      throw unprocessable(`name already exists on this account: ${name}`);
    }
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      createdAt: this.nowIso(),
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    return out;
  }

  // -- refs ------------------------------------------------------------------

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Resolve a branch name, a full ref, or a commit oid to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isObjectId(ref)) {
      const object = this.lookup(ref);
      if (object === undefined) return null;
      return peelToCommit(ref, (oid) => this.lookup(oid));
    }
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    const tip = repo.refs.get(full);
    if (tip === undefined) return null;
    return peelToCommit(tip, (oid) => this.lookup(oid));
  }

  createRef(repo: Repo, ref: string, sha: string): void {
    if (!ref.startsWith('refs/')) throw unprocessable(`invalid ref ${ref}`);
    if (repo.refs.has(ref)) throw unprocessable(`a ref named ${ref} already exists`);
    const object = this.lookup(sha);
    if (object === undefined) throw unprocessable(`object ${sha} does not exist`);
    if (ref.startsWith('refs/heads/') && peelToCommit(sha, (oid) => this.lookup(oid)) === null) {
      throw unprocessable(`object ${sha} is not a commit`);
    }
    repo.refs.set(ref, sha);
  }

  updateRef(repo: Repo, ref: string, sha: string): void {
    if (!repo.refs.has(ref)) throw notFound(`ref ${ref} does not exist`);
    const object = this.lookup(sha);
    if (object === undefined) throw unprocessable(`object ${sha} does not exist`);
    if (ref.startsWith('refs/heads/') && peelToCommit(sha, (oid) => this.lookup(oid)) === null) {
      throw unprocessable(`object ${sha} is not a commit`);
    }
    repo.refs.set(ref, sha);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  listRefs(repo: Repo, prefix = ''): Array<{ ref: string; sha: string }> {
    const out: Array<{ ref: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (prefix !== '' && !ref.startsWith(prefix)) continue;
      out.push({ ref, sha });
    }
    out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    return out;
  }

  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** Commits on a ref, newest first. */
  listCommits(repo: Repo, ref: string): string[] {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return [];
    const gens = commitAncestors([tip], (oid) => this.lookup(oid));
    return [...gens.entries()].sort((a, b) => a[1] - b[1]).map(([oid]) => oid);
  }

  // -- contents --------------------------------------------------------------

  private treeAtCommit(commitOid: string): string {
    const object = this.lookup(commitOid);
    if (object === undefined || object.type !== 'commit') return EMPTY_TREE_OID;
    return parseCommit(object.data).tree;
  }

  /** The file at `path` on a ref (or null). */
  getFileAtRef(repo: Repo, ref: string, path: string): { oid: string; data: Buffer } | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return null;
    const flat = flattenTree(this.treeAtCommit(tip), (oid) => this.lookup(oid));
    const entry = flat.get(path);
    if (entry === undefined) return null;
    const object = this.lookup(entry.oid);
    if (object === undefined || object.type !== 'blob') return null;
    return { oid: entry.oid, data: object.data };
  }

  /** Directory entries at `path` on a ref (or null when the path is absent). */
  getDirAtRef(
    repo: Repo,
    ref: string,
    path: string,
  ): Array<{ name: string; path: string; type: 'file' | 'dir'; sha: string; size: number }> | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return null;
    const treeOid = this.treeAtCommit(tip);
    let current = treeOid;
    if (path !== '') {
      const parts = path.split('/');
      let node = treeOid;
      for (const part of parts) {
        const object = this.lookup(node);
        if (object === undefined || object.type !== 'tree') return null;
        const entry = parseTree(object.data).find((e) => e.name === part && e.mode === '40000');
        if (entry === undefined) return null;
        node = entry.oid;
      }
      current = node;
    }
    const object = this.lookup(current);
    if (object === undefined || object.type !== 'tree') return null;
    const out: Array<{ name: string; path: string; type: 'file' | 'dir'; sha: string; size: number }> = [];
    for (const entry of parseTree(object.data)) {
      const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
      if (entry.mode === '40000') {
        out.push({ name: entry.name, path: childPath, type: 'dir', sha: entry.oid, size: 0 });
      } else {
        const blob = this.lookup(entry.oid);
        out.push({
          name: entry.name,
          path: childPath,
          type: 'file',
          sha: entry.oid,
          size: blob === undefined ? 0 : blob.data.length,
        });
      }
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  private makeCommit(
    treeOid: string,
    parents: readonly string[],
    message: string,
  ): { oid: string; data: Buffer } {
    const data = buildCommit({
      tree: treeOid,
      parents,
      message,
      author: VIEWER_IDENTITY,
      committer: VIEWER_IDENTITY,
      timestamp: this.epochSec,
    });
    const oid = this.putObject('commit', data);
    return { oid, data };
  }

  /**
   * Write (or update) a file on a branch, creating the branch from the
   * default tip when it does not exist yet, and the repo's first commit when
   * it is unborn. Returns the commit oid and whether it was a create.
   */
  putContents(
    repo: Repo,
    path: string,
    content: Buffer,
    message: string,
    branch: string | undefined,
    expectedSha: string | undefined,
  ): { commitOid: string; blobOid: string; created: boolean } {
    const branchName = branch ?? repo.defaultBranch;
    const branchRef = `refs/heads/${branchName}`;
    let tip = repo.refs.get(branchRef);
    let baseTree = EMPTY_TREE_OID;
    const parents: string[] = [];
    let created = true;
    if (tip !== undefined) {
      const commitOid = peelToCommit(tip, (oid) => this.lookup(oid));
      if (commitOid === null) throw unprocessable(`branch ${branchName} does not point at a commit`);
      baseTree = this.treeAtCommit(commitOid);
      parents.push(commitOid);
      const flat = flattenTree(baseTree, (oid) => this.lookup(oid));
      const existing = flat.get(path);
      if (existing !== undefined) {
        created = false;
        if (expectedSha !== undefined && expectedSha !== existing.oid) {
          throw conflict(`sha ${expectedSha} does not match the current blob ${existing.oid}`);
        }
      } else if (expectedSha !== undefined) {
        throw notFound(`no file at ${path} to update`);
      }
    } else {
      // The branch does not exist: start from the default branch tip (or
      // from nothing when the repo is unborn).
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip !== undefined && branchName !== repo.defaultBranch) {
        const commitOid = peelToCommit(defaultTip, (oid) => this.lookup(oid));
        if (commitOid !== null) {
          baseTree = this.treeAtCommit(commitOid);
          parents.push(commitOid);
        }
      }
      if (expectedSha !== undefined) throw notFound(`no file at ${path} to update`);
    }
    const blobOid = this.putObject('blob', content);
    const flat = flattenTree(baseTree, (oid) => this.lookup(oid));
    flat.set(path, { oid: blobOid, mode: '100644' });
    const treeOid = buildTreeFromFlat(flat, (type, data) => this.putObject(type, data));
    const commit = this.makeCommit(treeOid, parents, message);
    repo.refs.set(branchRef, commit.oid);
    return { commitOid: commit.oid, blobOid, created };
  }

  /** Delete a file on a branch; returns the new commit oid. */
  deleteContents(
    repo: Repo,
    path: string,
    message: string,
    branch: string | undefined,
    expectedSha: string,
  ): string {
    const branchName = branch ?? repo.defaultBranch;
    const branchRef = `refs/heads/${branchName}`;
    const tip = repo.refs.get(branchRef);
    if (tip === undefined) throw notFound(`branch ${branchName} does not exist`);
    const commitOid = peelToCommit(tip, (oid) => this.lookup(oid));
    if (commitOid === null) throw notFound(`branch ${branchName} does not point at a commit`);
    const baseTree = this.treeAtCommit(commitOid);
    const flat = flattenTree(baseTree, (oid) => this.lookup(oid));
    const existing = flat.get(path);
    if (existing === undefined) throw notFound(`no file at ${path}`);
    if (existing.oid !== expectedSha) {
      throw conflict(`sha ${expectedSha} does not match the current blob ${existing.oid}`);
    }
    flat.delete(path);
    const treeOid = buildTreeFromFlat(flat, (type, data) => this.putObject(type, data));
    const commit = this.makeCommit(treeOid, [commitOid], message);
    repo.refs.set(branchRef, commit.oid);
    return commit.oid;
  }

  // -- labels ----------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string): Label {
    if (repo.labels.has(name)) throw unprocessable(`label ${name} already exists`);
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  // -- issues ----------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue {
    for (const name of labelNames) {
      if (!repo.labels.has(name)) throw unprocessable(`label ${name} does not exist`);
    }
    const now = this.nowIso();
    this.sequence += 1;
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labelNames],
      comments: [],
      createdSeq: this.sequence,
      createdAt: now,
      updatedAt: now,
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.get(number);
  }

  listIssues(
    repo: Repo,
    state: 'open' | 'closed' | 'all',
    direction: 'asc' | 'desc',
  ): Issue[] {
    const out: Issue[] = [];
    for (const issue of repo.issues.values()) {
      if (state !== 'all' && issue.state !== state) continue;
      out.push(issue);
    }
    out.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    return out;
  }

  setIssueState(repo: Repo, number: number, state: 'open' | 'closed'): Issue {
    const issue = repo.issues.get(number);
    if (issue === undefined) throw notFound(`issue ${number} does not exist`);
    issue.state = state;
    issue.updatedAt = this.nowIso();
    return issue;
  }

  addComment(repo: Repo, issueNumber: number, body: string): Comment {
    const issue = repo.issues.get(issueNumber);
    if (issue === undefined) throw notFound(`issue ${issueNumber} does not exist`);
    const comment: Comment = { id: this.nextCommentId, body, createdAt: this.nowIso() };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // -- pull requests ---------------------------------------------------------

  createPullRequest(
    repo: Repo,
    headRef: string,
    baseRef: string,
    title: string,
    body: string,
  ): PullRequest {
    const headTip = repo.refs.get(`refs/heads/${headRef}`);
    if (headTip === undefined) throw unprocessable(`head branch ${headRef} does not exist`);
    const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
    if (baseTip === undefined) throw unprocessable(`base branch ${baseRef} does not exist`);
    const headSha = peelToCommit(headTip, (oid) => this.lookup(oid));
    const baseSha = peelToCommit(baseTip, (oid) => this.lookup(oid));
    if (headSha === null || baseSha === null) throw unprocessable('head or base is not a commit');
    for (const pr of repo.pulls.values()) {
      if (pr.state === 'open' && pr.headRef === headRef && pr.baseRef === baseRef) {
        throw unprocessable(`a pull request from ${headRef} into ${baseRef} is already open`);
      }
    }
    const now = this.nowIso();
    this.sequence += 1;
    const pr: PullRequest = {
      id: this.nextPrId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      createdSeq: this.sequence,
      createdAt: now,
      updatedAt: now,
    };
    this.nextPrId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pr.number, pr);
    return pr;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.get(number);
  }

  listPulls(repo: Repo, state: 'open' | 'closed' | 'all'): PullRequest[] {
    const out: PullRequest[] = [];
    for (const pr of repo.pulls.values()) {
      if (state !== 'all' && pr.state !== state) continue;
      out.push(pr);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  /** Diff between the merge-base tree and the head tree. */
  pullRequestFiles(repo: Repo, pr: PullRequest): DiffFile[] {
    const base = mergeBase(pr.headSha, pr.baseSha, (oid) => this.lookup(oid));
    const baseTree = base === null ? EMPTY_TREE_OID : this.treeAtCommit(base);
    const headTree = this.treeAtCommit(pr.headSha);
    return this.diffTrees(baseTree, headTree);
  }

  /** Diff two trees, as a file list. */
  diffTrees(baseTreeOid: string, headTreeOid: string): DiffFile[] {
    const base = flattenTree(baseTreeOid, (oid) => this.lookup(oid));
    const head = flattenTree(headTreeOid, (oid) => this.lookup(oid));
    const files: DiffFile[] = [];
    const names = new Set<string>([...base.keys(), ...head.keys()]);
    for (const name of names) {
      const b = base.get(name);
      const h = head.get(name);
      if (b === undefined && h !== undefined) {
        const blob = this.lookup(h.oid);
        const additions = blob === undefined ? 0 : countLines(blob.data);
        files.push({ filename: name, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b !== undefined && h === undefined) {
        const blob = this.lookup(b.oid);
        const deletions = blob === undefined ? 0 : countLines(blob.data);
        files.push({ filename: name, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
        const oldBlob = this.lookup(b.oid);
        const newBlob = this.lookup(h.oid);
        const diff = lineDiff(
          oldBlob === undefined ? '' : oldBlob.data.toString('utf8'),
          newBlob === undefined ? '' : newBlob.data.toString('utf8'),
        );
        files.push({
          filename: name,
          status: 'modified',
          additions: diff.additions,
          deletions: diff.deletions,
          changes: diff.additions + diff.deletions,
        });
      }
    }
    files.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
    return files;
  }

  /**
   * The current tip of a pull request's base branch. The base branch may have
   * advanced since the pull request was created (another pull request merged
   * first), so merges and mergeability must read the live ref, never the sha
   * captured at creation time.
   */
  baseTip(pr: PullRequest): string {
    for (const repo of this.repos.values()) {
      if (repo.pulls.get(pr.number) === pr) {
        return repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
      }
    }
    return pr.baseSha;
  }

  /**
   * Three-way merge of the head's changes onto the base branch. Returns the
   * merged tree oid, or null when the head and the base changed the same file
   * in different ways.
   */
  tryMerge(pr: PullRequest): string | null {
    const branchTip = this.baseTip(pr);
    const base = mergeBase(pr.headSha, branchTip, (oid) => this.lookup(oid));
    const baseTree = base === null ? EMPTY_TREE_OID : this.treeAtCommit(base);
    const headTree = this.treeAtCommit(pr.headSha);
    const branchTree = this.treeAtCommit(branchTip);
    const baseFlat = flattenTree(baseTree, (oid) => this.lookup(oid));
    const headFlat = flattenTree(headTree, (oid) => this.lookup(oid));
    const branchFlat = flattenTree(branchTree, (oid) => this.lookup(oid));
    const merged = new Map<string, { oid: string; mode: string }>(branchFlat);
    const names = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
    for (const name of names) {
      const b = baseFlat.get(name);
      const h = headFlat.get(name);
      const t = branchFlat.get(name);
      const headChanged = (b?.oid ?? null) !== (h?.oid ?? null);
      const branchChanged = (b?.oid ?? null) !== (t?.oid ?? null);
      if (!headChanged) continue;
      if (branchChanged && (t?.oid ?? null) !== (h?.oid ?? null)) return null;
      if (h === undefined) merged.delete(name);
      else merged.set(name, h);
    }
    return buildTreeFromFlat(merged, (type, data) => this.putObject(type, data));
  }

  /** MERGEABLE / CONFLICTING / UNKNOWN for a pull request. */
  mergeableState(pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pr.state !== 'open') return 'UNKNOWN';
    const headTip = this.lookup(pr.headSha);
    const baseTip = this.lookup(pr.baseSha);
    if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
    return this.tryMerge(pr) === null ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** Squash-merge a pull request onto its base branch. */
  mergePullRequest(repo: Repo, pr: PullRequest): { sha: string } {
    if (pr.state !== 'open' || pr.merged) {
      throw new ForgeError(405, `pull request #${pr.number} is not open`);
    }
    const mergedTree = this.tryMerge(pr);
    if (mergedTree === null) {
      throw new ForgeError(405, `pull request #${pr.number} has a merge conflict`);
    }
    const message = `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}`;
    const commit = this.makeCommit(mergedTree, [this.baseTip(pr)], message);
    repo.refs.set(`refs/heads/${pr.baseRef}`, commit.oid);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = this.nowIso();
    pr.mergeCommitSha = commit.oid;
    pr.baseSha = commit.oid;
    pr.updatedAt = this.nowIso();
    return { sha: commit.oid };
  }

  // -- git helpers -----------------------------------------------------------

  /** Build a tag object and store it. */
  createTag(object: string, type: GitObjectType, tag: string, message: string): string {
    const data = buildTag({
      object,
      type,
      tag,
      message,
      tagger: VIEWER_IDENTITY,
      timestamp: this.epochSec,
    });
    return this.putObject('tag', data);
  }
}

/** The viewer as a REST/GraphQL user object. */
export function viewerUser(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    name: VIEWER.name,
    email: VIEWER.email,
    type: 'User',
  };
}

/** A repository as a REST object. */
export function repoJson(repo: Repo, host: string): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
  };
}

/** An issue as a REST object. */
export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label === undefined ? 'ededed' : label.color };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

/** A pull request as a REST object. */
export function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    node_id: globalId('PullRequest', repo.id, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
  };
}

/** A comment as a REST object. */
export function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', repo.id, issue.number, comment.id),
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

/** Opaque global id: PREFIX + base64url("Type:parts..."). */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  const prefix = kind === 'Repository' ? 'R_' : kind === 'Issue' ? 'I_' : kind === 'PullRequest' ? 'PR_' : 'C_';
  const text = `${kind}:${parts.join(':')}`;
  return prefix + Buffer.from(text, 'utf8').toString('base64url');
}

/** Decode a global id into {kind, parts} or null. */
export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  const match = /^(R_|I_|PR_|C_)(.+)$/.exec(id);
  if (match === null) return null;
  try {
    const text = Buffer.from(match[2] as string, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

/** The empty tree id, re-exported for route code. */
export { EMPTY_TREE_OID };
