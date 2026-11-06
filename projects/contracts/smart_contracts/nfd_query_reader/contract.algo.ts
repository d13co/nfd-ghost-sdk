import {
  abimethod,
  Account,
  bytes,
  Bytes,
  Contract,
  contract,
  Global,
  log,
  op,
  uint64,
} from "@algorandfoundation/algorand-typescript"
import { encodeArc4 } from "@algorandfoundation/algorand-typescript/arc4"

/**
 * NfdQueryReader: a ghost reader for NFDs of every generation (v1, v2, v3) and every registry generation, at any round.
 *
 * It is never deployed. Each call of a dtalgod read-only query (`POST /v2/query`) creates it and runs one method, on the
 * state round R left. It needs foreign box reads in queries (`app_box_get`, `app_box_len` and `app_box_extract` on any
 * app), which only queries allow.
 *
 * Every method logs its answers and returns nothing:
 * - `0x01 ‖ NfdRecord` (ARC-4) per NFD
 * - `0x02 ‖ next ‖ total` (uint64s) when a list method stopped early, at candidate `next` of `total`, to stay within
 *   its candidate limit or its log budget: call it again with `start = next`
 *
 * `opts` packs the read options: bits 0–7 are the fields (`F_*`), bits 8–15 the most `caAlgo` addresses to return, and
 * bits 16–39 the most bytes the call may log.
 */

/** Return the verified addresses (`caAlgo`, `caAlgoCount`, `caAlgo0`). */
const F_CAALGO: uint64 = 1
/** Return the avatar: `u.avatar`, else `v.avatar`. */
const F_AVATAR: uint64 = 2
/** Return the bio: `u.bio` followed by `u.bio_00`, `u.bio_01`, … */
const F_BIO: uint64 = 4

/** The most `caAlgo` (and `caAlgo0`) addresses a record carries, so that a record stays under the 4,096-byte log limit. */
const MAX_CA_ALGO: uint64 = 40
const MAX_AVATAR: uint64 = 256
const MAX_BIO: uint64 = 768
/** Longest name, version or category returned. */
const MAX_STRING: uint64 = 96
/** `v.caAlgo.N.as` keys are read for N from 0 until one is missing, at most this many. */
const MAX_CHUNKS: uint64 = 16
/** `u.bio_NN` keys are read from 00 until one is missing, at most this many. */
const MAX_BIO_PARTS: uint64 = 16
/** The v1 reverse lookup lsig's local keys: `i.apps0` … `i.apps15`. */
const LSIG_APP_KEYS: uint64 = 16
/** The most bytes `app_box_get` / `app_box_extract` return at once. */
const MAX_READ: uint64 = 4096
/** How many ids before an NFD's asset its app is looked for, when the asset's name is cut short */
const ASSET_APP_WINDOW: uint64 = 8
/** The size of the "more" marker log. */
const MARKER_BYTES: uint64 = 17

const STATE_OWNED: uint64 = 0
const STATE_FOR_SALE: uint64 = 1
const STATE_EXPIRED: uint64 = 2
const STATE_UNOWNED: uint64 = 3

/** What a call logs per NFD. Strings and packed addresses are raw bytes (`byte[]`); the SDK decodes them. */
export type NfdRecord = {
  appId: uint64
  name: bytes
  version: bytes
  owner: Account
  asaId: uint64
  parentAppId: uint64
  category: bytes
  sellAmount: uint64
  expirationTime: uint64
  /** 0 owned, 1 for sale, 2 expired, 3 not owned (owned by its own app) */
  state: uint64
  /** Every nonzero address of every `v.caAlgo.N.as` chunk, before the cap; 0 for expired and for-sale NFDs */
  caAlgoCount: uint64
  /** Those addresses, packed, capped; empty for expired and for-sale NFDs */
  caAlgo: bytes
  /** The nonzero addresses of `v.caAlgo.0.as` alone, packed, capped, whatever the state: what Réti's contract reads */
  caAlgo0: bytes
  avatar: bytes
  bio: bytes
}

