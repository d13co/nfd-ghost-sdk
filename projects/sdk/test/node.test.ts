// Integration tests against a MainNet dtalgod with queries and foreign box reads (the local query node by default:
// ALGOD_SERVER / ALGOD_PORT / ALGOD_TOKEN). Skipped when the node can't be reached.
import { beforeAll, describe, expect, it, vi } from "vitest"
import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { NfdGhostSDK } from "../src/index.js"
import { QueryEngine, type CallSpec } from "../src/engine.js"
import { encodeOpts } from "../src/reader.js"

const algodConfig = {
  server: process.env.ALGOD_SERVER ?? "http://127.0.0.1",
  port: process.env.ALGOD_PORT ?? 8080,
  token: process.env.ALGOD_TOKEN ?? "",
}
const REG = 760937186n
const OWNER_818 = "43H6L4VKWP23F3UO64GUS4M5TFT5MOZRJPUFO57M3X2SDONQXJCT5MQZRE"
const KING = 1013764620n

const reachable = await fetch(`${algodConfig.server}:${algodConfig.port}/health`).then(
  (r) => r.ok,
  () => false,
)

/** An AlgorandClient whose query requests are counted. */
function counted() {
  const algorand = AlgorandClient.fromConfig({ algodConfig })
  const query = (algorand as any).query
  const run = query.run.bind(query)
  const counter = { requests: 0 }
  query.run = (...args: unknown[]) => {
    counter.requests++
    return run(...args)
  }
  return { algorand, counter }
}

