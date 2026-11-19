// rest.ts — GitHub REST v3 under /api/v3. Every reply is JSON with a non-empty
// X-GitHub-Request-Id (added by app.ts); errors are JSON {message}; unknown routes 404.

import { parseCommit } from './gitobj.ts';
import { Store, StoreError, VIEWER, type Issue, type Pull, type Repo } from './store.ts';

export interface RestRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
  json: unknown;
  jsonError: boolean;
  baseUrl: string;
}

export interface RestResult {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
}

type Handler = (store: Store, req: RestRequest, params: Record<string, string>) => RestResult;

interface Route {
  method: string;
  pattern: string[];
  handler: Handler;
}

const routes: Route[] = [];

function route(method: string, pattern: string, handler: Handler): void {
  routes.push({ method, pattern: pattern.split('/').filter((s) => s !== ''), handler });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bodyOf(req: RestRequest): Record<string, unknown> {
  if (req.jsonError) throw new StoreError(400, 'Malformed JSON body');
  return isRecord(req.json) ? req.json : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/** per_page/page from the query, GitHub-style (default 30, clamp 1..100). */
function pageOf(req: RestRequest): { perPage: number; page: number } {
  const perPageRaw = num(req.query.get('per_page'));
  const pageRaw = num(req.query.get('page'));
  const perPage = perPageRaw === undefined ? 30 : Math.min(100, Math.max(1, perPageRaw));
  const page = pageRaw === undefined ? 1 : Math.max(1, pageRaw);
  return { perPage, page };
}

function paginate<T>(items: T[], req: RestRequest): { page: T[]; total: number; perPage: number; pageNo: number } {
  const { perPage, page } = pageOf(req);
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, perPage, pageNo: page };
}

function linkHeader(req: RestRequest, total: number, perPage: number, pageNo: number): string | undefined {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (lastPage <= 1) return undefined;
  const urlFor = (page: number): string => {
    const query = new URLSearchParams(req.query);
    query.set('per_page', String(perPage));
    query.set('page', String(page));
    return `${req.baseUrl}${req.path}?${query.toString()}`;
  };
  const parts: string[] = [];
  if (pageNo < lastPage) parts.push(`<${urlFor(pageNo + 1)}>; rel="next"`);
  if (pageNo > 1) parts.push(`<${urlFor(pageNo - 1)}>; rel="prev"`);
  parts.push(`<${urlFor(1)}>; rel="first"`);
  parts.push(`<${urlFor(lastPage)}>; rel="last"`);
  return parts.join(', ');
}

function withPaging<T>(req: RestRequest, items: T[]): RestResult {
  const { page, total, perPage, pageNo } = paginate(items, req);
  const link = linkHeader(req, total, perPage, pageNo);
  return { status: 200, json: page, headers: link ? { link } : undefined };
}

// ---------------------------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------------------------

export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64url');
}

export function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return Buffer.from(`Issue:${repo.id}:${issue.number}`, 'utf8').toString('base64url');
}

export function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: '' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return Buffer.from(`PullRequest:${repo.id}:${pull.number}`, 'utf8').toString('base64url');
}

export function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: null,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export function commentView(repo: Repo, issue: Issue, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${repo.id}:${issue.number}:${comment.id}`, 'utf8').toString('base64url'),
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  };
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function needRepo(store: Store, params: Record<string, string>): Repo {
  const repo = store.getRepo(params.owner ?? '', params.repo ?? '');
  if (repo === undefined) throw new StoreError(404, `Repository ${params.owner}/${params.repo} not found`);
  return repo;
}

function needIssue(repo: Repo, params: Record<string, string>): Issue {
  const number = num(params.number);
  const issue = number === undefined ? undefined : repo.issues.get(number);
  if (issue === undefined) throw new StoreError(404, `Issue #${params.number} not found`);
  return issue;
}

function needPull(repo: Repo, params: Record<string, string>): Pull {
  const number = num(params.number);
  const pull = number === undefined ? undefined : repo.pulls.get(number);
  if (pull === undefined) throw new StoreError(404, `Pull request #${params.number} not found`);
  return pull;
}

function sortIssues(issues: Issue[], req: RestRequest): Issue[] {
  const direction = (req.query.get('direction') ?? 'desc').toLowerCase();
  const sorted = [...issues].sort((a, b) => a.createdOrder - b.createdOrder);
  if (direction === 'desc') sorted.reverse();
  return sorted;
}

// ---------------------------------------------------------------------------------------------
// routes: root, meta, user
// ---------------------------------------------------------------------------------------------

route('GET', '/api/v3', () => ({
  status: 200,
  json: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
  headers: { 'x-oauth-scopes': 'repo, read:org' },
}));

route('GET', '/api/v3/meta', () => ({
  status: 200,
  json: { installed_version: '1.0.0', verifiable_password_authentication: true },
}));

