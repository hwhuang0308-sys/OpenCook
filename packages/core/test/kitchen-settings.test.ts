import { Global } from "@opencook/util/global"
import { tempGlobalLayer } from "./fixture/global"
import path from "path"
import { expect } from "bun:test"
import { Effect, Exit } from "effect"
import { KitchenSettings } from "@opencook/core/cooking/settings"
import { SensorRecording } from "@opencook/core/cooking/devices/recording"
import { Credential } from "@opencook/core/credential"
import { KV } from "@opencook/core/kv"
import { AppNodeBuilder } from "@opencook/core/effect/app-node-builder"
import { FSUtil } from "@opencook/util/fs-util"
import { LayerNode } from "@opencook/util/effect/layer-node"
import { withEnv } from "./fixture/env"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([SensorRecording.node, KitchenSettings.node, KV.node, Credential.node, FSUtil.node]),
    [Global.node.replace(tempGlobalLayer)],
  ),
)
const profile = { enabled: true, base_url: "https://example.test/v1", model: "test-cook", context: 10000, output: 2000 }

it.effect("stores purpose-specific model configuration and never returns secrets in settings", () =>
  Effect.gen(function* () {
    const settings = yield* KitchenSettings.Service
    const kv = yield* KV.Service
    const credentials = yield* Credential.Service
    const updated = yield* settings.updateModel({ role: "chat", profile, api_key: "fixture-private-key" })
    expect(updated.models.chat).toMatchObject({ ...profile, has_key: true, source: "user" })
    expect(JSON.stringify(updated)).not.toContain("fixture-private-key")
    const stored = yield* Effect.promise(() => Bun.file(updated.config_file!).json())
    expect(stored.cooking_models.chat).toMatchObject({ ...profile, api_key: "fixture-private-key" })
    expect(JSON.stringify((yield* kv.get("opencook/settings")) ?? {})).not.toContain("fixture-private-key")
    expect((yield* credentials.list(KitchenSettings.integrationID("chat"))).at(-1)?.value).toEqual({
      type: "key",
      key: "fixture-private-key",
    })
    yield* settings.updateModel({
      role: "embedding",
      profile: { ...profile, model: "test-embedding" },
      api_key: "fixture-embedding-key",
    })
    yield* settings.updateModel({ role: "chat", profile: { ...profile, model: "updated" } })
    expect((yield* settings.model("chat")).api_key).toBe("fixture-private-key")
    expect((yield* settings.model("embedding")).api_key).toBe("fixture-embedding-key")
    yield* settings.updateModel({ role: "chat", profile, api_key: null })
    expect((yield* settings.get()).models.chat.has_key).toBe(false)
  }),
)

it.effect("rejects invalid model limits without overwriting configuration or keys", () =>
  Effect.gen(function* () {
    const settings = yield* KitchenSettings.Service
    yield* settings.updateModel({ role: "chat", profile, api_key: "original" })
    const result = yield* settings
      .updateModel({ role: "chat", profile: { ...profile, output: 10000 }, api_key: "replacement" })
      .pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    expect((yield* settings.model("chat")).api_key).toBe("original")
  }),
)

it.effect("explicit user disabling does not fall back to an operator's token", () =>
  withEnv(
    {
      OPENCOOK_MODEL_BASE_URL: "https://operator.test/v1",
      OPENCOOK_MODEL_ID: "operator-model",
      OPENCOOK_MODEL_API_KEY: "operator-key",
    },
    () =>
      Effect.gen(function* () {
        const settings = yield* KitchenSettings.Service
        expect((yield* settings.model("chat")).source).toBe("environment")
        yield* settings.updateModel({ role: "chat", profile: KitchenSettings.emptyModel() })
        expect(yield* settings.model("chat")).toMatchObject({ enabled: false, source: "user", has_key: false })
        expect((yield* settings.model("chat")).api_key).toBeUndefined()
      }),
  ),
)

it.effect("separates RTSP credentials and rejects conflicting serial-port assignments", () =>
  Effect.gen(function* () {
    const settings = yield* KitchenSettings.Service
    const devices = KitchenSettings.defaultDevices()
    const updated = yield* settings.updateDevices({
      devices: {
        ...devices,
        camera: { ...devices.camera, enabled: true, rtsp_url: "rtsp://admin:fixture-camera-key@example.test/live" },
      },
    })
    expect(updated.devices.camera.rtsp_url).toBe("rtsp://admin@example.test/live")
    expect(updated.camera_has_password).toBe(true)
    expect(yield* settings.cameraURL()).toBe("rtsp://admin:fixture-camera-key@example.test/live")
    const conflict = yield* settings
      .updateDevices({
        devices: {
          ...devices,
          sound: { ...devices.sound, enabled: true, port: "COM4" },
          air: { ...devices.air, enabled: true, port: "COM4" },
        },
      })
      .pipe(Effect.exit)
    expect(Exit.isFailure(conflict)).toBe(true)
    expect((yield* settings.get()).devices.camera.enabled).toBe(true)
  }),
)

