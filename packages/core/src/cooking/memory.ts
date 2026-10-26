export * as CookingMemory from "./memory.js"

import { Clock, Context, Effect, Layer, Schema, Semaphore } from "effect"
import { makeGlobalNode } from "@opencook/util/effect/app-node"
import { Hash } from "@opencook/util/hash"
import { Session } from "@opencook/schema/session"
import { KV } from "../kv.js"
import { SessionStore } from "../session/store.js"
import { CookingExecution } from "./execution.js"
import { optional } from "../schema.js"

const Text = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(2000))
export const Profile = Schema.Struct({ id: Text, name: Text })
export type Profile = typeof Profile.Type
const Registry = Schema.Struct({ active: Text, profiles: Schema.Array(Profile) })
const Episode = Schema.Struct({
  run_id: Text,
  task_id: Text,
  revision: Schema.Int,
  dish: Text,
  status: Schema.Literals(["running", "paused", "completed", "stopped"]),
  recipe_text: Schema.String,
  completed_steps: Schema.Int,
  total_steps: Schema.Int,
  completion_reasons: Schema.Array(Schema.Literals(["confirmed", "sensor", "duration"])),
})
export const Entry = Schema.Struct({
  id: Text,
  profile_id: Text,
  kind: Schema.Literals(["preference", "experience"]),
  scope: Schema.Literals(["general", "dish", "technique"]),
  quote: Text,
  topic: Text,
  dish: Schema.optional(Text),
  tags: Schema.Array(Text),
  proposed_adjustment: Schema.optional(Text),
  lasting_evidence: Schema.optional(Text),
  source: Schema.Struct({ session_id: Text, message_id: Text }),
  episode: Schema.optional(Episode),
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
})
export type Entry = typeof Entry.Type
export const Recall = Schema.Struct({
  profile: Profile,
  entries: Schema.Array(Schema.Struct({ entry: Entry, match: Schema.Literals(["general", "exact", "related"]) })),
})
export type Recall = typeof Recall.Type
export const Input = Schema.Struct({
  action: Schema.Literals(["recall", "remember", "forget", "list", "profiles", "profile"]),
  query: optional(Text),
  dish: optional(Text),
  kind: optional(Entry.fields.kind),
  scope: optional(Entry.fields.scope),
  quote: optional(Text),
  topic: optional(Text),
  tags: optional(Schema.Array(Text).check(Schema.isMaxLength(8))),
  proposed_adjustment: optional(Text),
  lasting_evidence: optional(Text),
  run_id: optional(Text),
  replace_id: optional(Text),
  id: optional(Text),
  profile_name: optional(Text),
})
export type Input = typeof Input.Type
export const Result = Schema.Struct({
  ...Recall.fields,
  status: Schema.Literals(["recalled", "saved", "forgotten", "listed", "profile", "not_retained"]),
  reason: Schema.optional(Schema.String),
  profiles: Schema.optional(Schema.Array(Profile)),
})
export type Result = typeof Result.Type
export class Error extends Schema.TaggedError<Error>()("CookingMemory.Error", { message: Schema.String }) {}
export interface Interface {
  readonly recall: (
    sessionID: string,
    query?: { query?: string; dish?: string; tags?: readonly string[] },
  ) => Effect.Effect<Recall>
  readonly run: (sessionID: string, input: Input) => Effect.Effect<Result, Error>
}
export class Service extends Context.Service<Service, Interface>()("@opencook/CookingMemory") {}

const decodeRegistry = Schema.decodeUnknownSync(Schema.toCodecJson(Registry))
const encodeRegistry = Schema.encodeSync(Schema.toCodecJson(Registry))
const decodeEntries = Schema.decodeUnknownSync(Schema.toCodecJson(Schema.Array(Entry)))
const encodeEntries = Schema.encodeSync(Schema.toCodecJson(Schema.Array(Entry)))
const normalize = (text: string) => text.normalize("NFKC").replace(/\s/g, "").toLowerCase()
export const dishKey = (text: string) =>
  normalize(text)
    .replace(/\([^)]*\)/g, "")
    .replaceAll("西红柿", "番茄")
    .replaceAll("炒鸡蛋", "炒蛋")

