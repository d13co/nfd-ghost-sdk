import { ABIMethod, ABIType, base64ToBytes, encodeAddress } from "algosdk"
import { READER_APPROVAL_B64, READER_CLEAR_B64, READER_METHODS } from "./generated/reader.js"

/** The NfdQueryReader's approval program: each query call creates an app running it. */
export const READER_PROGRAM = base64ToBytes(READER_APPROVAL_B64)
/** The NfdQueryReader's clear state program. */
export const READER_CLEAR_PROGRAM = base64ToBytes(READER_CLEAR_B64)

export type ReaderMethod = keyof typeof READER_METHODS

const methods = Object.fromEntries(
  Object.entries(READER_METHODS).map(([name, signature]) => [name, ABIMethod.fromSignature(signature)]),
) as Record<ReaderMethod, ABIMethod>

/** The app args of a reader call: the method selector, then each argument ABI-encoded. */
export function encodeCall(method: ReaderMethod, args: unknown[]): Uint8Array[] {
  const abi = methods[method]
  if (args.length !== abi.args.length) {
    throw new Error(`${method}: expected ${abi.args.length} arguments, got ${args.length}`)
  }
  return [abi.getSelector(), ...abi.args.map((arg, i) => (arg.type as ABIType).encode(args[i] as never))]
}

/** The fields a read can ask for. */
export type NfdField = "caAlgo" | "avatar" | "bio"

/** The fields asked for when a read doesn't say. */
export const DEFAULT_FIELDS: readonly NfdField[] = ["caAlgo", "avatar", "bio"]

const FIELD_BITS: Record<NfdField, number> = { caAlgo: 1, avatar: 2, bio: 4 }

/** The most `caAlgo` (and `caAlgo0`) addresses the reader returns per record: what fits a 4,096-byte log. */
export const MAX_CA_ALGO = 40

/**
 * The reader's `opts` argument: the fields (bits 0–7), the most `caAlgo` addresses (bits 8–15), and the most bytes a
 * call may log (bits 16–39).
 */
export function encodeOpts(fields: readonly NfdField[], maxCaAlgo: number, logBudget: number): bigint {
  let bits = 0
  for (const field of fields) {
    const bit = FIELD_BITS[field]
    if (bit === undefined) throw new Error(`Unknown NFD field: ${field}`)
    bits |= bit
  }
  const max = Math.max(0, Math.min(MAX_CA_ALGO, Math.floor(maxCaAlgo)))
  const budget = Math.max(0, Math.min(0xffffff, Math.floor(logBudget)))
  return BigInt(bits) | (BigInt(max) << 8n) | (BigInt(budget) << 16n)
}

/** An NFD's state at a round. */
export type NfdState = "owned" | "forSale" | "expired" | "unowned"

const STATES: NfdState[] = ["owned", "forSale", "expired", "unowned"]

/** An NFD as of a round. */
export type NfdRecord = {
  appId: bigint
  name: string
  /** `i.ver`, such as `3.7` */
  version: string
  /** The contract generation: v1 keeps its properties in global state, v2 and v3 in boxes */
  major: 1 | 2 | 3
  /** `i.owner.a` */
  owner: string
  /** `i.asaid` */
  asaId: bigint
  /** `i.parentAppID`: the root NFD of a segment; null for a root */
  parentAppId: bigint | null
  /** `i.category`, such as `curated`, `premium` or `common` */
  category?: string
  /**
   * - `expired`: `i.expirationTime` is set and past, as of the round's block timestamp (v3 only)
   * - `forSale`: `i.sellamt` is set
   * - `unowned`: `i.owner.a` is the NFD's own app address
   * - `owned`: otherwise
   *
   * Expired and for-sale NFDs have their properties ignored: no `caAlgo`, avatar or bio.
   */
  state: NfdState
  /** `i.expirationTime` (unix seconds), if set */
  expiresAt?: number
  /**
   * The verified addresses: every `v.caAlgo.N.as` chunk, in key order, zero addresses dropped, capped at the SDK's
   * `maxCaAlgo`. Empty unless the read asked for `caAlgo`, and for expired and for-sale NFDs.
   */
  caAlgo: string[]
  /** The number of verified addresses before the cap */
  caAlgoCount: number
  /**
   * Just `v.caAlgo.0.as`, zero addresses dropped, capped: the chunk Réti's contract checks. Read whatever the state, as
   * the contract does. Empty unless the read asked for `caAlgo`.
   */
  caAlgo0: string[]
  /** `u.avatar`, else `v.avatar`, raw (an `ipfs://` URL is left to the app); at most 256 bytes */
  avatar?: string
  /** `u.bio`, then `u.bio_00`, `u.bio_01`, … merged; at most 768 bytes */
  bio?: string
  /** The round it was read at */
  round: bigint
}