/** An NFD's core fields at the round. */
type Core = {
  exists: boolean
  /** v1 keeps properties in global state; v2 and v3 in boxes */
  v1: boolean
  name: bytes
  version: bytes
  owner: Account
  appAddress: Account
  asaId: uint64
  parentAppId: uint64
  category: bytes
  sellAmount: uint64
  expirationTime: uint64
  state: uint64
}

/** The result of scanning an NFD's verified addresses. */
type Scan = {
  /** `target` is in some chunk */
  found: boolean
  /** `target` is in `v.caAlgo.0.as` */
  found0: boolean
  count: uint64
  all: bytes
  first: bytes
}

@contract({ avmVersion: 13 })
export class NfdQueryReader extends Contract {
  /**
   * The NFD `app`, if it exists at the round and is the NFD its registry names: `i.name` resolves to `app` through the
   * registry's `name/` box, or the v1 name lsig.
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  getRecord(registry: uint64, app: uint64, opts: uint64): void {
    const core = this.readCore(app)
    if (!core.exists) return
    if (this.appForName(registry, core.name) !== app) return
    this.logRecord(app, core, opts, this.scanFor(app, core, Global.zeroAddress, opts))
  }

  /** The NFD named `name`: the registry's `name/` box, else the v1 name lsig, checked against the app's `i.name`. */
  @abimethod({ readonly: true, onCreate: "allow" })
  resolveName(registry: uint64, name: bytes, opts: uint64): void {
    const app = this.appForName(registry, name)
    if (app === 0) return
    const core = this.readCore(app)
    if (!core.exists || core.name !== name) return
    this.logRecord(app, core, opts, this.scanFor(app, core, Global.zeroAddress, opts))
  }

