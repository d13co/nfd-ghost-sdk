// Cross-checks the SDK at the latest round against the NFD REST API (api.nf.domains):
// - reverse lookups of every address in addresses.txt (the API's primary NFD vs ours)
// - records of v1-nfds.txt and a sample of all-nfd-apps.csv (owner, state, verified addresses, avatar, parent)
import { readFileSync } from "node:fs"
import { sdk } from "./common.js"

const API = "https://api.nf.domains"
const SAMPLE = Number(process.env.SAMPLE ?? 600)

async function api(path: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path)
    if (res.status === 404) return undefined
    if (res.status === 429 || res.status >= 500) {
      if (attempt > 6) throw new Error(`${path}: ${res.status}`)
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
      continue
    }
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
    return res.json()
  }
}

async function pool<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await f(items[i])
    }
  }))
  return out
}

let mismatches = 0
const report = (what: string) => {
  mismatches++
  console.log("MISMATCH", what)
}

// reverse
{
  const addresses = readFileSync("addresses.txt", "utf8").trim().split("\n")
  let t = Date.now()
  const ours = await sdk.reverseLookup(addresses)
  console.log(`reverseLookup(${addresses.length}): ${Date.now() - t} ms`)
  t = Date.now()
  const batches: string[][] = []
  for (let i = 0; i < addresses.length; i += 20) batches.push(addresses.slice(i, i + 20))
  const theirs = Object.assign(
    {},
    ...(await pool(batches, 4, (b) => api(`/nfd/lookup?${b.map((a) => `address=${a}`).join("&")}&view=thumbnail&allowUnverified=false`))).map((r) => r ?? {}),
  ) as Record<string, { name: string; appID: number }>
  console.log(`REST lookups: ${Date.now() - t} ms`)
  let same = 0
  for (const address of addresses) {
    const mine = ours.get(address) ?? []
    const rest = theirs[address]
    if (!rest && mine.length === 0) { same++; continue }
    if (rest && mine[0]?.name === rest.name) { same++; continue }
    const inList = rest && mine.some((r) => r.name === rest.name)
    report(`reverse ${address}: REST ${rest?.name ?? "(none)"}, ours [${mine.map((r) => `${r.name}:${r.state}`).join(", ")}]${inList ? " (REST's is in our list)" : ""}`)
  }
  console.log(`reverse: ${same}/${addresses.length} agree on the primary NFD`)
}

// records
{
  const v1 = readFileSync("v1-nfds.txt", "utf8").trim().split("\n")
  const csv = readFileSync("all-nfd-apps.csv", "utf8").trim().split("\n").slice(1).map((l) => l.split(","))
  const sample = csv.sort(() => Math.random() - 0.5).slice(0, SAMPLE).map((r) => r[1])
  const names = [...v1, ...sample]
  let t = Date.now()
  const ours = await sdk.resolveNames(names)
  console.log(`resolveNames(${names.length}): ${Date.now() - t} ms`)
  t = Date.now()
  const theirs = await pool(names, 6, (n) => api(`/nfd/${n}?view=brief&poll=false`))
  console.log(`REST records: ${Date.now() - t} ms`)
  let same = 0
  names.forEach((name, i) => {
    const mine = ours.get(name)
    const rest = theirs[i]
    if (!rest) {
      if (mine) report(`${name}: REST has none, ours ${mine.appId}`)
      else same++
      return
    }
    if (!mine) return report(`${name}: REST ${rest.appID}, ours none`)
    const problems: string[] = []
    if (BigInt(rest.appID) !== mine.appId) problems.push(`appId ${rest.appID} vs ${mine.appId}`)
    if (rest.owner && rest.owner !== mine.owner) problems.push(`owner ${rest.owner} vs ${mine.owner}`)
    const restState = rest.state === "expired" || rest.expired ? "expired" : rest.state
    const ourState = mine.state
    const stateOk = restState === ourState || (restState === "owned" && ourState === "owned") || (restState === "forSale" && ourState === "forSale")
    if (!stateOk) problems.push(`state ${rest.state}${rest.expired ? "(expired)" : ""} vs ${mine.state}`)
    const restCa = (rest.caAlgo ?? []).join(",")
    if (ourState !== "expired" && ourState !== "forSale" && restCa !== mine.caAlgo.join(",")) problems.push(`caAlgo [${restCa}] vs [${mine.caAlgo.join(",")}]`)
    const restAvatar = rest.properties?.userDefined?.avatar || rest.properties?.verified?.avatar
    if (ourState === "owned" && (restAvatar ?? "") !== (mine.avatar ?? "")) problems.push(`avatar ${restAvatar} vs ${mine.avatar}`)
    if ((rest.parentAppID ? BigInt(rest.parentAppID) : null) !== mine.parentAppId) problems.push(`parent ${rest.parentAppID} vs ${mine.parentAppId}`)
    if (problems.length) report(`${name}: ${problems.join("; ")}`)
    else same++
  })
  console.log(`records: ${same}/${names.length} agree`)
}
console.log(mismatches ? `${mismatches} mismatches` : "no mismatches")
