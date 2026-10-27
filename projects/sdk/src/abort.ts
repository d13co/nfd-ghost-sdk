/**
 * Waits for a promise other callers share (a cache, a deduplicated read) without tying it to one caller's signal:
 * rejects with the signal's reason as soon as it aborts, while the shared work carries on for the others.
 */
export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    // nobody else may be waiting on it: its rejection mustn't go unhandled
    promise.catch(() => {})
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Runs a read, failing with the signal's reason (an `AbortError` unless the caller gave another) once it has aborted,
 * whatever error the cancelled request threw.
 */
export async function abortable<T>(signal: AbortSignal | undefined, read: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted()
  try {
    return await read()
  } catch (e) {
    signal?.throwIfAborted()
    throw e
  }
}
