export * as CookingSafety from "./safety.js"

import { Context, Effect, Layer } from "effect"
import { Cooking } from "@opencook/schema/cooking"
import { makeGlobalNode } from "@opencook/util/effect/app-node"
import { KitchenDevices } from "./devices/service.js"
import { SensorImages } from "./devices/images.js"
import { CookingVision } from "./vision.js"

// Preserve Daemon_thread.py: two-second polling, independent ten-second alert
// cooldowns, and smoke >= 9 mg/m³ before asking the burnt-food vision question.
export const interval = "2 seconds"
export const cooldown = 10000
export const smokeThreshold = 9

// Advice applies to a small pan fire only. No hardware actuation is implied.
// Sources: https://www.usfa.fema.gov/prevention/home-fires/prevent-fires/cooking/
// https://yjglj.beijing.gov.cn/art/2015/4/13/art_3942_243698.html
export const steps = (kind: Cooking.Hazard) =>
  kind === "fire"
    ? [
        "疑似着火！能安全操作时立即关火；不要向油锅泼水，不要移动燃烧的锅。火势失控或无法安全处理时，立即撤离并拨打当地消防电话（中国大陆 119）。",
        "仅限锅内小火且能安全操作时：从侧面滑上合适的锅盖，保持盖住直至冷却；不能安全盖住时立即撤离求助。",
      ]
    : ["疑似糊锅，请立即关火、停止当前烹饪操作，检查锅内食物；若出现明火，按着火应急提示处理。"]

export interface Interface {
  readonly inspect: (
    kind: Cooking.Hazard,
  ) => Effect.Effect<{ state: typeof Cooking.MonitorState.Type; message?: string }>
}
export class Service extends Context.Service<Service, Interface>()("@opencook/CookingSafety") {}
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const devices = yield* KitchenDevices.Service
    const vision = yield* CookingVision.Service
    return Service.of({
      inspect: Effect.fn(function* (kind) {
        const connected = new Set(
          (yield* devices.status()).filter((device) => device.state === "connected").map((device) => device.id),
        )
        if (!connected.has("camera")) return { state: "unavailable" } as const
        if (kind === "burnt") {
          const smoke = devices.air()
          if (!connected.has("air") || smoke === undefined) return { state: "unavailable" } as const
          if (smoke < smokeThreshold) return { state: "clear" } as const
        }
        const frame = devices.picture(undefined, true)
        if (!frame) return { state: "unavailable" } as const
        const result = yield* SensorImages.encode(frame, "jpeg").pipe(
          Effect.flatMap((image) =>
            vision.check(
              image,
              kind === "fire"
                ? "判断图像中的锅内、食物或灶台是否发生异常着火。正常炉头火焰不算异常着火。仅输出1（异常着火）或0（未见异常着火）。"
                : "判断图像中的锅内食物是否明显烧焦或糊锅。仅输出1（糊锅）或0（未见糊锅）。",
            ),
          ),
          Effect.result,
        )
        if (result._tag === "Failure")
          return { state: "error", message: "异常视觉监测暂不可用，请留意锅内情况。" } as const
        return { state: result.success ? "alert" : "clear" } as const
      }),
    })
  }),
)
export const node = makeGlobalNode({ service: Service, layer, deps: [KitchenDevices.node, CookingVision.node] })
