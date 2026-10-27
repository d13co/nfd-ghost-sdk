// Checks the reader at past rounds against an independent derivation from algod REST state at the same round
// (globals, boxes, local state, block timestamp), over rounds spread across the registry's life.
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { encodeAddress, getApplicationAddress } from "algosdk"
import { sdk, MAINNET_REGISTRY } from "./common.js"
import { nameLsigAddress } from "../src/lsig.js"
import type { NfdRecord } from "../src/index.js"

const NODE = `${process.env.ALGOD_SERVER ?? "http://127.0.0.1"}:${process.env.ALGOD_PORT ?? 8081}`
const ROUNDS = Number(process.env.ROUNDS ?? 16)
const APPS = Number(process.env.APPS ?? 40)
const get = async (path: string) => {
  const res = await fetch(NODE + path)
  if (res.status === 404) return undefined
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json() as Promise<any>
}
const b64 = (s: string) => Buffer.from(s, "base64")
const be = (b: Buffer) => (b.length ? b.readBigUInt64BE(Math.max(0, b.length - 8)) : 0n)
const boxParam = (name: string) => encodeURIComponent(`b64:${Buffer.from(name).toString("base64")}`)

async function box(app: bigint, name: Buffer | string, round: bigint): Promise<Buffer | undefined> {
  const n = typeof name === "string" ? Buffer.from(name) : name
  const r = await get(`/v2/applications/${app}/box?name=${encodeURIComponent(`b64:${n.toString("base64")}`)}&round=${round}`)
  return r ? b64(r.value) : undefined
}

async function appForName(name: string, round: bigint): Promise<bigint> {
  const v = await box(MAINNET_REGISTRY, createHash("sha256").update(`name/${name}`).digest(), round)
  if (v && v.length === 16) return v.readBigUInt64BE(8)
  const lsig = nameLsigAddress(MAINNET_REGISTRY, name)
  const ls = await get(`/v2/accounts/${lsig}/applications/${MAINNET_REGISTRY}?round=${round}`)
  const kv = ls?.["app-local-state"]?.["key-value"]?.find((k: any) => b64(k.key).toString() === "i.appid")
  return kv ? be(b64(kv.value.bytes)) : 0n
}

async function expected(app: bigint, round: bigint, ts: number): Promise<Omit<NfdRecord, "round" | "major"> | null> {
  const a = await get(`/v2/applications/${app}?round=${round}`)
  if (!a) return null
  const g = new Map<string, Buffer>(
    (a.params["global-state"] ?? []).map((kv: any) => [b64(kv.key).toString("latin1"), b64(kv.value.bytes ?? "")]),
  )
  if (!g.has("i.name")) return null
  const name = g.get("i.name")!.toString()
  if ((await appForName(name, round)) !== app) return null
  const version = g.get("i.ver")?.toString() ?? ""
  const v1 = !version || version.startsWith("1")
  const prop = async (key: string) => (v1 ? g.get(key) : await box(app, key, round))
  const owner = g.get("i.owner.a")?.length === 32 ? encodeAddress(g.get("i.owner.a")!) : encodeAddress(new Uint8Array(32))
  const sell = be(g.get("i.sellamt") ?? Buffer.alloc(0))
  const exp = be(g.get("i.expirationTime") ?? Buffer.alloc(0))
  const appAddress = getApplicationAddress(app).toString()
  const state = exp !== 0n && BigInt(ts) >= exp ? "expired" : sell !== 0n ? "forSale" : owner === appAddress ? "unowned" : "owned"
  const apply = state !== "expired" && state !== "forSale"
  const chunks: Buffer[] = []
  for (let n = 0; n < 16; n++) {
    const c = await prop(`v.caAlgo.${n}.as`)
    if (!c) break
    chunks.push(c)
  }
  const addrs = (b: Buffer) => {
    const out: string[] = []
    for (let i = 0; i + 32 <= b.length; i += 32) if (!b.subarray(i, i + 32).equals(Buffer.alloc(32))) out.push(encodeAddress(b.subarray(i, i + 32)))
    return out
  }
  const all = chunks.flatMap(addrs)
  let avatar = (await prop("u.avatar"))?.subarray(0, 256)
  if (!avatar?.length) avatar = (await prop("v.avatar"))?.subarray(0, 256)
  let bio = (await prop("u.bio"))?.subarray(0, 768) ?? Buffer.alloc(0)
  for (let k = 0; k < 16 && bio.length < 768; k++) {
    const p = await prop(`u.bio_${String(k).padStart(2, "0")}`)
    if (!p) break
    bio = Buffer.concat([bio, p.subarray(0, 768)])
  }
  bio = bio.subarray(0, 768)
  const rec: any = {
    appId: app,
    name,
    version,
    owner,
    asaId: be(g.get("i.asaid") ?? Buffer.alloc(0)),
    parentAppId: be(g.get("i.parentAppID") ?? Buffer.alloc(0)) || null,
    state,
    caAlgo: apply ? all.slice(0, 40) : [],
    caAlgoCount: apply ? all.length : 0,
    caAlgo0: chunks[0] ? addrs(chunks[0]).slice(0, 40) : [],
  }
  const category = g.get("i.category")?.toString()
  if (category) rec.category = category
  if (exp) rec.expiresAt = Number(exp)
  if (apply && avatar?.length) rec.avatar = avatar.toString()
  if (apply && bio.length) rec.bio = new TextDecoder().decode(bio)
  return rec
}

const csv = readFileSync("all-nfd-apps.csv", "utf8").trim().split("\n").slice(1).map((l) => BigInt(l.split(",")[0]))
const v1 = [864806088n, 772301346n, 766611148n, 1038280399n, 1029328091n, 1116450565n, 876472739n, 775323115n]
const apps = [...new Set([1013764620n, 2318360299n, 2526143532n, 3296744483n, ...v1, ...csv.sort(() => Math.random() - 0.5).slice(0, APPS)])]
const first = 21_341_747n
const last = BigInt((await get("/v2/status"))["last-round"])
const rounds = Array.from({ length: ROUNDS }, (_, i) => first + ((last - first) * BigInt(i)) / BigInt(ROUNDS - 1))

const t = Date.now()
const series = await sdk.getRecordsSeries(apps, rounds)
console.log(`getRecordsSeries: ${apps.length} apps × ${rounds.length} rounds in ${Date.now() - t} ms`)

let checked = 0
let present = 0
let bad = 0
for (const point of series) {
  if (!point.ok) {
    console.log("POINT FAILED", point.round, point.error.message)
    bad++
    continue
  }
  const header = await get(`/v2/blocks/${point.round}?header-only=true`)
  const ts = header.block.ts as number
  await Promise.all(
    apps.map(async (app) => {
      const exp = await expected(app, point.round, ts)
      const got = point.value.get(app) ?? null
      const norm = (r: any) => (r ? JSON.stringify({ ...r, round: undefined, major: undefined }, (_, v) => (typeof v === "bigint" ? v.toString() : v)) : "null")
      checked++
      if (exp) present++
      if (norm(exp) !== norm(got)) {
        bad++
        console.log(`MISMATCH app ${app} at ${point.round}\n  expected ${norm(exp)}\n  got      ${norm(got)}`)
      }
    }),
  )
}
console.log(`${checked} (app, round) pairs checked, ${present} NFDs present, ${bad} mismatches`)
process.exit(bad ? 1 : 0)
