import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { loadConnection, InputError, projectQuestion, report, uuid, validateCohort } from './schema.js';
import { readJson } from './storage.js';
import { localReport, scan } from './scan.js';
import { readClient } from './transport.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, '.pingroom');
const controller = new AbortController();
const interrupt = () => controller.abort();
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'report') {
    if (args.length) throw new InputError('Usage: npm run report');
    console.log(JSON.stringify(report(await localReport(directory)), null, 2));
  } else {
    const connected = loadConnection(() => process.loadEnvFile(join(root, '.env')));
    if (command === 'scan') {
      if (args.length > 1) throw new InputError('Usage: npm start -- [cohort.json]');
      const cohort = validateCohort(await readJson(resolve(root, args[0] ?? 'cohort.json'), { maxBytes: 16 * 1024 }));
      console.log(JSON.stringify(report(await scan({ cohort, connection: connected, directory, signal: controller.signal })), null, 2));
    } else if (command === 'inspect') {
      if (args.length !== 1) throw new InputError('Usage: npm run inspect -- QUESTION_UUID');
      const id = uuid(args[0]);
      const client = readClient({ token: connected.token, questionIds: [id], signal: controller.signal });
      let question;
      try { question = await client.questions.get(id); }
      catch { throw new InputError('Question read failed. Use its original asking credential and check the ID and network.'); }
      const cohort = validateCohort({ version: 1, roomCode: connected.room, askingRegistrationId: uuid(question?.asker?.id), targetSeconds: 120, questionIds: [id] });
      projectQuestion(question, id, cohort, new Date().toISOString());
      console.log(JSON.stringify(cohort, null, 2));
    } else throw new InputError('Use npm start, npm run inspect, npm run report or npm run demo.');
  }
} catch (error) {
  // Never print SDK/network bodies, credentials, filesystem paths or raw errors.
  console.error(controller.signal.aborted ? 'Stopped. The next scan will read the whole cohort again.' : error instanceof InputError ? error.message : 'Operation failed. Check local files and permissions. Existing completed data was not intentionally removed.');
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
