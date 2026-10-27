# NFD Ghost SDK v2: forward and reverse lookups for v1, v2 and v3, at any round

Status: design draft, revision 2, 2026-10-26. The core reverse lookup is prototyped and tested on the local node (section 6.1).

- Target node: dtalgod with `POST /v2/query`. Every query endpoint reads foreign boxes (go-algorand-query `676100b5f`, deployed on the local MainNet query node `http://127.0.0.1:8081`, which needs no token). Nothing is deployed beyond that node.
- Consumer: reti-ui's time-travel branch (`/home/bit/code/reti/.claude/worktrees/query`, branch `dt-query`).

Revision 2 assumes queries can read any app's boxes with AVM v13's `app_box_get`, `app_box_len` and `app_box_extract`. That removes every way a read could fail. The design is now one pass, one request per lookup, query only. Section 8 lists what changed from revision 1.

## 1. Goal

Today reti-ui's time-travel mode shows "Read only. NFDs are current." It reads the validator config, gating and pools as of round R, but resolves NFDs through the NFD REST API, which only knows the present. v2 of this SDK should answer, at any round since the registry was created (21,341,747, May 2022):

- forward: name → NFD, appId → NFD record
- reverse: address → NFDs that have it as a verified address
- ownership: which NFDs, and which segments of a parent NFD, an address owns or is linked to (for reti's segment gating)

It must handle every NFD contract generation (v1.x, v2.x, v3.x) and every registry generation, and fit the reti-ghost-sdk dt pattern: the same `AlgorandClient`, `atRound(round)`, abort signals, and series over many rounds.

Scope is what reti-ui reads, nothing more (section 3).

## 2. What the chain looks like across time (verified on the local MainNet node)

### 2.1 Registry 760937186 has three generations

From `GET /v2/applications/760937186/versions?include=values` (11 program versions):

| Rounds | Dates | Program | Forward (name → app) | Reverse (address → apps) |
|---|---|---|---|---|
| 21,341,747 – 32,241,659 | May 2022 – Sep 2023 | 1.2 KB, TEAL v6 | v1 name lsig only | v1 address lsig only |
| 32,241,660 – 42,181,253 | Sep 2023 – Sep 2024 | 2.7 KB | `name/` box | `addr/algo/` box |
| 42,181,254 – now | Sep 2024 – now (8 updates, the latest 66,073,065 this month) | 6.5–7 KB | same | same, plus `"O"` owner boxes (2.3) |

**Registry boxes.** Both are keyed by a sha256:

- forward: `sha256("name/" + name)` → 16 bytes: `asaId ‖ appId`
- reverse: `sha256("addr/algo/" + pubkey32)` → packed uint64 app ids, with zeros for removed slots

The reader reads these boxes directly. Before 32,241,660 they don't exist, so the read returns "absent". The registry's `get_*` methods, which the first generation lacks, are never called.

**v1 data lives in logic-sig accounts opted into the registry,** and it is still there today. Both directions use one template (`getLookupLSIG` in TxnLab's Go code): the registry id goes at bytes 6–13, then a uvarint-length suffix.

- forward: suffix `name/<name>`, local key `i.appid` (8 bytes), plus `i.asaid`
- reverse: suffix `address/<58-char base32 address>` (**the string, not the 32 bytes**), local keys `i.apps0` … `i.apps15`, each up to 15 packed uint64 app ids, with `0` for removed slots

**The registry boxes don't include all v1 reverse data.** `818.algo` (864,806,088, still v1.12): its owner `43H6L4VK…` has no `addr/algo/` box, but its address lsig `BE3YV7YS…` holds `i.apps0 = [864806088, 0]`. Later registries have `migrate_name` / `migrate_address`, but migration is lazy. Registry boxes also come and go: `22T47MKF…` had a reverse box at 33M, none at 43M, and one again today.

### 2.2 An NFD app changes generation in place

App ids are stable; `i.ver` changes. Example: `king.dragonfi.algo` (1,013,764,620):

- v1.16 from round 26,324,847
- v2.11 from round 32,243,146
- its `v.caAlgo.0.as` moved from global state to a box in that same round
- the box was deleted at 37,821,215 and recreated at 45,666,020

So the reader branches on `i.ver` **as of the round being read**.

| Gen | Core fields | Verified addresses `v.caAlgo.N.as` | User props (`u.avatar`, `u.bio`) | Expiry |
|---|---|---|---|---|
| v1 | global `i.*` | global state, several keys of up to 3 addresses each | global `u.*`; long values split as `u.bio_00`, `u.bio_01`, … | none |
| v2 | global `i.*` | one box per key, named by the key (seen: `v.caAlgo.0.as`, `u.avatar`) | box per key | none |
| v3 | global `i.*` | one box per key (seen: `v.caAlgo.0.as`, `v.avatar`, `v.avatarasaid`, `u.caalgo`, `u.dns`) | box per key | `i.expirationTime` |

With foreign box reads, v2 and v3 are read the same way, with `app_box_get(app, key)`. There's no `read_property` (which rejects on a missing box) and no `readField`.

Rules from TxnLab's own on-chain reader (2.5):

- `caAlgo` is every `v.caAlgo.N.as` key, in key order, concatenated, with zero addresses dropped. Réti's contract only reads `.0.as`.
- User values whose names end in `_NN` are merged in key order (`bio_00` + `bio_01` → `bio`).
- Only `i.timeCreated`, `i.timeChanged`, `i.expirationTime`, `i.sellamt`, `i.asaid` (and `i.parentAppID`, which Réti `btoi`s) are 8-byte big-endian ints. `u.*` and `v.*` values are never decoded as ints.
- **State:**
  - expired: `i.expirationTime` ≠ 0 and in the past
  - for sale: `i.sellamt` ≠ 0
  - not owned: `i.owner.a` is the NFD's own app address
  - expired and for-sale NFDs have their properties ignored

### 2.3 Ownership: ASAs and owner boxes

In every generation, an NFD's ASA has unit name `NFD`, asset name equal to the NFD name, and **creator equal to the NFD app's address**. But holding the ASA isn't ownership; `i.owner.a` is.

- v3 owners often don't hold their ASA; it stays in the app (`topblaster.algo`, `bakare.algo`).
- An old holder can keep it after a sale: `43H6L4VK…` holds `building.algo`'s ASA, but its `i.owner.a` is `5DGTK…`.

**Owner index (v3 only).** Later registries keep an unhashed box per (owner, NFD): `"O" ‖ owner(32) ‖ appId(8)`.

- The dt node prefix-lists them at a round: `GET /v2/applications/760937186/boxes?prefix=b64:<"O"‖owner>&round=R`.
- `43H6L4VK…` has 94 today and 87 at 50M. None show up at 43M for the addresses tried, and v1 `818.algo` never does.
- The index can be stale: it still lists `building.algo` for `43H6L4VK…`.
- The AVM can't prefix-search boxes, so enumerating them stays a REST step.

### 2.4 What `/v2/query` gives us

From `ledger/simulation/query.go`, `ledger/eval/eval_query.go`, commit `676100b5f`, and `GET /v2/transactions/simulate/limits` on :8081:

- Each call is its own app create (the reader's program, with `onCreate: allow`), alone in its group, run on the state round R left. The same calls run at up to **64 rounds** per request, with up to **1,024 calls** and a budget of **320,000 per call**.
- **No fees.** Inner calls draw on unlimited fee credit, though this design makes none. **Unnamed resources are allowed.**
- **Foreign box reads (`676100b5f`):** `app_box_get`, `app_box_len` and `app_box_extract` read any app's boxes, as if every app had set `ForeignBoxReads`. Writes are still refused. This is a query-only setting: block evaluation and simulate keep it off.
  - A missing box: `exists = 0` and an empty value.
  - **An app that doesn't exist at R is an error**, not a missing box. Guard every `app_box_*` with `app_params_get AppCreator` (which returns an exists flag). Tested on :8081: the guard works for a deleted app and for an app not yet created at the round.
- **The program is TEAL v13.** Queries run under the latest protocol by default (`v42`, AVM 13) at every round, so v13 opcodes work at 2022 rounds too.
- Each call fails on its own and keeps its logs. Nothing in this design is expected to fail; that isolation now only limits the damage of a bug.

### 2.5 TxnLab's Go on-chain reader (prior art)

The same code lives in reti `nodemgr/internal/lib/nfdonchain`, `TxnLab/nfd-coredns` and `TxnLab/nfd-did` (`internal/nfd/fetch.go`). `TxnLab/nfd-cli-examples` (`nfd-display`) adds `-owns`. All of it is REST at the latest round.

| Topic | What it does | What this design does |
|---|---|---|
| lsig template and suffixes | same template; `name/<name>`, `address/<base32>` | same |
| forward | registry box, else v1 name lsig | same, then checks `i.name` |
| reverse | registry box, **else** v1 lsig (nodemgr, nfd-display); box only (nfd-did); no validation | union of both, validated against `caAlgo` at R |
| properties | lists all of an app's boxes, then reads each (REST); merges `_NN`; sorts `caAlgo` chunks | reads the named boxes directly in the query; same merge rules |
| state | `IsNfdExpired`, `IsNfdOwned` | same rules, at R |
| owned | prefix-scan of `"O"` boxes (v3 only) | `"O"` boxes ∪ ASA holdings ∪ reverse, validated against `i.owner.a` at R |

Is "box else lsig" good enough? At the latest round, 38 of the 1,639 test addresses have 42 v1-lsig app ids missing from their registry box. None lists the address as verified (30 list it only as owner; 12 are stale), so the Go rule loses nothing at the latest round. The union costs nothing extra and also holds during migration windows.

## 3. What reti-ui needs (from the dt-query worktree)

All of it is REST today (`ui/src/api/nfd.ts`, keys without a round, labelled "NFDs are current").

| Use | Lookup | Fields |
|---|---|---|
| validator NFD (`config.nfdForInfo`): table, detail header, staking table, page title | appId → record | `name`, `appID`, avatar (`u.avatar` ‖ `v.avatar`), `u.bio`; `state`/`category` only to pick a placeholder avatar |
| pool's linked NFD (StakingPoolInfo) | reverse, pool app address | `name`, avatar; null means "not linked" |
| staker labels in the stakers chart | reverse, each staker address | `name` |
| creator-NFD gating (`fetchValueToVerify`) | appId → record | `caAlgo` |
| segment gating (`fetchValueToVerify`) | segments of parent P owned by or linked to the staker | `appID` |
| write forms (NfdLookup, EditNfdForInfo, AddValidatorForm, EditEntryGating) | name → record | `appID`, `owner`, `caAlgo.length` (latest round only, since writes are hidden while pinned) |

Contract parity matters for gating. Réti's `doesStakerMeetGating` accepts a segment when `i.parentAppID == root` and either `i.owner.a == staker` **or** the staker is in `v.caAlgo.0.as`. The UI's REST search (`owner = staker`) misses the second case. The contracts only check `v.caAlgo.0.as`.

Not needed: `unverifiedCaAlgo`, `depositAccount`, banner, sale details, free-text search.

## 4. Design

### 4.1 Principle: one pass, plain reads

Everything the reader needs is now a plain read that can't fail once guarded:

| Data | Opcode | Guard |
|---|---|---|
| NFD and registry global state | `app_global_get_ex` | none (a missing app → `exists = 0`) |
| v1 lsig local state | `app_local_get_ex` | `app_opted_in(lsig, registry)`, which fails otherwise |
| registry boxes, NFD property boxes | `app_box_get`; `app_box_len` + `app_box_extract` for boxes over 4,096 bytes | `app_params_get AppCreator` (a missing app fails) |

So **one call reads the candidates, validates them and logs only the final answer.** There are no stage markers, no per-field cells and no second phase. Every lookup is one request (or several in parallel past 1,024 calls / 64 rounds).

### 4.2 Reader methods

The reader is `NfdQueryReader`: a ghost only, puya-ts with `@algorandfoundation/algorand-typescript` ≥ 1.3.1 (`op.AppBox.get/length/extract`), compiled for AVM 13. All methods are `readonly`, `onCreate: "allow"`, one item per call. Each result is logged as an ABI-encoded `NfdRecord` (one log per NFD); the return value is empty.

| Method | Reads | Logs |
|---|---|---|
| `getRecord(app, fields)` | `record(app, fields)` (below) | one record, or none if the app doesn't exist |
| `resolveName(registry, name, nameLsig, fields)` | registry `name/` box (`appId` = bytes 8–16); if absent, `i.appid` of `nameLsig` if opted in | the record, if it exists and its `i.name == name` |
| `reverseLookup(registry, address, addressLsig, fields)` | candidates: registry `addr/algo/` box ∪ `addressLsig`'s `i.apps0..15` (if opted in), zeros dropped, de-duplicated, registry order first; for each: exists, not expired, `address ∈ caAlgo` (every chunk) | each validated record, primary first |
| `ownedBy(address, candidates[], fields)` | for each candidate (from REST, 4.3): `i.owner.a == address` and not the app's own address | each validated record |
| `segmentsFor(registry, address, addressLsig, parent, ownedCandidates[], fields)` | the `reverseLookup` candidates ∪ `ownedCandidates`; keep those with `parentAppId == parent` that are linked (`address ∈ caAlgo.0.as`, Réti parity) or owned (`i.owner.a == address`) | each validated record |

`record(app, fields)` is shared by all of them:

- **Core**, always read: `i.name`, `i.ver`, `i.owner.a`, `i.asaid`, `i.parentAppID`, `i.category`, `i.sellamt`, `i.expirationTime`, and from those `state` and `expired`. "Now" is `Global.latestTimestamp`, which in a query is round R's block timestamp.
- **Fields**, a bitmask, by version:
  - `caAlgo` (+ `caAlgo0`): v1 `app_global_get_ex` of `v.caAlgo.0.as`, `.1.as`, … until missing; v2/v3 `app_box_*` of the same names
  - `avatar`: `u.avatar`, else `v.avatar`
  - `bio`: `u.bio`, else `u.bio_00`, `u.bio_01`, … merged
- **Caps** keep a call's logs under the node's 64 KB per call: `caAlgo` returns at most `maxCaAlgo` addresses (default 64) plus the total count, and `bio` at most 1 KB. Validation inside the reader always scans every chunk; only the output is capped.

**The lsig addresses come from the SDK** (`nameLsig`, `addressLsig`). They're a pure function of the registry id and the name or address, cheap in TS, and the reverse one needs base32, which is awkward in TEAL. A wrong argument can only give the caller a wrong answer to their own query. The SDK computes them with the template in 2.1, with the registry id as a parameter, so testnet and betanet work too.

### 4.3 SDK flows

| Lookup | Requests | Notes |
|---|---|---|
| `getRecords(appIds)` | 1 query | one call per app |
| `resolveNames(names)` | 1 query | one call per name |
| `reverseLookup(addresses)` | 1 query | one call per address, validation included. Measured: 1,639 addresses, latest round, 37–74 ms (6.1) |
| `getOwned(address)` | 2 REST reads in parallel, then 1 query | candidates: `"O"‖A` owner boxes (prefix list at R) and NFD ASAs held at R. ASAs are mapped to apps by the reader: asset name → `resolveName` → `appAddress == ASA creator` (names over 32 bytes: see section 10). One `ownedBy` call |
| `getSegmentsFor(address, parent)` | the same REST reads, then 1 query | one `segmentsFor` call. Reti uses the first `appId` as `valueToVerify` |

Known gap in `getOwned`: a v3 NFD owned at a round before owner boxes existed, whose ASA sits in the app. Measure how common this is before worrying about it (section 9).

### 4.4 Rounds and series

- Every read takes `{ round, signal }`, and `sdk.atRound(round)` pins a round, as in reti-ghost-sdk. A round before the registry was created → `NfdNotDeployedError`. A round past the tip → `FutureRoundError`. Both are thrown without a request.
- Series (`getRecordsSeries`, `reverseLookupSeries`, `resolveNamesSeries`) send the same calls at up to 64 rounds per request. **Each round validates its own candidates in the call**, so points are exact per round and the response holds only answers.
- Owned and segment series need the REST candidates for each round, so they cost one REST pair per round. Use the union of candidates across rounds for the query: candidates that don't validate at a round simply log nothing.
- Points are `{ round, ok, value | error }`, as in reti-ghost-sdk.
- Cache by `(round, kind, key, fields)`. Past rounds never change, so cache them forever. The latest round gets a short TTL.

### 4.5 Micro-batching

reti-ui asks one item at a time: a hook per validator NFD, and a `useQueries` entry per staker. The SDK coalesces calls made in the same tick (or within `batchWindowMs`, default ~10 ms) for the same round into one request: DataLoader-style, keyed by round. Calls of different kinds can share a request, since each is one call of the same program. The stakers chart becomes one request.

### 4.6 Transport: query only

- **Calls:** call `algorand.query.run` from `@d13co/dt-algokit-utils` 9.2.3-dt.2.0.1.0 directly. It splits by `maxCalls`/`maxRounds`, runs requests concurrently, takes an abort signal and reports per-call errors.
- **No ghostkit:** there's no simulate backend to generate. Encode args with `algosdk.ABIMethod` from the reader's `arc56.json`, and decode logs with `ABIType`.
- **Retry 503s** (the node's admission limiter) with backoff, and cap concurrency at the node's parallelism.
- **Feature detection:** time travel and queries are detected from `GET /v2/transactions/simulate/limits` (`time-travel`, `query`), as reti-ghost-sdk does. Every query endpoint reads foreign boxes, so "has `query`" is the whole check, with no probe or extra flag.
- **Without queries** (stock algod), `sdk.supported()` is false and every read throws `NfdQueryUnavailableError`. reti-ui then keeps today's REST path, latest only. This SDK no longer has a simulate fallback: it existed only to work around failures that can no longer happen, and REST already covers the latest round.

### 4.7 Public API

```ts
new NfdGhostSDK({ algorand, registryAppId, round?, batchWindowMs?, maxCaAlgo?, debug? })

sdk.atRound(round): NfdGhostSDK
sdk.prefetch(): Promise<void>
sdk.supported(): Promise<boolean>

sdk.getRecords(appIds, opts?): Promise<Map<bigint, NfdRecord | null>>
sdk.resolveNames(names, opts?): Promise<Map<string, NfdRecord | null>>
sdk.reverseLookup(addresses, opts?): Promise<Map<string, NfdRecord[]>>      // primary first
sdk.getOwned(address, opts?): Promise<NfdRecord[]>
sdk.getSegmentsFor(address, parentAppId, opts?): Promise<NfdRecord[]>

sdk.getRecordsSeries(appIds, rounds, opts?)
sdk.resolveNamesSeries(names, rounds, opts?)
sdk.reverseLookupSeries(addresses, rounds, opts?)

type ReadOpts = { round?: bigint; signal?: AbortSignal; fields?: NfdField[] }   // fields default: ['caAlgo', 'avatar', 'bio']

type NfdRecord = {
  appId: bigint; name: string; version: string; major: 1 | 2 | 3
  owner: string; asaId: bigint; parentAppId: bigint | null; category?: string
  state: 'owned' | 'forSale' | 'expired' | 'unowned'
  expiresAt?: number
  caAlgo: string[]          // all v.caAlgo.N.as chunks, zero addresses dropped, capped at maxCaAlgo
  caAlgoCount: number       // before the cap
  caAlgo0: string[]         // just v.caAlgo.0.as: what Réti's contract checks
  avatar?: string           // u.avatar || v.avatar (raw; ipfs:// left to the app)
  bio?: string
  round: bigint             // the round it was read at
}
```

v1 of the SDK's methods (`getAddressesAppids`, `getAppIdsFromNames`, `getTinyViewFromAppIds`, …) and its `NfdReader` contract are dropped. This is a new major version, and no external users are known.

### 4.8 reti-ui integration (follow-up, not part of the SDK)

- New query options `nfdRecordQueryOptions(appId, round)` and `nfdReverseQueryOptions(address, round)` that end their keys with `roundKey(round)`. Pinned rounds use `staleTime: Infinity`.
- Replace `fetchNfd` / `fetchNfdReverseLookup` for validator NFDs, pool links, staker labels and gating checks with the SDK at the page's round. Remove "NFDs are current" from the banner when `sdk.supported()`.
- `fetchValueToVerify(SegmentNfd)` → `getSegmentsFor`, which fixes the "linked but not owner" gap. `CreatorNfd` → `getRecords([...]).caAlgo0`, the chunk the contract checks.
- Keep REST for avatar image resolution, free-text search, and as the whole path when the SDK isn't supported.

## 5. Contract details and gotchas

- **Guard `app_box_*` with `app_params_get AppCreator`.** An app that doesn't exist at R makes `app_box_*` fail the call, unlike `app_global_get_ex`. Candidate ids from indexes can point at deleted apps, and appIds from callers can point at apps created after R.
- **Check `app_opted_in` before reading lsig local state.** `app_local_get_ex` on an account that never opted in to the registry fails the call.
- **Boxes over 4,096 bytes** (a `caAlgo` box can hold up to 1,024 addresses) can't be read with `app_box_get`: use `app_box_len`, then `app_box_extract` in chunks. Scan for validation chunk by chunk; log only up to the cap.
- **v1 lsig suffixes:** forward `name/<name>`; reverse `address/` + the base32 string (58 bytes), so the suffix is 66 bytes with a 1-byte uvarint length. Encode the uvarint properly (today's contract uses `encodeArc4(...).slice(1)`, which breaks above 255).
- **Registry id is a parameter everywhere,** not baked in (testnet 84,366,825, betanet 842,656,530).
- **Int decoding:** only the keys listed in 2.2. Don't guess from the length.
- **Budget:** a reverse lookup with ~100 candidates, each reading a few globals and one or two boxes, is a few tens of thousands of opcodes, under 320k. Addresses with hundreds of candidates (exchanges, dealers) could approach it. Cap the candidates checked per call (e.g. 256) and report `truncated` on the result.
- **Log size:** one call's logs are capped at 64 KB by the node, and a single log at 4 KB (the AVM's byte limit). Records are ~200 bytes without `caAlgo`, so a reverse lookup with 94 results fits easily.

## 6. Verification

### 6.1 Prototype results (2026-10-26, :8081 with `676100b5f`)

`prototypes/reverse-lookup.teal` (TEAL v13, 506 bytes) is `reverseLookup` from 4.2, without the field output. In one call it:

- reads the registry `addr/algo/` box and the v1 lsig's `i.apps0..15`
- removes duplicates and checks each app exists (`AppCreator`)
- drops expired NFDs
- scans `v.caAlgo.N.as` (v1 global state, or v2/v3 boxes read in 4 KB pieces)
- logs `appId ‖ i.name` for each NFD that passes

`prototypes/reverse-lookup-run.py` runs it, and `reverse-lookup-check.py` rebuilds the expected answers from REST reads at the same round.

**Raw box reads:**
- Registry boxes are present at latest and 40M, and absent (exists 0, no failure) at 30M, before the box era.
- `king.dragonfi`'s `v.caAlgo.0.as` is absent at 40M, while it was deleted.
- A missing box returns `0, ''`.
- The `AppCreator` guard covers apps not yet created at the round.

**Full run: 1,639 addresses × 8 rounds** (latest, 60M, 50M, 45M, 40M, 33M, 28M, 22M):

- 13,112 calls, **0 errors**
- max cost **8,824** opcodes (of 320,000); average 99–522 per round
- 2 requests, 5.6 s, 0.85 MB
- NFDs found per round: from 108 (22M) to 3,081 (60M)

**Speed at the latest round:** all 1,639 addresses in **37–74 ms** warm (102 ms cold), whether sent as 2 × 1,024, 7 × 256 or 13 × 128 calls. Past rounds are slower: the 8-round run averages ~0.7 s per round, because it reads historical state cold. No 503s at 4 parallel requests.

**Correctness:**
- 120 random (address, round) pairs (90 with NFDs, 30 without), recomputed purely from REST at the same round: **0 mismatches**.
- Named fixtures, at latest, 46M, 43M, 40M, 33M and 30M:
  - `818.algo` is found through the v1 lsig at every round.
  - `king.dragonfi`'s verified address `22T4…` resolves through v1 global state at 30M (before registry boxes) and a v2 box at 33M. It's absent at 40M and 43M (box deleted) and back at 46M.
  - `24F3…` gains and loses `topblaster.algo` over time, as its state did.

Still to test: `resolveName`, `getRecord` with field output and caps, `ownedBy`/`segmentsFor`, and the REST cross-check against the NFD API at the latest round.

### 6.2 Fixtures and cross-checks

Fixtures, from revision 1's probes:

| Case | Expectation |
|---|---|
| `818.algo` / owner `43H6L4VK…` at latest | forward → 864,806,088; reverse finds it (lsig only, no registry box); `caAlgo` from global |
| `king.dragonfi.algo` 1,013,764,620 at 30M / 33M / 40M / 46M | v1 with global caAlgo / v2 with box caAlgo / v2 with no caAlgo (box deleted) / v2 with caAlgo and `u.avatar` |
| `batmanmarkets.algo` 2,318,360,299 at 43M / latest | v3.4, not expired / v3.7, expired, excluded from reverse |
| `22T47MKF…` at 33M / 43M / latest | registry reverse box present / absent / present |
| `building.algo` 2,526,143,532 for `43H6L4VK…` | in its owner boxes and holds the ASA, but `getOwned` excludes it (`i.owner.a` is `5DGTK…`) |
| `bakare.algo` 3,296,744,483 for `27CZLZFH…` | owned although the ASA sits in the app (found through owner boxes) |
| any name or address at a round before 32,241,660 | registry boxes absent, lsig answer used, no errors |
| an appId created after R, a deleted appId | `null`, no error |

Cross-checks:

- At the latest round, compare against the NFD REST API for `projects/sdk/all-nfd-apps.csv` (32,654 apps), `addresses.txt` (1,639) and `v1-nfds.txt` (48): names, owners, verified addresses, reverse results.
- At past rounds, compare against REST state at the same round (`/v2/applications/{id}?round=R`, `/v2/applications/{id}/box?name=…&round=R`, URL-escaped). Use ~64 rounds over the registry's life, like reti-ghost-sdk's `verify.ts`.

## 7. Would more query features help?

Foreign box reads were the main ask. The try/catch idea from revision 1 is no longer needed: nothing fails. One feature would still remove the last REST step:

- **Box prefix iteration in queries** (e.g. a query-only opcode that returns the next box name of an app after a given name, within a prefix). `getOwned` and `getSegmentsFor` could then enumerate `"O"‖A` owner boxes in the reader. That would make them one request, and owned series would cost one request per 64 rounds instead of a REST pair per round. ASA holdings still need REST, but only for v1, v2 and older v3.

## 8. What changed from revision 1

- **Removed:**
  - per-field "cells" with stage markers
  - two-phase lookups (candidates, then validation)
  - v2 `read_property` and v3 `readField` inner calls
  - registry `get_*` inner calls
  - the simulate fallback and ghostkit
  - the try/catch discussion
- **Now:** one call per item, with validation inside; one request per lookup; series exact per round; query only, with REST as reti-ui's fallback.
- **New guards:** `AppCreator` before `app_box_*`, `app_box_len` + `app_box_extract` for boxes over 4 KB, and caps on candidates and output.
- **Unchanged:** the chain facts in section 2, the union of registry and v1 sources, validation at R, TxnLab's state and merge rules, reti's needs, and the API shape (minus `backend`, plus `supported()`, `getOwned`, `caAlgoCount`).

## 9. Open questions

1. When did `"O"` owner boxes start, and were older v3 NFDs back-filled? This decides how big the `getOwned` gap is.
2. ~~Feature flag for foreign box reads~~: not needed. Every query endpoint has them.
3. Testnet registry history: the same three-generation shape is likely but unverified. Nothing in this design depends on it.
4. Do any NFDs have more `caAlgo` addresses or candidates than the caps (64 output / 256 checked)? Measure across `all-nfd-apps.csv` and pick the caps from the data.

## 10. As built (2026-10-26)

Implemented in `projects/contracts/smart_contracts/nfd_query_reader` (the `NfdQueryReader`, puya-ts 1.3.1, AVM 13, 3.4 KB) and `projects/sdk` (v2.0.0-dt.1). Verified on :8081 (`b32cf958`, which includes `676100b5f`): the section 6 fixtures all pass; at the latest round, 1,639/1,639 reverse lookups agree with the REST API's primary NFD and 648/648 records (the 48 v1 NFDs and 600 sampled v3 ones) agree on owner, state, `caAlgo`, avatar and parent; at 64 rounds over the registry's life, 8,448 (app, round) pairs agree with an independent derivation from algod REST state.

Where it differs from sections 4–5:

- **The reader derives v1 name lsigs itself** (template, uvarint length, `sha512_256`) and hashes the registry box names (`sha256`). Only the reverse lsig, which needs base32, comes from the SDK. So `resolveName` takes no `nameLsig`, `ownedBy` can map NFD assets to apps on chain (unit name `NFD`, asset name → name → app, app address = asset creator), and the SDK needs no hash library (it runs in the browser).
- **`getRecord` checks the registry names the app**: `i.name` must resolve to the app through the `name/` box or the v1 lsig, else null, as the REST API only knows real NFDs.
- **Paging instead of a `truncated` flag.** `reverseLookup` and `ownedBy` take `start` and `limit` (128 candidates per call) and a log budget (the node's `maxCallLogBytes` less 64). A call that stops early logs `0x02 ‖ next ‖ total`, and the SDK calls again from `next` until done; a call over a limit is retried with half the page. Logs are tagged: `0x01 ‖ NfdRecord`.
- **No separate `segmentsFor` method**: `reverseLookup` and `ownedBy` take a `parent`, which switches them to Réti's rule (parent match, and owner or in `v.caAlgo.0.as`, no state filter). `getSegmentsFor` sends both in one request.
- **v1 segments count only their owner.** Réti reads `v.caAlgo.0.as` through the NFD's `read_property` method, and v1 programs (`1.12`, 864,806,088) don't have it, so Réti's stake would fail for a staker only linked to a v1 segment.
- **Long names in `ownedBy`.** NFD asset names are cut to 32 bytes (`key2manifestation.blockcy...algo`), so they don't resolve. The reader then looks at the 8 app ids before the asset for the one whose address created it, and checks its `i.name` against the registry. Across 2,769 NFDs the asset is 3 (recent v3), 6 or 7 (2022–2023, and every v1) ids after the app.
- **Caps**: `maxCaAlgo` is at most 40 (default 40), not 64, since `caAlgo0` is a separate list and a record must fit one 4,096-byte log; avatar ≤ 256 bytes, bio ≤ 768, name, version and category ≤ 96. `caAlgo0` is read whatever the state (Réti parity); `caAlgo`, avatar and bio follow the expired / for-sale rule.
- **`v.caAlgo.N.as` and `u.bio_NN`** are read from 0 until one is missing (at most 16). `bio` is `u.bio ‖ u.bio_00 ‖ …`: v1 NFDs use one or the other.
- **Foreign box reads are detected by a probe** (`resolveName` of a name no NFD has), since the node doesn't advertise them.
- **Extra API**: `getRecord` and `resolveName` (one item), `getRegistryCreationRound`, `clearCache`; options `concurrency`, `cacheEntries`, `latestTtlMs`.

Answers to section 9:

1. Owner boxes exist from the first round of the third registry generation (42,181,254). Whether older v3 NFDs were back-filled is still unmeasured.
4. Every live NFD (all v3 today) has at most one `v.caAlgo.N.as` chunk, of at most 5 addresses; the largest reverse box among `addresses.txt` holds 24 ids. A full 128-candidate page with every field costs ~95,000 opcodes (~750 per record) of the 320,000 budget.

Other findings: the node answers 503 at 8 concurrent query requests, so the SDK defaults to 4, shared by all its queries. A program may make at most 2,048 log calls in a query. The node's limit errors read `dynamic cost budget exceeded`, `program logs too large` and `too many log calls`; only those (and `query response too large` or a time-out) make the SDK retry a page at half its size. Every NFD key sampled (v1, v2, v3) is bytes, never a TEAL uint. NFD asset holdings at a past round come with `asset-params`, so the SDK filters them by unit name before the query.
