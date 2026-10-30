import type { AlgorandClient } from "@algorandfoundation/algokit-utils"
import * as algosdk from "algosdk"
import { abortable, raceAbort } from "./abort.js"
import { Batcher } from "./batcher.js"
import { ReadCache } from "./cache.js"
import { QueryEngine, type CallOutcome, type CallSpec } from "./engine.js"
import { FutureRoundError, NfdNotDeployedError, NfdQueryUnavailableError } from "./errors.js"
import { addressLsigAddress } from "./lsig.js"
import { DEFAULT_FIELDS, encodeOpts, MAX_CA_ALGO, type NfdField, type NfdRecord } from "./reader.js"
import { seriesRounds, type SeriesPoint, type SeriesRounds } from "./series.js"

/** Per-call read options. */
export type ReadOpts = {
  /**
   * Read the state as of the end of this round instead of the latest. Overrides the SDK's own `round` (see `atRound`).
   * A round before the registry was created throws `NfdNotDeployedError`, and one the node hasn't reached yet
   * `FutureRoundError`, both without a query.
   */
  round?: number | bigint
  /**
   * Stops the read: it rejects with the signal's reason. Requests other reads share (the same NFD read by another
   * caller, other calls batched with it) carry on for them; a request is cancelled once every read in it has aborted.
   */
  signal?: AbortSignal
  /** The fields to read besides the core ones. Default: `caAlgo`, `avatar` and `bio`. */
  fields?: readonly NfdField[]
}

/** Options for reads that only take a signal. */
export type SignalOpts = Pick<ReadOpts, "signal">

export type NfdGhostSDKParams = {
  /**
   * AlgoKit `AlgorandClient` on a dtalgod with read-only queries (`POST /v2/query`) and foreign box reads in queries,
   * built with the dtalgorand forks of algosdk and algokit-utils. A client made from a config retries a busy node (503).
   */
  algorand: AlgorandClient
  /** NFD registry app id: 760937186 on MainNet, 84366825 on TestNet */
  registryAppId: number | bigint
  /** Default round for every read; omit to read the latest state. See `atRound`. */
  round?: number | bigint
  /** How long reads wait for others to share a query with, in milliseconds (default 10) */
  batchWindowMs?: number
  /** The most `caAlgo` (and `caAlgo0`) addresses a record carries, at most 40 (default 40); `caAlgoCount` has them all */
  maxCaAlgo?: number
  /** The most query requests in flight at once, across every read of this SDK and its `atRound`s (default 4) */
  concurrency?: number
  /** The most reads kept in the cache (default 10,000; 0 turns it off) */
  cacheEntries?: number
  /** How long reads at the latest round are cached, in milliseconds (default 5,000). Past rounds are cached for good. */
  latestTtlMs?: number
  /**
   * Log each query to `console.debug`: its args by method, its `query.run`s and the HTTP requests they split into, the
   * records found by NFD major version, and timings
   */
  debug?: boolean
}

/** Candidates per reverse lookup call: about 1,000–1,800 opcodes each, under the 320,000 budget with room to spare. */
const REVERSE_PAGE = 128
/** Ownership candidates per call. */
const OWNED_PAGE = 128
/** Log bytes kept free under the node's per-call limit. */
const LOG_MARGIN = 64
/** What the protocol lets a call log when the node sets no query limit of its own. */
const PROTOCOL_LOG_BYTES = 1024
/** How long a read of the node's latest round is reused for reads that need a fresh one. */
const STATUS_MAX_AGE_MS = 1_000
/** A name no NFD has: the support probe resolves it, which reads a registry box. */
const PROBE_NAME = "nfd-ghost-sdk-probe-0.algo"

const textEncoder = new TextEncoder()

/** The shared state of an SDK and the SDKs `atRound` returns. */
type Shared = {
  engine: QueryEngine
  batcher: Batcher
  cache: ReadCache
  supported?: Promise<{ ok: boolean; reason?: string }>
  creationRound?: Promise<bigint | undefined>
  logBudget?: Promise<number>
  latest?: { round: bigint; at: number }
  statusRead?: Promise<bigint>
}

