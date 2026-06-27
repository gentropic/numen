# SPEC — numen multi-channel (two agents, one page)

> Let a single weir page serve **more than one agent at once** over the fs
> transport — e.g. the **librarian** (weir-desk) and the **dev** agent (the weir
> repo) connected simultaneously. Today the page watches exactly one folder, so two
> bridges on one folder clobber each other. The fix is **one page → N folders, each
> a clean single-occupancy fs channel**, leaving the bridge and the wire protocol
> untouched. As a bonus it makes **folder = identity** literal, which is exactly the
> per-connection identity that SPEC-librarian §2 needs.

| | |
|---|---|
| **Package** | `@gcu/numen` (the page-side shim) + `@gcu/weir` (integration) |
| **Implements** | concurrent fs clients on one page; the identity carrier for SPEC-librarian §2 |
| **Status** | **IMPLEMENTED (numen 0.1.3, 2026-06-21).** Shim multichannel + `smoke-fs-multichannel` shipped; weir integration (dev + librarian channels, folder = identity) live. Design record — authoritative summary in TRANSPORTS.md §6.5. Page-side only; bridge + `fs-channel.js` unchanged, as planned. |
| **Home** | the numen repo (the core change is `numen/shim.js`; weir consumes it via the vendored shim). |
| **Design language** | numen / Switchboard |

---

## 0. Ground yourself first

Read the real surfaces; the code is the contract.

- `numen/shim.js` — the page-side polyfill. The **singletons to generalize**:
  `_folder`, `_transport`, `_clientId` (~lines 36, 229–256, 260–265). `_connectFs`
  builds one `FsChannel` over `_fsaDir(_folder)`, stores it as `_transport`, runs one
  poll interval; `_handleMessage`/`_handleInvoke` dispatch to the shared `_tools`.
  Note `onMessage` is a per-channel closure (line 239) — that's the routing seam.
- `numen/fs-channel.js` — the channel itself. **Do not touch.** One `bridge.live`
  announce, one adopted session per folder, HMAC-authenticated. It's single-occupancy
  *per folder* by design (sessions handle bridge restart; epochs handle page reload —
  not concurrent agents). N folders = N independent instances of this, untouched.
- `numen/numen-bridge.js` — the bridge. `--folder <dir>` is per-instance; two bridges
  coexist *if* they use different folders. **Update (2026-06-27):** this was true for
  single-folder bridges, but **watch mode** (`--watch`, added after this spec — TRANSPORTS
  §6.3) DID gain a **coexistence guard** so a Desktop watch over a parent can run alongside
  the per-folder Code bridges without clobbering them (`smoke-fs-coexist.mjs`). Also note the
  keying edge this spec's §5 foreshadows: the key is `token + APP NAME` (not the channel/folder
  id), so single-folder bridges set it with `--app weir` (folder name free), but **watch keys
  by folder basename** — a watch-served weir channel folder must therefore be **named `weir`**
  (e.g. Cowork at `~/numen-cowork/weir`). See TRANSPORTS §6.3's "Watch × multichannel keying."
- `weir/src/js/fsmount.js` — **keyed** FSA handle persistence: `loadHandle(key)` /
  `saveHandle(handle, key)` / `pickDirectory(id)`. Default store = `'dir'`; the
  webmcp fs handle = `'webmcp-fs'`; the Courier already uses `courier:<id>`. A second
  channel handle is just another key. The pattern exists.
- `weir/src/js/webmcp.js` ~1247–1305 — `initWebmcp` + the control `api`:
  `connectFolder(handle, token)` sets `wm.folder = handle; wm.connect(token)` and
  stores one token in `localStorage[LS_FS]`. This is the singleton to extend.
- `weir/src/js/boot.js` — reconnects the fs path on load (persisted handle + a
  permission re-grant gesture). Must reconnect *all* persisted channels.
- SPEC-librarian.md §2 / §6 — the provenance taxonomy; the `agent` tier needs a
  per-connection **identity** string. This spec is where that identity originates.

If anything here contradicts the code, the code wins — note the divergence.

---

## 1. Why this exists

