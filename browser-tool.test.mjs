import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as browserTool from './browser-tool.mjs';

const { actAgentSession, closeAgentSession, createAgentSession } = browserTool;
const cliPath = fileURLToPath(new URL('./browser-tool.mjs', import.meta.url));

test('retired browser selection flags fail clearly', () => {
  const result = spawnSync(process.execPath, [cliPath, 'doctor', '--browser=msedge', '--json'], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'error',
    code: 'UNSUPPORTED_OPTION',
    error: '--browser is not supported; browser-tool always uses bundled Chromium.'
  });
});

test('file-based workflow surfaces are retired', () => {
  assert.equal('runWorkflow' in browserTool, false);

  const capabilities = JSON.parse(spawnSync(process.execPath, [cliPath, 'capabilities', '--json'], { encoding: 'utf8' }).stdout);
  assert.equal(capabilities.commands.includes('interact'), false);
  assert.equal('workflowActions' in capabilities, false);
  assert.equal(Object.keys(capabilities.defaultLimits).some(key => key.toLowerCase().includes('workflow')), false);

  const help = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' }).stdout;
  assert.doesNotMatch(help, /interact|workflow|--trace|--snapshots|--video-dir|--video-filename|--save-state|--record/);

  const retiredCommand = spawnSync(process.execPath, [cliPath, 'interact', 'flow.json', '--json'], { encoding: 'utf8' });
  assert.equal(retiredCommand.status, 1);
  assert.equal(JSON.parse(retiredCommand.stdout).code, 'RETIRED_COMMAND');

  const retiredQaOption = spawnSync(process.execPath, [cliPath, 'qa', '--workflow=x', '--json'], { encoding: 'utf8' });
  assert.equal(retiredQaOption.status, 1);
  assert.equal(JSON.parse(retiredQaOption.stdout).code, 'UNSUPPORTED_OPTION');

  const retiredAlias = spawnSync(process.execPath, [cliPath, 'session', '--json'], { encoding: 'utf8' });
  assert.equal(retiredAlias.status, 1);
  assert.equal(JSON.parse(retiredAlias.stdout).code, 'RETIRED_COMMAND');

  const retiredRecording = spawnSync(process.execPath, [cliPath, 'screenshot', 'https://example.com', '--record', '--json'], { encoding: 'utf8' });
  assert.equal(retiredRecording.status, 1);
  assert.equal(JSON.parse(retiredRecording.stdout).code, 'UNSUPPORTED_OPTION');
});

test('act forwards delta observation options', async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<main style="height:1800px"><button onclick="this.textContent=\'Done\'">Start</button></main>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const sessionId = `delta-${Date.now()}`;
  const screenshotPath = path.join(os.tmpdir(), `${sessionId}.png`);
  const viewportScreenshotPath = path.join(os.tmpdir(), `${sessionId}-viewport.png`);

  try {
    await createAgentSession({ sessionId, url: `http://127.0.0.1:${address.port}` });
    await assert.rejects(
      actAgentSession({ sessionId, action: 'click', selector: 'button', observe: true, mode: 'invalid' }),
      error => error?.code === 'INVALID_OBSERVE_MODE'
    );
    await actAgentSession({ sessionId, action: 'assert', selector: 'button', equalsText: 'Start' });

    const result = await actAgentSession({
      sessionId,
      action: 'click',
      selector: 'button',
      observe: true,
      mode: 'delta',
      view: 'controls'
    });

    assert.equal(result.observation.mode, 'delta');
    assert.equal(result.observation.deltaFallbackReason, undefined);

    const screenshot = await actAgentSession({ sessionId, action: 'screenshot', path: screenshotPath });
    const png = await fs.readFile(screenshotPath);
    assert.deepEqual(screenshot.capture, { mode: 'full-page', delayMs: 250 });
    assert(png.readUInt32BE(20) > 1000, 'default screenshot should extend beyond the viewport');

    const viewportScreenshot = await actAgentSession({ sessionId, action: 'screenshot', path: viewportScreenshotPath, fullPage: false, delay: 0 });
    assert.deepEqual(viewportScreenshot.capture, { mode: 'viewport', delayMs: 0 });
  } finally {
    await fs.unlink(screenshotPath).catch(() => {});
    await fs.unlink(viewportScreenshotPath).catch(() => {});
    await closeAgentSession({ sessionId }).catch(() => {});
    await new Promise(resolve => server.close(resolve));
  }
});
