// smoke-fs-share.mjs — --share co-residency (option C, docs/multichannel-shared-folder.md).
// WITHOUT --share, watch mode yields a subfolder another live bridge owns (smoke-fs-coexist).
// WITH --share it CO-SERVES it instead — so N bridges share a folder (two Desktop sessions on one
// surface). Pre-claims `beta` with a fresh foreign announce, runs watch + --share, asserts it
// serves beta anyway. Run: node tools/smoke-fs-share.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.join(here, '..', 'numen-bridge.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gcu-share-home-'));
const watch = fs.mkdtempSync(path.join(os.tmpdir(), 'gcu-share-'));
fs.mkdirSync(path.join(watch, 'beta'), { recursive: true });
// a FRESH foreign announce in beta — without --share the bridge would yield it (smoke-fs-coexist)
const announce = (ts) => JSON.stringify({ payload: JSON.stringify({ v: 1, session: 'foreign-seat', ts }), sig: 'na' });
fs.writeFileSync(path.join(watch, 'beta', 'bridge.live'), announce(Date.now()));

const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };
const proc = spawn('node', [bridgePath, '--transport', 'fs', '--watch', watch, '--share'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
let err = '';
proc.stderr.setEncoding('utf8');
proc.stderr.on('data', (d) => { err += d; });
const cleanup = () => { try { proc.kill(); } catch {} for (const d of [tmpHome, watch]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } };
const fail = (e) => { console.error(e); console.error('--- bridge stderr ---\n' + err); cleanup(); process.exit(1); };
proc.on('error', fail);

try {
  await sleep(1500);
  assert.ok(/--share: CO-SERVING/.test(err), 'announces co-serving mode on start');
  assert.ok(/fs surface "beta"/.test(err), 'CO-SERVES the foreign-owned folder under --share');
  assert.ok(!/yielding "beta"/.test(err), 'did NOT yield beta (the guard is off under --share)');
  console.log('fs-share smoke ok: co-served a foreign-owned folder under --share');
} catch (e) { fail(e); }
cleanup();
process.exit(0);
