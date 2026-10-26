export * as KitchenSettings from "./settings.js"

import path from "path"
import fs from "node:fs/promises"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { Context, Effect, Layer, PubSub, Schema, Semaphore, Stream } from "effect"
import { Kitchen } from "@opencook/schema/kitchen"
import { Integration } from "@opencook/schema/integration"
import { makeGlobalNode } from "@opencook/util/effect/app-node"
import { Global } from "@opencook/util/global"
import { Credential } from "../credential.js"
import { KV } from "../kv.js"

const Stored = Schema.Struct({
  models: Schema.Record(Kitchen.ModelRole, Schema.optionalKey(Kitchen.ModelProfile)),
  devices: Kitchen.Devices,
  recording: Kitchen.Recording,
})
const decode = Schema.decodeUnknownSync(Schema.toCodecJson(Stored))
const encode = Schema.encodeSync(Schema.toCodecJson(Stored))
const key = "opencook/settings"
export const integrationID = (role: Kitchen.ModelRole) =>
  Integration.ID.make(role === "chat" ? "opencook" : `opencook-${role}`)
const cameraID = Integration.ID.make("opencook-camera")
export const emptyModel = (): Kitchen.ModelProfile => ({
  enabled: false,
  base_url: "",
  model: "",
  context: 128000,
  output: 8192,
})
export const defaultDevices = (): Kitchen.Devices => ({
  camera: { enabled: false, rtsp_url: "", buffer_frames: 60, ffmpeg_path: "" },
  temperature: {
    enabled: false,
    port: "",
    baud_rate: 115200,
    timeout_ms: 2000,
    sample_period_ms: 500,
    buffer_seconds: 60,
  },
  sound: { enabled: false, port: "", baud_rate: 9600, timeout_ms: 1000, sample_period_ms: 500, buffer_seconds: 60 },
  air: { enabled: false, port: "", baud_rate: 9600, timeout_ms: 1000, sample_period_ms: 1000, buffer_seconds: 60 },
})

const modelProblem = (profile: Kitchen.ModelProfile) => {
  if (!profile.enabled) return
  const url = URL.parse(profile.base_url)
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || !profile.model.trim())
    return "启用模型需要有效的 HTTP(S) 服务地址和模型名称；密钥请填写在 API Key 中。"
  if (profile.context <= profile.output) return "上下文长度必须大于输出上限。"
}

export interface Interface {
  readonly get: () => Effect.Effect<Kitchen.Settings>
  readonly recording: () => Effect.Effect<Kitchen.Recording>
  readonly model: (role: Kitchen.ModelRole) => Effect.Effect<Kitchen.ModelView & { readonly api_key?: string }>
  readonly cameraURL: () => Effect.Effect<string>
  readonly updateModel: (input: Kitchen.ModelUpdate) => Effect.Effect<Kitchen.Settings, Kitchen.InvalidSettings>
  readonly updateDevices: (input: Kitchen.DeviceUpdate) => Effect.Effect<Kitchen.Settings, Kitchen.InvalidSettings>
  readonly updateRecording: (input: Kitchen.Recording) => Effect.Effect<Kitchen.Settings, Kitchen.InvalidSettings>
  readonly changes: () => Stream.Stream<"models" | "devices" | "recording">
}
export class Service extends Context.Service<Service, Interface>()("@opencook/KitchenSettings") {}

export interface Options {
  readonly file?: string
  readonly content?: string
  readonly project?: boolean
  readonly directory?: string
}

