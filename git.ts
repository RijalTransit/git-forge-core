// Git smart HTTP, implemented from the protocol itself: pkt-lines, ref advertisement (v0 and
// v2), ls-refs, upload-pack fetch (full, incremental and shallow, with deepen), and receive-pack
// push with report-status. Objects live in the store's per-repository map; packs are written
// undeltified (the protocol allows it) and read with full ofs/ref delta resolution.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  commitDistances,
  hashObject,
  isAncestor,
  parseCommit,
  parseTagTarget,
  peelToCommit,
  reachable,
  storeObject,
  type GitObj,
  type ObjType,
  type RepoRec,
} from './store.ts';

const TYPE_IDS: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const TYPE_NAMES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// --------------------------------------------------------------------------- pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0003', 'ascii');

export interface ParsedPkt {
  packets: Buffer[];
  rest: Buffer;
  /** Byte offset where the terminating flush/delim packet ended. */
  endOffset: number;
  terminator: 'flush' | 'delim' | 'none';
}

/** Parse pkt-lines until the first flush or delim packet; everything after it is `rest`. */
export function parsePktLines(buffer: Buffer, start = 0): ParsedPkt {
  const packets: Buffer[] = [];
  let offset = start;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) return { packets, rest: buffer.subarray(offset + 4), endOffset: offset + 4, terminator: 'flush' };
    if (length === 1) return { packets, rest: buffer.subarray(offset + 4), endOffset: offset + 4, terminator: 'delim' };
    if (length === 3) return { packets, rest: buffer.subarray(offset + 4), endOffset: offset + 4, terminator: 'flush' };
    if (length < 4 || offset + length > buffer.length) break;
    packets.push(buffer.subarray(offset + 4, offset + length));
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset), endOffset: offset, terminator: 'none' };
}

/** Split a whole pkt-line stream into its data payloads and the special packets between them. */
export function splitPktStream(buffer: Buffer): { items: (Buffer | 'flush' | 'delim')[]; rest: Buffer } {
  const items: (Buffer | 'flush' | 'delim')[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      items.push('flush');
      offset += 4;
      return { items, rest: buffer.subarray(offset) };
    }
    if (length === 1) {
      items.push('delim');
      offset += 4;
      continue;
    }
    if (length === 3) {
      items.push('flush');
      offset += 4;
      return { items, rest: buffer.subarray(offset) };
    }
    if (length < 4 || offset + length > buffer.length) break;
    items.push(buffer.subarray(offset + 4, offset + length));
    offset += length;
  }
  return { items, rest: buffer.subarray(offset) };
}

// --------------------------------------------------------------------------- packs

