// Real-browser test for shim.js: load the actual shim in Chromium, inject a mock
// fetch standing in for the bridge transport, and exercise the full state machine
// — HTTP-transport selection (injected fetch ⇒ WS skipped), connect, tools_changed,
// long-poll, and a tool_invoke → execute → tool_result round trip. Deterministic
// (no real sockets — the real bridge protocol is covered by tools/smoke.mjs).
//
// Uses the sibling Playwright (../../bridge/node_modules), so this is a LOCAL test,
// not part of the zero-dep `npm run smoke`.  Run: node tools/e2e-browser.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pw from '../../bridge/node_modules/playwright/index.js';
const { chromium } = pw;

const here = path.dirname(fileURLToPath(import.meta.url));
const shimCode = fs.readFileSync(path.join(here, '..', 'shim.js'), 'utf8');

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); if (process.env.WEBMCP_DEBUG) console.error(`[page:${m.type()}]`, m.text()); });
  await page.goto('about:blank');
  await page.addScriptTag({ content: shimCode });

  // The shim must have polyfilled navigator.modelContext (no native one here).
  const installed = await page.evaluate(() => ({
    api: !!window.gcuWebMCP,
    polyfill: !!navigator.modelContext,
    alias: window.__auditable_mcp === window.gcuWebMCP,
  }));
  assert.ok(installed.api, 'window.gcuWebMCP installed');
  assert.ok(installed.polyfill, 'navigator.modelContext polyfilled');
  assert.ok(installed.alias, '__auditable_mcp back-compat alias');

  // Drive the shim as weir would on a public origin: inject a fetch (here an
  // in-page MOCK bridge), register a tool, connect.
  await page.evaluate(() => {
    const m = window.gcuWebMCP;
    const st = (window.__bridge = { sent: [], pollQueue: [], pollResolvers: [], usedHttp: false });
    const reply = (obj) => ({ json: async () => obj });
    m.fetch = async (url, opts) => {
      st.usedHttp = true;
      const u = new URL(url);
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      if (u.pathname === '/connect') return reply({ type: 'welcome', id: 'weir', protocol: 1 });
      if (u.pathname === '/send') { st.sent.push(body.message); return reply({ ok: true }); }
      if (u.pathname === '/poll') {
        if (st.pollQueue.length) return reply(st.pollQueue.splice(0));
        return new Promise((resolve) => st.pollResolvers.push(() => resolve(reply(st.pollQueue.splice(0)))));
      }
      return reply({});
    };
    // Deliver a bridge→page message to the next/awaiting poll.
    window.__deliver = (msg) => { st.pollQueue.push(msg); const r = st.pollResolvers.shift(); if (r) r(); };
    m.name = 'weir';
    navigator.modelContext.registerTool({
      name: 'echo',
      description: 'Echo text back',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      annotations: { readOnlyHint: true },
      execute: async ({ text }) => ({ echoed: text, by: m.clientId }),
    });
    m.connect('7801:tok');
  });

  await page.waitForFunction(() => window.gcuWebMCP.state === 'connected', null, { timeout: 8000 });

  // tools_changed should have gone out over the injected (HTTP) transport with the tool.
  const afterConnect = await page.evaluate(() => ({
    usedHttp: window.__bridge.usedHttp,
    sentTypes: window.__bridge.sent.map((s) => s.type),
    toolNames: (window.__bridge.sent.find((s) => s.type === 'tools_changed')?.tools || []).map((t) => t.name),
  }));
  assert.equal(afterConnect.usedHttp, true, 'injected fetch (HTTP transport) used — WS skipped');
  assert.ok(afterConnect.sentTypes.includes('tools_changed'), 'tools_changed sent on connect');
  assert.deepEqual(afterConnect.toolNames, ['echo'], 'registered tool advertised to the bridge');

  // Deliver a tool_invoke and assert the shim executes it and posts a tool_result.
  await page.evaluate(() => window.__deliver({ type: 'tool_invoke', callId: 'c1', name: 'echo', input: { text: 'hello from claude' } }));
  await page.waitForFunction(() => window.__bridge.sent.some((s) => s.type === 'tool_result' && s.callId === 'c1'), null, { timeout: 5000 });

  const result = await page.evaluate(() => window.__bridge.sent.find((s) => s.type === 'tool_result' && s.callId === 'c1'));
  assert.equal(result.error, undefined, 'tool executed without error');
  assert.deepEqual(result.result, { echoed: 'hello from claude', by: 'weir' }, 'tool result round-tripped');

  // Unknown tool → error result (not a throw that kills the poll loop).
  await page.evaluate(() => window.__deliver({ type: 'tool_invoke', callId: 'c2', name: 'nope', input: {} }));
  await page.waitForFunction(() => window.__bridge.sent.some((s) => s.type === 'tool_result' && s.callId === 'c2'), null, { timeout: 5000 });
  const err = await page.evaluate(() => window.__bridge.sent.find((s) => s.callId === 'c2'));
  assert.match(err.error || '', /not found/i, 'unknown tool returns an error result');

  assert.equal(errors.length, 0, `no page errors (${errors.join('; ')})`);
  console.log('browser shim e2e ok:', JSON.stringify({ result: result.result, sent: afterConnect.sentTypes.length + 2 }));
  await browser.close();
  process.exit(0);
} catch (e) {
  console.error(e);
  try { await browser.close(); } catch {}
  process.exit(1);
}
