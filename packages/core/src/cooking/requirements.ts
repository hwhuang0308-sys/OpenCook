export * as CookingRequirements from "./requirements.js"

import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { makeLocationNode } from "@opencook/util/effect/app-node"
import { Hash } from "@opencook/util/hash"
import { Session } from "@opencook/schema/session"
import { Generate } from "../generate.js"
import { KV } from "../kv.js"
import { optional } from "../schema.js"
import { SessionStore } from "../session/store.js"
import { QuestionTool } from "../tool/plugin/question.js"
import { CookingRecipe } from "./recipe.js"
import PROMPT from "./prompts/requirements.txt"

const Text = Schema.Trim.check(Schema.isNonEmpty())
const Evidence = Schema.Struct({
  field: Text,
  source_id: Text,
  quote: Text,
  stock_name: optional(Text),
  quantity_text: optional(Text),
  unit_text: optional(Text),
})
const Directive = Schema.Struct({ action: Schema.Literals(["start", "none"]), source_id: Text, quote: Text })
const Extraction = Schema.Struct({
  changes: CookingRecipe.Changes,
  evidence: Schema.Array(Evidence),
  guidance: optional(Directive),
})
const Stored = Schema.Struct({
  fingerprint: Text,
  conditions: CookingRecipe.Conditions,
  source_ids: optional(Schema.Array(Text)),
  policy: optional(Text),
  guidance: optional(Directive),
})
const readStored = Schema.decodeUnknownSync(Schema.toCodecJson(Stored))
const writeStored = Schema.encodeSync(Schema.toCodecJson(Stored))
const policy = Hash.sha256(PROMPT)
const readQuestions = Schema.decodeUnknownOption(QuestionTool.Input)
const readAnswers = Schema.decodeUnknownOption(Schema.Array(Schema.Array(Schema.String)))
const readRecipe = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      recipe_text: optional(Schema.String),
    }),
  ),
)

export class Error extends Schema.TaggedError<Error>()("CookingRequirements.Error", { message: Schema.String }) {}
export interface Interface {
  readonly resolve: (sessionID: Session.ID) => Effect.Effect<CookingRecipe.Conditions, Error>
  readonly guidance: (sessionID: Session.ID) => Effect.Effect<"start" | "none">
  readonly consume: (sessionID: Session.ID) => Effect.Effect<void>
}
export class Service extends Context.Service<Service, Interface>()("@opencook/CookingRequirements") {}

