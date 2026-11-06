import { describe, expect, it } from "vitest"
import { ABIType } from "algosdk"
import { addressLsigAddress, nameLsigAddress, uvarint, lookupLsigProgram } from "../src/lsig.js"
import { decodeRecord, encodeOpts, parseLogs } from "../src/reader.js"
import { seriesRounds } from "../src/series.js"
import { QueryEngine, requestCount, type CallSpec } from "../src/engine.js"
import { packPairs } from "../src/sdk.js"

const REG = 760937186n

describe("v1 lookup lsigs", () => {
  it("derives the reverse lsig of 818.algo's owner (DESIGN-v2 2.1)", () => {
    expect(addressLsigAddress(REG, "43H6L4VKWP23F3UO64GUS4M5TFT5MOZRJPUFO57M3X2SDONQXJCT5MQZRE")).toBe(
      "BE3YV7YS6HPJYO676GBDU4ARBIOT7R4TTZRBGZC7XHJPGUOKE6PK6SMSQA",
    )
  })
  it("derives a name lsig", () => {
    expect(nameLsigAddress(REG, "king.dragonfi.algo")).toBe(
      "FPUYLUPCJPENUVCTLD5DQL5BGHWUJLM6OSVL2HMJFED7YGVV5E3TNHDN2Y",
    )
  })
  it("puts the registry id at bytes 6–13 and a 1-byte length for a 66-byte reverse suffix", () => {
    const program = lookupLsigProgram(84366825n, new Uint8Array(66))
    expect(new DataView(program.buffer).getBigUint64(6)).toBe(84366825n)
    expect(program[47]).toBe(66)
    expect(program.length).toBe(47 + 1 + 66)
  })
  it("encodes uvarints as Go's PutUvarint", () => {
    expect([...uvarint(0)]).toEqual([0])
    expect([...uvarint(127)]).toEqual([127])
    expect([...uvarint(128)]).toEqual([0x80, 0x01])
    expect([...uvarint(300)]).toEqual([0xac, 0x02])
  })
  it("rejects an address with a bad checksum", () => {
    expect(() => addressLsigAddress(REG, "43H6L4VKWP23F3UO64GUS4M5TFT5MOZRJPUFO57M3X2SDONQXJCT5MQZRA")).toThrow()
  })
})

describe("reader encoding", () => {
  it("packs fields, the caAlgo cap and the log budget", () => {
    expect(encodeOpts(["caAlgo", "avatar", "bio"], 40, 65_000)).toBe(7n | (40n << 8n) | (65_000n << 16n))
    expect(encodeOpts([], 100, 0)).toBe(40n << 8n)
    expect(() => encodeOpts(["nope" as never], 1, 1)).toThrow()
  })

  const type = ABIType.from(
    "(uint64,byte[],byte[],address,uint64,uint64,byte[],uint64,uint64,uint64,uint64,byte[],byte[],byte[],byte[])",
  )
  const zero = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ"
  const enc = (s: string) => new TextEncoder().encode(s)
  const owner = new Uint8Array(32).fill(7)

  it("decodes a record log", () => {
    const body = type.encode([
      5n,
      enc("a.algo"),
      enc("3.7"),
      zero,
      6n,
      0n,
      enc("common"),
      0n,
      1_700_000_000n,
      2n,
      1n,
      owner,
      owner,
      enc(""),
      enc("hi"),
    ])
    const [record] = parseLogs([Uint8Array.from([1, ...body])], 9n).records
    expect(record).toMatchObject({
      appId: 5n,
      name: "a.algo",
      version: "3.7",
      major: 3,
      asaId: 6n,
      parentAppId: null,
      category: "common",
      state: "expired",
      expiresAt: 1_700_000_000,
      caAlgoCount: 1,
      bio: "hi",
      round: 9n,
    })
    expect(record.avatar).toBeUndefined()
    expect(record.caAlgo).toHaveLength(1)
    expect(decodeRecord(body, 9n).name).toBe("a.algo")
  })

  it("parses the more marker", () => {
    const marker = new Uint8Array(17)
    marker[0] = 2
    new DataView(marker.buffer).setBigUint64(1, 128n)
    new DataView(marker.buffer).setBigUint64(9, 300n)
    expect(parseLogs([marker], 1n).more).toEqual({ next: 128n, total: 300n })
  })
})

describe("series rounds", () => {
  it("spreads points evenly, both ends included, deduplicated", () => {
    expect(seriesRounds({ from: 10, to: 20, points: 3 })).toEqual([10n, 15n, 20n])
    expect(seriesRounds([5, 3, 5])).toEqual([3n, 5n])
    expect(() => seriesRounds([1, 2, 3], 2)).toThrow(RangeError)
  })
})

