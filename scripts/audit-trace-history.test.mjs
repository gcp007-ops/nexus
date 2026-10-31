import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { auditHistory } from './audit-trace-history.mjs';

const script = new URL('./audit-trace-history.mjs', import.meta.url);
const trace = (id, metadata, extra = {}) => ({ id, type: 'trace_added', data: { id: 'trace-record-id', metadataJson: JSON.stringify(metadata) }, ...extra });
const writeMetadata = (notePath, content) => ({ tool: { agent: 'contentManager', mode: 'write' }, input: { arguments: { path: notePath, content } } });
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'nexus-audit-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'data');
  const vaultRoot = path.join(root, 'vault');
  await mkdir(path.join(dataRoot, 'workspaces'), { recursive: true });
  await mkdir(vaultRoot);
  const put = async (relative, value) => {
    const full = path.join(dataRoot, 'workspaces', relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, value);
    return full;
  };
  return { root, dataRoot, vaultRoot, put };
}
const jsonl = events => events.map(e => JSON.stringify(e)).join('\n') + '\n';
const digest = value => createHash('sha256').update(value).digest('hex');

test('discovers flat, recursive canonical and exact conflict siblings; accounts ignored files', async t => {
  const f = await fixture(t);
  await f.put('legacy.jsonl', jsonl([trace('a', {})]));
  await f.put('w/shard-000001.jsonl', jsonl([trace('b', {})]));
  await f.put('w/shard-000001 (1).jsonl', jsonl([trace('c', {})]));
  await f.put('w/shard-000001 [Conflict].jsonl', jsonl([trace('d', {})]));
  await f.put('w/shard-000001_2.jsonl', jsonl([trace('e', {})]));
  await f.put('w/nested/shard-0000012.jsonl', jsonl([trace('f', {})]));
  await f.put('w/shard-0.jsonl', 'ignored');
  await f.put('w/not-a-shard.jsonl', 'abc');
  const r = await auditHistory({ dataRoot: f.dataRoot });
  assert.equal(r.partial, false);
  assert.equal(r.sourceUnchanged, true);
  assert.equal(r.discovery.recognizedFiles, 6);
  assert.equal(r.discovery.ignoredFiles, 2);
  assert.equal(r.discovery.ignoredBytes, 10);
  assert.equal(r.totals.physical.conflictFiles, 3);
  assert.equal(r.totals.physical.traceRecords, 6);
  assert.equal(r.streams.length, 3);
});

test('counts raw UTF8 line bytes strictly above 65536 excluding CRLF and final newline', async t => {
  const f = await fixture(t);
  const base = { id: 'a', type: 'other', pad: '' };
  const make = size => JSON.stringify({ ...base, pad: 'é'.repeat(Math.floor((size - Buffer.byteLength(JSON.stringify(base))) / 2)) }) + (size % 2 ? ' ' : '');
  const exact = make(65536);
  const over = make(65538);
  assert.equal(Buffer.byteLength(exact), 65536);
  await f.put('w.jsonl', exact + '\r\n' + over);
  const r = await auditHistory({ dataRoot: f.dataRoot });
  assert.equal(r.totals.physical.oversizedRecords, 1);
  assert.equal(r.totals.physical.nonTraceOversizedRecords, 1);
  assert.equal(r.totals.physical.rawBytes, Buffer.byteLength(exact + '\r\n' + over));
  assert.equal(r.totals.physical.records, 2);
});

test('separates physical duplicates, canonical versions, divergent envelope IDs and missing IDs', async t => {
  const f = await fixture(t);
  const a = trace('event-a', { body: 'one' });
  const ordered = { data: a.data, type: a.type, id: a.id };
  const b = trace('event-b', { body: 'one' }); // Same data.id is NOT an envelope duplicate.
  const divergent = trace('event-a', { body: 'two' });
  const missing = trace(undefined, {});
  await f.put('w/shard-1.jsonl', jsonl([a, b, missing]));
  await f.put('w/shard-1 (1).jsonl', jsonl([ordered, divergent]));
  const r = await auditHistory({ dataRoot: f.dataRoot });
  assert.equal(r.totals.physical.records, 5);
  assert.equal(r.totals.unique.records, 4);
  assert.equal(r.totals.identity.exactDuplicateRecords, 1);
  assert.equal(r.totals.identity.divergentEventIds, 1);
  assert.equal(r.totals.identity.recordsWithoutEnvelopeId, 1);
  assert.equal(r.streams[0].identity.ambiguous, true);
});

test('reports logical and encoded metadata separately and scenario bounds without adding savings', async t => {
  const f = await fixture(t);
  const metadata = { body: '\n"é'.repeat(20000) };
  const text = JSON.stringify(metadata);
  await f.put('w.jsonl', jsonl([trace('a', metadata)]));
  const r = await auditHistory({ dataRoot: f.dataRoot });
  const p = r.totals.physical;
  assert.equal(p.metadataUtf8Bytes, Buffer.byteLength(text));
  assert.equal(p.metadataEncodedBytes, Buffer.byteLength(JSON.stringify(text)));
  assert.equal(p.logicalMetadataExcessBytes, Math.max(0, Buffer.byteLength(text) - 16384));
  assert.equal(p.metadataScenarioLowerBytes, Math.max(0, p.metadataEncodedBytes - (6 * 16384 + 2)));
  assert.equal(p.metadataScenarioUpperBytes, Math.max(0, p.metadataEncodedBytes - (16384 + 2)));
  assert.equal(r.policy.archiveOriginalTracesRequired, true);
});

