// smoke-fs-sessions-reap.mjs — the bridge sweeps stale sessions/<X> dirs on announce (sibling of
// the live/ reap). A prior bridge run / old page reconnect orphans a session tree; we rmrf any
// session with no LIVE announce. A co-resident LIVE bridge's session (fresh, VALIDLY-SIGNED
// live/<X>.json) and our own are kept. Run: node tools/smoke-fs-sessions-reap.mjs
import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { readFile, writeFile, rename, readdir, rm, mkdir } from 'node:fs/promises';
import { createHmac, hkdfSync } from 'node:crypto';
import { FsChannel, FS_VERSION } from '../fs-channel.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gcu-sreap-'));
const key = Buffer.from(hkdfSync('sha256', Buffer.from('tok', 'utf8'), Buffer.alloc(0), Buffer.from('numen-fs|app', 'utf8'), 32));
const hmac = (s) => createHmac('sha256', key).update(s).digest('hex');
function dir() {
  const P = (n) => path.join(tmp, n);
  return {
    async read(n) { try { return await readFile(P(n), 'utf8'); } catch { return null; } },
    async write(n, s) { const f = P(n); await mkdir(path.dirname(f), { recursive: true }); await writeFile(f + '.tmp', s); await rename(f + '.tmp', f); },
    async list(d) { try { return await readdir(P(d)); } catch { return []; } },
    async remove(n) { try { await rm(P(n)); } catch {} },
    async mkdirp(d) { await mkdir(P(d), { recursive: true }); },
    async rmrf(d) { try { await rm(P(d), { recursive: true, force: true }); } catch {} },
  };
}
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

// a VALIDLY-signed announce (matches fs-channel _announce's canon), so _readAnnounces accepts it
function signedAnnounce(session) {
  const ts = Date.now();
  const payload = JSON.stringify({ v: FS_VERSION, session, ts });
  const canon = FS_VERSION + '|' + session + '|-|announce|0|' + ts + '|' + payload.length + '|' + payload;
  return JSON.stringify({ payload, sig: hmac(canon) });
}

try {
  // (a) a co-resident LIVE bridge: a valid fresh announce + its session tree → KEEP
  fs.mkdirSync(path.join(tmp, 'live'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'live', 'livecoresident.json'), signedAnnounce('livecoresident'));
  fs.mkdirSync(path.join(tmp, 'sessions', 'livecoresident', 'ep1', 'to-page'), { recursive: true });
  // (b) a DEAD orphan session: no announce at all → REAP
  fs.mkdirSync(path.join(tmp, 'sessions', 'deadorphansess', 'ep0', 'to-bridge'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'sessions', 'deadorphansess', 'ep0', 'to-bridge', '0.json'), 'litter');
  // (c) our own session dir (pre-create so we can assert it survives)
  fs.mkdirSync(path.join(tmp, 'sessions', 'ourownsession', 'ep', 'to-page'), { recursive: true });

  const b = new FsChannel({ role: 'bridge', dir: dir(), hmac, now: Date.now, randomId: () => 'ourownsession' });
  await b.start();   // announces (adds live/ourownsession.json) → reaps dead sessions

  const sess = fs.readdirSync(path.join(tmp, 'sessions')).sort();
  assert.ok(!sess.includes('deadorphansess'), 'dead orphan session reaped');
  assert.ok(sess.includes('livecoresident'), 'co-resident LIVE bridge session kept (option C)');
  assert.ok(sess.includes('ourownsession'), "the bridge's own session kept");
  console.log('fs-sessions-reap smoke ok:', JSON.stringify({ sessions: sess }));
} catch (e) { console.error(e); cleanup(); process.exit(1); }
cleanup();
process.exit(0);
