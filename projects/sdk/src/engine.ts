import type { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { NfdReadError } from "./errors.js"
import {
  encodeCall,
  parseLogs,
  READER_CLEAR_PROGRAM,
  READER_PROGRAM,
  type NfdRecord,
  type ReaderMethod,
} from "./reader.js"

/** One reader call: a lookup of one item. */
export type CallSpec = {
  /** What it reads, for errors and debug output */
  label: string
  method: ReaderMethod
  /** The call's arguments; paged methods get the range of candidates to look at */
  args: (start: bigint, limit: bigint) => unknown[]
  /** Candidates per call, for paged methods (reverse lookups, ownership checks) */
  limit?: number
}

/** What one call found at one round, across all its pages. */
export type CallOutcome = { ok: true; records: NfdRecord[] } | { ok: false; error: Error }

/** The outcomes of the calls at one round. */
export type RoundOutcomes = { round: bigint; outcomes: CallOutcome[] }

type QueryCallResult =
  | { ok: true; callIndex: number; round: bigint; logs: Uint8Array[]; cost: number }
  | { ok: false; callIndex: number; round: bigint; error: { failureMessage: string; message: string } }

/** What one `query.run` took, for debug output. */
type QueryStat = {
  /** Reader calls in it */
  calls: number
  /** Rounds it read at (1 for the latest) */
  rounds: number
  /** HTTP requests it splits into by the node's `maxCalls` and `maxRounds`, before any split of a response too large */
  http?: number
  /** Retries of a busy or failing gateway */
  retries: number
  ms: number
}

type RunStats = { started: number; queries: QueryStat[] }

type QueryLimits = { maxCalls: number; maxRounds: number }

type QueryRun = (
  params: { program: Uint8Array; clearProgram: Uint8Array; rounds?: bigint[]; calls: { args: Uint8Array[] }[] },
  options: { signal?: AbortSignal; concurrency?: number },
) => Promise<{ round: bigint; calls: QueryCallResult[] }[]>

/**
 * A call error that a smaller page may avoid, as the node words it: over the opcode budget, too large or too many logs,
 * results over the response limit, or over the time limit.
 */
const LIMIT_ERROR =
  /dynamic cost budget exceeded|program logs too large|too many log calls|query response too large|time ?out|timed out/i

/** The node's usual query limits, for a node that doesn't say */
const DEFAULT_MAX_CALLS = 1024
const DEFAULT_MAX_ROUNDS = 64

const RETRY_STATUSES = new Set([502, 503, 504])
const MAX_RETRIES = 5

function httpStatus(e: unknown): number | undefined {
  const err = e as { status?: number; response?: { status?: number } } | undefined
  return err?.status ?? err?.response?.status
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * The query requests the SDK may have in flight at once, shared by every query: each takes up to as many as it splits
 * into, at least one, waiting while none are free.
 */
class Slots {
  private free: number
  private waiting: { want: number; grant: (n: number) => void }[] = []

  constructor(size: number) {
    this.free = Math.max(1, Math.floor(size))
  }

  take(want: number, signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted()
    want = Math.max(1, want)
    if (this.free > 0 && this.waiting.length === 0) return Promise.resolve(this.grab(want))
    return new Promise((resolve, reject) => {
      const waiter = {
        want,
        grant: (n: number) => {
          signal?.removeEventListener("abort", onAbort)
          resolve(n)
        },
      }
      const onAbort = () => {
        this.waiting.splice(this.waiting.indexOf(waiter), 1)
        reject(signal!.reason)
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.waiting.push(waiter)
    })
  }

  give(n: number): void {
    this.free += n
    while (this.free > 0 && this.waiting.length > 0) {
      const waiter = this.waiting.shift()!
      waiter.grant(this.grab(waiter.want))
    }
  }

  private grab(want: number): number {
    const n = Math.min(want, this.free)
    this.free -= n
    return n
  }
}

/** A call still to run: which call, at which round, from which candidate, and what it found so far. */
type Job = {
  spec: number
  roundIndex: number
  start: bigint
  limit: bigint
  records: NfdRecord[]
  outcome?: CallOutcome
}

/**
 * Runs reader calls through dtalgod's read-only queries: every call at every round in one `query.run` (split into
 * requests by the node's limits), then follow-up requests for the calls that stopped early (more candidates than one
 * call looks at, or more output than its log budget) or went over a limit with too many candidates.
 */
export class QueryEngine {
  private limits?: Promise<QueryLimits | undefined>
  private readonly slots: Slots

  constructor(
    private readonly algorand: AlgorandClient,
    private readonly concurrency: number,
    private readonly debug: boolean,
  ) {
    this.slots = new Slots(concurrency)
  }

  private get queryRun(): QueryRun {
    const query = (this.algorand as unknown as { query?: { run: QueryRun } }).query
    if (!query) throw new Error("algorand.query is missing: use the dtalgorand fork of algokit-utils")
    return query.run.bind(query)
  }

  /**
   * Runs `specs` at each of `rounds`, or once at the latest round when `rounds` is undefined. Returns the outcomes per
   * round, in the order of `rounds` (the latest round resolved to its number).
   */
  async run(specs: CallSpec[], rounds: bigint[] | undefined, signal?: AbortSignal): Promise<RoundOutcomes[]> {
    if (specs.length === 0) return (rounds ?? []).map((round) => ({ round, outcomes: [] }))
    const stats: RunStats | undefined = this.debug ? { started: Date.now(), queries: [] } : undefined
    try {
      const results = await this.runCalls(specs, rounds, signal, stats)
      if (stats) this.logRun(specs, rounds, stats, { results })
      return results
    } catch (e) {
      if (stats) this.logRun(specs, rounds, stats, { error: e })
      throw e
    }
  }

  private async runCalls(
    specs: CallSpec[],
    rounds: bigint[] | undefined,
    signal: AbortSignal | undefined,
    stats: RunStats | undefined,
  ): Promise<RoundOutcomes[]> {
    // first pass: every call at every round
    const first = await this.request(
      specs.map((spec) => this.encode(spec, 0n, BigInt(spec.limit ?? 0))),
      rounds,
      signal,
      stats,
    )
    const resolved = first.map((r) => r.round)
    const jobs: Job[][] = first.map((r, roundIndex) =>
      specs.map((spec, i) => {
        const job: Job = { spec: i, roundIndex, start: 0n, limit: BigInt(spec.limit ?? 0), records: [] }
        this.settle(job, specs[i], r.calls[i], r.round)
        return job
      }),
    )

    // follow-ups, one round at a time: every unfinished call of the round in one request
    for (;;) {
      const pending = jobs.flat().filter((job) => !job.outcome)
      if (pending.length === 0) break
      const byRound = new Map<number, Job[]>()
      for (const job of pending) byRound.set(job.roundIndex, [...(byRound.get(job.roundIndex) ?? []), job])
      for (const [roundIndex, roundJobs] of byRound) {
        const round = resolved[roundIndex]
        const [result] = await this.request(
          roundJobs.map((job) => this.encode(specs[job.spec], job.start, job.limit)),
          [round],
          signal,
          stats,
        )
        roundJobs.forEach((job, i) => this.settle(job, specs[job.spec], result.calls[i], round))
      }
    }

    return jobs.map((roundJobs, roundIndex) => ({
      round: resolved[roundIndex],
      outcomes: roundJobs.map((job) => job.outcome!),
    }))
  }

  private encode(spec: CallSpec, start: bigint, limit: bigint): { args: Uint8Array[] } {
    return { args: encodeCall(spec.method, spec.args(start, limit)) }
  }

  /** Takes a call's result: records it, schedules its next page or a retry with a smaller page, or ends it. */
  private settle(job: Job, spec: CallSpec, call: QueryCallResult | undefined, round: bigint): void {
    if (!call) {
      job.outcome = { ok: false, error: new NfdReadError(spec.label, round, "the node returned no result") }
      return
    }
    if (!call.ok) {
      const message = call.error.failureMessage || call.error.message
      if (spec.limit !== undefined && job.limit > 1n && LIMIT_ERROR.test(message)) {
        job.limit = job.limit / 2n
        if (this.debug)
          console.debug(`nfd-ghost-sdk: ${spec.label} at ${round}: ${message}; retrying ${job.limit} at a time`)
        return
      }
      job.outcome = { ok: false, error: new NfdReadError(spec.label, round, message) }
      return
    }
    const parsed = parseLogs(call.logs, round)
    job.records.push(...parsed.records)
    if (parsed.more && parsed.more.next > job.start) {
      job.start = parsed.more.next
      return
    }
    job.outcome = { ok: true, records: job.records }
  }

  /** One `query.run`, within the SDK's share of requests in flight, retrying a busy or failing gateway with backoff. */
  private async request(
    calls: { args: Uint8Array[] }[],
    rounds: bigint[] | undefined,
    signal: AbortSignal | undefined,
    stats: RunStats | undefined,
  ): Promise<{ round: bigint; calls: QueryCallResult[] }[]> {
    // the fork reads the node's limits once per client too, so this costs a request only the first time
    const limits = await this.queryLimits()
    const roundCount = rounds?.length ?? 1
    const http = limits && Math.ceil(calls.length / limits.maxCalls) * Math.ceil(roundCount / limits.maxRounds)
    const stat: QueryStat | undefined = stats && { calls: calls.length, rounds: roundCount, http, retries: 0, ms: 0 }
    if (stat) stats!.queries.push(stat)
    const slots = await this.slots.take(http ?? this.concurrency, signal)
    const started = Date.now()
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const results = await this.queryRun(
            {
              program: READER_PROGRAM,
              clearProgram: READER_CLEAR_PROGRAM,
              ...(rounds ? { rounds } : {}),
              calls,
            },
            { concurrency: slots, ...(signal ? { signal } : {}) },
          )
          if (stat) stat.ms = Date.now() - started
          return results
        } catch (e) {
          if (stat) stat.ms = Date.now() - started
          signal?.throwIfAborted()
          const status = httpStatus(e)
          if (status === undefined || !RETRY_STATUSES.has(status) || attempt >= MAX_RETRIES) throw e
          if (stat) stat.retries++
          await sleep(Math.min(250 * 2 ** attempt, 4000), signal)
        }
      }
    } finally {
      this.slots.give(slots)
    }
  }

  /** The most calls and rounds one HTTP request takes: the node's query limits, else the usual 1,024 and 64. */
  async requestLimits(): Promise<QueryLimits> {
    const limits = await this.queryLimits()
    return { maxCalls: limits?.maxCalls || DEFAULT_MAX_CALLS, maxRounds: limits?.maxRounds || DEFAULT_MAX_ROUNDS }
  }

  /** The node's query limits, read once: how many requests a query splits into. */
  private queryLimits(): Promise<QueryLimits | undefined> {
    if (!this.limits) {
      const query = (this.algorand as unknown as { query?: { limits?(): Promise<QueryLimits | undefined> } }).query
      this.limits = query?.limits ? query.limits().catch(() => undefined) : Promise.resolve(undefined)
    }
    return this.limits
  }

  /**
   * Logs a run: its calls by method, where it read, its `query.run`s and the HTTP requests they split into, what it
   * found by NFD major version, and how long each took. The details carry every call's label and each query's numbers.
   */
  private logRun(
    specs: CallSpec[],
    rounds: bigint[] | undefined,
    stats: RunStats,
    end: { results: RoundOutcomes[] } | { error: unknown },
  ): void {
    const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
    const counts = (keys: string[]) => {
      const map = new Map<string, number>()
      for (const key of keys) map.set(key, (map.get(key) ?? 0) + 1)
      return [...map].map(([key, n]) => `${key} ${n}`).join(", ")
    }
    const results = "results" in end ? end.results : undefined
    const at = rounds
      ? rounds.length === 1
        ? `round ${rounds[0]}`
        : `${rounds.length} rounds`
      : `latest${results?.[0] ? ` (${results[0].round})` : ""}`
    const httpTotal = stats.queries.every((q) => q.http !== undefined)
      ? stats.queries.reduce((n, q) => n + q.http!, 0)
      : undefined
    const http = httpTotal === undefined ? "" : `, ${plural(httpTotal, "HTTP request")}`
    const retries = stats.queries.reduce((n, q) => n + q.retries, 0)
    let outcome: string
    if (results) {
      const outcomes = results.flatMap((r) => r.outcomes)
      const versions = counts(outcomes.flatMap((o) => (o.ok ? o.records.map((r) => `v${r.major}`) : [])))
      const none = outcomes.filter((o) => o.ok && o.records.length === 0).length
      const failed = outcomes.filter((o) => !o.ok).length
      outcome = [versions || "no records", none && `${none} empty`, failed && `${failed} failed`]
        .filter(Boolean)
        .join(", ")
    } else {
      const { error } = end as { error: unknown }
      outcome = `failed: ${error instanceof Error ? error.message : String(error)}`
    }
    console.debug(
      `nfd-ghost-sdk: ${plural(specs.length, "arg")} (${counts(specs.map((s) => s.method))}) at ${at}: ` +
        `${plural(stats.queries.length, "query", "queries")}${http}${retries ? `, ${plural(retries, "retry", "retries")}` : ""}; ` +
        `${outcome}; ${Date.now() - stats.started} ms (${stats.queries.map((q) => q.ms).join(" + ")})`,
      { args: specs.map((s) => s.label), queries: stats.queries },
    )
  }
}
