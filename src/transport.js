import { PingRoom } from '@pingroom/sdk';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { fail } from './schema.js';

export const API_ORIGIN = 'https://api.pingroom.io';
export const REQUEST_TIMEOUT_MS = 8_000;
export const MAX_RESPONSE_BYTES = 128 * 1024;

// The SDK accepts FetchLike (string, RequestInit?) => Promise<Response>.
// Restrict this client to the exact GETs in the cohort, including in the demo.
export function readClient({ token, questionIds, signal, origin = API_ORIGIN, fetchImpl = globalThis.fetch, requestTimeoutMs = REQUEST_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES }) {
  const allowed = new Set(questionIds.map((id) => `/api/agent/questions/${id}`));
  const boundedFetch = async (input, init) => {
    const url = new URL(input);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash || !allowed.has(url.pathname) || init?.method !== 'GET' || init.body !== undefined) fail('The metrics transport permits only configured question GET requests.');
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : []), ...(init.signal ? [init.signal] : [])]);
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const started = performance.now();
    const check = () => {
      if (performance.now() - started >= requestTimeoutMs) controller.abort();
      combined.throwIfAborted();
    };
    let reader;
    let onAbort;
    const interrupted = new Promise((_, reject) => {
      onAbort = () => reject(new Error('Question request interrupted.'));
      if (combined.aborted) onAbort();
      else combined.addEventListener('abort', onAbort, { once: true });
    });
    const consume = async () => {
      check();
      const response = await fetchImpl(input, { ...init, signal: combined, redirect: 'error' });
      if (combined.aborted) { void response.body?.cancel().catch(() => {}); combined.throwIfAborted(); }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return new Response('{"message":"PingRoom request failed."}', { status: response.status });
      }
      const declared = response.headers.get('content-length');
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
        void response.body?.cancel().catch(() => {});
        fail('Question response exceeds its size limit.');
      }
      reader = response.body?.getReader();
      const chunks = [];
      let length = 0, reads = 0;
      if (reader) {
        while (true) {
          check();
          const { value, done } = await reader.read();
          check();
          if (done) break;
          length += value.byteLength;
          if (length > maxBytes) fail('Question response exceeds its size limit.');
          if (value.byteLength) chunks.push(value);
          if (++reads % 64 === 0) await yieldTurn(undefined, { signal: combined });
        }
      }
      check();
      const bytes = Buffer.concat(chunks, length);
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return new Response(bytes, { status: response.status, headers: { 'Content-Type': 'application/json' } });
    };
    try { return await Promise.race([consume(), interrupted]); }
    finally {
      clearTimeout(timer);
      combined.removeEventListener('abort', onAbort);
      controller.abort();
      void reader?.cancel().catch(() => {});
    }
  };
  return new PingRoom({ token, baseUrl: origin, timeoutMs: requestTimeoutMs + 1000, fetch: boundedFetch });
}
