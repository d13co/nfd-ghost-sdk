// Stamps a `type` marker into each dist subdirectory so Node treats the ESM
// output as modules and the CJS output as CommonJS, regardless of the `type`
// declared by the root package.json.
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const dist = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist")

for (const [dir, type] of [
  ["esm", "module"],
  ["cjs", "commonjs"],
]) {
  writeFileSync(join(dist, dir, "package.json"), `${JSON.stringify({ type }, null, 2)}\n`)
}