Dev wants to poke the *live* corpus while building — test a new tool (e.g.
`weir_queryCatalog`) against real data, inspect the real store, debug a poll — at the
same time the librarian (weir-desk) is connected and working. Today that's
impossible: the page binds one folder (`_folder`), so a second bridge pointed at the
same folder fights over the single `bridge.live` announce and the page thrashes
between sessions. The conservative interim rule is "only one bridge at a time" —
fine, but it makes the dev connection a second-class citizen. This makes it
first-class.

### 1.1 Approach: N folders, not multi-session-in-one-folder

Two ways to seat two agents:

- **(A) Page watches N folders** — each its own single-occupancy `FsChannel`. ✅
- (B) One folder, page tracks multiple bridge sessions (per-session announces, a
  session map). ❌ — touches the hardened crypto/control-plane in `fs-channel.js`.

**(A) wins decisively:** the risky code (protocol, HMAC, epoch adoption) and the
bridge stay **byte-for-byte unchanged**; each folder is the proven single-occupancy
channel, run N times. All the change is page-side plumbing. It also matches numen's
existing **folder = identity** security model (each folder its own machine token),
which is the §4 bonus.

---

## 2. The change — `numen/shim.js`

Generalize the singleton fs path into a small **registry of fs channels**, keyed by
an id. WS/HTTP (localhost, single-bridge) stay as the one legacy path — multichannel
is **fs-only** (the shipped transport; no need to multiplex WS).

- **State.** Replace `_folder` / `_transport` (for the fs path) with
  `_fsChannels: Map<id, { channel, token, identity, clientId, timer, polling }>`.
  WS/HTTP keep using `_transport` as today (mutually exclusive with fs, as now).
- **Add channel.** `addFolder({ id, handle, token, identity })` → derive the HMAC
  (`_fsHmac(token, _effectiveName())` unchanged), build a `FsChannel` over
  `_fsaDir(handle)`, **capture the entry in the `onMessage` closure** so dispatch
  knows which channel a frame came from, start it, and run its own poll interval.
  Idempotent on `id` (re-add replaces).
- **Remove channel.** `removeFolder(id)` → stop the timer, `disconnect()` the
  channel, drop the entry.
- **Routing.** `onMessage(msg)` → `_handleMessage(msg, entry)`;
  `_handleInvoke(msg, entry)` replies via `entry.channel.send(...)` (not a global
  `_send`). `welcome` sets `entry.clientId` (per-channel), not a single `_clientId`.
- **Identity carried to dispatch.** When a `tool_invoke` is handled, the executing
  tool must be able to learn **who called** — `entry.identity`. Expose it to the
  tool layer (e.g. a `_currentInvoker` set for the synchronous span of dispatch, or
  pass it through the registered `execute(input, ctx)` contract). This is the hook
  SPEC-librarian's provenance stamping reads; **this spec only delivers the
  identity to the dispatch boundary — it does not stamp** (that's the librarian
  work). Default identity when the client declares none → the weir mount label (§3).
- **Aggregate state.** `state` = connected if *any* fs channel is connected; the
  status callback reports per-channel (weir's flight-deck shows N indicators, §3).

Backward-compatible shim API: keep `connect(token)` + `wm.folder` working as "the
default channel" (id `'default'`) so existing single-folder callers are unchanged;
`addFolder` is the new multi path.

---

## 3. The change — weir integration

- **Persist N handles + tokens.** Reuse `fsmount` keyed handles: the existing
  `'webmcp-fs'` stays the librarian channel; add e.g. `'webmcp-fs:<id>'` per extra
  channel. Tokens move from the single `localStorage[LS_FS]` to a small JSON map
  `{ id → token }` (migrate the existing scalar into `{ default: <token> }`).
- **Mount label = default identity.** Each mounted channel carries a human label
  (`librarian`, `dev`) — the default `agent` identity when the bridge declares none.
  Stored alongside the handle/token. (Per SPEC-librarian §6, the bridge MAY override
  via a declared identity — §5 open.)
- **Control api.** Generalize `connectFolder` to **add** rather than **replace**:
  `addChannel({ handle, token, label })` (keep `connectFolder` as the one-channel
  shim for compat). `disconnectChannel(id)` / `disconnect()` (all).
- **boot.js.** Reconnect *every* persisted channel on load (each needs its own
  permission re-grant gesture — surface them together).
- **Flight-deck.** The status bar shows each channel's state + label (the user
  should never wonder which agents are attached). One row per channel.
