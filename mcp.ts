// mcp.ts — Model Context Protocol over Streamable HTTP at /mcp.
// JSON-RPC 2.0, modern revision 2026-07-28 (server/discover) and the legacy handshake
// revisions 2025-11-25 and earlier (initialize + notifications/initialized). Every tool
// dispatches into the same store REST and GraphQL use.

import { Store, StoreError } from './store.ts';
import { commentView, issueView, pullView, repoView } from './rest.ts';

export const MCP_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description?: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    properties: {
      name: { type: 'string', description: 'Repository name' },
      description: { type: 'string', description: 'Repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      state: { type: 'string', description: 'Issue state filter: open, closed or all' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'get_issue',
    description: 'Get one issue in a repository by number.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      issue_number: { type: 'integer', description: 'Issue number' },
    },
    required: ['owner', 'repo', 'issue_number'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Pull request title' },
      head: { type: 'string', description: 'Head branch name' },
      base: { type: 'string', description: 'Base branch name' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      state: { type: 'string', description: 'Pull request state filter: open, closed or all' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      pull_number: { type: 'integer', description: 'Pull request number' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolsList(): unknown[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
    },
  }));
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArg(args: Record<string, unknown>, def: ToolDef): string | null {
  for (const name of def.required) {
    const value = args[name];
    if (value === undefined || value === null || (typeof value === 'string' && value === '')) {
      return name;
    }
  }
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOLS.find((tool) => tool.name === name.toLowerCase());
  if (def === undefined) {
    throw { code: -32602, message: `Unknown tool: ${name}` };
  }
  const missing = missingArg(args, def);
  if (missing !== null) return toolError(`Missing required argument: ${missing}`);
  const owner = String(args.owner ?? '');
  const repoName = String(args.repo ?? '');
  try {
    switch (def.name) {
      case 'create_repo': {
        const repo = store.createRepo(String(args.name ?? ''), {
          description: typeof args.description === 'string' ? args.description : '',
          private: args.private === true,
        });
        return toolResult(repoView(repo));
      }
      case 'get_repo': {
        const repo = store.getRepo(owner, repoName);
        if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
        return toolResult(repoView(repo));
      }
      case 'create_issue': {
        const repo = store.getRepo(owner, repoName);
        if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
        const issue = store.createIssue(repo, {
          title: String(args.title ?? ''),
          body: typeof args.body === 'string' ? args.body : '',
        });
        return toolResult(issueView(repo, issue));
      }
      case 'list_issues': {
        const repo = store.getRepo(owner, repoName);
        if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
        const state = typeof args.state === 'string' ? args.state : 'open';
        const issues = [...repo.issues.values()]
          .filter((issue) => state === 'all' || issue.state === state)
          .sort((a, b) => b.createdOrder - a.createdOrder)
          .map((issue) => issueView(repo, issue));
        return toolResult(issues);
      }
      case 'get_issue': {
        const repo = store.getRepo(owner, repoName);
        const issue = repo?.issues.get(Number(args.issue_number));
        if (repo === undefined || issue === undefined) {
          return toolError(`Issue ${owner}/${repoName}#${String(args.issue_number)} not found`);
        }
        return toolResult(issueView(repo, issue));
      }
      case 'create_pull_request': {
        const repo = store.getRepo(owner, repoName);
        if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
        const pull = store.createPull(repo, {
          title: String(args.title ?? ''),
          body: typeof args.body === 'string' ? args.body : '',
          head: String(args.head ?? ''),
          base: String(args.base ?? ''),
        });
        return toolResult(pullView(repo, pull));
      }
      case 'list_pull_requests': {
        const repo = store.getRepo(owner, repoName);
        if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
        const state = typeof args.state === 'string' ? args.state : 'open';
        const pulls = [...repo.pulls.values()]
          .filter((pull) => state === 'all' || (state === 'open' ? pull.state === 'open' && !pull.merged : pull.state !== 'open' || pull.merged))
          .sort((a, b) => b.createdOrder - a.createdOrder)
          .map((pull) => pullView(repo, pull));
        return toolResult(pulls);
      }
      case 'merge_pull_request': {
        const repo = store.getRepo(owner, repoName);
        const pull = repo?.pulls.get(Number(args.pull_number));
        if (repo === undefined || pull === undefined) {
          return toolError(`Pull request ${owner}/${repoName}#${String(args.pull_number)} not found`);
        }
        store.mergePull(repo, pull, 'SQUASH');
        return toolResult(pullView(repo, pull));
      }
      default:
        return toolError(`Tool ${def.name} is not implemented`);
    }
  } catch (err) {
    if (err instanceof StoreError) return toolError(err.message);
    throw err;
  }
}

export interface McpOutcome {
  status: number;
  /** undefined means an empty body. */
  json?: unknown;
}

/** Handle one POST /mcp. The caller has already verified authorization. */
export function handleMcp(store: Store, body: Buffer): McpOutcome {
  let message: unknown;
  try {
    message = JSON.parse(body.toString('utf8'));
  } catch {
    return {
      status: 400,
      json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  const messages = Array.isArray(message) ? message : [message];
  const responses: unknown[] = [];
  for (const request of messages) {
    if (request === null || typeof request !== 'object') {
      responses.push({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      continue;
    }
    const req = request as Record<string, unknown>;
    const method = String(req.method ?? '');
    // A notification has no id: answer 202 with an empty body.
    if (req.id === undefined) {
      if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
        continue;
      }
      continue;
    }
    const id = req.id;
    const params = (req.params ?? {}) as Record<string, unknown>;
    if (method === 'server/discover') {
      responses.push({
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: MCP_REVISIONS,
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
          _meta: {
            'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
          },
        },
      });
      continue;
    }
    if (method === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = MCP_REVISIONS.includes(requested) ? requested : MCP_REVISIONS[0]!;
      responses.push({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        },
      });
      continue;
    }
    if (method === 'ping') {
      responses.push({ jsonrpc: '2.0', id, result: {} });
      continue;
    }
    if (method === 'tools/list') {
      responses.push({ jsonrpc: '2.0', id, result: { tools: toolsList() } });
      continue;
    }
    if (method === 'tools/call') {
      const name = String(params.name ?? '');
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = callTool(store, name, args);
        responses.push({ jsonrpc: '2.0', id, result });
      } catch (err) {
        if (err !== null && typeof err === 'object' && 'code' in err) {
          const coded = err as { code: number; message: string };
          responses.push({ jsonrpc: '2.0', id, error: { code: coded.code, message: coded.message } });
        } else {
          responses.push({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } });
        }
      }
      continue;
    }
    responses.push({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
  // A batch made only of notifications has no responses.
  if (responses.length === 0) return { status: 202 };
  if (Array.isArray(message)) return { status: 200, json: responses };
  return { status: 200, json: responses[0] };
}
