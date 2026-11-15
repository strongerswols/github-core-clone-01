// Git wire protocol: pkt-lines, objects, packfiles, reachability.
// Written from the protocol itself; no git binary, no dependency.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { sha1Hex } from './util.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` + bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function hashObjectHex(type: GitObjectType, data: Buffer): string {
  return hashObject(type, data);
}

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim' | 'end';

export interface Pkt {
  readonly kind: PktKind;
  readonly data: Buffer;
}

/** Encode one pkt-line (data). */
export function pktLine(data: Buffer | string): Buffer {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const total = payload.length + 4;
  const head = Buffer.from(total.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

function isHex4(bytes: Buffer, offset: number): boolean {
  if (offset + 4 > bytes.length) return false;
  for (let i = 0; i < 4; i += 1) {
    const c = bytes[offset + i] as number;
    const hex = (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66);
    if (!hex) return false;
  }
  return true;
}

/**
 * Decode a buffer of pkt-lines. Stops at the first raw (non-framed) tail and
 * reports where it stopped, so a receive-pack body can keep its pack bytes.
 */
export function decodePktLines(bytes: Buffer): { packets: Pkt[]; rawOffset: number } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (!isHex4(bytes, offset)) break;
    const len = parseInt(bytes.subarray(offset, offset + 4).toString('ascii'), 16);
    if (len === 0) {
      packets.push({ kind: 'flush', data: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', data: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end', data: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > bytes.length) break;
    packets.push({ kind: 'data', data: bytes.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, rawOffset: offset };
}

/** The decoded text of every data packet. */
export function packetLines(packets: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.data.toString('utf8'));
  }
  return lines;
}

/** Wrap bytes into sideband band-1 packets (chunked to the 64k pkt-line cap). */
export function sideband(band: number, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const maxChunk = 65515;
  if (data.length === 0) {
    parts.push(pktLine(Buffer.from([band])));
    return Buffer.concat(parts);
  }
  for (let offset = 0; offset < data.length; offset += maxChunk) {
    const chunk = data.subarray(offset, offset + maxChunk);
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}

/** Read sideband packets back into per-band byte streams. */
export function readSideband(packets: readonly Pkt[]): { band1: Buffer; band2: Buffer; band3: Buffer } {
  const b1: Buffer[] = [];
  const b2: Buffer[] = [];
  const b3: Buffer[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data' || packet.data.length === 0) continue;
    const band = packet.data[0] as number;
    const rest = packet.data.subarray(1);
    if (band === 1) b1.push(rest);
    else if (band === 2) b2.push(rest);
    else if (band === 3) b3.push(rest);
  }
  return { band1: Buffer.concat(b1), band2: Buffer.concat(b2), band3: Buffer.concat(b3) };
}

// ---------------------------------------------------------------------------
// trees, commits, tags
// ---------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse a tree object into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > data.length) throw new Error('tree entry has a truncated object id');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, directories as name + '/'. */
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export interface BuildCommitFields {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  readonly author?: string;
  readonly committer?: string;
  readonly timestamp?: number;
  readonly timezone?: string;
}

/** Build a commit object (same layout the suite's client builds). */
export function buildCommit(fields: BuildCommitFields): Buffer {
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const author = fields.author ?? 'Conformance <conformance@make.fun>';
  const committer = fields.committer ?? 'Conformance <conformance@make.fun>';
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${author} ${timestamp} ${timezone}`, `committer ${committer} ${timestamp} ${timezone}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of headerText.split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'object') object = value;
    else if (key === 'type') type = value as GitObjectType;
    else if (key === 'tag') tag = value;
    else if (key === 'tagger') tagger = value;
  }
  return { object, type, tag, tagger, message };
}

export interface BuildTagFields {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly message: string;
  readonly tagger?: string;
  readonly timestamp?: number;
  readonly timezone?: string;
}

/** Build an annotated tag object. */
export function buildTag(fields: BuildTagFields): Buffer {
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const tagger = fields.tagger ?? 'Conformance <conformance@make.fun>';
  const lines = [
    `object ${fields.object}`,
    `type ${fields.type}`,
    `tag ${fields.tag}`,
    `tagger ${tagger} ${timestamp} ${timezone}`,
    '',
  ];
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** The empty tree's id (constant, computed once). */
export const EMPTY_TREE_OID = hashObject('tree', Buffer.alloc(0));

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

function encodePackEntryHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  // First byte: 4 size bits, 3 type bits, continuation bit.
  let byte = (remaining & 0x0f) | (code << 4);
  remaining >>= 4;
  if (remaining > 0) byte |= 0x80;
  bytes.push(byte);
  // Following bytes: 7 size bits each, continuation bit.
  while (remaining > 0) {
    byte = remaining & 0x7f;
    remaining >>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Write a packfile of full objects (no deltas), version 2, SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.alloc(4), Buffer.alloc(4)];
  parts[1]?.writeUInt32BE(2, 0);
  parts[2]?.writeUInt32BE(objects.length, 0);
  for (const object of objects) {
    parts.push(encodePackEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** The 32-byte empty pack (PACK, version 2, count 0, trailer). */
export function emptyPack(): Buffer {
  return writePack([]);
}

interface PackEntry {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

function readVarint(data: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    const byte = data[pos] as number;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    pos += 1;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: pos };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const source = readVarint(delta, offset);
  offset = source.next;
  if (source.value !== base.length) throw new Error('delta source size mismatch');
  const target = readVarint(delta, offset);
  offset = target.next;
  const out: Buffer[] = [];
  let outLen = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          copyOffset |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          copySize |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      outLen += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      outLen += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (outLen !== target.value) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

/**
 * Read a packfile into objects. Handles full objects and ofs/ref deltas.
 * Verifies the SHA-1 trailer when the pack is long enough to carry one.
 */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  if (pack.length >= 32) {
    const trailer = pack.subarray(pack.length - 20);
    const expect = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
    if (!trailer.equals(expect)) throw new Error('pack checksum mismatch');
  }
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let entry: PackEntry;
    if (typeCode === 6) {
      // ofs-delta: the base offset is a negative varint.
      let baseOffset = pack[offset] as number;
      offset += 1;
      while ((baseOffset & 0x80) !== 0) {
        baseOffset = ((baseOffset + 1) << 7) | (pack[offset] as number);
        offset += 1;
      }
      const base = byOffset.get(entryOffset - baseOffset);
      if (base === undefined) throw new Error('ofs-delta base is missing');
      const inflated = inflateAt(pack, offset, size);
      offset += inflated.length;
      const data = applyDelta(base.data, inflated.data);
      entry = { type: base.type, data };
    } else if (typeCode === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const base = objects.get(baseOid);
      if (base === undefined) throw new Error('ref-delta base is missing');
      const inflated = inflateAt(pack, offset, size);
      offset += inflated.length;
      const data = applyDelta(base.data, inflated.data);
      entry = { type: base.type, data };
    } else {
      const type = CODE_TYPE[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateAt(pack, offset, size);
      offset += inflated.length;
      const data = inflated.data;
      if (data.length !== size) throw new Error('pack object size mismatch');
      entry = { type, data };
    }
    const oid = hashObject(entry.type, entry.data);
    objects.set(oid, entry);
    byOffset.set(entryOffset, entry);
  }
  return objects;
}

/**
 * Inflate the zlib stream starting at `offset`; return the data and how many
 * compressed bytes it occupied. Node's inflateSync ignores trailing bytes and
 * throws on a truncated stream, so the stream end is found by binary search.
 * The search is bounded by the expected uncompressed size first (deflate
 * rarely expands data), falling back to the whole remainder.
 */
function inflateAt(pack: Buffer, offset: number, expectedSize: number): { data: Buffer; length: number } {
  const remaining = pack.length - offset;
  const findEnd = (hi: number): number | null => {
    let lo = 1;
    let high = Math.min(hi, remaining);
    while (lo < high) {
      const mid = Math.floor((lo + high) / 2);
      try {
        inflateSync(pack.subarray(offset, offset + mid));
        high = mid;
      } catch {
        lo = mid + 1;
      }
    }
    try {
      inflateSync(pack.subarray(offset, offset + lo));
      return lo;
    } catch {
      return null;
    }
  };
  let length = findEnd(expectedSize + 2048);
  if (length === null) length = findEnd(remaining);
  if (length === null) throw new Error('cannot inflate pack entry');
  return { data: inflateSync(pack.subarray(offset, offset + length)), length };
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** Resolve a want oid to its commit tip (peeling tags). */
export function peelToCommit(oid: string, lookup: ObjectLookup): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = lookup(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** All commit ancestors of `tips` (BFS, newest-generation first). */
export function commitAncestors(
  tips: readonly string[],
  lookup: ObjectLookup,
  stopAt?: ReadonlySet<string>,
  maxGen?: number,
): Map<string, number> {
  const generations = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [];
  for (const tip of tips) {
    const commit = peelToCommit(tip, lookup);
    if (commit === null) continue;
    if (!generations.has(commit)) {
      generations.set(commit, 0);
      queue.push({ oid: commit, gen: 0 });
    }
  }
  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i] as { oid: string; gen: number };
    if (stopAt !== undefined && stopAt.has(item.oid)) continue;
    const object = lookup(item.oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    for (const parent of parents) {
      if (!generations.has(parent)) {
        const gen = item.gen + 1;
        // A depth cap keeps shallow fetches O(depth): generations at or
        // beyond the cap are never sent, so they are never walked.
        if (maxGen !== undefined && gen >= maxGen) continue;
        generations.set(parent, gen);
        queue.push({ oid: parent, gen });
      }
    }
  }
  return generations;
}

/**
 * Is `ancestor` an ancestor of (or equal to) `tip`? Walks from the tip and
 * stops the moment it is found — the fast-forward check on a push usually
 * finds the old tip as the new commit's direct parent, so this is O(1)
 * where a full ancestry walk is O(history).
 */
export function isAncestor(ancestor: string, tip: string, lookup: ObjectLookup): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue: string[] = [tip];
  seen.add(tip);
  for (let i = 0; i < queue.length; i += 1) {
    const oid = queue[i] as string;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/**
 * The object closure of commit tips: commits, their trees, blobs, tags.
 * Follows commit parents (full history reachability).
 */
export function collectReachable(tips: readonly string[], lookup: ObjectLookup): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const queue: string[] = [];
  const seen = new Set<string>();
  const push = (oid: string): void => {
    if (seen.has(oid)) return;
    seen.add(oid);
    queue.push(oid);
  };
  for (const tip of tips) push(tip);
  for (let i = 0; i < queue.length; i += 1) {
    const oid = queue[i] as string;
    const object = lookup(oid);
    if (object === undefined) continue;
    out.set(oid, object);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      push(commit.tree);
      for (const parent of commit.parents) push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) push(entry.oid);
    } else if (object.type === 'tag') {
      push(parseTag(object.data).object);
    }
  }
  return out;
}

/**
 * The object closure of commits for a fetch pack: each commit plus its tree
 * (subtrees and blobs), and tag targets — but NEVER a commit's parents.
 * A fetch sends exactly the commits it selected; their parents arrive only
 * when they are themselves selected (full clones select the whole ancestry).
 */
export function collectTreeClosure(tips: readonly string[], lookup: ObjectLookup): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const queue: string[] = [];
  const seen = new Set<string>();
  const push = (oid: string): void => {
    if (seen.has(oid)) return;
    seen.add(oid);
    queue.push(oid);
  };
  for (const tip of tips) push(tip);
  for (let i = 0; i < queue.length; i += 1) {
    const oid = queue[i] as string;
    const object = lookup(oid);
    if (object === undefined) continue;
    out.set(oid, object);
    if (object.type === 'commit') {
      push(parseCommit(object.data).tree);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) push(entry.oid);
    } else if (object.type === 'tag') {
      push(parseTag(object.data).object);
    }
  }
  return out;
}

/**
 * The object set a fetch must send, per the v2/v0 shallow rules.
 *
 * - `wants` are commit/tag oids; `haves` are commits the client already holds.
 * - `depth` (deepen N) limits generations 0..N-1 from the wants.
 * - `shallowBoundaries` are the client's current shallow oids: have-closure
 *   stops below them, and ones now reachable from the wants are unshallowed.
 */
export interface FetchSet {
  /** Objects to send (commits, trees, blobs, tags). */
  readonly objects: Map<string, GitObject>;
  /** Commits that are shallow boundaries in this response. */
  readonly shallow: string[];
  /** Former shallow boundaries now reachable from the wants. */
  readonly unshallow: string[];
  /** Commit oids sent, in generation order. */
  readonly sentCommits: string[];
}

export function computeFetchSet(
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | null,
  lookup: ObjectLookup,
): FetchSet {
  const shallowSet = new Set(shallowBoundaries);
  // Have-closure: ancestors of the haves, stopping below shallow boundaries.
  const haveCommits = commitAncestors(haves, lookup, shallowSet);
  // Want generations, capped at the requested depth: generations at or
  // beyond it are never sent (and a shallow boundary there is not unshallowed).
  const wantGens = commitAncestors(wants, lookup, undefined, depth ?? undefined);
  const sent: Array<{ oid: string; gen: number }> = [];
  for (const [oid, gen] of wantGens) {
    if (haveCommits.has(oid)) continue;
    if (depth !== null && gen >= depth) continue;
    sent.push({ oid, gen });
  }
  const sentSet = new Set(sent.map((item) => item.oid));
  const haveSet = new Set(haveCommits.keys());
  const shallow: string[] = [];
  for (const item of sent) {
    const object = lookup(item.oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0) continue;
    const atDepthEdge = depth !== null && item.gen === depth - 1;
    const parentMissing = parents.some((p) => !sentSet.has(p) && !haveSet.has(p));
    if (atDepthEdge || parentMissing) shallow.push(item.oid);
  }
  // Unshallow: a requested shallow boundary that is now an ancestor of (or
  // equal to) a want, i.e. inside the fetched history. This needs full
  // reachability, not the depth-capped walk above, so it is checked with the
  // early-exit ancestor test instead of the generation map.
  const unshallow: string[] = [];
  for (const boundary of shallowSet) {
    const inside = wants.some((want) => {
      const commit = peelToCommit(want, lookup);
      return commit !== null && isAncestor(boundary, commit, lookup);
    });
    if (inside) unshallow.push(boundary);
  }
  // The pack carries the tree closure of the sent commits, minus the tree
  // closure of the haves (what the client already holds), plus the tags that
  // point at the wants. Neither closure follows commit parents: only the
  // selected commits travel.
  const reachable = collectTreeClosure(
    sent.map((item) => item.oid),
    lookup,
  );
  const haveReachable = collectTreeClosure([...haveCommits.keys()], lookup);
  for (const oid of haveReachable.keys()) reachable.delete(oid);
  for (const want of wants) {
    const object = lookup(want);
    if (object !== undefined && object.type === 'tag') reachable.set(want, object);
  }
  return {
    objects: reachable,
    shallow,
    unshallow,
    sentCommits: sent.map((item) => item.oid),
  };
}

/** The merge-base of two commits: the first common ancestor by generation. */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  const aGens = commitAncestors([a], lookup);
  const bGens = commitAncestors([b], lookup);
  let best: string | null = null;
  let bestGen = Number.POSITIVE_INFINITY;
  for (const [oid, gen] of aGens) {
    const bGen = bGens.get(oid);
    if (bGen === undefined) continue;
    const total = gen + bGen;
    if (total < bestGen) {
      bestGen = total;
      best = oid;
    }
  }
  return best;
}

/** Flatten a tree to path -> {oid, mode}, following nested trees. */
export function flattenTree(treeOid: string, lookup: ObjectLookup): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = lookup(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build a nested tree object from a flat path map; returns the tree oid. */
export function buildTreeFromFlat(
  flat: ReadonlyMap<string, { oid: string; mode: string }>,
  put: (type: GitObjectType, data: Buffer) => string,
): string {
  interface Node {
    readonly files: Map<string, { oid: string; mode: string }>;
    readonly dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, value] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] as string, value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

/** The empty blob's id. */
export const EMPTY_BLOB_OID = hashObject('blob', Buffer.alloc(0));

/** Exported for tests: SHA-1 hex helper re-export. */
export { sha1Hex };