export const layer = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const credentials = yield* Credential.Service
      const global = yield* Global.Service
      const updates = yield* PubSub.unbounded<"models" | "devices" | "recording">()
      const lock = Semaphore.makeUnsafe(1)
      const load = () =>
        kv.get(key).pipe(
          Effect.map((value) =>
            value
              ? decode(value)
              : {
                  models: {},
                  devices: defaultDevices(),
                  recording: { enabled: false, directory: path.join(global.data, "sensor-debug") },
                },
          ),
        )
      const secret = (id: Integration.ID) =>
        credentials.list(id).pipe(
          Effect.map((values) => {
            const value = values.at(-1)?.value
            return value?.type === "key" ? value.key : undefined
          }),
        )
      const saveSecret = Effect.fn(function* (id: Integration.ID, value: string | null | undefined) {
        if (value === undefined) return
        const entries = yield* credentials.list(id)
        if (value === null || !value.trim()) {
          yield* Effect.forEach(entries, (entry) => credentials.remove(entry.id), { discard: true })
          return
        }
        const current = entries.at(-1)
        if (current) {
          yield* credentials.update(current.id, { value: { type: "key", key: value } })
          return
        }
        yield* credentials.create({ integrationID: id, value: { type: "key", key: value }, label: "OpenCook" })
      })
      const directory = options.project ? (options.directory ?? process.cwd()) : global.config
      const candidates: string[] = []
      for (let item = directory; ; item = path.dirname(item)) {
        candidates.push(path.join(item, "opencook.jsonc"), path.join(item, "opencook.json"))
        if (!options.project || path.dirname(item) === item) break
      }
      const inline = options.content === undefined ? undefined : { text: options.content }
      const file = inline
        ? "<inline>"
        : options.file
          ? path.resolve(options.file)
          : yield* Effect.promise(async () => {
              for (const candidate of candidates) if (await Bun.file(candidate).exists()) return candidate
              if (options.project)
                for (const candidate of candidates) {
                  if (
                    path.basename(candidate) === "opencook.json" &&
                    (await Bun.file(path.join(path.dirname(candidate), "opencook.example.json")).exists())
                  )
                    return candidate
                }
              return path.join(global.config, "opencook.json")
            })
      const readDocument = () =>
        Effect.tryPromise({
          try: async () => {
            const text = inline ? inline.text : (await Bun.file(file).exists()) ? await Bun.file(file).text() : "{}\n"
            const errors: ParseError[] = []
            const value: unknown = parse(text, errors, { allowTrailingComma: true })
            if (errors.length || !value || typeof value !== "object" || Array.isArray(value))
              throw new Error("Invalid configuration")
            return { text, value: value as Record<string, unknown> }
          },
          catch: () =>
            new Kitchen.InvalidSettings({ message: "无法读取模型配置文件，请检查 opencook.json 的格式和权限。" }),
        })
      const writeModels = (models: Kitchen.ModelConfig) =>
        Effect.gen(function* () {
          const document = yield* readDocument()
          const text = applyEdits(
            document.text,
            modify(document.text, ["cooking_models"], models, {
              formattingOptions: { tabSize: 2, insertSpaces: true },
            }),
          )
          if (inline) {
            inline.text = text
            return
          }
          yield* Effect.tryPromise({
            try: async () => {
              await fs.mkdir(path.dirname(file), { recursive: true })
              const temporary = `${file}.${crypto.randomUUID()}.tmp`
              try {
                await fs.writeFile(temporary, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 })
                await fs.rename(temporary, file)
              } finally {
                await fs.rm(temporary, { force: true })
              }
            },
            catch: () =>
              new Kitchen.InvalidSettings({ message: "无法保存模型配置文件，请检查 opencook.json 的写入权限。" }),
          })
        })
      const migrationLock = Semaphore.makeUnsafe(1)
      const readModels = () =>
        migrationLock.withPermit(
          Effect.gen(function* () {
            const document = yield* readDocument()
            const legacy = yield* load()
            if (document.value.cooking_models === undefined && Object.keys(legacy.models).length) {
              const models: Kitchen.ModelConfig = Object.fromEntries(
                yield* Effect.forEach(Kitchen.modelRoles, (role) =>
                  Effect.gen(function* () {
                    const profile = legacy.models[role]
                    return profile ? [role, { ...profile, api_key: yield* secret(integrationID(role)) }] : undefined
                  }),
                ).pipe(Effect.map((entries) => entries.filter((entry) => entry !== undefined))),
              )
              yield* writeModels(models)
              yield* kv.set(key, encode({ ...legacy, models: {} }))
              return models
            }
            const models = yield* Schema.decodeUnknownEffect(Kitchen.ModelConfig)(
              document.value.cooking_models ?? {},
            ).pipe(
              Effect.mapError(
                () => new Kitchen.InvalidSettings({ message: "opencook.json 中的 cooking_models 配置无效。" }),
              ),
            )
            for (const profile of Object.values(models)) {
              if (!profile) continue
              const problem = modelProblem(profile)
              if (problem) return yield* new Kitchen.InvalidSettings({ message: problem })
            }
            if (Object.keys(legacy.models).length) yield* kv.set(key, encode({ ...legacy, models: {} }))
            return models
          }),
        )
      const model = Effect.fn(function* (role: Kitchen.ModelRole) {
        const models = yield* readModels().pipe(Effect.orDie)
        const profile = models[role]
        const api_key = profile?.api_key
        // Credentials are a derived transport cache for the chat provider, never a fallback source.
        if ((yield* secret(integrationID(role))) !== api_key) yield* saveSecret(integrationID(role), api_key ?? null)
        if (profile) return { ...profile, has_key: !!api_key, source: "user" as const }
        if (role !== "chat" || !process.env.OPENCOOK_MODEL_BASE_URL || !process.env.OPENCOOK_MODEL_ID)
          return { ...emptyModel(), has_key: false, source: "unconfigured" as const }
        return {
          enabled: true,
          base_url: process.env.OPENCOOK_MODEL_BASE_URL.trim(),
          model: process.env.OPENCOOK_MODEL_ID.trim(),
          context: Number(process.env.OPENCOOK_MODEL_CONTEXT ?? 128000),
          output: Number(process.env.OPENCOOK_MODEL_OUTPUT ?? 8192),
          has_key: !!process.env.OPENCOOK_MODEL_API_KEY,
          source: "environment" as const,
          api_key: process.env.OPENCOOK_MODEL_API_KEY,
        }
      })
      const get = Effect.fn(function* () {
        const stored = yield* load()
        const models = Object.fromEntries(
          yield* Effect.forEach(Kitchen.modelRoles, (role) =>
            model(role).pipe(
              Effect.map((value) => {
                const { api_key, ...view } = value
                return [role, view] as const
              }),
            ),
          ),
        ) as Kitchen.Settings["models"]
        return { ...stored, config_file: file, models, camera_has_password: !!(yield* secret(cameraID)) }
      })
      const persist = (stored: typeof Stored.Type, type: "models" | "devices" | "recording") =>
        kv.set(key, encode(stored)).pipe(Effect.andThen(PubSub.publish(updates, type)), Effect.andThen(get()))
      let previous = (yield* readDocument().pipe(Effect.orDie)).text
      yield* Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep("1 second")
          const document = yield* readDocument().pipe(Effect.result)
          if (document._tag === "Failure" || document.success.text === previous) continue
          previous = document.success.text
          yield* PubSub.publish(updates, "models")
        }
      }).pipe(Effect.forkIn(yield* Effect.scope))
      return Service.of({
        get,
        model,
        recording: () => load().pipe(Effect.map((stored) => stored.recording)),
        changes: () => Stream.fromPubSub(updates),
        cameraURL: Effect.fn(function* () {
          const stored = yield* load()
          const url = URL.parse(stored.devices.camera.rtsp_url)
          if (!url) return ""
          url.password = (yield* secret(cameraID)) ?? ""
          return url.toString()
        }),
        updateModel: (input) =>
          lock.withPermit(
            Effect.gen(function* () {
              const profile = {
                ...input.profile,
                model: input.profile.model.trim(),
                base_url: input.profile.base_url.trim().replace(/\/+$/, ""),
              }
              const problem = modelProblem(profile)
              if (problem) return yield* new Kitchen.InvalidSettings({ message: problem })
              const models = yield* readModels()
              const api_key =
                input.api_key === undefined ? models[input.role]?.api_key : input.api_key?.trim() || undefined
              yield* writeModels({ ...models, [input.role]: { ...profile, api_key } })
              yield* saveSecret(integrationID(input.role), api_key ?? null)
              yield* PubSub.publish(updates, "models")
              return yield* get()
            }),
          ),
        updateDevices: (input) =>
          lock.withPermit(
            Effect.gen(function* () {
              const camera = input.devices.camera
              const url = URL.parse(camera.rtsp_url)
              if (camera.rtsp_url && (!url || !["rtsp:", "rtsps:"].includes(url.protocol)))
                return yield* new Kitchen.InvalidSettings({ message: "摄像头地址需要使用 rtsp:// 或 rtsps://。" })
              const ports = [input.devices.temperature, input.devices.sound, input.devices.air].filter(
                (device) => device.enabled,
              )
              if (ports.some((device) => !device.port.trim()))
                return yield* new Kitchen.InvalidSettings({ message: "启用串口设备需要填写串口名称。" })
              if (new Set(ports.map((device) => device.port.trim())).size !== ports.length)
                return yield* new Kitchen.InvalidSettings({ message: "不同传感器不能同时占用同一个串口。" })
              if (camera.enabled && !url)
                return yield* new Kitchen.InvalidSettings({ message: "启用摄像头需要填写 RTSP 地址。" })
              const password =
                input.camera_password !== undefined
                  ? input.camera_password
                  : url?.password
                    ? decodeURIComponent(url.password)
                    : undefined
              if (url) url.password = ""
              const stored = yield* load()
              yield* saveSecret(cameraID, password)
              return yield* persist(
                { ...stored, devices: { ...input.devices, camera: { ...camera, rtsp_url: url?.toString() ?? "" } } },
                "devices",
              )
            }),
          ),
        updateRecording: (input) =>
          lock.withPermit(
            Effect.gen(function* () {
              if (input.enabled && !path.isAbsolute(input.directory))
                return yield* new Kitchen.InvalidSettings({ message: "调试数据保存目录需要使用绝对路径。" })
              return yield* persist({ ...(yield* load()), recording: input }, "recording")
            }),
          ),
      })
    }),
  )
export const configured = (options: Options = {}) =>
  makeGlobalNode({
    service: Service,
    layer: layer(options),
    deps: [KV.node, Credential.node, Global.node],
  })
export const node = configured()
