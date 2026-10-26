export * as SensorRecording from "./recording.js"

import path from "path"
import { Context, Effect, Layer } from "effect"
import { FSUtil } from "@opencook/util/fs-util"
import { makeGlobalNode } from "@opencook/util/effect/app-node"
import { KitchenSettings } from "../settings.js"
import { SensorImages } from "./images.js"
import type { KitchenCamera } from "./camera.js"

export interface Interface {
  readonly image: (frame: KitchenCamera.Frame, time: number) => Effect.Effect<void, Error>
  readonly temperature: (matrix: Float32Array, time: number) => Effect.Effect<void, Error>
  readonly scalar: (id: "sound" | "air", value: number, time: number) => Effect.Effect<void, Error>
  readonly warning: (message: string, time: number) => Effect.Effect<void, Error>
}
export class Service extends Context.Service<Service, Interface>()("@opencook/SensorRecording") {}
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const settings = yield* KitchenSettings.Service
    const fs = yield* FSUtil.Service
    const cv = yield* Effect.cached(SensorImages.load)
    const write = (operation: (directory: string) => Effect.Effect<void, Error>) =>
      Effect.gen(function* () {
        const config = yield* settings.recording()
        if (!config.enabled) return
        yield* operation(config.directory)
      })
    const filename = (directory: string, id: string, time: number, extension: string) =>
      path.join(directory, id, `${new Date(time).toISOString().replace(/[:.]/g, "-")}.${extension}`)
    const append = (directory: string, id: string, value: string) =>
      Effect.gen(function* () {
        yield* fs.ensureDir(path.join(directory, id))
        yield* fs.writeFileString(path.join(directory, id, "samples.jsonl"), value + "\n", { flag: "a" })
      }).pipe(Effect.mapError(() => new Error("无法写入传感器调试记录")))
    return Service.of({
      image: (frame, time) =>
        write((directory) =>
          Effect.gen(function* () {
            const encoded = yield* SensorImages.encode(frame, "jpeg")
            yield* fs.writeWithDirs(filename(directory, "camera", time, "jpg"), encoded)
          }).pipe(Effect.mapError(() => new Error("无法保存摄像头调试图片"))),
        ),
      temperature: (matrix, time) =>
        write((directory) =>
          Effect.gen(function* () {
            const csv =
              Array.from({ length: 24 }, (_, row) =>
                Array.from(matrix.slice(row * 32, (row + 1) * 32), (value) => value.toFixed(1)).join(","),
              ).join("\n") + "\n"
            yield* fs.writeWithDirs(filename(directory, "temperature", time, "csv"), csv)
            const image = SensorImages.heatmap(yield* cv, matrix)
            yield* fs.writeWithDirs(
              filename(directory, "temperature", time, "png"),
              yield* SensorImages.encode(image, "png"),
            )
          }).pipe(Effect.mapError(() => new Error("无法保存温度调试数据"))),
        ),
      scalar: (id, value, time) =>
        write((directory) =>
          append(directory, id, JSON.stringify({ time, value, unit: id === "sound" ? "dB" : "mg/m³" })),
        ),
      warning: (message, time) =>
        write((directory) => append(directory, "warnings", JSON.stringify({ time, message }))),
    })
  }),
)
export const node = makeGlobalNode({ service: Service, layer, deps: [KitchenSettings.node, FSUtil.node] })
