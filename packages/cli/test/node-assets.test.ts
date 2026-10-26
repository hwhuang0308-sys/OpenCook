import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { collectNodeAssets } from "../script/node-assets"
import { nodeTarget, shellParserWasmAssets } from "../src/node/target"

test("collects each SEA asset key once", async () => {
  const assets = await collectNodeAssets(nodeTarget(process.platform, process.arch))
  const keys = assets.map((asset) => asset.key)
  expect(keys).toContain("kitchen/serialport.cjs")
  expect(keys).toContain("kitchen/serialport.node")
  const serial = assets.find((asset) => asset.key === "kitchen/serialport.cjs")!
  const binding = assets.find((asset) => asset.key === "kitchen/serialport.node")!
  const child = Bun.spawn(
    [
      "node",
      "-e",
      "const { SerialPort } = require(process.argv[1]); console.log(typeof SerialPort.list)",
      serial.source,
      "fixture-port",
      "9600",
      binding.source,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ stderr, code }).toEqual({ stderr: "", code: 0 })
  expect(stdout.trim()).toBe("function")

  expect(new Set(keys).size).toBe(keys.length)
  if (process.platform !== "win32") expect(keys.filter((key) => key === "opencook-pty/opencook-pty")).toHaveLength(1)
  expect(assets.filter((asset) => asset.key === shellParserWasmAssets.runtime)).toEqual([
    {
      key: shellParserWasmAssets.runtime,
      source: fileURLToPath(import.meta.resolve(shellParserWasmAssets.runtime)),
    },
  ])
})
