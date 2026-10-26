export * as PhotonModule from "./photon-module.js"

import photonWasm from "#photon-wasm"
import { Effect } from "effect"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const load = Effect.tryPromise({
  try: async () => {
    if (!photonWasm) throw new Error("Image encoding is unavailable in this runtime")
    ;(globalThis as typeof globalThis & { __OPENCOOK_PHOTON_WASM_PATH?: string }).__OPENCOOK_PHOTON_WASM_PATH =
      path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url))
    return await import("@silvia-odwyer/photon-node")
  },
  catch: (cause) => new Error("无法加载图像编码器", { cause }),
})
