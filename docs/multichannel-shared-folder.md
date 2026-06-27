# SPEC (proposed) — shared-folder multichannel: N bridges, one folder

> **Option C** from the 2026-06-27 design chat. Today the `fs` transport is **one bridge per
> folder** (TRANSPORTS §6.5): N agents ⇒ N folders. This makes it **N bridges per folder** —
> a folder becomes a multi-occupancy channel — **without** changing the identity model
> (identity stays *folder-scoped*, set by the consumer; see §3, the load-bearing decision).
> Status: **PROPOSED, not built.** Supersedes [multichannel.md]'s §1.1 "(B) is rejected" — the
> rejection was right *then* (it implied touching the crypto); the insight below makes it small.

## 0. The insight — the frames are already per-session

The original spec rejected "many bridges, one folder" as touching the hardened crypto. But
re-reading `fs-channel.js`: message frames already live at **`sessions/<session>/<epoch>/…`**,
where `<session>` is the *bridge's* nonce. So two bridges in one folder already write to
**disjoint subtrees** — their frames never collide, their HMAC/epoch logic is untouched. The
**only** single-occupancy point is one file: **`bridge.live`** (one announce, one session; a
second bridge overwriting it makes the page flap). Fix that one file and the folder is
multi-occupancy. No protocol/crypto change to framing, sentinels, epochs, or adoption.

## 1. The change — per-bridge announces

Replace the single root `bridge.live` with a **`live/` directory, one announce per bridge**:

```
  live/<session>.json     {payload:"{v,session,ts}", sig}   — one per live bridge (was bridge.live)
  sessions/<session>/<epoch>/to-page|to-bridge/ …           — UNCHANGED (already per-session)
```

- **Bridge:** writes/refreshes `live/<session>.json` (its own session) instead of `bridge.live`.
  Removes it on clean shutdown; else it ages out (§4). Everything else (serving its session,
  adopting the page's epoch) is unchanged.
- **Page:** `_discover` **scans `live/`** for all `<session>.json`, verifies each (the existing
  `_verify` HMAC path — a bad/forged announce is ignored, as today), and maintains a **set** of
  live bridge sessions. For each *new* verified session it mints an epoch and runs a channel;
  sessions whose announce goes stale are dropped.

## 2. Where the multi-session logic lives — shim orchestrates, channel stays single

Keep `fs-channel.js` **per-session simple**: one `FsChannel` instance still serves exactly one
bridge session. The **shim** (`shim.js`) does the orchestration:

- A *channel* (one folder = one consumer-config entry) owns a **map of sub-channels**, one
  `FsChannel` per discovered bridge session over the same dir adapter.
- The shim scans `live/` on its poll tick; spins up a sub-channel (pinned to session S) when a
  new authentic announce appears; tears one down when its announce goes stale or its session
  errors.
- `fs-channel.js` gains a small **"page, pinned to session S"** mode: skip self-discovery (the
  shim already did it), use the given session, mint the epoch, drain/send as today. The announce
  *read* (scan `live/`) moves to the shim; the announce *write* (bridge) moves to `live/<s>.json`.

This confines the new surface area to the shim + a tiny pinned-mode hook — the hardened
adoption/HMAC/sentinel code is reused verbatim, one instance per bridge.

## 3. Identity stays folder-scoped — the load-bearing decision

**A folder still maps to one identity, set by the consumer** (weir's channel config:
`~/numen/weir-dev` → `claude:dev`). All bridges sharing a folder inherit **that** folder's
identity. We do **NOT** move to bridge-declared identity in this spec — that would let any
token-holder pick its own label, shifting a user-controlled mapping to a bridge-controlled one.
So:

- The bureau is unchanged: librarian / dev / cowork stay distinct folders, distinct identities,
  exactly as today. C is invisible to them.
- The win is the **generic** case: several bridges of the *same* identity on one folder — two
  Claude Desktop sessions both `claude:cowork`, a flaky bridge that restarts, a watch bridge
  co-resident with a hand-run one — all connect, none yields, no empty `listClients`, no flap.
- Per-folder N bridges ⇒ N `clientId`s in weir's client map, **all stamped the folder's
  identity**. (Bridge-*declared* identity is a separate, optional axis — `multichannel.md §5`'s
  `--identity` — and explicitly out of scope here.)

## 4. Lifecycle & compatibility

- **Stale reaping.** An announce older than `LIVENESS_MS` ⇒ its sub-channel is dropped; the
  page MAY unlink a clearly-dead `live/<session>.json` (it only ever removes already-authenticated
  entries — same rule as epoch reaping today; never rmrf on unverified input, §4 confused-deputy).
- **Backward compat (lockstep, but graceful).** The page reads **`live/*.json` AND** the legacy
  root **`bridge.live`** — so an *old* single-folder bridge (writes `bridge.live`) still connects
  to a *new* page. A *new* bridge writes only `live/<session>.json`; an *old* page (reads only
  `bridge.live`) won't see it — acceptable, since weir vendors the shim and updates in lockstep
  with numen. No dual-write (that would re-introduce the clobber).
- **The §6.3 coexistence guard becomes mostly moot** for shared folders: bridges no longer fight
  over one `bridge.live`, so they don't need to yield. The guard stays for the *watch-keys-by-
  basename* topology, but "two bridges, one folder" is now first-class, not a hazard.

## 5. Build plan

1. `fs-channel.js`: announce write → `live/<session>.json`; add a page **pinned-session** ctor
   option; expose a static `listAnnounces(dir)` (scan + verify) for the shim. Keep `bridge.live`
   read as a legacy fallback.
2. `shim.js`: per-channel sub-channel map; scan `live/` each tick; add/drop sub-channels;
   per-sub-channel `clientId`, all carrying the channel's identity.
3. `numen-bridge.js`: single-folder + watch both write `live/<session>.json` (one announce each).
4. Smokes: `smoke-fs-shared-folder.mjs` — TWO bridges on ONE folder, page sees BOTH clients,
   tool calls route to each, one bridge dies → its sub-channel drops, the other survives. Keep
   `smoke-fs-multichannel` (N folders) + `smoke-fs-coexist` green.
5. TRANSPORTS §6.5 + this doc graduate; bump the shim/`.mcpb` minor.

## 6. Non-goals

- **No bridge-declared identity** (that's the separate `--identity` axis; folder-scoped here).
- **No framing/sentinel/epoch/HMAC change** — frames are already per-session; we touch only the
  announce file + the shim's orchestration.
- **No WS/HTTP multiplexing, no WebRTC** — `fs` only, as today.
