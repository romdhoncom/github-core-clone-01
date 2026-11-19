// app.ts — the forge's HTTP surface, wired together.
// One Store per process; the token in MAKEFUN_SHOP_TOKEN names the viewer (adaiversen) and is the
// only bearer token accepted. Routes, in order: /healthz (no auth), git smart HTTP, GraphQL,
// MCP, REST v3, then a JSON 404 for everything else.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { Store, StoreError } from './store.ts';
import { handleGit } from './gitproto.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** A push of a hundred files can be large; still, never read without a bound. */
const MAX_BODY_BYTES = 128 * 1024 * 1024;

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Read the request body in full. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy(new Error('request body too large'));
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on port 0. */
export function createApp(): Server {
  const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const store = new Store(shopToken);

  const isAuthorized = (req: IncomingMessage): boolean => {
    if (shopToken === '') return false;
    const header = req.headers.authorization;
    return header === `Bearer ${shopToken}`;
  };

  const sendJson = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): void => {
    const text = `${JSON.stringify(body)}\n`;
    res.writeHead(status, {
      'content-type': JSON_TYPE,
      'content-length': Buffer.byteLength(text),
      'x-github-request-id': store.nextRequestId(),
      ...headers,
    });
    res.end(text);
  };

  const sendNoContent = (res: ServerResponse, headers: Readonly<Record<string, string>> = {}): void => {
    res.writeHead(204, { 'x-github-request-id': store.nextRequestId(), ...headers });
    res.end();
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    // The env's boot check calls this twice: 200 {"ok":true}.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Git smart HTTP at /{owner}/{repo}.git/... — the client always sends the bearer token.
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\//.exec(path);
    if (gitMatch !== null) {
      void readBody(req).then((body) => {
        const outcome = handleGit(store, {
          method,
          path,
          headers: req.headers,
          query: new URL(req.url ?? '/', 'http://entry').searchParams,
          body,
        });
        res.writeHead(outcome.status, {
          'content-type': outcome.contentType,
          'content-length': outcome.body.length,
        });
        res.end(outcome.body);
      }).catch(() => {
        if (!res.headersSent) sendJson(res, 400, { message: 'Bad Request' });
      });
      return;
    }

    // GraphQL v4: POST only, bearer token required (unauthenticated is exactly 401).
    if (path === '/api/graphql') {
      if (method !== 'POST') {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (!isAuthorized(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      void readBody(req).then((body) => {
        let json: unknown = null;
        let jsonError = false;
        if (body.length > 0) {
          try {
            json = JSON.parse(body.toString('utf8'));
          } catch {
            jsonError = true;
          }
        }
        const outcome = handleGraphQL(store, { body, json, jsonError });
        sendJson(res, outcome.status, outcome.json);
      }).catch(() => {
        if (!res.headersSent) sendJson(res, 400, { message: 'Bad Request' });
      });
      return;
    }

    // MCP over Streamable HTTP: POST only, bearer token required.
    if (path === '/mcp') {
      if (method !== 'POST') {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (!isAuthorized(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      void readBody(req).then((body) => {
        const outcome = handleMcp(store, body);
        if (outcome.json === undefined) {
          res.writeHead(outcome.status, { 'x-github-request-id': store.nextRequestId() });
          res.end();
          return;
        }
        sendJson(res, outcome.status, outcome.json);
      }).catch(() => {
        if (!res.headersSent) sendJson(res, 400, { message: 'Bad Request' });
      });
      return;
    }

    // REST v3 under /api/v3: bearer token required.
    if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
      if (!isAuthorized(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      void readBody(req).then((body) => {
        let json: unknown = null;
        let jsonError = false;
        if (body.length > 0) {
          try {
            json = JSON.parse(body.toString('utf8'));
          } catch {
            jsonError = true;
          }
        }
        const url = new URL(req.url ?? '/', 'http://entry');
        let outcome;
        try {
          outcome = handleRest(store, {
            method,
            path,
            query: url.searchParams,
            headers: req.headers,
            body,
            json,
            jsonError,
            baseUrl: `http://${req.headers.host ?? '127.0.0.1'}`,
          });
        } catch (err) {
          // A StoreError carries the HTTP status the wire contract wants (404, 409, 422, ...);
          // anything else is a genuine server fault.
          if (err instanceof StoreError) {
            sendJson(res, err.status, { message: err.message });
            return;
          }
          throw err;
        }
        if (outcome === null) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (outcome.status === 204) {
          sendNoContent(res, outcome.headers ?? {});
          return;
        }
        sendJson(res, outcome.status, outcome.json, outcome.headers ?? {});
      }).catch(() => {
        if (!res.headersSent) sendJson(res, 400, { message: 'Bad Request' });
      });
      return;
    }

    // Everything else, every method: GitHub's 404 body.
    sendJson(res, 404, { message: 'Not Found' });
  });
}