- **Settings UI.** "Attach a channel" → `pickDirectory` + paste token + label;
  "detach." Minimal; mirrors the existing single fs-connect flow.

---

## 4. Bonus: this *is* the identity mechanism (SPEC-librarian §2/§6)

SPEC-librarian decided the `agent` provenance identity is **per-connection, declared
by the MCP client, default to a weir setting**. Multichannel realizes it:

- **folder = identity.** Each channel = one folder = one machine token = one agent.
  The librarian's folder → `by: "claude:librarian"`; dev's → `by: "claude:dev"`.
- The **mount label** is the weir-setting default; the **bridge-declared identity**
  (if added, §5) is the override. Either way, `entry.identity` reaches dispatch (§2),
  and the librarian's provenance helper stamps `{ source: 'agent', by: identity }`.
- So the two specs compose: this delivers *who is calling* to the tool boundary;
  SPEC-librarian *records* it. Build this first (or together) — the librarian's `by`
  field has no real source until identity is carried here.

---

## 5. Open questions

- **Where the bridge declares identity.** Add a `numen-bridge.js --identity <label>`
  that rides in the page-bound `hello`/announce, so the *client* names itself (the
  truest reading of "declared by the MCP client")? Or is the weir mount label
  enough? (Lean: mount label is the default; add `--identity` as an optional
  override later — it's the only change that would touch the bridge.)
- **Distinct tokens required?** `fs-channel` derives the key from `token +
  appname`, so two folders with the *same* token + same app derive the same key and
  both work — but folder=identity is the security boundary. Require distinct tokens
  per channel, or allow shared? (Lean: allow, but the bridge prints a fresh token
  per folder by default.)
- **Concurrency on the store.** Two agents' tool calls interleave at `await` points
  (single-threaded page). Most writes are small and the propose→ratify model keeps
  them low-stakes, but a bulk op + `flush` could interleave with another write. Add a
  tiny async mutex around mutating tool dispatch, or accept it? (Lean: accept first;
  add a per-dispatch mutex only if a real race shows up.)
- **Channel cap.** Design for N; cap small (2–3?) so a misconfig can't spawn many
  poll loops. 
- **Permission re-grants on boot.** N folders = N FSA permission gestures on load —
  batch them into one prompt flow so reconnect isn't N separate clicks.

---

## 6. Non-goals

- **No change to `fs-channel.js` or the wire protocol.** If this spec tempts a
  protocol edit, it's the wrong approach (that's rejected option B).
- **No multi-session-per-folder.** One folder stays one bridge.
- **No WS/HTTP multiplexing.** Multichannel is fs-only; localhost transports stay
  single.
- **No WebRTC.** The other roadmap path to remote/multi-client (numen v1.5) is
  separate and unaffected.
- **No provenance *stamping* here.** This carries identity to dispatch; SPEC-librarian
  records it.

---

## 7. Done means

- `numen/shim.js` serves ≥2 fs channels concurrently over ≥2 folders, each its own
  `FsChannel` + poll loop, sharing one tool registry; replies route to the calling
  channel; per-channel `clientId`/state.
- The bridge and `fs-channel.js` are unchanged; two `numen-bridge --folder …`
  instances on *different* folders both reach the same weir page at the same time.
- weir persists N handles + tokens + labels (keyed `fsmount`), reconnects all on
  boot, and shows per-channel state in the flight-deck.
- `entry.identity` is available at tool dispatch (the hook SPEC-librarian reads).
- A smoke test stands up two page channels against two folders and confirms both get
  independent tool calls + correct reply routing.
- End-to-end: librarian (weir-desk) and dev (weir) connected to one running weir
  simultaneously, each calling tools, neither disrupting the other.
