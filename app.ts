// The forge server: one HTTP server routing the REST v3 API, the git smart-HTTP endpoints,
// GraphQL and the MCP endpoint onto the shared in-memory store.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  VIEWER,
  ZERO_OID,
  ancestorSet,
  commitTreeOid,
  createRepo,
  deleteRepo,
  flattenTree,
  getRepo,
  hashObject,
  isAncestor,
  listRepos,
  makeCommit,
  mergePull,
  nextCommentId,
  nextSeq,
  nowIso,
  parseCommit,
  parseTree,
  pullDiff,
  pullMergeable,
  storeObject,
  treeFromFlat,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { advertiseV0, advertiseV2, handleReceivePack, handleUploadPack, sortedRefs } from './git.ts';
import { executeGraphql } from './graphql.ts';
import { issueJson, pullJson, repoJson } from './shapes.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(36)}-${Date.now().toString(36)}`;
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (SHOP_TOKEN === '') return token.length > 0;
  return token === SHOP_TOKEN;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId(),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'x-github-request-id': requestId() });
  res.end(body);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': requestId() });
  res.end();
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

type JsonResult = { ok: true; value: Record<string, unknown> } | { ok: false };

function parseJsonBody(buffer: Buffer): JsonResult {
  if (buffer.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(buffer.toString('utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: true, value: {} };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function validationError(res: ServerResponse, message: string): void {
  sendJson(res, 422, { message });
}

// --------------------------------------------------------------------------- contents helpers

interface FlatEntry {
  oid: string;
  mode: string;
}

function resolveRef(repo: RepoRec, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const branchOid = repo.refs.get(`refs/heads/${ref}`);
  if (branchOid) return branchOid;
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  const tagOid = repo.refs.get(`refs/tags/${ref}`);
  if (tagOid) return tagOid;
  return null;
}

function treeOfCommit(repo: RepoRec, commitOid: string): Map<string, FlatEntry> {
  const treeOid = commitTreeOid(repo, commitOid);
  if (!treeOid) return new Map();
  return flattenTree(repo, treeOid);
}

function dirListing(repo: RepoRec, treeOid: string | null, dirPath: string): { type: string; name: string; path: string; sha: string }[] | null {
  if (treeOid === null) return dirPath === '' ? [] : null;
  let current = treeOid;
  if (dirPath !== '') {
    for (const segment of dirPath.split('/')) {
      const tree = repo.objects.get(current);
      if (!tree || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segment && (candidate.mode === '40000' || candidate.mode === '040000'));
      if (!entry) return null;
      current = entry.oid;
    }
  }
  const tree = repo.objects.get(current);
  if (!tree || tree.type !== 'tree') return null;
  return parseTree(tree.data).map((entry) => ({
    type: entry.mode === '40000' || entry.mode === '040000' ? 'dir' : 'file',
    name: entry.name,
    path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
    sha: entry.oid,
  }));
}

// --------------------------------------------------------------------------- REST

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, segments: string[]): Promise<void> {
  const method = req.method ?? 'GET';
  const bodyBuffer = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const jsonBody = (): JsonResult => parseJsonBody(bodyBuffer);

  // Root + meta + viewer
  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          issue_search_url: '/api/v3/search/issues',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    notFound(res);
    return;
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    sendJson(res, 200, { installed_version: '1.0.0-forge', verifiable_password_authentication: false });
    return;
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
      return;
    }
    notFound(res);
    return;
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'POST') {
      const parsed = jsonBody();
      if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const name = String(parsed.value.name ?? '');
      if (name === '') return validationError(res, 'name is required');
      if (getRepo(VIEWER.login, name)) return validationError(res, `A repository named ${name} already exists for ${VIEWER.login}`);
      const repo = createRepo(
        VIEWER.login,
        name,
        typeof parsed.value.description === 'string' ? parsed.value.description : '',
        parsed.value.private === true,
      );
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const perPage = Math.max(1, Number(url.searchParams.get('per_page') ?? '30') || 30);
      const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
      const all = listRepos(VIEWER.login);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      if (page * perPage < all.length) {
        const next = new URL(url.pathname + url.search, `http://${req.headers.host ?? 'forge.local'}`);
        next.searchParams.set('page', String(page + 1));
        next.searchParams.set('per_page', String(perPage));
        headers.link = `<${next.toString()}>; rel="next"`;
      }
      sendJson(res, 200, slice.map((repo) => repoJson(repo)), headers);
      return;
    }
    notFound(res);
    return;
  }

  if (segments[0] !== 'repos' || segments.length < 3) {
    notFound(res);
    return;
  }
  const owner = segments[1] as string;
  const repoName = segments[2] as string;
  const rest = segments.slice(3);
  const repo = getRepo(owner, repoName);

  // Repository itself
  if (rest.length === 0) {
    if (!repo) return notFound(res);
    if (method === 'GET') return sendJson(res, 200, repoJson(repo));
    if (method === 'PATCH') {
      const parsed = jsonBody();
      if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.name === 'string' && parsed.value.name !== '') repo.name = parsed.value.name;
      if (typeof parsed.value.private === 'boolean') repo.isPrivate = parsed.value.private;
      if (typeof parsed.value.default_branch === 'string') repo.defaultBranch = parsed.value.default_branch;
      return sendJson(res, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      deleteRepo(owner, repoName);
      return sendEmpty(res, 204);
    }
    return notFound(res);
  }
  if (!repo) return notFound(res);

  // Branches and refs
  if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
    const branches = sortedRefs(repo)
      .filter(([name]) => name.startsWith('refs/heads/'))
      .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }));
    return sendJson(res, 200, branches);
  }
  if (rest[0] === 'branches' && rest.length === 2 && method === 'GET') {
    const branch = decodeURIComponent(rest[1] as string);
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (!oid) return notFound(res);
    return sendJson(res, 200, { name: branch, commit: { sha: oid }, protected: false });
  }
  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && method === 'POST') {
    const parsed = jsonBody();
    if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
    const ref = String(parsed.value.ref ?? '');
    const sha = String(parsed.value.sha ?? '');
    if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return validationError(res, 'invalid ref or sha');
    repo.refs.set(ref, sha);
    return sendJson(res, 201, { ref, node_id: ref, object: { sha, type: 'commit' } });
  }
  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length >= 3 && method === 'GET') {
    const refName = `refs/${rest.slice(2).map((s) => decodeURIComponent(s)).join('/')}`;
    const oid = repo.refs.get(refName);
    if (!oid) return notFound(res);
    return sendJson(res, 200, { ref: refName, node_id: refName, object: { sha: oid, type: 'commit' } });
  }

  // Commits list
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const shaParam = url.searchParams.get('sha');
    const tip = shaParam ? resolveRef(repo, shaParam) : (repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null);
    if (!tip) return sendJson(res, 200, []);
    const tipCommit = repo.objects.get(tip)?.type === 'commit' ? tip : null;
    if (!tipCommit) return sendJson(res, 200, []);
    // Newest-first ancestry walk: BFS by depth, then by author time descending.
    const distances = new Map<string, number>();
    const queue: [string, number][] = [[tipCommit, 0]];
    while (queue.length > 0) {
      const [oid, depth] = queue.shift() as [string, number];
      if (distances.has(oid)) continue;
      distances.set(oid, depth);
      const object = repo.objects.get(oid);
      if (object && object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push([parent, depth + 1]);
      }
    }
    const commits = [...distances.entries()]
      .map(([oid, depth]) => ({ oid, depth, view: parseCommit((repo.objects.get(oid) as { data: Buffer }).data) }))
      .sort((a, b) => a.depth - b.depth || b.view.authorTime - a.view.authorTime)
      .map(({ oid, view }) => ({
        sha: oid,
        node_id: oid,
        commit: {
          message: view.message,
          tree: { sha: view.tree },
          author: { name: VIEWER.name, email: VIEWER.email, date: new Date(view.authorTime * 1000).toISOString() },
          committer: { name: VIEWER.name, email: VIEWER.email, date: new Date(view.authorTime * 1000).toISOString() },
        },
        parents: view.parents.map((parent) => ({ sha: parent })),
      }));
    return sendJson(res, 200, commits);
  }

  // Contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
    if (method === 'GET') {
      const refParam = url.searchParams.get('ref') ?? undefined;
      const commitOid = resolveRef(repo, refParam);
      if (path === '') {
        const treeOid = commitOid ? commitTreeOid(repo, commitOid) : null;
        const listing = dirListing(repo, treeOid, '');
        return sendJson(res, 200, (listing ?? []).map((entry) => ({ ...entry, size: 0 })));
      }
      const flat = commitOid ? treeOfCommit(repo, commitOid) : new Map<string, FlatEntry>();
      const file = flat.get(path);
      if (file) {
        const blob = repo.objects.get(file.oid);
        const content = blob ? blob.data : Buffer.alloc(0);
        return sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          content: content.toString('base64'),
          sha: file.oid,
          name: path.split('/').pop(),
          path,
          size: content.length,
        });
      }
      const treeOid = commitOid ? commitTreeOid(repo, commitOid) : null;
      const listing = dirListing(repo, treeOid, path);
      if (listing !== null) return sendJson(res, 200, listing.map((entry) => ({ ...entry, size: 0 })));
      return notFound(res);
    }
    if (method === 'PUT') {
      const parsed = jsonBody();
      if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const message = String(parsed.value.message ?? '');
      const contentBase64 = String(parsed.value.content ?? '');
      const branch = typeof parsed.value.branch === 'string' && parsed.value.branch !== '' ? parsed.value.branch : repo.defaultBranch;
      const content = Buffer.from(contentBase64, 'base64');
      const blobOid = storeObject(repo, 'blob', content);
      const branchRef = `refs/heads/${branch}`;
      const tip = repo.refs.get(branchRef) ?? null;
      const flat = tip ? treeOfCommit(repo, tip) : new Map<string, FlatEntry>();
      const existing = flat.get(path);
      if (existing) {
        const givenSha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
        if (givenSha !== undefined && givenSha !== existing.oid) {
          return sendJson(res, 409, { message: `${path} has changed since it was read; supply the current sha` });
        }
      }
      flat.set(path, { oid: blobOid, mode: '100644' });
      const treeOid = treeFromFlat(repo, flat);
      const commitOid = makeCommit(repo, treeOid, tip ? [tip] : [], message);
      repo.refs.set(branchRef, commitOid);
      return sendJson(res, existing ? 200 : 201, {
        content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
        commit: { sha: commitOid, message },
      });
    }
    if (method === 'DELETE') {
      const parsed = jsonBody();
      if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const message = String(parsed.value.message ?? '');
      const branch = typeof parsed.value.branch === 'string' && parsed.value.branch !== '' ? parsed.value.branch : repo.defaultBranch;
      const branchRef = `refs/heads/${branch}`;
      const tip = repo.refs.get(branchRef) ?? null;
      if (!tip) return notFound(res);
      const flat = treeOfCommit(repo, tip);
      const existing = flat.get(path);
      if (!existing) return notFound(res);
      const givenSha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
      if (givenSha !== undefined && givenSha !== existing.oid) {
        return sendJson(res, 409, { message: `${path} has changed since it was read` });
      }
      flat.delete(path);
      const treeOid = treeFromFlat(repo, flat);
      const commitOid = makeCommit(repo, treeOid, [tip], message);
      repo.refs.set(branchRef, commitOid);
      return sendJson(res, 200, { content: null, commit: { sha: commitOid, message } });
    }
    return notFound(res);
  }

  // Labels
  if (rest[0] === 'labels' && rest.length === 1) {
    if (method === 'POST') {
      const parsed = jsonBody();
      if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const name = String(parsed.value.name ?? '');
      if (name === '') return validationError(res, 'name is required');
      const label = {
        name,
        color: typeof parsed.value.color === 'string' ? parsed.value.color.replace(/^#/, '') : '000000',
        description: typeof parsed.value.description === 'string' ? parsed.value.description : null,
      };
      repo.labels.set(name, label);
      return sendJson(res, 201, { id: repo.labels.size, node_id: `L${name}`, ...label, default: false });
    }
    if (method === 'GET') {
      return sendJson(res, 200, [...repo.labels.values()].map((label) => ({ ...label, default: false })));
    }
    return notFound(res);
  }

  // Issues
  if (rest[0] === 'issues' && rest.length === 1) {
    if (method === 'POST') {
      const parsed = jsonBody();
      if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const title = String(parsed.value.title ?? '');
      if (title === '') return validationError(res, 'title is required');
      const labelNames: string[] = [];
      if (Array.isArray(parsed.value.labels)) {
        for (const entry of parsed.value.labels) {
          const labelName = typeof entry === 'string' ? entry : String((entry as { name?: unknown }).name ?? '');
          if (!repo.labels.has(labelName)) return validationError(res, `label not found: ${labelName}`);
          labelNames.push(labelName);
        }
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: IssueRec = {
        number,
        title,
        body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
        state: 'open',
        labels: labelNames,
        comments: [],
        seq: nextSeq(),
      };
      repo.issues.set(number, issue);
      return sendJson(res, 201, issueJson(repo, issue));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      const perPage = Math.max(1, Number(url.searchParams.get('per_page') ?? '30') || 30);
      const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
      let items = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') items = items.filter((issue) => issue.state === state);
      void sort;
      items.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const slice = items.slice((page - 1) * perPage, page * perPage);
      return sendJson(res, 200, slice.map((issue) => issueJson(repo, issue)));
    }
    return notFound(res);
  }
  if (rest[0] === 'issues' && rest.length >= 2) {
    const number = Number(rest[1]);
    const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    if (rest.length === 2) {
      if (!issue) return notFound(res);
      if (method === 'GET') return sendJson(res, 200, issueJson(repo, issue));
      if (method === 'PATCH') {
        const parsed = jsonBody();
        if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
        if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
        if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
        if (parsed.value.state === 'open' || parsed.value.state === 'closed') issue.state = parsed.value.state;
        if (Array.isArray(parsed.value.labels)) {
          const names: string[] = [];
          for (const entry of parsed.value.labels) {
            const labelName = typeof entry === 'string' ? entry : String((entry as { name?: unknown }).name ?? '');
            if (!repo.labels.has(labelName)) return validationError(res, `label not found: ${labelName}`);
            names.push(labelName);
          }
          issue.labels = names;
        }
        return sendJson(res, 200, issueJson(repo, issue));
      }
      return notFound(res);
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (!issue) return notFound(res);
      if (method === 'POST') {
        const parsed = jsonBody();
        if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
        const comment = { id: nextCommentId(), body: String(parsed.value.body ?? ''), seq: nextSeq() };
        issue.comments.push(comment);
        return sendJson(res, 201, {
          id: comment.id,
          node_id: `C${comment.id}`,
          body: comment.body,
          user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
          created_at: nowIso(),
          updated_at: nowIso(),
        });
      }
      if (method === 'GET') {
        return sendJson(
          res,
          200,
          issue.comments.map((comment) => ({
            id: comment.id,
            node_id: `C${comment.id}`,
            body: comment.body,
            user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
            created_at: nowIso(),
            updated_at: nowIso(),
          })),
        );
      }
      return notFound(res);
    }
    return notFound(res);
  }

  // Pull requests
  if (rest[0] === 'pulls' && rest.length === 1) {
    if (method === 'POST') {
      const parsed = jsonBody();
      if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const head = String(parsed.value.head ?? '');
      const base = String(parsed.value.base ?? '');
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        return validationError(res, 'head or base branch not found');
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: PullRec = {
        number,
        title: String(parsed.value.title ?? ''),
        body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
        head,
        base,
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq: nextSeq(),
      };
      repo.pulls.set(number, pull);
      return sendJson(res, 201, pullJson(repo, pull));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let items = [...repo.pulls.values()];
      if (state === 'open') items = items.filter((pull) => pull.state === 'open');
      else if (state === 'closed') items = items.filter((pull) => pull.state === 'closed');
      items.sort((a, b) => a.seq - b.seq);
      return sendJson(res, 200, items.map((pull) => pullJson(repo, pull)));
    }
    return notFound(res);
  }
  if (rest[0] === 'pulls' && rest.length >= 2) {
    const number = Number(rest[1]);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (rest.length === 2) {
      if (!pull) return notFound(res);
      if (method === 'GET') return sendJson(res, 200, pullJson(repo, pull));
      if (method === 'PATCH') {
        const parsed = jsonBody();
        if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
        if (typeof parsed.value.title === 'string') pull.title = parsed.value.title;
        if (typeof parsed.value.body === 'string') pull.body = parsed.value.body;
        if (parsed.value.state === 'open' || parsed.value.state === 'closed') pull.state = parsed.value.state;
        return sendJson(res, 200, pullJson(repo, pull));
      }
      return notFound(res);
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (!pull) return notFound(res);
      const diffs = pullDiff(repo, pull);
      return sendJson(
        res,
        200,
        diffs.map((diff) => ({
          filename: diff.filename,
          status: diff.status,
          additions: diff.additions,
          deletions: diff.deletions,
          changes: diff.changes,
          sha: '',
        })),
      );
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (!pull) return notFound(res);
      const parsed = jsonBody();
      if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const mergeMethod = typeof parsed.value.merge_method === 'string' ? parsed.value.merge_method : 'merge';
      if (pull.state !== 'open') return sendJson(res, 405, { message: 'Pull request is not open' });
      if (!pullMergeable(repo, pull)) return sendJson(res, 405, { message: 'Pull request is not mergeable: conflicts must be resolved first' });
      const sha = mergePull(repo, pull, mergeMethod);
      if (sha === null) return sendJson(res, 405, { message: 'Pull request is not mergeable' });
      return sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    }
    return notFound(res);
  }

  return notFound(res);
}

// --------------------------------------------------------------------------- git smart HTTP

async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL, owner: string, repoGitName: string): Promise<void> {
  const repoName = repoGitName.replace(/\.git$/, '');
  const repo = getRepo(owner, repoName);
  const tail = url.pathname.split('/').slice(3).join('/');
  const method = req.method ?? 'GET';
  if (tail === 'info/refs' && method === 'GET') {
    if (!repo) return notFound(res);
    const service = url.searchParams.get('service') ?? '';
    if (service === 'git-upload-pack') {
      const protocol = req.headers['git-protocol'];
      if (typeof protocol === 'string' && protocol.includes('version=2')) {
        return sendBuffer(res, 200, advertiseV2(), 'application/x-git-upload-pack-advertisement');
      }
      return sendBuffer(res, 200, advertiseV0(repo, service), 'application/x-git-upload-pack-advertisement');
    }
    if (service === 'git-receive-pack') {
      return sendBuffer(res, 200, advertiseV0(repo, service), 'application/x-git-receive-pack-advertisement');
    }
    return notFound(res);
  }
  if (tail === 'git-upload-pack' && method === 'POST') {
    const body = await readBody(req);
    if (!repo) return notFound(res);
    const protocol = req.headers['git-protocol'];
    const isV2 = typeof protocol === 'string' && protocol.includes('version=2');
    try {
      const out = handleUploadPack(repo, body, isV2);
      return sendBuffer(res, 200, out, 'application/x-git-upload-pack-result');
    } catch {
      return sendBuffer(res, 200, Buffer.from('0000', 'ascii'), 'application/x-git-upload-pack-result');
    }
  }
  if (tail === 'git-receive-pack' && method === 'POST') {
    const body = await readBody(req);
    if (!repo) return notFound(res);
    try {
      const out = handleReceivePack(repo, body);
      return sendBuffer(res, 200, out, 'application/x-git-receive-pack-result');
    } catch {
      return sendBuffer(res, 200, Buffer.alloc(0), 'application/x-git-receive-pack-result');
    }
  }
  return notFound(res);
}

