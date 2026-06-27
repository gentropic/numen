// smoke-fs-shared-folder.mjs — N bridges, ONE folder (shared-folder multichannel, option C;
// docs/multichannel-shared-folder.md). Two bridge channels announce into one folder
// (live/<session>.json); a page lists BOTH via listAnnounces() and runs one PINNED page
// channel per bridge; each routes independently to its own bridge. Pure FsChannel, no spawned
// process. Run: node tools/smoke-fs-shared-folder.mjs
import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { readFile, writeFile, rename, readdir, rm, mkdir } from 'node:fs/promises';
import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { FsChannel } from '../fs-channel.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gcu-shared-'));
const key = Buffer.from(hkdfSync('sha256', Buffer.from('tok', 'utf8'), Buffer.alloc(0), Buffer.from('numen-fs|app', 'utf8'), 32));
const hmac = (s) => createHmac('sha256', key).update(s).digest('hex');
const rand = () => randomBytes(8).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
// a bridge that echoes ping → pong tagged with its label
function makeBridge(label) {
  const ch = new FsChannel({ role: 'bridge', dir: dir(), hmac, now: Date.now, randomId: rand,
    onMessage: (m) => { if (m.type === 'ping') ch.send({ type: 'pong', from: label, n: m.n }); } });
  return ch;
}
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

try {
  const b1 = makeBridge('b1'), b2 = makeBridge('b2');
  await b1.start(); await b2.start();   // both announce into the SAME folder's live/
  assert.ok(b1.session && b2.session && b1.session !== b2.session, 'two distinct bridge sessions, one folder');

  // the page sees BOTH live bridges in the one folder
  const scanner = new FsChannel({ role: 'page', dir: dir(), hmac, now: Date.now, randomId: rand });
  const announces = await scanner.listAnnounces();
  assert.equal(announces.length, 2, 'listAnnounces() returns BOTH bridges from one folder');

  // one page channel PINNED to each bridge
  const got = {};
  const pages = announces.map((a) => {
    got[a.session] = [];
    const p = new FsChannel({ role: 'page', dir: dir(), hmac, now: Date.now, randomId: rand, session: a.session,
      onMessage: (m) => { if (m.type === 'pong') got[a.session].push(m); } });
    p.send({ type: 'ping', n: 1 });
    return p;
  });

  for (let i = 0; i < 80; i++) {
    await b1.tick(); await b2.tick();
    for (const p of pages) await p.tick();
    if (Object.values(got).every((g) => g.length)) break;
    await sleep(20);
  }

  const sessOf = { [b1.session]: 'b1', [b2.session]: 'b2' };
  for (const s of Object.keys(got)) {
    assert.equal(got[s].length, 1, `page pinned to ${sessOf[s]} got exactly one pong`);
    assert.equal(got[s][0].from, sessOf[s], `routed to the RIGHT bridge (${sessOf[s]}), not the other`);
  }
  console.log('fs-shared-folder smoke ok:', JSON.stringify({ bridges: [b1.session.slice(0, 6), b2.session.slice(0, 6)], routed: Object.keys(got).map((s) => sessOf[s]) }));
} catch (e) { console.error(e); cleanup(); process.exit(1); }
cleanup();
process.exit(0);