function packIds(ids: bigint[]): Uint8Array {
  const out = new Uint8Array(ids.length * 8)
  const view = new DataView(out.buffer)
  ids.forEach((id, i) => view.setBigUint64(i * 8, id))
  return out
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

function dedupe(records: NfdRecord[]): NfdRecord[] {
  const seen = new Set<bigint>()
  return records.filter((record) => {
    if (seen.has(record.appId)) return false
    seen.add(record.appId)
    return true
  })
}

function unwrap(outcome: CallOutcome): NfdRecord[] {
  if (!outcome.ok) throw outcome.error
  return outcome.records
}

/** A query of `getRecordsAt`: its NFDs, each read at every one of its rounds. */
type PairGroup = { appIds: bigint[]; rounds: bigint[] }

/** The most reads a `getRecordsAt` query makes for each pair asked for: an NFD is read at every round of its query. */
const PAIR_WASTE = 16
/** The queries still open to more pairs while packing: the latest ones, which hold the nearest rounds. */
const OPEN_GROUPS = 32

/**
 * Packs the rounds each NFD is wanted at into queries of at most `maxRounds` rounds and `maxCalls` NFDs, each one HTTP
 * request: an NFD's rounds are cut into runs of `maxRounds`, and each run, earliest rounds first, joins the first open
 * query it fits in, so NFDs wanted at the same or nearby rounds share a query. A query reads all its NFDs at all its
 * rounds, so a run only joins one while that stays within `PAIR_WASTE` reads per pair asked for.
 */
export function packPairs(
  wanted: Map<bigint, Set<bigint>>,
  { maxCalls, maxRounds }: { maxCalls: number; maxRounds: number },
): PairGroup[] {
  const ascending = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0)
  const items: { appId: bigint; rounds: bigint[] }[] = []
  for (const [appId, set] of wanted) {
    const rounds = [...set].sort(ascending)
    for (let at = 0; at < rounds.length; at += maxRounds)
      items.push({ appId, rounds: rounds.slice(at, at + maxRounds) })
  }
  items.sort((a, b) => ascending(a.rounds[0], b.rounds[0]))
  type Group = { appIds: Set<bigint>; rounds: Set<bigint>; pairs: number }
  const groups: Group[] = []
  const open: Group[] = []
  for (const item of items) {
    let group = open.find((g) => {
      const apps = g.appIds.size + (g.appIds.has(item.appId) ? 0 : 1)
      if (apps > maxCalls) return false
      let rounds = g.rounds.size
      for (const round of item.rounds) if (!g.rounds.has(round) && ++rounds > maxRounds) return false
      return apps * rounds <= PAIR_WASTE * (g.pairs + item.rounds.length)
    })
    if (!group) {
      group = { appIds: new Set(), rounds: new Set(), pairs: 0 }
      groups.push(group)
      open.push(group)
      if (open.length > OPEN_GROUPS) open.shift()
    }
    group.appIds.add(item.appId)
    for (const round of item.rounds) group.rounds.add(round)
    group.pairs += item.rounds.length
  }
  return groups.map((g) => ({ appIds: [...g.appIds], rounds: [...g.rounds].sort(ascending) }))
}

/** An NFD name as the registry keys it. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Read-only NFD lookups at any round, for every NFD generation (v1, v2, v3) and registry generation, through dtalgod's
 * read-only queries. Every read takes `{ round }` to read the state as of that round, or pin a round for all reads with
 * `atRound`.
 */
export class NfdGhostSDK {
  public readonly algorand: AlgorandClient
  public readonly registryAppId: bigint
  /** Default round for every read; undefined reads the latest state. */
  public readonly round?: bigint
  public readonly maxCaAlgo: number
  public readonly debug: boolean
  private readonly shared: Shared

  constructor({
    algorand,
    registryAppId,
    round,
    batchWindowMs = 10,
    maxCaAlgo = MAX_CA_ALGO,
    concurrency = 4,
    cacheEntries = 10_000,
    latestTtlMs = 5_000,
    debug = false,
  }: NfdGhostSDKParams) {
    this.algorand = algorand
    this.registryAppId = BigInt(registryAppId)
    this.round = round === undefined ? undefined : BigInt(round)
    this.maxCaAlgo = Math.max(0, Math.min(MAX_CA_ALGO, maxCaAlgo))
    this.debug = debug
    const engine = new QueryEngine(algorand, concurrency, debug)
    this.shared = {
      engine,
      batcher: new Batcher(engine, batchWindowMs),
      cache: new ReadCache(cacheEntries, latestTtlMs),
    }
  }