route('GET', '/api/v3/user', () => ({
  status: 200,
  json: {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: Buffer.from(`User:${VIEWER.id}`, 'utf8').toString('base64url'),
    name: VIEWER.name,
    email: VIEWER.email,
    type: 'User',
    html_url: `https://github.com/${VIEWER.login}`,
  },
}));

route('GET', '/api/v3/user/repos', (store, req) => withPaging(req, store.listRepos().map(repoView)));

route('POST', '/api/v3/user/repos', (store, req) => {
  const body = bodyOf(req);
  const name = str(body.name);
  if (name === undefined || name === '') throw new StoreError(422, 'Repository name is required');
  const repo = store.createRepo(name, {
    private: typeof body.private === 'boolean' ? body.private : undefined,
    description: str(body.description),
  });
  return { status: 201, json: repoView(repo) };
});

// ---------------------------------------------------------------------------------------------
// routes: repositories
// ---------------------------------------------------------------------------------------------

route('GET', '/api/v3/repos/:owner/:repo', (store, _req, params) => ({
  status: 200,
  json: repoView(needRepo(store, params)),
}));

route('PATCH', '/api/v3/repos/:owner/:repo', (store, req, params) => {
  const repo = needRepo(store, params);
  const body = bodyOf(req);
  if (str(body.description) !== undefined) repo.description = str(body.description)!;
  if (typeof body.private === 'boolean') repo.private = body.private;
  repo.updatedAt = store.nextIso();
  return { status: 200, json: repoView(repo) };
});

route('DELETE', '/api/v3/repos/:owner/:repo', (store, _req, params) => {
  const repo = needRepo(store, params);
  store.deleteRepo(repo);
  return { status: 204 };
});

// ---------------------------------------------------------------------------------------------
// routes: branches, commits, refs
// ---------------------------------------------------------------------------------------------

route('GET', '/api/v3/repos/:owner/:repo/branches', (store, _req, params) => {
  const repo = needRepo(store, params);
  const branches = [...repo.refs.entries()]
    .filter(([name]) => name.startsWith('refs/heads/'))
    .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha }, protected: false }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { status: 200, json: branches };
});

route('GET', '/api/v3/repos/:owner/:repo/branches/*branch', (store, _req, params) => {
  const repo = needRepo(store, params);
  const branch = params.branch ?? '';
  const sha = store.branchTip(repo, branch);
  if (sha === undefined) throw new StoreError(404, `Branch ${branch} not found`);
  return { status: 200, json: { name: branch, commit: { sha }, protected: false } };
});

route('GET', '/api/v3/repos/:owner/:repo/commits', (store, req, params) => {
  const repo = needRepo(store, params);
  const sha = req.query.get('sha') ?? undefined;
  const commits = store.listCommits(repo, sha).map((entry) => {
    const parseIdentity = (line: string): { name: string; email: string; date: string } => {
      const match = /^(.*) <(.*)> (\d+) \+0000$/.exec(line);
      if (!match) return { name: line, email: '', date: '' };
      return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]) * 1000).toISOString() };
    };
    const author = parseIdentity(entry.author);
    const committer = parseIdentity(entry.committer);
    return {
      sha: entry.sha,
      commit: {
        message: entry.message.replace(/\n+$/, ''),
        author,
        committer,
        tree: { sha: entry.tree },
      },
      author: { login: VIEWER.login, id: VIEWER.id },
      committer: { login: VIEWER.login, id: VIEWER.id },
    };
  });
  return withPaging(req, commits);
});

route('GET', '/api/v3/repos/:owner/:repo/commits/*sha', (store, _req, params) => {
  const repo = needRepo(store, params);
  const sha = params.sha ?? '';
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') throw new StoreError(404, `Commit ${sha} not found`);
  const commit = parseCommit(object.data);
  return {
    status: 200,
    json: { sha, commit: { message: commit.message.replace(/\n+$/, ''), tree: { sha: commit.tree } } },
  };
});

route('GET', '/api/v3/repos/:owner/:repo/git/refs', (store, _req, params) => {
  const repo = needRepo(store, params);
  const refs = [...repo.refs.entries()]
    .map(([name, sha]) => ({ ref: name, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }))
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return { status: 200, json: refs };
});

route('GET', '/api/v3/repos/:owner/:repo/git/refs/*ref', (store, _req, params) => {
  const repo = needRepo(store, params);
  const ref = `refs/${params.ref ?? ''}`;
  const sha = repo.refs.get(ref);
  if (sha === undefined) throw new StoreError(404, `Reference ${ref} not found`);
  return { status: 200, json: { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } } };
});