  /**
   * The NFDs that have `address` as a verified address. Candidates are the registry's `addr/algo/` box, then the v1
   * address lsig's `i.apps0..15` (only those not in the box), zeros skipped. With `parent` 0, a candidate is kept when it
   * is an NFD, not expired or for sale, and `address` is in one of its `v.caAlgo.N.as` chunks. With a `parent`, it is
   * kept when `i.parentAppID == parent` and `address` owns it or, for v2 and v3, is in its `v.caAlgo.0.as` (Réti's
   * segment rule).
   *
   * Looks at candidates `start` to `start + limit` (of the combined list); logs a "more" marker if there are more.
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  reverseLookup(
    registry: uint64,
    address: Account,
    addressLsig: Account,
    parent: uint64,
    start: uint64,
    limit: uint64,
    opts: uint64,
  ): void {
    const [, registryExists] = op.AppParams.appCreator(registry)
    if (!registryExists) return

    const boxKey = op.sha256(Bytes`addr/algo/`.concat(address.bytes))
    const [boxLength, boxExists] = op.AppBox.length(registry, boxKey)
    const inBox: uint64 = boxExists ? boxLength / 8 : 0

    let lsigIds = Bytes``
    if (op.appOptedIn(addressLsig, registry)) {
      for (let k: uint64 = 0; k < LSIG_APP_KEYS; k++) {
        const [ids, exists] = op.AppLocal.getExBytes(addressLsig, registry, Bytes`i.apps`.concat(decimal(k)))
        if (exists) lsigIds = lsigIds.concat(ids)
      }
    }
    const total: uint64 = inBox + lsigIds.length / 8

    let logged: uint64 = 0
    const end: uint64 = start + limit < total ? start + limit : total
    for (let i: uint64 = start; i < end; i++) {
      let app: uint64 = 0
      if (i < inBox) {
        app = op.btoi(op.AppBox.extract(registry, boxKey, i * 8, 8))
      } else {
        app = op.extractUint64(lsigIds, (i - inBox) * 8)
        if (app !== 0 && this.boxHas(registry, boxKey, inBox, app)) app = 0
      }
      if (app === 0) continue

      const core = this.readCore(app)
      if (!core.exists) continue
      let scan: Scan
      if (parent === 0) {
        if (!propertiesApply(core)) continue
        scan = this.scanCaAlgo(app, core.v1, address, opts)
        if (!scan.found) continue
      } else {
        if (core.parentAppId !== parent) continue
        scan = this.scanCaAlgo(app, core.v1, address, opts)
        // Réti reads v.caAlgo.0.as through `read_property`, which v1 NFDs don't have: for them only the owner counts
        if (!(core.owner === address || (!core.v1 && scan.found0))) continue
      }
      const size = this.logRecordWithin(app, core, opts, scan, logged)
      if (size === 0) {
        logMore(i, total)
        return
      }
      logged += size
    }
    if (end < total) logMore(end, total)
  }

  /**
   * The candidate NFDs that `address` owns (`i.owner.a`, other than the NFD's own app address). `apps` are packed
   * uint64 app ids; `asas` packed uint64 asset ids, each mapped to its NFD (see `appForAsset`). With a `parent`, keeps
   * instead the candidates with `i.parentAppID == parent` that `address` owns or, for v2 and v3, is in the
   * `v.caAlgo.0.as` of (Réti's segment rule).
   *
   * Looks at candidates `start` to `start + limit` of `apps` then `asas`; logs a "more" marker if there are more.
   */
  @abimethod({ readonly: true, onCreate: "allow" })
  ownedBy(
    registry: uint64,
    address: Account,
    apps: bytes,
    asas: bytes,
    parent: uint64,
    start: uint64,
    limit: uint64,
    opts: uint64,
  ): void {
    const appCount: uint64 = apps.length / 8
    const total: uint64 = appCount + asas.length / 8
    let logged: uint64 = 0
    const end: uint64 = start + limit < total ? start + limit : total
    for (let i: uint64 = start; i < end; i++) {
      const app: uint64 =
        i < appCount ? op.extractUint64(apps, i * 8) : this.appForAsset(registry, op.extractUint64(asas, (i - appCount) * 8))
      if (app === 0) continue

      const core = this.readCore(app)
      if (!core.exists) continue
      let scan: Scan
      if (parent === 0) {
        if (core.owner !== address || core.owner === core.appAddress) continue
        scan = this.scanFor(app, core, Global.zeroAddress, opts)
      } else {
        if (core.parentAppId !== parent) continue
        if (core.owner === address) {
          scan = this.scanFor(app, core, Global.zeroAddress, opts)
        } else {
          if (core.v1) continue
          scan = this.scanCaAlgo(app, core.v1, address, opts)
          if (!scan.found0) continue
        }
      }
      const size = this.logRecordWithin(app, core, opts, scan, logged)
      if (size === 0) {
        logMore(i, total)
        return
      }
      logged += size
    }
    if (end < total) logMore(end, total)
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Core fields

  private readCore(app: uint64): Core {
    const [, appExists] = op.AppParams.appCreator(app)
    if (!appExists) return emptyCore()
    const [name, hasName] = op.AppGlobal.getExBytes(app, Bytes`i.name`)
    if (!hasName) return emptyCore()

    const [version, hasVersion] = op.AppGlobal.getExBytes(app, Bytes`i.ver`)
    const v1 = !hasVersion || version.length === 0 || version.slice(0, 1) === Bytes`1`
    const [ownerBytes, hasOwner] = op.AppGlobal.getExBytes(app, Bytes`i.owner.a`)
    const owner = hasOwner && ownerBytes.length === 32 ? Account(ownerBytes) : Global.zeroAddress
    const [appAddress] = op.AppParams.appAddress(app)
    const [category] = op.AppGlobal.getExBytes(app, Bytes`i.category`)

    const sellAmount = this.globalUint(app, Bytes`i.sellamt`)
    const expirationTime = this.globalUint(app, Bytes`i.expirationTime`)
    let state = STATE_OWNED
    if (expirationTime !== 0 && Global.latestTimestamp >= expirationTime) {
      state = STATE_EXPIRED
    } else if (sellAmount !== 0) {
      state = STATE_FOR_SALE
    } else if (owner === appAddress) {
      state = STATE_UNOWNED
    }

    return {
      exists: true,
      v1,
      name,
      version,
      owner,
      appAddress,
      asaId: this.globalUint(app, Bytes`i.asaid`),
      parentAppId: this.globalUint(app, Bytes`i.parentAppID`),
      category,
      sellAmount,
      expirationTime,
      state,
    }
  }

  /** A global that holds an 8-byte big-endian int; 0 if missing or not an int. */
  private globalUint(app: uint64, key: bytes): uint64 {
    const [value, exists] = op.AppGlobal.getExBytes(app, key)
    if (!exists || value.length === 0 || value.length > 8) return 0
    return op.btoi(value)
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Name resolution

  /** The app of NFD `name`: the registry's `name/` box (`asaId ‖ appId`), else the v1 name lsig's `i.appid`; 0 if none. */
  private appForName(registry: uint64, name: bytes): uint64 {
    const [, registryExists] = op.AppParams.appCreator(registry)
    if (!registryExists) return 0
    const [value, exists] = op.AppBox.get(registry, op.sha256(Bytes`name/`.concat(name)))
    if (exists && value.length === 16) return op.extractUint64(value, 8)

    const lsig = nameLsig(registry, name)
    if (!op.appOptedIn(lsig, registry)) return 0
    const [appId, hasAppId] = op.AppLocal.getExBytes(lsig, registry, Bytes`i.appid`)
    if (!hasAppId || appId.length === 0 || appId.length > 8) return 0
    return op.btoi(appId)
  }

  /**
   * The NFD app of an NFD asset (unit name `NFD`): the app its name resolves to, if that app's address created the asset.
   * Names over 32 bytes are cut short in the asset's name, so failing that, the app among the `ASSET_APP_WINDOW` ids
   * before the asset whose address created it (NFDs mint their asset 3, 6 or 7 ids after their app), if its `i.name`
   * resolves to it. 0 if neither.
   */
  private appForAsset(registry: uint64, asa: uint64): uint64 {
    const [unitName, exists] = op.AssetParams.assetUnitName(asa)
    if (!exists || unitName !== Bytes`NFD`) return 0
    const [name] = op.AssetParams.assetName(asa)
    const [creator] = op.AssetParams.assetCreator(asa)
    const app = this.appForName(registry, name)
    if (app !== 0) {
      const [appAddress, appExists] = op.AppParams.appAddress(app)
      if (appExists && appAddress === creator) return app
    }
    for (let k: uint64 = 1; k <= ASSET_APP_WINDOW && k < asa; k++) {
      const candidate: uint64 = asa - k
      const [address, candidateExists] = op.AppParams.appAddress(candidate)
      if (!candidateExists || address !== creator) continue
      const [appName, hasName] = op.AppGlobal.getExBytes(candidate, Bytes`i.name`)
      return hasName && this.appForName(registry, appName) === candidate ? candidate : 0
    }
    return 0
  }

  /** Whether the registry's reverse box (of `count` app ids) holds `app`. */
  private boxHas(registry: uint64, boxKey: bytes, count: uint64, app: uint64): boolean {
    for (let i: uint64 = 0; i < count; i++) {
      if (op.btoi(op.AppBox.extract(registry, boxKey, i * 8, 8)) === app) return true
    }
    return false
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Verified addresses

  /** The scan a record needs: the verified addresses if they're asked for, else nothing. */
  private scanFor(app: uint64, core: Core, target: Account, opts: uint64): Scan {
    if ((opts & F_CAALGO) === 0) return emptyScan()
    return this.scanCaAlgo(app, core.v1, target, opts)
  }

  /**
   * Reads every `v.caAlgo.N.as` chunk, N from 0 until one is missing (v1: globals; v2, v3: boxes, read 4 KB at a time),
   * counting the nonzero addresses, looking for `target`, and collecting up to the cap if the fields ask for them.
   */
  private scanCaAlgo(app: uint64, v1: boolean, target: Account, opts: uint64): Scan {
    const collect = (opts & F_CAALGO) !== 0
    const max = caAlgoCap(opts)
    let found = false
    let found0 = false
    let count: uint64 = 0
    let all = Bytes``
    let first = Bytes``
    for (let n: uint64 = 0; n < MAX_CHUNKS; n++) {
      const key = Bytes`v.caAlgo.`.concat(decimal(n)).concat(Bytes`.as`)
      let length: uint64 = 0
      let chunk = Bytes``
      if (v1) {
        const [value, exists] = op.AppGlobal.getExBytes(app, key)
        if (!exists) break
        chunk = value
        length = value.length
      } else {
        const [boxLength, exists] = op.AppBox.length(app, key)
        if (!exists) break
        length = boxLength
      }
      for (let offset: uint64 = 0; offset < length; offset += MAX_READ) {
        let piece = chunk
        if (!v1) {
          const size: uint64 = length - offset < MAX_READ ? length - offset : MAX_READ
          piece = op.AppBox.extract(app, key, offset, size)
        }
        for (let at: uint64 = 0; at + 32 <= piece.length; at += 32) {
          const addr = op.extract(piece, at, 32)
          if (addr === Global.zeroAddress.bytes) continue
          count++
          if (addr === target.bytes) {
            found = true
            if (n === 0) found0 = true
          }
          if (collect && count <= max) all = all.concat(addr)
          if (collect && n === 0 && first.length < max * 32) first = first.concat(addr)
        }
      }
    }
    return { found, found0, count, all, first }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Properties

  /** A property (global in v1, box in v2 and v3), cut to `max` bytes. */
  private property(app: uint64, v1: boolean, key: bytes, max: uint64): readonly [bytes, boolean] {
    if (v1) {
      const [value, exists] = op.AppGlobal.getExBytes(app, key)
      if (!exists) return [Bytes``, false]
      return [value.length > max ? value.slice(0, max) : value, true]
    }
    const [length, exists] = op.AppBox.length(app, key)
    if (!exists) return [Bytes``, false]
    if (length === 0) return [Bytes``, true]
    return [op.AppBox.extract(app, key, 0, length < max ? length : max), true]
  }

  private avatar(app: uint64, v1: boolean): bytes {
    const [user, hasUser] = this.property(app, v1, Bytes`u.avatar`, MAX_AVATAR)
    if (hasUser && user.length > 0) return user
    const [verified] = this.property(app, v1, Bytes`v.avatar`, MAX_AVATAR)
    return verified
  }

  /** `u.bio` followed by `u.bio_00`, `u.bio_01`, … until one is missing (TxnLab's merge), cut to `MAX_BIO`. */
  private bio(app: uint64, v1: boolean): bytes {
    let [bio] = this.property(app, v1, Bytes`u.bio`, MAX_BIO)
    for (let k: uint64 = 0; k < MAX_BIO_PARTS && bio.length < MAX_BIO; k++) {
      const [part, exists] = this.property(app, v1, Bytes`u.bio_`.concat(twoDigits(k)), MAX_BIO)
      if (!exists) break
      bio = bio.concat(part)
    }
    return bio.length > MAX_BIO ? bio.slice(0, MAX_BIO) : bio
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Output

  private encodeRecord(app: uint64, core: Core, opts: uint64, scan: Scan): bytes {
    const apply = propertiesApply(core)
    const record: NfdRecord = {
      appId: app,
      name: cut(core.name, MAX_STRING),
      version: cut(core.version, MAX_STRING),
      owner: core.owner,
      asaId: core.asaId,
      parentAppId: core.parentAppId,
      category: cut(core.category, MAX_STRING),
      sellAmount: core.sellAmount,
      expirationTime: core.expirationTime,
      state: core.state,
      caAlgoCount: apply ? scan.count : 0,
      caAlgo: apply ? scan.all : Bytes``,
      caAlgo0: scan.first,
      avatar: apply && (opts & F_AVATAR) !== 0 ? this.avatar(app, core.v1) : Bytes``,
      bio: apply && (opts & F_BIO) !== 0 ? this.bio(app, core.v1) : Bytes``,
    }
    return Bytes.fromHex("01").concat(encodeArc4(record))
  }

  private logRecord(app: uint64, core: Core, opts: uint64, scan: Scan): void {
    log(this.encodeRecord(app, core, opts, scan))
  }

  /**
   * Logs the record if it fits in the call's log budget after `logged` bytes, leaving room for a "more" marker; returns
   * its size, or 0 if it didn't fit. The first record of a call is always logged.
   */
  private logRecordWithin(app: uint64, core: Core, opts: uint64, scan: Scan, logged: uint64): uint64 {
    const record = this.encodeRecord(app, core, opts, scan)
    if (logged > 0 && logged + record.length + MARKER_BYTES > logBudget(opts)) return 0
    log(record)
    return record.length
  }
}

// -----------------------------------------------------------------------------------------------------------------
// Helpers

function emptyCore(): Core {
  return {
    exists: false,
    v1: false,
    name: Bytes``,
    version: Bytes``,
    owner: Global.zeroAddress,
    appAddress: Global.zeroAddress,
    asaId: 0,
    parentAppId: 0,
    category: Bytes``,
    sellAmount: 0,
    expirationTime: 0,
    state: STATE_OWNED,
  }
}

function emptyScan(): Scan {
  return { found: false, found0: false, count: 0, all: Bytes``, first: Bytes`` }
}

/** Expired and for-sale NFDs have their properties ignored. */
function propertiesApply(core: Core): boolean {
  return core.state !== STATE_EXPIRED && core.state !== STATE_FOR_SALE
}

function caAlgoCap(opts: uint64): uint64 {
  const max: uint64 = (opts >> 8) & 0xff
  return max < MAX_CA_ALGO ? max : MAX_CA_ALGO
}

function logBudget(opts: uint64): uint64 {
  return (opts >> 16) & 0xffffff
}

function cut(value: bytes, max: uint64): bytes {
  return value.length > max ? value.slice(0, max) : value
}

function logMore(next: uint64, total: uint64): void {
  log(Bytes.fromHex("02").concat(op.itob(next)).concat(op.itob(total)))
}

/** `n` in decimal ASCII, for n < 100. */
function decimal(n: uint64): bytes {
  if (n < 10) return digit(n)
  return digit(n / 10).concat(digit(n % 10))
}

/** `n` as two decimal ASCII digits, for n < 100. */
function twoDigits(n: uint64): bytes {
  return digit(n / 10).concat(digit(n % 10))
}

function digit(n: uint64): bytes {
  return op.extract(op.itob(n + 48), 7, 1)
}

/** The uvarint encoding of `n`, for n < 16,384. */
function uvarint(n: uint64): bytes {
  if (n < 128) return op.extract(op.itob(n), 7, 1)
  return op.extract(op.itob((n & 0x7f) | 0x80), 7, 1).concat(op.extract(op.itob(n >> 7), 7, 1))
}

/**
 * The v1 name lookup lsig of `name` (`getLookupLSIG` in TxnLab's Go code): the template with the registry id at bytes
 * 6–13, then the uvarint length of `name/<name>` and the suffix itself, hashed as a program.
 */
function nameLsig(registry: uint64, name: bytes): Account {
  const suffix = Bytes`name/`.concat(name)
  const program = Bytes.fromHex("052001018008")
    .concat(op.itob(registry))
    .concat(Bytes.fromHex("173500311834001231108106121031192212311981001211104000010022432601"))
    .concat(uvarint(suffix.length))
    .concat(suffix)
  return Account(op.sha512_256(Bytes`Program`.concat(program)))
}
