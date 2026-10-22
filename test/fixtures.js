import assert from 'node:assert/strict';

export const ORIGIN = 'https://metrics-demo.invalid';
export const TOKEN = 'offline-synthetic-token';
export const NOW = '2026-10-22T12:00:00.000Z';
export const registration = '10000000-0000-4000-8000-000000000001';
export const id = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const cohort = (count = 1) => ({ version: 1, roomCode: 'DEMO01', askingRegistrationId: registration, targetSeconds: 120, questionIds: Array.from({ length: count }, (_, index) => id(index + 1)) });
export const connection = { token: TOKEN, room: 'DEMO01' };

export function question(number = 1, state = 'answered', latencySeconds = 30) {
  const created = '2026-10-22T11:50:00+00:00';
  const answerTime = new Date(Date.parse(created) + latencySeconds * 1000).toISOString();
  const expires = state === 'expired' ? '2026-10-22T11:59:00+00:00' : '2026-10-22T12:10:00+00:00';
  return {
    id: id(number), kind: 'question', is_handoff: false, resolution_policy: 'first', results: null,
    prompt: 'PRIVATE PROMPT', context: 'PRIVATE CONTEXT', options: [], text_input: { max_length: 60 },
    responder_scope: 'direct', target_user_id: '30000000-0000-4000-8000-000000000001', state,
    answer: state === 'answered' ? { value: null, label: null, text: 'PRIVATE ANSWER', responder: { id: '30000000-0000-4000-8000-000000000001', display_name: 'PRIVATE NAME' }, answered_at: answerTime } : null,
    created_at: created, expires_at: expires,
    resolved_at: state === 'pending' ? null : state === 'expired' ? expires : answerTime,
    data: { secret: 'PRIVATE STRUCTURED DATA' }, correlation_id: 'PRIVATE CORRELATION', reply_to: null,
    room: { code: 'DEMO01', name: 'PRIVATE ROOM', icon: '🔔', color: '#abcdef' }, room_code: 'DEMO01',
    asker: { type: 'agent', id: registration, display_name: 'PRIVATE AGENT NAME' },
  };
}

export function mockFetch(questions, { onRequest } = {}) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, ORIGIN);
    assert.equal(url.search, '');
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${TOKEN}`);
    const found = questions.find((q) => url.pathname === `/api/agent/questions/${q.id}`);
    assert.ok(found, 'Unexpected SDK request');
    calls.push(url.pathname);
    if (onRequest) {
      const override = await onRequest(calls.length, init);
      if (override) return override;
    }
    return Response.json(found);
  };
  return { calls, transport: { fetchImpl, origin: ORIGIN } };
}