describe.skipIf(!reachable)("on a query node", () => {
  let sdk: NfdGhostSDK
  beforeAll(() => {
    sdk = new NfdGhostSDK({ algorand: AlgorandClient.fromConfig({ algodConfig }), registryAppId: REG })
  })

  it("is supported", async () => {
    expect(await sdk.supported()).toBe(true)
  })

  it("coalesces reads made in the same tick into one query", async () => {
    const { algorand, counter } = counted()
    const fresh = new NfdGhostSDK({ algorand, registryAppId: REG })
    await fresh.prefetch()
    counter.requests = 0
    const ids = [KING, 864806088n, 2318360299n, 3296744483n]
    const [a, b, c] = await Promise.all([
      ...ids.map((id) => fresh.getRecord(id, { round: 60_000_000n })),
      fresh.resolveName("818.algo", { round: 60_000_000n }),
      fresh.reverseLookup([OWNER_818], { round: 60_000_000n }),
    ])
    expect(a?.name).toBe("king.dragonfi.algo")
    expect(b?.name).toBe("818.algo")
    expect(c).toBeTruthy()
    expect(counter.requests).toBe(1)
    // cached: no more requests
    await fresh.getRecord(KING, { round: 60_000_000n })
    expect(counter.requests).toBe(1)
  })

  it("pages: small pages and a small log budget give the same records as one call", async () => {
    const engine = new QueryEngine(AlgorandClient.fromConfig({ algodConfig }), 4, false)
    const owner = await sdk.getOwned(OWNER_818, { round: 60_000_000n })
    const apps = owner.map((r) => r.appId)
    const packed = new Uint8Array(apps.length * 8)
    apps.forEach((id, i) => new DataView(packed.buffer).setBigUint64(i * 8, id))
    const spec = (limit: number, budget: number): CallSpec => ({
      label: "ownedBy",
      method: "ownedBy",
      args: (start, l) => [
        REG,
        OWNER_818,
        packed,
        new Uint8Array(),
        0n,
        start,
        l,
        encodeOpts(["caAlgo", "avatar", "bio"], 40, budget),
      ],
      limit,
    })
    const [whole] = await engine.run([spec(256, 60_000)], [60_000_000n])
    const [paged] = await engine.run([spec(7, 60_000), spec(256, 1_500)], [60_000_000n])
    const names = (o: any) => o.records.map((r: any) => r.name).sort()
    expect(whole.outcomes[0].ok).toBe(true)
    expect(names(paged.outcomes[0])).toEqual(names(whole.outcomes[0]))
    expect(names(paged.outcomes[1])).toEqual(names(whole.outcomes[0]))
    expect(names(whole.outcomes[0])).toHaveLength(apps.length)
  })

  it("aborts with the caller's reason, and the shared read carries on for others", async () => {
    const fresh = new NfdGhostSDK({ algorand: AlgorandClient.fromConfig({ algodConfig }), registryAppId: REG })
    await fresh.prefetch()
    const controller = new AbortController()
    const aborted = fresh.getRecord(KING, { round: 55_000_000n, signal: controller.signal })
    const other = fresh.getRecord(KING, { round: 55_000_000n })
    controller.abort(new Error("stop"))
    await expect(aborted).rejects.toThrow("stop")
    expect((await other)?.name).toBe("king.dragonfi.algo")
    const already = new AbortController()
    already.abort()
    await expect(fresh.getRecord(KING, { signal: already.signal })).rejects.toThrow()
  })

  it("gives series points equal to single-round reads", async () => {
    const rounds = [25_000_000n, 33_000_000n, 40_000_000n, 50_000_000n]
    const series = await sdk.reverseLookupSeries(
      ["22T47MKF2YHPJVOJN4PKSAD5EPRBWWL4VZ4G6I6XIDFI5FS7OZYYY3PPWU", OWNER_818],
      rounds,
    )
    const fresh = new NfdGhostSDK({
      algorand: AlgorandClient.fromConfig({ algodConfig }),
      registryAppId: REG,
      cacheEntries: 0,
    })
    for (const point of series) {
      expect(point.ok).toBe(true)
      if (!point.ok) continue
      const single = await fresh.reverseLookup([...point.value.keys()], { round: point.round })
      expect(single).toEqual(point.value)
    }
  })

  it("marks rounds out of range as failed points", async () => {
    const series = await sdk.getRecordsSeries([KING], [1_000n, 40_000_000n])
    expect(series[0]).toMatchObject({ ok: false })
    expect(series[1]).toMatchObject({ ok: true })
  })

  it("reads each NFD at its own rounds, as single reads do", async () => {
    const pairs = [
      { appId: KING, round: 40_000_000n },
      { appId: 864806088n, round: 30_000_000n },
      { appId: 2318360299n, round: 60_000_000n },
      { appId: KING, round: 60_000_000n },
      { appId: 3296744483n, round: 62_000_000n },
      { appId: KING, round: 40_000_000n },
      { appId: 864806088n, round: 1_000n },
    ]
    const { algorand, counter } = counted()
    const fresh = new NfdGhostSDK({ algorand, registryAppId: REG })
    await fresh.prefetch()
    counter.requests = 0
    const records = await fresh.getRecordsAt(pairs, { fields: [] })
    expect(counter.requests).toBe(1)
    expect(records).toHaveLength(pairs.length)
    expect(records[6]).toBeNull()
    expect(records[0]).toEqual(records[5])
    const single = new NfdGhostSDK({ algorand: AlgorandClient.fromConfig({ algodConfig }), registryAppId: REG })
    for (const [i, { appId, round }] of pairs.entries()) {
      if (i === 6) continue
      expect(records[i]).toEqual(await single.getRecord(appId, { round, fields: [] }))
      if (records[i]) expect(records[i]!.round).toBe(round)
    }
    // read again: from the cache
    await fresh.getRecordsAt(pairs.slice(0, 3), { fields: [] })
    expect(counter.requests).toBe(1)
    const tip = BigInt((await algorand.client.algod.status().do()).lastRound)
    await expect(fresh.getRecordsAt([{ appId: KING, round: tip + 1_000n }])).rejects.toThrow(/round/i)
  })

  it("finds segments linked or owned, with Réti's rule", async () => {
    const king = (await sdk.getRecord(KING))!
    const segments = await sdk.getSegmentsFor(king.owner, king.parentAppId!)
    expect(segments.map((s) => s.appId)).toContain(KING)
    expect(segments.every((s) => s.parentAppId === king.parentAppId)).toBe(true)
    expect(await sdk.getSegmentsFor(OWNER_818, king.parentAppId!, { round: 30_000_000n })).toEqual([])
  })

  it("counts the HTTP requests a query splits into as algokit-utils sends them", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
    const fetch = globalThis.fetch
    let posts = 0
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input instanceof Request ? input.url : input).includes("/v2/query")) posts++
      return fetch(input, init)
    }) as typeof fetch
    try {
      const logged = new NfdGhostSDK({
        algorand: AlgorandClient.fromConfig({ algodConfig }),
        registryAppId: REG,
        debug: true,
      })
      await logged.prefetch()
      debug.mockClear()
      posts = 0
      // 100 NFDs at 17 rounds: more than one request on any node's default limits
      const ids = Array.from({ length: 100 }, (_, i) => KING + BigInt(i))
      await logged.getRecordsSeries(ids, { from: 60_000_000n, to: 62_000_000n, points: 17 }, { fields: [] })
      const [, details] = debug.mock.calls.at(-1) as [string, { queries: { http?: number }[] }]
      const http = details.queries.reduce((n, q) => n + q.http!, 0)
      expect(posts).toBeGreaterThan(1)
      expect(http).toBe(posts)
    } finally {
      globalThis.fetch = fetch
      debug.mockRestore()
    }
  })

  it("logs each query's args, requests, versions and timings with debug", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
    try {
      const logged = new NfdGhostSDK({
        algorand: AlgorandClient.fromConfig({ algodConfig }),
        registryAppId: REG,
        debug: true,
      })
      await logged.prefetch()
      debug.mockClear()
      await Promise.all([logged.getRecord(KING), logged.resolveName("nfd-ghost-sdk-missing-0.algo")])
      expect(debug).toHaveBeenCalledTimes(1)
      const [line, details] = debug.mock.calls[0] as [string, { args: string[]; queries: { calls: number }[] }]
      expect(line).toMatch(
        /^nfd-ghost-sdk: 2 args \(getRecord 1, resolveName 1\) at latest \(\d+\): 1 query, 1 HTTP request; v2 1, 1 empty; \d+ ms \(\d+\)$/,
      )
      expect(details.args).toEqual([`getRecord(${KING})`, "resolveName(nfd-ghost-sdk-missing-0.algo)"])
      expect(details.queries).toMatchObject([{ calls: 2, rounds: 1, http: 1 }])
    } finally {
      debug.mockRestore()
    }
  })

  it("maps an NFD asset with a name cut to 32 bytes to its app", async () => {
    // key2manifestation.blockcycle.algo: its asset is named key2manifestation.blockcy...algo
    const app = 2569170783n
    const record = (await sdk.getRecord(app, { fields: [] }))!
    expect(record.name).toBe("key2manifestation.blockcycle.algo")
    const asas = new Uint8Array(8)
    new DataView(asas.buffer).setBigUint64(0, record.asaId)
    const engine = new QueryEngine(AlgorandClient.fromConfig({ algodConfig }), 4, false)
    const [result] = await engine.run(
      [
        {
          label: "ownedBy",
          method: "ownedBy",
          args: (start, limit) => [
            REG,
            record.owner,
            new Uint8Array(0),
            asas,
            0n,
            start,
            limit,
            encodeOpts([], 0, 60_000),
          ],
          limit: 128,
        },
      ],
      [record.round],
    )
    expect(result.outcomes[0]).toMatchObject({ ok: true, records: [{ appId: app }] })
  })

  it("reads a round the node has only just made", async () => {
    const fresh = new NfdGhostSDK({ algorand: AlgorandClient.fromConfig({ algodConfig }), registryAppId: REG })
    // a read at a past round makes the SDK learn the tip
    await fresh.getRecord(KING, { round: 60_000_000n })
    const algod = AlgorandClient.fromConfig({ algodConfig }).client.algod
    const known = BigInt((await algod.status().do()).lastRound)
    let next = known
    while (next <= known) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      next = BigInt((await algod.status().do()).lastRound)
    }
    // however recent the tip the SDK learnt, a later round is checked with the node, not refused
    const now = Date.now()
    const clock = vi.spyOn(Date, "now").mockReturnValue(now)
    try {
      expect((await fresh.getRecord(KING, { round: next }))?.round).toBe(next)
    } finally {
      clock.mockRestore()
    }
  }, 20_000)

  it("throws NfdQueryUnavailableError without the fork's query", async () => {
    const algorand = AlgorandClient.fromConfig({ algodConfig })
    Object.defineProperty(algorand, "query", { value: undefined })
    const plain = new NfdGhostSDK({ algorand, registryAppId: REG })
    expect(await plain.supported()).toBe(false)
    await expect(plain.getRecord(KING)).rejects.toThrow(/NFD reads need/)
  })
})
