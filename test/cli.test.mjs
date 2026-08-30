import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { runFullQA, runWorkflow } from '../browser-tool.mjs';

const execFileAsync = promisify(execFile);
const toolPath = fileURLToPath(new URL('../browser-tool.mjs', import.meta.url));

test('CLI help documents browser selection and diagnostics', async () => {
  const { stdout } = await execFileAsync(process.execPath, [toolPath, '--help']);
  assert.match(stdout, /doctor/);
  assert.match(stdout, /--executable/);
  assert.match(stdout, /--trace/);
  assert.match(stdout, /--mode/);
  assert.match(stdout, /--chaos-seed/);
  assert.match(stdout, /--max-output-chars/);
  assert.match(stdout, /--safe/);
  assert.match(stdout, /capabilities/);
});

test('presets command is available without a browser binary', async () => {
  const { stdout } = await execFileAsync(process.execPath, [toolPath, 'presets']);
  assert.match(stdout, /tablet-landscape/);
  assert.match(stdout, /slow-3g/);
  assert.match(stdout, /release/);
});

test('capabilities command is available without a browser binary', async () => {
  const { stdout } = await execFileAsync(process.execPath, [toolPath, 'capabilities', '--json']);
  const result = JSON.parse(stdout);
  assert.equal(result.protocolVersion, '1');
  assert.ok(result.commands.includes('capabilities'));
  assert.ok(result.workflowActions.includes('evaluate'));
  assert.equal(result.maximumLimits.maxSessionWatchers, 32);
});

test('CLI resolves portable local fixture URLs', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [toolPath, 'map', 'file://{{cwd}}/fixtures/browser-playground.html', '--json', '--max-items=1'],
    { cwd: path.dirname(toolPath) }
  );
  const result = JSON.parse(stdout);
  assert.equal(result.title, 'Moonlight Tea Lab');
  assert.equal(result.returnedElements, 1);
});

test('JSONL sessions preserve request IDs when output is bounded', async () => {
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
    JSON.stringify({ requestId: 'cap-1', op: 'capabilities', maxOutputChars: 10000 }),
    JSON.stringify({ requestId: 'open-1', op: 'open', sessionId: 'bounded', url: 'file://{{cwd}}/fixtures/browser-playground.html', maxItems: 1, maxText: 100, maxOutputChars: 512 }),
    JSON.stringify({ requestId: 'close-1', op: 'close', sessionId: 'bounded' }),
    JSON.stringify({ requestId: 'quit-1', op: 'quit' })
  ].join('\n') + '\n');
  const [exitCode] = await once(child, 'close');
  assert.equal(exitCode, 0, stderr);
  const responses = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(responses.map(response => response.requestId), ['cap-1', 'open-1', 'close-1', 'quit-1']);
  assert.equal(responses[0].protocolVersion, '1');
  assert.equal(responses[1].outputTruncated, true);
  assert.equal(responses[1].ok, true);
  assert.ok(JSON.stringify(responses[1]).length <= 512);
  assert.ok(responses[0].workflowActions.includes('mockRoute'));
  assert.ok(responses[0].sessionOperations.includes('exit'));
  assert.equal(responses[0].maximumLimits.maxSessionRequestChars, 250000);
});

test('CLI preserves numeric-looking token values', async () => {
  const server = http.createServer((request, response) => {
    const authorized = request.headers.authorization === 'Bearer 123';
    response.writeHead(authorized ? 200 : 401, { 'content-type': 'text/html' });
    response.end('<h1>Token test</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [toolPath, 'probe', `http://127.0.0.1:${port}/`, '--token=123', '--json'],
      { cwd: path.dirname(toolPath) }
    );
    const result = JSON.parse(stdout);
    assert.equal(result.httpStatus, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('JSONL subscriptions emit event-driven watcher matches', async () => {
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
    JSON.stringify({ requestId: 'open-events', op: 'open', sessionId: 'events', url: 'file://{{cwd}}/fixtures/browser-playground.html', maxItems: 6, maxText: 100 }),
    JSON.stringify({ requestId: 'subscribe-events', op: 'subscribe', sessionId: 'events', subscriptionId: 'sub-events', events: ['watch.matched'] }),
    JSON.stringify({ requestId: 'watch-status', op: 'watch', sessionId: 'events', watcherId: 'status-ready', selector: '#status', containsText: 'ready', timeout: 5000 }),
    JSON.stringify({ requestId: 'click-brew', op: 'act', sessionId: 'events', action: 'click', ref: 'e4' }),
    JSON.stringify({ requestId: 'unsubscribe-events', op: 'unsubscribe', sessionId: 'events', subscriptionId: 'sub-events' }),
    JSON.stringify({ requestId: 'close-events', op: 'close', sessionId: 'events' }),
    JSON.stringify({ requestId: 'quit-events', op: 'quit' })
  ].join('\n') + '\n');
  const [exitCode] = await once(child, 'close');
  assert.equal(exitCode, 0, stderr);
  const responses = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  const event = responses.find(response => response.type === 'event' && response.event === 'watch.matched');
  assert.ok(event);
  assert.equal(event.data.watcherId, 'status-ready');
  assert.match(event.data.text, /ready/);
  assert.ok(responses.some(response => response.requestId === 'click-brew' && response.ok === true));
  assert.ok(responses.some(response => response.requestId === 'unsubscribe-events' && response.ok === true));
});

test('validation fails before browser launch for unsafe or unknown modes', async () => {
  await assert.rejects(
    runFullQA({ mode: 'unknown' }),
    /Unknown QA mode/
  );
  await assert.rejects(
    runWorkflow({ steps: [{ action: 'wait', ms: 1 }], redact: true, trace: 'on' }),
    /Tracing with redaction is disabled by default/
  );
  await assert.rejects(
    runWorkflow({ steps: [{ action: 'not-a-supported-action' }] }),
    /Unsupported action/
  );
});
