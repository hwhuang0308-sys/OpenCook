import { createRequire } from "node:module"
import path from "node:path"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"

const require = createRequire(new URL("../../core/package.json", import.meta.url))

export async function kitchenAssets(target: { os: string; arch: string; abi?: string }, directory: string) {
  await fs.mkdir(directory, { recursive: true })
  const entry = require.resolve("serialport")
  const serial = path.join(directory, "serialport.cjs")
  const built = await Bun.build({
    entrypoints: [entry],
    target: "node",
    format: "cjs",
    packages: "bundle",
    plugins: [
      {
        name: "serial-native-binding",
        setup(build) {
          build.onLoad({ filter: /bindings-cpp[/\\]dist[/\\]serialport-bindings\.js$/ }, () => ({
            loader: "js",
            contents: "exports.binding = require(process.argv[4])",
          }))
        },
      },
    ],
  })
  if (!built.success) throw new AggregateError(built.logs, "Cannot bundle serial driver")
  await Bun.write(serial, built.outputs[0])
  const root = path.dirname(createRequire(entry).resolve("@serialport/bindings-cpp/package.json"))
  const platform = target.os === "darwin" ? "darwin-x64+arm64" : `${target.os}-${target.arch}`
  const prebuilds = path.join(root, "prebuilds", platform)
  const native = (await fs.readdir(prebuilds)).find(
    (file) => file.endsWith(".node") && (target.os !== "linux" || file.includes(target.abi ?? "glibc")),
  )
  if (!native) throw new Error(`No serial driver for ${platform}/${target.abi ?? "default"}`)
  return {
    serial: { module: await asset(serial), binding: await asset(path.join(prebuilds, native)) },
  }
}

async function asset(file: string) {
  return {
    path: file,
    sha256: createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex"),
  }
}
