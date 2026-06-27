// smoke-fs-coexist.mjs — watch-mode coexistence guard. A watch bridge (`--watch <dir>`)
// must NOT clobber a subfolder a live FOREIGN bridge already owns (e.g. a per-folder
// Claude Code seat on ~/numen/weir while a Desktop bridge watches ~/numen). It serves
// the unclaimed folder, YIELDS the claimed one, and RECLAIMS it once the foreign
// announce goes stale. Decisions are read off the bridge's stderr (no page needed).
// Run: node tools/smoke-fs-coexist.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.join(here, '..', 'numen-bridge.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gcu-coexist-home-'));
const watch = fs.mkdtempSync(path.join(os.tmpdir(), 'gcu-coexist-'));
fs.mkdirSync(path.join(watch, 'alpha'), { recursive: true });   // unclaimed
fs.mkdirSync(path.join(watch, 'beta'), { recursive: true });    // pre-claimed by a foreign bridge

// A foreign announce in beta — only the ts matters to the guard (it doesn't verify the sig).
const announce = (ts) => JSON.stringify({ payload: JSON.stringify({ v: 1, session: 'foreign-seat', ts }), sig: 'na' });
fs.writeFileSync(path.join(watch, 'beta', 'bridge.live'), announce(Date.now()));   // FRESH ⇒ owned

const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };
const proc = spawn('node', [bridgePath, '--transport', 'fs', '--watch', watch], { env, stdio: ['pipe', 'pipe', 'pipe'] });
let err = '';
proc.stderr.setEncoding('utf8');
proc.stderr.on('data', (d) => { err += d; });
const cleanup = () => { try { proc.kill(); } catch {} for (const d of [tmpHome, watch]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } };
const fail = (e) => { console.error(e); console.error('--- bridge stderr ---\n' + err); cleanup(); process.exit(1); };
proc.on('error', fail);

try {
  await sleep(1500);   // first scan
  assert.ok(/fs surface "alpha"/.test(err), 'serves the unclaimed folder (alpha)');
  assert.ok(/yielding "beta"/.test(err), 'yields the foreign-owned folder (beta)');
  assert.ok(!/fs surface "beta"/.test(err), 'does NOT serve beta while a fresh foreign bridge owns it');

  // The foreign bridge dies → its announce ages out → watch reclaims beta on a later scan.
  fs.writeFileSync(path.join(watch, 'beta', 'bridge.live'), announce(Date.now() - 120000));   // STALE
  await sleep(6000);   // > the 5s rescan
  assert.ok(/fs surface "beta"/.test(err), 'reclaims beta once the foreign announce is stale');

  console.log('fs-coexist smoke ok: served alpha, yielded then reclaimed beta');
} catch (e) { fail(e); }
cleanup();
process.exit(0);
