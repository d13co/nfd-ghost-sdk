// The fixtures of DESIGN-v2.md section 6, checked through the SDK. Exits non-zero on a mismatch.
import { short, sdk } from "./common.js"
import type { NfdRecord } from "../src/index.js"

const OWNER_818 = "43H6L4VKWP23F3UO64GUS4M5TFT5MOZRJPUFO57M3X2SDONQXJCT5MQZRE"
let failures = 0
function check(what: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`)
  if (!ok) failures++
}
const show = (r: NfdRecord | null | undefined) =>
  r ? `${r.name} v${r.version} ${r.state} owner=${short(r.owner)} caAlgo=[${r.caAlgo.map(short)}] avatar=${r.avatar ? "yes" : "no"}` : String(r)

console.log("supported:", await sdk.supported())

// 818.algo, v1 at the latest round
{
  const r = await sdk.resolveName("818.algo")
  check("818.algo forward", r?.appId === 864806088n, show(r))
  check("818.algo caAlgo from global", r?.caAlgo[0] === OWNER_818)
  const rev = (await sdk.reverseLookup([OWNER_818])).get(OWNER_818)!
  check("818.algo reverse through the lsig", rev.some((x) => x.appId === 864806088n), rev.map((x) => x.name).join(", "))
}

// king.dragonfi.algo across generations
{
  const id = 1013764620n
  const at = async (round: bigint) => sdk.getRecord(id, { round })
  const r30 = await at(30_000_000n)
  check("king.dragonfi 30M: v1, global caAlgo", r30?.major === 1 && r30.caAlgo.length === 1, show(r30))
  const r33 = await at(33_000_000n)
  check("king.dragonfi 33M: v2, box caAlgo", r33?.major === 2 && r33.caAlgo.length === 1, show(r33))
  const r40 = await at(40_000_000n)
  check("king.dragonfi 40M: v2, no caAlgo", r40?.major === 2 && r40.caAlgo.length === 0, show(r40))
  const r46 = await at(46_000_000n)
  check("king.dragonfi 46M: v2, caAlgo", r46?.major === 2 && r46.caAlgo.length === 1, show(r46))
  const latest = await sdk.getRecord(id)
  check("king.dragonfi latest: u.avatar", !!latest?.avatar, show(latest))
}

// batmanmarkets.algo: v3.4 at 43M, v3.7 expired at the latest round
{
  const id = 2318360299n
  const r43 = await sdk.getRecord(id, { round: 43_000_000n })
  check("batmanmarkets 43M: v3.4, not expired", r43?.version === "3.4" && r43.state !== "expired", show(r43))
  const latest = await sdk.getRecord(id)
  check("batmanmarkets latest: expired", latest?.state === "expired", show(latest))
  const owner = latest!.owner
  const rev = (await sdk.reverseLookup([owner])).get(owner)!
  check("batmanmarkets excluded from its owner's reverse", !rev.some((x) => x.appId === id), `${rev.length} NFDs`)
}

// 22T47MKF…: registry reverse box present / absent / present
{
  const address = "22T47MKF2YHPJVOJN4PKSAD5EPRBWWL4VZ4G6I6XIDFI5FS7OZYYY3PPWU"
  for (const round of [33_000_000n, 43_000_000n, undefined]) {
    const rev = (await sdk.reverseLookup([address], { round })).get(address)!
    console.log(`     22T47MKF at ${round ?? "latest"}: ${rev.map((x) => x.name).join(", ") || "(none)"}`)
  }
}

// building.algo for 43H6L4VK…: in its owner boxes, holds the ASA, but not the owner
{
  const owned = await sdk.getOwned(OWNER_818)
  check("building.algo not owned by 43H6L4VK", !owned.some((x) => x.appId === 2526143532n), `${owned.length} owned`)
  check("everything getOwned returns is owned by 43H6L4VK", owned.every((x) => x.owner === OWNER_818))
  const at50 = await sdk.getOwned(OWNER_818, { round: 50_000_000n })
  console.log(`     43H6L4VK owned at 50M: ${at50.length}`)
}

// bakare.algo: owned although the ASA sits in the app
{
  const bakare = await sdk.getRecord(3296744483n)
  const owned = await sdk.getOwned(bakare!.owner)
  check("bakare.algo owned through owner boxes", owned.some((x) => x.appId === 3296744483n), `owner ${short(bakare!.owner)}, ${owned.length} owned`)
}

// before the second registry generation: lsig answers, no errors
{
  const r = await sdk.resolveName("king.dragonfi.algo", { round: 30_000_000n })
  check("name at 30M through the v1 lsig", r?.appId === 1013764620n, show(r))
  const rev = (await sdk.reverseLookup([OWNER_818], { round: 30_000_000n })).get(OWNER_818)!
  check("reverse at 30M through the v1 lsig", rev.some((x) => x.appId === 864806088n))
}

// an app created after R, a deleted app
{
  const future = await sdk.getRecord(3296744483n, { round: 30_000_000n })
  check("an app created after R is null", future === null)
  const missing = await sdk.getRecord(99_999_999_999n)
  check("an app that doesn't exist is null", missing === null)
}

// round checks
{
  const before = await sdk.getRecord(1n, { round: 1_000n }).catch((e) => e)
  check("before the registry: NfdNotDeployedError", before?.name === "NfdNotDeployedError", before?.message)
  const future = await sdk.getRecord(1n, { round: 10n ** 12n }).catch((e) => e)
  check("past the tip: FutureRoundError", future?.name === "FutureRoundError", future?.message)
}

console.log(failures ? `\n${failures} failed` : "\nall passed")
process.exit(failures ? 1 : 0)
