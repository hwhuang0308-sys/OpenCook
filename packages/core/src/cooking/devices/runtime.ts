export * as KitchenRuntime from "./runtime.js"

import path from "node:path"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { Global } from "@opencook/util/global"
import binding, { type Asset } from "./runtime-binding.js"

const pending = new Map<string, Promise<string>>()

export async function serial() {
  if (process.env.OPENCOOK_SERIAL_MODULE_PATH && process.env.OPENCOOK_SERIAL_BINDING_PATH)
    return { module: process.env.OPENCOOK_SERIAL_MODULE_PATH, binding: process.env.OPENCOOK_SERIAL_BINDING_PATH }
  if (!binding) return
  return {
    module: await materialize(binding.serial.module),
    binding: await materialize(binding.serial.binding),
  }
}

function materialize(asset: Asset) {
  const key = `${asset.sha256}/${path.basename(asset.path)}`
  const cached = pending.get(key)
  if (cached) return cached
  const task = (async () => {
    const directory = path.join(Global.Path.cache, "kitchen-runtime", asset.sha256)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await fs.lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()))
      throw new Error("Unsafe kitchen runtime directory")
    const target = path.join(directory, path.basename(asset.path))
    const present = await fs.readFile(target).catch(() => undefined)
    if (present && createHash("sha256").update(present).digest("hex") === asset.sha256) return target
    const bytes = await Bun.file(asset.path).bytes()
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
      throw new Error("Kitchen runtime asset checksum mismatch")
    const temporary = `${target}.${crypto.randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, bytes, { mode: 0o600, flag: "wx" })
      await fs.rename(temporary, target)
    } finally {
      await fs.rm(temporary, { force: true })
    }
    return target
  })()
  pending.set(key, task)
  void task.catch(() => pending.delete(key))
  return task
}
