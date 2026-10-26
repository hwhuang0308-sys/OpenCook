export * as SensorSerialWorker from "./serial-worker.js"

import type { SerialPort } from "serialport"
import type { Interface } from "node:readline"

// Self-contained: its transpiled function body runs in Node when the host is Bun.
// Native serialport bindings use libuv APIs that Bun does not implement.
export function run(load: NodeRequire) {
  const Port: typeof SerialPort = load(process.argv[1]).SerialPort
  const port = new Port({ path: process.argv[2], baudRate: Number(process.argv[3]), autoOpen: false })
  let bytes = Buffer.alloc(0)
  let failure: string | undefined
  let reader: { id: number; count: number; timer: ReturnType<typeof setTimeout> } | undefined
  const send = (id: number, data?: string, error?: string) =>
    process.stdout.write(JSON.stringify({ id, data, error }) + "\n")
  const finishRead = () => {
    if (!reader) return
    clearTimeout(reader.timer)
    const count = Math.min(reader.count, bytes.length)
    send(reader.id, bytes.subarray(0, count).toString("base64"))
    bytes = bytes.subarray(count)
    reader = undefined
    if (bytes.length < port.readableHighWaterMark) port.resume()
  }
  port.on("data", (chunk: Buffer) => {
    bytes = Buffer.concat([bytes, chunk])
    if (bytes.length >= port.readableHighWaterMark) port.pause()
    if (reader && bytes.length >= reader.count) finishRead()
  })
  port.on("error", () => {
    failure = "串口通信失败"
    if (reader) {
      clearTimeout(reader.timer)
      send(reader.id, undefined, "串口通信失败")
      reader = undefined
    }
  })
  port.on("close", () => {
    failure = "串口已关闭"
    if (reader) {
      clearTimeout(reader.timer)
      send(reader.id, undefined, "串口已关闭")
      reader = undefined
    }
  })
  port.open((error) => send(0, undefined, error ? "无法打开串口，请检查设备、端口和权限" : undefined))
  const lines: Interface = load("node:readline").createInterface({ input: process.stdin })
  lines
    .on("line", (line: string) => {
      // Private protocol: only the typed parent writes these commands.
      const input: { id: number; type: "read" | "write" | "flush"; count?: number; timeout?: number; data?: string } =
        JSON.parse(line)
      if (failure) {
        send(input.id, undefined, failure)
        return
      }
      if (input.type === "read") {
        reader = { id: input.id, count: input.count!, timer: setTimeout(finishRead, input.timeout) }
        if (bytes.length >= reader.count) finishRead()
        return
      }
      if (input.type === "write") {
        port.write(Buffer.from(input.data!, "base64"), (error) =>
          send(input.id, undefined, error ? "串口写入失败" : undefined),
        )
        return
      }
      bytes = Buffer.alloc(0)
      port.resume()
      port.flush((error) => send(input.id, undefined, error ? "串口清空失败" : undefined))
    })
    .on("close", () => {
      if (reader) clearTimeout(reader.timer)
      if (port.isOpen) port.close(() => process.exit(0))
      else process.exit(0)
    })
}
