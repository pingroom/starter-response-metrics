import { createHash } from 'node:crypto';

export class InputError extends Error {}
export const fail = (message) => { throw new InputError(message); };
export const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const STATES = ['pending', 'answered', 'expired', 'cancelled'];

export function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function exactKeys(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
export function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('Use lowercase UUIDs for question and registration IDs.');
  return value;
}
export function roomCode(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.trim())) fail('Set a valid PingRoom room code.');
  return value.trim().toUpperCase();
}
export function connection(env = process.env) {
  if (typeof env.PINGROOM_TOKEN !== 'string' || !env.PINGROOM_TOKEN.trim() || typeof env.PINGROOM_ROOM !== 'string' || !env.PINGROOM_ROOM.trim()) {
    fail('Set both PINGROOM_TOKEN and PINGROOM_ROOM to the original asking connection; blank or partial credentials are refused.');
  }
  const token = env.PINGROOM_TOKEN.trim();
  if (token.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(token)) fail('PINGROOM_TOKEN has an invalid format.');
  return { token, room: roomCode(env.PINGROOM_ROOM) };
}
export function loadConnection(loadFile, env = process.env) {
  // A defined external value, including an empty one, selects the whole pair.
  if (env.PINGROOM_TOKEN !== undefined || env.PINGROOM_ROOM !== undefined) return connection(env);
  try { loadFile(); }
  catch (error) { if (error.code !== 'ENOENT') fail('Cannot load .env. Check its format and permissions.'); }
  return connection(env);
}

export function validateCohort(value) {
  if (!exactKeys(value, ['version', 'roomCode', 'askingRegistrationId', 'targetSeconds', 'questionIds']) || value.version !== 1) fail('Cohort must match the version 1 example.');
  const room = roomCode(value.roomCode);
  const registration = uuid(value.askingRegistrationId);
  if (!Number.isSafeInteger(value.targetSeconds) || value.targetSeconds < 1 || value.targetSeconds > 86400) fail('targetSeconds must be an integer from 1 to 86400.');
  if (!Array.isArray(value.questionIds) || value.questionIds.length < 1 || value.questionIds.length > 50) fail('Choose 1–50 question IDs.');
  const ids = value.questionIds.map(uuid).sort();
  if (new Set(ids).size !== ids.length) fail('Question IDs must be unique.');
  return { version: 1, roomCode: room, askingRegistrationId: registration, targetSeconds: value.targetSeconds, questionIds: ids };
}

// Carbon's ISO 8601 timestamps include an offset. Reject calendar rollover and
// timezone-free strings instead of relying on Date.parse's permissive parsing.
export function timestamp(value) {
  if (typeof value !== 'string') fail('A required timestamp is missing.');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) fail('A timestamp is not valid ISO 8601.');
  const [, y, mo, d, h, mi, s, , offset] = match;
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (year < 1000 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) fail('A timestamp has an invalid calendar date.');
  if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 14 || Number(offset.slice(4)) > 59 || (Number(offset.slice(1, 3)) === 14 && offset.slice(4) !== '00'))) fail('A timestamp has an invalid offset.');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail('A timestamp cannot be parsed.');
  return new Date(ms).toISOString();
}

function validateTimes(row) {
  const created = Date.parse(row.createdAt), expires = Date.parse(row.expiresAt), observed = Date.parse(row.observedAt);
  if (expires <= created || created > observed) fail('Question creation/expiry timestamps are inconsistent; check the system clock.');
  if (row.state === 'pending') {
    if (row.resolvedAt !== null || row.answeredAt !== null) fail('Pending question has terminal timestamps.');
  } else if (row.state === 'answered') {
    if (row.answeredAt === null || row.resolvedAt !== row.answeredAt) fail('Answered question lacks matching server answer/resolution timestamps.');
  } else {
    if (row.answeredAt !== null || row.resolvedAt === null) fail('Unanswered terminal question has inconsistent timestamps.');
    if (row.state === 'expired' && Date.parse(row.resolvedAt) < expires) fail('Expired question cannot resolve before its expiry timestamp.');
  }
  if (row.resolvedAt !== null && (Date.parse(row.resolvedAt) < created || Date.parse(row.resolvedAt) > observed)) fail('Question resolution is outside the observed time interval.');
  // Equality is accepted at the millisecond precision used by this report.
  if (row.state !== 'expired' && row.resolvedAt !== null && Date.parse(row.resolvedAt) > expires) fail('Question resolution is after its expiry timestamp.');
  return row;
}