function quantityText(text: string, value: number) {
  if (Number(text.normalize("NFKC")) === value) return true
  if (value === 2 && (text === "两" || text === "俩")) return true
  if (value === 0.5 && text === "半") return true
  const digits = "零一二三四五六七八九"
  const chinese =
    Number.isInteger(value) && value > 0 && value < 100
      ? value < 10
        ? digits[value]
        : `${value < 20 ? "" : digits[Math.floor(value / 10)]}十${value % 10 ? digits[value % 10] : ""}`
      : undefined
  return text === chinese
}
const unit = (text: string) => ({ ml: "毫升", g: "克", kg: "千克", l: "升" })[text.toLowerCase()] ?? text

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const kv = yield* KV.Service
    const generate = yield* Generate.Service
    const locks = new Map<string, Semaphore.Semaphore>()
    const failed = new Map<string, string>()
    return Service.of({
      guidance: (sessionID) =>
        kv
          .get(`cooking/requirements/${sessionID}`)
          .pipe(Effect.map((value) => (value ? (readStored(value).guidance?.action ?? "none") : "none"))),
      consume: (sessionID) =>
        Effect.gen(function* () {
          const value = yield* kv.get(`cooking/requirements/${sessionID}`)
          if (value)
            yield* kv.set(
              `cooking/requirements/${sessionID}`,
              writeStored({ ...readStored(value), guidance: undefined }),
            )
        }),
      resolve: (sessionID) =>
        Effect.gen(function* () {
          const lock = locks.get(sessionID) ?? Semaphore.makeUnsafe(1)
          locks.set(sessionID, lock)
          return yield* lock.withPermit(
            Effect.gen(function* () {
              const history = yield* store
                .context(sessionID)
                .pipe(Effect.mapError(() => new Error({ message: "无法读取已确认的用户要求" })))
              const sources = history.flatMap((message) => {
                if (message.type === "user") return [{ id: message.id as string, text: message.text }]
                if (message.type !== "assistant") return []
                return message.content.flatMap((part) => {
                  if (part.type !== "tool" || part.name !== "question" || part.state.status !== "completed") return []
                  const questions = readQuestions(part.state.input)
                  const answers = readAnswers(part.state.metadata?.answers)
                  if (Option.isNone(questions) || Option.isNone(answers)) return []
                  return answers.value.flatMap((answer, index) =>
                    answer.length
                      ? [
                          {
                            id: `${part.id}/${index}`,
                            text: answer.join("，"),
                            question: questions.value.questions[index]?.question,
                          },
                        ]
                      : [],
                  )
                })
              })
              const fingerprint = Hash.sha256(JSON.stringify({ sources, policy: PROMPT }))
              const saved = yield* kv.get(`cooking/requirements/${sessionID}`)
              const previous = saved ? readStored(saved) : undefined
              if (previous?.fingerprint === fingerprint) return previous.conditions
              if (failed.get(sessionID) === fingerprint)
                return yield* new Error({
                  message: "相同用户输入的要求整理已失败，请说明格式问题；重复修改工具参数不能补充用户事实",
                })
              const recipes = history.flatMap((message) =>
                message.type !== "assistant"
                  ? []
                  : message.content.flatMap((part) =>
                      part.type !== "tool" || part.name !== "recipe_task" || part.state.status !== "completed"
                        ? []
                        : part.state.content.flatMap((item) =>
                            item.type !== "text"
                              ? []
                              : Option.toArray(readRecipe(item.text)).flatMap((value) =>
                                  value.recipe_text ? [value.recipe_text] : [],
                                ),
                          ),
                    ),
              )
              const before = previous?.conditions ?? CookingRecipe.emptyConditions()
              const userIndex = history.findLastIndex((message) => message.type === "user")
              const previousReply = history
                .slice(0, userIndex)
                .flatMap((message) =>
                  message.type !== "assistant"
                    ? []
                    : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
                )
                .at(-1)
              const newSources =
                previous?.policy === policy && previous.source_ids
                  ? sources.filter((source) => !previous.source_ids!.includes(source.id))
                  : sources
              let correction = ""
              for (let attempt = 0; attempt < 3; attempt++) {
                const raw = yield* generate
                  .text({
                    prompt:
                      PROMPT +
                      "\nInput data:\n" +
                      JSON.stringify({
                        sources,
                        new_sources: newSources,
                        previously_confirmed: before,
                        last_presented_recipe: recipes.at(-1),
                        previous_assistant_reply: previousReply,
                        pending_guidance: previous?.guidance?.action ?? "none",
                      }) +
                      "\nOutput JSON schema:\n" +
                      JSON.stringify(Schema.toJsonSchemaDocument(Extraction).schema) +
                      correction,
                  })
                  .pipe(Effect.mapError((error) => new Error({ message: error.message })))
                const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Extraction))(raw).pipe(
                  Effect.result,
                )
                if (decoded._tag === "Failure") {
                  correction = `\nPrevious output:\n${raw}\nCorrect this format error and return the full JSON:\n${decoded.failure.message.slice(0, 3000)}`
                  continue
                }
                if (
                  decoded.success.guidance &&
                  !newSources.some(
                    (source) =>
                      source.id === decoded.success.guidance!.source_id &&
                      source.text.includes(decoded.success.guidance!.quote),
                  )
                ) {
                  correction = `\nPrevious output:\n${raw}\nThe guidance quote is not an exact substring of its cited new source. Copy a short exact span from that user's original text; do not paraphrase. Return the complete corrected JSON.`
                  continue
                }
                const evidence = decoded.success.evidence.filter((item) =>
                  newSources.some((source) => source.id === item.source_id && source.text.includes(item.quote)),
                )
                const changes = Object.fromEntries(
                  Object.entries(decoded.success.changes).filter(
                    ([field, value]) => value !== undefined && evidence.some((item) => item.field === field),
                  ),
                ) as CookingRecipe.Changes
                const stock = (field: "ingredients" | "seasonings") =>
                  changes[field]?.map((item) => {
                    const proof = evidence.find(
                      (entry) =>
                        entry.field === field &&
                        entry.stock_name === item.name &&
                        entry.quantity_text &&
                        entry.quote.includes(entry.quantity_text) &&
                        item.quantity !== undefined &&
                        item.unit !== undefined &&
                        quantityText(entry.quantity_text, item.quantity) &&
                        ((entry.unit_text &&
                          entry.quote.includes(entry.unit_text) &&
                          unit(entry.unit_text) === unit(item.unit)) ||
                          (entry.quantity_text === "俩" && item.unit === "个")),
                    )
                    return proof ? item : { name: item.name }
                  })
                const confirmed = Object.fromEntries(
                  Object.entries({
                    ...before,
                    ...changes,
                    ...(changes.ingredients ? { ingredients: stock("ingredients") } : {}),
                    ...(changes.seasonings ? { seasonings: stock("seasonings") } : {}),
                  }).filter(([, value]) => value !== null),
                ) as CookingRecipe.Conditions
                const directive = decoded.success.guidance
                const guidance =
                  directive &&
                  newSources.some(
                    (source) => source.id === directive.source_id && source.text.includes(directive.quote),
                  )
                    ? directive
                    : previous?.guidance
                yield* kv.set(
                  `cooking/requirements/${sessionID}`,
                  writeStored({
                    fingerprint,
                    conditions: confirmed,
                    source_ids: sources.map((source) => source.id),
                    policy,
                    guidance,
                  }),
                )
                failed.delete(sessionID)
                return confirmed
              }
              failed.set(sessionID, fingerprint)
              return yield* new Error({ message: "用户要求整理未完成，未使用模型猜测的库存或偏好" })
            }),
          )
        }),
    })
  }),
)
export const node = makeLocationNode({ service: Service, layer, deps: [Generate.node, KV.node, SessionStore.node] })
