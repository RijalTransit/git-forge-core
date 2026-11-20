// A small real GraphQL engine for the surface the suite exercises: it parses documents (fields,
// aliases, arguments with variables/enums/lists/input objects, inline fragments, operation
// names), executes them against the store, and answers schema questions from a static type map.
// Unknown fields come back as GraphQL errors naming the field, the way the real API does.

import {
  VIEWER,
  flattenTree,
  getRepo,
  mergePull,
  nextSeq,
  pullMergeable,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { issueJson, pullJson } from './shapes.ts';

// --------------------------------------------------------------------------- ids

export function repoNodeId(repo: RepoRec): string {
  return Buffer.from(`R${repo.id}`, 'utf8').toString('base64');
}

export function issueNodeId(repo: RepoRec, number: number): string {
  return Buffer.from(`I${repo.id}:${number}`, 'utf8').toString('base64');
}

export function pullNodeId(repo: RepoRec, number: number): string {
  return Buffer.from(`P${repo.id}:${number}`, 'utf8').toString('base64');
}

export function commentNodeId(id: number): string {
  return Buffer.from(`C${id}`, 'utf8').toString('base64');
}

function decodeNodeId(id: string): { kind: string; repoId: number; number: number } | null {
  let raw: string;
  try {
    raw = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const repoMatch = /^R(\d+)$/.exec(raw);
  if (repoMatch) return { kind: 'R', repoId: Number(repoMatch[1]), number: 0 };
  const itemMatch = /^([IP])(\d+):(\d+)$/.exec(raw);
  if (itemMatch) return { kind: itemMatch[1] as string, repoId: Number(itemMatch[2]), number: Number(itemMatch[3]) };
  const commentMatch = /^C(\d+)$/.exec(raw);
  if (commentMatch) return { kind: 'C', repoId: 0, number: Number(commentMatch[1]) };
  return null;
}

function repoById(id: number): RepoRec | undefined {
  const { listRepos } = requireRepos();
  return listRepos().find((repo) => repo.id === id);
}

// store.ts keeps repos in a module-level map; import the lister lazily to avoid a cycle.
import { listRepos as listAllRepos } from './store.ts';
function requireRepos(): { listRepos: () => RepoRec[] } {
  return { listRepos: () => listAllRepos(VIEWER.login).concat(listAllRepos('faint-meadow-org')) };
}

function findRepoByNumericId(id: number): RepoRec | undefined {
  for (const owner of [VIEWER.login, 'faint-meadow-org']) {
    const found = listAllRepos(owner).find((repo) => repo.id === id);
    if (found) return found;
  }
  return undefined;
}

void repoById;

// --------------------------------------------------------------------------- lexer / parser

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',' || char === '﻿') {
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (source.startsWith('...', index)) {
      tokens.push({ kind: 'spread' });
      index += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      index += 1;
      continue;
    }
    if (char === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        tokens.push({ kind: 'string', value: source.slice(index + 3, end === -1 ? source.length : end) });
        index = end === -1 ? source.length : end + 3;
        continue;
      }
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\' && index + 1 < source.length) {
          const escaped = source[index + 1] as string;
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' };
          if (escaped === 'u') {
            value += String.fromCharCode(parseInt(source.slice(index + 2, index + 6), 16));
            index += 6;
          } else {
            value += map[escaped] ?? escaped;
            index += 2;
          }
        } else {
          value += source[index];
          index += 1;
        }
      }
      index += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(char)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(index));
      const text = match ? match[0] : char;
      tokens.push(text.includes('.') || /[eE]/.test(text) ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      index += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(char)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(index));
      const text = match ? match[0] : char;
      tokens.push({ kind: 'name', value: text });
      index += text.length;
      continue;
    }
    index += 1;
  }
  return tokens;
}

export type Value =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'var'; name: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

export interface FieldNode {
  name: string;
  alias: string | null;
  args: { name: string; value: Value }[];
  selections: Selection[];
}

export type Selection =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; typeCondition: string | null; selections: Selection[] };

export interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private eatPunct(value: string): boolean {
    if (this.atPunct(value)) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectPunct(value: string): void {
    if (!this.eatPunct(value)) throw new Error(`expected ${value}`);
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, Selection[]> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, Selection[]>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token && token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selections: this.parseSelectionSet() });
        continue;
      }
      if (token && token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        let name: string | null = null;
        const nameToken = this.peek();
        if (nameToken && nameToken.kind === 'name') name = (this.next() as { value: string }).value;
        if (this.atPunct('(')) this.skipBalanced();
        // directives
        while (this.atPunct('@')) {
          this.next();
          this.next();
          if (this.atPunct('(')) this.skipBalanced();
        }
        operations.push({ type: token.value as 'query' | 'mutation', name, selections: this.parseSelectionSet() });
        continue;
      }
      if (token && token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = (this.next() as { value: string }).value;
        this.next(); // on
        this.next(); // type name
        fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      this.next();
    }
    return { operations, fragments };
  }

  private skipBalanced(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token === undefined) break;
      if (token.kind === 'punct' && (token.value === '(' || token.value === '[' || token.value === '{')) depth += 1;
      if (token.kind === 'punct' && (token.value === ')' || token.value === ']' || token.value === '}')) depth -= 1;
    } while (depth > 0);
  }

  parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.atPunct('}')) {
      const token = this.peek();
      if (token === undefined) break;
      if (token.kind === 'spread') {
        this.next();
        const nextToken = this.peek();
        if (nextToken && nextToken.kind === 'name' && nextToken.value === 'on') {
          this.next();
          const typeName = (this.next() as { value: string }).value;
          selections.push({ kind: 'fragment', typeCondition: typeName, selections: this.parseSelectionSet() });
        } else if (nextToken && nextToken.kind === 'name') {
          const fragName = (this.next() as { value: string }).value;
          selections.push({ kind: 'fragment', typeCondition: null, selections: [{ kind: 'field', field: { name: `__fragment:${fragName}`, alias: null, args: [], selections: [] } }] });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseField(): FieldNode {
    const first = this.next() as { value: string };
    let name = first.value;
    let alias: string | null = null;
    if (this.eatPunct(':')) {
      alias = name;
      name = (this.next() as { value: string }).value;
    }
    const args: { name: string; value: Value }[] = [];
    if (this.eatPunct('(')) {
      while (!this.atPunct(')')) {
        const argName = (this.next() as { value: string }).value;
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    while (this.atPunct('@')) {
      this.next();
      this.next();
      if (this.atPunct('(')) this.skipBalanced();
    }
    let selections: Selection[] = [];
    if (this.atPunct('{')) selections = this.parseSelectionSet();
    return { name, alias, args, selections };
  }

  parseValue(): Value {
    const token = this.next();
    if (token === undefined) return { kind: 'null' };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'punct' && token.value === '$') {
      const nameToken = this.next() as { value: string };
      return { kind: 'var', name: nameToken.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (!this.atPunct('}')) {
        const fieldName = (this.next() as { value: string }).value;
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    return { kind: 'null' };
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'var':
      return variables[value.name] ?? null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((entry) => entry.name === name);
  if (!arg) return undefined;
  return resolveValue(arg.value, variables);
}

// --------------------------------------------------------------------------- schema

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', '__type', '__schema', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url', 'databaseId'],
  Organization: ['id', 'login', 'name', 'url', 'databaseId'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'isPrivate', 'description', 'url', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt'],
  Ref: ['id', 'name', 'target', 'prefix', 'repository'],
  Commit: ['id', 'oid', 'message', 'messageHeadline', 'tree', 'parents', 'author', 'committer', 'committedDate', 'authoredDate', 'url'],
  GitActor: ['name', 'email', 'date'],
  Tree: ['id', 'oid', 'entries'],
  TreeEntry: ['name', 'path', 'type', 'mode', 'object'],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'url', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'closed'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeCommit', 'mergedAt', 'files', 'author', 'url', 'createdAt', 'updatedAt', 'closed', 'isDraft', 'additions', 'deletions', 'changedFiles'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'url', 'createdAt', 'updatedAt'],
  Label: ['id', 'name', 'color', 'description'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestFilesConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFilesEdge: ['node', 'cursor'],
  CommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CommentEdge: ['node', 'cursor'],
  SearchResultItemConnection: ['nodes', 'edges', 'pageInfo', 'issueCount', 'codeCount'],
  CreateIssuePayload: ['clientMutationId', 'issue'],
  CloseIssuePayload: ['clientMutationId', 'issue'],
  CreatePullRequestPayload: ['clientMutationId', 'pullRequest'],
  MergePullRequestPayload: ['clientMutationId', 'pullRequest'],
  AddCommentPayload: ['clientMutationId', 'commentEdge', 'subject'],
  __Type: ['kind', 'name', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'interfaces', 'ofType'],
  __Field: ['name', 'description', 'type', 'args', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  FileStatus: ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED'],
};

const KIND_OF: Record<string, string> = {};
for (const name of Object.keys(ENUM_VALUES)) KIND_OF[name] = 'ENUM';
for (const name of Object.keys(TYPE_FIELDS)) KIND_OF[name] = name.startsWith('__') ? 'OBJECT' : 'OBJECT';

// --------------------------------------------------------------------------- execution

export interface GqlContext {
  variables: Record<string, unknown>;
  fragments: Map<string, Selection[]>;
  errors: { message: string }[];
}

interface Wrapped {
  __type: string;
  repo?: RepoRec;
  issue?: IssueRec;
  pull?: PullRec;
  commentId?: number;
  commentBody?: string;
  raw?: unknown;
}

function wrapRepo(repo: RepoRec): Wrapped {
  return { __type: 'Repository', repo };
}

function viewerValue(field: FieldNode, ctx: GqlContext): unknown {
  switch (field.name) {
    case 'login':
      return VIEWER.login;
    case 'id':
      return Buffer.from(`U${VIEWER.id}`, 'utf8').toString('base64');
    case 'databaseId':
      return VIEWER.id;
    case 'name':
      return VIEWER.name;
    case 'email':
      return VIEWER.email;
    case 'url':
      return `https://forge.local/${VIEWER.login}`;
    default:
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'User'` });
      return null;
  }
}

function issueValue(repo: RepoRec, issue: IssueRec, field: FieldNode, ctx: GqlContext): unknown {
  switch (field.name) {
    case 'id':
      return issueNodeId(repo, issue.number);
    case 'databaseId':
      return issue.number;
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'body':
    case 'bodyText':
      return issue.body;
    case 'state':
      return issue.state.toUpperCase();
    case 'closed':
      return issue.state === 'closed';
    case 'url':
      return `https://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}`;
    case 'author':
      return { __type: 'User' } as Wrapped;
    case 'createdAt':
    case 'updatedAt':
      return new Date(1700000000000 + issue.seq * 1000).toISOString();
    case 'labels': {
      const nodes = issue.labels.map((name) => ({ __type: 'Label', raw: { name, color: repo.labels.get(name)?.color ?? '000000' } }) as Wrapped);
      return { __type: 'LabelConnection', raw: nodes };
    }
    case 'comments': {
      const nodes = issue.comments.map((comment) => ({ __type: 'IssueComment', commentId: comment.id, commentBody: comment.body }) as Wrapped);
      return connection(field, nodes, ctx);
    }
    default:
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Issue'` });
      return null;
  }
}

function pullValue(repo: RepoRec, pull: PullRec, field: FieldNode, ctx: GqlContext): unknown {
  switch (field.name) {
    case 'id':
      return pullNodeId(repo, pull.number);
    case 'databaseId':
      return pull.number;
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body;
    case 'state':
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    case 'merged':
      return pull.merged;
    case 'closed':
      return pull.state === 'closed';
    case 'isDraft':
      return false;
    case 'mergeable':
      if (pull.merged) return 'UNKNOWN';
      return pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    case 'headRefName':
      return pull.head;
    case 'baseRefName':
      return pull.base;
    case 'headRefOid':
      return repo.refs.get(`refs/heads/${pull.head}`) ?? null;
    case 'baseRefOid':
      return repo.refs.get(`refs/heads/${pull.base}`) ?? null;
    case 'mergedAt':
      return pull.mergedAt;
    case 'mergeCommit': {
      if (!pull.mergeCommitSha) return null;
      return { __type: 'Commit', raw: pull.mergeCommitSha } as Wrapped;
    }
    case 'url':
      return `https://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`;
    case 'author':
      return { __type: 'User' } as Wrapped;
    case 'createdAt':
    case 'updatedAt':
      return new Date(1700000000000 + pull.seq * 1000).toISOString();
    case 'files': {
      const { pullDiff } = pullDiffModule();
      const diffs = pullDiff(repo, pull);
      const nodes = diffs.map(
        (diff) =>
          ({
            __type: 'PullRequestChangedFile',
            raw: { path: diff.filename, additions: diff.additions, deletions: diff.deletions, changeType: diff.status.toUpperCase() },
          }) as Wrapped,
      );
      return connection(field, nodes, ctx, 'PullRequestFilesConnection');
    }
    case 'additions': {
      const { pullDiff } = pullDiffModule();
      return pullDiff(repo, pull).reduce((sum, diff) => sum + diff.additions, 0);
    }
    case 'deletions': {
      const { pullDiff } = pullDiffModule();
      return pullDiff(repo, pull).reduce((sum, diff) => sum + diff.deletions, 0);
    }
    case 'changedFiles': {
      const { pullDiff } = pullDiffModule();
      return pullDiff(repo, pull).length;
    }
    default:
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'PullRequest'` });
      return null;
  }
}

import { pullDiff as pullDiffImpl } from './store.ts';
function pullDiffModule(): { pullDiff: typeof pullDiffImpl } {
  return { pullDiff: pullDiffImpl };
}

function connection(field: FieldNode, nodes: Wrapped[], ctx: GqlContext, typeName = 'Connection'): unknown {
  const firstArg = argValue(field, 'first', ctx.variables);
  const afterArg = argValue(field, 'after', ctx.variables);
  const first = typeof firstArg === 'number' ? firstArg : nodes.length;
  let start = 0;
  if (typeof afterArg === 'string' && afterArg !== '') {
    const decoded = Number(Buffer.from(afterArg, 'base64').toString('utf8'));
    if (Number.isFinite(decoded)) start = decoded + 1;
  }
  const slice = nodes.slice(start, start + first);
  const hasNextPage = start + slice.length < nodes.length;
  const endCursor = slice.length > 0 ? Buffer.from(String(start + slice.length - 1), 'utf8').toString('base64') : null;
  return {
    __type: typeName,
    raw: { nodes: slice, pageInfo: { hasNextPage, endCursor, totalCount: nodes.length }, edges: slice.map((node, index) => ({ node, cursor: Buffer.from(String(start + index), 'utf8').toString('base64') })) },
  } as Wrapped;
}

function typeValue(typeName: string, field: FieldNode, ctx: GqlContext): unknown {
  switch (field.name) {
    case 'name':
      return typeName;
    case 'kind':
      return KIND_OF[typeName] ?? 'OBJECT';
    case 'description':
      return null;
    case 'fields': {
      const names = TYPE_FIELDS[typeName] ?? [];
      return names.map((name) => ({ __type: '__Field', raw: { name } }) as Wrapped);
    }
    case 'enumValues': {
      const names = ENUM_VALUES[typeName] ?? [];
      return names.map((name) => ({ __type: '__EnumValue', raw: { name } }) as Wrapped);
    }
    case 'possibleTypes':
    case 'interfaces':
    case 'inputFields':
      return [];
    case 'ofType':
      return null;
    default:
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '__Type'` });
      return null;
  }
}

function resolveField(parentType: string, parent: Wrapped | null, field: FieldNode, ctx: GqlContext): unknown {
  const name = field.name;
  if (name === '__typename') return parentType;
  if (parentType === 'Query') {
    switch (name) {
      case 'viewer':
        return { __type: 'User' } as Wrapped;
      case 'repository': {
        const owner = String(argValue(field, 'owner', ctx.variables) ?? '');
        const repoName = String(argValue(field, 'name', ctx.variables) ?? '');
        const repo = getRepo(owner, repoName);
        return repo ? wrapRepo(repo) : null;
      }
      case 'node': {
        const id = String(argValue(field, 'id', ctx.variables) ?? '');
        const decoded = decodeNodeId(id);
        if (!decoded) return null;
        if (decoded.kind === 'R') {
          const repo = findRepoByNumericId(decoded.repoId);
          return repo ? wrapRepo(repo) : null;
        }
        if (decoded.kind === 'I') {
          const repo = findRepoByNumericId(decoded.repoId);
          const issue = repo?.issues.get(decoded.number);
          return repo && issue ? ({ __type: 'Issue', repo, issue } as Wrapped) : null;
        }
        if (decoded.kind === 'P') {
          const repo = findRepoByNumericId(decoded.repoId);
          const pull = repo?.pulls.get(decoded.number);
          return repo && pull ? ({ __type: 'PullRequest', repo, pull } as Wrapped) : null;
        }
        return null;
      }
      case '__type': {
        const typeName = String(argValue(field, 'name', ctx.variables) ?? '');
        return { __type: '__Type', raw: typeName } as Wrapped;
      }
      case '__schema':
        return { __type: '__Schema' } as Wrapped;
      case 'search': {
        return { __type: 'SearchResultItemConnection', raw: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null, totalCount: 0 }, edges: [] } } as Wrapped;
      }
      case 'rateLimit':
        return { __type: 'RateLimit', raw: { limit: 5000, cost: 1, remaining: 4999, resetAt: new Date(Date.now() + 3600_000).toISOString(), nodeCount: 0 } } as Wrapped;
      default:
        ctx.errors.push({ message: `Field '${name}' doesn't exist on type 'Query'` });
        return null;
    }
  }
  if (parentType === 'Mutation') return resolveMutation(name, field, ctx);
  if (parent === null) return null;

  switch (parentType) {
    case 'User':
    case 'Organization':
      if (parent.__type === 'User' || parent.__type === 'Organization') return viewerValue(field, ctx);
      return viewerValue(field, ctx);
    case 'Repository': {
      const repo = parent.repo as RepoRec;
      switch (name) {
        case 'id':
          return repoNodeId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'description':
          return repo.description === '' ? null : repo.description;
        case 'isPrivate':
          return repo.isPrivate;
        case 'url':
          return `https://forge.local/${repo.owner}/${repo.name}`;
        case 'owner':
          return { __type: repo.owner === VIEWER.login ? 'User' : 'Organization' } as Wrapped;
        case 'defaultBranchRef': {
          const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return { __type: 'Ref', raw: { name: repo.defaultBranch, oid: oid ?? null, repo } } as Wrapped;
        }
        case 'viewerPermission':
          return repo.owner === VIEWER.login ? 'ADMIN' : 'READ';
        case 'hasIssuesEnabled':
          return true;
        case 'createdAt':
        case 'updatedAt':
          return new Date(1700000000000 + repo.id * 1000).toISOString();
        case 'issue': {
          const number = Number(argValue(field, 'number', ctx.variables));
          const issue = repo.issues.get(number);
          return issue ? ({ __type: 'Issue', repo, issue } as Wrapped) : null;
        }
        case 'issues': {
          let items = [...repo.issues.values()].sort((a, b) => a.seq - b.seq);
          const states = argValue(field, 'states', ctx.variables);
          if (Array.isArray(states) && states.length > 0) {
            const wanted = states.map((state) => String(state).toLowerCase());
            items = items.filter((issue) => wanted.includes(issue.state));
          }
          const orderBy = argValue(field, 'orderBy', ctx.variables) as { direction?: string } | undefined;
          if (orderBy && String(orderBy.direction ?? 'ASC') === 'DESC') items.reverse();
          const nodes = items.map((issue) => ({ __type: 'Issue', repo, issue }) as Wrapped);
          return connection(field, nodes, ctx, 'IssueConnection');
        }
        case 'pullRequest': {
          const number = Number(argValue(field, 'number', ctx.variables));
          const pull = repo.pulls.get(number);
          return pull ? ({ __type: 'PullRequest', repo, pull } as Wrapped) : null;
        }
        case 'pullRequests': {
          let items = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
          const states = argValue(field, 'states', ctx.variables);
          if (Array.isArray(states) && states.length > 0) {
            const wanted = states.map((state) => String(state));
            items = items.filter((pull) => {
              const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
              return wanted.includes(state);
            });
          }
          const nodes = items.map((pull) => ({ __type: 'PullRequest', repo, pull }) as Wrapped);
          return connection(field, nodes, ctx, 'PullRequestConnection');
        }
        default:
          ctx.errors.push({ message: `Field '${name}' doesn't exist on type 'Repository'` });
          return null;
      }
    }
    case 'Issue':
      return issueValue(parent.repo as RepoRec, parent.issue as IssueRec, field, ctx);
    case 'PullRequest':
      return pullValue(parent.repo as RepoRec, parent.pull as PullRec, field, ctx);
    case 'IssueComment':
      switch (name) {
        case 'id':
          return commentNodeId(parent.commentId ?? 0);
        case 'databaseId':
          return parent.commentId ?? 0;
        case 'body':
          return parent.commentBody ?? '';
        case 'author':
          return { __type: 'User' } as Wrapped;
        case 'createdAt':
        case 'updatedAt':
          return new Date().toISOString();
        case 'url':
          return 'https://forge.local/';
        default:
          ctx.errors.push({ message: `Field '${name}' doesn't exist on type 'IssueComment'` });
          return null;
      }
    case 'Ref': {
      const raw = parent.raw as { name: string; oid: string | null; repo: RepoRec };
      switch (name) {
        case 'name':
          return raw.name;
        case 'prefix':
          return 'refs/heads/';
        case 'id':
          return Buffer.from(`REF${raw.repo.id}:${raw.name}`, 'utf8').toString('base64');
        case 'target':
          return raw.oid ? ({ __type: 'Commit', raw: raw.oid } as Wrapped) : null;
        case 'repository':
          return wrapRepo(raw.repo);
        default:
          ctx.errors.push({ message: `Field '${name}' doesn't exist on type 'Ref'` });
          return null;
      }
    }
    case 'Commit': {
      const oid = parent.raw as string;
      switch (name) {
        case 'oid':
        case 'id':
          return oid;
        case 'message':
          return '';
        case 'url':
          return `https://forge.local/commit/${oid}`;
        default:
          return null;
      }
    }
    case '__Type':
      return typeValue(parent.raw as string, field, ctx);
    case '__Field': {
      const raw = parent.raw as { name: string };
      switch (name) {
        case 'name':
          return raw.name;
        case 'description':
          return null;
        case 'isDeprecated':
          return false;
        case 'deprecationReason':
          return null;
        case 'args':
          return [];
        case 'type':
          return { __type: '__Type', raw: 'String' } as Wrapped;
        default:
          return null;
      }
    }
    case '__EnumValue': {
      const raw = parent.raw as { name: string };
      switch (name) {
        case 'name':
          return raw.name;
        case 'description':
          return null;
        case 'isDeprecated':
          return false;
        case 'deprecationReason':
          return null;
        default:
          return null;
      }
    }
    case '__Schema':
      switch (name) {
        case 'queryType':
          return { __type: '__Type', raw: 'Query' } as Wrapped;
        case 'mutationType':
          return { __type: '__Type', raw: 'Mutation' } as Wrapped;
        case 'subscriptionType':
          return null;
        case 'types':
          return Object.keys(TYPE_FIELDS).map((typeName) => ({ __type: '__Type', raw: typeName }) as Wrapped);
        case 'directives':
          return [];
        default:
          return null;
      }
    case 'PageInfo': {
      const raw = parent.raw as { hasNextPage: boolean; endCursor: string | null };
      switch (name) {
        case 'hasNextPage':
          return raw.hasNextPage;
        case 'hasPreviousPage':
          return false;
        case 'startCursor':
          return raw.endCursor;
        case 'endCursor':
          return raw.endCursor;
        default:
          return null;
      }
    }
    default: {
      // Generic containers: connections and payloads carry their data in `raw`.
      const raw = parent.raw as Record<string, unknown> | undefined;
      if (raw && typeof raw === 'object' && name in raw) return raw[name];
      if (parent.__type.endsWith('Connection')) {
        if (name === 'nodes' || name === 'edges') {
          const container = parent.raw as { nodes?: unknown; edges?: unknown };
          return name === 'nodes' ? container.nodes : container.edges;
        }
        if (name === 'pageInfo') {
          const container = parent.raw as { pageInfo: unknown };
          return { __type: 'PageInfo', raw: container.pageInfo } as Wrapped;
        }
        if (name === 'totalCount') {
          const container = parent.raw as { pageInfo: { totalCount: number } };
          return container.pageInfo.totalCount;
        }
        if (name === 'issueCount' || name === 'codeCount') return 0;
      }
      if (parent.__type === 'IssueEdge' || parent.__type === 'PullRequestEdge' || parent.__type === 'PullRequestFilesEdge') {
        const edge = parent.raw as { node?: unknown; cursor?: unknown };
        if (name === 'node') return edge.node;
        if (name === 'cursor') return edge.cursor;
      }
      if (parent.__type === 'Label') {
        const label = parent.raw as { name: string; color: string };
        if (name === 'name') return label.name;
        if (name === 'color') return label.color;
        if (name === 'id') return Buffer.from(`L${label.name}`, 'utf8').toString('base64');
        if (name === 'description') return null;
      }
      if (parent.__type === 'PullRequestChangedFile') {
        const file = parent.raw as Record<string, unknown>;
        if (name in file) return file[name];
        if (name === 'changeType') return file.changeType;
      }
      ctx.errors.push({ message: `Field '${name}' doesn't exist on type '${parentType}'` });
      return null;
    }
  }
}

function resolveMutation(name: string, field: FieldNode, ctx: GqlContext): unknown {
  const input = (argValue(field, 'input', ctx.variables) ?? {}) as Record<string, unknown>;
  const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
  switch (name) {
    case 'createIssue': {
      const decoded = decodeNodeId(String(input.repositoryId ?? ''));
      const repo = decoded ? findRepoByNumericId(decoded.repoId) : undefined;
      if (!repo) {
        ctx.errors.push({ message: 'repository not found for createIssue' });
        return null;
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: IssueRec = {
        number,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        seq: nextSeq(),
      };
      repo.issues.set(number, issue);
      return { __type: 'CreateIssuePayload', raw: { clientMutationId, issue: { __type: 'Issue', repo, issue } as Wrapped } } as Wrapped;
    }
    case 'closeIssue': {
      const decoded = decodeNodeId(String(input.issueId ?? ''));
      const repo = decoded ? findRepoByNumericId(decoded.repoId) : undefined;
      const issue = repo?.issues.get(decoded?.number ?? -1);
      if (!repo || !issue) {
        ctx.errors.push({ message: 'issue not found for closeIssue' });
        return null;
      }
      issue.state = 'closed';
      return { __type: 'CloseIssuePayload', raw: { clientMutationId, issue: { __type: 'Issue', repo, issue } as Wrapped } } as Wrapped;
    }
    case 'createPullRequest': {
      const decoded = decodeNodeId(String(input.repositoryId ?? ''));
      const repo = decoded ? findRepoByNumericId(decoded.repoId) : undefined;
      if (!repo) {
        ctx.errors.push({ message: 'repository not found for createPullRequest' });
        return null;
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: PullRec = {
        number,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq: nextSeq(),
      };
      repo.pulls.set(number, pull);
      return { __type: 'CreatePullRequestPayload', raw: { clientMutationId, pullRequest: { __type: 'PullRequest', repo, pull } as Wrapped } } as Wrapped;
    }
    case 'mergePullRequest': {
      const decoded = decodeNodeId(String(input.pullRequestId ?? ''));
      const repo = decoded ? findRepoByNumericId(decoded.repoId) : undefined;
      const pull = repo?.pulls.get(decoded?.number ?? -1);
      if (!repo || !pull) {
        ctx.errors.push({ message: 'pull request not found for mergePullRequest' });
        return null;
      }
      const method = String(input.mergeMethod ?? 'SQUASH').toLowerCase();
      mergePull(repo, pull, method);
      return { __type: 'MergePullRequestPayload', raw: { clientMutationId, pullRequest: { __type: 'PullRequest', repo, pull } as Wrapped } } as Wrapped;
    }
    case 'addComment': {
      const decoded = decodeNodeId(String(input.subjectId ?? ''));
      const repo = decoded ? findRepoByNumericId(decoded.repoId) : undefined;
      if (!repo || !decoded) {
        ctx.errors.push({ message: 'subject not found for addComment' });
        return null;
      }
      const body = String(input.body ?? '');
      const { nextCommentId } = commentIds();
      const id = nextCommentId();
      const target = decoded.kind === 'P' ? repo.pulls.get(decoded.number) : repo.issues.get(decoded.number);
      if (target && 'comments' in target) {
        target.comments.push({ id, body, seq: nextSeq() });
      } else if (repo.issues.get(decoded.number)) {
        (repo.issues.get(decoded.number) as IssueRec).comments.push({ id, body, seq: nextSeq() });
      }
      const node = { __type: 'IssueComment', commentId: id, commentBody: body } as Wrapped;
      const edge = { __type: 'CommentEdge', raw: { node, cursor: Buffer.from('0', 'utf8').toString('base64') } } as Wrapped;
      return { __type: 'AddCommentPayload', raw: { clientMutationId, commentEdge: edge, subject: node } } as Wrapped;
    }
    default:
      ctx.errors.push({ message: `Field '${name}' doesn't exist on type 'Mutation'` });
      return null;
  }
}

import { nextCommentId as nextCommentIdImpl } from './store.ts';
function commentIds(): { nextCommentId: () => number } {
  return { nextCommentId: nextCommentIdImpl };
}

// --------------------------------------------------------------------------- selection execution

function executeSelections(parentType: string, parent: Wrapped | null, selections: Selection[], ctx: GqlContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition === null) {
        // Named fragment spread recorded as a marker field.
        continue;
      }
      if (selection.typeCondition !== parentType && !(parentType === 'User' && selection.typeCondition === 'Actor')) continue;
      Object.assign(out, executeSelections(parentType, parent, selection.selections, ctx));
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    const value = resolveField(parentType, parent, field, ctx);
    out[key] = completeValue(value, field, ctx);
  }
  return out;
}

function typeOfValue(value: unknown): string {
  if (value !== null && typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    return (value as Wrapped).__type;
  }
  return 'Unknown';
}

function completeValue(value: unknown, field: FieldNode, ctx: GqlContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, field, ctx));
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    const wrapped = value as Wrapped;
    if (field.selections.length === 0) return wrapped.raw ?? null;
    return executeSelections(wrapped.__type, wrapped, field.selections, ctx);
  }
  if (typeof value === 'object') {
    // Plain object (e.g. connection raw handled above, edges): recurse by keys.
    return value;
  }
  return value;
}

/** Execute one GraphQL document; returns the response body object. */
export function executeGraphql(document: unknown, variablesInput: unknown, operationName: unknown): Record<string, unknown> {
  if (typeof document !== 'string') {
    return { errors: [{ message: 'query must be a string' }] };
  }
  const variables = (variablesInput && typeof variablesInput === 'object' ? variablesInput : {}) as Record<string, unknown>;
  let parsed: { operations: Operation[]; fragments: Map<string, Selection[]> };
  try {
    parsed = new Parser(lex(document)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation =
    parsed.operations.find((op) => typeof operationName === 'string' && op.name === operationName) ?? parsed.operations[0];
  if (!operation) return { errors: [{ message: 'no operation found' }] };
  // Expand named fragments inline.
  const expand = (selections: Selection[]): Selection[] => {
    const out: Selection[] = [];
    for (const selection of selections) {
      if (selection.kind === 'fragment' && selection.typeCondition === null) {
        const marker = selection.selections[0];
        if (marker && marker.kind === 'field' && marker.field.name.startsWith('__fragment:')) {
          const frag = parsed.fragments.get(marker.field.name.slice('__fragment:'.length));
          if (frag) out.push(...expand(frag));
          continue;
        }
      }
      if (selection.kind === 'field' && selection.field.selections.length > 0) {
        out.push({ kind: 'field', field: { ...selection.field, selections: expand(selection.field.selections) } });
        continue;
      }
      if (selection.kind === 'fragment') {
        out.push({ kind: 'fragment', typeCondition: selection.typeCondition, selections: expand(selection.selections) });
        continue;
      }
      out.push(selection);
    }
    return out;
  };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const ctx: GqlContext = { variables, fragments: parsed.fragments, errors: [] };
  const data = executeSelections(rootType, null, expand(operation.selections), ctx);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

// Keep the REST shapes import referenced for parity tooling.
void issueJson;
void pullJson;
void flattenTree;
