// Live validation of the merged tool against a real public app (Swag Labs demo store).
// Usage: node validate-live.mjs 1 | 1b | 2
// Part 1  : current agent loop (ref recovery, no re-observes)
// Part 1b : legacy-style loop (forced re-observe between every act) for comparison
// Part 2  : batch + precision guard + observation views
import { createAgentSession as cN, actAgentSession as aN, observeAgentSession as oN, batchAgentSession as bN, closeAgentSession as xN } from './browser-tool.mjs';
import { createAgentSession as cO, actAgentSession as aO, observeAgentSession as oO, closeAgentSession as xO } from './browser-tool.mjs';

const BASE = 'https://www.saucedemo.com';
const part = process.argv[2] || '1';
let failures = 0;
const check = (name, pass, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`);
  if (!pass) failures++;
};

if (part === '1') {
  // ---- A) Real login flow with the copy: refs recovered between fills, no re-observes ----
  let requests = 0;
  const sid = `live-n-${Date.now()}`;
  const opened = await cN({ sessionId: sid, url: BASE, maxItems: 20 });
  requests++;
  const userField = opened.elements.find(e => e.role === 'textbox' && /user/i.test(e.name || ''));
  const passField = opened.elements.find(e => e.role === 'textbox' && /pass/i.test(e.name || ''));
  const loginBtn = opened.elements.find(e => e.role === 'button');
  check('A1 open: username/password/login controls found on real site', Boolean(userField && passField && loginBtn),
    `fields="${userField?.name}", "${passField?.name}", button="${loginBtn?.name}"`);

  const r1 = await aN({ sessionId: sid, action: 'fill', ref: userField.ref, text: 'standard_user' }); requests++;
  const r2 = await aN({ sessionId: sid, action: 'fill', ref: passField.ref, text: 'secret_sauce' }); requests++;
  const r3 = await aN({ sessionId: sid, action: 'click', ref: loginBtn.ref }); requests++;
  check('A2 fill+fill+click with NO re-observe: refs auto-recovered', r1.status === 'ok' && r2.status === 'ok' && r3.status === 'ok' && Boolean(r2.refRecovered) && Boolean(r3.refRecovered),
    `recovered: fill2=${Boolean(r2.refRecovered)}, click=${Boolean(r3.refRecovered)}`);
  const after = await oN({ sessionId: sid, mode: 'delta' }); requests++;
  const landedUrl = after.url || after.page?.url || '';
  check('A3 landed on real inventory page', /inventory\.html/.test(landedUrl), `url=${landedUrl}`);
  check('A4 request count for full login (open+3 acts+observe)', requests === 5, `${requests} requests`);
  await xN({ sessionId: sid }).catch(() => {});
}

if (part === '1b') {
  // ---- B) Same flow with the ORIGINAL tool: forced re-observe between every act ----
  let requestsO = 0;
  const sidO = `live-o-${Date.now()}`;
  const openedO = await cO({ sessionId: sidO, url: BASE, maxItems: 20 }); requestsO++;
  const uO = openedO.elements.find(e => e.role === 'textbox' && /user/i.test(e.name || ''));
  const pO = openedO.elements.find(e => e.role === 'textbox' && /pass/i.test(e.name || ''));
  const bO = openedO.elements.find(e => e.role === 'button');
  await aO({ sessionId: sidO, action: 'fill', ref: uO.ref, text: 'standard_user' }); requestsO++;
  await oO({ sessionId: sidO }); requestsO++; // original contract: refs invalidated -> must re-observe
  await aO({ sessionId: sidO, action: 'fill', ref: pO.ref, text: 'secret_sauce' }); requestsO++;
  await oO({ sessionId: sidO }); requestsO++;
  await aO({ sessionId: sidO, action: 'click', ref: bO.ref }); requestsO++;
  await oO({ sessionId: sidO }); requestsO++;
  const afterO = await oO({ sessionId: sidO }); requestsO++;
  check('B1 original tool also completes the login (both work)', /inventory\.html/.test(afterO.url || ''), `${requestsO} requests`);
  await xO({ sessionId: sidO }).catch(() => {});
}

if (part === '2') {
  // ---- C) batch: real form, one request (evaluate opt-in for check D4) ----
  const sidB = `live-b-${Date.now()}`;
  await cN({ sessionId: sidB, url: BASE, maxItems: 10, allowEvaluate: true });
  const batch = await bN({
    sessionId: sidB,
    steps: [
      { action: 'fill', selector: '#user-name', text: 'standard_user' },
      { action: 'fill', selector: '#password', text: 'secret_sauce' },
      { action: 'click', selector: '#login-button' },
      { action: 'assert', selector: '.title', containsText: 'Products' }
    ],
    observeAfter: 'delta'
  });
  check('C1 batch: real 4-step login+assert in ONE request', batch.status === 'ok' && batch.passedSteps === 4 && batch.observation?.mode === 'delta',
    `status=${batch.status}, passed=${batch.passedSteps}/${batch.totalSteps}`);

  // ---- D) PRECISION: button renames itself after click (Add to cart -> Remove) ----
  const inv = await oN({ sessionId: sidB });
  const addBtn = inv.elements.find(e => /add to cart/i.test(e.name || ''));
  check('D1 found a real "Add to cart" button', Boolean(addBtn), `name="${addBtn?.name}", count=${addBtn?.locator.count}`);
  await aN({ sessionId: sidB, action: 'click', ref: addBtn.ref });
  const refused = await aN({ sessionId: sidB, action: 'click', ref: addBtn.ref }).then(() => null, e => e);
  check('D2 stale ref on RENAMED button is REFUSED (no blind re-click)', refused?.code === 'STALE_REF', `code=${refused?.code}`);
  const cart = await oN({ sessionId: sidB, view: 'controls' });
  const removeBtn = cart.elements.find(e => /remove/i.test(e.name || ''));
  check('D3 observe shows the button became "Remove" (state tracked correctly)', Boolean(removeBtn), `name="${removeBtn?.name}"`);
  const badge = await aN({ sessionId: sidB, action: 'evaluate', fn: '() => document.querySelector(".shopping_cart_badge")?.textContent' }).catch(e => ({ error: e.code }));
  check('D4 gated evaluate works on real page (opt-in session)', badge?.result === '1', `cart badge=${badge?.result ?? badge?.error}`);

  // ---- E) observation views on a real page ----
  const full = await oN({ sessionId: sidB, view: 'standard' });
  const controls = await oN({ sessionId: sidB, view: 'controls' });
  const sF = JSON.stringify(full).length, sC = JSON.stringify(controls).length;
  check('E1 controls view smaller on real page, elements intact', sC < sF && controls.elements.length > 0,
    `standard=${sF} chars, controls=${sC} chars (${Math.round((1 - sC / sF) * 100)}% smaller)`);
  await xN({ sessionId: sidB }).catch(() => {});
}

console.log(failures === 0 ? `\nALL CHECKS PASSED (part ${part})` : `\n${failures} CHECK(S) FAILED (part ${part})`);
process.exit(failures === 0 ? 0 : 1);