describe("series round caps", () => {
  it("caps points at the rounds in the range before building the list", () => {
    expect(seriesRounds({ from: 1, to: 10, points: 1e9 })).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n])
    expect(() => seriesRounds({ from: 1, to: 1e12, points: 1e9 })).toThrow(RangeError)
    expect(() => seriesRounds({ from: 1, to: 10, points: Number.NaN })).toThrow(RangeError)
  })
})

/** An AlgorandClient stand-in whose `query.run` answers every call with `answer`, after `delayMs`. */
function fakeAlgorand(
  answer: (limit: bigint) => { ok: true; logs: Uint8Array[] } | { ok: false; message: string },
  delayMs = 0,
) {
  const stats = { runs: 0, inFlight: 0, maxInFlight: 0 }
  const query = {
    limits: async () => ({ maxCalls: 1, maxRounds: 64 }),
    run: async (params: { calls: { args: Uint8Array[] }[]; rounds?: bigint[] }, options: { concurrency?: number }) => {
      stats.runs++
      const share = options.concurrency ?? 4
      stats.inFlight += share
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      stats.inFlight -= share
      return (params.rounds ?? [100n]).map((round) => ({
        round,
        calls: params.calls.map((call, callIndex) => {
          // getRecord's last uint64 argument carries the page size in these tests
          const limit = new DataView(call.args[3].buffer, call.args[3].byteOffset).getBigUint64(0)
          const a = answer(limit)
          return a.ok
            ? { ok: true as const, callIndex, round, logs: a.logs, cost: 1 }
            : { ok: false as const, callIndex, round, error: { failureMessage: a.message, message: a.message } }
        }),
      }))
    },
  }
  return { algorand: { query } as never, stats }
}

const paged = (label: string): CallSpec => ({
  label,
  method: "getRecord",
  args: (_start, limit) => [1n, 2n, limit],
  limit: 128,
})

describe("query engine", () => {
  it("keeps every query's requests within one shared concurrency", async () => {
    const { algorand, stats } = fakeAlgorand(() => ({ ok: true, logs: [] }), 20)
    const engine = new QueryEngine(algorand, 4, false)
    // three queries of 4 calls each: 4 requests apiece at maxCalls 1
    const specs = [0, 1, 2, 3].map((i) => paged(`c${i}`))
    await Promise.all([engine.run(specs, undefined), engine.run(specs, [5n]), engine.run(specs, [6n])])
    expect(stats.runs).toBe(3)
    expect(stats.maxInFlight).toBeLessThanOrEqual(4)
  })

  it("leaves retries to the algod client: a busy node's error is thrown after one try", async () => {
    let runs = 0
    const busy = Object.assign(new Error("the node is busy"), { status: 503 })
    const query = {
      limits: async () => ({ maxCalls: 1024, maxRounds: 16 }),
      run: async () => {
        runs++
        throw busy
      },
    }
    await expect(new QueryEngine({ query } as never, 4, false).run([paged("busy")], undefined)).rejects.toBe(busy)
    expect(runs).toBe(1)
  })

  it("fails an ordinary call error at once, without smaller pages", async () => {
    const { algorand, stats } = fakeAlgorand(() => ({
      ok: false,
      message: "logic eval error: + overflowed. Details: pc=14",
    }))
    const [result] = await new QueryEngine(algorand, 4, false).run([paged("overflow")], undefined)
    expect(result.outcomes[0].ok).toBe(false)
    expect(stats.runs).toBe(1)
  })

  it("halves the page on the node's limit errors, down to one", async () => {
    const message = "logic eval error: dynamic cost budget exceeded, executing b: local program cost was 320000"
    const { algorand, stats } = fakeAlgorand((limit) => (limit > 16n ? { ok: false, message } : { ok: true, logs: [] }))
    const [result] = await new QueryEngine(algorand, 4, false).run([paged("budget")], undefined)
    expect(result.outcomes[0].ok).toBe(true)
    expect(stats.runs).toBe(4) // 128, 64, 32, 16
    const { algorand: always, stats: alwaysStats } = fakeAlgorand(() => ({
      ok: false,
      message: "program logs too large. 69632 bytes > 65536 bytes limit",
    }))
    const [failed] = await new QueryEngine(always, 4, false).run([paged("logs")], undefined)
    expect(failed.outcomes[0].ok).toBe(false)
    expect(alwaysStats.runs).toBe(8) // 128 … 1
  })
})