const RECORD_TYPE = ABIType.from(
  "(uint64,byte[],byte[],address,uint64,uint64,byte[],uint64,uint64,uint64,uint64,byte[],byte[],byte[],byte[])",
)

const textDecoder = new TextDecoder()

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (Array.isArray(value)) return Uint8Array.from(value as number[])
  throw new Error(`Expected bytes, got ${typeof value}`)
}

function text(value: unknown): string {
  return textDecoder.decode(asBytes(value))
}

function addresses(value: unknown): string[] {
  const bytes = asBytes(value)
  const out: string[] = []
  for (let at = 0; at + 32 <= bytes.length; at += 32) out.push(encodeAddress(bytes.subarray(at, at + 32)))
  return out
}

function majorOf(version: string): 1 | 2 | 3 {
  const major = Number.parseInt(version, 10)
  if (major === 2) return 2
  if (major >= 3) return 3
  return 1
}

/** Decodes a record log (after its tag) read at `round`. */
export function decodeRecord(bytes: Uint8Array, round: bigint): NfdRecord {
  const [
    appId,
    name,
    version,
    owner,
    asaId,
    parentAppId,
    category,
    ,
    expirationTime,
    state,
    caAlgoCount,
    caAlgo,
    caAlgo0,
    avatar,
    bio,
  ] = RECORD_TYPE.decode(bytes) as unknown[]
  const versionText = text(version)
  const record: NfdRecord = {
    appId: BigInt(appId as bigint),
    name: text(name),
    version: versionText,
    major: majorOf(versionText),
    owner: owner as string,
    asaId: BigInt(asaId as bigint),
    parentAppId: BigInt(parentAppId as bigint) === 0n ? null : BigInt(parentAppId as bigint),
    state: STATES[Number(state)] ?? "owned",
    caAlgo: addresses(caAlgo),
    caAlgoCount: Number(caAlgoCount),
    caAlgo0: addresses(caAlgo0),
    round,
  }
  const categoryText = text(category)
  if (categoryText) record.category = categoryText
  if (BigInt(expirationTime as bigint) !== 0n) record.expiresAt = Number(expirationTime)
  const avatarText = text(avatar)
  if (avatarText) record.avatar = avatarText
  const bioText = text(bio)
  if (bioText) record.bio = bioText
  return record
}

/** What a reader call logged: its records, and where to go on if it stopped early. */
export type ParsedLogs = { records: NfdRecord[]; more?: { next: bigint; total: bigint } }

const TAG_RECORD = 0x01
const TAG_MORE = 0x02

/** Parses a reader call's logs read at `round`. */
export function parseLogs(logs: Uint8Array[], round: bigint): ParsedLogs {
  const parsed: ParsedLogs = { records: [] }
  for (const entry of logs) {
    if (entry[0] === TAG_RECORD) {
      parsed.records.push(decodeRecord(entry.subarray(1), round))
    } else if (entry[0] === TAG_MORE && entry.length === 17) {
      const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength)
      parsed.more = { next: view.getBigUint64(1), total: view.getBigUint64(9) }
    }
  }
  return parsed
}
