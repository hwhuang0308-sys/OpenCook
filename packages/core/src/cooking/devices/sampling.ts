export * as SensorSampling from "./sampling.js"

import { Clock, Effect } from "effect"
import { SensorProtocols } from "./protocols.js"
import type { SensorSerial } from "./serial.js"

export const sound = Effect.fn(function* (serial: SensorSerial.Connection, timeout: number) {
  yield* serial.flush()
  yield* serial.write(SensorProtocols.soundRequest())
  yield* Effect.sleep("100 millis")
  return SensorProtocols.soundValue(yield* serial.read(7, timeout))
})

export const temperature = Effect.fn(function* (serial: SensorSerial.Connection, timeout: number) {
  yield* serial.flush()
  yield* serial.write(SensorProtocols.temperatureRequest())
  const chunks: Buffer[] = []
  let length = 0
  const start = yield* Clock.currentTimeMillis
  while (length < SensorProtocols.temperatureFrameLength && (yield* Clock.currentTimeMillis) - start < 2000) {
    const chunk = yield* serial.read(SensorProtocols.temperatureFrameLength - length, timeout)
    if (!chunk.length) break
    chunks.push(chunk)
    length += chunk.length
  }
  return SensorProtocols.temperatureMatrix(Buffer.concat(chunks))
})

export const activateAir = Effect.fn(function* (serial: SensorSerial.Connection) {
  yield* serial.flush()
  yield* serial.write(SensorProtocols.airActiveRequest())
  yield* Effect.sleep("100 millis")
})

export const air = Effect.fn(function* (serial: SensorSerial.Connection, timeout: number) {
  let first = yield* serial.read(1, timeout)
  while (first.length && first[0] !== 0xff) first = yield* serial.read(1, timeout)
  if (!first.length) return yield* Effect.fail(new Error("空气传感器读取超时"))
  const rest = yield* serial.read(8, timeout)
  if (rest.length !== 8) return yield* Effect.fail(new Error("空气传感器响应长度不足"))
  return SensorProtocols.airValue(Buffer.concat([first, rest]))
})
