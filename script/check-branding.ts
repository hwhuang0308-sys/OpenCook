#!/usr/bin/env bun
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const result = Bun.spawnSync(["git", "ls-files", "-c", "-o", "--exclude-standard", "-z"], { cwd: root })
if (result.exitCode !== 0) throw new Error("Cannot enumerate product sources")
const failures: string[] = []
for (const file of new Set(result.stdout.toString().split("\0").filter(Boolean))) {
  if (file === "NOTICE" || path.basename(file) === "LICENSE" || file === "script/check-branding.ts") continue
  if (file.includes("/test/") || file.includes("/component-tests/")) continue
  const source = Bun.file(path.join(root, file))
  if (!(await source.exists())) continue
  if (/\.(?:png|jpg|jpeg|webp|gif|mp3|wav|woff2?|ttf|zip|pdf)$/.test(file)) continue
  const content = (await source.text())
    .replaceAll(/@opencode-ai\/pty(?:-[a-z0-9-]+)?/g, "")
    .replaceAll("opencode-pty", "")
  // README attribution is intentional; other upstream product identifiers remain disallowed.
  const product =
    file === "README.md" || file === "README.zh.md"
      ? content.replaceAll("[OpenCode](https://github.com/anomalyco/opencode)", "")
      : content
  if (/opencode|OpenCode|OPENCODE/.test(product) || /opencode|OpenCode|OPENCODE/.test(file)) failures.push(file)
}
if (failures.length) {
  console.error("Unexpected upstream product identifiers:\n" + failures.join("\n"))
  process.exit(1)
}
console.log("OpenCook product identifiers verified")
