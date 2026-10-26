import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SensorProtocols } from "@opencook/core/cooking/devices/protocols"
import { TemperatureSensor } from "@opencook/core/cooking/devices/temperature"
import { SensorImages } from "@opencook/core/cooking/devices/images"
import reference from "./fixture/sensors.json"
import { it } from "./lib/effect"

test("wire values and commands match outputs obtained from the original Python definitions", () => {
  expect(SensorProtocols.soundValue(Buffer.from("99000202580000", "hex"))).toBe(reference.sound.value)
  expect(SensorProtocols.soundRequest().toString("hex")).toBe(String(reference.sound.calls[1][1]))
  expect(SensorProtocols.temperatureRequest().toString("hex")).toBe(reference.temperature.request)
  expect(Array.from(SensorProtocols.temperatureMatrix(Buffer.from(reference.temperature.frame, "hex")) ?? [])).toEqual(
    reference.temperature.cases[0].matrix,
  )
  expect(SensorProtocols.airActiveRequest().toString("hex")).toBe(reference.air.request)
  expect(SensorProtocols.airValue(Buffer.from(reference.air.frame, "hex"))).toEqual(reference.air.value)
})

test("temperature regions, dominant windows and top-k readings match the Python reference", () => {
  for (const fixture of reference.temperature.cases) {
    const matrix = Float32Array.from(fixture.matrix)
    const region = TemperatureSensor.analyzeRegions(matrix)
    expect(String(region.hottest)).toBe(fixture.region)
    expect(region.counts).toEqual(fixture.counts)
    for (const name of TemperatureSensor.regions) expect(region.scores[name]).toBeCloseTo(fixture.scores[name], 3)
    expect(TemperatureSensor.topMean(matrix, 0.1)).toBeCloseTo(fixture.top_mean, 3)
    const monitor = new TemperatureSensor.Monitor()
    expect(Array.from({ length: 6 }, () => monitor.process(matrix).persistent)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ])
    expect(
      monitor.process(
        Float32Array.from(reference.temperature.cases.find((entry) => entry.region !== fixture.region)!.matrix),
      ).persistent,
    ).toBe(false)
  }
})

function picture(variant: string) {
  const data = new Uint8Array(1520 * 1020 * 3)
  for (let y = 0; y < 1020; y++)
    for (let x = 0; x < 1520; x++)
      for (let c = 0; c < 3; c++) {
        const base = (x * 13 + y * 7 + c * 47 + ((x * y) % 97)) % 256
        data[(y * 1520 + x) * 3 + c] =
          variant === "inverted" ? 255 - base : variant === "changed" ? (base + ((x * 11 + y * 3) % 91)) % 256 : base
      }
  return { width: 1520, height: 1020, data }
}

it.live("WASM OpenCV preserves the original ROI, blur, template correlation and six-frame alarm decisions", () =>
  Effect.gen(function* () {
    const cv = yield* SensorImages.load
    const previous = picture("same")
    for (const fixture of reference.vision) {
      const score = SensorImages.correlation(cv, picture(fixture.variant), previous)
      expect(score).toBeDefined()
      // Native OpenCV and WASM use different floating-point reduction backends.
      expect(score).toBeCloseTo(fixture.score, 4)
      const monitor = new TemperatureSensor.Monitor()
      expect(
        Array.from(
          { length: 6 },
          () => monitor.process(Float32Array.from(reference.temperature.cases[0].matrix)).persistent && score! >= 0.89,
        ),
      ).toEqual(fixture.decisions)
    }
    expect(SensorImages.correlation(cv, { width: 1, height: 1, data: new Uint8Array(3) }, previous)).toBeUndefined()
  }),
)
