import { join } from 'node:path';
import { atomicJson, readJson, withLock } from './storage.js';
import { fail, hash, projectQuestion, scopeHash, timestamp, validateCohort, validateSnapshot } from './schema.js';
import { readClient } from './transport.js';

export const SCAN_TIMEOUT_MS = 120_000;

export async function scan({ cohort: input, connection, directory, signal, now = () => new Date(), totalTimeoutMs = SCAN_TIMEOUT_MS, transport = {} }) {
  const cohort = validateCohort(input);
  if (cohort.roomCode !== connection.room) fail('PINGROOM_ROOM must match the cohort room.');
  return withLock(directory, async () => {
    const previous = await readJson(join(directory, 'snapshot.json'), { optional: true });
    const scope = scopeHash(cohort, connection.token);
    if (previous !== undefined) {
      validateSnapshot(previous);
      if (previous.scopeHash !== scope || previous.cohortHash !== hash(cohort)) fail('This state belongs to a different credential or cohort. Use a separate checkout for a new cohort.');
    }
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const timer = setTimeout(() => controller.abort(), totalTimeoutMs);
    try {
      const start = timestamp(now().toISOString());
      if (previous && start < previous.scanCompletedAt) fail('The clock moved behind the previous scan; correct it before scanning.');
      const client = readClient({ ...transport, token: connection.token, questionIds: cohort.questionIds, signal: combined });
      const rows = [];
      for (const id of cohort.questionIds) {
        combined.throwIfAborted();
        let question;
        try { question = await client.questions.get(id); }
        catch { fail('Question read failed or timed out. Check access, connectivity and quotas; any previous completed snapshot is unchanged.'); }
        combined.throwIfAborted();
        const row = projectQuestion(question, id, cohort, now().toISOString());
        const earlier = previous?.questions[rows.length];
        if (earlier && (earlier.createdAt !== row.createdAt || earlier.expiresAt !== row.expiresAt || (earlier.state !== 'pending' && ['state', 'resolvedAt', 'answeredAt'].some((key) => earlier[key] !== row[key])))) fail('Question history changed unexpectedly. Preserve the saved snapshot and investigate.');
        rows.push(row);
      }
      const snapshot = validateSnapshot({ version: 1, cohort, cohortHash: hash(cohort), scopeHash: scope, scanStartedAt: start, scanCompletedAt: timestamp(now().toISOString()), questions: rows });
      combined.throwIfAborted();
      await atomicJson(directory, 'snapshot.json', snapshot);
      return snapshot;
    } finally { clearTimeout(timer); controller.abort(); }
  });
}

export async function localReport(directory) {
  const value = await readJson(join(directory, 'snapshot.json'));
  return validateSnapshot(value);
}
