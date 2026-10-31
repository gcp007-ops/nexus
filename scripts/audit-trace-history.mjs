#!/usr/bin/env node
/**
 * Standalone, read-only diagnostic. No plugin imports, network, cache or writes.
 * Only aggregate counts and workspace directory identifiers leave this process.
 * Originals are ALWAYS preservation-required; matching a write body proves only
 * that body's current-file equality, never recoverability of the whole trace.
 */
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const LINE_LIMIT = 128 * 1024 * 1024;
const IDENTITY_LIMIT = 1_000_000;
const LARGE_LINE = 65536;
const METADATA_TARGET = 16384;
// Kept identical to ShardedJsonlStreamStore.ts; canonical matching comes first.
const SHARD = /^shard-(\d+)\.jsonl$/;
const CONFLICT = /^shard-(\d+)(?:[ _]?\w*?(\(.+?\)|\[.+?\])|[ _]+(\d+))\.jsonl$/;
const decoder = new TextDecoder('utf-8', { fatal: true });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const byteLength = value => Buffer.byteLength(value, 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');

function metrics() {
  return {
    rawBytes: 0, scannedBytes: 0, files: 0, conflictFiles: 0, lines: 0, blankLines: 0, records: 0,
    traceRecords: 0, traceRawLineBytes: 0, oversizedRecords: 0,
    traceOversizedRecords: 0, nonTraceOversizedRecords: 0,
    unclassifiedOversizedLines: 0, malformedJsonLines: 0, invalidUtf8Lines: 0,
    malformedEventLines: 0, malformedMetadataRecords: 0, missingMetadataRecords: 0,
    skippedOversizedLines: 0, skippedOversizedLineBytes: 0,
    metadataUtf8Bytes: 0, metadataEncodedBytes: 0, logicalMetadataExcessBytes: 0,
    metadataScenarioCandidateRecords: 0, metadataScenarioLowerBytes: 0,
    metadataScenarioUpperBytes: 0,
  };
}
function preservation() {
  return {
    tracesRequiringOriginalPreservation: 0, exactCurrentFileMatch: 0,
    changed: 0, missing: 0, unsafeOrUnreadable: 0, unverified: 0, unsupported: 0,
    duplicateBodyOccurrences: 0, distinctBodiesRequiringFirstCopy: 0,
    bodyIdentityUnverifiedOccurrences: 0,
  };
}
function identity() {
  return { exactDuplicateRecords: 0, divergentEventIds: 0,
    recordsWithoutEnvelopeId: 0, identityUnverifiedRecords: 0,
    ambiguous: false, complete: true };
}
function sumObjects(items, factory) {
  const result = factory();
  for (const item of items) for (const key of Object.keys(result)) {
    if (typeof result[key] === 'number') result[key] += item[key];
  }
  return result;
}
function shardKind(name) {
  const canonical = name.match(SHARD);
  const match = canonical || name.match(CONFLICT);
  if (!match || !Number.isInteger(Number(match[1])) || Number(match[1]) <= 0) return null;
  return canonical ? 'canonical' : 'conflict';
}
function confined(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
async function directoryRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  try {
    const resolved = path.resolve(value);
    const stat = await lstat(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return await realpath(resolved);
  } catch { return null; }
}

// The digest is internal. Sorted keys distinguish canonical object versions,
// ignoring insignificant object key ordering but preserving array ordering.
function canonicalDigest(value) {
  const digest = createHash('sha256');
  function visit(node) {
    if (Array.isArray(node)) {
      digest.update('[');
      node.forEach((item, index) => { if (index) digest.update(','); visit(item); });
      digest.update(']');
    } else if (isObject(node)) {
      digest.update('{');
      Object.keys(node).sort().forEach((key, index) => {
        if (index) digest.update(',');
        digest.update(JSON.stringify(key) + ':');
        visit(node[key]);
      });
      digest.update('}');
    } else digest.update(JSON.stringify(node));
  }
  visit(value);
  return digest.digest('hex');
}

// JSON.parse has already validated this line. Locate the final direct property
// token (matching JSON.parse's duplicate-key behavior) without normalizing its
// original escaping. No source token or digest appears in the output.
function valueEnd(text, start) {
  if (text[start] === '"') {
    let index = start + 1;
    while (index < text.length) {
      if (text[index] === '\\') index += 2;
      else if (text[index++] === '"') return index;
    }
  }
  if (text[start] === '{' || text[start] === '[') {
    let depth = 0;
    for (let index = start; index < text.length; index++) {
      if (text[index] === '"') { index = valueEnd(text, index) - 1; continue; }
      if (text[index] === '{' || text[index] === '[') depth++;
      if ((text[index] === '}' || text[index] === ']') && --depth === 0) return index + 1;
    }
  }
  let end = start;
  while (end < text.length && !/[\s,}\]]/.test(text[end])) end++;
  return end;
}
function propertySpan(text, start, name) {
  if (text[start] !== '{') return null;
  let index = start + 1, found = null;
  while (index < text.length) {
    while (/[\s,]/.test(text[index] ?? '') && index < text.length) index++;
    if (text[index] === '}') break;
    const keyEnd = valueEnd(text, index);
    const key = JSON.parse(text.slice(index, keyEnd));
    index = keyEnd;
    while (/\s/.test(text[index] ?? '') && index < text.length) index++;
    index++; // colon
    while (/\s/.test(text[index] ?? '') && index < text.length) index++;
    const end = valueEnd(text, index);
    if (key === name) found = { start: index, end };
    index = end;
  }
  return found;
}
function encodedMetadataBytes(text) {
  const start = text.search(/\S/);
  const data = propertySpan(text, start, 'data');
  const metadata = data && propertySpan(text, data.start, 'metadataJson');
  return metadata ? byteLength(text.slice(metadata.start, metadata.end)) : 0;
}