// --------------------------------------------------------------------------- MCP

const MCP_TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Filter by state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch' },
        base: { type: 'string', description: 'Base branch' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value as Record<string, unknown> };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(name: string, args: Record<string, unknown>): { result?: Record<string, unknown>; rpcError?: { code: number; message: string } } {
  const owner = String(args.owner ?? VIEWER.login);
  const repoName = String(args.repo ?? '');
  switch (name) {
    case 'create_repo': {
      const repoItemName = String(args.name ?? '');
      if (repoItemName === '') return { result: toolError('name is required') };
      const existing = getRepo(VIEWER.login, repoItemName);
      if (existing) return { result: toolResult(repoJson(existing)) };
      const repo = createRepo(VIEWER.login, repoItemName, typeof args.description === 'string' ? args.description : '', args.private === true);
      return { result: toolResult(repoJson(repo)) };
    }
    case 'get_repo': {
      const repo = getRepo(owner, repoName);
      if (!repo) return { result: toolError('repository not found') };
      return { result: toolResult(repoJson(repo)) };
    }
    case 'create_issue': {
      const repo = getRepo(owner, repoName);
      if (!repo) return { result: toolError('repository not found') };
      const title = String(args.title ?? '');
      if (title === '') return { result: toolError('title is required') };
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: IssueRec = {
        number,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        seq: nextSeq(),
      };
      repo.issues.set(number, issue);
      return { result: toolResult(issueJson(repo, issue)) };
    }
    case 'list_issues': {
      const repo = getRepo(owner, repoName);
      if (!repo) return { result: toolError('repository not found') };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let items = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') items = items.filter((issue) => issue.state === state);
      items.sort((a, b) => a.seq - b.seq);
      return { result: toolResult(items.map((issue) => issueJson(repo, issue))) };
    }
    case 'create_pull_request': {
      const repo = getRepo(owner, repoName);
      if (!repo) return { result: toolError('repository not found') };
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      const title = String(args.title ?? '');
      if (title === '' || head === '' || base === '') return { result: toolError('title, head and base are required') };
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: PullRec = {
        number,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        head,
        base,
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq: nextSeq(),
      };
      repo.pulls.set(number, pull);
      return { result: toolResult(pullJson(repo, pull)) };
    }
    case 'merge_pull_request': {
      const repo = getRepo(owner, repoName);
      if (!repo) return { result: toolError('repository not found') };
      const pullNumber = Number(args.pull_number);
      const pull = Number.isInteger(pullNumber) ? repo.pulls.get(pullNumber) : undefined;
      if (!pull) return { result: toolError('pull request not found') };
      if (pull.state !== 'open' || !pullMergeable(repo, pull)) return { result: toolError('pull request is not mergeable') };
      const sha = mergePull(repo, pull, 'squash');
      if (sha === null) return { result: toolError('pull request is not mergeable') };
      return { result: toolResult(pullJson(repo, pull)) };
    }
    default:
      return { rpcError: { code: -32602, message: `unknown tool: ${name}` } };
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const handleOne = (message: Record<string, unknown>): Record<string, unknown> | null => {
    const id = (message.id ?? null) as string | number | null;
    const method = String(message.method ?? '');
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (id === null && method.startsWith('notifications/')) return null;
    switch (method) {
      case 'server/discover':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
            capabilities: { tools: {} },
            serverInfo: { name: 'forge-mcp', version: '1.0.0' },
          },
        };
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'forge-mcp', version: '1.0.0' },
          },
        };
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
      case 'tools/call': {
        const toolName = String(params.name ?? '');
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const outcome = callTool(toolName, args);
        if (outcome.rpcError) return { jsonrpc: '2.0', id, error: outcome.rpcError };
        return { jsonrpc: '2.0', id, result: outcome.result };
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
    }
  };
  if (Array.isArray(parsed)) {
    const results = parsed.map((message) => handleOne(message as Record<string, unknown>)).filter((entry) => entry !== null);
    if (results.length === 0) return sendEmpty(res, 204);
    return sendJson(res, 200, results);
  }
  const result = handleOne(parsed as Record<string, unknown>);
  if (result === null) return sendEmpty(res, 204);
  return sendJson(res, 200, result);
}

