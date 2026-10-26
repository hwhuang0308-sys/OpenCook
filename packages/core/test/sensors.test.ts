import { expect, test } from "bun:test"
import { Effect, Fiber, Exit } from "effect"
import { TestClock } from "effect/testing"
import { SensorProtocols } from "@opencook/core/cooking/devices/protocols"
import { SensorSampling } from "@opencook/core/cooking/devices/sampling"
import { SensorBuffer } from "@opencook/core/cooking/devices/buffer"
import { KitchenCamera } from "@opencook/core/cooking/devices/camera"
import { SensorSerial } from "@opencook/core/cooking/devices/serial"
import { it } from "./lib/effect"

it.live("native driver reports an unavailable port without crashing the Bun host or leaking its worker", () =>
  Effect.gen(function* () {
    const result = yield* Effect.scoped(SensorSerial.open("opencook-test-nonexistent-port", 9600)).pipe(
      Effect.timeout("5 seconds"),
      Effect.exit,
    )
    expect(Exit.isFailure(result)).toBe(true)
  }),
)

function transport(chunks: Uint8Array[]) {
  const calls: Array<string | number> = []
  const connection: SensorSerial.Connection = {
    flush: () =>
      Effect.sync(() => {
        calls.push("flush")
      }),
    write: (data) =>
      Effect.sync(() => {
        calls.push(Buffer.from(data).toString("hex"))
      }),
    read: (count) =>
      Effect.sync(() => {
        calls.push(count)
        return Buffer.from(chunks.shift() ?? [])
      }),
  }
  return { connection, calls }
}

it.effect("sound sends the legacy command, waits 100 ms, and accepts its original simplified response", () =>
  Effect.gen(function* () {
    const device = transport([Buffer.from("99000202580000", "hex")])
    const fiber = yield* SensorSampling.sound(device.connection, 1000).pipe(
      Effect.forkChild({ startImmediately: true }),
    )
    expect(device.calls).toEqual(["flush", "010300000001840a"])
    yield* TestClock.adjust("99 millis")
    expect(device.calls).toHaveLength(2)
    yield* TestClock.adjust("1 millis")
    expect(yield* Fiber.join(fiber)).toBe(60)
    expect(device.calls.at(-1)).toBe(7)
  }),
)

it.effect("temperature assembles partial responses and treats short frames as missing samples", () =>
  Effect.gen(function* () {
    const frame = Buffer.alloc(SensorProtocols.temperatureFrameLength)
    frame.writeInt16LE(-123, 37)
    frame.writeInt16LE(2456, 37 + 767 * 2)
    const device = transport([frame.subarray(0, 100), frame.subarray(100)])
    const value = yield* SensorSampling.temperature(device.connection, 2000)
    expect(device.calls).toEqual(["flush", SensorProtocols.temperatureRequest().toString("hex"), 1575, 1475])
    expect(value?.[0]).toBe(Math.fround(-12.3))
    expect(value?.[767]).toBe(Math.fround(245.6))
    const short = transport([frame.subarray(0, 12), Buffer.alloc(0)])
    expect(yield* SensorSampling.temperature(short.connection, 2000)).toBeUndefined()
  }),
)

it.effect(
  "air switches to active mode, resynchronizes at FF, and distinguishes checksum failure from read failure",
  () =>
    Effect.gen(function* () {
      const frame = Buffer.from("ff1711021234138800", "hex")
      frame[8] = SensorProtocols.airChecksum(frame)
      const device = transport([Buffer.from([3]), Buffer.from([0xff]), frame.subarray(1)])
      const activation = yield* SensorSampling.activateAir(device.connection).pipe(
        Effect.forkChild({ startImmediately: true }),
      )
      yield* TestClock.adjust("100 millis")
      yield* Fiber.join(activation)
      expect(device.calls).toEqual(["flush", "ff0078400000000048"])
      expect(yield* SensorSampling.air(device.connection, 1000)).toMatchObject({
        concentration: 46.6,
        full_scale: 50,
        unit: "mg/m³",
        unit_code: 0x11,
      })
      frame[8] ^= 1
      expect(
        yield* SensorSampling.air(transport([frame.subarray(0, 1), frame.subarray(1)]).connection, 1000),
      ).toBeUndefined()
      expect(Exit.isFailure(yield* SensorSampling.air(transport([]).connection, 1000).pipe(Effect.exit))).toBe(true)
    }),
)

test("bounded buffers retain strict past frames and inclusive scalar window boundaries", () => {
  const buffer = new SensorBuffer.Window<number>(3)
  buffer.append(1000, 1)
  buffer.append(2000, 2)
  buffer.append(3000, 3)
  buffer.append(4000, 4)
  expect(buffer.length).toBe(3)
  expect(buffer.atOrBefore(1999)).toBeUndefined()
  expect(buffer.atOrBefore(3000)?.value).toBe(3)
  expect(buffer.atOrBefore(3999)?.value).toBe(3)
  expect(buffer.between(2000, 4000)).toEqual([2, 3, 4])
  buffer.resize(2)
  expect(buffer.between(0, 5000)).toEqual([3, 4])
  const air = new SensorBuffer.Window<number>(130, 60)
  air.append(0, 1)
  air.append(60000, 2)
  expect(air.length).toBe(2)
  air.append(60001, 3)
  expect(air.between(0, 70000)).toEqual([2, 3])
})

test("camera decoder assembles arbitrary stream fragments and keeps OpenCV BGR channel order", () => {
  const stream = Buffer.concat([
    Buffer.from("P6\n2 1\n255\n"),
    Buffer.from([255, 128, 0, 4, 5, 6]),
    Buffer.from("P6\n1 1\n255\n"),
    Buffer.from([7, 8, 9]),
  ])
  const decoder = new KitchenCamera.Decoder()
  const frames = Array.from(stream).flatMap((byte) => decoder.push(Uint8Array.of(byte)))
  expect(frames).toEqual([
    { width: 2, height: 1, data: Uint8Array.from([0, 128, 255, 6, 5, 4]) },
    { width: 1, height: 1, data: Uint8Array.from([9, 8, 7]) },
  ])
})
