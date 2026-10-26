export * as VerbosityPlugin from "./verbosity.js"

import { define } from "@opencook/plugin/effect/plugin"
import type { SessionRequest } from "@opencook/plugin/effect/session"
import { Effect } from "effect"
import { Model } from "../model.js"
import { Provider } from "../provider.js"
import type { PluginInternal } from "./internal.js"

const direct = new Set([
  "@opencook/ai/providers/openai",
  "@opencook/ai/providers/openai/responses",
  "@opencook/ai/providers/azure",
  "@opencook/ai/providers/azure/responses",
])
const gateways = new Set([
  "@opencook/ai/providers/cloudflare-ai-gateway",
  "@opencook/ai/providers/vercel-ai-gateway",
  Provider.aisdk("@ai-sdk/gateway"),
])

export const Plugin = define({
  id: "opencook.prompt.verbosity",
  effect: Effect.fn("VerbosityPlugin")(function* (ctx) {
    const models = yield* Model.Service
    const hook = (event: SessionRequest) =>
      Effect.gen(function* () {
        if (event.options.textVerbosity !== undefined) return
        const model = yield* models.get(event.model.providerID, event.model.id)
        if (!model) return
        const id = openAIModelID(model)
        if (!id || !supportsVerbosity(id)) return
        if (model.settings?.textVerbosity !== undefined) return
        const variant = model.variants.find((item) => item.id === event.model.variant)
        if (variant?.settings?.textVerbosity !== undefined) return
        event.options.textVerbosity = "low"
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
    yield* ctx.session.hook("title", hook)
  }),
} satisfies PluginInternal.InternalPlugin)

function supportsVerbosity(id: string) {
  if (id.includes("gpt-6")) return true
  if (id.includes("-chat") || id.includes("-image")) return false
  // New GPT-5 minor versions remain unset until their support is known.
  return /(?:^|[/.])gpt-5\.[1-6](?:[.:-]|$)/.test(id) || /(?:^|[/.])gpt-5(?:-(?:mini|nano)(?:[.:-]|$)|$)/.test(id)
}

function openAIModelID(model: Model.Info) {
  const id = model.modelID.toLowerCase()
  if (direct.has(model.package ?? "")) return id
  if (model.package === "@opencook/ai/providers/amazon-bedrock/mantle/responses" && id.startsWith("openai."))
    return id.slice("openai.".length)
  if (gateways.has(model.package ?? "") && id.startsWith("openai/")) return id.slice("openai/".length)
}
