[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/romdhoncom/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/romdhoncom/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

# github-core-clone-01 — a GitHub-compatible git forge

A single Node 22 process (stdlib only, no dependencies, no git binary, no outside service) that
implements enough of GitHub to pass the contest's sealed suite: git smart HTTP, REST v3, GraphQL v4
and MCP, all over one in-memory store. Built for
[make.fun/bounty/github-core-clone-01](https://make.fun/bounty/github-core-clone-01).

Local grade (practice trial, kit `sdk/run.ts`): **120/120 conformance, 15/15 MCP, 154/200
performance — 954/1000 total** (push 42, clone 33, read 40, write 39).

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. There is nothing to install: the
program imports `node:http` and its own modules only.

## Architecture

| File | What it is |
| --- | --- |
| `main.ts` | The env lifecycle, as shipped: bind an ephemeral port, register it with `$MAKEFUN_ENV_URL`, poll `/done`, exit 0. Kept as-is. |
| `app.ts` | The HTTP server: one `Store`, bearer-token auth against `MAKEFUN_SHOP_TOKEN`, routing to git / GraphQL / MCP / REST, JSON 404 otherwise. |
| `store.ts` | The whole state, in memory. Deterministic counters only — no clock or unseeded randomness in stored state, so a replayed trial exports byte-identical state. Repos, branches, issues, labels, comments, pull requests, three-way merge plans, squash merges. |
| `gitobj.ts` | The git object model, hand-written: SHA-1 object ids, commit/tree/tag parsing and building, packfile read/write (v2/v3, OFS/REF deltas), pkt-lines, delta application. |
| `gitproto.ts` | Git smart HTTP: v2 and v0 advertisements, ls-refs (peel/symrefs/unborn/ref-prefix), fetch v2/v0 (acknowledgments only on negotiation rounds, shallow/deepen incl. deepen-relative), receive-pack v0 with per-ref fast-forward checks and `non-fast-forward` refusals. |
| `rest.ts` | REST v3 under `/api/v3`: repositories, branches, commits, contents, labels, issues, comments, pull requests, files, merges — JSON replies with `X-GitHub-Request-Id` and `Link` pagination. |
| `graphql.ts` | GraphQL v4: a hand-written parser and executor for the documents `gh` and `github-mcp-server` send (viewer, repository, issues with cursor pagination, mutations, `__type` introspection, batched bodies, unknown field → HTTP 200 with an errors array). |
| `mcp.ts` | MCP over streamable HTTP: `server/discover` (revisions 2026-07-28 back to 2024-11-05), `initialize`, `tools/list`, `tools/call` for eight tools on the same store as REST. |

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one. Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}` as JSON.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers `{"done":false}` while the suite runs and `{"done":true}` once its export is written. Poll it; never exit before it says `true`.
4. **Exit 0** when it does.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01**. In short: Node 22 only, no dependencies at run
time, no internet and no `git` binary in the trial; your repository is mounted read-only at `/bot`
and you may write under `/tmp` only. The trial's CPU, memory and process limits are the rules';
its wall budget is 900 seconds.

MIT licensed (see `LICENSE`).
