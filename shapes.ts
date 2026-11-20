// The REST JSON shapes, shared by the REST surface, MCP tools and GraphQL payload parity.

import { VIEWER, type IssueRec, type PullRec, type RepoRec } from './store.ts';

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 2000, type: 'User' },
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    html_url: `https://forge.local/${repo.owner}/${repo.name}`,
    url: `https://forge.local/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.number,
    node_id: `I${repo.id}:${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({
      name,
      color: repo.labels.get(name)?.color ?? '000000',
      description: repo.labels.get(name)?.description ?? null,
    })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: new Date(1700000000000 + issue.seq * 1000).toISOString(),
    updated_at: new Date(1700000000000 + issue.seq * 1000).toISOString(),
    url: `https://forge.local/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? null;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? null;
  return {
    id: pull.number,
    node_id: `P${repo.id}:${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: new Date(1700000000000 + pull.seq * 1000).toISOString(),
    updated_at: new Date(1700000000000 + pull.seq * 1000).toISOString(),
    url: `https://forge.local/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}
