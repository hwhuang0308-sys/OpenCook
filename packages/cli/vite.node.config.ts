import path from "node:path"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { defineConfig, type Plugin, type UserConfig } from "vite"
import solid from "vite-plugin-solid"
import { nodeExecArgv, nodeTarget, type NodeTarget, photonWasmAsset, shellParserWasmAssets } from "./src/node/target"
import { verifySimulationGraph } from "./script/verify-artifact"

const dir = import.meta.dirname

function rawTextPlugin(): Plugin {
  return {
    name: "opencook:raw-text",
    // "pre" is load-bearing for .txt: Vite's built-in asset plugin claims
    // known asset types (.txt among them) ahead of normal-priority plugins,
    // replacing the import with an asset URL string instead of the content.
    // .md only ever worked without it because .md is not a known asset type.
    enforce: "pre",
    async load(id) {
      if (!id.endsWith(".md") && !id.endsWith(".txt")) return
      return `export default ${JSON.stringify(await readFile(id, "utf8"))}`
    },
  }
}

function runtimeRequirePlugin(): Plugin {
  return {
    name: "opencook:runtime-require",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith("turndown/lib/turndown.es.js")) return
      const transformed = code.replace("    var domino = require('@mixmark-io/domino');", "")
      if (transformed === code) this.error("Failed to rewrite Turndown's Domino require")
      return `import domino from "@mixmark-io/domino"\n${transformed}`
    },
  }
}

function simulationGraphPlugin(): Plugin {
  return {
    name: "opencook:simulation-graph",
    generateBundle() {
      verifySimulationGraph(this.getModuleIds())
    },
  }
}

function fffNodePlugin(): Plugin {
  return {
    name: "opencook:fff-node",
    enforce: "pre",
    transform(code, id) {
      const normalized = id.replaceAll("\\", "/")
      if (normalized.endsWith("/ffi-rs/index.js")) {
        const start = code.indexOf("if (!nativeBinding) {")
        if (start === -1) this.error("Failed to rewrite ffi-rs native binding loader")
        return `const unavailable = () => { throw new Error("ffi-rs native binding unavailable") }
const nativeBinding = globalThis.__OPENCOOK_FFF_FFI ?? {
  DataType: new Proxy({}, { get: (target, key) => target[key] ?? key }),
  PointerType: {},
  FFITypeTag: {},
  open: unavailable,
  close: unavailable,
  load: unavailable,
  isNullPointer: unavailable,
  createPointer: unavailable,
  restorePointer: unavailable,
  unwrapPointer: unavailable,
  wrapPointer: unavailable,
  freePointer: unavailable,
}
const loadError = undefined
${code.slice(start)}`
      }
      if (!normalized.endsWith("/fff-node/dist/src/binary.js")) return
      const transformed = code.replace(
        "export function findBinary() {",
        "export function findBinary() { if (process.env.FFF_BINARY_PATH) return process.env.FFF_BINARY_PATH;",
      )
      if (transformed === code) this.error("Failed to rewrite FFF binary loader")
      return transformed
    },
  }
}

const resolve = {
  alias: [
    { find: /^solid-js\/store$/, replacement: "solid-js/store/dist/store.js" },
    { find: /^solid-js$/, replacement: "solid-js/dist/solid.js" },
    {
      find: /^ws$/,
      replacement: path.join(path.dirname(createRequire(import.meta.url).resolve("ws/package.json")), "wrapper.mjs"),
    },
  ],
  conditions: ["node"],
}

const output = (entryFileNames: string, banner?: string) => ({
  format: "esm" as const,
  entryFileNames,
  inlineDynamicImports: true,
  banner,
})

