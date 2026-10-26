export * as CookingSpeech from "./speech.js"

import { Context, Effect, Layer } from "effect"
import { Cooking } from "@opencook/schema/cooking"
import { makeGlobalNode } from "@opencook/util/effect/app-node"
import { KitchenSettings } from "./settings.js"
import { CookingExecution } from "./execution.js"

export interface Interface {
  readonly synthesize: (input: Cooking.SpeechRequest) => Effect.Effect<Cooking.Speech, Cooking.Invalid>
}
export class Service extends Context.Service<Service, Interface>()("@opencook/CookingSpeech") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const settings = yield* KitchenSettings.Service
    const execution = yield* CookingExecution.Service
    return Service.of({
      synthesize: Effect.fn(function* (input) {
        const current = yield* execution.get(input.session_id)
        if (
          !current ||
          current.id !== input.run_id ||
          current.index !== input.index ||
          (current.status !== "running" &&
            !(current.status === "paused" && input.kind === "emergency" && current.emergency))
        )
          return { status: "obsolete" } as const
        const model = yield* settings.model("speech")
        if (!model.enabled) return { status: "disabled" } as const
        if (!model.api_key) return yield* new Cooking.Invalid({ message: "请在语音合成 TTS 设置中配置 API Key" })
        if (
          input.kind === "emergency" &&
          (current.emergency?.id !== input.emergency_id || current.emergency?.index !== input.emergency_index)
        )
          return { status: "obsolete" } as const
        const text =
          input.kind === "emergency"
            ? (current.emergency?.steps[current.emergency.index] ??
              "应急步骤已完成，请确认现场安全。普通烹饪仍保持暂停。")
            : input.kind === "warning"
              ? current.warning
              : `第${input.index + 1}步，${current.plan.steps[input.index].action}。`
        if (!text) return { status: "obsolete" } as const
        const voice = model.voice ?? "female_news"
        const audio = yield* Effect.tryPromise({
          try: async (signal) => {
            const response = await fetch(`${model.base_url.replace(/\/$/, "")}/audio/speech`, {
              method: "POST",
              signal,
              headers: { authorization: `Bearer ${model.api_key}`, "content-type": "application/json" },
              body: JSON.stringify({
                model: model.model,
                input: text.slice(0, 4096),
                voice,
                speed: model.speed ?? 1,
                response_format: "mp3",
              }),
            })
            if (!response.ok) throw new Error("TTS request failed")
            if (!(response.headers.get("content-type") ?? "").startsWith("audio/"))
              throw new Error("TTS returned no audio")
            const data = new Uint8Array(await response.arrayBuffer())
            if (!data.length || data.length > 8 * 1024 * 1024) throw new Error("TTS audio size invalid")
            return Buffer.from(data).toString("base64")
          },
          catch: () =>
            new Cooking.Invalid({ message: "语音合成失败，请检查 TTS 服务、音色和凭据；做菜指导继续运行。" }),
        }).pipe(
          Effect.timeout("20 seconds"),
          Effect.mapError(() => new Cooking.Invalid({ message: "语音合成失败或超时；做菜指导继续运行。" })),
        )
        const latest = yield* execution.get(input.session_id)
        if (
          !latest ||
          latest.id !== input.run_id ||
          latest.index !== input.index ||
          (latest.status !== "running" &&
            !(latest.status === "paused" && input.kind === "emergency" && latest.emergency)) ||
          (input.kind === "emergency" &&
            (latest.emergency?.id !== input.emergency_id || latest.emergency?.index !== input.emergency_index)) ||
          (input.kind !== "emergency" && !!latest.emergency) ||
          (input.kind === "warning" && latest.warning !== text)
        )
          return { status: "obsolete" } as const
        return { status: "ready", audio, voice } as const
      }),
    })
  }),
)
export const node = makeGlobalNode({ service: Service, layer, deps: [KitchenSettings.node, CookingExecution.node] })
