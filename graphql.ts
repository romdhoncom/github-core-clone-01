// graphql.ts — GitHub GraphQL v4 for the documents gh and github-mcp-server actually
// send: a small hand-written parser and executor over the same store REST uses.
// Unknown fields are HTTP 200 with an errors array naming the field; an unknown repository
// is data.repository null with no errors; two documents in one body answer in order.

import { Store, StoreError, VIEWER, type Issue, type Pull, type Repo } from './store.ts';
import { issueGlobalId, pullGlobalId, repoGlobalId } from './rest.ts';

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Record<string, GqlValue> };

interface GqlField {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  selections: GqlSelection[] | null;
}

type GqlSelection =
  | GqlField
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selections: GqlSelection[] };

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, { default?: GqlValue }>;
  selections: GqlSelection[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Record<string, GqlSelection[]>;
}

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      // String (block strings """...""" are not sent by the suite; a plain string suffices).
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document, got ${token.value}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name in GraphQL document, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value} in GraphQL document, got ${token.value}`);
    return token.value;
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments: Record<string, GqlSelection[]> = {};
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, variables: {}, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        this.expectName();
        fragments[name] = this.parseSelectionSet();
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const variables: Record<string, { default?: GqlValue }> = {};
        if (this.matchPunct('(')) {
          while (!this.matchPunct(')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            if (this.matchPunct('=')) variables[varName] = { default: this.parseValue() };
            else variables[varName] = {};
          }
        }
        // Directives, if any, are skipped.
        while (this.matchPunct('@')) {
          this.expectName();
          if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
        }
        operations.push({ kind, name, variables, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token ${token.value} in GraphQL document`);
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.matchPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.matchPunct('!');
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!this.matchPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): GqlSelection {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        while (this.matchPunct('@')) {
          this.expectName();
          if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
        }
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        return { kind: 'spread', name: this.next().value };
      }
      while (this.matchPunct('@')) {
        this.expectName();
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
      }
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.matchPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : {};
    const selections =
      this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Record<string, GqlValue> {
    this.expectPunct('(');
    const args: Record<string, GqlValue> = {};
    while (!this.matchPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    return args;
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const values: GqlValue[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, GqlValue> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value} in GraphQL document`);
  }
}

// ---------------------------------------------------------------------------------------------
// schema (for validation and __type introspection)
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author'],
  PullRequest: [
    'id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files',
    'body', 'createdAt', 'updatedAt', 'url',
  ],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  User: ['login', 'id', 'name', 'email'],
  Ref: ['name'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  Node: ['id'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
};

const TYPE_KIND: Record<string, string> = {
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  Repository: 'OBJECT',
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  IssueConnection: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  PullRequestChangedFileConnection: 'OBJECT',
  PullRequestChangedFile: 'OBJECT',
  User: 'OBJECT',
  Ref: 'OBJECT',
  PageInfo: 'OBJECT',
  Node: 'INTERFACE',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
  PullRequestMergeMethod: 'ENUM',
  RepositoryPermission: 'ENUM',
  IssueOrderField: 'ENUM',
  OrderDirection: 'ENUM',
  SearchType: 'ENUM',
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MILESTONE', 'PACKAGE', 'MARKETPLACE', 'TOPIC', 'WIKI'],
};

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface GqlContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: { message: string }[];
  fragments: Record<string, GqlSelection[]>;
}

type GqlObject = Record<string, unknown> & { __typename: string };

function resolveValue(value: GqlValue, ctx: GqlContext): unknown {
  switch (value.kind) {
    case 'var': {
      const found = ctx.variables[value.name];
      return found === undefined ? null : found;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((entry) => resolveValue(entry, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value.fields)) out[key] = resolveValue(entry, ctx);
      return out;
    }
  }
}

function resolveArgs(args: Record<string, GqlValue>, ctx: GqlContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = resolveValue(value, ctx);
  return out;
}

function typeDescription(name: string): GqlObject | null {
  const kind = TYPE_KIND[name];
  if (kind === undefined) return null;
  const fields = (TYPE_FIELDS[name] ?? []).map((field) => ({ __typename: '__Field', name: field }));
  const enumValues = (ENUM_VALUES[name] ?? []).map((value) => ({ __typename: '__EnumValue', name: value }));
  return { __typename: '__Type', name, kind, fields, enumValues };
}

function decodeGlobalId(id: unknown): { type: string; parts: string[] } | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    const type = parts.shift();
    if (type === undefined || parts.length === 0) return null;
    return { type, parts };
  } catch {
    return null;
  }
}

function repoByDbId(store: Store, id: number): Repo | undefined {
  for (const repo of store.listRepos()) if (repo.id === id) return repo;
  return undefined;
}

function userObject(): GqlObject {
  return { __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
}

function repoObject(repo: Repo): GqlObject {
  return { __typename: 'Repository', __repo: repo };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}

function pullObject(repo: Repo, pull: Pull): GqlObject {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function cursorIndex(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1]!, 10) : -1;
  } catch {
    return -1;
  }
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  let issues = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state)));
    issues = issues.filter((issue) => wanted.has(issueState(issue)));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const field = String(orderBy.field ?? 'CREATED_AT');
  const direction = String(orderBy.direction ?? 'DESC');
  issues.sort((a, b) => {
    let cmp = 0;
    if (field === 'COMMENTS') cmp = a.comments.length - b.comments.length;
    else if (field === 'UPDATED_AT') cmp = a.updatedOrder - b.updatedOrder;
    else cmp = a.createdOrder - b.createdOrder;
    if (cmp === 0) cmp = a.number - b.number;
    return direction === 'ASC' ? cmp : -cmp;
  });
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : issues.length;
  const afterIndex = cursorIndex(args.after);
  const start = afterIndex + 1;
  const page = issues.slice(start, start + first);
  const endCursor = page.length > 0 ? cursorFor(start + page.length - 1) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueObject(repo, issue)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + page.length < issues.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorFor(start) : null,
      endCursor,
    },
    totalCount: issues.length,
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  const pulls = [...repo.pulls.values()].sort((a, b) => b.createdOrder - a.createdOrder);
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : pulls.length;
  const page = pulls.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullObject(repo, pull)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: page.length < pulls.length,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: null,
    },
    totalCount: pulls.length,
  };
}

/** Resolve one field of an object; returns the raw value (sub-selections applied by the caller). */
function resolveField(typename: string, name: string, object: GqlObject, args: Record<string, unknown>, ctx: GqlContext): unknown {
  const store = ctx.store;
  if (typename === 'Query') {
    if (name === 'viewer') return userObject();
    if (name === 'repository') {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repoObject(repo);
    }
    if (name === 'node') {
      const decoded = decodeGlobalId(args.id);
      if (decoded === null) return null;
      if (decoded.type === 'Repository') {
        const repo = repoByDbId(store, Number(decoded.parts[0]));
        return repo === undefined ? null : repoObject(repo);
      }
      return null;
    }
    if (name === '__type') return typeDescription(String(args.name ?? ''));
    if (name === '__schema') return { __typename: '__Schema', types: [] };
    return null;
  }
  if (typename === 'Mutation') {
    if (name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(input.repositoryId);
      if (decoded === null || decoded.type !== 'Repository') throw new StoreError(422, 'createIssue needs a repository id');
      const repo = repoByDbId(store, Number(decoded.parts[0]));
      if (repo === undefined) throw new StoreError(404, 'repository not found');
      const issue = store.createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
      return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue) };
    }
    if (name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(input.issueId);
      if (decoded === null || decoded.type !== 'Issue') throw new StoreError(422, 'closeIssue needs an issue id');
      const repo = repoByDbId(store, Number(decoded.parts[0]));
      const issue = repo?.issues.get(Number(decoded.parts[1]));
      if (repo === undefined || issue === undefined) throw new StoreError(404, 'issue not found');
      issue.state = 'closed';
      issue.updatedAt = store.nextIso();
      issue.updatedOrder = store.nextOrder();
      return { __typename: 'CloseIssuePayload', issue: issueObject(repo, issue) };
    }
    if (name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(input.repositoryId);
      if (decoded === null || decoded.type !== 'Repository') throw new StoreError(422, 'createPullRequest needs a repository id');
      const repo = repoByDbId(store, Number(decoded.parts[0]));
      if (repo === undefined) throw new StoreError(404, 'repository not found');
      const pull = store.createPull(repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull) };
    }
    if (name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(input.pullRequestId);
      if (decoded === null || decoded.type !== 'PullRequest') throw new StoreError(422, 'mergePullRequest needs a pull request id');
      const repo = repoByDbId(store, Number(decoded.parts[0]));
      const pull = repo?.pulls.get(Number(decoded.parts[1]));
      if (repo === undefined || pull === undefined) throw new StoreError(404, 'pull request not found');
      store.mergePull(repo, pull, String(input.mergeMethod ?? 'SQUASH'));
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(repo, pull) };
    }
    if (name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(input.subjectId);
      if (decoded === null || decoded.type !== 'Issue') throw new StoreError(422, 'addComment needs an issue id');
      const repo = repoByDbId(store, Number(decoded.parts[0]));
      const issue = repo?.issues.get(Number(decoded.parts[1]));
      if (repo === undefined || issue === undefined) throw new StoreError(404, 'issue not found');
      const comment = store.createComment(repo, issue, String(input.body ?? ''));
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: {
            __typename: 'IssueComment',
            id: Buffer.from(`IssueComment:${repo.id}:${issue.number}:${comment.id}`, 'utf8').toString('base64url'),
            body: comment.body,
          },
        },
      };
    }
    return null;
  }
  if (typename === 'Repository') {
    const repo = object.__repo as Repo;
    switch (name) {
      case 'id': return repoGlobalId(repo);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'owner': return userObject();
      case 'defaultBranchRef': {
        const tip = store.branchTip(repo, repo.defaultBranch);
        return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch };
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'description': return repo.description;
      case 'url': return `https://github.com/${repo.owner}/${repo.name}`;
      case 'createdAt': return repo.createdAt;
      case 'issue': {
        const issue = repo.issues.get(Number(args.number));
        return issue === undefined ? null : issueObject(repo, issue);
      }
      case 'issues': return issuesConnection(repo, args);
      case 'pullRequests': return pullsConnection(repo, args);
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(args.number));
        return pull === undefined ? null : pullObject(repo, pull);
      }
      default: return null;
    }
  }
  if (typename === 'Issue') {
    const repo = object.__repo as Repo;
    const issue = object.__issue as Issue;
    switch (name) {
      case 'id': return issueGlobalId(repo, issue);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issueState(issue);
      case 'body': return issue.body;
      case 'createdAt': return issue.createdAt;
      case 'updatedAt': return issue.updatedAt;
      case 'url': return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'author': return userObject();
      default: return null;
    }
  }
  if (typename === 'PullRequest') {
    const repo = object.__repo as Repo;
    const pull = object.__pull as Pull;
    switch (name) {
      case 'id': return pullGlobalId(repo, pull);
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'state': return pullState(pull);
      case 'merged': return pull.merged;
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'mergeable': return store.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      case 'body': return pull.body;
      case 'createdAt': return pull.createdAt;
      case 'updatedAt': return pull.updatedAt;
      case 'url': return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'files': {
        const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : undefined;
        const files = store.pullFiles(repo, pull).map((file) => ({
          __typename: 'PullRequestChangedFile',
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
        }));
        const nodes = first === undefined ? files : files.slice(0, first);
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes,
          pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        };
      }
      default: return null;
    }
  }
  if (typename === 'IssueConnection' || typename === 'PullRequestConnection' || typename === 'PullRequestChangedFileConnection') {
    if (name === 'nodes') return (object.nodes as unknown[]) ?? [];
    if (name === 'pageInfo') return object.pageInfo ?? null;
    if (name === 'totalCount') return object.totalCount ?? null;
    return null;
  }
  if (typename === 'PageInfo') {
    return (object as Record<string, unknown>)[name] ?? null;
  }
  if (typename === 'User') {
    return (object as Record<string, unknown>)[name] ?? null;
  }
  if (typename === 'Ref') {
    return name === 'name' ? (object as Record<string, unknown>).name ?? null : null;
  }
  if (typename === '__Type') {
    if (name === 'fields') return (object.fields as unknown[]) ?? [];
    if (name === 'enumValues') return (object.enumValues as unknown[]) ?? [];
    return (object as Record<string, unknown>)[name] ?? null;
  }
  if (typename === '__Field' || typename === '__EnumValue' || typename === '__InputValue') {
    return (object as Record<string, unknown>)[name] ?? null;
  }
  // Payload objects (createIssue, closeIssue, ...) and edges expose their fields directly.
  return (object as Record<string, unknown>)[name] ?? null;
}