it.live("records no sensor files by default, records when enabled, and stops immediately after disabling", () =>
  Effect.gen(function* () {
    const settings = yield* KitchenSettings.Service
    const recorder = yield* SensorRecording.Service
    const fs = yield* FSUtil.Service
    const temporary = yield* tmpdirScoped()
    const directory = path.join(temporary.path, "captures")
    expect((yield* settings.get()).recording.enabled).toBe(false)
    yield* settings.updateRecording({ enabled: false, directory })
    const frame = { width: 1, height: 1, data: Uint8Array.from([0, 128, 255]) }
    const matrix = Float32Array.from({ length: 768 }, (_, index) => index / 10)
    yield* recorder.image(frame, 1000)
    yield* recorder.temperature(matrix, 1000)
    yield* recorder.scalar("sound", 53.2, 1000)
    yield* recorder.warning("测试", 1000)
    expect(yield* fs.existsSafe(directory)).toBe(false)
    yield* settings.updateRecording({ enabled: true, directory })
    yield* recorder.scalar("sound", 53.2, 2000)
    yield* recorder.image(frame, 2000)
    yield* recorder.temperature(matrix, 2000)
    const before = yield* fs.readFileString(path.join(directory, "sound", "samples.jsonl"))
    expect(before).toContain('"value":53.2')
    expect(yield* fs.existsSafe(path.join(directory, "camera", "1970-01-01T00-00-02-000Z.jpg"))).toBe(true)
    expect(yield* fs.existsSafe(path.join(directory, "temperature", "1970-01-01T00-00-02-000Z.png"))).toBe(true)
    yield* settings.updateRecording({ enabled: false, directory })
    yield* recorder.scalar("sound", 99, 3000)
    yield* recorder.image(frame, 3000)
    expect(yield* fs.readFileString(path.join(directory, "sound", "samples.jsonl"))).toBe(before)
    expect(yield* fs.existsSafe(path.join(directory, "camera", "1970-01-01T00-00-03-000Z.jpg"))).toBe(false)
  }),
)

it.live(
  "migrates all legacy model profiles and keys once, preserves other fields, and respects subsequent file clearing",
  () =>
    Effect.gen(function* () {
      const settings = yield* KitchenSettings.Service
      const kv = yield* KV.Service
      const credentials = yield* Credential.Service
      const fs = yield* FSUtil.Service
      const file = (yield* settings.get()).config_file!
      yield* fs.writeWithDirs(file, '{\n  "model": "opencook/cook",\n  "websearch": "fixture"\n}\n')
      yield* kv.set("opencook/settings", {
        models: Object.fromEntries(
          ["chat", "vision", "speech", "embedding", "rerank"].map((role) => [role, { ...profile, model: role }]),
        ),
        devices: KitchenSettings.defaultDevices(),
        recording: { enabled: false, directory: "/fixture" },
      })
      for (const role of ["chat", "vision", "speech", "embedding", "rerank"] as const)
        yield* credentials.create({
          integrationID: KitchenSettings.integrationID(role),
          label: "legacy",
          value: { type: "key", key: `fixture-${role}` },
        })
      const migrated = yield* settings.get()
      const document = yield* Effect.promise(() => Bun.file(file).json())
      expect(document.websearch).toBe("fixture")
      for (const role of ["chat", "vision", "speech", "embedding", "rerank"] as const) {
        expect(document.cooking_models[role]).toMatchObject({ model: role, api_key: `fixture-${role}` })
        expect(migrated.models[role].has_key).toBe(true)
      }
      expect(yield* kv.get("opencook/settings")).toMatchObject({ models: {} })
      // Public/cleared config is authoritative: old DB credentials must not reappear.
      yield* fs.writeFileString(file, '{"cooking_models": {}}')
      expect((yield* settings.get()).models.chat).toMatchObject({ enabled: false, has_key: false })
      expect((yield* settings.model("chat")).api_key).toBeUndefined()
      expect(yield* credentials.list(KitchenSettings.integrationID("chat"))).toEqual([])
    }),
)

it.live("reads manual file edits and round-trips settings without losing JSONC comments or other roles", () =>
  Effect.gen(function* () {
    const settings = yield* KitchenSettings.Service
    const fs = yield* FSUtil.Service
    const file = (yield* settings.get()).config_file!
    yield* fs.writeWithDirs(
      file,
      '{\n// fixture comment\n"model":"opencook/cook",\n"cooking_models": {"chat":' +
        JSON.stringify({ ...profile, api_key: "manual-key" }) +
        "}\n}\n",
    )
    expect((yield* settings.model("chat")).api_key).toBe("manual-key")
    yield* settings.updateModel({
      role: "speech",
      profile: { ...profile, model: "tts", voice: "female_news" },
      api_key: "tts-key",
    })
    const text = yield* fs.readFileString(file)
    expect(text).toContain("// fixture comment")
    expect(text).toContain('"model":"opencook/cook"')
    expect((yield* settings.model("chat")).api_key).toBe("manual-key")
    expect((yield* settings.model("speech")).voice).toBe("female_news")
    yield* fs.writeFileString(file, '{"cooking_models": {"chat": "invalid"}}')
    const result = yield* settings.updateModel({ role: "chat", profile, api_key: "replacement" }).pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    expect(yield* fs.readFileString(file)).toContain('"invalid"')
    expect(yield* fs.readFileString(file)).not.toContain("replacement")
  }),
)

it.live("a fresh checkout saves beside opencook.example.json when launched from its nested CLI directory", () =>
  Effect.gen(function* () {
    const temporary = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const nested = path.join(temporary.path, "packages", "cli")
    yield* fs.ensureDir(nested)
    yield* fs.writeFileString(path.join(temporary.path, "opencook.example.json"), "{}")
    yield* Effect.gen(function* () {
      const settings = yield* KitchenSettings.Service
      const updated = yield* settings.updateModel({ role: "chat", profile, api_key: "fresh-fixture-key" })
      expect(updated.config_file).toBe(path.join(temporary.path, "opencook.json"))
      const document = yield* Effect.promise(() => Bun.file(updated.config_file!).json())
      expect(document.cooking_models.chat).toMatchObject({ model: profile.model, api_key: "fresh-fixture-key" })
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(KitchenSettings.configured({ project: true, directory: nested }), [
          Global.node.replace(tempGlobalLayer),
        ]),
      ),
    )
  }),
)