describe("request count", () => {
  it("plans requests as algokit-utils splits them", () => {
    const dt5 = { maxCalls: 1024, maxRounds: 16, maxTotalCalls: 1024 }
    expect(requestCount(1, 1, dt5)).toBe(1)
    expect(requestCount(1024, 1, dt5)).toBe(1)
    expect(requestCount(64, 16, dt5)).toBe(1)
    expect(requestCount(100, 16, dt5)).toBe(2) // 64 calls at all 16 rounds, twice (most rounds on a tie)
    expect(requestCount(1000, 16, dt5)).toBe(16)
    expect(requestCount(1, 100, dt5)).toBe(7)
    // nodes before dt5: calls times rounds is no limit
    expect(requestCount(1000, 64, { maxCalls: 1024, maxRounds: 64, maxTotalCalls: 1024 * 64 })).toBe(1)
  })
})

describe("getRecordsAt packing", () => {
  const limits = { maxCalls: 1024, maxRounds: 64 }
  const wanted = (entries: [bigint, bigint[]][]) => new Map(entries.map(([id, rounds]) => [id, new Set(rounds)]))
  const covers = (groups: { appIds: bigint[]; rounds: bigint[] }[], want: Map<bigint, Set<bigint>>) => {
    for (const [id, rounds] of want)
      for (const round of rounds)
        expect(groups.some((g) => g.appIds.includes(id) && g.rounds.includes(round))).toBe(true)
  }

  it("packs NFDs at different rounds into one query while their rounds fit", () => {
    const want = wanted([
      [1n, [10n, 20n]],
      [2n, [15n]],
      [3n, [20n, 30n]],
    ])
    const groups = packPairs(want, limits)
    expect(groups).toEqual([{ appIds: [1n, 2n, 3n], rounds: [10n, 15n, 20n, 30n] }])
  })

  it("keeps each query within the round and call limits", () => {
    const want = new Map<bigint, Set<bigint>>()
    for (let i = 0n; i < 200n; i++) want.set(i, new Set([i * 7n, i * 7n + 1n, i * 7n + 100_000n]))
    want.set(999n, new Set(Array.from({ length: 150 }, (_, i) => BigInt(i))))
    const small = { maxCalls: 16, maxRounds: 64 }
    const groups = packPairs(want, small)
    for (const g of groups) {
      expect(g.rounds.length).toBeLessThanOrEqual(64)
      expect(g.appIds.length).toBeLessThanOrEqual(16)
      expect(new Set(g.appIds).size).toBe(g.appIds.length)
    }
    covers(groups, want)
    // 750 pairs: at least 12 queries by rounds, and not many more
    expect(groups.length).toBeLessThan(60)
  })

  it("reads at most 16 times per pair asked for", () => {
    const want = new Map<bigint, Set<bigint>>([[0n, new Set(Array.from({ length: 64 }, (_, i) => BigInt(i)))]])
    for (let i = 1n; i < 1024n; i++) want.set(i, new Set([i % 64n]))
    for (let i = 2000n; i < 3000n; i++) want.set(i, new Set([i * 1000n]))
    const groups = packPairs(want, limits)
    covers(groups, want)
    for (const g of groups) {
      const pairs = g.appIds.reduce((n, id) => n + g.rounds.filter((r) => want.get(id)!.has(r)).length, 0)
      expect(g.appIds.length * g.rounds.length).toBeLessThanOrEqual(16 * pairs)
    }
  })

  it("keeps each query within the node's calls times rounds", () => {
    // :8080 on dt5: 1,024 calls, 16 rounds, but 1,024 calls times rounds
    const dt5 = { maxCalls: 1024, maxRounds: 16, maxTotalCalls: 1024 }
    const want = new Map<bigint, Set<bigint>>()
    for (let i = 0n; i < 300n; i++) want.set(i, new Set([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]))
    want.set(999n, new Set(Array.from({ length: 40 }, (_, i) => BigInt(i))))
    const groups = packPairs(want, dt5)
    covers(groups, want)
    for (const g of groups) {
      expect(g.rounds.length).toBeLessThanOrEqual(16)
      expect(g.appIds.length * g.rounds.length).toBeLessThanOrEqual(1024)
    }
    // a run of rounds is cut to the total too
    const tiny = packPairs(new Map([[1n, new Set([1n, 2n, 3n, 4n, 5n])]]), {
      maxCalls: 8,
      maxRounds: 16,
      maxTotalCalls: 2,
    })
    expect(tiny.map((g) => g.rounds.length)).toEqual([2, 2, 1])
  })

  it("puts NFDs at the same round together", () => {
    const want = new Map(Array.from({ length: 1000 }, (_, i) => [BigInt(i), new Set([5n])]))
    expect(packPairs(want, limits)).toHaveLength(1)
  })
})