function nodePrelude(input: NodeBuildInput) {
  const nodePtySpawnHelper =
    input.target.platform === "darwin"
      ? `${input.target.nodePtyPackage}/prebuilds/darwin-${input.target.arch}/spawn-helper`
      : undefined
  const opencookPtyAsset = input.target.opencookPtyAsset
  const promiseModule = `const sdk = globalThis[Symbol.for("opencook.plugin.v2.promise")]
if (!sdk) throw new Error("OpenCook Promise plugin SDK is unavailable")
export const Agent = sdk.Agent
export const Command = sdk.Command
export const Connection = sdk.Connection
export const Credential = sdk.Credential
export const Integration = sdk.Integration
export const Model = sdk.Model
export const Plugin = sdk.Plugin
export const Provider = sdk.Provider
export const Reference = sdk.Reference
export const Skill = sdk.Skill`
  const effectModule = promiseModule
    .replace("opencook.plugin.v2.promise", "opencook.plugin.v2.effect")
    .replace("Promise plugin", "Effect plugin")
  const promisePluginModule = `const sdk = globalThis[Symbol.for("opencook.plugin.v2.promise")]
if (!sdk) throw new Error("OpenCook Promise plugin SDK is unavailable")
export const define = sdk.Plugin.define`
  const effectPluginModule = promisePluginModule
    .replace("opencook.plugin.v2.promise", "opencook.plugin.v2.effect")
    .replace("Promise plugin", "Effect plugin")
  const promiseToolModule = `export {}`
  const effectToolModule = `const sdk = globalThis[Symbol.for("opencook.plugin.v2.effect")]
if (!sdk) throw new Error("OpenCook Effect plugin SDK is unavailable")
export const Error = sdk.Tool.Error
`
  return `#!/usr/bin/env -S node ${nodeExecArgv.join(" ")}
import __cjs_mod__ from "node:module"
import { chmodSync as __ocChmod, existsSync as __ocExists, lstatSync as __ocLstat, mkdirSync as __ocMkdir, renameSync as __ocRename, rmSync as __ocRm, writeFileSync as __ocWrite } from "node:fs"
import { tmpdir as __ocTmpdir } from "node:os"
import __ocPath from "node:path"
import { getAssetKeys as __ocAssetKeys, getRawAsset as __ocRawAsset, isSea as __ocIsSea } from "node:sea"
import { fileURLToPath as __ocFileURLToPath } from "node:url"
const __filename = import.meta.filename
const __dirname = import.meta.dirname
const require = __cjs_mod__.createRequire(import.meta.url)
const __ocPluginModules = ${JSON.stringify({
    "@opencook/plugin": "opencook:plugin-v2",
    "@opencook/plugin/promise/plugin": "opencook:plugin-promise-plugin",
    "@opencook/plugin/promise/tool": "opencook:plugin-promise-tool",
    "@opencook/plugin/effect": "opencook:plugin-v2-effect",
    "@opencook/plugin/effect/plugin": "opencook:plugin-v2-effect-plugin",
    "@opencook/plugin/effect/tool": "opencook:plugin-v2-effect-tool",
  })}
const __ocPluginSources = ${JSON.stringify({
    "opencook:plugin-v2": promiseModule,
    "opencook:plugin-promise-plugin": promisePluginModule,
    "opencook:plugin-promise-tool": promiseToolModule,
    "opencook:plugin-v2-effect": effectModule,
    "opencook:plugin-v2-effect-plugin": effectPluginModule,
    "opencook:plugin-v2-effect-tool": effectToolModule,
  })}
__cjs_mod__.registerHooks({
  resolve(__ocSpecifier, __ocContext, __ocNextResolve) {
    const __ocUrl = __ocPluginModules[__ocSpecifier]
    return __ocUrl ? { url: __ocUrl, shortCircuit: true } : __ocNextResolve(__ocSpecifier, __ocContext)
  },
  load(__ocUrl, __ocContext, __ocNextLoad) {
    const __ocSource = __ocPluginSources[__ocUrl]
    return __ocSource
      ? { format: "module", source: __ocSource, shortCircuit: true }
      : __ocNextLoad(__ocUrl, __ocContext)
  },
})
const __ocUid = typeof process.getuid === "function" ? process.getuid() : undefined
const __ocCacheRoot = __ocPath.join(__ocTmpdir(), \`opencook-node-\${__ocUid ?? "user"}\`)
if (__ocIsSea()) {
  try {
    __ocMkdir(__ocCacheRoot, { mode: 0o700 })
  } catch (__ocError) {
    if (!__ocExists(__ocCacheRoot)) throw __ocError
  }
  const __ocCacheInfo = __ocLstat(__ocCacheRoot)
  if (!__ocCacheInfo.isDirectory() || __ocCacheInfo.isSymbolicLink()) throw new Error("Unsafe Node asset cache path")
  if (__ocUid !== undefined && __ocCacheInfo.uid !== __ocUid) throw new Error("Node asset cache is owned by another user")
  if (__ocUid !== undefined) __ocChmod(__ocCacheRoot, 0o700)
}
const __ocAssetRoot = __ocIsSea()
  ? __ocPath.join(__ocCacheRoot, ${JSON.stringify(`${input.assetHash}-${input.target.platform}-${input.target.arch}`)})
  : __ocFileURLToPath(new URL("./assets/", import.meta.url))
const __ocPersistentPty = ${JSON.stringify(opencookPtyAsset)}
if (__ocIsSea()) {
  const __ocPtySpawnHelper = ${JSON.stringify(nodePtySpawnHelper)}
  for (const __ocKey of __ocAssetKeys()) {
    const __ocTarget = __ocPath.join(__ocAssetRoot, __ocKey)
    if (__ocExists(__ocTarget)) continue
    __ocMkdir(__ocPath.dirname(__ocTarget), { recursive: true })
    const __ocTemporary = \`${"${__ocTarget}"}.${"${process.pid}"}.${"${crypto.randomUUID()}"}.tmp\`
    __ocWrite(__ocTemporary, new Uint8Array(__ocRawAsset(__ocKey)))
    if ((__ocKey === __ocPtySpawnHelper || __ocKey === __ocPersistentPty) && process.platform !== "win32")
      __ocChmod(__ocTemporary, 0o755)
    try {
      __ocRename(__ocTemporary, __ocTarget)
    } catch (__ocError) {
      __ocRm(__ocTemporary, { force: true })
      if (!__ocExists(__ocTarget)) throw __ocError
    }
  }
}
process.env.OPENCOOK_NODE_ASSETS_DIR = __ocAssetRoot
process.env.OPENCOOK_SERIAL_MODULE_PATH = __ocPath.join(__ocAssetRoot, "kitchen/serialport.cjs")
process.env.OPENCOOK_SERIAL_BINDING_PATH = __ocPath.join(__ocAssetRoot, "kitchen/serialport.node")
process.env.OTUI_ASSET_ROOT = __ocAssetRoot
process.env.OPENCOOK_NODE_PTY_PATH = __ocPath.join(__ocAssetRoot, ${JSON.stringify(input.target.nodePtyEntryAsset)})
process.env.OPENCOOK_PARCEL_WATCHER_PATH = __ocPath.join(__ocAssetRoot, ${JSON.stringify(input.target.parcelWatcherAsset)})
process.env.OPENCOOK_PHOTON_WASM_PATH = __ocPath.join(__ocAssetRoot, ${JSON.stringify(photonWasmAsset)})
process.env.OPENCOOK_TREE_SITTER_WASM_PATH = __ocPath.join(__ocAssetRoot, ${JSON.stringify(shellParserWasmAssets.runtime)})
process.env.OPENCOOK_TREE_SITTER_BASH_WASM_PATH = __ocPath.join(__ocAssetRoot, ${JSON.stringify(shellParserWasmAssets.bash)})
process.env.OPENCOOK_TREE_SITTER_POWERSHELL_WASM_PATH = __ocPath.join(__ocAssetRoot, ${JSON.stringify(shellParserWasmAssets.powershell)})
process.env.FFF_BINARY_PATH = __ocPath.join(__ocAssetRoot, ${JSON.stringify(input.target.fffAsset)})
process.env.OPENCOOK_FFF_FFI_PATH = __ocPath.join(__ocAssetRoot, ${JSON.stringify(input.target.fffFfiAsset)})
if (__ocPersistentPty && !process.env.OPENCOOK_PTY_BIN) process.env.OPENCOOK_PTY_BIN = __ocPath.join(__ocAssetRoot, __ocPersistentPty)
try {
  globalThis.__OPENCOOK_FFF_FFI = require(process.env.OPENCOOK_FFF_FFI_PATH)
} catch {}
globalThis.__OPENCOOK_PHOTON_WASM_PATH = process.env.OPENCOOK_PHOTON_WASM_PATH
if (process.platform === "linux") process.env.OPENTUI_LIBC = "glibc"`
}

