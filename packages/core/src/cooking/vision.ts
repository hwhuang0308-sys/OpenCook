export * as CookingVision from "./vision.js"

import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencook/util/effect/app-node"
import { KitchenSettings } from "./settings.js"
export class Error extends Schema.TaggedError<Error>()("CookingVision.Error", { message: Schema.String }) {}
export class Service extends Context.Service<
  Service,
  {
    readonly check: (image: Uint8Array, prompt: string) => Effect.Effect<boolean, Error>
  }
>()("@opencook/CookingVision") {}
const Response = Schema.Struct({
  choices: Schema.Array(Schema.Struct({ message: Schema.Struct({ content: Schema.String }) })),
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const settings = yield* KitchenSettings.Service
    const visual = (image: Uint8Array, prompt: string) =>
      Effect.gen(function* () {
        const profile = yield* settings.model("vision")
        if (!profile.enabled || !profile.api_key) return yield* new Error({ message: "视觉模型尚未配置" })
        const raw = yield* Effect.tryPromise({
          try: async (signal) => {
            const response = await fetch(`${profile.base_url.replace(/\/$/, "")}/chat/completions`, {
              method: "POST",
              signal,
              headers: { authorization: `Bearer ${profile.api_key}`, "content-type": "application/json" },
              body: JSON.stringify({
                model: profile.model,
                messages: [
                  {
                    role: "user",
                    content: [
                      { type: "text", text: prompt },
                      {
                        type: "image_url",
                        image_url: { url: `data:image/jpeg;base64,${Buffer.from(image).toString("base64")}` },
                      },
                    ],
                  },
                ],
                max_tokens: 32,
              }),
            })
            if (!response.ok) throw new globalThis.Error(`HTTP ${response.status}`)
            return response.json()
          },
          catch: () => new Error({ message: "视觉模型请求失败" }),
        }).pipe(
          Effect.timeout("10 seconds"),
          Effect.mapError(() => new Error({ message: "视觉模型请求失败或超时" })),
        )
        const response = yield* Schema.decodeUnknownEffect(Response)(raw).pipe(
          Effect.mapError(() => new Error({ message: "视觉模型响应格式无效" })),
        )
        const answer = response.choices[0]?.message.content.trim()
        if (answer !== "0" && answer !== "1") return yield* new Error({ message: "视觉模型未返回有效的 0/1 判定" })
        return answer === "1"
      })
    return Service.of({ check: visual })
  }),
)
export const node = makeGlobalNode({ service: Service, layer, deps: [KitchenSettings.node] })