test('classifies direct and legacy write bodies without treating results or state as recoverable', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.vaultRoot, 'same.md'), 'secret-body-é');
  await writeFile(path.join(f.vaultRoot, 'changed.md'), 'current');
  const events = [
    trace('a', writeMetadata('same.md', 'secret-body-é')),
    trace('b', writeMetadata('changed.md', 'old')),
    trace('c', writeMetadata('missing.md', 'lost')),
    trace('d', writeMetadata('../escape.md', 'secret-escape')),
    trace('e', { tool: 'contentManager_write', params: { path: 'same.md', content: 'secret-body-é' }, result: { nested: { body: 'result-secret' } } }),
    trace('f', { legacy: { result: { state: 'state-secret' } } }),
  ];
  await f.put('w.jsonl', jsonl(events));
  const r = await auditHistory({ dataRoot: f.dataRoot, vaultRoot: f.vaultRoot });
  const p = r.totals.preservation;
  assert.equal(p.exactCurrentFileMatch, 2);
  assert.equal(p.changed, 1);
  assert.equal(p.missing, 1);
  assert.equal(p.unsafeOrUnreadable, 1);
  assert.equal(p.unsupported, 1);
  assert.equal(p.tracesRequiringOriginalPreservation, 6);
  assert.equal(p.duplicateBodyOccurrences, 1);
  assert.equal(p.distinctBodiesRequiringFirstCopy, 4);
  const output = JSON.stringify(r);
  for (const secret of ['secret-body', 'same.md', 'escape.md', 'result-secret', 'state-secret', 'event-a', digest('secret-body-é')]) assert.equal(output.includes(secret), false);
});

test('does not follow a symlink or junction out of the supplied vault', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.md'), 'secret');
  await symlink(outside, path.join(f.vaultRoot, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await f.put('w.jsonl', jsonl([trace('a', writeMetadata('link/secret.md', 'secret'))]));
  const r = await auditHistory({ dataRoot: f.dataRoot, vaultRoot: f.vaultRoot });
  assert.equal(r.totals.preservation.unsafeOrUnreadable, 1);
  assert.equal(r.totals.preservation.exactCurrentFileMatch, 0);
});

test('strict CLI subset extracts bodies; escapes, batches, unknown tools fail closed', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.vaultRoot, 'note.md'), 'body text');
  const cli = command => ({ tool: { agent: 'toolManager', mode: 'useTools' }, input: { arguments: { tool: command } } });
  await f.put('w.jsonl', jsonl([
    trace('a', cli('content write --path note.md --content "body text"')),
    trace('b', cli('content write --content "body text" --path note.md')),
    trace('c', cli('content write --path note.md --content "body\\ntext"')),
    trace('d', cli('content write --path note.md --content "body text", storage list')),
    trace('e', { tool: 'unknown_write', params: { path: 'note.md', content: 'body text' } }),
  ]));
  const r = await auditHistory({ dataRoot: f.dataRoot, vaultRoot: f.vaultRoot });
  assert.equal(r.totals.preservation.exactCurrentFileMatch, 2);
  assert.equal(r.totals.preservation.unsupported, 3);
});

test('missing vault comparison remains unverified and does not certify metadata safe', async t => {
  const f = await fixture(t);
  await f.put('w.jsonl', jsonl([trace('a', writeMetadata('note.md', 'body'))]));
  const r = await auditHistory({ dataRoot: f.dataRoot });
  assert.equal(r.totals.preservation.unverified, 1);
  assert.equal(r.totals.preservation.tracesRequiringOriginalPreservation, 1);
});

test('accounts malformed JSON, invalid UTF8 and invalid metadata without disclosing errors', async t => {
  const f = await fixture(t);
  await f.put('w.jsonl', Buffer.concat([
    Buffer.from('{"secret-malformed":\r\n'),
    Buffer.from([0xff, 10]),
    Buffer.from(jsonl([trace('a', {}), { id: 'bad-meta', type: 'trace_added', data: { metadataJson: '{secret' } }, { id: 'wrong-meta', type: 'trace_added', data: { metadataJson: {} } }])),
  ]));
  const r = await auditHistory({ dataRoot: f.dataRoot });
  assert.equal(r.partial, true);
  assert.equal(r.totals.physical.malformedJsonLines, 1);
  assert.equal(r.totals.physical.invalidUtf8Lines, 1);
  assert.equal(r.totals.physical.malformedMetadataRecords, 2);
  assert.equal(JSON.stringify(r).includes('secret'), false);
});