route('POST', '/api/v3/repos/:owner/:repo/git/refs', (store, req, params) => {
  const repo = needRepo(store, params);
  const body = bodyOf(req);
  const ref = str(body.ref);
  const sha = str(body.sha);
  if (ref === undefined || !ref.startsWith('refs/')) throw new StoreError(422, 'ref must start with refs/');
  if (sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) throw new StoreError(422, 'sha must be a 40-hex object id');
  const object = repo.objects.get(sha);
  if (!object) throw new StoreError(422, `Object ${sha} does not exist`);
  if (repo.refs.has(ref)) throw new StoreError(422, `Reference ${ref} already exists`);
  repo.refs.set(ref, sha);
  return { status: 201, json: { ref, object: { sha, type: object.type } } };
});

// ---------------------------------------------------------------------------------------------
// routes: contents
// ---------------------------------------------------------------------------------------------

function contentsPath(params: Record<string, string>): string {
  return decodeURIComponent(params.path ?? '');
}

route('PUT', '/api/v3/repos/:owner/:repo/contents/*path', (store, req, params) => {
  const repo = needRepo(store, params);
  const body = bodyOf(req);
  const content = str(body.content);
  const message = str(body.message) ?? 'Update file';
  if (content === undefined) throw new StoreError(422, 'content is required');
  let contentBytes: Buffer;
  try {
    contentBytes = Buffer.from(content, 'base64');
  } catch {
    throw new StoreError(422, 'content is not valid base64');
  }
  const branch = str(body.branch);
  const sha = str(body.sha);
  const path = contentsPath(params);
  const result = store.commitFile(repo, { path, content: contentBytes, message, branch, sha });
  const blob = repo.objects.get(result.contentSha ?? '');
  return {
    status: result.created ? 201 : 200,
    json: {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: result.contentSha,
        size: blob ? blob.data.length : 0,
        type: 'file',
        encoding: 'base64',
        content: contentBytes.toString('base64'),
      },
      commit: { sha: result.commitSha, message },
    },
  };
});

route('GET', '/api/v3/repos/:owner/:repo/contents/*path', (store, req, params) => {
  const repo = needRepo(store, params);
  const path = contentsPath(params);
  const ref = req.query.get('ref') ?? undefined;
  const read = store.readPath(repo, path, ref);
  if (read === undefined) throw new StoreError(404, `Path ${path} not found`);
  if (read.kind === 'file') {
    const blob = repo.objects.get(read.oid);
    const content = blob ? blob.data.toString('base64') : '';
    return {
      status: 200,
      json: {
        type: 'file',
        name: path.split('/').pop() ?? path,
        path,
        sha: read.oid,
        size: read.size,
        encoding: 'base64',
        content,
      },
    };
  }
  return {
    status: 200,
    json: read.entries.map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: entry.path,
      sha: entry.oid,
      size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
    })),
  };
});

route('DELETE', '/api/v3/repos/:owner/:repo/contents/*path', (store, req, params) => {
  const repo = needRepo(store, params);
  const body = bodyOf(req);
  const message = str(body.message) ?? 'Delete file';
  const sha = str(body.sha);
  const path = contentsPath(params);
  const result = store.commitFile(repo, { path, content: Buffer.alloc(0), message, sha, remove: true });
  return { status: 200, json: { commit: { sha: result.commitSha, message } } };
});

// ---------------------------------------------------------------------------------------------
// routes: labels and issues
// ---------------------------------------------------------------------------------------------

route('POST', '/api/v3/repos/:owner/:repo/labels', (store, req, params) => {
  const repo = needRepo(store, params);
  const body = bodyOf(req);
  const name = str(body.name);
  if (name === undefined || name === '') throw new StoreError(422, 'Label name is required');
  const label = store.createLabel(repo, name, str(body.color) ?? 'ededed');
  return { status: 201, json: { name: label.name, color: label.color, description: '' } };
});

route('GET', '/api/v3/repos/:owner/:repo/labels', (store, _req, params) => {
  const repo = needRepo(store, params);
  return {
    status: 200,
    json: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '' })),
  };
});

route('POST', '/api/v3/repos/:owner/:repo/issues', (store, req, params) => {
  const repo = needRepo(store, params);
  const body = bodyOf(req);
  const title = str(body.title);
  if (title === undefined || title === '') throw new StoreError(422, 'Issue title is required');
  const labels = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
  const issue = store.createIssue(repo, { title, body: str(body.body) ?? '', labels });
  return { status: 201, json: issueView(repo, issue) };
});

route('GET', '/api/v3/repos/:owner/:repo/issues', (store, req, params) => {
  const repo = needRepo(store, params);
  const state = (req.query.get('state') ?? 'open').toLowerCase();
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  else if (state !== 'all') throw new StoreError(422, `Invalid state ${state}`);
  return withPaging(req, sortIssues(issues, req).map((issue) => issueView(repo, issue)));
});

route('GET', '/api/v3/repos/:owner/:repo/issues/:number', (store, _req, params) => {
  const repo = needRepo(store, params);
  return { status: 200, json: issueView(repo, needIssue(repo, params)) };
});

