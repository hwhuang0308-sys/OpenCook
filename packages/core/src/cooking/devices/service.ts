export * as KitchenDevices from "./service.js"

import { Clock, Context, Effect, Fiber, Layer, Stream } from "effect"
import { Kitchen } from "@opencook/schema/kitchen"
import { makeGlobalNode } from "@opencook/util/effect/app-node"
import { AppProcess } from "@opencook/util/process"
import { KitchenSettings } from "../settings.js"
import { SensorBuffer } from "./buffer.js"
import { SensorSerial } from "./serial.js"
import { SensorSampling } from "./sampling.js"
import { SensorRecording } from "./recording.js"
import { KitchenCamera } from "./camera.js"
import { SensorImages } from "./images.js"
import { TemperatureSensor } from "./temperature.js"

export interface Interface {
  readonly status: () => Effect.Effect<Kitchen.DeviceStatus[]>
  readonly reconnect: (id: Kitchen.DeviceID) => Effect.Effect<void>
  readonly picture: (time?: number, copy?: boolean) => KitchenCamera.Frame | undefined
  readonly matrix: (copy?: boolean) => Float32Array | undefined
  readonly temperature: (ratio?: number) => number | undefined
  readonly sound: (start: number, end?: number) => Effect.Effect<number[], Error>
  readonly air: () => number | undefined
  readonly stir: () => { readonly needed: boolean; readonly message: string }
}
export class Service extends Context.Service<Service, Interface>()("@opencook/KitchenDevices") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const settings = yield* KitchenSettings.Service
    const recording = yield* SensorRecording.Service
    const processes = yield* AppProcess.Service
    const scope = yield* Effect.scope
    const cv = yield* Effect.cached(SensorImages.load)
    const state = {
      config: (yield* settings.get()).devices,
      cameraURL: yield* settings.cameraURL(),
      stir: { needed: false, message: "" },
    }
    const fibers = new Map<Kitchen.DeviceID, Fiber.Fiber<void, never>>()
    const statuses = new Map<Kitchen.DeviceID, Kitchen.DeviceStatus>()
    const buffers = {
      camera: new SensorBuffer.Window<KitchenCamera.Frame>(state.config.camera.buffer_frames),
      temperature: new SensorBuffer.Window<Float32Array>(
        Math.max(
          1,
          Math.trunc(
            (state.config.temperature.buffer_seconds * 1000) / state.config.temperature.sample_period_ms + 0.5,
          ),
        ),
      ),
      sound: new SensorBuffer.Window<number>(
        Math.max(1, Math.trunc((state.config.sound.buffer_seconds * 1000) / state.config.sound.sample_period_ms + 0.5)),
      ),
      air: new SensorBuffer.Window<number>(
        Math.max(10, Math.trunc(state.config.air.buffer_seconds * (1000 / state.config.air.sample_period_ms) * 2) + 10),
        state.config.air.buffer_seconds,
      ),
    }
    const update = (id: Kitchen.DeviceID, value: Partial<Kitchen.DeviceStatus>) => {
      statuses.set(id, { id, state: "connecting", ...statuses.get(id), ...value })
    }
    const received = (id: Kitchen.DeviceID, time: number, value?: number) =>
      update(id, {
        state: "connected",
        last_sample: time,
        value,
        unit: id === "sound" ? "dB" : id === "temperature" ? "°C" : id === "air" ? "mg/m³" : undefined,
        message: undefined,
      })
    const run = (id: Kitchen.DeviceID) =>
      Effect.gen(function* () {
        let backoff = 500
        let lastCameraSave = yield* Clock.currentTimeMillis
        const monitor = new TemperatureSensor.Monitor()
        while (true) {
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              if (id === "camera") {
                const url = yield* settings.cameraURL()
                yield* KitchenCamera.capture(url, state.config.camera.ffmpeg_path, (frame, time) =>
                  Effect.gen(function* () {
                    backoff = 500
                    buffers.camera.append(time, frame)
                    received(id, time)
                    if (time - lastCameraSave >= 500) {
                      yield* recording.image(frame, time).pipe(Effect.ignore)
                      lastCameraSave = time
                    }
                  }),
                ).pipe(Effect.provideService(AppProcess.Service, processes))
                return
              }
              const config = state.config[id]
              const serial = yield* SensorSerial.open(config.port, config.baud_rate)
              backoff = 500
              if (id === "air") yield* SensorSampling.activateAir(serial)
              while (true) {
                if (id === "temperature") {
                  const matrix = yield* SensorSampling.temperature(serial, config.timeout_ms)
                  if (matrix) {
                    const time = yield* Clock.currentTimeMillis
                    yield* recording.temperature(matrix, time).pipe(Effect.ignore)
                    buffers.temperature.append(time, matrix.slice())
                    const region = monitor.process(matrix)
                    const current = buffers.camera.latest()?.value
                    const previous = buffers.camera.atOrBefore((yield* Clock.currentTimeMillis) - 3000)?.value
                    const similarity =
                      region.persistent && current && previous
                        ? SensorImages.correlation(yield* cv, current, previous)
                        : undefined
                    const needed = region.persistent && similarity !== undefined && similarity >= 0.89
                    state.stir = {
                      needed,
                      message: needed
                        ? `${region.dominant}区域受热不均，请均匀翻炒！`
                        : region.persistent
                          ? "正常"
                          : "初始化数据...",
                    }
                    if (needed) yield* recording.warning(state.stir.message, time).pipe(Effect.ignore)
                    received(id, time, TemperatureSensor.topMean(matrix, 0.1))
                  }
                }
                if (id === "sound") {
                  const value = yield* SensorSampling.sound(serial, config.timeout_ms)
                  const time = yield* Clock.currentTimeMillis
                  yield* recording.scalar(id, value, time).pipe(Effect.ignore)
                  buffers.sound.append(time, value)
                  received(id, time, value)
                }
                if (id === "air") {
                  const value = yield* SensorSampling.air(serial, config.timeout_ms)
                  if (value) {
                    const time = yield* Clock.currentTimeMillis
                    yield* recording.scalar(id, value.concentration, time).pipe(Effect.ignore)
                    buffers.air.append(time, value.concentration)
                    received(id, time, value.concentration)
                  }
                  continue
                }
                yield* Effect.sleep(`${config.sample_period_ms} millis`)
              }
            }),
          ).pipe(Effect.result)
          if (result._tag === "Failure")
            update(id, {
              state: "disconnected",
              message:
                id === "camera"
                  ? "未收到有效视频帧，请检查 RTSP、凭据和网络。"
                  : "串口通信失败，正在重连；请检查端口、权限和设备。",
            })
          yield* Effect.sleep(`${backoff} millis`)
          backoff = Math.min(backoff * 2, 5000)
        }
      })
    const start = Effect.fn(function* (id: Kitchen.DeviceID) {
      const previous = fibers.get(id)
      if (previous) yield* Fiber.interrupt(previous)
      fibers.delete(id)
      const config = state.config[id]
      if (id === "camera") buffers.camera.resize(state.config.camera.buffer_frames)
      if (id === "sound" || id === "temperature")
        buffers[id].resize(
          Math.max(1, Math.trunc((state.config[id].buffer_seconds * 1000) / state.config[id].sample_period_ms + 0.5)),
        )
      if (id === "air")
        buffers.air.resize(
          Math.max(
            10,
            Math.trunc(state.config.air.buffer_seconds * (1000 / state.config.air.sample_period_ms) * 2) + 10,
          ),
          state.config.air.buffer_seconds,
        )
      const configured = id === "camera" ? !!state.config.camera.rtsp_url : !!state.config[id].port
      statuses.set(id, { id, state: !configured ? "unconfigured" : !config.enabled ? "disabled" : "connecting" })
      if (!configured || !config.enabled) return
      const fiber = yield* run(id).pipe(Effect.forkIn(scope, { startImmediately: true }))
      fibers.set(id, fiber)
    })
    yield* Effect.forEach(Kitchen.deviceIDs, start, { discard: true })
    yield* settings.changes().pipe(
      Stream.filter((type) => type === "devices"),
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const next = (yield* settings.get()).devices
          const cameraURL = yield* settings.cameraURL()
          const changed = Kitchen.deviceIDs.filter(
            (id) =>
              JSON.stringify(state.config[id]) !== JSON.stringify(next[id]) ||
              (id === "camera" && cameraURL !== state.cameraURL),
          )
          state.config = next
          state.cameraURL = cameraURL
          for (const id of changed) yield* start(id)
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    return Service.of({
      status: () =>
        Clock.currentTimeMillis.pipe(
          Effect.map((time) =>
            Kitchen.deviceIDs.map((id) => {
              const status = statuses.get(id) ?? { id, state: "unconfigured" as const }
              const config = state.config[id]
              const expiry =
                id === "camera"
                  ? 2000
                  : Math.max(
                      2000,
                      (state.config[id] as Kitchen.Serial).timeout_ms +
                        (state.config[id] as Kitchen.Serial).sample_period_ms,
                    )
              return status.state === "connected" &&
                status.last_sample !== undefined &&
                time - status.last_sample > expiry &&
                config.enabled
                ? { ...status, state: "disconnected" as const, message: "接收数据已超时" }
                : status
            }),
          ),
        ),
      reconnect: (id) => start(id),
      picture: (time, copy = true) => {
        const frame = (time === undefined ? buffers.camera.latest() : buffers.camera.atOrBefore(time))?.value
        return frame && copy ? { ...frame, data: frame.data.slice() } : frame
      },
      matrix: (copy = true) => {
        const matrix = buffers.temperature.latest()?.value
        return copy ? matrix?.slice() : matrix
      },
      temperature: (ratio = 0.1) => {
        const sample = buffers.temperature.latest()
        return sample ? TemperatureSensor.topMean(sample.value, ratio) : undefined
      },
      sound: (start, end = 0) =>
        Effect.gen(function* () {
          if (start >= end || end > 0 || start < -state.config.sound.buffer_seconds)
            return yield* Effect.fail(new Error("要求 start_offset < end_offset ≤ 0，且查询位于缓存窗口内"))
          const config = state.config.sound
          const needed = Math.max(1, Math.trunc((Math.abs(start) * 1000) / config.sample_period_ms + 0.5))
          const begin = yield* Clock.currentTimeMillis
          while (
            buffers.sound.length < needed &&
            (yield* Clock.currentTimeMillis) - begin < Math.abs(start) * 1000 + config.sample_period_ms
          )
            yield* Effect.sleep(`${Math.min(50, config.sample_period_ms / 2)} millis`)
          const now = yield* Clock.currentTimeMillis
          return buffers.sound.between(now + start * 1000, now + end * 1000)
        }),
      air: () => buffers.air.latest()?.value,
      stir: () => state.stir,
    })
  }),
)
export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [KitchenSettings.node, SensorRecording.node, AppProcess.node],
})
