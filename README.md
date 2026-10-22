# PingRoom response metrics

Measure how long a known set of PingRoom questions took to receive an answer. Give this starter 1–50 question IDs from your existing integration; it reads each question and produces a local JSON report with outcome counts and answer-time percentiles.

**Use the credential that originally asked the questions.** A new pairing creates a different registration and cannot read another registration's questions. This starter does not pair, ask, answer, cancel, or send pings.

## Try it offline

Requires Node.js 22 or newer on macOS or Linux, with persistent private storage. The SDK is pinned to `@pingroom/sdk@0.6.0`; `.npmrc` sets a 14-day minimum release age. Choose **Use this template**, clone your repository, then:

```sh
npm ci
npm run demo
npm test
```

The demo uses the real SDK with an injected transport and synthetic responses. It requires no credentials or network, creates a temporary snapshot, prints the report, and removes its temporary files. Package installation needs npm access.

## Use your questions

1. Copy `.env.example` to `.env`. Set `PINGROOM_TOKEN` to the original asking registration's credential and `PINGROOM_ROOM` to its room code. Protect `.env` with `chmod 600 .env`. Credential files and local results are ignored by Git.
2. Copy `cohort.example.json` to `cohort.json`. Replace the example room, registration UUID, and question UUIDs with your own. These IDs should come from your integration's saved question receipts. Set `targetSeconds` to the response-time target you want to count against (1–86400).
3. Run the scan, then replay its saved report offline:

```sh
npm start
npm run report
```

If your receipt contains a question ID but not the asking registration UUID, this command reads that exact question and prints a minimal one-question cohort you can copy into `cohort.json`:

```sh
npm run inspect -- YOUR_QUESTION_UUID
```

It prints no prompt, answer, or person's name. Add the remaining IDs from the same room and asking registration to that cohort. Inspection does not save a snapshot.

The manifest accepts only ordinary first-response Questions. Polls, handoffs, legacy approvals, and human-authored questions are rejected. Room-scoped first-response Questions are allowed, but each question still represents one answer, not every room member's response. UUIDs must be lowercase; room codes are normalized to uppercase. Duplicate IDs and unknown manifest fields are rejected.

Set both `PINGROOM_TOKEN` and `PINGROOM_ROOM` in your scheduler's secret store to override `.env`. Defining either variable selects the entire environment pair; partial or blank pairs fail instead of mixing credentials. With neither set, the entry point loads the project `.env` using `process.loadEnvFile()`. API URL environment overrides are ignored: real requests go to `https://api.pingroom.io`.

## Read the report

| Field | Meaning |
| --- | --- |
| `counts` | Separate observed counts for pending, answered, expired, and cancelled questions. |
| `answeredLatencyMs` | Server answer time minus server creation time, for answered questions only. Includes sample count, minimum, p50, p95, and maximum. |
| `answeredWithinTargetCount` | Answered questions whose latency is at or below `targetSeconds`. |
| `pendingBeyondTargetAtObservationCount` | Questions still reported pending when read, whose age exceeded the target at their local observation time. |
| `scanStartedAt`, `scanCompletedAt` | The interval in which the question reads took place. |
| `cohortHash`, `scopeHash` | Local identifiers binding the manifest and the manifest-plus-credential scope. Neither contains the token itself. |

p50 and p95 use the **nearest-rank** definition: sort the answered latencies and select rank `ceil(p × n)`, starting at rank 1. With two answers, p50 is the smaller and p95 is the larger. If no questions were answered, all latency statistics are `null`, not zero. Timestamps are normalized to UTC with millisecond precision. At that precision, answered and cancelled questions must resolve no later than expiry, and expired questions must resolve exactly at expiry.

These are creation-to-server-answer timings, **not phone delivery, notification reading, or attention times**. Cancelled and expired questions do not become zero-duration answers. Pending questions have unknown eventual latency and are excluded from percentiles. The target count is not an SLA compliance rate; the chosen cohort may omit other questions, and pending outcomes can change. Keep the machine clock synchronized, particularly for pending ages.

## Adapt and schedule

Have the integration that asks questions save their IDs, room code, and `asker.id`. Use those receipts to define a fixed cohort, then run `npm start` periodically from that integration's environment with its original credential. For an alternate manifest filename, use `npm start -- path/to/cohort.json`.

Every scan starts with the full configured ID set. It never treats `questions.list()` as a complete feed: the current API's recent list is capped, and the pinned SDK does not expose its newer pagination controls. An explicitly supplied cohort also makes the report denominator visible.

`src/schema.js` owns validation and calculations; `src/scan.js` owns collection and snapshot replacement. To change the metrics, work from the stored minimal timestamps. Avoid persisting raw question bodies: they may contain sensitive prompts, answers, names, or structured data.

## Storage, failures, and limits

- A scan makes at most 50 sequential question GETs. Each request, including body consumption, has an 8-second deadline and a 128 KiB response cap; the whole collection has a 120-second deadline. There are no automatic retries. Slow or rate-limited scans fail and can be rerun later.
- Every returned ID, room code, asking registration, supported question shape, state, and required timestamp must validate. One failed or invalid read stops the scan and preserves any previous completed snapshot. Unknown or inaccessible IDs are not quietly dropped from the denominator.
- Results are observations collected over time, **not an atomic server snapshot**. Each saved row has its own observation time. A question can change while later questions are being read. The report makes no completeness or historical-retention guarantee; access loss, deletion, or service changes can prevent a future scan.
- `.pingroom/snapshot.json` retains only the latest successful cohort snapshot. It contains IDs, states, timestamps, and scope metadata, with no prompts, answer text, names, attachments, or raw `data`. The report prints aggregates. Both remain private operational data. Keep the directory on a local filesystem; it is bounded to 128 KiB per snapshot and written through a temporary file and atomic rename. POSIX permissions are `0700` for the directory and `0600` for created files.
- Once a snapshot exists, the credential and cohort are fixed, including the target. Changes are rejected, as are changed creation/expiry times or a terminal question reverting or changing outcome. Use a separate checkout for a different cohort or credential, including a refreshed credential. This is a local consistency check, not a cryptographic audit log.
- `.pingroom/scan.lock` permits one local writer. SIGINT/SIGTERM stops collection; a crash can leave a stale lock. Confirm no instance is still running, then remove only `scan.lock` and retry. Never remove a live lock. A failure during final file replacement can leave either the old or new complete snapshot; `npm run report` validates the file that exists.
- Corrupt or `null` saved state is an error, not a fresh start. Preserve it for investigation and restore a known-good backup. `npm run report` requires no credential or network and prints the recorded scan interval; it does not refresh old results.

No Pro-only operation is used. Access still depends on the original registration's question permissions, the current API, and applicable rate limits. A 403/404 is not proof that a question never existed. Do not reconnect to work around it; check the original credential and receipt first.

See the [official SDK](https://github.com/pingroom/sdk) and [agent API guide](https://pingroom.io/agent.md). For creating human questions, see [starter-human-review](https://github.com/pingroom/starter-human-review); for collecting room messages, see [starter-room-archive](https://github.com/pingroom/starter-room-archive).

MIT licensed; see [LICENSE](LICENSE). CI runs the tests and offline demo on Node 22 and 24 without secrets.