route('PATCH', '/api/v3/repos/:owner/:repo/issues/:number', (store, req, params) => {
  const repo = needRepo(store, params);
  const issue = needIssue(repo, params);
  const body = bodyOf(req);
  if (str(body.title) !== undefined) issue.title = str(body.title)!;
  if (str(body.body) !== undefined) issue.body = str(body.body)!;
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  if (Array.isArray(body.labels)) {
    const labels = body.labels.filter((entry): entry is string => typeof entry === 'string');
    for (const name of labels) {
      if (!repo.labels.has(name)) throw new StoreError(422, `Label ${name} does not exist`);
    }
    issue.labels = labels;
  }
  issue.updatedAt = store.nextIso();
  issue.updatedOrder = store.nextOrder();
  return { status: 200, json: issueView(repo, issue) };
});

route('POST', '/api/v3/repos/:owner/:repo/issues/:number/comments', (store, req, params) => {
  const repo = needRepo(store, params);
  const issue = needIssue(repo, params);
  const body = bodyOf(req);
  const text = str(body.body);
  if (text === undefined || text === '') throw new StoreError(422, 'Comment body is required');
  const comment = store.createComment(repo, issue, text);
  return { status: 201, json: commentView(repo, issue, comment) };
});

route('GET', '/api/v3/repos/:owner/:repo/issues/:number/comments', (store, req, params) => {
  const repo = needRepo(store, params);
  const issue = needIssue(repo, params);
  return withPaging(req, issue.comments.map((comment) => commentView(repo, issue, comment)));
});

// ---------------------------------------------------------------------------------------------
// routes: pull requests
// ---------------------------------------------------------------------------------------------

route('POST', '/api/v3/repos/:owner/:repo/pulls', (store, req, params) => {
  const repo = needRepo(store, params);
  const body = bodyOf(req);
  const title = str(body.title);
  const head = str(body.head);
  const base = str(body.base) ?? repo.defaultBranch;
  if (title === undefined || title === '') throw new StoreError(422, 'Pull request title is required');
  if (head === undefined || head === '') throw new StoreError(422, 'Pull request head is required');
  const pull = store.createPull(repo, { title, body: str(body.body) ?? '', head, base });
  return { status: 201, json: pullView(repo, pull) };
});

route('GET', '/api/v3/repos/:owner/:repo/pulls', (store, req, params) => {
  const repo = needRepo(store, params);
  const state = (req.query.get('state') ?? 'open').toLowerCase();
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  else if (state !== 'all') throw new StoreError(422, `Invalid state ${state}`);
  pulls.sort((a, b) => b.createdOrder - a.createdOrder);
  return withPaging(req, pulls.map((pull) => pullView(repo, pull)));
});

route('GET', '/api/v3/repos/:owner/:repo/pulls/:number', (store, _req, params) => {
  const repo = needRepo(store, params);
  return { status: 200, json: pullView(repo, needPull(repo, params)) };
});

route('GET', '/api/v3/repos/:owner/:repo/pulls/:number/files', (store, _req, params) => {
  const repo = needRepo(store, params);
  const pull = needPull(repo, params);
  return {
    status: 200,
    json: store.pullFiles(repo, pull).map((file) => ({
      filename: file.path,
      status: file.status === 'removed' ? 'removed' : file.status === 'added' ? 'added' : 'modified',
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    })),
  };
});

route('PUT', '/api/v3/repos/:owner/:repo/pulls/:number/merge', (store, req, params) => {
  const repo = needRepo(store, params);
  const pull = needPull(repo, params);
  const body = bodyOf(req);
  const method = str(body.merge_method) ?? 'squash';
  const result = store.mergePull(repo, pull, method);
  return { status: 200, json: { merged: true, sha: result.sha, message: result.message } };
});

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

function matchPattern(pattern: string[], segments: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  let i = 0;
  for (const part of pattern) {
    if (part.startsWith('*')) {
      params[part.slice(1)] = segments.slice(i).map((s) => decodeURIComponent(s)).join('/');
      return params;
    }
    if (i >= segments.length) return null;
    if (part.startsWith(':')) {
      params[part.slice(1)] = decodeURIComponent(segments[i]!);
    } else if (part !== segments[i]) {
      return null;
    }
    i += 1;
  }
  return i === segments.length ? params : null;
}

/** Route one REST request. Returns null when the path is not a REST route. */
export function handleRest(store: Store, req: RestRequest): RestResult | null {
  const segments = req.path.split('/').filter((s) => s !== '');
  for (const candidate of routes) {
    if (candidate.method !== req.method) continue;
    const params = matchPattern(candidate.pattern, segments);
    if (params === null) continue;
    return candidate.handler(store, req, params);
  }
  return null;
}
