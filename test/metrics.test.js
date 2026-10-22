import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connection as parseConnection, loadConnection, report, timestamp, validateCohort } from '../src/schema.js';
import { localReport, scan } from '../src/scan.js';
import { readClient } from '../src/transport.js';
import { cohort, connection, id, mockFetch, NOW, ORIGIN, question, TOKEN } from './fixtures.js';

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'metrics-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function run(directory, questions = [question()], overrides = {}) {
  const mock = mockFetch(questions);
  return scan({ directory, cohort: cohort(questions.length), connection, now: () => new Date(NOW), transport: mock.transport, ...overrides });
}

test('real SDK GETs every exact ID, stores only minimal metadata and reports nearest-rank percentiles', async (t) => {
  const directory = await workspace(t);
  const questions = [question(1, 'answered', 30), question(2, 'answered', 120), question(3, 'answered', 240), question(4, 'pending'), question(5, 'expired'), question(6, 'cancelled')];
  const mock = mockFetch(questions);
  const result = report(await run(directory, questions, { transport: mock.transport }));
  assert.deepEqual(mock.calls, questions.map((q) => `/api/agent/questions/${q.id}`));
  assert.deepEqual(result.counts, { pending: 1, answered: 3, expired: 1, cancelled: 1 });
  assert.deepEqual(result.answeredLatencyMs, { samples: 3, min: 30000, p50: 120000, p95: 240000, max: 240000 });
  assert.equal(result.answeredWithinTargetCount, 2);
  assert.equal(result.pendingBeyondTargetAtObservationCount, 1);
  const saved = await readFile(join(directory, 'snapshot.json'), 'utf8');
  assert.doesNotMatch(saved, /PRIVATE|offline-synthetic-token|prompt|answer_text|display_name|correlation_id/);
  assert.deepEqual(report(await localReport(directory)), result);
  if (process.platform !== 'win32') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'snapshot.json'))).mode & 0o777, 0o600);
  }
});

test('no answers produces null latency statistics rather than zero', async (t) => {
  const result = report(await run(await workspace(t), [question(1, 'pending'), question(2, 'expired')]));
  assert.deepEqual(result.answeredLatencyMs, { samples: 0, min: null, p50: null, p95: null, max: null });
  assert.equal(result.answeredWithinTargetCount, 0);
});

test('rescan reads all IDs again and pending can become answered', async (t) => {
  const directory = await workspace(t);
  await run(directory, [question(1, 'pending')]);
  const mock = mockFetch([question()]);
  await run(directory, [question()], { transport: mock.transport });
  assert.equal(mock.calls.length, 1);
  assert.equal(report(await localReport(directory)).counts.answered, 1);
});

test('a late failed read preserves the previous completed snapshot byte for byte', async (t) => {
  const directory = await workspace(t);
  const questions = [question(1, 'pending'), question(2, 'pending')];
  await run(directory, questions);
  const before = await readFile(join(directory, 'snapshot.json'));
  const mock = mockFetch(questions, { onRequest: (n) => n === 2 ? Response.json({ message: TOKEN }, { status: 403 }) : undefined });
  await assert.rejects(run(directory, questions, { transport: mock.transport }), (error) => {
    assert.doesNotMatch(error.message, /offline-synthetic-token/);
    return /read failed/.test(error.message);
  });
  assert.deepEqual(await readFile(join(directory, 'snapshot.json')), before);
});

test('credential, room and immutable cohort changes are rejected before GETs', async (t) => {
  const directory = await workspace(t);
  await run(directory);
  const changes = [
    { connection: { ...connection, token: 'another-token' } },
    { connection: { ...connection, room: 'OTHER1' } },
    { cohort: { ...cohort(), targetSeconds: 300 } },
    { cohort: { ...cohort(), askingRegistrationId: id(9) } },
    { cohort: { ...cohort(), questionIds: [id(2)] } },
  ];
  for (const change of changes) {
    const mock = mockFetch([question()]);
    await assert.rejects(run(directory, [question()], { transport: mock.transport, ...change }), /different credential or cohort|must match/);
    assert.equal(mock.calls.length, 0);
  }
});

test('wrong IDs, room, asker, question kinds, policies and state are rejected without a snapshot', async (t) => {
  const variants = [
    { id: id(9) }, { room: { code: 'OTHER1' } }, { room_code: 'OTHER1' },
    { asker: { type: 'user', id: cohort().askingRegistrationId } }, { asker: { type: 'agent', id: id(9) } },
    { kind: 'approval' }, { is_handoff: true }, { is_handoff: undefined }, { resolution_policy: 'all' }, { results: {} }, { state: 'decided' },
    { state: 'pending' }, { responder_scope: 'everyone' },
  ];
  for (const variant of variants) {
    const directory = await workspace(t);
    await assert.rejects(run(directory, [question()], { transport: { origin: ORIGIN, fetchImpl: async () => Response.json({ ...question(), ...variant }) } }));
    await assert.rejects(readFile(join(directory, 'snapshot.json')), { code: 'ENOENT' });
  }
});

