export * as CookingWorkflow from "./workflow.js"

import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { makeLocationNode } from "@opencook/util/effect/app-node"
import { Hash } from "@opencook/util/hash"
import { Generate } from "../generate.js"
import { KV } from "../kv.js"
import { CookingKnowledge } from "./knowledge.js"
import { CookingRecipe } from "./recipe.js"
import { optional } from "../schema.js"
import { CookingMemory } from "./memory.js"
import DISH from "./prompts/dish.txt"
import REFERENCE from "./prompts/reference.txt"
import PERSONALIZE from "./prompts/personalize.txt"
import ASSESSMENT from "./prompts/assessment.txt"
import ADJUSTMENTS from "./prompts/adjustments.txt"
import REVIEW from "./prompts/review.txt"
import CLARIFICATION from "./prompts/clarification.txt"

const Text = Schema.Trim.check(Schema.isNonEmpty())
const Candidate = Schema.Struct({ name: Text, reason: Text, source_ids: Schema.Array(Text) })
const Candidates = Schema.Struct({
  candidates: Schema.Array(Candidate).check(Schema.isNonEmpty(), Schema.isMaxLength(24)),
})
const Assessment = Schema.Struct({
  needs_adaptation: Schema.Boolean,
  reasons: Schema.Array(Text),
  questions: Schema.Array(Text).check(Schema.isMaxLength(3)),
})
const Review = Schema.Struct({ errors: Schema.Array(Text) })
const Outcome = Schema.Struct({
  status: Schema.Literals([
    "suggested",
    "reference_ready",
    "personalized",
    "needs_clarification",
    "needs_adaptation",
    "needs_evidence",
    "validation_failed",
    "ready",
  ]),
  recipe_text: optional(Schema.String),
  errors: optional(Schema.Array(CookingRecipe.Issue)),
  unresolved: optional(Schema.Array(CookingRecipe.Issue)),
})
const Reference = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ready"), recipe: CookingRecipe.Recipe, notes: Schema.Array(Text) }),
  Schema.Struct({
    status: Schema.Literal("needs_evidence"),
    gaps: Schema.Array(Text).check(Schema.isNonEmpty()),
  }),
])
const Evidence = Schema.Struct({
  ...CookingKnowledge.Result.fields,
  status: Schema.Literals(["ready", "empty_library", "no_match", "not_searched"]),
})
export const Task = Schema.Struct({
  id: Text,
  session_id: Text,
  revision: Schema.Int,
  conditions: CookingRecipe.Conditions,
  candidates: Schema.Array(Candidate),
  dish: optional(Text),
  reference: optional(CookingRecipe.Recipe),
  reference_notes: optional(Schema.Array(Text)),
  reference_attempt: optional(Schema.Struct({ fingerprint: Text, errors: Schema.Array(CookingRecipe.Issue) })),
  personalized: optional(CookingRecipe.Recipe),
  evidence: optional(Evidence),
  assessment: optional(Assessment),
  adjustments: optional(Schema.String),
  memory: optional(CookingMemory.Recall),
  attempt: optional(Schema.Struct({ fingerprint: Text, outcome: Outcome })),
  readiness: optional(Schema.Union([Outcome.fields.status, Schema.Literal("preparing")])),
  policy: optional(Text),
})
export type Task = typeof Task.Type
export const Input = Schema.Struct({
  action: Schema.Literals(["suggest", "reference", "personalize", "get"]),
  task_id: optional(
    Text.annotate({
      description:
        "Omit this field on the FIRST call to create a task. On subsequent calls copy the exact recipe_... ID returned by this tool. Never invent a name or ID.",
    }),
  ),
  dish: optional(Text),
  conditions: optional(CookingRecipe.Changes),
  count: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 24 }))),
  source: optional(
    Schema.Literals(["auto", "library", "web"]).annotate({
      description:
        "auto (default): reuse an existing baseline or supplied recipe/pages; otherwise search the library for a new reference, but not for names-only suggestions. library: explicitly select library evidence. web: use only supplied evidence_urls from pages read in this conversation. Explicit library/web selection or new evidence replaces the baseline. Use auto with provided_recipe.",
    }),
  ),
  allow_draft: optional(Schema.Boolean),
  provided_recipe: optional(CookingRecipe.Recipe),
  evidence_urls: optional(Schema.Array(Text).check(Schema.isMaxLength(5))),
})
export class Error extends Schema.TaggedError<Error>()("CookingWorkflow.Error", { message: Schema.String }) {}
export const Result = Schema.Struct({
  ...Outcome.fields,
  task: Task,
  ready_for_guidance: Schema.Boolean,
  next_action: Schema.Literals([
    "choose_dish",
    "present_recipe",
    "start_guidance",
    "retrieve_evidence",
    "adapt_recipe",
    "ask_user",
    "repair_recipe",
  ]),
  reused: optional(Schema.Boolean),
  transition: optional(
    Schema.Struct({
      cause: Schema.Literals(["new_task", "dish_changed", "new_reference", "conditions_changed", "continued"]),
      changed_fields: Schema.Array(Schema.String),
      reference: Schema.Literals(["reused", "acquired", "missing"]),
      source_action: Schema.Literals(["none", "library_lookup", "read_web_pages", "conversation_recipe"]),
    }),
  ),
})
export type Result = typeof Result.Type
export interface Interface {
  readonly run: (
    input: typeof Input.Type,
    sessionID: string,
    request?: { id: string; text: string },
  ) => Effect.Effect<Result, Error>
}
export class Service extends Context.Service<Service, Interface>()("@opencook/CookingWorkflow") {}

