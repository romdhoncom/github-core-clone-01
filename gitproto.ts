// gitproto.ts — git smart HTTP: info/refs (v0 + v2), upload-pack (v2 ls-refs/fetch,
// v0 fetch), receive-pack (v0, report-status in sideband). Packfiles are built and parsed
// here, in-process, with no git binary.

import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  collectReachable,
  decodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  pktLinesToStrings,
  readPack,
  writePack,
  type GitObject,
  type Pkt,
} from './gitobj.ts';
import { Store, VIEWER, type Repo } from './store.ts';

export interface GitRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

function buf(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

function json404(message: string): GitResponse {
  return { status: 404, contentType: 'application/json', body: buf(JSON.stringify({ message })) };
}

function json400(message: string): GitResponse {
  return { status: 400, contentType: 'application/json', body: buf(JSON.stringify({ message })) };
}

/** All refs of a repository, sorted: heads first, then tags, each by name. */
function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  refs.sort((a, b) => {
    const aHead = a.name.startsWith('refs/heads/') ? 0 : 1;
    const bHead = b.name.startsWith('refs/heads/') ? 0 : 1;
    if (aHead !== bHead) return aHead - bHead;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return refs;
}

/** The commit an annotated tag peels to, or null. */
function peeledCommit(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  try {
    const tag = parseTag(object.data);
    const target = repo.objects.get(tag.object);
    if (target && target.type === 'commit') return tag.object;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress symref=HEAD:refs/heads/main'
      : 'report-status side-band-64k delete-refs ofs-delta';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const mainTip = repo.refs.get('refs/heads/main');
    if (mainTip !== undefined) {
      parts.push(pktLine(`${mainTip} HEAD\0${caps}\n`));
    }
    let first = mainTip === undefined;
    for (const ref of refs) {
      const line = first ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      first = false;
      parts.push(pktLine(line));
      const peeled = peeledCommit(repo, ref.oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// fetch set computation
// ---------------------------------------------------------------------------------------------

export interface FetchPlan {
  /** Objects to send, in a stable order. */
  objects: GitObject[];
  /** New shallow boundaries (commits whose parents stay behind). */
  shallow: string[];
  /** Old shallow boundaries that are filled in by this fetch. */
  unshallow: string[];
}

/**
 * The object set for a v2/v0 fetch: reachable from the wants within `depth` generations
 * (undefined = the whole history), minus what the haves already hold. With `deepenRelative`
 * the depth adds to the client's current shallow depth instead of replacing it.
 */
export function computeFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  oldShallow: string[],
  depth: number | undefined,
  deepenRelative = false,
): FetchPlan {
  const objects = repo.objects;
  const lookup = (oid: string): GitObject | undefined => objects.get(oid);

  // Resolve the wants: tag objects ride along; their targets are the want commits.
  const tagObjects: GitObject[] = [];
  const wantCommits: string[] = [];
  for (const want of wants) {
    const object = objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      tagObjects.push(object);
      const target = parseTag(object.data).object;
      const peeled = objects.get(target);
      if (peeled && peeled.type === 'commit') wantCommits.push(target);
      else if (peeled && peeled.type === 'tag') wantCommits.push(target);
    } else if (object.type === 'commit') {
      wantCommits.push(want);
    }
  }

  // Breadth-first commit distances from the wants.
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const commit of wantCommits) {
    if (!distance.has(commit)) {
      distance.set(commit, 0);
      queue.push(commit);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++]!;
    const dist = distance.get(oid)!;
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!distance.has(parent)) {
        distance.set(parent, dist + 1);
        queue.push(parent);
      }
    }
  }

  // Effective depth: with deepen-relative the requested depth adds to the client's current
  // shallow depth (one more than the distance from a want to its shallow boundary).
  let effectiveDepth = depth;
  if (depth !== undefined && deepenRelative && oldShallow.length > 0) {
    let oldDepth = 0;
    for (const oid of oldShallow) {
      const dist = distance.get(oid);
      if (dist !== undefined) oldDepth = Math.max(oldDepth, dist + 1);
    }
    if (oldDepth > 0) effectiveDepth = depth + oldDepth;
  }

  const included = new Set<string>();
  const boundary = new Set<string>();
  for (const [oid, dist] of distance) {
    if (effectiveDepth === undefined || dist < effectiveDepth) {
      included.add(oid);
      if (effectiveDepth !== undefined && dist === effectiveDepth - 1) {
        const object = objects.get(oid);
        if (object && object.type === 'commit' && parseCommit(object.data).parents.length > 0) {
          boundary.add(oid);
        }
      }
    }
  }

  // Everything the haves already hold (full reachability, no depth limit) — except that a
  // have sitting on a shallow boundary does NOT imply its parents: the client never received
  // them, so they must stay sendable for a deepen.
  let haveReachable = new Set<string>();
  if (haves.length > 0) {
    try {
      haveReachable = collectReachable(haves, lookup, new Set(oldShallow));
    } catch {
      haveReachable = new Set<string>();
    }
  }

  // The objects to send: each included commit plus its tree closure, and the tag objects.
  const send = new Map<string, GitObject>();
  for (const oid of included) {
    const object = objects.get(oid);
    if (!object) continue;
    send.set(oid, object);
    const commit = parseCommit(object.data);
    const treeClosure = new Set<string>();
    const treeQueue: string[] = [commit.tree];
    while (treeQueue.length > 0) {
      const treeOid = treeQueue.pop()!;
      if (treeClosure.has(treeOid)) continue;
      treeClosure.add(treeOid);
      const treeObject = objects.get(treeOid);
      if (!treeObject || treeObject.type !== 'tree') continue;
      for (const entry of parseTree(treeObject.data)) {
        if (entry.mode === '160000') continue;
        if (entry.mode === '40000') treeQueue.push(entry.oid);
        else {
          const blob = objects.get(entry.oid);
          if (blob) treeClosure.add(entry.oid);
        }
      }
    }
    for (const treeOid of treeClosure) {
      const treeObject = objects.get(treeOid);
      if (treeObject) send.set(treeOid, treeObject);
    }
  }
  for (const tag of tagObjects) send.set(hashObject('tag', tag.data), tag);
  for (const oid of haveReachable) send.delete(oid);

  const delivered = new Set(send.keys());
  const deliveredPlusHeld = new Set([...delivered, ...haveReachable]);

  // Shallow bookkeeping: new boundaries, plus old boundaries that are still shallow, and
  // old boundaries whose parents are now all present (unshallow).
  const shallow = new Set<string>(boundary);
  const unshallow = new Set<string>();
  const clientCommits = new Set([...wantCommits, ...haves, ...included]);
  for (const old of oldShallow) {
    if (!clientCommits.has(old)) continue;
    const object = objects.get(old);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0) continue;
    if (parents.every((parent) => deliveredPlusHeld.has(parent))) unshallow.add(old);
    else shallow.add(old);
  }

  // Stable order: commits first (by distance, then oid), then trees, then blobs, then tags.
  const ordered = [...send.values()].sort((a, b) => {
    const rank = (object: GitObject): number => (object.type === 'commit' ? 0 : object.type === 'tag' ? 1 : object.type === 'tree' ? 2 : 3);
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return hashObject(a.type, a.data) < hashObject(b.type, b.data) ? -1 : 1;
  });
  return { objects: ordered, shallow: [...shallow].sort(), unshallow: [...unshallow].sort() };
}

