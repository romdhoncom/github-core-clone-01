// store.ts — the forge's whole state, in memory. One Store per process; every id and
// timestamp comes from deterministic counters, never a clock or Math.random, so a replayed
// trial leaves a byte-identical state export.
//
// The token's owner is the viewer: the sealed scenario's seed is fixed, so the viewer is
// always adaiversen (id 1000). A repository belongs to that login; any other owner is 404.

import {
  buildCommit,
  buildTreeFromFiles,
  diffTrees,
  flattenTree,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  peelToCommit,
  type FileChange,
  type GitObject,
  type ObjType,
} from './gitobj.ts';

export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** The fixed epoch every timestamp derives from: 2025-01-01T00:00:00Z. */
export const EPOCH_SEC = 1735689600;

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdOrder: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  createdOrder: number;
  updatedOrder: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  createdOrder: number;
  updatedOrder: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextNumber: number;
  createdOrder: number;
}

export class StoreError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class Store {
  readonly token: string;
  readonly repos = new Map<string, Repo>();
  private dbIdSeq = 5000;
  private objectIdSeq = 0;
  private commentIdSeq = 0;
  private seq = 0;
  private tick = 0;
  private reqSeq = 0;

  constructor(token: string) {
    this.token = token;
  }

  /** The next deterministic second (epoch + counter). */
  nextTimestamp(): number {
    return EPOCH_SEC + this.tick++;
  }

  nextIso(): string {
    return new Date(this.nextTimestamp() * 1000).toISOString();
  }

  /** A monotonically increasing creation-order counter. */
  nextOrder(): number {
    this.seq += 1;
    return this.seq;
  }

  /** A request id for X-GitHub-Request-Id: deterministic, non-empty. */
  nextRequestId(): string {
    this.reqSeq += 1;
    return `req-${this.reqSeq.toString(16).padStart(8, '0')}`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** The repository, or undefined when the owner is not the viewer or it does not exist. */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(this.repoKey(owner, name));
  }

  /** Every repository the viewer owns, in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdOrder - b.createdOrder);
  }

  createRepo(name: string, options: { private?: boolean; description?: string }): Repo {
    if (name === '' || /[^\w.-]/.test(name) || name.startsWith('.') || name.startsWith('-')) {
      throw new StoreError(422, `Invalid repository name ${JSON.stringify(name)}`);
    }
    const key = this.repoKey(VIEWER.login, name);
    if (this.repos.has(key)) throw new StoreError(422, `Repository ${name} already exists`);
    const repo: Repo = {
      id: this.dbIdSeq++,
      owner: VIEWER.login,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      createdAt: this.nextIso(),
      updatedAt: this.nextIso(),
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      createdOrder: this.nextOrder(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  // -------------------------------------------------------------------------------------------
  // git: refs, commits, contents
  // -------------------------------------------------------------------------------------------

  /** The tip of a branch, or undefined. */
  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** Resolve a ref-ish (branch name, full ref, or commit sha) to a commit oid. */
  resolveRef(repo: Repo, ref: string | undefined): string | undefined {
    if (ref === undefined || ref === '') return this.branchTip(repo, repo.defaultBranch);
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const asBranch = repo.refs.get(`refs/heads/${ref}`);
    if (asBranch !== undefined) return asBranch;
    if (/^[0-9a-f]{40}$/.test(ref)) {
      const object = repo.objects.get(ref);
      if (object && (object.type === 'commit' || object.type === 'tag')) {
        return peelToCommit(repo.objects, ref) ?? undefined;
      }
    }
    return undefined;
  }