// --------------------------------------------------------------------------- server

export function createApp(): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://forge.local');
        const path = url.pathname;
        if (path === '/healthz') {
          return sendJson(res, 200, { ok: true });
        }
        if (!authorized(req)) {
          return sendJson(res, 401, { message: 'Bad credentials' });
        }
        if (path === '/api/graphql' && (req.method ?? '') === 'POST') {
          const body = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8')) as unknown;
          } catch {
            return sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
          }
          if (Array.isArray(parsed)) {
            const results = parsed.map((entry) => {
              const doc = entry as { query?: unknown; variables?: unknown; operationName?: unknown };
              return executeGraphql(doc.query, doc.variables, doc.operationName);
            });
            return sendJson(res, 200, results);
          }
          const doc = parsed as { query?: unknown; variables?: unknown; operationName?: unknown };
          return sendJson(res, 200, executeGraphql(doc.query, doc.variables, doc.operationName));
        }
        if (path === '/mcp') {
          return await handleMcp(req, res);
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const segments = path.split('/').filter((segment) => segment !== '').slice(2);
          return await handleRest(req, res, url, segments);
        }
        const gitMatch = /^\/([^/]+)\/([^/]+\.git)(?:\/(.*))?$/.exec(path);
        if (gitMatch) {
          return await handleGit(req, res, url, gitMatch[1] as string, gitMatch[2] as string);
        }
        return notFound(res);
      } catch {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
  return server;
}

// Referenced helpers kept for parity with the store's surface.
void hashObject;
void ancestorSet;
void isAncestor;
void ZERO_OID;
