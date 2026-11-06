import type { CallOutcome, CallSpec, QueryEngine } from "./engine.js"

type Item = {
  spec: CallSpec
  signal?: AbortSignal
  resolve: (value: { round: bigint; outcome: CallOutcome }) => void
  reject: (error: unknown) => void
  done: boolean
}

type Batch = { round: bigint | undefined; items: Item[] }

/**
 * Coalesces reader calls made within `windowMs` of each other for the same round into one query (DataLoader-style):
 * a page that asks for one NFD per component, or one per row, sends one request.
 */
export class Batcher {
  private pending = new Map<string, Batch>()

  constructor(
    private readonly engine: QueryEngine,
    private readonly windowMs: number,
  ) {}

  /** Runs `spec` at `round` (undefined: the latest) with the other calls made around the same time. */
  call(
    round: bigint | undefined,
    spec: CallSpec,
    signal?: AbortSignal,
  ): Promise<{ round: bigint; outcome: CallOutcome }> {
    signal?.throwIfAborted()
    const key = round === undefined ? "latest" : round.toString()
    let batch = this.pending.get(key)
    if (!batch) {
      const created: Batch = { round, items: [] }
      batch = created
      this.pending.set(key, created)
      setTimeout(() => {
        if (this.pending.get(key) === created) this.pending.delete(key)
        void this.flush(created)
      }, this.windowMs)
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (item.done) return
        item.done = true
        reject(signal!.reason)
      }
      const settle =
        <T>(fn: (value: T) => void) =>
        (value: T) => {
          signal?.removeEventListener("abort", onAbort)
          fn(value)
        }
      const item: Item = { spec, signal, resolve: settle(resolve), reject: settle(reject), done: false }
      batch.items.push(item)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  private async flush(batch: Batch): Promise<void> {
    const items = batch.items.filter((item) => !item.done)
    if (items.length === 0) return
    // the request is cancelled once every call in it has been aborted
    const controller = new AbortController()
    let live = items.length
    const listeners = items.map((item) => {
      const onAbort = () => {
        if (--live === 0) controller.abort(item.signal!.reason)
      }
      item.signal?.addEventListener("abort", onAbort, { once: true })
      return onAbort
    })
    try {
      const [result] = await this.engine.run(
        items.map((item) => item.spec),
        batch.round === undefined ? undefined : [batch.round],
        controller.signal,
      )
      items.forEach((item, i) => {
        if (item.done) return
        item.done = true
        item.resolve({ round: result.round, outcome: result.outcomes[i] })
      })
    } catch (e) {
      for (const item of items) {
        if (item.done) continue
        item.done = true
        item.reject(e)
      }
    } finally {
      items.forEach((item, i) => item.signal?.removeEventListener("abort", listeners[i]))
    }
  }
}
