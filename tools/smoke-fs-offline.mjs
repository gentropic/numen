// fs-channel: a STALE bridge.live (heartbeat older than LIVENESS_MS) makes the page report
// 'offline' — not an eternal 'connecting' — and it auto-recovers to 'open' when the bridge
// heartbeats again. (The weir-OOM-aftermath fix: a dead bridge process must read as down.)
// Pure over injected adapters + a shared fake clock. Run: node tools/smoke-fs-offline.mjs
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rename, readdir, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FsChannel, FS_VERSION } from '../fs-channel.js';

let failed = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m); } };

const SECRET = Buffer.from('shared-cluster-secret-for-the-offline-smoke');
const hmac = async (s) => createHmac('sha256', SECRET).update(s).digest('hex');
const randomId = () => randomBytes(8).toString('hex');
function makeNodeDir(root) {
  const P = (n) => join(root, n);
  return {
    async read(n) { try { return await readFile(P(n), 'utf8'); } catch { return null; } },
    async write(n, s) { const f = P(n); await writeFile(f + '.tmp', s); await rename(f + '.tmp', f); },
    async list(d) { try { return await readdir(P(d)); } catch { return []; } },
    async remove(n) { try { await rm(P(n)); } catch { /* missing */ } },
    async mkdirp(d) { await mkdir(P(d), { recursive: true }); },
    async rmrf(d) { try { await rm(P(d), { recursive: true, force: true }); } catch { /* missing */ } },
  };
}

async function main() {
  const dir = makeNodeDir(await mkdtemp(join(tmpdir(), 'numen-fsoff-')));
  const clock = { t: 1_700_000_000_000 };           // shared, advanceable
  const now = () => clock.t;
  const bridge = new FsChannel({ role: 'bridge', dir, hmac, randomId, now, onMessage(m) { if (m.type === 'hello') bridge.send({ type: 'welcome', id: 'p', protocol: FS_VERSION }); } });
  const page = new FsChannel({ role: 'page', dir, hmac, randomId, now, onMessage() {} });

  await bridge.start();                              // writes bridge.live @ clock.t
  page.send({ type: 'hello', name: 'weir', path: 't' });
  await page.start();
  for (let i = 0; i < 10; i++) { await bridge.tick(); await page.tick(); }
  ok(page.state === 'open', 'page reaches open while the bridge is fresh');

  // bridge process "dies": stop heartbeating, and time marches past LIVENESS_MS (90s).
  clock.t += 200000;
  await page.tick();                                // discover sees a 200s-old bridge.live → stale
  ok(page.state === 'offline', 'stale bridge.live → page goes OFFLINE (not stuck "connecting")');

  // bridge comes back and heartbeats again → page recovers.
  await bridge.tick();                              // re-announces (200s > ANNOUNCE_INTERVAL) @ clock.t
  await page.tick();
  ok(page.state === 'open', 'page auto-recovers to open when the bridge heartbeats again');

  console.log(failed ? '\nFAIL' : '\nPASS');
  process.exit(failed ? 1 : 0);
}
main();
