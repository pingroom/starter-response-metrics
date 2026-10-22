import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan, localReport } from './scan.js';
import { report } from './schema.js';
import { cohort, connection, mockFetch, NOW, question } from '../test/fixtures.js';

// Synthetic data, a real SDK client, and an injected fetch with no network fallback.
const directory = await mkdtemp(join(tmpdir(), 'pingroom-metrics-demo-'));
try {
  const mock = mockFetch([question(1, 'answered', 30), question(2, 'answered', 180), question(3, 'pending'), question(4, 'expired'), question(5, 'cancelled')]);
  await scan({ cohort: cohort(5), connection, directory, transport: mock.transport, now: () => new Date(NOW) });
  console.log('Offline example: 5 synthetic questions; no credentials or network used.');
  console.log(JSON.stringify(report(await localReport(directory)), null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
