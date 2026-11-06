// Fails if dist/ uses Node-only APIs: apps bundle the SDK for the browser (Vite), so it may not import node:
// modules or Node builtins, nor use Buffer.
import { readdirSync, readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dist = join(root, "dist")
const builtins = new Set(builtinModules)
const files = readdirSync(dist, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith(".js"))

const errors = []
for (const file of files) {
  const text = readFileSync(join(dist, file), "utf8")
  for (const [, spec] of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm))
    if (spec.startsWith("node:") || builtins.has(spec)) errors.push(`${relative(root, join(dist, file))}: imports ${spec}`)
  if (/\bBuffer\b/.test(text)) errors.push(`${relative(root, join(dist, file))}: uses Buffer`)
}

if (!files.length) errors.push("dist/ has no .js files: run pnpm build first")
if (errors.length) {
  errors.forEach((e) => console.error(e))
  process.exit(1)
}
console.log(`dist/: ${files.length} files, browser-safe`)