  /** The same SDK with every read as of the end of `round`; `undefined` reads the latest state. Shares the cache. */
  atRound(round: number | bigint | undefined): NfdGhostSDK {
    return Object.assign(Object.create(this) as NfdGhostSDK, { round: round === undefined ? undefined : BigInt(round) })
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Node

  /**
   * Whether this node and client can read NFDs: the dtalgorand forks, a dtalgod with read-only queries, and foreign box
   * reads in queries (probed once with a 1-call query). When false, every read throws `NfdQueryUnavailableError`.
   * Throws if the probe can't reach the node (not remembered: the next call probes again).
   */
  async supported(): Promise<boolean> {
    return (await this.support()).ok
  }

  /**
   * Fetches what the first reads wait for: support, the registry's creation round and the node's limits. Reads fetch
   * them anyway; this lets them arrive while the app does other work.
   *
   * @param options.signal Stops the wait only: the fetches are shared and carry on for the reads that need them
   */
  async prefetch({ signal }: SignalOpts = {}): Promise<void> {
    signal?.throwIfAborted()
    await raceAbort(Promise.all([this.support(), this.getRegistryCreationRound(), this.logBudget()]), signal)
  }

  /** The round the registry was created at, the earliest round NFDs can be read at. Undefined if the node can't say. */
  getRegistryCreationRound(): Promise<bigint | undefined> {
    if (!this.shared.creationRound) {
      const dt = (this.algorand as Partial<Pick<AlgorandClient, "dt">>).dt
      if (!dt) return Promise.resolve(undefined)
      const lookup: Promise<bigint | undefined> = dt
        .getAppVersions(this.registryAppId, { order: "asc", limit: 1 })
        .then(({ versions }) => versions[0]?.round)
        .catch(() => {
          // unknown this time; the next read asks again
          if (this.shared.creationRound === lookup) this.shared.creationRound = undefined
          return undefined
        })
      this.shared.creationRound = lookup
    }
    return this.shared.creationRound
  }

  /** Drops every cached read. */
  clearCache(): void {
    this.shared.cache.clear()
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Lookups

  /**
   * Each NFD by app id: null if the app doesn't exist at the round or isn't the NFD its registry names (its `i.name`
   * resolves to another app, or to none).
   */
  async getRecords(appIds: (number | bigint)[], opts: ReadOpts = {}): Promise<Map<bigint, NfdRecord | null>> {
    const ids = [...new Set(appIds.map(BigInt))]
    const records = await this.readEach(
      opts,
      ids,
      (id) => `r|${id}`,
      (id, o) => this.recordSpec(id, o),
    )
    return new Map(ids.map((id, i) => [id, records[i][0] ?? null]))
  }

  /** One NFD by app id; see `getRecords`. */
  async getRecord(appId: number | bigint, opts: ReadOpts = {}): Promise<NfdRecord | null> {
    return (await this.getRecords([appId], opts)).get(BigInt(appId)) ?? null
  }

  /**
   * Each NFD by name (the registry's `name/` box, else the v1 name lsig), checked against the app's `i.name`: null if no
   * NFD has the name at the round. Keyed by the names as given; names are looked up lowercased.
   */
  async resolveNames(names: string[], opts: ReadOpts = {}): Promise<Map<string, NfdRecord | null>> {
    const unique = [...new Set(names)]
    const records = await this.readEach(
      opts,
      unique,
      (name) => `n|${normalizeName(name)}`,
      (name, o) => this.nameSpec(normalizeName(name), o),
    )
    return new Map(unique.map((name, i) => [name, records[i][0] ?? null]))
  }

  /** One NFD by name; see `resolveNames`. */
  async resolveName(name: string, opts: ReadOpts = {}): Promise<NfdRecord | null> {
    return (await this.resolveNames([name], opts)).get(name) ?? null
  }

  /**
   * The NFDs that have each address as a verified address at the round, primary first: the registry's `addr/algo/`
   * box and the v1 address lsig's `i.apps0..15`, each checked to be an NFD that is neither expired nor for sale and that
   * lists the address in its `caAlgo`. Empty if none.
   */
  async reverseLookup(addresses: string[], opts: ReadOpts = {}): Promise<Map<string, NfdRecord[]>> {
    const unique = [...new Set(addresses)]
    const records = await this.readEach(
      opts,
      unique,
      (address) => `a|${address}`,
      (address, o) => this.reverseSpec(address, 0n, o),
    )
    return new Map(unique.map((address, i) => [address, dedupe(records[i])]))
  }

  /**
   * The NFDs `address` owns (`i.owner.a`) at the round. Candidates are the registry's `"O"` owner boxes (v3) and the
   * NFD assets the address holds, from two REST reads at the round, each checked in the query. Holding an NFD's asset
   * isn't owning it: only `i.owner.a` counts.
   *
   * Known gap: a v3 NFD owned at a round before owner boxes existed, whose asset sits in its app.
   */
  async getOwned(address: string, opts: ReadOpts = {}): Promise<NfdRecord[]> {
    return this.ownership(address, 0n, opts)
  }

  /**
   * The segments of `parentAppId` that `address` owns or is linked to at the round, as Réti's `doesStakerMeetGating`
   * accepts them: `i.parentAppID == parentAppId`, and `i.owner.a == address` or, for v2 and v3 NFDs, `address` in
   * `v.caAlgo.0.as` (Réti reads it with `read_property`, which v1 NFDs lack). The candidates are the reverse lookup's
   * and `getOwned`'s. Réti takes the first one's `appId` as `valueToVerify`.
   */
  async getSegmentsFor(address: string, parentAppId: number | bigint, opts: ReadOpts = {}): Promise<NfdRecord[]> {
    const parent = BigInt(parentAppId)
    if (parent === 0n) throw new RangeError("getSegmentsFor: parentAppId must be an NFD app id")
    return this.ownership(address, parent, opts)
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Series

  /** `getRecords` at each of `rounds`: one query per `maxRounds` rounds (the node's limit), each round exact. */
  async getRecordsSeries(
    appIds: (number | bigint)[],
    rounds: SeriesRounds,
    opts: Omit<ReadOpts, "round"> & { maxPoints?: number } = {},
  ): Promise<SeriesPoint<Map<bigint, NfdRecord | null>>[]> {
    const ids = [...new Set(appIds.map(BigInt))]
    return this.series(
      ids,
      rounds,
      opts,
      (id) => `r|${id}`,
      (id, o) => this.recordSpec(id, o),
      (records) => records[0] ?? null,
    )
  }

  /** `resolveNames` at each of `rounds`. */
  async resolveNamesSeries(
    names: string[],
    rounds: SeriesRounds,
    opts: Omit<ReadOpts, "round"> & { maxPoints?: number } = {},
  ): Promise<SeriesPoint<Map<string, NfdRecord | null>>[]> {
    const unique = [...new Set(names)]
    return this.series(
      unique,
      rounds,
      opts,
      (name) => `n|${normalizeName(name)}`,
      (name, o) => this.nameSpec(normalizeName(name), o),
      (records) => records[0] ?? null,
    )
  }

  /** `reverseLookup` at each of `rounds`. */
  async reverseLookupSeries(
    addresses: string[],
    rounds: SeriesRounds,
    opts: Omit<ReadOpts, "round"> & { maxPoints?: number } = {},
  ): Promise<SeriesPoint<Map<string, NfdRecord[]>>[]> {
    const unique = [...new Set(addresses)]
    return this.series(
      unique,
      rounds,
      opts,
      (address) => `a|${address}`,
      (address, o) => this.reverseSpec(address, 0n, o),
      dedupe,
    )
  }

  /**
   * Each NFD at its own round: the record of `appId` as of the end of `round` for each pair, in the order given, null
   * as in `getRecords` and for a round before the registry was created. A round past the node's tip throws
   * `FutureRoundError` before any query, and a failed read throws its error.
   *
   * Reads every NFD only at the rounds asked for it, unlike a series, which reads every key at every round: the pairs
   * are packed into queries within the node's limits (`maxRounds` rounds and `maxCalls` NFDs), NFDs wanted at the same
   * or nearby rounds together. Each query reads its NFDs at all its rounds, at most 16 reads per pair asked
   * for. Pairs read before are taken from the cache, and everything a query read is cached. The first failed query
   * cancels the others.
   */
  async getRecordsAt(
    pairs: { appId: number | bigint; round: number | bigint }[],
    opts: Omit<ReadOpts, "round"> = {},
  ): Promise<(NfdRecord | null)[]> {
    const { signal } = opts
    const asked = pairs.map(({ appId, round }) => ({ appId: BigInt(appId), round: BigInt(round) }))
    const pairKey = (appId: bigint, round: bigint) => `${appId}@${round}`
    return abortable(signal, async () => {
      const found = new Map<string, NfdRecord | null>()
      // check every round first: one past the tip fails the whole read before any query
      const rounds = [...new Set(asked.map((pair) => pair.round))]
      const early = new Set<bigint>()
      await Promise.all(
        rounds.map((round) =>
          this.roundFor({ round, signal }).catch((error: unknown) => {
            if (!(error instanceof NfdNotDeployedError)) throw error
            early.add(round)
          }),
        ),
      )
      const todo = new Map<bigint, Set<bigint>>()
      await Promise.all(
        asked.map(async ({ appId, round }) => {
          const key = pairKey(appId, round)
          if (found.has(key)) return
          if (early.has(round)) return void found.set(key, null)
          const cached = await this.shared.cache
            .peek<NfdRecord[]>(this.cacheKey(round, opts.fields, `r|${appId}`))
            ?.catch(() => undefined)
          if (cached) return void found.set(key, cached[0] ?? null)
          todo.set(appId, (todo.get(appId) ?? new Set()).add(round))
        }),
      )
      if (todo.size) {
        await this.ensureSupported(signal)
        const o = await this.opts(opts.fields)
        const groups = packPairs(todo, await this.shared.engine.requestLimits())
        // the first failed query cancels the others
        const controller = new AbortController()
        const onAbort = () => controller.abort(signal!.reason)
        signal?.addEventListener("abort", onAbort, { once: true })
        try {
          signal?.throwIfAborted()
          await Promise.all(
            groups.map(async (group) => {
              const results = await this.shared.engine.run(
                group.appIds.map((id) => this.recordSpec(id, o)),
                group.rounds,
                controller.signal,
              )
              for (const result of results) {
                group.appIds.forEach((appId, i) => {
                  const outcome = result.outcomes[i]
                  const wanted = todo.get(appId)!.has(result.round)
                  // a failure only counts for a pair asked for; the query reads every NFD at every round
                  if (!outcome.ok) {
                    if (wanted) throw outcome.error
                    return
                  }
                  this.shared.cache.put(this.cacheKey(result.round, opts.fields, `r|${appId}`), outcome.records, false)
                  if (wanted) found.set(pairKey(appId, result.round), outcome.records[0] ?? null)
                })
              }
            }),
          )
        } catch (e) {
          controller.abort(e)
          throw e
        } finally {
          signal?.removeEventListener("abort", onAbort)
        }
      }
      return asked.map(({ appId, round }) => found.get(pairKey(appId, round)) ?? null)
    })
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Calls

  private recordSpec(appId: bigint, o: bigint): CallSpec {
    return { label: `getRecord(${appId})`, method: "getRecord", args: () => [this.registryAppId, appId, o] }
  }

  private nameSpec(name: string, o: bigint): CallSpec {
    return {
      label: `resolveName(${name})`,
      method: "resolveName",
      args: () => [this.registryAppId, textEncoder.encode(name), o],
    }
  }

  private reverseSpec(address: string, parent: bigint, o: bigint): CallSpec {
    const lsig = addressLsigAddress(this.registryAppId, address)
    return {
      label: `reverseLookup(${address}${parent ? `, ${parent}` : ""})`,
      method: "reverseLookup",
      args: (start, limit) => [this.registryAppId, address, lsig, parent, start, limit, o],
      limit: REVERSE_PAGE,
    }
  }

  private ownedSpecs(address: string, apps: bigint[], asas: bigint[], parent: bigint, o: bigint): CallSpec[] {
    const candidates = [...apps.map((id) => ({ app: true, id })), ...asas.map((id) => ({ app: false, id }))]
    const specs: CallSpec[] = []
    for (let at = 0; at < candidates.length; at += OWNED_PAGE) {
      const chunk = candidates.slice(at, at + OWNED_PAGE)
      const packedApps = packIds(chunk.filter((c) => c.app).map((c) => c.id))
      const packedAsas = packIds(chunk.filter((c) => !c.app).map((c) => c.id))
      specs.push({
        label: `ownedBy(${address}${parent ? `, ${parent}` : ""})`,
        method: "ownedBy",
        args: (start, limit) => [this.registryAppId, address, packedApps, packedAsas, parent, start, limit, o],
        limit: OWNED_PAGE,
      })
    }
    return specs
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Reading

  /** Reads one call per item at the read's round, each through the cache and the batcher. */
  private async readEach<K>(
    opts: ReadOpts,
    keys: K[],
    keyOf: (key: K) => string,
    spec: (key: K, o: bigint) => CallSpec,
  ): Promise<NfdRecord[][]> {
    const { signal } = opts
    return abortable(signal, async () => {
      const round = await this.roundFor(opts)
      await this.ensureSupported(signal)
      const o = await this.opts(opts.fields)
      return Promise.all(
        keys.map((key) =>
          this.shared.cache.read(
            this.cacheKey(round, opts.fields, keyOf(key)),
            round === undefined,
            async (shared) => unwrap((await this.shared.batcher.call(round, spec(key, o), shared)).outcome),
            signal,
          ),
        ),
      )
    })
  }

  /** `getOwned` (parent 0) and `getSegmentsFor`. */
  private async ownership(address: string, parent: bigint, opts: ReadOpts): Promise<NfdRecord[]> {
    algosdk.decodeAddress(address)
    const { signal } = opts
    return abortable(signal, async () => {
      const pinned = await this.roundFor(opts)
      await this.ensureSupported(signal)
      // the REST reads and the query must see the same round
      const round = pinned ?? (await this.lastRound(signal, STATUS_MAX_AGE_MS))
      const o = await this.opts(opts.fields)
      const key = this.cacheKey(pinned, opts.fields, parent ? `s|${address}|${parent}` : `o|${address}`)
      return this.shared.cache.read(
        key,
        pinned === undefined,
        async (shared) => {
          const { apps, asas } = await this.ownedCandidates(address, round, shared)
          const specs = this.ownedSpecs(address, apps, asas, parent, o)
          if (parent) specs.unshift(this.reverseSpec(address, parent, o))
          const results = await Promise.all(specs.map((spec) => this.shared.batcher.call(round, spec, shared)))
          return dedupe(results.flatMap((r) => unwrap(r.outcome)))
        },
        signal,
      )
    })
  }

  /** The candidates for `address`'s NFDs at `round`: its `"O"` owner boxes in the registry, and the NFD assets it holds. */
  private async ownedCandidates(
    address: string,
    round: bigint,
    signal?: AbortSignal,
  ): Promise<{ apps: bigint[]; asas: bigint[] }> {
    const DT = (algosdk as unknown as { DTAlgodClient?: { from(algod: algosdk.Algodv2): DTAlgod } }).DTAlgodClient
    if (!DT) throw new NfdQueryUnavailableError("algosdk is not the dtalgorand fork")
    const algod = DT.from(this.algorand.client.algod)
    const fetchOpts = signal ? { signal } : undefined
    const publicKey = algosdk.decodeAddress(address).publicKey

    const ownerBoxes = async () => {
      const apps: bigint[] = []
      const prefix = concatBytes(textEncoder.encode("O"), publicKey)
      let next: string | undefined
      do {
        const request = algod.getApplicationBoxes(this.registryAppId).prefix(prefix).round(round).limit(1000)
        if (next) request.next(next)
        const page = await request.do(undefined, fetchOpts)
        for (const box of page.boxes) {
          if (box.name.length !== 41) continue
          apps.push(new DataView(box.name.buffer, box.name.byteOffset, box.name.byteLength).getBigUint64(33))
        }
        next = page.nextToken
      } while (next)
      return apps
    }

    const nfdAssets = async () => {
      const asas: bigint[] = []
      let next: string | undefined
      try {
        do {
          const request = algod.accountAssetsInformation(address).round(round).limit(1000)
          if (next) request.next(next)
          const page = await request.do(undefined, fetchOpts)
          for (const holding of page.assetHoldings ?? []) {
            if (holding.assetHolding.amount === 0n || holding.assetHolding.amount === 0) continue
            if (holding.assetParams?.unitName !== "NFD") continue
            asas.push(BigInt(holding.assetHolding.assetId))
          }
          next = page.nextToken
        } while (next)
      } catch (e) {
        // an account that doesn't exist at the round holds nothing
        if ((e as { status?: number }).status === 404) return asas
        throw e
      }
      return asas
    }

    let apps: bigint[], asas: bigint[]
    try {
      ;[apps, asas] = await Promise.all([ownerBoxes(), nfdAssets()])
    } catch (e) {
      // these REST reads pin a round, which needs time travel on the node even for the latest one
      if ((e as { name?: string }).name === "DTUnsupportedError")
        throw new NfdQueryUnavailableError(`owner reads need a node with time travel: ${(e as Error).message}`)
      throw e
    }
    return { apps: [...new Set(apps)], asas: [...new Set(asas)] }
  }

  /** Each key's value at each round, in as few queries as the node allows. */
  private async series<K, V>(
    keys: K[],
    rounds: SeriesRounds,
    opts: Omit<ReadOpts, "round"> & { maxPoints?: number },
    keyOf: (key: K) => string,
    spec: (key: K, o: bigint) => CallSpec,
    valueOf: (records: NfdRecord[]) => V,
  ): Promise<SeriesPoint<Map<K, V>>[]> {
    const { signal } = opts
    const list = seriesRounds(rounds, opts.maxPoints)
    return abortable(signal, async () => {
      await this.ensureSupported(signal)
      const o = await this.opts(opts.fields)
      const checks = await Promise.all(
        list.map((round) =>
          this.roundFor({ round }).then(
            () => undefined,
            (error: Error) => error,
          ),
        ),
      )
      const valid = list.filter((_, i) => !checks[i])
      const results = valid.length
        ? await this.shared.engine.run(
            keys.map((key) => spec(key, o)),
            valid,
            signal,
          )
        : []
      const byRound = new Map(results.map((r) => [r.round, r]))
      return list.map((round, i): SeriesPoint<Map<K, V>> => {
        const invalid = checks[i]
        if (invalid) return { round, ok: false, error: invalid }
        const result = byRound.get(round)!
        const failed = result.outcomes.find((outcome) => !outcome.ok)
        if (failed && !failed.ok) return { round, ok: false, error: failed.error }
        const value = new Map<K, V>()
        keys.forEach((key, k) => {
          const records = (result.outcomes[k] as { records: NfdRecord[] }).records
          this.shared.cache.put(this.cacheKey(round, opts.fields, keyOf(key)), records, false)
          value.set(key, valueOf(records))
        })
        return { round, ok: true, value }
      })
    })
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Rounds, support and options

  /** The round a read is at (undefined: the latest), after checking it is one NFDs can be read at. */
  private async roundFor(opts: ReadOpts): Promise<bigint | undefined> {
    const value = opts.round ?? this.round
    if (value === undefined) return undefined
    const round = BigInt(value)
    const creation = await this.getRegistryCreationRound()
    if (creation !== undefined && round < creation) throw new NfdNotDeployedError(round, creation)
    const known = this.shared.latest?.round
    if (known === undefined || round > known) {
      // past the tip we know: ask the node, whatever the age of that tip, so a round it has just made isn't refused
      let last = await this.lastRound(opts.signal, 0)
      // that answer may come from a status read already in flight when the caller learned of the round: ask once more
      if (round > last) last = await this.lastRound(opts.signal, 0)
      if (round > last) throw new FutureRoundError(round, last)
    }
    return round
  }

  /**
   * The node's latest round: the last one read if it is at most `maxAgeMs` old (by default, whatever its age), else from
   * the node, sharing a status read in flight.
   */
  private async lastRound(signal?: AbortSignal, maxAgeMs = Number.POSITIVE_INFINITY): Promise<bigint> {
    const latest = this.shared.latest
    if (latest && Date.now() - latest.at <= maxAgeMs) return latest.round
    if (!this.shared.statusRead) {
      const read = this.algorand.client.algod
        .status()
        .do()
        .then((status) => {
          const round = BigInt(status.lastRound)
          if (!this.shared.latest || round >= this.shared.latest.round) this.shared.latest = { round, at: Date.now() }
          return round
        })
        .finally(() => {
          if (this.shared.statusRead === read) this.shared.statusRead = undefined
        })
      this.shared.statusRead = read
    }
    return raceAbort(this.shared.statusRead, signal)
  }

  private support(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.shared.supported) {
      const check = this.probe()
      check.catch(() => {
        if (this.shared.supported === check) this.shared.supported = undefined
      })
      this.shared.supported = check
    }
    return this.shared.supported
  }

  private async probe(): Promise<{ ok: boolean; reason?: string }> {
    const query = (this.algorand as unknown as { query?: { supported(): Promise<boolean> } }).query
    if (!query) return { ok: false, reason: "algokit-utils is not the dtalgorand fork (no algorand.query)" }
    if (!(await query.supported())) return { ok: false, reason: "the node or algosdk has no read-only queries" }
    const o = await this.opts([])
    let result
    try {
      ;[result] = await this.shared.engine.run([this.nameSpec(PROBE_NAME, o)], undefined)
    } catch (e) {
      const name = (e as { name?: string }).name
      if (name === "DTUnsupportedError" || name === "DTNotAvailableError") return { ok: false, reason: String(e) }
      throw e
    }
    const outcome = result.outcomes[0]
    if (outcome.ok) return { ok: true }
    if (/box/i.test(outcome.error.message))
      return { ok: false, reason: `no foreign box reads: ${outcome.error.message}` }
    throw outcome.error
  }

  private async ensureSupported(signal?: AbortSignal): Promise<void> {
    const support = await raceAbort(this.support(), signal)
    if (!support.ok) throw new NfdQueryUnavailableError(support.reason ?? "unsupported")
  }

  /** The most bytes a call may log, from the node's query limits. */
  private logBudget(): Promise<number> {
    if (!this.shared.logBudget) {
      const query = (
        this.algorand as unknown as { query?: { limits(): Promise<{ maxCallLogBytes: number } | undefined> } }
      ).query
      const read = (query ? query.limits() : Promise.resolve(undefined)).then((limits) => {
        const bytes = limits?.maxCallLogBytes || PROTOCOL_LOG_BYTES
        return Math.max(0, bytes - LOG_MARGIN)
      })
      read.catch(() => {
        if (this.shared.logBudget === read) this.shared.logBudget = undefined
      })
      this.shared.logBudget = read
    }
    return this.shared.logBudget
  }

  private async opts(fields: readonly NfdField[] = DEFAULT_FIELDS): Promise<bigint> {
    return encodeOpts(fields, this.maxCaAlgo, await this.logBudget())
  }

  private cacheKey(round: bigint | undefined, fields: readonly NfdField[] = DEFAULT_FIELDS, key: string): string {
    return `${round ?? "latest"}|${[...fields].sort().join(",")}|${key}`
  }
}

/** The parts of the dtalgorand fork's `DTAlgodClient` the SDK uses. */
type DTAlgod = {
  getApplicationBoxes(appId: bigint): {
    prefix(prefix: Uint8Array): DTAlgodBoxes
  }
  accountAssetsInformation(address: string): {
    round(round: bigint): DTAlgodAssets
  }
}
type DTAlgodBoxes = {
  round(round: bigint): DTAlgodBoxes
  limit(limit: number): DTAlgodBoxes
  next(next: string): DTAlgodBoxes
  do(
    headers?: Record<string, string>,
    options?: { signal: AbortSignal },
  ): Promise<{ boxes: { name: Uint8Array }[]; nextToken?: string }>
}
type DTAlgodAssets = {
  limit(limit: number): DTAlgodAssets
  next(next: string): DTAlgodAssets
  do(
    headers?: Record<string, string>,
    options?: { signal: AbortSignal },
  ): Promise<{
    assetHoldings?: {
      assetHolding: { amount: number | bigint; assetId: number | bigint }
      assetParams?: { unitName?: string }
    }[]
    nextToken?: string
  }>
}