/** Wrap bytes in sideband packets (band 1), chunked so no pkt-line exceeds 65520 bytes. */
function sidebandPackets(data: Buffer, band = 1): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  if (data.length === 0) return parts;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const slice = data.subarray(offset, Math.min(offset + CHUNK, data.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

function handleLsRefs(repo: Repo, lines: string[]): GitResponse {
  const peel = lines.includes('peel');
  const symrefs = lines.includes('symrefs');
  const unborn = lines.includes('unborn');
  const prefixes = lines.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
  const refs = sortedRefs(repo);
  const parts: Buffer[] = [];
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (refs.length === 0) {
    if (unborn && prefixes.length === 0) {
      parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    }
  } else {
    const mainTip = repo.refs.get('refs/heads/main');
    // The HEAD symref line is named "HEAD": it belongs only when no prefix filters it out,
    // or when a prefix matches HEAD itself (as a clone asks for).
    if (mainTip !== undefined && symrefs && (prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p)))) {
      parts.push(pktLine(`${mainTip} HEAD symref-target:refs/heads/main\n`));
    }
    for (const ref of refs) {
      if (!matches(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      const peeled = peel ? peeledCommit(repo, ref.oid) : null;
      if (peeled !== null) line += ` peeled:${peeled}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: UPLOAD_RESULT, body: Buffer.concat(parts) };
}

function handleFetchV2(repo: Repo, lines: string[]): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let deepenRelative = false;
  let done = false;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    } else if (line === 'deepen-relative') deepenRelative = true;
    else if (line === 'done') done = true;
  }
  // No wants: a real upload-pack sends nothing at all.
  if (wants.length === 0) {
    return { status: 200, contentType: UPLOAD_RESULT, body: Buffer.alloc(0) };
  }
  // Negotiation round: the client sent haves without "done", so it is waiting for an
  // acknowledgments section and nothing else (unless the server is ready to send the pack).
  if (haves.length > 0 && !done) {
    const common = haves.filter(
      (have) => repo.objects.has(have) && wants.some((want) => isAncestor(repo.objects, have, want)),
    );
    const allCommon = common.length === haves.length;
    const parts: Buffer[] = [pktLine('acknowledgments\n')];
    if (common.length === 0) parts.push(pktLine('NAK\n'));
    else for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
    if (allCommon) {
      // Ready: the packfile follows in this same response, after a delim.
      parts.push(pktLine('ready\n'));
      parts.push(PKT_DELIM);
      appendPackfileSections(repo, wants, haves, shallow, depth, deepenRelative, parts);
    } else {
      parts.push(PKT_FLUSH);
    }
    return { status: 200, contentType: UPLOAD_RESULT, body: Buffer.concat(parts) };
  }
  // Final request (the client sent "done", or it has no haves): the response carries no
  // acknowledgments section at all — the client goes straight to the packfile.
  const parts: Buffer[] = [];
  appendPackfileSections(repo, wants, haves, shallow, depth, deepenRelative, parts);
  return { status: 200, contentType: UPLOAD_RESULT, body: Buffer.concat(parts) };
}

/** The shallow-info (when there is one) and packfile sections of a v2 fetch response. */
function appendPackfileSections(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallow: string[],
  depth: number | undefined,
  deepenRelative: boolean,
  parts: Buffer[],
): void {
  const plan = computeFetch(repo, wants, haves, shallow, depth, deepenRelative);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  // The packfile section is always present, even when it carries an empty pack.
  const pack = writePack(plan.objects);
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack, 1));
  parts.push(PKT_FLUSH);
}

function handleUploadPackV0(repo: Repo, body: Buffer): GitResponse {
  let packets: Pkt[];
  try {
    packets = decodePktLines(body);
  } catch {
    return json400('malformed pkt-line stream');
  }
  const sections: string[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'flush') sections.push([]);
    else if (packet.kind === 'data') sections[sections.length - 1]!.push(packet.payload.toString('utf8'));
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let deepenRelative = false;
  for (const section of sections) {
    for (const line of section) {
      const clean = line.split('\0')[0]!;
      if (clean.startsWith('want ')) wants.push(clean.slice(5).trim());
      else if (clean.startsWith('have ')) haves.push(clean.slice(5).trim());
      else if (clean.startsWith('shallow ')) shallow.push(clean.slice(8).trim());
      else if (clean.startsWith('deepen ')) {
        const n = Number.parseInt(clean.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) depth = n;
      } else if (clean === 'deepen-relative') deepenRelative = true;
    }
  }
  const plan = computeFetch(repo, wants, haves, shallow, depth, deepenRelative);
  const parts: Buffer[] = [];
  let acked = false;
  for (const have of haves) {
    if (repo.objects.has(have) && wants.some((want) => isAncestor(repo.objects, have, want))) {
      parts.push(pktLine(`ACK ${have}\n`));
      acked = true;
    }
  }
  if (acked) parts.push(pktLine('ready\n'));
  else parts.push(pktLine('NAK\n'));
  if (plan.objects.length > 0) {
    parts.push(...sidebandPackets(writePack(plan.objects), 1));
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: UPLOAD_RESULT, body: Buffer.concat(parts) };
}

function handleUploadPack(repo: Repo, body: Buffer): GitResponse {
  let packets: Pkt[];
  try {
    packets = decodePktLines(body);
  } catch {
    return json400('malformed pkt-line stream');
  }
  const lines = pktLinesToStrings(packets).map((line) => line.replace(/\n$/, ''));
  const first = lines[0] ?? '';
  if (first.startsWith('command=')) {
    const command = first.slice('command='.length).trim();
    if (command === 'ls-refs') return handleLsRefs(repo, lines.slice(1));
    if (command === 'fetch') return handleFetchV2(repo, lines.slice(1));
    return json400(`unknown upload-pack command ${command}`);
  }
  return handleUploadPackV0(repo, body);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): GitResponse {
  // The command list is pkt-lines up to the first flush; everything after it is the raw
  // pack, which must NOT be parsed as pkt-lines (it is binary).
  const commandLines: string[] = [];
  let cursor = 0;
  let packStart = body.length;
  let foundFlush = false;
  while (cursor + 4 <= body.length) {
    const lenHex = body.subarray(cursor, cursor + 4).toString('ascii');
    if (lenHex === '0000') {
      packStart = cursor + 4;
      foundFlush = true;
      break;
    }
    const len = Number.parseInt(lenHex, 16);
    if (!Number.isFinite(len) || len < 4 || cursor + len > body.length) {
      return json400('malformed pkt-line stream');
    }
    commandLines.push(body.subarray(cursor + 4, cursor + len).toString('utf8'));
    cursor += len;
  }
  if (!foundFlush) return json400('push needs at least one command');
  const commands: PushCommand[] = [];
  for (const rawLine of commandLines) {
    const line = rawLine.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const head = nul >= 0 ? line.slice(0, nul) : line;
    const space1 = head.indexOf(' ');
    const space2 = head.indexOf(' ', space1 + 1);
    if (space1 < 0 || space2 < 0) return json400('malformed push command');
    commands.push({
      oldOid: head.slice(0, space1),
      newOid: head.slice(space1 + 1, space2),
      ref: head.slice(space2 + 1),
    });
  }
  if (commands.length === 0) return json400('push needs at least one command');

  const packBytes = body.subarray(packStart);
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackError: string | null = null;
  let pushed = new Map<string, GitObject>();
  if (updatesRef && packBytes.length > 0) {
    try {
      pushed = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  } else if (updatesRef && packBytes.length === 0) {
    unpackError = 'pack is missing';
  }

  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack error\n`);
  } else {
    // Store the unpacked objects first, then judge each ref update against the merged store.
    for (const [oid, object] of pushed) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      if (!command.ref.startsWith('refs/') || !isObjectId(command.oldOid) || !isObjectId(command.newOid)) {
        reportLines.push(`ng ${command.ref} invalid ref\n`);
        continue;
      }
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined || current !== command.oldOid) {
          reportLines.push(`ng ${command.ref} non-fast-forward\n`);
          continue;
        }
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}\n`);
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          reportLines.push(`ng ${command.ref} already exists\n`);
          continue;
        }
        if (!repo.objects.has(command.newOid)) {
          reportLines.push(`ng ${command.ref} object not found\n`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
        continue;
      }
      // Update: old must match the tip and the new tip must descend from it.
      if (current === undefined || current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      const newObject = repo.objects.get(command.newOid);
      if (!newObject) {
        reportLines.push(`ng ${command.ref} object not found\n`);
        continue;
      }
      // A tag update moves the ref to the tag; ancestry is judged on the commit it peels to.
      const peeledNew =
        newObject.type === 'tag' ? parseTag(newObject.data).object : command.newOid;
      const peeledObject = repo.objects.get(peeledNew);
      if (!peeledObject || peeledObject.type !== 'commit' || !isAncestor(repo.objects, command.oldOid, peeledNew)) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    }
  }

  const report = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  const parts = [...sidebandPackets(report, 1), PKT_FLUSH];
  return { status: 200, contentType: RECEIVE_RESULT, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

/** Route one git smart-HTTP request. Returns null when the path is not a git route. */
export function handleGit(store: Store, request: GitRequest): GitResponse | null {
  const segments = request.path.split('/').filter((segment) => segment !== '');
  if (segments.length < 2) return null;
  const repoSegment = segments[1]!;
  if (!repoSegment.endsWith('.git')) return null;
  const owner = decodeURIComponent(segments[0]!);
  const repoName = decodeURIComponent(repoSegment.slice(0, -4));
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return json404(`Repository ${owner}/${repoName} not found`);
  const tail = segments.slice(2).join('/');

  if (request.method === 'GET' && tail === 'info/refs') {
    const service = request.query.get('service') ?? '';
    if (service === 'git-upload-pack') {
      const wantsV2 = (request.headers['git-protocol'] ?? '') === 'version=2';
      if (wantsV2) {
        return { status: 200, contentType: UPLOAD_AD, body: v2Advertisement() };
      }
      return { status: 200, contentType: UPLOAD_AD, body: v0Advertisement(repo, 'git-upload-pack') };
    }
    if (service === 'git-receive-pack') {
      // Receive-pack is v0-only, whatever the client asked for.
      return { status: 200, contentType: RECEIVE_AD, body: v0Advertisement(repo, 'git-receive-pack') };
    }
    return json400(`unknown service ${service}`);
  }
  if (request.method === 'POST' && tail === 'git-upload-pack') {
    return handleUploadPack(repo, request.body);
  }
  if (request.method === 'POST' && tail === 'git-receive-pack') {
    return handleReceivePack(repo, request.body);
  }
  return null;
}

export { VIEWER };
