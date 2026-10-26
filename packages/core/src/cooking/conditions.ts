export * as CookingConditions from "./conditions.js"

import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Cooking } from "@opencook/schema/cooking"
import { makeGlobalNode } from "@opencook/util/effect/app-node"
import { KitchenDevices } from "./devices/service.js"
import { CookingVision } from "./vision.js"
import { SensorImages } from "./devices/images.js"
import { CookingScore } from "./score.js"

export class Error extends Schema.TaggedError<Error>()("CookingConditions.Error", { message: Schema.String }) {}
export type Latch = { since?: number; last?: number; accumulated: number; done: boolean }
export const latch = (): Latch => ({ accumulated: 0, done: false })

export class StirWarning {
  private visible = false
  private opened = 0
  private closed = -Infinity
  private message = ""
  close(now: number) {
    if (this.visible) this.closed = now
    this.visible = false
    this.message = ""
  }
  update(needed: boolean, message: string, now: number) {
    if (needed) {
      if (!this.visible && now - this.closed >= 3000) {
        this.visible = true
        this.opened = now
      }
      if (this.visible) this.message = message || "请均匀翻炒"
    }
    if (!needed && this.visible && now - this.opened >= 3000) this.close(now)
    return this.visible ? this.message : undefined
  }
}

// The food-surface judge in condition_checker.py accumulates qualifying time;
// the pan/oil and visual judges require uninterrupted qualifying time.
export function hold(state: Latch, met: boolean, now: number, duration: number, cumulative = false) {
  if (state.done) return true
  if (cumulative) {
    if (met && state.last !== undefined) state.accumulated += now - state.last
    state.last = now
    state.done = state.accumulated >= duration * 1000
    return state.done
  }
  if (!met) {
    state.since = undefined
    return false
  }
  if (state.since === undefined) {
    state.since = now
    return false
  }
  state.done = now - state.since >= duration * 1000
  return state.done
}

export function foodTemperature(matrix: Float32Array, threshold: number) {
  const inside: number[] = []
  for (let y = 0; y < 24; y++)
    for (let x = 0; x < 32; x++) {
      const dy = Math.fround((y - 11.5) / (24 * 0.35))
      const dx = Math.fround((x - 15.5) / (32 * 0.35))
      if (Math.fround(Math.fround(dy * dy) + Math.fround(dx * dx)) <= 1) inside.push(matrix[y * 32 + x])
    }
  const cold = Array.from(matrix)
    .sort((a, b) => a - b)
    .slice(0, Math.max(1, Math.trunc(matrix.length * 0.2)))
  return (
    inside.reduce((a, b) => a + b, 0) / inside.length >= threshold &&
    cold.reduce((a, b) => a + b, 0) / cold.length >= threshold * 0.6
  )
}

export interface Interface {
  readonly check: (step: Cooking.Step, states: Latch[]) => Effect.Effect<boolean, Error>
}
export class Service extends Context.Service<Service, Interface>()("@opencook/CookingConditions") {}
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const devices = yield* KitchenDevices.Service
    const vision = yield* CookingVision.Service
    const visual = (image: Uint8Array, prompt: string) =>
      vision.check(image, prompt).pipe(Effect.mapError((error) => new Error({ message: error.message })))
    return Service.of({
      check: Effect.fn(function* (step, states) {
        const status = yield* devices.status()
        const results: boolean[] = []
        for (const [index, condition] of step.conditions.entries()) {
          const state = states[index] ?? (states[index] = latch())
          if (state.done) {
            results.push(true)
            continue
          }
          const id = condition.type === "visual" ? "camera" : condition.type === "audio" ? "sound" : "temperature"
          if (!status.some((item) => item.id === id && item.state === "connected")) {
            results.push(false)
            continue
          }
          const threshold = Number(condition.condition.match(/[-+]?(?:\d+\.?\d*|\.\d+)/)?.[0])
          if (condition.type === "audio") {
            const current = yield* devices
              .sound(-3, 0)
              .pipe(Effect.mapError(() => new Error({ message: "声音数据读取失败" })))
            const previous = yield* devices
              .sound(-condition.duration - 3, -3)
              .pipe(Effect.mapError(() => new Error({ message: "声音历史数据不足" })))
            state.done =
              current.length > 0 &&
              previous.length > 0 &&
              current.reduce((a, b) => a + b, 0) / current.length -
                previous.reduce((a, b) => a + b, 0) / previous.length >
                threshold
            results.push(state.done)
            continue
          }
          if (condition.type === "temperature") {
            const matrix = devices.matrix(false)
            const met = condition.condition.includes("食材")
              ? !!matrix && foodTemperature(matrix, threshold)
              : (devices.temperature(0.2) ?? -Infinity) >= threshold
            results.push(
              hold(
                state,
                met,
                yield* Clock.currentTimeMillis,
                condition.duration,
                condition.condition.includes("食材"),
              ),
            )
            continue
          }
          const frame = devices.picture()
          if (!frame) {
            results.push(false)
            continue
          }
          const image = yield* SensorImages.encode(frame, "jpeg").pipe(
            Effect.mapError(() => new Error({ message: "摄像头画面编码失败" })),
          )
          const present = yield* visual(
            image,
            `我现在正在进行炒菜，且正在执行的炒菜步骤为：${step.action}。请根据图像判断：图像中存在炒菜步骤中所有涉及到的食材。满足只返回1，否则只返回0。`,
          )
          const met = yield* visual(
            image,
            `我现在正在进行炒菜，且正在执行的炒菜步骤为：${step.action}。请根据图像判断是否满足条件：${condition.condition}。满足只返回1，否则只返回0。`,
          )
          results.push(hold(state, present && met, yield* Clock.currentTimeMillis, condition.duration))
        }
        return CookingScore.evaluate(step.logic, results)
      }),
    })
  }),
)
export const node = makeGlobalNode({ service: Service, layer, deps: [KitchenDevices.node, CookingVision.node] })
