import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  actAgentSession,
  captureResponsiveScreenshots,
  closeAgentSession,
  compareVisualDiff,
  createAgentSession,
  mapInteractiveElements,
  observeAgentSession,
  probeUrl,
  runFullQA,
  runWorkflow
} from '../browser-tool.next.mjs';

const pageUrl = html => `data:text/html,${encodeURIComponent(html)}`;

test('agent session observes controls and acts using a stable ref', async () => {
  const sessionId = `test-session-${Date.now()}`;
  const opened = await createAgentSession({
    sessionId,
    url: pageUrl('<main><h1>Test page</h1><button id="change">Change</button><p id="state">before</p><script>document.querySelector("#change").onclick=()=>document.querySelector("#state").textContent="after"; setTimeout(()=>document.querySelector("#change").id="changed",50)</script></main>'),
    maxItems: 10
  });

  try {
    const button = opened.elements.find(element => element.role === 'button');
    assert.ok(button);
    assert.equal(button.name, 'Change');
    assert.equal(button.locator.role, 'button');

    await new Promise(resolve => setTimeout(resolve, 100));
    const acted = await actAgentSession({ sessionId, action: 'click', ref: button.ref });
    assert.equal(acted.status, 'ok');
    assert.equal(acted.requiresObserve, true);

    const observed = await observeAgentSession({ sessionId });
    assert.match(observed.text, /after/);
  } finally {
    await closeAgentSession({ sessionId });
  }
});

test('delta observations return only changes from the last observation', async () => {
  const sessionId = `delta-session-${Date.now()}`;
  const opened = await createAgentSession({
    sessionId,
    url: pageUrl('<main><button id="toggle">Toggle</button><p id="state">before</p><script>document.querySelector("#toggle").onclick=()=>document.querySelector("#state").textContent="after"</script></main>')
  });

  try {
    const button = opened.elements.find(element => element.role === 'button');
    assert.ok(button);
    await actAgentSession({ sessionId, action: 'click', ref: button.ref });
    const delta = await observeAgentSession({ sessionId, mode: 'delta' });

    assert.equal(delta.mode, 'delta');
    assert.match(delta.page.text, /after/);
    assert.deepEqual(delta.elements.added, []);
    assert.deepEqual(delta.elements.removed, []);
  } finally {
    await closeAgentSession({ sessionId });
  }
});