/** Apply sub-selections to a resolved value. */
function applySelections(value: unknown, field: GqlField, ctx: GqlContext): unknown {
  if (field.selections === null) return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => applySelections(entry, field, ctx));
  if (typeof value === 'object') {
    const object = value as GqlObject;
    const typename = object.__typename ?? 'Object';
    return executeSelections(field.selections, typename, object, ctx);
  }
  return value;
}

function executeSelections(
  selections: GqlSelection[],
  typename: string,
  object: GqlObject,
  ctx: GqlContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments[selection.name];
      if (fragment) Object.assign(out, executeSelections(fragment, typename, object, ctx));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typename) {
        Object.assign(out, executeSelections(selection.selections, typename, object, ctx));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const known = TYPE_FIELDS[typename]?.includes(selection.name) ?? false;
    if (!known) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typename}".` });
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolveField(typename, selection.name, object, resolveArgs(selection.args, ctx), ctx);
    } catch (err) {
      if (err instanceof StoreError) {
        ctx.errors.push({ message: err.message });
        out[key] = null;
        continue;
      }
      throw err;
    }
    out[key] = applySelections(value, selection, ctx);
  }
  return out;
}

function executeOperation(document: GqlDocument, operation: GqlOperation, store: Store, variables: Record<string, unknown>): { data: unknown; errors?: { message: string }[] } {
  const ctx: GqlContext = { store, variables, errors: [], fragments: document.fragments };
  // Apply variable defaults for missing variables.
  for (const [name, spec] of Object.entries(operation.variables)) {
    if (ctx.variables[name] === undefined && spec.default !== undefined) {
      ctx.variables[name] = resolveValue(spec.default, ctx);
    }
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __typename: rootType };
  const data = executeSelections(operation.selections, rootType, root, ctx);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

// ---------------------------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------------------------

export interface GraphQLRequest {
  body: Buffer;
  json: unknown;
  jsonError: boolean;
}

/** Handle one POST /api/graphql. Returns the JSON value to send (object or array). */
export function handleGraphQL(store: Store, request: GraphQLRequest): { status: number; json: unknown } {
  if (request.jsonError) {
    return { status: 400, json: { errors: [{ message: 'Malformed JSON body' }] } };
  }
  const body = request.json;
  const operations: { query: string; variables?: Record<string, unknown>; operationName?: string }[] = [];
  if (Array.isArray(body)) {
    for (const entry of body) {
      if (entry !== null && typeof entry === 'object' && typeof (entry as Record<string, unknown>).query === 'string') {
        operations.push(entry as { query: string; variables?: Record<string, unknown>; operationName?: string });
      } else {
        operations.push({ query: '' });
      }
    }
  } else if (body !== null && typeof body === 'object' && typeof (body as Record<string, unknown>).query === 'string') {
    operations.push(body as { query: string; variables?: Record<string, unknown>; operationName?: string });
  } else {
    return { status: 400, json: { errors: [{ message: 'GraphQL body must carry a query string' }] } };
  }
  const results = operations.map((entry) => {
    let document: GqlDocument;
    try {
      document = new Parser(entry.query).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    if (document.operations.length === 0) {
      return { data: null, errors: [{ message: 'No operation in GraphQL document' }] };
    }
    let operation = document.operations[0]!;
    if (entry.operationName !== undefined) {
      const named = document.operations.find((candidate) => candidate.name === entry.operationName);
      if (named !== undefined) operation = named;
    }
    const variables = entry.variables ?? {};
    try {
      return executeOperation(document, operation, store, { ...variables });
    } catch (err) {
      if (err instanceof StoreError) {
        return { data: null, errors: [{ message: err.message }] };
      }
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  });
  return { status: 200, json: Array.isArray(body) ? results : results[0] };
}
