// fs-channel.js — @gcu/webmcp `fs` transport core. See TRANSPORTS.md §3.
//
// Dependency-free protocol shared by the bridge (node fs) and the shim (browser
// FSA). PURE over injected adapters, so it runs anywhere and tests without a real
// filesystem, crypto, or browser:
//
//   dir       async { read(name)->str|null, write(name,str), list(dir)->[name],
//                     remove(name), mkdirp(dir), rmrf(dir) }   — names are '/'-paths
//   hmac      async (str) -> hex          — key bound by the caller (HKDF of the
//                                            machine token); key material NEVER here
//   now       () -> epoch ms
//   randomId  () -> hex string            — session (bridge) / epoch (page) nonces
//   onMessage (wireMsg) -> void           — deliver a verified inbound message
//   onState   ('connecting'|'open'|'closed') -> void
//
// Roles: the BRIDGE announces (writes `bridge.live`); the PAGE dials. Layout:
//
//   bridge.live                                     signed announce (session + ts)
//   sessions/<session>/<epoch>/to-page/   ‹seq›.json ‹seq›.ready   bridge → page
//   sessions/<session>/<epoch>/to-bridge/ ‹seq›.json ‹seq›.ready   page → bridge
//
// `<session>` is minted by the bridge per start (a restart = a new session). The
// `<epoch>` is minted by the PAGE per connect, so a browser reload reconnects on a
// fresh epoch instead of colliding seq counters with the live session. The bridge
// serves the freshest epoch and sweeps the rest (free cleanup).
//
// A frame is `‹seq›.json` (payload) + `‹seq›.ready` (signed sentinel). The sentinel
// proves the payload COMPLETE and AUTHENTIC in one check (§3.3): partial sync,
// reordered delivery, tamper, and replay all fail closed. Delivery is in-order,
// exactly-once. The channel carries the existing wire message set verbatim and
// knows nothing about tools.
//
// Liveness is PASSIVE (no per-tick heartbeat — writes over a sync folder are
// expensive). A frame's `ts` is its own liveness proof; when idle, nobody writes.
// The one periodic write is the bridge refreshing `bridge.live` slowly, so an idle
// page can tell a live bridge from a stale one. The page is write-silent when idle.
//
// The host drives time: call tick() on an interval (bridge/shim) or in a loop
// (smoke). The host MUST NOT overlap ticks (await one before the next).

