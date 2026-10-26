export * as SensorSerial from "./serial.js"

import { Effect, Schema } from "effect"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import type { SerialPort } from "serialport"
import { SensorSerialWorker } from "./serial-worker.js"
import { KitchenRuntime } from "./runtime.js"

export interface Connection {
  readonly read: (count: number, timeout: number) => Effect.Effect<Buffer, Error>
  readonly write: (data: Uint8Array) => Effect.Effect<void, Error>
  readonly flush: () => Effect.Effect<void, Error>
}

export const open = Effect.fn(function* (path: string, baudRate: number) {
  const runtime = yield* Effect.tryPromise({
    try: () => KitchenRuntime.serial(),
    catch: () => new Error("无法加载串口运行文件"),
  })
  if (process.versions.bun || runtime) return yield* openWorker(path, baudRate, runtime)
  const module = yield* Effect.tryPromise({
    try: () => import("serialport"),
    catch: () => new Error("无法加载串口驱动"),
  })
  const port = new module.SerialPort({ path, baudRate, autoOpen: false })
  let failure: Error | undefined
  const onError = (error: Error) => {
    failure = error
  }
  port.on("error", onError)
  yield* Effect.acquireRelease(
    Effect.callback<void, Error>((resume) => {
      port.open((error) => resume(error ? Effect.fail(error) : Effect.void))
    }),
    () =>
      Effect.callback<void>((resume) => {
        if (!port.isOpen) {
          resume(Effect.void)
          return
        }
        port.close(() => {
          port.off("error", onError)
          resume(Effect.void)
        })
      }),
  )
  return connection(port, () => failure)
})

const Reply = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.Number,
    data: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(Schema.String),
  }),
)
const decodeReply = Schema.decodeUnknownOption(Reply)

const openWorker = Effect.fn(function* (path: string, baudRate: number, runtime?: { module: string; binding: string }) {
  const entry = yield* Effect.try({
    try: () => runtime?.module ?? createRequire(import.meta.url).resolve("serialport"),
    catch: () => new Error("无法找到串口驱动，请安装项目依赖"),
  })
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      spawn(
        process.env.OPENCOOK_NODE_PATH || "node",
        [
          "-e",
          `(${SensorSerialWorker.run.toString()})(require)`,
          entry,
          path,
          String(baudRate),
          runtime?.binding ?? "",
        ],
        { stdio: ["pipe", "pipe", "ignore"] },
      ),
    ),
    (child) =>
      Effect.callback<void>((resume) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resume(Effect.void)
          return
        }
        child.once("close", () => resume(Effect.void))
        child.kill()
      }),
  )
  const pending = new Map<number, (effect: Effect.Effect<string | undefined, Error>) => void>()
  let sequence = 0
  let remainder = ""
  let failure: Error | undefined
  const fail = (error: Error) => {
    failure = error
    for (const reply of pending.values()) reply(Effect.fail(error))
    pending.clear()
  }
  child.on("error", () => fail(new Error("无法启动串口运行时，请安装 Node.js 或设置 OPENCOOK_NODE_PATH")))
  child.stdin.on("error", () => fail(new Error("串口运行时不可写")))
  child.on("close", () => fail(new Error("串口运行时已退出")))
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    remainder += chunk
    const lines = remainder.split("\n")
    remainder = lines.pop() ?? ""
    for (const line of lines) {
      const parsed = decodeReply(line)
      if (parsed._tag === "None") {
        fail(new Error("串口运行时响应无效"))
        return
      }
      const reply = parsed.value
      pending.get(reply.id)?.(reply.error ? Effect.fail(new Error(reply.error)) : Effect.succeed(reply.data))
      pending.delete(reply.id)
    }
  })
  const call = (
    id: number,
    command?: { type: "read" | "write" | "flush"; count?: number; timeout?: number; data?: string },
  ) =>
    Effect.callback<string | undefined, Error>((resume) => {
      if (failure) {
        resume(Effect.fail(failure))
        return
      }
      pending.set(id, resume)
      if (command)
        child.stdin.write(JSON.stringify({ id, ...command }) + "\n", (error) => {
          if (error) fail(new Error("串口运行时不可写"))
        })
      return Effect.sync(() => {
        pending.delete(id)
      })
    })
  yield* call(0)
  return {
    flush: () => call(++sequence, { type: "flush" }).pipe(Effect.asVoid),
    write: (data: Uint8Array) =>
      call(++sequence, { type: "write", data: Buffer.from(data).toString("base64") }).pipe(Effect.asVoid),
    read: (count: number, timeout: number) =>
      call(++sequence, { type: "read", count, timeout }).pipe(Effect.map((data) => Buffer.from(data ?? "", "base64"))),
  } satisfies Connection
})

function connection(port: SerialPort, failure: () => Error | undefined): Connection {
  return {
    read: (count, timeout) =>
      Effect.gen(function* () {
        const result = yield* Effect.callback<Buffer, Error>((resume) => {
          const onError = (error: Error) => resume(Effect.fail(error))
          const onClose = () => onError(new Error("串口已关闭"))
          const ready = () => {
            const error = failure()
            if (error) {
              onError(error)
              return
            }
            const data: Buffer | null = port.read(count)
            if (data) resume(Effect.succeed(data))
          }
          port.on("readable", ready)
          port.on("error", onError)
          port.on("close", onClose)
          ready()
          return Effect.sync(() => {
            port.off("readable", ready)
            port.off("error", onError)
            port.off("close", onClose)
          })
        }).pipe(Effect.timeoutOption(`${timeout} millis`))
        if (result._tag === "Some") return result.value
        return (port.read(Math.min(count, port.readableLength)) as Buffer | null) ?? Buffer.alloc(0)
      }),
    write: (data) =>
      Effect.callback<void, Error>((resume) => {
        port.write(Buffer.from(data), (error) => resume(error ? Effect.fail(error) : Effect.void))
      }),
    flush: () =>
      Effect.callback<void, Error>((resume) => {
        while (port.read() !== null) {
          /* Mirror reset_input_buffer before sending a request. */
        }
        port.flush((error) => resume(error ? Effect.fail(error) : Effect.void))
      }),
  }
}