test('workflow returns step-level evidence for successful actions', async () => {
  const result = await runWorkflow({
    steps: [
      { action: 'navigate', url: pageUrl('<h1>Workflow page</h1>') },
      { action: 'assert', selector: 'h1', containsText: 'Workflow page' }
    ]
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.stepResults.length, 2);
  assert.equal(result.stepResults[1].verifiedText, 'Workflow page');
});

test('workflow press targets its selector and bare scroll reaches page content', async () => {
  const result = await runWorkflow({
    steps: [
      { action: 'navigate', url: pageUrl('<input id="command"><p id="status">idle</p><div style="height:4000px"></div><script>document.querySelector("#command").addEventListener("keydown", event => { if (event.key === "Enter") document.querySelector("#status").textContent = "pressed"; });</script>') },
      { action: 'press', selector: '#command', key: 'Enter' },
      { action: 'scroll' },
      { action: 'assert', selector: '#status', containsText: 'pressed' },
      { action: 'evaluate', script: 'window.scrollY > 0' }
    ]
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.stepResults[4].result, true);
});

test('workflow preserves an undefined evaluate result as null', async () => {
  const result = await runWorkflow({
    steps: [
      { action: 'navigate', url: pageUrl('<h1>Undefined result</h1>') },
      { action: 'evaluate', script: 'void 0' }
    ]
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.stepResults[1].result, null);
});

test('one-shot map stays bounded and includes page context', async () => {
  const result = await mapInteractiveElements({
    url: pageUrl('<main><h1>Map page</h1><div aria-hidden="true"><button>Hidden</button></div><button>First</button><button>Second</button><p>bounded context</p></main>'),
    maxItems: 1,
    maxText: 100
  });

  assert.equal(result.returnedElements, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.headings[0].text, 'Map page');
  assert.equal(result.elements[0].tag, 'button');
  assert.equal(result.elements[0].role, 'button');
  assert.equal(result.elements[0].label, 'First');
  assert.match(result.text, /bounded context/);
});

test('workflow rejects invalid retry counts before launching a browser', async () => {
  await assert.rejects(
    runWorkflow({ steps: [{ action: 'wait', ms: 1, retries: -1 }] }),
    /retries must be an integer from 0 to 10/
  );
});

test('safe mode blocks arbitrary workflow evaluation', async () => {
  const result = await runWorkflow({
    safetyMode: 'safe',
    steps: [
      { action: 'navigate', url: pageUrl('<h1>Safe page</h1>') },
      { action: 'evaluate', script: 'document.title = "changed"' }
    ]
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'UNSAFE_ACTION');
  assert.equal(result.stepResults[1].code, 'UNSAFE_ACTION');
});

test('safe mode blocks cross-origin navigation unless the host is allowed', async () => {
  const createServer = () => new Promise(resolve => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<h1>${request.url}</h1>`);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  const firstServer = await createServer();
  const secondServer = await createServer();
  const firstPort = firstServer.address().port;
  const secondPort = secondServer.address().port;

  try {
    const blocked = await runWorkflow({
      safetyMode: 'safe',
      steps: [
        { action: 'navigate', url: `http://127.0.0.1:${firstPort}/first` },
        { action: 'navigate', url: `http://127.0.0.1:${secondPort}/second` }
      ]
    });
    assert.equal(blocked.status, 'failed');
    assert.equal(blocked.errorCode, 'NAVIGATION_BLOCKED');

    const allowed = await runWorkflow({
      safetyMode: 'safe',
      allowedHosts: [`127.0.0.1:${secondPort}`],
      steps: [
        { action: 'navigate', url: `http://127.0.0.1:${firstPort}/first` },
        { action: 'navigate', url: `http://127.0.0.1:${secondPort}/second` }
      ]
    });
    assert.equal(allowed.status, 'passed');
  } finally {
    await new Promise(resolve => firstServer.close(resolve));
    await new Promise(resolve => secondServer.close(resolve));
  }
});

test('safe mode blocks an initial file outside the workspace', async () => {
  const sessionId = `safe-file-session-${Date.now()}`;
  const outsideUrl = pathToFileURL(path.resolve('..', 'browser-tool-outside.html')).href;
  await assert.rejects(
    createAgentSession({ sessionId, url: outsideUrl, safetyMode: 'safe' }),
    /Safe mode only permits file navigation inside the current workspace/
  );
});

test('safe mode blocks workflow state output outside the workspace', async () => {
  const outsideStatePath = path.resolve('..', 'browser-tool-outside-state.json');
  await assert.rejects(
    runWorkflow({
      safetyMode: 'safe',
      saveStatePath: outsideStatePath,
      steps: [{ action: 'navigate', url: pageUrl('<h1>Safe state</h1>') }]
    }),
    /Safe mode only permits artifact paths inside the current workspace/
  );
});

test('safe mode applies to one-shot navigation and artifact paths', async () => {
  const outsideUrl = pathToFileURL(path.resolve('..', 'browser-tool-one-shot-outside.html')).href;
  await assert.rejects(
    mapInteractiveElements({ url: outsideUrl, safetyMode: 'safe' }),
    /Safe mode only permits file navigation inside the current workspace/
  );
  await assert.rejects(
    captureResponsiveScreenshots({
      url: pageUrl('<h1>Safe screenshot</h1>'),
      safetyMode: 'safe',
      outputDir: path.resolve('..', 'browser-tool-one-shot-artifacts')
    }),
    /Safe mode only permits artifact paths inside the current workspace/
  );
});

test('persistent sessions enforce limits and expire when idle', async () => {
  const sessionId = `lifecycle-session-${Date.now()}`;
  await createAgentSession({
    sessionId,
    url: pageUrl('<h1>Lifecycle</h1>'),
    maxSessions: 1,
    idleTimeout: 250
  });

  try {
    await assert.rejects(
      createAgentSession({ sessionId: 'second-session', url: pageUrl('<h1>Second</h1>'), maxSessions: 1 }),
      /Maximum active agent sessions reached/
    );
    await new Promise(resolve => setTimeout(resolve, 350));
    await assert.rejects(
      observeAgentSession({ sessionId }),
      /expired after 250ms/
    );
  } finally {
    await closeAgentSession({ sessionId }).catch(() => {});
  }
});

test('workflow fails when an expected dialog never appears', async () => {
  const result = await runWorkflow({
    steps: [
      { action: 'navigate', url: pageUrl('<h1>No dialog</h1>') },
      { action: 'dialog', type: 'accept' }
    ]
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.stepResults[1].status, 'error');
  assert.match(result.error, /workflow ended before an action opened it/);
});

test('probe records console.warn diagnostics', async () => {
  const result = await probeUrl({
    url: pageUrl('<script>console.warn("warning evidence")</script><h1>Probe page</h1>')
  });

  assert.equal(result.consoleLogs.totalWarnings, 1);
  assert.equal(result.consoleLogs.warnings[0].text, 'warning evidence');
});

test('diagnostic URL filters suppress only configured noise', async () => {
  const result = await probeUrl({
    url: pageUrl('<script>console.error("ignored noise")</script><h1>Filtered</h1>'),
    ignoreUrls: ['data:*']
  });

  assert.equal(result.consoleLogs.totalErrors, 0);
});

test('standard QA reports small targets without failing by default', async () => {
  const fixtureUrl = pathToFileURL(path.resolve('fixtures/browser-playground.html')).href;
  const result = await runFullQA({ frontendUrl: fixtureUrl, mode: 'standard', json: true });

  try {
    assert.equal(result.passed, true);
    assert.equal(result.quality.layout.smallTapTargetsEnforced, false);
    assert.ok(result.quality.layout.smallTapTargets > 0);
  } finally {
    for (const file of result.responsive?.files || []) await fs.unlink(file.path).catch(() => {});
  }
});

test('custom screenshot sizes can be used for visual diff baselines', async () => {
  const url = pageUrl('<h1>Custom diff</h1>');
  let baselinePath;
  try {
    const capture = await captureResponsiveScreenshots({
      url,
      presets: [],
      customSizes: [{ width: 320, height: 240 }]
    });
    baselinePath = capture.files[0].path;
    const result = await compareVisualDiff({
      url,
      baselinePath,
      customViewport: { width: 320, height: 240 }
    });

    assert.equal(result.match, true);
    assert.equal(result.exactHashMatch, true);
  } finally {
    if (baselinePath) await fs.unlink(baselinePath).catch(() => {});
  }
});

test('workflow returns structured evidence for a failed action', async () => {
  const result = await runWorkflow({
    steps: [
      { action: 'navigate', url: pageUrl('<h1>Failure page</h1>') },
      { action: 'assert', selector: 'h1', containsText: 'missing text' }
    ]
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.passedSteps, 1);
  assert.equal(result.stepResults[1].status, 'error');
  assert.match(result.error, /Text mismatch/);
});