  /** Store one object, answering its oid. */
  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /**
   * Commit one file change on a branch: creates the branch from the default tip when it does
   * not exist yet, and creates the default branch itself on an unborn repository. Returns the
   * commit sha and the new blob sha.
   */
  commitFile(
    repo: Repo,
    options: {
      path: string;
      content: Buffer;
      message: string;
      branch?: string;
      sha?: string;
      remove?: boolean;
    },
  ): { commitSha: string; contentSha: string | null; created: boolean } {
    const branch = options.branch ?? repo.defaultBranch;
    let tip = this.branchTip(repo, branch);
    let baseFiles = new Map<string, { oid: string; mode: string }>();
    if (tip !== undefined) {
      const commit = parseCommit(repo.objects.get(tip)!.data);
      baseFiles = flattenTree(repo.objects, commit.tree);
    } else if (branch !== repo.defaultBranch) {
      // A new branch starts at the default branch's tip (GitHub's behaviour for a contents
      // write naming a branch that does not exist yet).
      const defaultTip = this.branchTip(repo, repo.defaultBranch);
      if (defaultTip !== undefined) {
        tip = defaultTip;
        const commit = parseCommit(repo.objects.get(tip)!.data);
        baseFiles = flattenTree(repo.objects, commit.tree);
      }
    }
    const existing = baseFiles.get(options.path);
    if (options.remove === true) {
      if (!existing) throw new StoreError(404, `File ${options.path} does not exist`);
      if (options.sha !== undefined && options.sha !== existing.oid) {
        throw new StoreError(409, `sha ${options.sha} does not match the current ${existing.oid}`);
      }
      baseFiles.delete(options.path);
    } else {
      if (existing && options.sha !== undefined && options.sha !== existing.oid) {
        throw new StoreError(409, `sha ${options.sha} does not match the current ${existing.oid}`);
      }
      const blobSha = this.putObject(repo, 'blob', options.content);
      const created = existing === undefined;
      baseFiles.set(options.path, { oid: blobSha, mode: '100644' });
      const tree = buildTreeFromFiles(repo.objects, baseFiles);
      const message = options.message.endsWith('\n') ? options.message : `${options.message}\n`;
      const timestamp = this.nextTimestamp();
      const who = `${VIEWER.name} <${VIEWER.email}>`;
      const commitData = buildCommit({
        tree,
        parents: tip === undefined ? [] : [tip],
        message,
        author: who,
        committer: who,
        timestamp,
      });
      const commitSha = this.putObject(repo, 'commit', commitData);
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      return { commitSha, contentSha: blobSha, created };
    }
    const tree = buildTreeFromFiles(repo.objects, baseFiles);
    const message = options.message.endsWith('\n') ? options.message : `${options.message}\n`;
    const timestamp = this.nextTimestamp();
    const who = `${VIEWER.name} <${VIEWER.email}>`;
    const commitData = buildCommit({
      tree,
      parents: tip === undefined ? [] : [tip],
      message,
      author: who,
      committer: who,
      timestamp,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, contentSha: null, created: false };
  }

  /** Read one path at a ref: a file entry, a directory listing, or undefined. */
  readPath(
    repo: Repo,
    path: string,
    ref: string | undefined,
  ): { kind: 'file'; oid: string; mode: string; size: number } | { kind: 'dir'; entries: { name: string; path: string; oid: string; mode: string }[] } | undefined {
    const tip = this.resolveRef(repo, ref);
    if (tip === undefined) return undefined;
    const commit = parseCommit(repo.objects.get(tip)!.data);
    const files = flattenTree(repo.objects, commit.tree);
    const file = files.get(path);
    if (file) {
      const blob = repo.objects.get(file.oid);
      return { kind: 'file', oid: file.oid, mode: file.mode, size: blob ? blob.data.length : 0 };
    }
    // A directory: the immediate children of `path` in the flattened tree.
    const prefix = path === '' ? '' : `${path}/`;
    const children = new Map<string, { name: string; path: string; oid: string; mode: string }>();
    for (const [filePath, entry] of files) {
      if (prefix !== '' && !filePath.startsWith(prefix)) continue;
      const rest = prefix === '' ? filePath : filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        children.set(rest, { name: rest, path: filePath, oid: entry.oid, mode: entry.mode });
      } else {
        const dirName = rest.slice(0, slash);
        if (!children.has(dirName)) {
          // Find the directory's tree oid by walking the tree.
          const dirOid = this.treeOidAt(repo, commit.tree, prefix + dirName);
          children.set(dirName, { name: dirName, path: `${prefix}${dirName}`, oid: dirOid ?? '', mode: '40000' });
        }
      }
    }
    if (children.size === 0) return undefined;
    const entries = [...children.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { kind: 'dir', entries };
  }

  /** The tree oid of a directory path under a root tree, or undefined. */
  treeOidAt(repo: Repo, treeOid: string, path: string): string | undefined {
    const segments = path.split('/').filter((segment) => segment !== '');
    let current = treeOid;
    for (const segment of segments) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return undefined;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
      if (!entry) return undefined;
      current = entry.oid;
    }
    return current;
  }

