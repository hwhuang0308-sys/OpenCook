import { Global } from "@opencook/util/global"
import { tempGlobalLayer } from "./fixture/global"
import { expect } from "bun:test"
import { Effect, Fiber, Schema } from "effect"
import { Cooking } from "@opencook/schema/cooking"
import { Kitchen } from "@opencook/schema/kitchen"
import { KitchenSettings } from "@opencook/core/cooking/settings"
import { CookingSpeech } from "@opencook/core/cooking/speech"
import { CookingExecution } from "@opencook/core/cooking/execution"
import { KV } from "@opencook/core/kv"
import { AppNodeBuilder } from "@opencook/core/effect/app-node-builder"
import { LayerNode } from "@opencook/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CookingSpeech.node, CookingExecution.node, KitchenSettings.node, KV.node]), [
    Global.node.replace(tempGlobalLayer),
  ]),
)
const plan: Cooking.Plan = {
  task_id: "speech-fixture",
  revision: 1,
  dish: "土豆",
  recipe_text: "测试菜谱",
  program: "测试程序谱",
  actions: "测试动作谱",
  steps: ["清洗土豆", "切土豆成片"].map((action) => ({
    action,
    continuous: false,
    seconds: 0,
    conditions: [],
    logic: "",
  })),
}

it.live(
  "uses the configured TTS model, defaults to the supported female voice, and skips disabled or obsolete speech",
  () =>
    Effect.gen(function* () {
      const received: Array<Record<string, unknown>> = []
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            async fetch(request) {
              expect(new URL(request.url).pathname).toBe("/v1/audio/speech")
              received.push((await request.json()) as Record<string, unknown>)
              return new Response(new Uint8Array([73, 68, 51, 1]), { headers: { "content-type": "audio/mpeg" } })
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const speech = yield* CookingSpeech.Service
      const execution = yield* CookingExecution.Service
      const settings = yield* KitchenSettings.Service
      const run = yield* execution.start("session-a", plan)
      const request: Cooking.SpeechRequest = { session_id: "session-a", run_id: run.id, index: 0, kind: "step" }
      expect(yield* speech.synthesize(request)).toEqual({ status: "disabled" })
      const profile = { enabled: true, model: "ecnu-tts", base_url: `${server.url}v1`, context: 4096, output: 1024 }
      yield* settings.updateModel({ role: "speech", profile, api_key: "fixture-secret" })
      expect(yield* speech.synthesize(request)).toMatchObject({ status: "ready", voice: "female_news" })
      expect(received[0]).toEqual({
        model: "ecnu-tts",
        input: "第1步，清洗土豆。",
        voice: "female_news",
        speed: 1,
        response_format: "mp3",
      })
      yield* settings.updateModel({ role: "speech", profile: { ...profile, voice: "liwa", speed: 1.1 } })
      yield* speech.synthesize(request)
      expect(received[1]).toMatchObject({ voice: "liwa", speed: 1.1 })
      expect(() =>
        Schema.decodeUnknownSync(Kitchen.ModelUpdate)({ role: "speech", profile: { ...profile, speed: 9 } }),
      ).toThrow()
      yield* execution.control({ session_id: "session-a", run_id: run.id, index: 0, action: "confirm" })
      expect(yield* speech.synthesize(request)).toEqual({ status: "obsolete" })
      expect(received).toHaveLength(2)
    }),
)

it.live("slow synthesis never blocks advancing a step, and a late audio response is discarded", () =>
  Effect.gen(function* () {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          async fetch() {
            entered.resolve()
            await release.promise
            return new Response(new Uint8Array([73, 68, 51, 1]), { headers: { "content-type": "audio/mpeg" } })
          },
        }),
      ),
      (server) =>
        Effect.sync(() => {
          release.resolve()
          server.stop(true)
        }),
    )
    const speech = yield* CookingSpeech.Service
    const execution = yield* CookingExecution.Service
    const settings = yield* KitchenSettings.Service
    yield* settings.updateModel({
      role: "speech",
      profile: { enabled: true, model: "fixture-tts", base_url: `${server.url}v1`, context: 4096, output: 1024 },
      api_key: "fixture-secret",
    })
    const run = yield* execution.start("session-a", plan)
    const pending = yield* speech
      .synthesize({ session_id: "session-a", run_id: run.id, index: 0, kind: "step" })
      .pipe(Effect.forkChild({ startImmediately: true }))
    yield* Effect.promise(() => entered.promise)
    const advanced = yield* execution.control({ session_id: "session-a", run_id: run.id, index: 0, action: "confirm" })
    expect(advanced.index).toBe(1)
    release.resolve()
    expect(yield* Fiber.join(pending)).toEqual({ status: "obsolete" })
  }),
)

it.live("stopping an emergency retains its history but rejects further emergency narration", () =>
  Effect.gen(function* () {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let requests = 0
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          async fetch() {
            requests++
            entered.resolve()
            await release.promise
            return new Response(new Uint8Array([73, 68, 51, 1]), { headers: { "content-type": "audio/mpeg" } })
          },
        }),
      ),
      (server) =>
        Effect.sync(() => {
          release.resolve()
          server.stop(true)
        }),
    )
    const execution = yield* CookingExecution.Service
    const speech = yield* CookingSpeech.Service
    const settings = yield* KitchenSettings.Service
    const kv = yield* KV.Service
    yield* settings.updateModel({
      role: "speech",
      api_key: "fixture-secret",
      profile: { enabled: true, model: "fixture-tts", base_url: `${server.url}v1`, context: 4096, output: 1024 },
    })
    const run: Cooking.Run = {
      id: "stopped-emergency",
      session_id: "session-a",
      plan,
      status: "paused",
      index: 0,
      elapsed_ms: 0,
      started_at: 0,
      updated_at: 0,
      completions: [],
      emergency: { id: "fire", kind: "fire", index: 0, steps: ["立即关火"], interrupted_step: 0, time: 0 },
      incidents: [{ id: "fire", kind: "fire", step: 0, time: 0 }],
    }
    yield* kv.set("cooking/execution/session-a", Schema.encodeSync(Schema.toCodecJson(Cooking.Run))(run))
    const request: Cooking.SpeechRequest = {
      session_id: "session-a",
      run_id: run.id,
      index: 0,
      kind: "emergency",
      emergency_id: "fire",
      emergency_index: 0,
    }
    const pending = yield* speech.synthesize(request).pipe(Effect.forkChild({ startImmediately: true }))
    yield* Effect.promise(() => entered.promise)
    const stopped = yield* execution.control({ session_id: "session-a", run_id: run.id, index: 0, action: "stop" })
    expect(stopped.emergency?.id).toBe("fire")
    expect(stopped.incidents?.[0].resolved_at).toBeUndefined()
    release.resolve()
    expect(yield* Fiber.join(pending)).toEqual({ status: "obsolete" })
    expect(yield* speech.synthesize(request)).toEqual({ status: "obsolete" })
    expect(requests).toBe(1)
  }),
)
