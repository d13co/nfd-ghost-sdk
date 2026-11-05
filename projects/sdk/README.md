# nfd-ghost-sdk v2

Read-only NFD lookups at any round since the NFD registry was created (21,341,747 on MainNet, May 2022), for every NFD contract generation (v1, v2, v3) and every registry generation:

- forward: name → NFD, app id → NFD
- reverse: address → the NFDs that list it as a verified address, primary first
- ownership: the NFDs an address owns, and the segments of a parent NFD an address owns or is linked to (Réti's segment gating rule)

Every lookup is one read-only query (`POST /v2/query`) on a dtalgod, running the `NfdQueryReader` ghost program, which reads registry and NFD state, validates the candidates and logs only the answers. Reads at past rounds are exact: each round validates its own candidates.

See [DESIGN-v2.md](../../DESIGN-v2.md) for the chain facts and the design.

## Requirements

- A dtalgod that serves `GET /v2/capabilities`, with read-only queries on (they read foreign boxes). `getOwned` and `getSegmentsFor` also need time travel on (`EnableTimeTravel`); without it they throw `NfdQueryUnavailableError`.
- The dtalgorand forks of algosdk (`dt-algosdk` 3.9.0-dt.5.2.0.0) and algokit-utils (`@d13co/dt-algokit-utils` 9.2.3-dt.5.2.0.0) from npm, installed under the stock names, pinned exactly, and overridden so that one copy of each loads: `"algosdk": "npm:dt-algosdk@3.9.0-dt.5.2.0.0"` and `"@algorandfoundation/algokit-utils": "npm:@d13co/dt-algokit-utils@9.2.3-dt.5.2.0.0"` in `dependencies` and again in npm's `overrides` (pnpm `overrides`, yarn `resolutions`). Older forks read the node through an endpoint current nodes no longer serve, so with them `supported()` is false; the dt4 forks can't read a dt5 node's limits, so every read fails. Don't use `--legacy-peer-deps` for a peer conflict: it means an override is missing, and installs a second, stock copy. See [Installing the fork](https://github.com/d13co/dt-algokit-utils-ts#installing-the-fork).

Without them, `sdk.supported()` is false and every read throws `NfdQueryUnavailableError`: keep reading NFDs another way (the NFD REST API) there. `supported()` throws when it can't reach the node, and asks again on the next call.

## Usage

```ts
import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { NfdGhostSDK } from "nfd-ghost-sdk"

const algorand = AlgorandClient.fromConfig({ algodConfig: { server: "http://127.0.0.1", port: 8081, token: "" } })
const sdk = new NfdGhostSDK({ algorand, registryAppId: 760937186 })

if (await sdk.supported()) {
  const king = await sdk.getRecord(1013764620n) // latest round
  const then = await sdk.atRound(45_000_000n).resolveName("king.dragonfi.algo")
  const linked = await sdk.reverseLookup([poolAppAddress], { round, signal })
  const segments = await sdk.getSegmentsFor(staker, rootAppId, { round })
}
```

## API

```ts
new NfdGhostSDK({ algorand, registryAppId, round?, batchWindowMs?, maxCaAlgo?, concurrency?, cacheEntries?, latestTtlMs?, debug? })

sdk.atRound(round): NfdGhostSDK          // every read at that round; shares the cache
sdk.supported(): Promise<boolean>
sdk.prefetch(opts?): Promise<void>
sdk.getRegistryCreationRound(): Promise<bigint | undefined>
sdk.clearCache(): void

sdk.getRecords(appIds, opts?): Promise<Map<bigint, NfdRecord | null>>
sdk.getRecord(appId, opts?): Promise<NfdRecord | null>
sdk.resolveNames(names, opts?): Promise<Map<string, NfdRecord | null>>
sdk.resolveName(name, opts?): Promise<NfdRecord | null>
sdk.reverseLookup(addresses, opts?): Promise<Map<string, NfdRecord[]>>   // primary first
sdk.getOwned(address, opts?): Promise<NfdRecord[]>
sdk.getSegmentsFor(address, parentAppId, opts?): Promise<NfdRecord[]>

sdk.getRecordsSeries(appIds, rounds, opts?): Promise<SeriesPoint<Map<bigint, NfdRecord | null>>[]>
sdk.resolveNamesSeries(names, rounds, opts?): Promise<SeriesPoint<Map<string, NfdRecord | null>>[]>
sdk.reverseLookupSeries(addresses, rounds, opts?): Promise<SeriesPoint<Map<string, NfdRecord[]>>[]>
sdk.getRecordsAt(pairs: { appId; round }[], opts?): Promise<(NfdRecord | null)[]>   // in the order given

type ReadOpts = { round?: number | bigint; signal?: AbortSignal; fields?: ("caAlgo" | "avatar" | "bio")[] }  // fields default: all three
type SeriesRounds = (number | bigint)[] | { from; to; points }
type SeriesPoint<T> = { round: bigint } & ({ ok: true; value: T } | { ok: false; error: Error })
```

`NfdRecord`:

| Field | |
|---|---|
| `appId`, `name`, `version`, `major` | `i.ver` such as `3.7`; `major` 1 (properties in global state), 2 or 3 (properties in boxes) |
| `owner`, `asaId`, `parentAppId`, `category` | `i.owner.a`, `i.asaid`, `i.parentAppID` (null for a root), `i.category` |
| `state` | `expired` (`i.expirationTime` set and past at the round's block timestamp), `forSale` (`i.sellamt` set), `unowned` (owned by its own app), else `owned` |
| `expiresAt` | `i.expirationTime`, unix seconds |
| `caAlgo`, `caAlgoCount` | every `v.caAlgo.N.as` chunk in key order, zero addresses dropped, capped at `maxCaAlgo` (≤ 40); the count is before the cap. Empty for expired and for-sale NFDs |
| `caAlgo0` | just `v.caAlgo.0.as`, whatever the state: what Réti's contract checks |
| `avatar` | `u.avatar`, else `v.avatar`, raw (≤ 256 bytes) |
| `bio` | `u.bio` then `u.bio_00`, `u.bio_01`, … merged (≤ 768 bytes) |
| `round` | the round it was read at |

Expired and for-sale NFDs have their properties ignored (no `caAlgo`, avatar or bio), and are left out of reverse lookups.

### Lookups in detail

- **getRecords**: null when the app doesn't exist at the round, or isn't the NFD its registry names (its `i.name` resolves, through the registry's `name/` box or the v1 name lsig, to another app or to none).
- **resolveNames**: the registry's `name/` box, else the v1 name lsig's `i.appid`, then checked against the app's `i.name`. Names are looked up lowercased; the map is keyed by the names as given.
- **reverseLookup**: the union of the registry's `addr/algo/` box and the v1 address lsig's `i.apps0..15`, each checked to be an NFD, neither expired nor for sale, that lists the address in its `caAlgo` at the round. The registry box doesn't hold all v1 data, so both are read.
- **getOwned**: two REST reads at the round find the candidates, the registry's `"O" ‖ owner ‖ appId` owner boxes (v3) and the NFD assets the address holds; one query keeps those whose `i.owner.a` is the address. Holding an NFD's asset isn't owning it. An asset is mapped to its NFD by its name; names over 32 bytes are cut short in asset names, so for those the reader finds the app among the 8 ids before the asset (NFDs mint their asset 3, 6 or 7 ids after their app) by its address being the asset's creator, then checks the app's `i.name` against the registry. Known gap: a v3 NFD owned at a round before owner boxes were written for it, whose asset sits in its app.
- **getRecordsAt**: each NFD at its own rounds, such as every NFD an account touched at the rounds it changed. A series reads every key at every round; this packs the pairs into queries of one request each, within the node's limits (`maxRounds`, `maxCalls` and `maxTotalCalls`, NFDs times rounds: 16 rounds, 1,024 NFDs and 1,024 in all on :8080), NFDs wanted at the same or nearby rounds together, and reads each query's NFDs at all its rounds, at most 16 reads per pair asked for. On :8080, 1,000 pairs (200 NFDs at 5 rounds each, spread from round 40M to the tip) take 67 queries, about 3,000 evaluations and 1.1 s. Results are as `getRecords` gives them, plus null for a round before the registry was created; a round past the tip throws `FutureRoundError` before any query, and a failed read of a pair asked for throws and cancels the other queries. Pairs already read come from the cache, and everything read is cached.
- **getSegmentsFor**: the reverse lookup's and `getOwned`'s candidates, kept when `i.parentAppID` is the parent and the address is `i.owner.a` or, for v2 and v3 NFDs, in `v.caAlgo.0.as`, as Réti's `doesStakerMeetGating` checks (no state filter, as there). Réti reads `v.caAlgo.0.as` with the NFD's `read_property` method, which v1 NFDs don't have, so for a v1 segment only its owner passes. Réti takes the first one's `appId` as `valueToVerify`.

### Rounds, batching and caching

- A round before the registry was created throws `NfdNotDeployedError`, and a round past the node's tip `FutureRoundError`, both without a query. Series give those rounds as failed points instead.
- Reads made within `batchWindowMs` (10 ms) of each other for the same round share one query, whatever their kind: a page that asks for one NFD per row sends one request. The node's limits (calls, rounds, and calls times rounds per request; 1,024, 16 and 1,024 on :8080, where dt5 nodes first report the last) are kept by splitting.
- Reads are cached by round, kind, key and fields: past rounds for good, the latest round for `latestTtlMs` (5 s). Two callers asking for the same thing share one read.
- At most `concurrency` (4) query requests are in flight at once, across every read of the SDK and its `atRound`s.
- A caller's signal stops its own wait. A request is cancelled once every read in it has aborted.
- `debug: true` logs one `console.debug` line per batch of reads: its calls by method, the round, its queries and HTTP requests, the records found by version, and the time taken, with the call labels and per-query numbers as a second argument.
- Busy and failing nodes are retried by the algod client, not by the SDK: the clients algokit-utils makes (`AlgorandClient.fromConfig`, `fromEnvironment`) retry by dt-algosdk's retry policy (rate limits, busy nodes, server and network errors, up to 5 tries, honouring `Retry-After`), set with their `retry` option or `Config.configure({ retry })`. An `Algodv2` passed to `AlgorandClient.fromClients` retries only if its HTTP client does: wrap it with dt-algosdk's `withRetry`. A round past the latest one the SDK knows is checked against the node before `FutureRoundError` is thrown. Lists (reverse lookups, ownership candidates) are read 128 candidates per call, and a call that reaches its log budget says where to go on, so neither the 320,000 opcode budget nor the 64 KB of logs per call can be exceeded.

### v1 lookup lsigs

`nameLsigAddress(registryAppId, name)` and `addressLsigAddress(registryAppId, address)` derive the v1 lookup accounts (`getLookupLSIG` in TxnLab's Go code), with the registry id as a parameter, so TestNet (84,366,825) and BetaNet (842,656,530) work too.

## Development

```sh
pnpm install
pnpm build              # copies the reader from ../contracts (build it there first: pnpm run build), then tsc to dist/esm and dist/cjs
pnpm test               # unit tests, plus integration tests against the local MainNet query node when it's reachable
pnpm verify             # DESIGN-v2 section 6 fixtures
pnpm verify:rest        # latest round vs the NFD REST API (addresses.txt, v1-nfds.txt, a sample of all-nfd-apps.csv)
pnpm verify:rounds      # past rounds vs an independent derivation from algod REST state (ROUNDS=64 APPS=120)
```

The examples and tests use `http://127.0.0.1:8081` by default; set `ALGOD_SERVER`, `ALGOD_PORT` and `ALGOD_TOKEN` for another node.

This is a new major version: v1's methods (`getAddressesAppids`, `getAppIdsFromNames`, `getTinyViewFromAppIds`, …) and its `NfdReader` contract are gone.
