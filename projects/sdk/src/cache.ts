import { raceAbort } from "./abort.js"

/** A read shared by every caller that asks for the same thing. */
type SharedRead = {
  value: Promise<unknown>
  /** Aborts the read, once every caller waiting on it has aborted */
  controller: AbortController
  /** Callers waiting with a signal that hasn't aborted, plus one for each caller without a signal (never released) */
  waiters: number
  settled: boolean
  expires: number
}

/**
 * Reads by key, shared and cached. Entries for past rounds never expire (their state never changes); entries for the
 * latest round expire after `latestTtlMs`. The least recently used entries are dropped past `maxEntries`. Failed and
 * aborted reads are not kept.
 *
 * A caller's signal only stops its own wait. The read itself is aborted when every caller waiting on it has aborted,
 * so a read one caller gives up on carries on for the others.
 */
export class ReadCache {
  private entries = new Map<string, SharedRead>()

  constructor(
    private readonly maxEntries: number,
    private readonly latestTtlMs: number,
  ) {}

  /** The shared read of `key`, starting it with `start` if there is none. */
  read<T>(key: string, latest: boolean, start: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    let entry = this.entries.get(key)
    // an aborted read is dropped unless it had already finished (its last caller gave up just as it did)
    if (entry && (entry.expires < Date.now() || (entry.controller.signal.aborted && !entry.settled))) {
      this.entries.delete(key)
      entry = undefined
    }
    if (entry) {
      // most recently used last
      this.entries.delete(key)
      this.entries.set(key, entry)
    } else {
      const controller = new AbortController()
      const created: SharedRead = {
        value: Promise.resolve(),
        controller,
        waiters: 0,
        settled: false,
        expires: latest ? Date.now() + this.latestTtlMs : Number.POSITIVE_INFINITY,
      }
      const settle = () => {
        created.settled = true
      }
      // marked settled as soon as the read ends, before any caller's handlers run
      created.value = start(controller.signal)
      created.value.then(settle, settle)
      created.value.catch(() => {
        if (this.entries.get(key) === created) this.entries.delete(key)
      })
      entry = created
      if (this.maxEntries > 0) {
        this.entries.set(key, entry)
        while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as string)
      }
    }
    return this.join(entry, signal) as Promise<T>
  }

  /** The value of a finished read of `key`, if one is cached; a read in flight or failed gives undefined. */
  peek<T>(key: string): Promise<T> | undefined {
    const entry = this.entries.get(key)
    if (!entry || !entry.settled || entry.expires < Date.now()) return undefined
    // most recently used last
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value as Promise<T>
  }

  /** Stores a value read some other way (a series). */
  put<T>(key: string, value: T, latest: boolean): void {
    if (this.maxEntries <= 0) return
    this.entries.set(key, {
      value: Promise.resolve(value),
      controller: new AbortController(),
      waiters: 0,
      settled: true,
      expires: latest ? Date.now() + this.latestTtlMs : Number.POSITIVE_INFINITY,
    })
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as string)
  }

  clear(): void {
    this.entries.clear()
  }

  private join(entry: SharedRead, signal?: AbortSignal): Promise<unknown> {
    if (entry.settled) return raceAbort(entry.value, signal)
    entry.waiters++
    if (!signal) return entry.value
    const release = () => {
      entry.waiters--
      if (entry.waiters === 0 && !entry.settled) entry.controller.abort(signal.reason)
    }
    signal.addEventListener("abort", release, { once: true })
    entry.value.then(
      () => signal.removeEventListener("abort", release),
      () => signal.removeEventListener("abort", release),
    )
    return raceAbort(entry.value, signal)
  }
}
