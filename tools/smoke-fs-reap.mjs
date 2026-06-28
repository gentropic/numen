// smoke-fs-reap.mjs — the bridge sweeps clearly-dead peer announces (live/<session>.json) when it
// announces, so a restart-storm doesn't pile up litter (each dead/wrong-token bridge left an
// announce the page re-rejects forever). A FRESH co-resident announce (option C / --share) is left
// untouched. Run: node tools/smoke-fs-reap.mjs
import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { readFile, writeFile, rename, readdir, rm, mkdir } from 'node:fs/promises';
import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { FsChannel } from '../fs-channel.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gcu-reap-'));
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
const announce = (session, ts) => JSON.stringify({ payload: JSON.stringify({ v: 1, session, ts }), sig: 'na' });

try {
  fs.mkdirSync(path.join(tmp, 'live'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'live', 'deadbeefdeadbeef.json'), announce('deadbeefdeadbeef', Date.now() - 200000));  // STALE (>2×LIVENESS) — wrong-token litter
  fs.writeFileSync(path.join(tmp, 'live', 'cafef00dcafef00d.json'), announce('cafef00dcafef00d', Date.now()));          // FRESH co-resident bridge

  const b = new FsChannel({ role: 'bridge', dir: dir(), hmac, now: Date.now, randomId: () => randomBytes(8).toString('hex') });
  await b.start();   // announces → reaps the stale, keeps the fresh, writes its own

  const live = fs.readdirSync(path.join(tmp, 'live'));
  assert.ok(!live.includes('deadbeefdeadbeef.json'), 'STALE litter reaped');
  assert.ok(live.includes('cafef00dcafef00d.json'), 'FRESH co-resident announce left untouched (option C)');
  assert.ok(live.includes(b.session + '.json'), "the bridge's own announce written");
  console.log('fs-reap smoke ok:', JSON.stringify({ live: live.map((f) => f.slice(0, 8)) }));
} catch (e) { console.error(e); cleanup(); process.exit(1); }
cleanup();
process.exit(0);