const decodeTask = Schema.decodeUnknownSync(Schema.toCodecJson(Task))
const encodeTask = Schema.encodeSync(Schema.toCodecJson(Task))
const policy = Hash.sha256([DISH, REFERENCE, ASSESSMENT, CLARIFICATION, PERSONALIZE, REVIEW, ADJUSTMENTS].join("\n"))
function result(task: Task, outcome: typeof Outcome.Type, reused = false, transition?: Result["transition"]): Result {
  const ready = ["ready", "reference_ready", "personalized"].includes(outcome.status)
  return {
    ...outcome,
    task,
    recipe_text: ready ? outcome.recipe_text : undefined,
    ready_for_guidance: ready,
    next_action: ready
      ? "present_recipe"
      : outcome.status === "suggested"
        ? "choose_dish"
        : outcome.status === "needs_evidence"
          ? "retrieve_evidence"
          : outcome.status === "needs_clarification"
            ? "ask_user"
            : outcome.status === "needs_adaptation"
              ? "adapt_recipe"
              : "repair_recipe",
    ...(reused ? { reused: true } : {}),
    ...(transition ? { transition } : {}),
  }
}

export function describe(value: Result) {
  const task = value.task
  return {
    task_id: task.id,
    revision: task.revision,
    dish: task.dish,
    status: value.status,
    phase: value.ready_for_guidance
      ? "recipe_ready"
      : value.status === "suggested"
        ? "choosing_dish"
        : value.status === "needs_evidence"
          ? "finding_reference"
          : value.status === "needs_clarification"
            ? "awaiting_user_fact"
            : "adapting_recipe",
    candidates: task.candidates,
    reference_recipe: task.reference
      ? {
          name: task.reference.name,
          servings: task.reference.servings,
          source_ids: task.reference.source_ids,
        }
      : null,
    current_recipe_kind: task.personalized ? "personalized" : task.reference ? "reference" : null,
    ready_for_guidance: value.ready_for_guidance,
    next_action: value.next_action,
    conditions: task.conditions,
    recipe_text: value.recipe_text,
    adjustments: task.adjustments,
    errors: value.errors,
  }
}
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const generate = yield* Generate.Service
    const knowledge = yield* CookingKnowledge.Service
    const kv = yield* KV.Service
    const memory = yield* CookingMemory.Service
    const locks = new Map<string, Semaphore.Semaphore>()

    const structured = <A>(
      schema: Schema.Codec<A>,
      instructions: string,
      data: Readonly<Record<string, unknown>>,
      validate: (value: A) => string[] | Effect.Effect<readonly string[], Error> = () => [],
    ) =>
      Effect.gen(function* () {
        const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(schema), { errors: "all" })
        let errors: string[] = []
        let previousOutput = ""
        for (let attempt = 0; attempt < 3; attempt++) {
          const text = yield* generate
            .text({
              prompt: `${instructions}\n\nInput data:\n${JSON.stringify({ ...data, previous_output: previousOutput || undefined })}\n\nCorrection requirements:\n${JSON.stringify(errors)}`,
            })
            .pipe(Effect.mapError((error) => new Error({ message: error.message })))
          previousOutput = text
          const parsed = yield* decode(text).pipe(
            Effect.map(Option.some),
            Effect.catch((error) =>
              Effect.sync(() => {
                errors = ["Return JSON without Markdown fences. " + error.message.slice(0, 4000)]
                return Option.none<A>()
              }),
            ),
          )
          if (Option.isNone(parsed)) continue
          const checked = validate(parsed.value)
          errors = [...(Effect.isEffect(checked) ? yield* checked : checked)]
          if (!errors.length) return parsed.value
        }
        return yield* new Error({ message: `阶段校验失败（已尝试3次）：${errors.join("；")}` })
      })

    const run = Effect.fn("CookingWorkflow.run")(function* (
      input: typeof Input.Type,
      sessionID: string,
      request?: { id: string; text: string },
    ): Effect.fn.Return<Result, Error> {
      const id = input.task_id ?? `recipe_${crypto.randomUUID()}`
      const lock = locks.get(id) ?? Semaphore.makeUnsafe(1)
      locks.set(id, lock)
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const saved = yield* kv.get(`cooking/task/${id}`)
          if (input.task_id && !saved) return yield* new Error({ message: "菜谱任务不存在" })
          const previous = saved ? decodeTask(saved) : undefined
          if (previous && previous.session_id !== sessionID)
            return yield* new Error({ message: "不能访问其他会话的菜谱任务" })
          if (input.action === "get" && previous) {
            if (previous.reference && previous.policy !== policy)
              return result(previous, {
                status: "needs_adaptation",
                errors: [
                  {
                    code: "assessment_outdated",
                    message: "请用 personalize 按当前要求重新核对已保存的参考菜谱，无需重复检索或复述旧问题",
                  },
                ],
              })
            if (
              previous.readiness &&
              !["ready", "reference_ready", "personalized", "suggested"].includes(previous.readiness)
            )
              return result(previous, {
                ...previous.attempt?.outcome,
                status: previous.readiness === "preparing" ? "validation_failed" : previous.readiness,
                errors:
                  previous.readiness === "preparing"
                    ? [{ code: "recipe_incomplete", message: "上次菜谱准备未完成，需要修复并保存后才能开始引导" }]
                    : previous.attempt?.outcome.errors,
              })
            const recipe = previous.personalized ?? previous.reference
            if (!recipe)
              return result(previous, {
                status: previous.dish ? "needs_evidence" : "suggested",
                errors: previous.reference_attempt?.errors,
              })
            const validation = CookingRecipe.validate(recipe, previous.conditions)
            const questions = !previous.personalized ? (previous.assessment?.questions ?? []) : []
            const mismatch = !validation.passed || (!previous.personalized && previous.assessment?.needs_adaptation)
            return result(previous, {
              status: questions.length ? "needs_clarification" : mismatch ? "needs_adaptation" : "ready",
              recipe_text: CookingRecipe.render(recipe),
              errors: [...validation.errors, ...questions.map((message) => ({ code: "clarification", message }))],
              unresolved: validation.unresolved,
            })
          }
          const conditions = Object.fromEntries(
            Object.entries({
              ...(previous?.conditions ?? CookingRecipe.emptyConditions()),
              ...Object.fromEntries(Object.entries(input.conditions ?? {}).filter(([, value]) => value !== undefined)),
            }).filter(([, value]) => value !== null),
          ) as CookingRecipe.Conditions
          const changedFields = previous
            ? Object.keys(CookingRecipe.Conditions.fields).filter(
                (key) =>
                  JSON.stringify(conditions[key as keyof CookingRecipe.Conditions]) !==
                  JSON.stringify(previous.conditions[key as keyof CookingRecipe.Conditions]),
              )
            : []
          const changed = changedFields.length > 0
          let transition: NonNullable<Result["transition"]> = {
            cause: previous ? (changed ? "conditions_changed" : "continued") : "new_task",
            changed_fields: changedFields,
            reference: "missing",
            source_action: "none",
          }
          let task: Task = {
            ...previous,
            id,
            session_id: sessionID,
            revision: (previous?.revision ?? 0) + 1,
            readiness: "preparing",
            policy,
            conditions,
            candidates: previous?.candidates ?? [],
            personalized: changed ? undefined : previous?.personalized,
            assessment: changed || previous?.policy !== policy ? undefined : previous?.assessment,
            adjustments: changed ? undefined : previous?.adjustments,
          }
          let fingerprint = ""
          const persist = (outcome: typeof Outcome.Type) => {
            task = {
              ...task,
              readiness: outcome.status,
              attempt: { fingerprint: fingerprint || Hash.sha256(JSON.stringify(input)), outcome },
            }
            return kv
              .set(`cooking/task/${id}`, encodeTask(task))
              .pipe(Effect.as(result(task, outcome, false, transition)))
          }
          if (input.action === "get") return yield* new Error({ message: "查询任务需要已有的 task_id" })
          const source = input.source ?? "auto"
          if (input.provided_recipe && source !== "auto")
            return yield* new Error({ message: "provided_recipe 使用 auto 来源；指定书库或网页时请提供对应来源证据" })
          const dish = input.dish ?? input.provided_recipe?.name ?? previous?.dish ?? ""
          const recalled = yield* memory.recall(sessionID, {
            dish,
            query: [dish, ...conditions.preferences, ...conditions.ingredients.map((item) => item.name)].join(" "),
          })
          const memoryChanged =
            previous &&
            JSON.stringify(previous.memory ?? { profile: recalled.profile, entries: [] }) !== JSON.stringify(recalled)
          task = {
            ...task,
            memory: recalled,
            ...(memoryChanged ? { assessment: undefined, personalized: undefined, adjustments: undefined } : {}),
          }
          if (input.action !== "suggest") {
            if (!dish)
              return yield* persist({
                status: "needs_clarification",
                errors: [{ code: "dish_required", message: "需要确定菜品后才能取得参考菜谱" }],
              })
            if (
              input.provided_recipe &&
              CookingRecipe.canonical(input.provided_recipe.name) !== CookingRecipe.canonical(dish)
            )
              return yield* persist({
                status: "needs_clarification",
                errors: [{ code: "dish_mismatch", message: "所选菜品与用户提供的菜谱名称不一致" }],
              })
          }
          const reuse =
            input.action !== "suggest" &&
            CookingMemory.dishKey(previous?.dish ?? "") === CookingMemory.dishKey(dish) &&
            !input.provided_recipe &&
            !input.evidence_urls?.length &&
            source === "auto"
          transition = {
            ...transition,
            cause:
              previous?.dish && CookingMemory.dishKey(previous.dish) !== CookingMemory.dishKey(dish)
                ? "dish_changed"
                : previous?.reference && (input.provided_recipe || input.evidence_urls?.length || source !== "auto")
                  ? "new_reference"
                  : transition.cause,
            reference: reuse && task.reference ? "reused" : "missing",
          }
          if (input.action !== "suggest")
            task = {
              ...task,
              dish,
              reference: reuse ? task.reference : undefined,
              reference_notes: reuse ? task.reference_notes : undefined,
              reference_attempt:
                CookingMemory.dishKey(previous?.dish ?? "") === CookingMemory.dishKey(dish)
                  ? task.reference_attempt
                  : undefined,
              personalized: reuse ? task.personalized : undefined,
              assessment: reuse ? task.assessment : undefined,
              adjustments: reuse ? task.adjustments : undefined,
            }
          if (
            input.action === "personalize" &&
            !task.reference &&
            !input.provided_recipe &&
            !input.evidence_urls?.length
          )
            return yield* persist({
              status: "needs_evidence",
              errors: [
                {
                  code: "reference_required",
                  message:
                    "尚未取得有效参考菜谱，不能进入个性化调整。先处理 reference 返回的具体缺口；没有新证据时不要反复切换 reference 和 personalize，应说明限制或询问用户。",
                },
                ...(task.reference_attempt?.errors ?? []),
              ],
            })
          const query =
            input.dish ??
            input.provided_recipe?.name ??
            (input.action === "suggest" ? undefined : previous?.dish) ??
            [
              ...conditions.ingredients.map((item) => item.name),
              ...conditions.preferences,
              ...conditions.regional_context,
              ...conditions.emotional_context,
            ].join(" ")
          const external = yield* knowledge.pages(sessionID, [...new Set(input.evidence_urls ?? [])])
          const searchLibrary =
            !input.provided_recipe &&
            (source === "library" ||
              (source === "auto" &&
                input.action !== "suggest" &&
                !input.evidence_urls?.length &&
                !(reuse && previous?.reference)))
          const library = searchLibrary
            ? yield* knowledge.search({ query: query || "家常菜", limit: 5 })
            : { status: "not_searched" as const, query: "", hits: [] }
          transition = {
            ...transition,
            source_action: input.provided_recipe
              ? "conversation_recipe"
              : input.evidence_urls?.length
                ? "read_web_pages"
                : searchLibrary
                  ? "library_lookup"
                  : "none",
          }
          const evidence: typeof Evidence.Type =
            reuse && previous?.reference && previous.evidence ? previous.evidence : { ...library, external }
          task = { ...task, evidence }
          fingerprint = Hash.sha256(
            JSON.stringify({
              action: input.action,
              dish,
              conditions,
              source,
              allow_draft: input.allow_draft ?? false,
              provided_recipe: input.provided_recipe,
              evidence,
              memory: recalled,
              policy,
              request_id: request?.id,
            }),
          )
          if (previous?.attempt?.fingerprint === fingerprint)
            return result(previous, previous.attempt.outcome, true, transition)
          if (external.length !== new Set(input.evidence_urls ?? []).size)
            return yield* persist({
              status: "needs_evidence",
              errors: [
                {
                  code: "unread_source",
                  message: `以下来源尚未在当前会话中通过 webfetch 成功读取：${(input.evidence_urls ?? [])
                    .filter((url) => !external.some((page) => page.source === url))
                    .join("、")}`,
                },
              ],
            })
          if (source === "web" && !external.length)
            return yield* persist({
              status: "needs_evidence",
              errors: [
                { code: "web_evidence_required", message: "需要先联网读取相关网页，再通过 evidence_urls 提供来源" },
              ],
            })
          const sourceIDs = new Set([
            ...evidence.hits.map((hit) => hit.document.id),
            ...(evidence.external?.map((document) => document.id) ?? []),
          ])
          if (input.action === "suggest") {
            const result = yield* structured(
              Candidates,
              DISH,
              {
                conditions,
                evidence,
                memory: recalled,
                count: input.count ?? 3,
                request: request?.text,
                previous_candidates: previous?.candidates.map((item) => item.name) ?? [],
              },
              (value) => {
                const errors =
                  value.candidates.length > (input.count ?? 3)
                    ? ["Return no more than the requested number of dishes"]
                    : []
                for (const candidate of value.candidates) {
                  if (/^[\p{Script=Han}]+$/u.test(candidate.name) && Array.from(candidate.name).length > 6)
                    errors.push("Chinese dish names must be at most six characters")
                  if (candidate.source_ids.some((source) => !sourceIDs.has(source))) errors.push("Unknown source ID")
                }
                return errors
              },
            )
            task = {
              ...task,
              candidates: result.candidates,
              evidence,
              dish: undefined,
              reference: undefined,
              reference_notes: undefined,
              reference_attempt: undefined,
              personalized: undefined,
              assessment: undefined,
              adjustments: undefined,
            }
            return yield* persist({ status: "suggested" })
          }
          let reference = task.reference
          if (input.provided_recipe) {
            reference = { ...input.provided_recipe, source_ids: [`conversation:${id}`] }
            const document: CookingKnowledge.Document = {
              id: `conversation:${id}`,
              title: "本次对话整理的菜谱（未独立核验）",
              author: "对话配方",
              edition: "本次对话",
              locator: id,
              source: "conversation-recipe",
              text: CookingRecipe.render(reference),
              tags: [],
              recipe: reference,
            }
            task = {
              ...task,
              reference,
              reference_notes: [],
              reference_attempt: undefined,
              evidence: { ...evidence, external: [...external, document] },
              assessment: undefined,
            }
          }
          if (!reference) {
            const fingerprint = Hash.sha256(
              JSON.stringify({
                instructions: REFERENCE,
                dish,
                allow_draft: input.allow_draft ?? false,
                sources: [...evidence.hits.map((hit) => hit.document), ...(evidence.external ?? [])].toSorted((a, b) =>
                  a.id.localeCompare(b.id),
                ),
              }),
            )
            const cached = task.reference_attempt?.fingerprint === fingerprint
            if (cached && previous?.reference) {
              reference = previous.reference
              task = {
                ...task,
                reference,
                reference_notes: previous.reference_notes,
                assessment: changed || memoryChanged ? undefined : previous.assessment,
              }
            } else if (cached)
              return yield* persist({
                status: "needs_evidence",
                errors: [
                  {
                    code: "unchanged_evidence",
                    message:
                      "这些来源已检查过，缺口仍未解决。再次调整人数、口味或库存不能补齐来源。请读取针对缺口的新资料，或向用户说明限制；不要用相同来源重试或进入 personalize。",
                  },
                  ...(task.reference_attempt?.errors ?? []),
                ],
              })
            if (!reference) {
              const exact = evidence.hits.find(
                (hit) => CookingRecipe.canonical(hit.document.recipe?.name ?? "") === CookingRecipe.canonical(dish),
              )
              if (!sourceIDs.size && !input.allow_draft)
                return yield* persist({
                  status: "needs_evidence",
                  errors: [
                    {
                      code: "reference_evidence_missing",
                      message:
                        "当前没有可用于菜谱的参考资料。请提供或读取相关来源；适合通用知识草稿时可使用 auto 来源并明确设置 allow_draft。重复相同参数或调用 personalize 不能解决来源缺失。",
                    },
                  ],
                })
              const extracted = exact?.document.recipe
                ? {
                    status: "ready" as const,
                    recipe: { ...exact.document.recipe, source_ids: [exact.document.id] },
                    notes: [],
                  }
                : yield* structured(
                    Reference,
                    REFERENCE,
                    { dish, evidence, allow_draft: input.allow_draft ?? false },
                    (value) => {
                      if (value.status === "needs_evidence") return []
                      const recipe = value.recipe
                      const errors = CookingRecipe.validate(
                        recipe,
                        CookingRecipe.emptyConditions(),
                        sourceIDs,
                      ).errors.map((error) => error.message)
                      if (CookingRecipe.canonical(recipe.name) !== CookingRecipe.canonical(dish))
                        errors.push("Use the selected dish name")
                      if (sourceIDs.size && !recipe.source_ids.length) errors.push("Cite at least one supplied source")
                      if (
                        !sourceIDs.size &&
                        [...recipe.ingredients, ...recipe.seasonings].some((item) => !item.estimated)
                      )
                        errors.push("Draft quantities must be labeled estimated")
                      return errors
                    },
                  )
              if (extracted.status === "needs_evidence") {
                const errors = extracted.gaps.map((message) => ({ code: "source_gap", message }))
                task = { ...task, reference_attempt: { fingerprint, errors } }
                return yield* persist({
                  status: "needs_evidence",
                  errors,
                })
              }
              reference = extracted.recipe
              task = {
                ...task,
                reference,
                reference_notes: extracted.notes,
                reference_attempt: { fingerprint, errors: [] },
                evidence,
              }
            }
          }
          const allowedSources = new Set([
            ...(task.evidence?.hits.map((hit) => hit.document.id) ?? []),
            ...(task.evidence?.external?.map((document) => document.id) ?? []),
          ])
          if (transition.reference !== "reused") transition = { ...transition, reference: "acquired" }
          const fit = CookingRecipe.validate(reference, conditions, allowedSources)
          yield* kv.set(`cooking/task/${id}`, encodeTask(task))
          const assessed =
            task.assessment ??
            (conditions.preferences.length ||
            conditions.dietary_requirements.length ||
            conditions.excluded.length ||
            conditions.emotional_context.length ||
            recalled.entries.length
              ? yield* structured(Assessment, ASSESSMENT, { reference, conditions, memory: recalled })
              : { needs_adaptation: false, reasons: [], questions: [] })
          const checked = assessed.questions.length
            ? yield* structured(
                Schema.Struct({ ask_indices: Schema.Array(Schema.Int), reason: Text }),
                CLARIFICATION,
                {
                  conditions,
                  reference,
                  conversation: request ? [{ role: "user", text: request.text }] : [],
                  proposed_questions: assessed.questions.map((question) => ({ question })),
                },
                (value) =>
                  value.ask_indices.some((index) => index < 0 || index >= assessed.questions.length)
                    ? ["Return only indices of the supplied questions"]
                    : [],
              )
            : undefined
          const assessment = checked
            ? {
                ...assessed,
                questions: [...new Set(checked.ask_indices)].slice(0, 3).map((index) => assessed.questions[index]),
              }
            : assessed
          task = { ...task, reference, assessment }
          yield* kv.set(`cooking/task/${id}`, encodeTask(task))
          if (assessment.questions.length)
            return yield* persist({
              status: "needs_clarification",
              errors: assessment.questions.map((message) => ({ code: "clarification", message })),
            })
          if (input.action === "reference" || (fit.passed && !assessment.needs_adaptation)) {
            task = { ...task, adjustments: "定制化菜谱与标准菜谱之间无本质区别" }
            return yield* persist({
              status: fit.passed && !assessment.needs_adaptation ? "reference_ready" : "needs_adaptation",
              recipe_text: CookingRecipe.render(reference),
              errors: fit.errors,
              unresolved: fit.unresolved,
            })
          }
          if (task.personalized) {
            const validation = CookingRecipe.validate(task.personalized, conditions, allowedSources)
            if (validation.passed)
              return yield* persist({
                status: "personalized",
                recipe_text: CookingRecipe.render(task.personalized),
                unresolved: validation.unresolved,
              })
          }
          const personalized = CookingRecipe.inventoryNames(
            yield* structured(
              CookingRecipe.Recipe,
              PERSONALIZE,
              {
                reference,
                current_recipe: reuse ? previous?.personalized : undefined,
                conditions,
                memory: recalled,
                errors: fit.errors,
                assessment,
              },
              (recipe) =>
                Effect.gen(function* () {
                  const normalized = CookingRecipe.inventoryNames(recipe, conditions)
                  const errors = CookingRecipe.validate(normalized, conditions, allowedSources).errors.map(
                    (error) => error.message,
                  )
                  if (CookingRecipe.canonical(recipe.name) !== CookingRecipe.canonical(reference.name))
                    errors.push("Preserve the reference dish name")
                  if (errors.length) return errors
                  if (
                    !conditions.preferences.length &&
                    !conditions.dietary_requirements.length &&
                    !conditions.excluded.length &&
                    !conditions.emotional_context.length &&
                    !recalled.entries.length
                  )
                    return []
                  return (yield* structured(Review, REVIEW, { recipe: normalized, conditions, memory: recalled }))
                    .errors
                }),
            ),
            conditions,
          )
          const explanation = yield* structured(
            Schema.Struct({ explanation: Text }),
            ADJUSTMENTS,
            { reference, personalized, conditions, memory: recalled },
            (value) => (Array.from(value.explanation).length > 300 ? ["改动说明不得超过300字"] : []),
          )
          task = { ...task, personalized, adjustments: explanation.explanation }
          const validation = CookingRecipe.validate(personalized, conditions)
          return yield* persist({
            status: "personalized",
            recipe_text: CookingRecipe.render(personalized),
            unresolved: validation.unresolved,
          })
        }),
      )
    })
    return Service.of({ run })
  }),
)
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Generate.node, CookingKnowledge.node, CookingMemory.node, KV.node],
})
