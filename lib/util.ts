// Shared helpers: identities, deterministic time, ids, HTTP plumbing.
// Nothing here reads the wall clock: every date the forge emits comes from
// MAKEFUN_TRIAL_NOW (parsed once at startup) or from a timestamp a client
// already put inside a git object.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** The one viewer the trial's fixed scenario seeds (wire.ts buildScenario). */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const VIEWER_IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

/** The token every API call presents, when the trial sets one. */
export const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** Fallback epoch (2025-01-01T00:00:00Z) when MAKEFUN_TRIAL_NOW is unset. */
export const FALLBACK_EPOCH_SEC = 1735689600;

/** Parse MAKEFUN_TRIAL_NOW (RFC 3339 or epoch ms) into epoch seconds. */
export function trialEpochSec(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw === '') return FALLBACK_EPOCH_SEC;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return FALLBACK_EPOCH_SEC;
    // Epoch milliseconds (13 digits) or epoch seconds (10 digits).
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return FALLBACK_EPOCH_SEC;
  return Math.floor(ms / 1000);
}

/** Days from civil date (Howard Hinnant's algorithm); no wall clock involved. */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Civil date from days since epoch (Howard Hinnant's algorithm). */
function civilFromDays(z: number): [number, number, number] {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [m <= 2 ? y + 1 : y, m, d];
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Format epoch seconds as an RFC 3339 UTC instant, e.g. 2025-01-01T00:00:00Z. */
export function isoFromEpochSec(epochSec: number): string {
  const days = Math.floor(epochSec / 86400);
  const secs = epochSec - days * 86400;
  const [y, m, d] = civilFromDays(days);
  const hh = Math.floor(secs / 3600);
  const mm = Math.floor((secs - hh * 3600) / 60);
  const ss = secs - hh * 3600 - mm * 60;
  return `${y}-${pad2(m)}-${pad2(d)}T${pad2(hh)}:${pad2(mm)}:${pad2(ss)}Z`;
}

/** SHA-1 hex of bytes. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Base64url without padding. */
export function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** Decode base64url (or plain base64) to UTF-8; null when undecodable. */
export function b64urlDecode(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** The Bearer token on a request, or null. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match === null ? null : match[1] as string;
}

/** True when the request carries the trial token (or any token when unset). */
export function isAuthenticated(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

/** Read a whole request body. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; returns null when the body is empty or invalid. */
export function parseJsonBody(body: Buffer): unknown {
  const text = body.toString('utf8').trim();
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Send a JSON object with the given status. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

/** Send raw bytes with an explicit content type. */
export function sendBytes(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    ...extraHeaders,
  });
  res.end(body);
}

/** Parse a git identity line "Name <email> 1234567890 +0000". */
export function parseIdentity(line: string): { name: string; email: string; timestamp: number } {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line.trim());
  if (match === null) return { name: line, email: '', timestamp: FALLBACK_EPOCH_SEC };
  return {
    name: (match[1] as string).trim(),
    email: match[2] as string,
    timestamp: Number(match[3]),
  };
}

/** The deterministic per-day offset used by daysFromCivil (kept for tests). */
export function daysFromCivilForTest(y: number, m: number, d: number): number {
  return daysFromCivil(y, m, d);
}
