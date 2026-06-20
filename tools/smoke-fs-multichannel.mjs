// smoke-fs-multichannel.mjs — proves the SHIM's multichannel fs dispatch contract
// (SPEC-numen-multichannel.md): ONE page serving N bridges over N folders, each its
// own FsChannel, all sharing a SINGLE tool registry, with (a) replies routed back to
// the calling channel and (b) the calling channel's `identity` (folder = identity)
// carried into tool execution — the SPEC-librarian §2 provenance hook.
//
// The shim (shim.js) is an IIFE bound to navigator/window, so it can't be driven in
// node directly; this models its dispatch with the same FsChannel primitive + the
// SAME _handleInvoke logic the shim now uses (shared `tools` Map, per-call identity).
// Live wiring is covered by e2e-browser / the deployed PWA. Mirrors smoke-fs.mjs.
//
// Run: node tools/smoke-fs-multichannel.mjs   (exit 0 = pass)

import { mkdtemp, readFile, writeFile, rename, readdir, rm, mkdir } from 'node:fs/promises';
import { createHmac, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsChannel, FS_VERSION } from '../fs-channel.js';

let failed = 0;
function ok(cond, msg) { if (cond) { console.log('  ✓ ' + msg); } else { failed++; console.log('  ✗ ' + msg); } }

const SECRET = Buffer.from('shared-cluster-secret-for-the-smoke');
const hmac = async (str) => createHmac('sha256', SECRET).update(str).digest('hex');
const randomId = () => randomBytes(8).toString('hex');

function makeNodeDir(root) {
  const P = (name) => join(root, name);
  return {
    async read(name) { try { return await readFile(P(name), 'utf8'); } catch { return null; } },
    async write(name, str) { const f = P(name); await writeFile(f + '.tmp', str); await rename(f + '.tmp', f); },
    async list(dir) { try { return await readdir(P(dir)); } catch { return []; } },
    async remove(name) { try { await rm(P(name)); } catch { /* missing */ } },
    async mkdirp(dir) { await mkdir(P(dir), { recursive: true }); },
    async rmrf(dir) { try { await rm(P(dir), { recursive: true, force: true }); } catch { /* missing */ } },
  };
}

// ── the SHARED tool registry + dispatch, identical in shape to the shim's _handleInvoke ──
const tools = new Map();
tools.set('ping', { execute: (input) => ({ pong: input.n * 2 }) });
tools.set('whoami', { execute: (input, client) => ({ identity: client.identity }) });   // reads the per-call identity
function handleInvoke(msg, reply, identity) {
  const tool = tools.get(msg.name);
  if (!tool) { reply({ type: 'tool_result', callId: msg.callId, error: 'Tool not found: ' + msg.name }); return; }
  const client = { identity: identity || null };
  Promise.resolve().then(() => tool.execute(msg.input || {}, client))
    .then((result) => reply({ type: 'tool_result', callId: msg.callId, result }))
    .catch((e) => reply({ type: 'tool_result', callId: msg.callId, error: (e && e.message) || String(e) }));
}

async function pumpAll(chs, done, max = 160) { for (let i = 0; i < max; i++) { for (const c of chs) await c.tick(); if (done()) return true; } return done(); }

async function main() {
  // two independent folders = two channels = two agents (librarian + dev)
  const rootA = await mkdtemp(join(tmpdir(), 'numen-mc-a-'));
  const rootB = await mkdtemp(join(tmpdir(), 'numen-mc-b-'));
  const dirA = makeNodeDir(rootA), dirB = makeNodeDir(rootB);

  const got = {};   // tag → last tool_result seen by that tag's bridge

  // each bridge: welcome on hello, then invoke `whoami` once tools arrive
  function makeBridge(tag, dir) {
    const b = new FsChannel({
      role: 'bridge', dir, hmac, randomId,
      onMessage(m) {
        if (m.type === 'hello') b.send({ type: 'welcome', id: 'page-' + tag, protocol: FS_VERSION });
        else if (m.type === 'tools_changed') b.send({ type: 'tool_invoke', callId: 'c-' + tag, name: 'whoami', input: {} });
        else if (m.type === 'tool_result') got[tag] = m;
      },
    });
    return b;
  }
  // one page per folder, but a SINGLE shared `tools` registry + dispatch (the shim's job).
  // `identity` is the channel's (folder = identity) — carried into handleInvoke.
  function makePage(tag, dir, identity) {
    const seen = [];
    const p = new FsChannel({
      role: 'page', dir, hmac, randomId,
      onMessage(m) {
        seen.push(m.type);
        if (m.type === 'welcome') p.send({ type: 'tools_changed', tools: [{ name: 'ping' }, { name: 'whoami' }] });
        else if (m.type === 'tool_invoke') handleInvoke(m, (o) => p.send(o), identity);
      },
    });
    p._seen = seen;
    return p;
  }

  console.log('two channels, one registry, identity + reply routing per channel:');
  const bridgeA = makeBridge('A', dirA), bridgeB = makeBridge('B', dirB);
  const pageA = makePage('A', dirA, 'claude:librarian'), pageB = makePage('B', dirB, 'claude:dev');
  await bridgeA.start(); await bridgeB.start();
  pageA.send({ type: 'hello', name: 'weir', path: 'A' });
  pageB.send({ type: 'hello', name: 'weir', path: 'B' });
  await pageA.start(); await pageB.start();
  await pumpAll([bridgeA, bridgeB, pageA, pageB], () => got.A && got.B);

  ok(got.A && got.B, 'both channels completed a round-trip concurrently');
  ok(got.A && got.A.result && got.A.result.identity === 'claude:librarian', 'channel A carried its identity into the tool (claude:librarian)');
  ok(got.B && got.B.result && got.B.result.identity === 'claude:dev', 'channel B carried its identity into the tool (claude:dev)');
  ok(got.A && got.A.callId === 'c-A' && got.B && got.B.callId === 'c-B', 'replies routed back to the calling channel (callIds did not cross)');
  ok(pageA.session !== pageB.session, 'the two channels are independent sessions (no shared bridge.live)');

  await rm(rootA, { recursive: true, force: true });
  await rm(rootB, { recursive: true, force: true });
}

main().then(() => {
  console.log(failed ? `\nFAIL (${failed})` : '\nPASS');
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