/**
 * Deliberately strict subset of the actual ToolCliNormalizer tokenizer:
 * two named flags, no escapes, commas/batches, embedded/concatenated quotes,
 * extra flags, inline equals, or positional arguments. These are unsupported,
 * never guessed. Quoted strings may contain whitespace, including newlines.
 */
function strictCliWrite(command) {
  if (typeof command !== 'string' || /[\\,]/.test(command)) return null;
  const tokens = [];
  let index = 0;
  while (index < command.length) {
    while (/\s/.test(command[index] ?? '') && index < command.length) index++;
    if (index >= command.length) break;
    const quote = command[index] === '"' || command[index] === "'" ? command[index++] : null;
    const start = index;
    if (quote) {
      while (index < command.length && command[index] !== quote) index++;
      if (index >= command.length) return null;
      tokens.push({ value: command.slice(start, index++), quoted: true });
      if (index < command.length && !/\s/.test(command[index])) return null;
    } else {
      while (index < command.length && !/\s/.test(command[index])) index++;
      const value = command.slice(start, index);
      if (/["']/.test(value)) return null;
      tokens.push({ value, quoted: false });
    }
  }
  if (tokens.length !== 6 || tokens[0].quoted || tokens[1].quoted ||
      tokens[0].value !== 'content' || tokens[1].value !== 'write') return null;
  const args = {};
  for (let index = 2; index < 6; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (flag.quoted || !['--path', '--content'].includes(flag.value) ||
        (!value.quoted && value.value.startsWith('--')) || Object.hasOwn(args, flag.value)) return null;
    args[flag.value] = value.value;
  }
  return { path: args['--path'], content: args['--content'] };
}
function writeBody(metadata) {
  if (!isObject(metadata)) return null;
  const tool = metadata.tool;
  const direct = isObject(tool) && tool.agent === 'contentManager' && tool.mode === 'write';
  const legacy = ['contentManager_write', 'contentManager.write'].includes(tool);
  if (direct || legacy) {
    // Only these known argument locations are evidence. Legacy result/state
    // objects are intentionally never searched for arbitrary path/content pairs.
    const args = direct ? metadata.input?.arguments : metadata.params;
    if (isObject(args) && typeof args.path === 'string' && typeof args.content === 'string') return args;
  }
  const wrapper = isObject(tool) ? tool.agent === 'toolManager' && ['useTools', 'useTool'].includes(tool.mode)
    : ['toolManager_useTools', 'toolManager_useTool', 'toolManager.useTools', 'toolManager.useTool'].includes(tool);
  if (wrapper) return strictCliWrite((isObject(tool) ? metadata.input?.arguments : metadata.params)?.tool);
  return null;
}

async function compareBody(vaultRoot, body) {
  const notePath = body.path;
  // Apply both Windows and POSIX rejection rules on every host. No drive paths,
  // UNC, traversal, alternate streams, empty segments, or Windows aliases.
  if (!notePath || path.posix.isAbsolute(notePath) || path.win32.isAbsolute(notePath) ||
      /[:\0]/.test(notePath)) return 'unsafeOrUnreadable';
  const parts = notePath.split(/[\\/]/);
  if (parts.some(part => !part || part === '..' || part === '.' || /[. ]$/.test(part))) return 'unsafeOrUnreadable';
  if (!vaultRoot) return 'unverified';
  let target = vaultRoot;
  try {
    for (let index = 0; index < parts.length; index++) {
      target = path.join(target, parts[index]);
      const stat = await lstat(target);
      if (stat.isSymbolicLink() || !confined(vaultRoot, await realpath(target))) return 'unsafeOrUnreadable';
      if (index < parts.length - 1 && !stat.isDirectory()) return 'unsafeOrUnreadable';
      if (index === parts.length - 1 && !stat.isFile()) return 'unsafeOrUnreadable';
    }
    // Read via a handle, then recheck path identity to fail closed on ordinary
    // concurrent replacements. No claim of an atomic filesystem snapshot.
    const handle = await open(target, 'r');
    try {
      const before = await handle.stat();
      if (before.size !== byteLength(body.content)) return 'changed';
      const digest = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
      const after = await handle.stat();
      const current = await lstat(target);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || current.isSymbolicLink() ||
          current.ino !== before.ino || current.dev !== before.dev || !confined(vaultRoot, await realpath(target))) return 'unsafeOrUnreadable';
      return digest.digest('hex') === hash(body.content) ? 'exactCurrentFileMatch' : 'changed';
    } finally { await handle.close(); }
  } catch (error) { return error?.code === 'ENOENT' ? 'missing' : 'unsafeOrUnreadable'; }
}

async function fileDigest(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

/** Streaming bounded line reader. Delimiters are excluded from line metrics. */
async function scanLines(file, maxLineBytes, callback) {
  const digest = createHash('sha256');
  let chunks = [], length = 0, lastByte = -1, rawBytes = 0;
  async function finish(hasNewline) {
    const lineBytes = length - (hasNewline && lastByte === 13 ? 1 : 0);
    const skipped = lineBytes > maxLineBytes;
    const bytes = skipped ? null : Buffer.concat(chunks, length).subarray(0, lineBytes);
    await callback(bytes, lineBytes, skipped);
    chunks = []; length = 0; lastByte = -1;
  }
  for await (const chunk of createReadStream(file)) {
    digest.update(chunk); rawBytes += chunk.length;
    let start = 0;
    for (let index = 0; index <= chunk.length; index++) {
      if (index !== chunk.length && chunk[index] !== 10) continue;
      const part = chunk.subarray(start, index);
      const previousLength = length;
      length += part.length;
      if (part.length) lastByte = part[part.length - 1];
      if (previousLength <= maxLineBytes && length <= maxLineBytes + 1) chunks.push(part);
      else if (length > maxLineBytes + 1) chunks = [];
      if (index < chunk.length) await finish(true);
      start = index + 1;
    }
  }
  if (length) await finish(false);
  return { digest: digest.digest('hex'), rawBytes };
}

/** Options are also exported for synthetic tests; CLI exposes roots only. */
export async function auditHistory({ dataRoot, vaultRoot, maxLineBytes = LINE_LIMIT } = {}) {
  const report = {
    schemaVersion: 1, partial: false, errors: [], sourceUnchanged: false,
    verificationCoverage: 'regular files under workspaces; before/after content digests and inventory; no atomic snapshot',
    discovery: { regularFiles: 0, regularBytes: 0, recognizedFiles: 0, recognizedBytes: 0,
      ignoredFiles: 0, ignoredBytes: 0, unsafeEntries: 0 },
    streams: [], totals: null,
    policy: {
      archiveOriginalTracesRequired: true,
      uniqueScope: 'physical stream: flat file or shard parent directory; distinct divergent versions retained; unidentified occurrences retained',
      uniqueMetrics: 'record metrics only; disk bytes and file metrics are physical',
      preservationScope: 'physical trace occurrences; body identity scoped to stream; first copy of each distinct body still required; metadata always requires original preservation',
      metadataScenario: 'hypothetical replacement of metadata UTF8 >16384 bytes on trace lines >65536 bytes with exactly 16384 UTF8 bytes and unknown escaping; interval uses maximum/minimum JSON string encoding of that fixed budget; not an actual compactor; no archive or cache savings',
      overlappingMetrics: 'logical metadata excess and encoded scenario intervals overlap and must never be added',
      maxLineBytes, identityEntriesPerStreamLimit: IDENTITY_LIMIT,
    },
  };
  const fail = code => { report.partial = true; if (!report.errors.includes(code)) report.errors.push(code); };
  const root = await directoryRoot(dataRoot);
  const vault = vaultRoot === undefined ? undefined : await directoryRoot(vaultRoot);
  if (!root) { fail('INVALID_DATA_ROOT'); return report; }
  if (vaultRoot !== undefined && !vault) { fail('INVALID_VAULT_ROOT'); return report; }
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0 || maxLineBytes > LINE_LIMIT) {
    fail('INVALID_LINE_LIMIT'); return report;
  }
  const workspaces = path.join(root, 'workspaces');
  if (!await directoryRoot(workspaces)) { fail('INVALID_WORKSPACES_ROOT'); return report; }

  async function inventory() {
    const files = [];
    async function walk(directory, relative = '') {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch { fail('DIRECTORY_UNREADABLE'); return; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        const rel = relative ? relative + '/' + entry.name : entry.name;
        try {
          const stat = await lstat(file);
          if (stat.isSymbolicLink()) { files.push({ rel, unsafe: true }); continue; }
          if (!confined(workspaces, await realpath(file))) { files.push({ rel, unsafe: true }); continue; }
          if (stat.isDirectory()) { await walk(file, rel); continue; }
          if (!stat.isFile()) { files.push({ rel, unsafe: true }); continue; }
          const kind = relative ? shardKind(entry.name) : null;
          const flat = !relative && entry.name.endsWith('.jsonl');
          files.push({ file, rel, size: stat.size, recognized: Boolean(kind || flat),
            workspace: flat ? entry.name.slice(0, -6) : relative,
            layout: flat ? 'legacy-flat' : 'sharded', conflict: kind === 'conflict' });
        } catch { fail('ENTRY_UNREADABLE'); }
      }
    }
    await walk(workspaces);
    return files;
  }
  const files = await inventory();
  const streams = new Map();
  const sourceDigests = new Map();
  for (const file of files) {
    if (file.unsafe) { report.discovery.unsafeEntries++; fail('UNSAFE_SOURCE_ENTRY'); continue; }
    report.discovery.regularFiles++; report.discovery.regularBytes += file.size;
    if (!file.recognized) {
      report.discovery.ignoredFiles++; report.discovery.ignoredBytes += file.size;
      try { sourceDigests.set(file.rel, await fileDigest(file.file)); } catch { fail('SOURCE_UNREADABLE'); }
      continue;
    }
    report.discovery.recognizedFiles++; report.discovery.recognizedBytes += file.size;
    const key = file.layout + ':' + file.workspace;
    let state = streams.get(key);
    if (!state) {
      const output = { workspace: file.workspace, layout: file.layout,
        physical: metrics(), unique: metrics(), identity: identity(), preservation: preservation() };
      state = { output, events: new Map(), bodies: new Set(), identityEntries: 0 };
      streams.set(key, state); report.streams.push(output);
    }
    const { physical, unique, identity: ids, preservation: keep } = state.output;
    physical.files++; physical.rawBytes += file.size;
    if (file.conflict) physical.conflictFiles++;
    try {
      const result = await scanLines(file.file, maxLineBytes, async (bytes, lineBytes, skipped) => {
        physical.lines++;
        const oversized = lineBytes > LARGE_LINE;
        if (oversized) physical.oversizedRecords++;
        if (skipped) {
          physical.skippedOversizedLines++; physical.skippedOversizedLineBytes += lineBytes;
          if (oversized) physical.unclassifiedOversizedLines++;
          fail('LINE_LIMIT_EXCEEDED'); return;
        }
        if (!lineBytes) { physical.blankLines++; return; }
        let text, event;
        try { text = decoder.decode(bytes); }
        catch { physical.invalidUtf8Lines++; if (oversized) physical.unclassifiedOversizedLines++; fail('INVALID_UTF8'); return; }
        try { event = JSON.parse(text); }
        catch { physical.malformedJsonLines++; if (oversized) physical.unclassifiedOversizedLines++; fail('MALFORMED_JSON'); return; }
        if (!isObject(event) || typeof event.type !== 'string') {
          physical.malformedEventLines++; if (oversized) physical.unclassifiedOversizedLines++; fail('MALFORMED_EVENT'); return;
        }
        let duplicate = false;
        if (typeof event.id !== 'string' || !event.id) {
          ids.recordsWithoutEnvelopeId++; ids.complete = false;
          fail('MISSING_ENVELOPE_ID');
        }
        else {
          try {
            const digest = canonicalDigest(event);
            const eventKey = hash(event.id);
            const versions = state.events.get(eventKey);
            if (versions?.has(digest)) { duplicate = true; ids.exactDuplicateRecords++; }
            else if (state.identityEntries >= IDENTITY_LIMIT) {
              ids.identityUnverifiedRecords++; ids.complete = false; fail('IDENTITY_LIMIT_EXCEEDED');
            } else {
              if (versions && versions.size === 1) ids.divergentEventIds++;
              const values = versions ?? new Set(); values.add(digest);
              state.events.set(eventKey, values); state.identityEntries++;
            }
          } catch { ids.identityUnverifiedRecords++; ids.complete = false; fail('IDENTITY_UNAVAILABLE'); }
        }
        const targets = duplicate ? [physical] : [physical, unique];
        for (const metric of targets) {
          metric.records++;
          if (metric === unique && oversized) metric.oversizedRecords++;
          if (event.type !== 'trace_added' && oversized) metric.nonTraceOversizedRecords++;
        }
        if (event.type !== 'trace_added') return;
        keep.tracesRequiringOriginalPreservation++;
        for (const metric of targets) {
          metric.traceRecords++; metric.traceRawLineBytes += lineBytes;
          if (oversized) metric.traceOversizedRecords++;
        }
        const metadataJson = isObject(event.data) ? event.data.metadataJson : undefined;
        let metadata;
        if (metadataJson === undefined || metadataJson === null) {
          for (const metric of targets) metric.missingMetadataRecords++;
        } else if (typeof metadataJson !== 'string') {
          for (const metric of targets) metric.malformedMetadataRecords++;
          fail('MALFORMED_METADATA');
        } else {
          const utf8 = byteLength(metadataJson);
          const encoded = encodedMetadataBytes(text);
          for (const metric of targets) {
            metric.metadataUtf8Bytes += utf8; metric.metadataEncodedBytes += encoded;
            metric.logicalMetadataExcessBytes += Math.max(0, utf8 - METADATA_TARGET);
          }
          try {
            metadata = JSON.parse(metadataJson);
            if (!isObject(metadata)) throw new Error();
            if (oversized && utf8 > METADATA_TARGET) for (const metric of targets) {
              metric.metadataScenarioCandidateRecords++;
              metric.metadataScenarioLowerBytes += Math.max(0, encoded - (6 * METADATA_TARGET + 2));
              metric.metadataScenarioUpperBytes += Math.max(0, encoded - (METADATA_TARGET + 2));
            }
          } catch {
            for (const metric of targets) metric.malformedMetadataRecords++;
            fail('MALFORMED_METADATA'); metadata = undefined;
          }
        }
        const body = writeBody(metadata);
        if (!body) { keep.unsupported++; return; }
        const bodyHash = hash(body.content);
        if (state.bodies.has(bodyHash)) keep.duplicateBodyOccurrences++;
        else if (state.bodies.size < IDENTITY_LIMIT) {
          state.bodies.add(bodyHash); keep.distinctBodiesRequiringFirstCopy++;
        } else { keep.bodyIdentityUnverifiedOccurrences++; fail('BODY_IDENTITY_LIMIT_EXCEEDED'); }
        keep[await compareBody(vault, body)]++;
      });
      physical.scannedBytes += result.rawBytes;
      sourceDigests.set(file.rel, result.digest);
      if (result.rawBytes !== file.size) fail('SOURCE_CHANGED');
    } catch { fail('SOURCE_UNREADABLE'); }
  }
  let unchanged = !report.errors.some(code => ['SOURCE_UNREADABLE', 'DIRECTORY_UNREADABLE', 'ENTRY_UNREADABLE', 'UNSAFE_SOURCE_ENTRY', 'SOURCE_CHANGED'].includes(code));
  const after = await inventory();
  const signature = list => JSON.stringify(list.map(file => [file.rel, file.size, Boolean(file.unsafe)]));
  if (signature(files) !== signature(after)) unchanged = false;
  for (const file of files) if (!file.unsafe) {
    try { if (sourceDigests.get(file.rel) !== await fileDigest(file.file)) unchanged = false; }
    catch { unchanged = false; }
  }
  if (!unchanged) fail('SOURCE_CHANGED_OR_UNVERIFIED');
  report.sourceUnchanged = unchanged;
  for (const { output } of streams.values()) output.identity.ambiguous = output.identity.divergentEventIds > 0 || !output.identity.complete;
  report.totals = {
    physical: sumObjects(report.streams.map(stream => stream.physical), metrics),
    unique: sumObjects(report.streams.map(stream => stream.unique), metrics),
    identity: sumObjects(report.streams.map(stream => stream.identity), identity),
    preservation: sumObjects(report.streams.map(stream => stream.preservation), preservation),
  };
  report.totals.identity.ambiguous = report.streams.some(stream => stream.identity.ambiguous);
  report.totals.identity.complete = report.streams.every(stream => stream.identity.complete);
  return report;
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') return {
    usage: 'node scripts/audit-trace-history.mjs --data-root <absolute directory containing workspaces/> [--vault-root <absolute vault directory>]',
    output: 'JSON on stdout only. Redirect outside the input tree. No files are written. Exit 1 means partial/invalid input; exit 0 means complete diagnostic.',
    safety: 'No real-data scan is implied by installing/testing this tool. Original traces must be archived before any future transformation. Results expose workspace names and aggregate counts only.',
    limits: '128 MiB maximum raw line bytes; 1,000,000 internal event versions and body hashes per stream. Unsupported CLI commands fail closed. Concurrent filesystem changes cannot provide atomic snapshot guarantees.',
  };
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index] === '--data-root' ? 'dataRoot' : argv[index] === '--vault-root' ? 'vaultRoot' : null;
    if (!key || options[key] !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      return { partial: true, errors: ['INVALID_ARGUMENTS'] };
    }
    options[key] = argv[index + 1];
  }
  if (!options.dataRoot) return { partial: true, errors: ['INVALID_ARGUMENTS'] };
  return auditHistory(options);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.partial) process.exitCode = 1;
  }).catch(() => {
    process.stdout.write(JSON.stringify({ partial: true, errors: ['UNEXPECTED_FAILURE'] }) + '\n');
    process.exitCode = 1;
  });
}