function related(query: string, tag: string) {
  const normalized = dishKey(tag)
  if (query.includes(normalized)) return true
  return (normalized.match(/[\p{Script=Han}]+/gu) ?? []).some((word) =>
    Array.from(word)
      .slice(1)
      .some((_, index) => query.includes(word.slice(index, index + 2))),
  )
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const store = yield* SessionStore.Service
    const execution = yield* CookingExecution.Service
    const lock = Semaphore.makeUnsafe(1)
    const registry = Effect.gen(function* () {
      const stored = yield* kv.get("cooking/memory/profiles")
      return stored
        ? decodeRegistry(stored)
        : { active: "local-default", profiles: [{ id: "local-default", name: "本机默认用户" }] }
    })
    const profile = Effect.fn(function* (sessionID: string) {
      const users = yield* registry
      const binding = yield* kv.get(`cooking/memory/session/${sessionID}`)
      const session = !binding && sessionID.startsWith("ses") ? yield* store.get(Session.ID.make(sessionID)) : undefined
      const parentID = session?.parentID ?? session?.fork?.sessionID
      const parent = parentID ? yield* kv.get(`cooking/memory/session/${parentID}`) : undefined
      const current =
        users.profiles.find((item) => item.id === (binding ?? parent)) ??
        users.profiles.find((item) => item.id === users.active)!
      if (!binding) yield* kv.set(`cooking/memory/session/${sessionID}`, current.id)
      return current
    })
    const load = Effect.fn(function* (id: string) {
      const stored = yield* kv.get(`cooking/memory/user/${id}`)
      return stored ? decodeEntries(stored) : []
    })
    const recall = Effect.fn(function* (
      sessionID: string,
      input: { query?: string; dish?: string; tags?: readonly string[] } = {},
    ) {
      const user = yield* profile(sessionID)
      const query = dishKey([input.query, input.dish, ...(input.tags ?? [])].filter(Boolean).join(" "))
      const entries = (yield* load(user.id))
        .flatMap((entry) => {
          const general = entry.scope === "general" && entry.kind === "preference"
          const exact = !!entry.dish && !!query && query.includes(dishKey(entry.dish))
          const similar =
            !exact &&
            [...entry.tags, ...(entry.scope === "technique" ? [entry.topic] : [])].some((tag) => related(query, tag))
          if (!general && !exact && !similar) return []
          return [
            {
              entry,
              match: general ? ("general" as const) : exact ? ("exact" as const) : ("related" as const),
              score: exact ? 3 : general ? 2 : 1,
            },
          ]
        })
        .sort((a, b) => b.score - a.score || b.entry.updated_at - a.entry.updated_at)
        .slice(0, 8)
        .map(({ entry, match }) => ({ entry, match }))
      return { profile: user, entries }
    })
    const source = Effect.fn(function* (sessionID: string, quote?: string) {
      const history = yield* store
        .context(Session.ID.make(sessionID))
        .pipe(Effect.mapError(() => new Error({ message: "无法核对用户原话" })))
      const message = history.findLast((item) => item.type === "user")
      if (!quote || message?.type !== "user" || !normalize(message.text).includes(normalize(quote)))
        return yield* new Error({ message: "记忆必须引用本轮用户的原话，不能使用助手建议、工具内容或其他会话的文本" })
      return message
    })
    return Service.of({
      recall: (sessionID, input) => lock.withPermit(recall(sessionID, input)),
      run: (sessionID, input) =>
        lock.withPermit(
          Effect.gen(function* () {
            const user = yield* profile(sessionID)
            const entries = yield* load(user.id)
            if (input.action === "profile") {
              if (!input.profile_name) return { status: "profile", profile: user, entries: [] }
              const message = yield* source(sessionID, input.quote)
              if (!normalize(message.text).includes(normalize(input.profile_name)))
                return yield* new Error({ message: "切换个人档案需要用户明确提供姓名或档案名" })
              const users = yield* registry
              const next = users.profiles.find((item) => normalize(item.name) === normalize(input.profile_name!)) ?? {
                id: crypto.randomUUID(),
                name: input.profile_name,
              }
              yield* kv.set(
                "cooking/memory/profiles",
                encodeRegistry({
                  active: next.id,
                  profiles: users.profiles.some((item) => item.id === next.id)
                    ? users.profiles
                    : [...users.profiles, next],
                }),
              )
              yield* kv.set(`cooking/memory/session/${sessionID}`, next.id)
              return { status: "profile", profile: next, entries: [] }
            }
            if (input.action === "profiles")
              return { status: "profile", profile: user, entries: [], profiles: (yield* registry).profiles }
            if (input.action === "list")
              return {
                status: "listed",
                profile: user,
                entries: entries.map((entry) => ({
                  entry,
                  match: entry.scope === "general" ? ("general" as const) : ("exact" as const),
                })),
              }
            if (input.action === "recall") return { status: "recalled", ...(yield* recall(sessionID, input)) }
            if (input.action === "forget") {
              if (!input.id || !entries.some((entry) => entry.id === input.id))
                return yield* new Error({ message: "当前个人档案中没有这条记忆" })
              yield* kv.set(
                `cooking/memory/user/${user.id}`,
                encodeEntries(entries.filter((entry) => entry.id !== input.id)),
              )
              return { status: "forgotten", profile: user, entries: [] }
            }
            const message = yield* source(sessionID, input.quote)
            if (!input.kind || !input.scope || !input.topic)
              return yield* new Error({ message: "请区分长期偏好与单次体验，并给出适用范围和主题" })
            if (
              input.kind === "preference" &&
              (!input.lasting_evidence || !normalize(message.text).includes(normalize(input.lasting_evidence)))
            )
              return yield* new Error({
                message:
                  "长期偏好需要 lasting_evidence 引用用户表达持续口味或以后适用的原话。某一天的用餐计划不是长期偏好，应留在当前对话中，不要保存为经历或换个标签重试。",
              })
            if (input.kind === "experience" && input.scope === "general")
              return yield* new Error({ message: "单次体验需要限定菜品或技法，不能直接变成全局偏好" })
            if (input.scope === "dish" && !input.dish) return yield* new Error({ message: "菜品记忆需要明确菜名" })
            const run = yield* execution.get(sessionID)
            if (
              input.run_id &&
              (!run || input.run_id !== run.id || !input.dish || dishKey(run.plan.dish) !== dishKey(input.dish))
            )
              return yield* new Error({ message: "所选烹饪记录与当前菜品不一致" })
            const id = `memory_${Hash.sha256(JSON.stringify([user.id, message.id, input.kind, input.scope, input.dish, input.quote]))}`
            const existing = entries.find((entry) => entry.id === id)
            if (existing)
              return {
                status: "saved",
                profile: user,
                entries: [{ entry: existing, match: existing.scope === "general" ? "general" : "exact" }],
              }
            if (input.replace_id && !entries.some((entry) => entry.id === input.replace_id))
              return yield* new Error({ message: "只能修正当前个人档案中已有的记忆" })
            const now = yield* Clock.currentTimeMillis
            const episode =
              run && input.kind === "experience" && input.dish && dishKey(run.plan.dish) === dishKey(input.dish)
                ? {
                    run_id: run.id,
                    task_id: run.plan.task_id,
                    revision: run.plan.revision,
                    dish: run.plan.dish,
                    status: run.status,
                    recipe_text: run.plan.recipe_text,
                    completed_steps: run.completions.length,
                    total_steps: run.plan.steps.length,
                    completion_reasons: run.completions.map((item) => item.reason),
                  }
                : undefined
            const entry: Entry = {
              id,
              profile_id: user.id,
              kind: input.kind,
              scope: input.scope,
              quote: input.quote!,
              topic: input.topic,
              dish: input.dish,
              tags: [...new Set(input.tags ?? [])],
              proposed_adjustment: input.proposed_adjustment,
              lasting_evidence: input.lasting_evidence,
              source: { session_id: sessionID, message_id: message.id },
              episode,
              created_at: now,
              updated_at: now,
            }
            yield* kv.set(
              `cooking/memory/user/${user.id}`,
              encodeEntries([...entries.filter((item) => item.id !== input.replace_id), entry]),
            )
            return {
              status: "saved",
              profile: user,
              entries: [{ entry, match: input.scope === "general" ? "general" : "exact" }],
            }
          }),
        ),
    })
  }),
)
export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [KV.node, SessionStore.node, CookingExecution.node],
})
