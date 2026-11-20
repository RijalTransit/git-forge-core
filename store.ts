// The forge's in-memory store and git object model: repositories, their objects and refs, and the
// issue / pull-request records every surface (REST, GraphQL, MCP, git smart HTTP) shares. One
// process, one store, no files: a trial starts empty and the suite seeds everything it checks.

import { createHash } from 'node:crypto';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
}

/** The token owner's identity: the login every trial of this contest uses for its viewer. */
export const VIEWER = {
  login: process.env.MAKEFUN_FORGE_LOGIN ?? 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

export const repos = new Map<string, RepoRec>();
let repoIdSeq = 0;
let globalSeq = 0;
let commentIdSeq = 0;

export function nextSeq(): number {
  globalSeq += 1;
  return globalSeq;
}

export function nextCommentId(): number {
  commentIdSeq += 1;
  return commentIdSeq;
}

export function nowIso(): string {
  return new Date().toISOString();
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(owner: string, name: string): RepoRec | undefined {
  return repos.get(repoKey(owner, name));
}

export function createRepo(owner: string, name: string, description: string, isPrivate: boolean): RepoRec {
  repoIdSeq += 1;
  const repo: RepoRec = {
    id: repoIdSeq,
    owner,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

export function deleteRepo(owner: string, name: string): void {
  repos.delete(repoKey(owner, name));
}

export function listRepos(owner: string): RepoRec[] {
  return [...repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.id - b.id);
}

// --------------------------------------------------------------------------- git objects

export const ZERO_OID = '0'.repeat(40);

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`);
  hash.update(data);
  return hash.digest('hex');
}

export function storeObject(repo: RepoRec, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  const isTree = entry.mode === '40000' || entry.mode === '040000';
  return isTree ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  authorTime: number;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const timeMatch = / (\d+) [+-]\d{4}$/.exec(author);
  return { tree, parents, author, committer, message, authorTime: timeMatch ? Number(timeMatch[1]) : 0 };
}

export function parseTagTarget(data: Buffer): { object: string; type: string } {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line === '') break;
  }
  return { object, type };
}

export function identNow(): string {
  const time = Math.floor(Date.now() / 1000);
  return `${VIEWER.name} <${VIEWER.email}> ${time} +0000`;
}

export function makeCommit(repo: RepoRec, treeOid: string, parents: readonly string[], message: string): string {
  const ident = identNow();
  const lines = [`tree ${treeOid}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`);
  lines.push(`committer ${ident}`);
  const data = Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
  return storeObject(repo, 'commit', data);
}

/** Flatten a tree (recursively) into a path -> {oid, mode} map. */
export function flattenTree(repo: RepoRec, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build (and store) nested trees from a flat path map; returns the root tree oid. */
export function treeFromFlat(repo: RepoRec, flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Node {
    files: { name: string; oid: string; mode: string }[];
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, value] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index] as string;
      if (!node.dirs.has(segment)) node.dirs.set(segment, { files: [], dirs: new Map() });
      node = node.dirs.get(segment) as Node;
    }
    node.files.push({ name: segments[segments.length - 1] as string, oid: value.oid, mode: value.mode });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const file of node.files) entries.push({ mode: file.mode, name: file.name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The tree oid at a commit, or null when the oid is not a commit. */
export function commitTreeOid(repo: RepoRec, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Every object reachable from the tips, following commits, trees and tags. */
export function reachable(repo: RepoRec, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      stack.push(view.tree, ...view.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTagTarget(object.data).object);
    }
  }
  return seen;
}

/** Follow tag objects until a commit (or another type) is reached. */
export function peelToCommit(repo: RepoRec, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTagTarget(object.data).object;
  }
  return current;
}

/** True when `ancestor` is reachable from `descendant` through commit parents. */
export function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object && object.type === 'commit') stack.push(...parseCommit(object.data).parents);
  }
  return false;
}

/** All ancestors of a commit, including itself. */
export function ancestorSet(repo: RepoRec, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object && object.type === 'commit') stack.push(...parseCommit(object.data).parents);
  }
  return seen;
}

/** The best common ancestor of two commits, or null. */
export function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const ancestors = ancestorSet(repo, a);
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestors.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (object && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return null;
}

/** Shortest parent-distance from the tips to every reachable commit (tags peeled first). */
export function commitDistances(repo: RepoRec, tips: readonly string[]): Map<string, number> {
  const distances = new Map<string, number>();
  const queue: string[] = [];
  for (const tip of tips) {
    const commit = peelToCommit(repo, tip);
    if (!distances.has(commit)) {
      distances.set(commit, 0);
      queue.push(commit);
    }
  }
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const distance = distances.get(oid) as number;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!distances.has(parent)) {
        distances.set(parent, distance + 1);
        queue.push(parent);
      }
    }
  }
  return distances;
}

// --------------------------------------------------------------------------- files, diffs, merges

export interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** Line-level add/delete counts between two texts, via a longest-common-subsequence length. */
export function lineChangeCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const rows = oldLines.length;
  const cols = newLines.length;
  if (rows * cols > 4_000_000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  let previous = new Array<number>(cols + 1).fill(0);
  for (let i = 1; i <= rows; i += 1) {
    const current = new Array<number>(cols + 1).fill(0);
    for (let j = 1; j <= cols; j += 1) {
      current[j] = oldLines[i - 1] === newLines[j - 1] ? (previous[j - 1] as number) + 1 : Math.max(previous[j] as number, current[j - 1] as number);
    }
    previous = current;
  }
  const common = previous[cols] as number;
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

function blobText(repo: RepoRec, oid: string | undefined): string {
  if (oid === undefined) return '';
  const object = repo.objects.get(oid);
  return object ? object.data.toString('utf8') : '';
}

/** The file-level diff between two flat path maps. */
export function diffFlat(
  repo: RepoRec,
  before: ReadonlyMap<string, { oid: string; mode: string }>,
  after: ReadonlyMap<string, { oid: string; mode: string }>,
): FileDiff[] {
  const diffs: FileDiff[] = [];
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry && newEntry && oldEntry.oid === newEntry.oid) continue;
    if (oldEntry === undefined && newEntry !== undefined) {
      const lines = blobText(repo, newEntry.oid).split('\n').length;
      diffs.push({ filename: path, status: 'added', additions: Math.max(1, lines), deletions: 0, changes: Math.max(1, lines) });
    } else if (newEntry === undefined && oldEntry !== undefined) {
      const lines = blobText(repo, oldEntry.oid).split('\n').length;
      diffs.push({ filename: path, status: 'removed', additions: 0, deletions: Math.max(1, lines), changes: Math.max(1, lines) });
    } else {
      const counts = lineChangeCounts(blobText(repo, oldEntry?.oid), blobText(repo, newEntry?.oid));
      const additions = Math.max(1, counts.additions);
      const deletions = counts.deletions;
      diffs.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return diffs;
}

/** The diff a pull request shows: merge-base tree against the head tree. */
export function pullDiff(repo: RepoRec, pull: PullRec): FileDiff[] {
  const headOid = repo.refs.get(`refs/heads/${pull.head}`);
  const baseOid = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headOid || !baseOid) return [];
  const base = mergeBase(repo, headOid, baseOid) ?? baseOid;
  const baseTree = commitTreeOid(repo, base);
  const headTree = commitTreeOid(repo, headOid);
  if (!baseTree || !headTree) return [];
  return diffFlat(repo, flattenTree(repo, baseTree), flattenTree(repo, headTree));
}

export interface MergeOutcome {
  ok: boolean;
  treeOid: string | null;
}

/** A three-way tree merge of head into base; conflicts answer ok:false and change nothing. */
export function tryMergeTrees(repo: RepoRec, headOid: string, baseOid: string): MergeOutcome {
  const base = mergeBase(repo, headOid, baseOid);
  if (base === null) return { ok: false, treeOid: null };
  if (isAncestor(repo, headOid, baseOid)) {
    const tree = commitTreeOid(repo, baseOid);
    return { ok: true, treeOid: tree };
  }
  const baseTree = commitTreeOid(repo, base);
  const headTree = commitTreeOid(repo, headOid);
  const targetTree = commitTreeOid(repo, baseOid);
  if (!baseTree || !headTree || !targetTree) return { ok: false, treeOid: null };
  const fromBase = flattenTree(repo, baseTree);
  const fromHead = flattenTree(repo, headTree);
  const fromTarget = flattenTree(repo, targetTree);
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set<string>([...fromBase.keys(), ...fromHead.keys(), ...fromTarget.keys()]);
  for (const path of paths) {
    const baseEntry = fromBase.get(path);
    const headEntry = fromHead.get(path);
    const targetEntry = fromTarget.get(path);
    const headChanged = headEntry?.oid !== baseEntry?.oid;
    const targetChanged = targetEntry?.oid !== baseEntry?.oid;
    if (headChanged && targetChanged && headEntry?.oid !== targetEntry?.oid) return { ok: false, treeOid: null };
    const winner = headChanged ? headEntry : targetEntry;
    if (winner) merged.set(path, winner);
  }
  return { ok: true, treeOid: treeFromFlat(repo, merged) };
}

/** Whether a pull request can merge cleanly right now. */
export function pullMergeable(repo: RepoRec, pull: PullRec): boolean {
  const headOid = repo.refs.get(`refs/heads/${pull.head}`);
  const baseOid = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headOid || !baseOid) return false;
  return tryMergeTrees(repo, headOid, baseOid).ok;
}

/**
 * Merge a pull request into its base branch: a squash commit (or a true merge commit for
 * merge_method=merge) carrying the three-way merged tree. Returns the new commit oid, or null on
 * conflict, in which case nothing changes.
 */
export function mergePull(repo: RepoRec, pull: PullRec, method: string): string | null {
  const headOid = repo.refs.get(`refs/heads/${pull.head}`);
  const baseOid = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headOid || !baseOid) return null;
  const outcome = tryMergeTrees(repo, headOid, baseOid);
  if (!outcome.ok || outcome.treeOid === null) return null;
  let sha: string;
  if (isAncestor(repo, headOid, baseOid)) {
    sha = baseOid;
  } else if (method === 'merge' && !isAncestor(repo, baseOid, headOid)) {
    sha = makeCommit(repo, outcome.treeOid, [baseOid, headOid], `${pull.title}\n\nMerge pull request #${pull.number} from ${pull.head}`);
  } else if (method === 'merge' || method === 'squash' || method === 'rebase') {
    sha = makeCommit(repo, outcome.treeOid, [baseOid], `${pull.title} (#${pull.number})`);
  } else {
    sha = makeCommit(repo, outcome.treeOid, [baseOid], `${pull.title} (#${pull.number})`);
  }
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = sha;
  return sha;
}
