export * as ModelRuntimePlugin from "./model-runtime.js"

import { define } from "@opencook/plugin/effect/plugin"
import { Effect, Stream } from "effect"
import { Model } from "../model.js"
import { Provider } from "../provider.js"
import { KitchenSettings } from "../cooking/settings.js"

export const Plugin = define({
  id: "opencook.model-runtime",
  effect: Effect.fn(function* (ctx) {
    const settings = yield* KitchenSettings.Service
    const loaded = { value: yield* settings.get() }
    yield* ctx.integration.transform((editor) => {
      for (const role of ["chat", "vision"] as const) {
        const profile = loaded.value.models[role]
        const id = KitchenSettings.integrationID(role)
        editor.update(id, (integration) => {
          integration.name = role === "chat" ? "OpenCook 对话模型" : "OpenCook 多模态模型"
        })
        if (profile.source === "environment")
          editor.method.update({ integrationID: id, method: { type: "env", names: ["OPENCOOK_MODEL_API_KEY"] } })
        if (profile.source !== "environment")
          editor.method.update({ integrationID: id, method: { type: "key", label: "API Key" } })
      }
    })
    yield* ctx.provider.transform((editor) => {
      for (const provider of editor.list()) editor.remove(provider.provider.id)
      for (const role of ["chat", "vision"] as const) {
        const profile = loaded.value.models[role]
        if (!profile.enabled) continue
        const url = URL.parse(profile.base_url)
        if (
          !url ||
          !["http:", "https:"].includes(url.protocol) ||
          !Number.isSafeInteger(profile.context) ||
          !Number.isSafeInteger(profile.output) ||
          profile.output <= 0 ||
          profile.context <= profile.output
        )
          throw new Error("OpenCook model endpoint and context/output limits are invalid")
        const providerID = Provider.ID.make(KitchenSettings.integrationID(role))
        const id = Model.ID.make(role === "chat" ? "cook" : "vision")
        editor.add({
          info: {
            id: providerID,
            name: "OpenCook",
            activation: "enabled",
            package: "@opencook/ai/providers/openai-compatible",
            settings: { baseURL: profile.base_url, provider: String(providerID) },
          },
          models: [
            {
              ...Model.Info.default(providerID, id),
              modelID: Model.ID.make(profile.model),
              name: role === "chat" ? "Cook" : "Cook Vision",
              capabilities: { tools: true, input: role === "vision" ? ["text", "image"] : ["text"], output: ["text"] },
              limit: { context: profile.context, output: profile.output },
            },
          ],
        })
      }
    })
    yield* ctx.model.transform((editor) => editor.default.set(Provider.ID.make("opencook"), Model.ID.make("cook")))
    yield* settings.changes().pipe(
      Stream.filter((type) => type === "models"),
      Stream.runForEach(() =>
        Effect.gen(function* () {
          loaded.value = yield* settings.get()
          yield* ctx.integration.reload()
          yield* ctx.provider.reload()
          yield* ctx.model.reload()
        }).pipe(Effect.catchCause(() => Effect.logWarning("模型配置未能刷新，请检查配置文件；修正后将重新读取。"))),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
