import { expect } from "bun:test"
import { LLM } from "@opencook/ai"
import { Headers } from "effect/http"
import { Model } from "@opencook/core/model"
import { ModelResolver } from "@opencook/core/model-resolver"
import { Plugin } from "@opencook/core/plugin"
import { PluginHost } from "@opencook/core/plugin/host"
import { ModelRuntimePlugin } from "@opencook/core/plugin/model-runtime"
import { Provider } from "@opencook/core/provider"
import { KitchenSettings } from "@opencook/core/cooking/settings"
import { Effect, Schedule } from "effect"
import { withEnv } from "../fixture/env"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
it.live("uses locally saved chat and vision services and reloads model edits", () =>
  Effect.gen(function* () {
    const settings = yield* KitchenSettings.Service
    const plugins = yield* Plugin.Service
    const models = yield* Model.Service
    const resolver = yield* ModelResolver.Service
    const profile = {
      enabled: true,
      base_url: "https://user.test/v1",
      model: "user-model",
      context: 10000,
      output: 1000,
    }
    yield* settings.updateModel({ role: "chat", profile, api_key: "user-fixture-secret" })
    yield* settings.updateModel({
      role: "vision",
      profile: { ...profile, model: "vision-model" },
      api_key: "vision-fixture-secret",
    })
    yield* ModelRuntimePlugin.Plugin.effect(yield* PluginHost.make(plugins))
    expect((yield* models.available()).map((model) => String(model.id))).toEqual(["cook", "vision"])
    const resolved = yield* resolver.resolve()
    if (!resolved) throw new Error("Expected configured chat model")
    expect(String(resolved.model.id)).toBe("user-model")
    const headers = yield* resolved.model.route.auth.apply({
      request: LLM.request({ model: resolved.model, prompt: "test" }),
      body: "{}",
      method: "POST",
      url: resolved.model.route.endpoint.baseURL ?? "",
      headers: Headers.fromInput(resolved.model.route.defaults.headers),
    })
    expect(headers["authorization"]).toBe("Bearer user-fixture-secret")
    yield* settings.updateModel({ role: "chat", profile: { ...profile, model: "updated-model" } })
    yield* resolver.resolve().pipe(
      Effect.repeat({
        until: (result) => String(result?.model.id) === "updated-model",
        schedule: Schedule.spaced("10 millis"),
      }),
      Effect.timeout("2 seconds"),
    )
    expect(String((yield* resolver.resolve())?.model.id)).toBe("updated-model")
  }),
)
it.effect("does not fall back to another provider when operator model settings are absent", () =>
  withEnv(
    {
      OPENCOOK_MODEL_BASE_URL: undefined,
      OPENCOOK_MODEL_ID: undefined,
    },
    () =>
      Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const providers = yield* Provider.Service
        const models = yield* Model.Service
        yield* providers.transform((editor) => editor.update(Provider.ID.make("user-provider"), () => {}))
        yield* ModelRuntimePlugin.Plugin.effect(yield* PluginHost.make(plugins))
        expect(yield* providers.available()).toEqual([])
        expect(yield* models.default()).toBeUndefined()
      }),
  ),
)

it.effect("uses one internally configured model and keeps the API key out of public catalogs", () =>
  withEnv(
    {
      OPENCOOK_MODEL_BASE_URL: "https://gateway.example.test/v1",
      OPENCOOK_MODEL_ID: "internal-recipe-model",
      OPENCOOK_MODEL_API_KEY: "fixture-secret",
    },
    () =>
      Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const providers = yield* Provider.Service
        const models = yield* Model.Service
        const resolver = yield* ModelResolver.Service
        yield* providers.transform((editor) => editor.update(Provider.ID.make("user-provider"), () => {}))
        yield* ModelRuntimePlugin.Plugin.effect(yield* PluginHost.make(plugins))
        expect((yield* providers.available()).map((provider) => String(provider.id))).toEqual(["opencook"])
        expect((yield* models.available()).map((model) => String(model.id))).toEqual(["cook"])
        expect(JSON.stringify(yield* providers.available())).not.toContain("fixture-secret")
        const resolved = yield* resolver.resolve()
        expect(String(resolved?.model.id)).toBe("internal-recipe-model")
        if (!resolved) throw new Error("Expected the configured model")
        const headers = yield* resolved.model.route.auth.apply({
          request: LLM.request({ model: resolved.model, prompt: "test" }),
          body: "{}",
          method: "POST",
          url: resolved.model.route.endpoint.baseURL ?? "",
          headers: Headers.fromInput(resolved.model.route.defaults.headers),
        })
        expect(headers["authorization"]).toBe("Bearer fixture-secret")
      }),
  ),
)

it.live("manual opencook.json edits refresh the model and its transport credential", () =>
  Effect.gen(function* () {
    const settings = yield* KitchenSettings.Service
    const plugins = yield* Plugin.Service
    const resolver = yield* ModelResolver.Service
    const profile = {
      enabled: true,
      base_url: "https://file.test/v1",
      model: "first-file-model",
      context: 10000,
      output: 1000,
    }
    yield* settings.updateModel({ role: "chat", profile, api_key: "first-fixture-key" })
    yield* ModelRuntimePlugin.Plugin.effect(yield* PluginHost.make(plugins))
    const file = (yield* settings.get()).config_file!
    yield* Effect.promise(() =>
      Bun.write(
        file,
        JSON.stringify({
          cooking_models: { chat: { ...profile, model: "second-file-model", api_key: "second-fixture-key" } },
        }),
      ),
    )
    const resolved = yield* resolver.resolve().pipe(
      Effect.repeat({
        until: (value) => String(value?.model.id) === "second-file-model",
        schedule: Schedule.spaced("10 millis"),
      }),
      Effect.timeout("3 seconds"),
    )
    if (!resolved) throw new Error("Expected file-configured model")
    const headers = yield* resolved.model.route.auth.apply({
      request: LLM.request({ model: resolved.model, prompt: "fixture" }),
      body: "{}",
      method: "POST",
      url: resolved.model.route.endpoint.baseURL ?? "",
      headers: Headers.fromInput(resolved.model.route.defaults.headers),
    })
    expect(headers["authorization"]).toBe("Bearer second-fixture-key")
  }),
)
