/** The rounds of a series: a list, or `points` rounds spread evenly from `from` to `to`, both included. */
export type SeriesRounds = (number | bigint)[] | { from: number | bigint; to: number | bigint; points: number }

/** One point of a series: the value at a round, or why it couldn't be read there. */
export type SeriesPoint<T> = { round: bigint } & ({ ok: true; value: T } | { ok: false; error: Error })

/** Most points per series by default. */
export const MAX_SERIES_POINTS = 1024

/** The rounds of a series, deduplicated and in ascending order. */
export function seriesRounds(rounds: SeriesRounds, maxPoints = MAX_SERIES_POINTS): bigint[] {
  let list: bigint[]
  if (Array.isArray(rounds)) {
    list = rounds.map(BigInt)
  } else {
    const from = BigInt(rounds.from)
    const to = BigInt(rounds.to)
    if (to < from) throw new RangeError(`series: to (${to}) is before from (${from})`)
    if (!(rounds.points >= 1)) throw new RangeError(`series: points must be at least 1`)
    // more points than rounds in the range give every round in it: cap them before building the list
    const span = to - from + 1n
    const points = Math.min(Math.floor(rounds.points), Number(span))
    if (points > maxPoints) {
      throw new RangeError(`series: ${points} rounds is more than ${maxPoints}; pass maxPoints to allow more`)
    }
    if (points === 1) {
      list = [to]
    } else {
      const steps = BigInt(points - 1)
      list = Array.from({ length: points }, (_, i) => from + ((to - from) * BigInt(i)) / steps)
    }
  }
  list = [...new Set(list)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (list.length > maxPoints) {
    throw new RangeError(`series: ${list.length} rounds is more than ${maxPoints}; pass maxPoints to allow more`)
  }
  return list
}
