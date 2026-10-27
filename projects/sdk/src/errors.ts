/** A read at a round before the NFD registry was created. */
export class NfdNotDeployedError extends Error {
  readonly round: bigint
  readonly creationRound: bigint

  constructor(round: bigint, creationRound: bigint) {
    super(`The NFD registry didn't exist at round ${round}: it was created at round ${creationRound}`)
    this.name = "NfdNotDeployedError"
    this.round = round
    this.creationRound = creationRound
  }
}

/** A read at a round the node hasn't reached yet. */
export class FutureRoundError extends Error {
  readonly round: bigint
  readonly lastRound: bigint

  constructor(round: bigint, lastRound: bigint) {
    super(`Round ${round} isn't on this node yet: its latest round is ${lastRound}`)
    this.name = "FutureRoundError"
    this.round = round
    this.lastRound = lastRound
  }
}

/**
 * A read on a node or client without what the SDK needs: dtalgod's read-only queries with foreign box reads, and the
 * dtalgorand forks of algosdk and algokit-utils. Keep reading NFDs another way (the NFD REST API) there.
 */
export class NfdQueryUnavailableError extends Error {
  constructor(reason: string) {
    super(`NFD reads need a dtalgod with read-only queries and foreign box reads: ${reason}`)
    this.name = "NfdQueryUnavailableError"
  }
}

/** A reader call that failed at a round: its program erred, or it went over the node's limits even alone. */
export class NfdReadError extends Error {
  readonly round: bigint
  readonly failureMessage: string

  constructor(what: string, round: bigint, failureMessage: string) {
    super(`${what} failed at round ${round}: ${failureMessage}`)
    this.name = "NfdReadError"
    this.round = round
    this.failureMessage = failureMessage
  }
}