test('bounded line reader skips oversized input while counting bytes and resumes', async t => {
  const f = await fixture(t);
  await f.put('w.jsonl', 'x'.repeat(4097) + '\r\n' + jsonl([trace('a', {})]));
  const r = await auditHistory({ dataRoot: f.dataRoot, maxLineBytes: 4096 });
  assert.equal(r.partial, true);
  assert.equal(r.totals.physical.skippedOversizedLines, 1);
  assert.equal(r.totals.physical.skippedOversizedLineBytes, 4097);
  assert.equal(r.totals.physical.traceRecords, 1);
});

test('CLI validates absolute explicit roots, uses JSON only and exits nonzero on malformed data', async t => {
  const f = await fixture(t);
  const scriptPath = decodeURIComponent(script.pathname).replace(/^\/(\w:)/, '$1');
  const run = args => spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', timeout: 10000 });
  const missing = run([]);
  assert.notEqual(missing.status, 0);
  assert.equal(JSON.parse(missing.stdout).errors[0], 'INVALID_ARGUMENTS');
  const relative = run(['--data-root', 'relative']);
  assert.notEqual(relative.status, 0);
  assert.equal(JSON.parse(relative.stdout).errors[0], 'INVALID_DATA_ROOT');
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(JSON.parse(help.stdout).usage, /--data-root/);
  await f.put('w.jsonl', 'broken-secret\n');
  const bad = run(['--data-root', f.dataRoot]);
  assert.notEqual(bad.status, 0);
  assert.equal(bad.stderr, '');
  assert.equal(JSON.parse(bad.stdout).partial, true);
  assert.equal(bad.stdout.includes('broken-secret'), false);
});

test('source bytes remain identical and no output files are created in input', async t => {
  const f = await fixture(t);
  const file = await f.put('w.jsonl', jsonl([trace('a', writeMetadata('note.md', 'body'))]));
  const before = digest(await readFile(file));
  const r = await auditHistory({ dataRoot: f.dataRoot });
  assert.equal(digest(await readFile(file)), before);
  assert.equal(r.sourceUnchanged, true);
  assert.equal(r.discovery.regularFiles, 1);
});

test('trace boundary is strictly greater than 64 KiB and small metadata is no scenario candidate', async t => {
  const f = await fixture(t);
  const make = bytes => {
    const event = trace(String(bytes), { note: 'small' });
    event.data.padding = '';
    event.data.padding = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(event)));
    const value = JSON.stringify(event);
    assert.equal(Buffer.byteLength(value), bytes);
    return value;
  };
  await f.put('w.jsonl', make(65536) + '\r\n' + make(65537));
  const r = await auditHistory({ dataRoot: f.dataRoot });
  assert.equal(r.totals.physical.traceOversizedRecords, 1);
  assert.equal(r.totals.physical.traceRecords, 2);
  assert.equal(r.totals.physical.metadataScenarioCandidateRecords, 0);
});

test('encoded metadata counts original JSON token escapes and final lone CR is a raw byte', async t => {
  const f = await fixture(t);
  const ordinary = JSON.stringify(trace('a', { body: 'é' }));
  const source = ordinary.replace('é', '\\u00e9');
  const token = JSON.stringify(JSON.stringify({ body: 'é' })).replace('é', '\\u00e9');
  await f.put('w.jsonl', source + '\r');
  const r = await auditHistory({ dataRoot: f.dataRoot });
  assert.equal(r.totals.physical.metadataEncodedBytes, Buffer.byteLength(token));
  assert.equal(r.totals.physical.metadataUtf8Bytes, Buffer.byteLength(JSON.stringify({ body: 'é' })));
  assert.equal(r.totals.physical.traceRawLineBytes, Buffer.byteLength(source + '\r'));
});

test('arbitrary event types and invalid metadata values never disclose payloads', async t => {
  const f = await fixture(t);
  await f.put('w.jsonl', jsonl([
    { id: 'a', type: 'PAYLOAD_TYPE_SECRET', arbitrary: 'other-secret' },
    { id: 'b', type: 'trace_added', data: { metadataJson: '[]' } },
    { id: 'c', type: 'trace_added', data: { metadataJson: 'null' } },
    { id: 'd', type: 'trace_added', data: { metadataJson: null } },
  ]));
  const r = await auditHistory({ dataRoot: f.dataRoot });
  assert.equal(r.partial, true);
  assert.equal(r.totals.physical.malformedMetadataRecords, 2);
  assert.equal(r.totals.physical.missingMetadataRecords, 1);
  assert.equal(JSON.stringify(r).includes('SECRET'), false);
});

test('empty workspaces is complete with zero counts; absent workspaces is invalid input', async t => {
  const f = await fixture(t);
  const empty = await auditHistory({ dataRoot: f.dataRoot });
  assert.equal(empty.partial, false);
  assert.equal(empty.totals.physical.records, 0);
  const absent = await auditHistory({ dataRoot: f.vaultRoot });
  assert.equal(absent.partial, true);
  assert.deepEqual(absent.errors, ['INVALID_WORKSPACES_ROOT']);
});
