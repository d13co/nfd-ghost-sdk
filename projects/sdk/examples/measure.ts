// Worst-case cost of a full page, the largest reverse candidate lists, and when "O" owner boxes started.
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { decodeAddress } from "algosdk"
import { algorand, sdk, MAINNET_REGISTRY } from "./common.js"
import { encodeCall, encodeOpts, READER_PROGRAM, READER_CLEAR_PROGRAM, DEFAULT_FIELDS } from "../src/reader.js"
import { addressLsigAddress } from "../src/lsig.js"

const NODE = "http://127.0.0.1:8081"
const OWNER = "43H6L4VKWP23F3UO64GUS4M5TFT5MOZRJPUFO57M3X2SDONQXJCT5MQZRE"

// 1. cost of one ownedBy call over 128 owned NFDs with every field
const owned = (await sdk.getOwned(OWNER)).map((r) => r.appId).slice(0, 128)
const packed = new Uint8Array(owned.length * 8)
owned.forEach((id, i) => new DataView(packed.buffer).setBigUint64(i * 8, id))
const opts = encodeOpts(DEFAULT_FIELDS, 40, 65_000)
const [r1] = await algorand.query.run({
  program: READER_PROGRAM, clearProgram: READER_CLEAR_PROGRAM,
  calls: [{ args: encodeCall("ownedBy", [MAINNET_REGISTRY, OWNER, packed, new Uint8Array(), 0n, 0n, 128n, opts]) }],
})
const c = r1.calls[0]
console.log(`ownedBy over ${owned.length} owned NFDs: ${c.ok ? `cost ${c.cost}, ${c.logs.length} logs, ${c.logs.reduce((n, l) => n + l.length, 0)} bytes` : c.error.failureMessage}`)

// 2. reverse candidate counts across addresses.txt (registry box length / 8)
const addresses = readFileSync("addresses.txt", "utf8").trim().split("\n")
const sizes = await Promise.all(addresses.map(async (a) => {
  const key = createHash("sha256").update(Buffer.concat([Buffer.from("addr/algo/"), Buffer.from(decodeAddress(a).publicKey)])).digest()
  const res = await fetch(`${NODE}/v2/applications/${MAINNET_REGISTRY}/box?name=${encodeURIComponent("b64:" + key.toString("base64"))}`)
  return res.ok ? Buffer.from(((await res.json()) as any).value, "base64").length / 8 : 0
}))
const top = addresses.map((a, i) => [a, sizes[i]] as const).sort((x, y) => y[1] - x[1]).slice(0, 3)
console.log("largest reverse boxes:", top.map(([a, n]) => `${a.slice(0, 8)}=${n}`).join(" "))
const [r2] = await algorand.query.run({
  program: READER_PROGRAM, clearProgram: READER_CLEAR_PROGRAM,
  calls: top.map(([a]) => ({ args: encodeCall("reverseLookup", [MAINNET_REGISTRY, a, addressLsigAddress(MAINNET_REGISTRY, a), 0n, 0n, 128n, opts]) })),
})
r2.calls.forEach((c, i) => console.log(`  reverseLookup ${top[i][0].slice(0, 8)}: ${c.ok ? `cost ${c.cost}, ${c.logs.length} logs` : c.error.failureMessage}`))

// 3. the first round with any "O" owner box in the registry (binary search on a prefix listing)
const hasOwnerBoxes = async (round: bigint) => {
  const res = await fetch(`${NODE}/v2/applications/${MAINNET_REGISTRY}/boxes?prefix=b64:${encodeURIComponent(Buffer.from("O").toString("base64"))}&round=${round}&limit=1`)
  const j = (await res.json()) as any
  return (j.boxes ?? []).length > 0
}
let lo = 42_181_254n
let hi = BigInt(((await (await fetch(`${NODE}/v2/status`)).json()) as any)["last-round"])
if (await hasOwnerBoxes(lo)) console.log("owner boxes exist from the third registry generation on")
else {
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n
    if (await hasOwnerBoxes(mid)) hi = mid
    else lo = mid
  }
  console.log(`first "O" owner box at round ${hi}`)
}