export type NodeBuildInput = {
  readonly version: string
  readonly channel: string
  readonly highlights?: string
  readonly assetHash: string
  readonly target: NodeTarget
}

export function mainConfig(input: NodeBuildInput): UserConfig {
  return defineConfig({
    root: dir,
    plugins: [
      rawTextPlugin(),
      runtimeRequirePlugin(),
      fffNodePlugin(),
      simulationGraphPlugin(),
      solid({
        solid: {
          generate: "universal",
          moduleName: "@opentui/solid",
        },
      }),
    ],
    resolve,
    esbuild: { jsx: "automatic" },
    define: {
      OPENCOOK_VERSION: JSON.stringify(input.version),
      OPENCOOK_CLI_NAME: JSON.stringify("opencook-node"),
      OPENCOOK_CHANNEL: JSON.stringify(input.channel),
      OPENCOOK_ARTIFACT: JSON.stringify("cli-node"),
      ...(input.highlights ? { OPENCOOK_RELEASE_HIGHLIGHTS: JSON.stringify(input.highlights) } : {}),
      OPENCOOK_LIBC: input.target.platform === "linux" ? JSON.stringify("glibc") : "undefined",
      FFF_LIBC: input.target.platform === "linux" ? JSON.stringify("gnu") : "undefined",
      "process.env.WS_NO_BUFFER_UTIL": JSON.stringify("1"),
    },
    ssr: { noExternal: true },
    build: {
      ssr: "src/node/index.ts",
      target: "node26",
      outDir: "dist-node",
      emptyOutDir: false,
      minify: true,
      rollupOptions: {
        output: output("opencook.mjs", nodePrelude(input)),
      },
    },
  })
}

export default mainConfig({
  version: process.env.OPENCOOK_VERSION ?? "local",
  channel: process.env.OPENCOOK_CHANNEL ?? "local",
  assetHash: "local",
  target: nodeTarget(process.platform, process.arch),
})