test('invalid timestamps never become latency samples', async (t) => {
  const variants = [
    { created_at: null }, { created_at: '2026-02-30T00:00:00Z' }, { created_at: '2026-10-22 11:00:00' },
    { created_at: '2026-10-22T13:00:00Z' }, { expires_at: '2026-10-22T11:40:00Z' },
    { resolved_at: '2026-10-22T11:51:00Z' },
    { answer: { answered_at: null } },
    { answer: { answered_at: '2026-10-22T11:49:59Z' }, resolved_at: '2026-10-22T11:49:59Z' },
    { answer: { answered_at: '2026-10-22T12:00:01Z' }, resolved_at: '2026-10-22T12:00:01Z' },
  ];
  for (const variant of variants) await assert.rejects(run(await workspace(t), [{ ...question(), ...variant }]));
  assert.equal(timestamp('2026-10-22T15:00:00.123456+03:00'), '2026-10-22T12:00:00.123Z');
});

test('expired resolves at its deadline; cancellation is a distinct terminal state', async (t) => {
  const expired = question(1, 'expired');
  await assert.rejects(run(await workspace(t), [{ ...expired, resolved_at: '2026-10-22T11:58:59Z' }]));
  const result = report(await run(await workspace(t), [question(1, 'cancelled')]));
  assert.equal(result.counts.cancelled, 1);
  assert.equal(result.counts.expired, 0);
});

test('late answer/cancellation is rejected in API reads and saved snapshots', async (t) => {
  for (const state of ['answered', 'cancelled']) {
    const directory = await workspace(t);
    const initial = question(1, 'pending');
    initial.expires_at = '2026-10-22T11:59:00Z';
    await run(directory, [initial]);
    const before = await readFile(join(directory, 'snapshot.json'));
    const late = question(1, state, 541); // 11:59:01, one second after expiry.
    late.expires_at = initial.expires_at;
    await assert.rejects(run(directory, [late]), /after its expiry/);
    assert.deepEqual(await readFile(join(directory, 'snapshot.json')), before);
    const saved = JSON.parse(before);
    Object.assign(saved.questions[0], { state, resolvedAt: '2026-10-22T11:59:01.000Z', answeredAt: state === 'answered' ? '2026-10-22T11:59:01.000Z' : null });
    await writeFile(join(directory, 'snapshot.json'), JSON.stringify(saved));
    await assert.rejects(localReport(directory), /after its expiry/);
  }
});

test('terminal regression or changed creation time preserves the saved history', async (t) => {
  const directory = await workspace(t);
  await run(directory);
  const before = await readFile(join(directory, 'snapshot.json'));
  await assert.rejects(run(directory, [question(1, 'pending')]), /history changed/);
  await assert.rejects(run(directory, [{ ...question(), created_at: '2026-10-22T11:49:00Z' }]), /history changed/);
  assert.deepEqual(await readFile(join(directory, 'snapshot.json')), before);
});

test('null, malformed, oversized and tampered saved state fail closed before requests', async (t) => {
  for (const contents of ['null', '{', ' '.repeat(128 * 1024 + 1), JSON.stringify({ version: 1 })]) {
    const directory = await workspace(t);
    await writeFile(join(directory, 'snapshot.json'), contents);
    const mock = mockFetch([question()]);
    await assert.rejects(run(directory, [question()], { transport: mock.transport }));
    assert.equal(mock.calls.length, 0);
    assert.equal(await readFile(join(directory, 'snapshot.json'), 'utf8'), contents);
  }
  const directory = await workspace(t);
  await run(directory);
  const saved = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8'));
  saved.questions[0].prompt = 'not allowed';
  await writeFile(join(directory, 'snapshot.json'), JSON.stringify(saved));
  await assert.rejects(localReport(directory), /question list/);
});

test('a stale lock is not silently stolen and symlink snapshots are refused', async (t) => {
  const directory = await workspace(t);
  await writeFile(join(directory, 'scan.lock'), '{}');
  await assert.rejects(run(directory), /locked/);
  await rm(join(directory, 'scan.lock'));
  const outside = join(await workspace(t), 'outside.json');
  await writeFile(outside, 'null');
  await symlink(outside, join(directory, 'snapshot.json'));
  await assert.rejects(run(directory), /regular file/);
  assert.equal(await readFile(outside, 'utf8'), 'null');
});

test('SDK client cannot write, list, wait or read IDs outside its allowlist', async () => {
  let called = 0;
  const client = readClient({ token: TOKEN, questionIds: [id(1)], origin: ORIGIN, fetchImpl: async () => { called++; return Response.json({}); } });
  await assert.rejects(client.questions.get(id(2)));
  await assert.rejects(client.questions.list());
  await assert.rejects(client.questions.wait(id(1), { timeout: 0 }));
  await assert.rejects(client.questions.cancel(id(1)));
  assert.equal(called, 0);
});

