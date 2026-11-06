// Keep the fork versions in step across the package, the lockfile and the README, and check them before a release.
//
// Usage:
//   node scripts/release.mjs update        rewrite the README's fork versions to the devDependencies'
//   node scripts/release.mjs check [tag]   fail if the version, the tag, the forks or the README disagree
//
// The SDK builds and tests against one exact dt-algosdk and dt-algokit-utils, installed under the stock names:
// devDependencies `npm:<fork>@<version>`, the same in pnpm-workspace.yaml's overrides and the lockfile, and a peer
// range `^<version>` that accepts them. The README's install snippets name those versions.
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (file) => readFileSync(join(root, file), "utf8")

const NAME = "nfd-ghost-sdk"
const DOCS = ["README.md"]
const REPOSITORY = "git+https://github.com/d13co/nfd-ghost-sdk.git"
const FORMAT = "<x.y.z>-dt.<n>"
const VERSION_FORMAT = /^\d+\.\d+\.\d+-dt\.\d+$/
const DT_VERSION = /\d+\.\d+\.\d+-dt(?:\.\d+)+/.source
const FORKS = [
  { name: "algosdk", fork: "dt-algosdk" },
  { name: "@algorandfoundation/algokit-utils", fork: "@d13co/dt-algokit-utils" },
]
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
// dt-algosdk@3.9.0-dt.5.2.0.0, but not as part of @d13co/dt-algosdk-something
const docRef = (fork) => new RegExp(`(?<![\\w@/-])${escape(fork)}@(${DT_VERSION})`, "g")

const [mode, tag] = process.argv.slice(2)
const pkg = JSON.parse(read("package.json"))
const { version } = pkg
const pinned = (name, fork) => new RegExp(`^npm:${escape(fork)}@(${DT_VERSION})$`).exec(pkg.devDependencies?.[name] ?? "")?.[1]

if (mode === "update") {
  for (const file of DOCS) {
    let text = read(file)
    const before = text
    for (const { name, fork } of FORKS) {
      const v = pinned(name, fork)
      if (!v) {
        console.error(`devDependencies["${name}"] is not npm:${fork}@<exact dt version>`)
        process.exit(1)
      }
      text = text.replace(docRef(fork), `${fork}@${v}`)
    }
    writeFileSync(join(root, file), text)
    console.log(`${file}: ${text === before ? "unchanged" : "updated"}`)
  }
} else if (mode === "check") {
  const errors = []
  if (pkg.name !== NAME) errors.push(`package.json name is ${pkg.name}`)
  if (!VERSION_FORMAT.test(version)) errors.push(`version ${version} is not ${FORMAT}`)
  if (tag && tag !== `v${version}`) errors.push(`tag ${tag} is not v${version}`)
  if (pkg.publishConfig?.tag !== "latest") errors.push(`publishConfig.tag is ${pkg.publishConfig?.tag}, not latest`)
  // npm's provenance check matches it against the repository the workflow runs in
  if (pkg.repository?.url !== REPOSITORY) errors.push(`repository.url is ${pkg.repository?.url}, not ${REPOSITORY}`)

  const workspace = read("pnpm-workspace.yaml")
  const lock = read("pnpm-lock.yaml")
  const lockOverrides = /^overrides:\n((?: {2}.+\n)+)/m.exec(lock)?.[1] ?? ""
  for (const { name, fork } of FORKS) {
    const v = pinned(name, fork)
    if (!v) {
      errors.push(`devDependencies["${name}"] is ${pkg.devDependencies?.[name]}, not npm:${fork}@<exact dt version>`)
      continue
    }
    const spec = `npm:${fork}@${v}`
    const key = new RegExp(`^\\s+'?${escape(name)}'?: ${escape(spec)}$`, "m")
    if (!key.test(workspace)) errors.push(`pnpm-workspace.yaml doesn't override ${name} with ${spec}`)
    if (!key.test(lockOverrides)) errors.push(`pnpm-lock.yaml doesn't override ${name} with ${spec}: run pnpm install`)
    const peer = pkg.peerDependencies?.[name]
    if (peer !== `^${v}`) errors.push(`peerDependencies["${name}"] is ${peer}, not ^${v}`)
    for (const file of DOCS)
      for (const [ref, found] of read(file).matchAll(docRef(fork))) if (found !== v) errors.push(`${file}: ${ref} is not ${v}`)
  }

  if (errors.length) {
    errors.forEach((e) => console.error(e))
    console.error("Set the versions in package.json and pnpm-workspace.yaml, run pnpm install, then node scripts/release.mjs update")
    process.exit(1)
  }
  const forks = FORKS.map(({ name, fork }) => `${fork}@${pinned(name, fork)}`).join(", ")
  console.log(`${NAME} ${version} (${forks}) is consistent${tag ? ` with ${tag}` : ""}`)
} else {
  console.error("Usage: release.mjs update | check [tag]")
  process.exit(1)
}