export function projectQuestion(question, id, cohort, observedAt) {
  if (!object(question) || question.id !== id || question.kind !== 'question' || question.is_handoff !== false || question.resolution_policy !== 'first' || question.results !== null) fail('Expected an ordinary first-response Question with the requested ID.');
  if (!object(question.room) || question.room.code !== cohort.roomCode || question.room_code !== cohort.roomCode || !object(question.asker) || question.asker.type !== 'agent' || question.asker.id !== cohort.askingRegistrationId) fail('Question room or asking registration does not match the cohort.');
  if (!STATES.includes(question.state) || !['direct', 'room'].includes(question.responder_scope)) fail('Question state or responder scope is unsupported.');
  if (question.state === 'answered' ? !object(question.answer) : question.answer !== null) fail('Question answer does not match its state.');
  return validateTimes({
    id, state: question.state,
    createdAt: timestamp(question.created_at), expiresAt: timestamp(question.expires_at),
    resolvedAt: question.resolved_at === null ? null : timestamp(question.resolved_at),
    answeredAt: question.state === 'answered' ? timestamp(question.answer.answered_at) : null,
    observedAt: timestamp(observedAt),
  });
}

export function scopeHash(cohort, token) { return hash({ cohort, token }); }

export function validateSnapshot(value) {
  if (!exactKeys(value, ['version', 'cohort', 'cohortHash', 'scopeHash', 'scanStartedAt', 'scanCompletedAt', 'questions']) || value.version !== 1) fail('Saved snapshot is invalid; preserve it and restore a known-good copy.');
  const cohort = validateCohort(value.cohort);
  if (JSON.stringify(value.cohort) !== JSON.stringify(cohort) || value.cohortHash !== hash(cohort) || !HASH.test(value.scopeHash ?? '')) fail('Saved snapshot scope is invalid.');
  const start = timestamp(value.scanStartedAt), end = timestamp(value.scanCompletedAt);
  if (start !== value.scanStartedAt || end !== value.scanCompletedAt || start > end || !Array.isArray(value.questions) || value.questions.length !== cohort.questionIds.length) fail('Saved snapshot scan metadata is invalid.');
  let previousObservation = start;
  for (const [index, row] of value.questions.entries()) {
    if (!exactKeys(row, ['id', 'state', 'createdAt', 'expiresAt', 'resolvedAt', 'answeredAt', 'observedAt']) || row.id !== cohort.questionIds[index] || !STATES.includes(row.state)) fail('Saved snapshot question list is invalid.');
    for (const key of ['createdAt', 'expiresAt', 'observedAt']) if (timestamp(row[key]) !== row[key]) fail('Saved snapshot timestamps are invalid.');
    for (const key of ['resolvedAt', 'answeredAt']) if (row[key] !== null && timestamp(row[key]) !== row[key]) fail('Saved snapshot timestamps are invalid.');
    validateTimes(row);
    if (row.observedAt < previousObservation || row.observedAt > end) fail('Saved snapshot observation order is invalid.');
    previousObservation = row.observedAt;
  }
  return value;
}

export function report(snapshot) {
  validateSnapshot(snapshot);
  const counts = { pending: 0, answered: 0, expired: 0, cancelled: 0 };
  const latencies = [];
  const targetMs = snapshot.cohort.targetSeconds * 1000;
  let answeredWithinTarget = 0, pendingBeyondTarget = 0;
  for (const row of snapshot.questions) {
    counts[row.state]++;
    if (row.state === 'answered') {
      const latency = Date.parse(row.answeredAt) - Date.parse(row.createdAt);
      latencies.push(latency);
      if (latency <= targetMs) answeredWithinTarget++;
    } else if (row.state === 'pending' && Date.parse(row.observedAt) - Date.parse(row.createdAt) > targetMs) pendingBeyondTarget++;
  }
  latencies.sort((a, b) => a - b);
  const percentile = (p) => latencies.length ? latencies[Math.ceil(p * latencies.length) - 1] : null;
  return {
    cohortHash: snapshot.cohortHash, scopeHash: snapshot.scopeHash,
    scanStartedAt: snapshot.scanStartedAt, scanCompletedAt: snapshot.scanCompletedAt,
    cohortSize: snapshot.questions.length, counts,
    answeredLatencyMs: { samples: latencies.length, min: latencies[0] ?? null, p50: percentile(0.5), p95: percentile(0.95), max: latencies.at(-1) ?? null },
    targetSeconds: snapshot.cohort.targetSeconds,
    answeredWithinTargetCount: answeredWithinTarget,
    pendingBeyondTargetAtObservationCount: pendingBeyondTarget,
  };
}
