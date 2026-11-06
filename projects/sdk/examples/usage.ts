// The SDK's lookups at the latest round and at a past one.
import { sdk, short } from "./common.js"

const round = 45_000_000n
const owner = "43H6L4VKWP23F3UO64GUS4M5TFT5MOZRJPUFO57M3X2SDONQXJCT5MQZRE"

console.log("supported:", await sdk.supported())

const king = await sdk.getRecord(1013764620n)
console.log("getRecord:", king?.name, king?.version, king?.state, king?.avatar)

const past = sdk.atRound(round)
console.log(`resolveName at ${round}:`, (await past.resolveName("king.dragonfi.algo"))?.version)

const reverse = await sdk.reverseLookup([owner, king!.owner])
for (const [address, nfds] of reverse) console.log("reverseLookup:", short(address), nfds.map((n) => n.name))

const owned = await sdk.getOwned(owner)
console.log("getOwned:", owned.length, "NFDs, e.g.", owned.slice(0, 3).map((n) => n.name))

const segments = await sdk.getSegmentsFor(king!.owner, king!.parentAppId!)
console.log("getSegmentsFor:", segments.map((n) => n.name))

const series = await sdk.getRecordsSeries([1013764620n], { from: 26_400_000, to: 66_000_000, points: 8 })
for (const point of series) {
  const r = point.ok ? point.value.get(1013764620n) : undefined
  console.log("series:", point.round, point.ok ? `${r?.version} ${short(r?.owner ?? "")} caAlgo=${r?.caAlgo.length}` : point.error.message)
}