(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GcuFsChannel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var FS_VERSION = 1;
  var SKEW_MS = 5 * 60 * 1000;        // frame freshness / replay window
  var ANNOUNCE_INTERVAL_MS = 30000;   // bridge.live refresh cadence (the ONLY periodic write)
  var LIVENESS_MS = 90000;            // page treats the bridge as down if bridge.live is older

  function outboxOf(role) { return role === 'bridge' ? 'to-page' : 'to-bridge'; }
  function inboxOf(role) { return role === 'bridge' ? 'to-bridge' : 'to-page'; }

  // The signed string binds the envelope to the payload — editing any field, or
  // moving a sentinel onto a different payload, breaks the HMAC.
  function canon(session, epoch, dir, seq, ts, len, payload) {
    return FS_VERSION + '|' + session + '|' + epoch + '|' + dir + '|' + seq + '|' + ts + '|' + len + '|' + payload;
  }

  function FsChannel(opts) {
    this.role = opts.role;             // 'bridge' | 'page'
    this._dir = opts.dir;
    this._hmac = opts.hmac;
    this._now = opts.now || function () { return Date.now(); };
    this._rand = opts.randomId || function () { return 'x'; };
    this._onMessage = opts.onMessage || function () {};
    this._onState = opts.onState || function () {};
    this._log = opts.log || function () {};
    this.session = null;
    this.epoch = null;
    this.state = 'connecting';
    this._outSeq = 0;
    this._lastIn = -1;                 // highest inbound seq delivered (replay/order guard)
    this._outQueue = [];
    this._lastAnnounce = 0;
  }

  FsChannel.prototype._setState = function (s) {
    if (this.state === s) return;
    this.state = s;
    try { this._onState(s); } catch (e) { /* host callback */ }
  };

  FsChannel.prototype._epochDir = function (sub) { return 'sessions/' + this.session + '/' + this.epoch + '/' + sub; };

  // Reset the per-connection counters (on a new session or a new adopted epoch).
  FsChannel.prototype._resetConn = function () { this._outSeq = 0; this._lastIn = -1; };

  // ── start ──

  FsChannel.prototype.start = async function () {
    if (this.role === 'bridge') {
      this.session = this._rand();
      await this._announce();          // page can't dial until bridge.live exists
    }
    // page discovers (and mints its epoch) on the first tick()
  };

  // ── bridge: announce (the one periodic write) ──

  FsChannel.prototype._announce = async function () {
    var ts = this._now();
    var payload = JSON.stringify({ v: FS_VERSION, session: this.session, ts: ts });
    var sig = await this._hmac(canon(this.session, '-', 'announce', 0, ts, payload.length, payload));
    await this._dir.write('bridge.live', JSON.stringify({ payload: payload, sig: sig }));  // sign the RAW string
    this._lastAnnounce = ts;
  };

  // bridge: adopt the freshest connection epoch (a page reload = a new epoch) and
  // sweep the others. Resets the per-connection counters when the epoch changes.
  FsChannel.prototype._adoptEpoch = async function () {
    var epochs = await this._dir.list('sessions/' + this.session);
    var best = null, bestTs = -1;
    for (var i = 0; i < epochs.length; i++) {
      var ep = epochs[i];
      var raw = await this._dir.read('sessions/' + this.session + '/' + ep + '/to-bridge/0.ready');  // the hello sentinel
      if (raw == null) continue;
      var s; try { s = JSON.parse(raw); } catch (e) { continue; }
      if (s && typeof s.ts === 'number' && s.ts > bestTs) { bestTs = s.ts; best = ep; }
    }
    if (best && best !== this.epoch) {
      this.epoch = best;
      this._resetConn();
      await this._dir.mkdirp(this._epochDir('to-page'));
    }
    // sweep stale epoch dirs (previous reloads); never the one we serve
    for (var j = 0; j < epochs.length; j++) {
      if (epochs[j] !== this.epoch) await this._dir.rmrf('sessions/' + this.session + '/' + epochs[j]);
    }
  };

  // page: read + verify bridge.live; adopt the session (minting a fresh epoch) when
  // it first appears or changes. Returns false if no live, unverifiable, or stale
  // bridge (→ the bridge is presumed down).
  FsChannel.prototype._discover = async function () {
    var raw = await this._dir.read('bridge.live');
    if (raw == null) return false;
    var ann; try { ann = JSON.parse(raw); } catch (e) { return false; }
    if (!ann || typeof ann.payload !== 'string') return false;
    var b; try { b = JSON.parse(ann.payload); } catch (e) { return false; }
    if (!b || b.v !== FS_VERSION) return false;
    var expect = await this._hmac(canon(b.session, '-', 'announce', 0, b.ts, ann.payload.length, ann.payload));
    if (expect !== ann.sig) { this._log('bad announce sig'); return false; }
    if (this._now() - b.ts > LIVENESS_MS) { this._log('bridge.live stale — bridge presumed down'); return false; }
    if (this.session !== b.session) {            // first sight or a bridge restart → fresh connection
      this.session = b.session;
      this.epoch = this._rand();
      this._resetConn();
      await this._dir.mkdirp(this._epochDir('to-bridge'));
      await this._dir.mkdirp(this._epochDir('to-page'));
    }
    return true;
  };

  // ── send (queued; flushed by tick once a session+epoch exist) ──

  FsChannel.prototype.send = function (msg) { this._outQueue.push(msg); };

  // Write one frame. The seq is committed and the caller dequeues ONLY on success —
  // a transient FS error (lock contention, a momentary AV/sync lock) must not drop
  // the message or burn the seq; it's retried with the same seq next tick. Returns
  // true on success, false to retry. A half-write (payload ok, sentinel failed)
  // leaves a harmless orphan `.json` the retry overwrites; readers key off `.ready`.
  FsChannel.prototype._writeFrame = async function (msg) {
    var dir = outboxOf(this.role);
    var seq = this._outSeq;                                    // tentative
    var ts = this._now();
    var payload = JSON.stringify(msg);
    try {
      var sig = await this._hmac(canon(this.session, this.epoch, dir, seq, ts, payload.length, payload));
      var base = this._epochDir(dir) + '/' + seq;
      await this._dir.write(base + '.json', payload);          // payload first…
      await this._dir.write(base + '.ready', JSON.stringify({  // …then the sentinel
        v: FS_VERSION, session: this.session, epoch: this.epoch, dir: dir, seq: seq, ts: ts, len: payload.length, sig: sig,
      }));
      this._outSeq = seq + 1;                                  // commit only on full success
      return true;
    } catch (e) {
      this._log('write failed seq ' + seq + ': ' + ((e && e.message) || e));
      return false;
    }
  };

  FsChannel.prototype._remove = async function (base) {
    await this._dir.remove(base + '.json');
    await this._dir.remove(base + '.ready');
  };

  // Consume the peer's outbox: verify + deliver in seq order, exactly once.
  FsChannel.prototype._drainInbox = async function () {
    var dir = inboxOf(this.role);
    var dpath = this._epochDir(dir);
    var names = await this._dir.list(dpath);
    var readys = [];
    for (var i = 0; i < names.length; i++) {
      var m = /^(\d+)\.ready$/.exec(names[i]);
      if (m) readys.push(parseInt(m[1], 10));
    }
    readys.sort(function (a, b) { return a - b; });

    for (var j = 0; j < readys.length; j++) {
      var seq = readys[j];
      var base = dpath + '/' + seq;
      if (seq <= this._lastIn) { await this._remove(base); continue; }   // already delivered → sweep
      if (seq !== this._lastIn + 1) break;                               // gap → wait for the missing seq

      var rawR = await this._dir.read(base + '.ready');
      if (rawR == null) continue;
      var sent; try { sent = JSON.parse(rawR); } catch (e) { continue; }     // torn sentinel → retry next tick
      if (!sent || sent.v !== FS_VERSION || sent.session !== this.session || sent.epoch !== this.epoch || sent.seq !== seq || sent.dir !== dir) break;
      if (Math.abs(this._now() - sent.ts) > SKEW_MS) { this._log('stale frame ' + seq); await this._remove(base); break; }

      var payload = await this._dir.read(base + '.json');
      if (payload == null || payload.length !== sent.len) break;         // not fully synced yet → wait
      var expect = await this._hmac(canon(this.session, this.epoch, dir, seq, sent.ts, sent.len, payload));
      if (expect !== sent.sig) { this._log('bad frame sig ' + seq); await this._remove(base); break; }

      var msg; try { msg = JSON.parse(payload); } catch (e) { await this._remove(base); break; }
      this._lastIn = seq;
      if (this.role === 'bridge') this._setState('open');               // a page is talking
      await this._remove(base);
      try { this._onMessage(msg); } catch (e) { this._log('onMessage threw'); }
    }
  };

  // ── tick: one poll cycle (host schedules it; must not overlap) ──

  FsChannel.prototype.tick = async function () {
    if (this.state === 'closed') return;
    if (this.role === 'bridge') {
      if (this._now() - this._lastAnnounce > ANNOUNCE_INTERVAL_MS) await this._announce();  // slow refresh — the only periodic write
      await this._adoptEpoch();
      if (!this.epoch) return;                                           // no page has dialled yet
    } else {
      var ok = await this._discover();
      if (!ok) { this._setState('connecting'); return; }
      this._setState('open');                                            // the bridge is announcing
    }
    if (!this.session || !this.epoch) return;
    while (this._outQueue.length) {
      var wrote = await this._writeFrame(this._outQueue[0]);
      if (!wrote) break;                  // transient write failure → keep it queued, retry next tick
      this._outQueue.shift();
    }
    await this._drainInbox();
  };

  FsChannel.prototype.stop = function () { this._setState('closed'); this._outQueue.length = 0; };

  return { FsChannel: FsChannel, FS_VERSION: FS_VERSION };
}));