  /** Commits reachable from a ref, newest first (breadth-first over parents). */
  listCommits(repo: Repo, ref: string | undefined): { sha: string; message: string; author: string; committer: string; tree: string }[] {
    const tip = this.resolveRef(repo, ref);
    if (tip === undefined) return [];
    const out: { sha: string; message: string; author: string; committer: string; tree: string }[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ sha: oid, message: commit.message, author: commit.author, committer: commit.committer, tree: commit.tree });
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // issues and labels
  // -------------------------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string): Label {
    if (repo.labels.has(name)) throw new StoreError(422, `Label ${name} already exists`);
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, input: { title: string; body: string; labels?: string[] }): Issue {
    const labels = input.labels ?? [];
    for (const name of labels) {
      if (!repo.labels.has(name)) throw new StoreError(422, `Label ${name} does not exist`);
    }
    const order = this.nextOrder();
    const issue: Issue = {
      id: ++this.objectIdSeq,
      number: repo.nextNumber++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: this.nextIso(),
      updatedAt: this.nextIso(),
      createdOrder: order,
      updatedOrder: order,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = { id: ++this.commentIdSeq, body, createdOrder: this.nextOrder() };
    issue.comments.push(comment);
    return comment;
  }

  // -------------------------------------------------------------------------------------------
  // pull requests
  // -------------------------------------------------------------------------------------------

  createPull(repo: Repo, input: { title: string; body: string; head: string; base: string }): Pull {
    const headSha = this.branchTip(repo, input.head);
    if (headSha === undefined) throw new StoreError(422, `Head branch ${input.head} does not exist`);
    const baseSha = this.branchTip(repo, input.base);
    if (baseSha === undefined) throw new StoreError(422, `Base branch ${input.base} does not exist`);
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === input.head && existing.baseRef === input.base) {
        throw new StoreError(422, `A pull request already exists for ${input.head} into ${input.base}`);
      }
    }
    const order = this.nextOrder();
    const pull: Pull = {
      id: ++this.objectIdSeq,
      number: repo.nextNumber++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      headRef: input.head,
      baseRef: input.base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: this.nextIso(),
      updatedAt: this.nextIso(),
      createdOrder: order,
      updatedOrder: order,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The changed files of a pull request (merge-base tree -> head tree). */
  pullFiles(repo: Repo, pull: Pull): (FileChange & { additions: number; deletions: number; changes: number })[] {
    const base = mergeBase(repo.objects, pull.headSha, pull.baseSha) ?? pull.baseSha;
    const baseCommit = parseCommit(repo.objects.get(peelToCommit(repo.objects, base) ?? base)!.data);
    const headCommit = parseCommit(repo.objects.get(peelToCommit(repo.objects, pull.headSha) ?? pull.headSha)!.data);
    const baseFiles = flattenTree(repo.objects, baseCommit.tree);
    const headFiles = flattenTree(repo.objects, headCommit.tree);
    const countLines = (oid: string | undefined): number => {
      if (oid === undefined) return 0;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'blob') return 0;
      const text = object.data.toString('utf8');
      if (text === '') return 0;
      return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    };
    const lineMultiset = (oid: string | undefined): Map<string, number> => {
      const counts = new Map<string, number>();
      if (oid === undefined) return counts;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'blob') return counts;
      for (const line of object.data.toString('utf8').split('\n')) {
        counts.set(line, (counts.get(line) ?? 0) + 1);
      }
      return counts;
    };
    const out: (FileChange & { additions: number; deletions: number; changes: number })[] = [];
    for (const change of diffTrees(baseFiles, headFiles)) {
      let additions = 0;
      let deletions = 0;
      if (change.status === 'added') {
        additions = countLines(change.newOid);
      } else if (change.status === 'removed') {
        deletions = countLines(change.oldOid);
      } else {
        const before = lineMultiset(change.oldOid);
        const after = lineMultiset(change.newOid);
        for (const [line, count] of after) {
          const missing = count - (before.get(line) ?? 0);
          if (missing > 0) additions += missing;
        }
        for (const [line, count] of before) {
          const extra = count - (after.get(line) ?? 0);
          if (extra > 0) deletions += extra;
        }
        if (additions === 0 && deletions === 0) additions = 1;
      }
      out.push({ ...change, additions, deletions, changes: additions + deletions });
    }
    return out;
  }

  /** Whether a pull request merges cleanly (three-way: no file changed differently on both sides). */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    return this.mergePlan(repo, pull).conflict === null;
  }

  /** The three-way merge plan for a pull request. */
  mergePlan(
    repo: Repo,
    pull: Pull,
  ): { conflict: string | null; files: Map<string, { oid: string; mode: string }> } {
    // The target is the base branch's CURRENT tip, not the tip recorded when the pull request
    // was opened: another pull request may have merged since, and its changes are what a
    // three-way merge must be judged against.
    const targetOid = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const baseOid = mergeBase(repo.objects, pull.headSha, targetOid) ?? targetOid;
    const baseCommit = parseCommit(repo.objects.get(peelToCommit(repo.objects, baseOid) ?? baseOid)!.data);
    const headCommit = parseCommit(repo.objects.get(peelToCommit(repo.objects, pull.headSha) ?? pull.headSha)!.data);
    const targetCommit = parseCommit(repo.objects.get(peelToCommit(repo.objects, targetOid) ?? targetOid)!.data);
    const baseFiles = flattenTree(repo.objects, baseCommit.tree);
    const headFiles = flattenTree(repo.objects, headCommit.tree);
    const targetFiles = flattenTree(repo.objects, targetCommit.tree);
    const merged = new Map(targetFiles);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...targetFiles.keys()]);
    for (const path of paths) {
      const before = baseFiles.get(path);
      const head = headFiles.get(path);
      const target = targetFiles.get(path);
      const same = (a: { oid: string; mode: string } | undefined, b: { oid: string; mode: string } | undefined): boolean =>
        (a === undefined && b === undefined) || (a !== undefined && b !== undefined && a.oid === b.oid);
      if (same(head, before)) continue; // unchanged on the head side: keep the target
      if (same(target, before)) {
        // Unchanged on the target side: take the head's version (or its deletion).
        if (head === undefined) merged.delete(path);
        else merged.set(path, head);
        continue;
      }
      if (same(head, target)) continue; // changed identically on both sides
      return { conflict: path, files: merged };
    }
    return { conflict: null, files: merged };
  }

  /** Squash-merge a pull request onto its base branch. */
  mergePull(repo: Repo, pull: Pull, method: string): { sha: string; message: string } {
    if (pull.merged || pull.state !== 'open') {
      throw new StoreError(405, `Pull request #${pull.number} is already ${pull.merged ? 'merged' : pull.state}`);
    }
    const plan = this.mergePlan(repo, pull);
    if (plan.conflict !== null) {
      throw new StoreError(405, `Merge conflict in ${plan.conflict}`);
    }
    // The squash commit lands on the base branch's current tip, so a merge never rewinds
    // another pull request that merged first.
    const targetOid = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const tree = buildTreeFromFiles(repo.objects, plan.files);
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
    const timestamp = this.nextTimestamp();
    const who = `${VIEWER.name} <${VIEWER.email}>`;
    const commitData = buildCommit({
      tree,
      parents: [targetOid],
      message,
      author: who,
      committer: who,
      timestamp,
    });
    const sha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = new Date(timestamp * 1000).toISOString();
    pull.mergeCommitSha = sha;
    pull.baseSha = sha;
    pull.updatedOrder = this.nextOrder();
    void method;
    return { sha, message: message.trimEnd() };
  }

  /** Is `commit` an ancestor of (or equal to) `tip`? */
  isAncestorOf(repo: Repo, ancestor: string, tip: string): boolean {
    return isAncestor(repo.objects, ancestor, tip);
  }
}
