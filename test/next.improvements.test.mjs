import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  actAgentSession,
  closeAgentSession,
  createAgentSession,
  listAgentSessions,
  observeAgentSession
} from '../browser-tool.next.mjs';

const pageUrl = html => `data:text/html,${encodeURIComponent(html)}`;
const toolPath = fileURLToPath(new URL('../browser-tool.next.mjs', import.meta.url));

test('stale refs fail fast with machine-readable evidence instead of burning the action timeout', async () => {
  const sessionId = `stale-ref-${Date.now()}`;
  // The button disappears AFTER the open-observation, so session.refs still
  // holds the entry and resolveAgentRef must detect the dead locator itself.
  const opened = await createAgentSession({
    sessionId,
    url: pageUrl('<main><button id="doomed">Vanish</button><script>setTimeout(() => document.getElementById("doomed").remove(), 250)</script></main>'),
    maxItems: 10
  });

  try {
    const button = opened.elements.find(element => element.role === 'button');
    assert.ok(button);
    await new Promise(resolve => setTimeout(resolve, 400));

    const startedAt = Date.now();
    await assert.rejects(
      actAgentSession({ sessionId, action: 'click', ref: button.ref }),
      error => {
        assert.equal(error.name, 'BrowserToolError');
        assert.equal(error.code, 'STALE_REF');
        assert.match(error.message, /Observe again/);
        assert.ok(Array.isArray(error.details?.tried) && error.details.tried.length > 0);
        assert.ok(error.details.tried.every(attempt => attempt.resolved === false && attempt.reason));
        assert.match(error.details?.hint, /observe/i);
        return true;
      }
    );
    // Two bounded candidate checks (1s each) must beat the previous behaviour,
    // where a dead locator burned the full 8s default action timeout.
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 6000, `stale ref took ${elapsed}ms; expected fast failure`);
  } finally {
    await closeAgentSession({ sessionId }).catch(() => {});
  }
});

test('live refs still resolve after the stale-ref fast-fail change', async () => {
  const sessionId = `live-ref-${Date.now()}`;
  const opened = await createAgentSession({
    sessionId,
    url: pageUrl('<main><button id="keep" onclick="document.title=\'clicked\'">Stay</button></main>'),
    maxItems: 10
  });

  try {
    const button = opened.elements.find(element => element.role === 'button');
    const acted = await actAgentSession({ sessionId, action: 'click', ref: button.ref });
    assert.equal(acted.status, 'ok');
    assert.equal(acted.title, 'clicked');
  } finally {
    await closeAgentSession({ sessionId }).catch(() => {});
  }
});

test('semantic nth indices stay correct for duplicate controls after the O(n) rewrite', async () => {
  const sessionId = `semantic-${Date.now()}`;
  const opened = await createAgentSession({
    sessionId,
    url: pageUrl('<main><button id="b1">Pick</button><button id="b2">Pick</button><button id="b3">Pick</button><p id="out">none</p><script>for (const id of ["b1","b2","b3"]) document.getElementById(id).onclick = event => document.getElementById("out").textContent = event.target.id;</script></main>'),
    maxItems: 10
  });

  try {
    const buttons = opened.elements.filter(element => element.role === 'button');
    assert.equal(buttons.length, 3);
    assert.deepEqual(buttons.map(button => button.locator.nth), [0, 1, 2]);

    const observed = await observeAgentSession({ sessionId });
    const refreshed = observed.elements.filter(element => element.role === 'button');
    assert.deepEqual(refreshed.map(button => button.locator.nth), [0, 1, 2]);

    // The third identical button must still map to the real third element.
    await actAgentSession({ sessionId, action: 'click', ref: refreshed[2].ref });
    const after = await observeAgentSession({ sessionId });
    assert.match(after.text, /b3/);
  } finally {
    await closeAgentSession({ sessionId }).catch(() => {});
  }
});

test('listAgentSessions reports active sessions with recovery metadata', async () => {
  const first = `listed-a-${Date.now()}`;
  const second = `listed-b-${Date.now()}`;
  await createAgentSession({ sessionId: first, url: pageUrl('<h1>First</h1>'), idleTimeout: 60000 });
  await createAgentSession({ sessionId: second, url: pageUrl('<h1>Second</h1>'), idleTimeout: 60000 });

  try {
    const listed = listAgentSessions();
    const ids = listed.map(session => session.sessionId);
    assert.ok(ids.includes(first));
    assert.ok(ids.includes(second));

    const entry = listed.find(session => session.sessionId === first);
    for (const key of ['url', 'safetyMode', 'generation', 'idleTimeoutMs', 'msSinceLastActivity', 'expiresInMillis', 'subscriptions', 'watchers']) {
      assert.ok(Object.prototype.hasOwnProperty.call(entry, key), `missing field: ${key}`);
    }
    assert.equal(entry.safetyMode, 'standard');
    assert.equal(entry.watchers, 0);
    assert.ok(entry.expiresInMillis > 0);
  } finally {
    await closeAgentSession({ sessionId: first }).catch(() => {});
    await closeAgentSession({ sessionId: second }).catch(() => {});
  }
  assert.equal(listAgentSessions().some(session => session.sessionId === first), false);
});

test('serve exposes the sessions discovery operation and capabilities advertise it', async () => {
  const child = spawn(process.execPath, [toolPath, 'serve'], {
    cwd: path.dirname(toolPath),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end([
    JSON.stringify({ requestId: 'cap', op: 'capabilities' }),
    JSON.stringify({ requestId: 'list-empty', op: 'sessions' }),
    JSON.stringify({ requestId: 'open', op: 'open', sessionId: 'discovery', url: 'file://{{cwd}}/fixtures/browser-playground.html', maxItems: 4, maxText: 100 }),
    JSON.stringify({ requestId: 'list-one', op: 'sessions' }),
    JSON.stringify({ requestId: 'close', op: 'close', sessionId: 'discovery' }),
    JSON.stringify({ requestId: 'quit', op: 'quit' })
  ].join('\n') + '\n');
  const [exitCode] = await once(child, 'close');
  assert.equal(exitCode, 0, stderr);

  const responses = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.ok(responses.find(r => r.requestId === 'cap').sessionOperations.includes('sessions'));

  const empty = responses.find(r => r.requestId === 'list-empty');
  assert.equal(empty.ok, true);
  assert.equal(empty.activeSessions, 0);
  assert.deepEqual(empty.sessions, []);

  const one = responses.find(r => r.requestId === 'list-one');
  assert.equal(one.ok, true);
  assert.equal(one.activeSessions, 1);
  assert.equal(one.sessions[0].sessionId, 'discovery');
  assert.match(one.sessions[0].url, /browser-playground\.html/);
});