test('response size is bounded for both declared and streamed bodies', async (t) => {
  for (const response of [new Response('small', { headers: { 'content-length': '999999' } }), new Response('x'.repeat(129 * 1024))]) {
    const directory = await workspace(t);
    await assert.rejects(run(directory, [question()], { transport: { origin: ORIGIN, fetchImpl: async () => response } }), /read failed/);
    await assert.rejects(readFile(join(directory, 'snapshot.json')), { code: 'ENOENT' });
  }
});

test('request deadline covers a fetch that ignores abort', async (t) => {
  const directory = await workspace(t);
  const start = Date.now();
  await assert.rejects(run(directory, [question()], { transport: { origin: ORIGIN, requestTimeoutMs: 25, fetchImpl: () => new Promise(() => {}) } }), /read failed/);
  assert.ok(Date.now() - start < 1000);
});

test('request deadline covers a stalled response body', async (t) => {
  let cancelled = false;
  await assert.rejects(run(await workspace(t), [question()], { transport: { origin: ORIGIN, requestTimeoutMs: 25, fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) } }), /read failed/);
  assert.equal(cancelled, true);
});

test('endless ready empty chunks cannot starve the request deadline', async (t) => {
  let cancelled = false;
  const start = Date.now();
  const response = new Response(new ReadableStream({ pull(stream) { stream.enqueue(new Uint8Array()); }, cancel() { cancelled = true; } }));
  await assert.rejects(run(await workspace(t), [question()], { transport: { origin: ORIGIN, requestTimeoutMs: 25, fetchImpl: async () => response } }), /read failed/);
  assert.ok(Date.now() - start < 1000);
  assert.equal(cancelled, true);
});

test('invalid UTF-8 in server bodies and local JSON is rejected without replacement characters', async (t) => {
  const directory = await workspace(t);
  const valid = JSON.stringify(question());
  const bytes = Buffer.concat([Buffer.from(valid.slice(0, -1) + ',"ignored":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  await assert.rejects(run(directory, [question()], { transport: { origin: ORIGIN, fetchImpl: async () => new Response(bytes) } }), /read failed/);
  await writeFile(join(directory, 'snapshot.json'), Buffer.concat([Buffer.from('{"ignored":"'), Buffer.from([0xff]), Buffer.from('"}')]));
  await assert.rejects(localReport(directory), /malformed/);
});

test('whole-scan deadline and caller cancellation stop reads without publishing', async (t) => {
  for (const explicit of [false, true]) {
    const directory = await workspace(t);
    const controller = new AbortController();
    let timer;
    if (explicit) timer = setTimeout(() => controller.abort(), 20);
    try {
      await assert.rejects(run(directory, [question()], { signal: controller.signal, totalTimeoutMs: explicit ? 1000 : 20, transport: { origin: ORIGIN, requestTimeoutMs: 2000, fetchImpl: () => new Promise(() => {}) } }));
      await assert.rejects(readFile(join(directory, 'snapshot.json')), { code: 'ENOENT' });
      await assert.rejects(readFile(join(directory, 'scan.lock')), { code: 'ENOENT' });
    } finally { clearTimeout(timer); }
  }
});

test('cohort bounds, uniqueness and strict configuration prevent accidental broad reads', () => {
  for (const invalid of [{ ...cohort(), questionIds: [] }, cohort(51), { ...cohort(), questionIds: [id(1), id(1)] }, { ...cohort(), questionIds: ['../all'] }, { ...cohort(), targetSeconds: 0 }, { ...cohort(), extra: true }, null]) assert.throws(() => validateCohort(invalid));
  assert.equal(validateCohort({ ...cohort(), roomCode: 'demo01' }).roomCode, 'DEMO01');
  for (const env of [{}, { PINGROOM_TOKEN: TOKEN }, { PINGROOM_ROOM: 'DEMO01' }, { PINGROOM_TOKEN: '', PINGROOM_ROOM: 'DEMO01' }, { PINGROOM_TOKEN: TOKEN, PINGROOM_ROOM: '' }]) assert.throws(() => parseConnection(env));
  assert.deepEqual(parseConnection({ PINGROOM_TOKEN: TOKEN, PINGROOM_ROOM: 'demo01' }), connection);
});

test('defined environment values choose the complete pair and cannot mix with .env', () => {
  let loaded = false;
  const loadFile = () => { loaded = true; };
  for (const env of [{ PINGROOM_TOKEN: TOKEN }, { PINGROOM_ROOM: 'DEMO01' }, { PINGROOM_TOKEN: '', PINGROOM_ROOM: 'DEMO01' }]) assert.throws(() => loadConnection(loadFile, env));
  assert.equal(loaded, false);
  assert.deepEqual(loadConnection(loadFile, { PINGROOM_TOKEN: TOKEN, PINGROOM_ROOM: 'DEMO01' }), connection);
  assert.equal(loaded, false);
  const env = {};
  assert.deepEqual(loadConnection(() => Object.assign(env, { PINGROOM_TOKEN: TOKEN, PINGROOM_ROOM: 'DEMO01' }), env), connection);
});