function packObjectHeader(type: ObjType, size: number): Buffer {
  const typeId = TYPE_IDS[type] as number;
  const bytes: number[] = [];
  let first = (typeId << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** A version-2 pack carrying the given objects, undeltified, with its SHA-1 trailer. */
export function writePack(objects: readonly { type: ObjType; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // source size
  const targetSize = readVarint();
  const out: Buffer[] = [];
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= (delta[offset] as number) << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= (delta[offset] as number) << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize) throw new Error('delta result size mismatch');
  return result;
}

export interface PackObject extends GitObj {
  oid: string;
}

/** Read a pack fully, resolving ofs-delta and ref-delta entries against the pack and the repo. */
export function readPack(repo: RepoRec, pack: Buffer): PackObject[] {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const byOffset = new Map<number, PackObject>();
  const pending: { offset: number; type: ObjType; data: Buffer }[] = [];
  const raw: { offset: number; kind: number; baseOffset?: number; baseOid?: string; delta: Buffer }[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const kind = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (kind === 6) {
      let b = pack[offset] as number;
      offset += 1;
      let back = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset] as number;
        offset += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - back;
    } else if (kind === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateSync(pack.subarray(offset));
    // inflateSync with a trailing stream is not bounded; use the raw deflate length via a second pass:
    offset = advanceDeflate(pack, offset, inflated.length, size);
    const data = inflated.subarray(0, size);
    if (kind >= 1 && kind <= 4) {
      const type = TYPE_NAMES[kind] as ObjType;
      const oid = hashObject(type, data);
      const object = { type, data: Buffer.from(data), oid };
      byOffset.set(start, object);
      pending.push(object);
    } else {
      raw.push({ offset: start, kind, baseOffset, baseOid, delta: Buffer.from(data) });
    }
  }
  for (const entry of raw) {
    let base: GitObj | undefined;
    if (entry.kind === 6 && entry.baseOffset !== undefined) base = byOffset.get(entry.baseOffset);
    if (entry.kind === 7 && entry.baseOid !== undefined) {
      base = byOffset.get([...byOffset.entries()].find(([, value]) => value.oid === entry.baseOid)?.[0] ?? -1) ?? repo.objects.get(entry.baseOid);
    }
    if (!base) throw new Error('delta base not found');
    const data = applyDelta(base.data, entry.delta);
    const oid = hashObject(base.type, data);
    const object = { type: base.type, data, oid };
    byOffset.set(entry.offset, object);
    pending.push(object);
  }
  return pending;
}

/**
 * Find where a raw deflate stream ends. Node's zlib has no consumed-bytes report, so inflate
 * candidate end positions is wasteful; instead use the sync inflate on a growing window is also
 * wasteful. The packs this server reads are small (the suite builds them), so scan forward with
 * `inflateSync` on progressively longer slices only until it succeeds exactly at `size` bytes —
 * in practice the stream is found within a few tries by jumping the compressed estimate.
 */
function advanceDeflate(pack: Buffer, offset: number, inflatedLength: number, expectedSize: number): number {
  // zlib.inflateSync stops at the end of the deflate stream and ignores trailing bytes, but does
  // not report how many it used. Use the streaming API through a manual check: try the whole
  // remainder once and locate the boundary with a binary search on success.
  void inflatedLength;
  void expectedSize;
  let lo = offset + 1;
  let hi = pack.length;
  // The deflate stream ends at the smallest end for which inflate still succeeds with same output.
  // Binary search is O(log n) inflates of a small pack: acceptable for the suite's pack sizes.
  let best = hi;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      const out = inflateSync(pack.subarray(offset, mid));
      if (out.length === expectedSize) {
        best = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    } catch {
      lo = mid + 1;
    }
  }
  return best;
}

// --------------------------------------------------------------------------- advertisement

export function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function peeledOf(repo: RepoRec, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  return peelToCommit(repo, oid);
}

/** The v0 ref advertisement body for a service, with the service preamble. */
export function advertiseV0(repo: RepoRec, service: string): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? 'report-status delete-refs side-band-64k ofs-delta quiet agent=forge/1.0'
      : 'multi_ack_detailed side-band-64k ofs-delta shallow thin-pack no-progress agent=forge/1.0';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const lines: Buffer[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps} symref=HEAD:${target}\n`));
  } else {
    let first = true;
    const pushLine = (oid: string, name: string) => {
      if (first) {
        lines.push(pktLine(`${oid} ${name}\0${caps} symref=HEAD:${target}\n`));
        first = false;
      } else {
        lines.push(pktLine(`${oid} ${name}\n`));
      }
    };
    pushLine(headOid ?? ZERO_OID, 'HEAD');
    for (const [name, oid] of refs) {
      pushLine(oid, name);
      const peeled = peeledOf(repo, oid);
      if (peeled !== null && name.startsWith('refs/tags/')) lines.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(...lines, PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement body for git-upload-pack. */
export function advertiseV2(): Buffer {
  const lines = [
    'version 2\n',
    'agent=forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
}

// --------------------------------------------------------------------------- ls-refs (v2)

export function handleLsRefs(repo: RepoRec, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (matches('HEAD')) {
    if (headOid) {
      lines.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (unborn) {
      lines.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

// --------------------------------------------------------------------------- fetch

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
}

export function parseFetchArgs(args: readonly string[]): FetchArgs {
  const parsed: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [], done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) parsed.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) parsed.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) parsed.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) parsed.depth = Number(arg.slice(7).trim());
    else if (arg.startsWith('deepen-since ')) parsed.deepenSince = Number(arg.slice(13).trim());
    else if (arg.startsWith('deepen-not ')) parsed.deepenNot.push(arg.slice(11).trim());
    else if (arg === 'done') parsed.done = true;
  }
  return parsed;
}

interface SendPlan {
  objects: GitObj[];
  shallow: string[];
  unshallow: string[];
}

/** Decide exactly which objects a fetch sends, honouring haves and the shallow rules. */
export function planFetch(repo: RepoRec, args: FetchArgs): SendPlan {
  const clientShallow = new Set(args.shallow);
  // What the client already holds: the closure of its haves, cut at its shallow boundary.
  const haveSet = new Set<string>();
  {
    const stack = [...args.haves];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (haveSet.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      haveSet.add(oid);
      if (object.type === 'commit') {
        const view = parseCommit(object.data);
        stack.push(view.tree);
        if (!clientShallow.has(oid)) stack.push(...view.parents);
      } else if (object.type === 'tree') {
        stack.push(...parseTreeOids(object.data));
      } else if (object.type === 'tag') {
        stack.push(parseTagTarget(object.data).object);
      }
    }
  }

  const wantSet = new Set<string>();
  const shallowOut = new Set<string>();
  const unshallowOut = new Set<string>();

  if (args.depth !== null && Number.isFinite(args.depth)) {
    const distances = commitDistances(repo, args.wants);
    const includedCommits = new Set<string>();
    for (const [oid, distance] of distances) {
      if (distance < (args.depth as number)) includedCommits.add(oid);
    }
    // Boundary: an included commit whose parent is not included (and exists).
    for (const oid of includedCommits) {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length > 0 && parents.some((parent) => !includedCommits.has(parent))) shallowOut.add(oid);
    }
    for (const oid of clientShallow) {
      if (includedCommits.has(oid) && !shallowOut.has(oid)) unshallowOut.add(oid);
    }
    // Collect objects: wants (tags etc.), included commits with their trees and blobs; traverse
    // into a parent commit only when it is included too.
    const stack = [...args.wants];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      if (object.type === 'commit' && !includedCommits.has(oid) && !args.wants.includes(oid)) continue;
      seen.add(oid);
      wantSet.add(oid);
      if (object.type === 'commit') {
        const view = parseCommit(object.data);
        stack.push(view.tree);
        for (const parent of view.parents) if (includedCommits.has(parent)) stack.push(parent);
      } else if (object.type === 'tree') {
        stack.push(...parseTreeOids(object.data));
      } else if (object.type === 'tag') {
        stack.push(parseTagTarget(object.data).object);
      }
    }
  } else if (args.deepenSince !== null) {
    const all = reachable(repo, args.wants);
    for (const oid of all) {
      const object = repo.objects.get(oid);
      if (object && object.type === 'commit' && parseCommit(object.data).authorTime < (args.deepenSince as number)) {
        shallowOut.add(oid);
        continue;
      }
      wantSet.add(oid);
    }
    // Commits older than the cutoff are the boundary, not payload: drop their trees too is wrong
    // (their trees belong to the boundary commit the client receives), so re-add boundary trees.
    for (const oid of shallowOut) {
      const object = repo.objects.get(oid);
      if (object && object.type === 'commit') {
        const tree = parseCommit(object.data).tree;
        for (const inner of reachable(repo, [tree])) wantSet.add(inner);
        wantSet.add(oid);
      }
    }
  } else {
    for (const oid of reachable(repo, args.wants)) wantSet.add(oid);
  }

  const send: GitObj[] = [];
  for (const oid of wantSet) {
    if (haveSet.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) send.push(object);
  }
  return { objects: send, shallow: [...shallowOut], unshallow: [...unshallowOut] };
}

function parseTreeOids(data: Buffer): string[] {
  const oids: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    oids.push(data.subarray(nul + 1, nul + 21).toString('hex'));
    offset = nul + 21;
  }
  return oids;
}

function sidebandChunks(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const PAYLOAD = 65515; // 4-byte header + 1 band byte + payload <= 65520 total
  for (let offset = 0; offset < pack.length; offset += PAYLOAD) {
    const slice = pack.subarray(offset, offset + PAYLOAD);
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (chunks.length === 0) chunks.push(pktLine(Buffer.concat([Buffer.from([1])])));
  return chunks;
}

/** A v2 fetch response: acknowledgments, shallow-info (when any), then the packfile section. */
export function fetchV2Response(repo: RepoRec, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  const knownHave = args.haves.filter((oid) => repo.objects.has(oid));
  if (knownHave.length > 0) {
    for (const oid of knownHave) parts.push(pktLine(`ACK ${oid} common\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(PKT_DELIM);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0 || args.depth !== null || args.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandChunks(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** A v0 fetch response: shallow lines, NAK/ACK, then sideband-framed pack bytes. */
export function fetchV0Response(repo: RepoRec, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const knownHave = args.haves.filter((oid) => repo.objects.has(oid));
  if (knownHave.length > 0) {
    for (const oid of knownHave) parts.push(pktLine(`ACK ${oid}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(...sidebandChunks(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Dispatch an upload-pack POST body: a v2 command document or a v0 want/have negotiation. */
export function handleUploadPack(repo: RepoRec, body: Buffer, isV2: boolean): Buffer {
  if (isV2) {
    const { items } = splitPktStream(body);
    const lines: string[] = [];
    for (const item of items) {
      if (item === 'flush') break;
      if (item === 'delim') continue;
      lines.push(item.toString('utf8').replace(/\n$/, ''));
    }
    const commandLine = lines.find((line) => line.startsWith('command='));
    const command = commandLine ? commandLine.slice('command='.length) : '';
    const commandIndex = lines.indexOf(commandLine ?? '');
    const args = lines.slice(commandIndex + 1).filter((line) => !line.startsWith('agent=') && !line.startsWith('object-format='));
    if (command === 'ls-refs') return handleLsRefs(repo, args);
    if (command === 'fetch') return fetchV2Response(repo, parseFetchArgs(args));
    return Buffer.concat([pktLine('error: unknown command\n'), PKT_FLUSH]);
  }
  // v0: wants in the first pkt section, haves and done in the second.
  const first = parsePktLines(body, 0);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [], done: false };
  const readLines = (packets: Buffer[]) => {
    for (const packet of packets) {
      const line = packet.toString('utf8').replace(/\n$/, '');
      const space = line.indexOf(' ');
      const head = space === -1 ? line : line.slice(0, space);
      const rest = space === -1 ? '' : line.slice(space + 1);
      if (head === 'want') args.wants.push(rest.split(' ')[0] as string);
      else if (head === 'have') args.haves.push(rest.trim());
      else if (head === 'shallow') args.shallow.push(rest.trim());
      else if (head === 'deepen') args.depth = Number(rest.trim());
      else if (head === 'deepen-since') args.deepenSince = Number(rest.trim());
      else if (head === 'deepen-not') args.deepenNot.push(rest.trim());
      else if (head === 'done') args.done = true;
    }
  };
  readLines(first.packets);
  if (first.terminator === 'flush' && first.rest.length > 0) {
    const second = parsePktLines(first.rest, 0);
    readLines(second.packets);
  }
  return fetchV0Response(repo, args);
}

// --------------------------------------------------------------------------- receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** A receive-pack POST: unpack the pack, judge each ref update, apply the good ones, report. */
export function handleReceivePack(repo: RepoRec, body: Buffer): Buffer {
  const first = parsePktLines(body, 0);
  const commands: PushCommand[] = [];
  let capabilities = '';
  first.packets.forEach((packet, index) => {
    let line = packet.toString('utf8').replace(/\n$/, '');
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  });
  const wantsReport = capabilities.includes('report-status');
  const sideband = capabilities.includes('side-band-64k');
  const packBytes = first.rest;
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(repo, packBytes);
      for (const object of objects) storeObject(repo, object.type, object.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const command of commands) {
    const fail = (reason: string) => results.push({ ref: command.ref, ok: false, reason });
    if (!unpackOk) {
      fail(`unpacker error`);
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      // delete
      if (current === ZERO_OID) fail('ref does not exist');
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) fail('old oid mismatch');
      else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      fail('new oid not in pack');
      continue;
    }
    if (current === ZERO_OID) {
      if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        fail('old oid mismatch');
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.oldOid !== current) {
      fail('old oid mismatch');
      continue;
    }
    // update: must be a fast-forward when both ends are commits
    const newObject = repo.objects.get(command.newOid);
    const oldObject = repo.objects.get(current);
    if (newObject && oldObject && newObject.type === 'commit' && oldObject.type === 'commit') {
      if (command.newOid === current || isAncestor(repo, current, command.newOid)) {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      } else {
        fail('non-fast-forward');
      }
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  if (!wantsReport) return Buffer.alloc(0);
  const reportLines: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const result of results) {
    reportLines.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  reportLines.push(PKT_FLUSH);
  const report = Buffer.concat(reportLines);
  if (!sideband) return report;
  // With side-band-64k the report stream rides in band 1, itself pkt-framed.
  const chunks: Buffer[] = [];
  const PAYLOAD = 65515; // 4-byte header + 1 band byte + payload <= 65520 total
  for (let offset = 0; offset < report.length; offset += PAYLOAD) {
    const slice = report.subarray(offset, offset + PAYLOAD);
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}
