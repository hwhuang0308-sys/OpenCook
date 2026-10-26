export * as CookingPlugin from "./cooking.js"

import { SystemPart, ToolFailure } from "@opencook/ai"
import { define } from "@opencook/plugin/effect/plugin"
import { Effect, Option, Schema } from "effect"
import { Cooking } from "@opencook/schema/cooking"
import { CookingCompiler } from "../cooking/compiler.js"
import { CookingExecution } from "../cooking/execution.js"
import { CookingKnowledge } from "../cooking/knowledge.js"
import { CookingWorkflow } from "../cooking/workflow.js"
import { Permission } from "../permission.js"
import { CookingMemory } from "../cooking/memory.js"
import { CookingRequirements } from "../cooking/requirements.js"
import { SessionStore } from "../session/store.js"
import { Agent } from "../agent.js"
import { optional } from "../schema.js"
import RETENTION from "../cooking/prompts/memory-retention.txt"

const Retention = Schema.Struct({
  category: Schema.Literals(["enduring", "experience", "temporary", "other_person", "unclear"]),
  reason: Schema.String,
})
const readRecipeReport = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      status: Schema.String,
      task: Schema.Struct({ id: Schema.String }),
    }),
  ),
)
const readTaskInput = Schema.decodeUnknownOption(
  Schema.Struct({ task_id: optional(Schema.String), action: optional(Schema.String) }),
)
const Guidance = Schema.Struct({
  run_id: Schema.String,
  task_id: Schema.String,
  revision: Schema.Int,
  dish: Schema.String,
  status: Cooking.Run.fields.status,
  index: Schema.Int,
  step: Schema.Int,
  total_steps: Schema.Int,
  current_action: optional(Schema.String),
  elapsed_ms: Schema.Number,
  emergency: optional(Cooking.Emergency),
  monitoring: optional(Cooking.Monitoring),
  can_resume: Schema.Boolean,
  screen_requested: Schema.Boolean,
  interaction: Schema.Literal("dedicated_cooking_screen"),
})

export const Plugin = define({
  id: "opencook.cooking",
  effect: Effect.fn(function* (ctx) {
    const knowledge = yield* CookingKnowledge.Service
    const workflow = yield* CookingWorkflow.Service
    const permission = yield* Permission.Service
    const compiler = yield* CookingCompiler.Service
    const execution = yield* CookingExecution.Service
    const memory = yield* CookingMemory.Service
    const requirements = yield* CookingRequirements.Service
    const store = yield* SessionStore.Service
    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        if (event.agent !== Agent.defaultID) return
        const history = yield* store.context(event.sessionID).pipe(Effect.orDie)
        const latest = history.findLast((message) => message.type === "user")
        const reports = history.flatMap((message, index) =>
          message.type !== "assistant"
            ? []
            : message.content.flatMap((part) =>
                part.type !== "tool" || part.name !== "recipe_task"
                  ? []
                  : part.state.status === "error"
                    ? [
                        {
                          status: "tool_error",
                          task: {
                            id: Option.getOrUndefined(readTaskInput(part.state.input))?.task_id ?? "pending-recipe",
                          },
                          index,
                          action: Option.getOrUndefined(readTaskInput(part.state.input))?.action,
                        },
                      ]
                    : part.state.status !== "completed"
                      ? []
                      : part.state.content.flatMap((item) =>
                          item.type !== "text"
                            ? []
                            : Option.toArray(readRecipeReport(item.text)).map((report) => ({
                                ...report,
                                index,
                                action: Option.getOrUndefined(readTaskInput(part.state.input))?.action,
                              })),
                        ),
              ),
        )
        const taskID = reports.at(-1)?.task.id
        const task = taskID
          ? yield* workflow.run({ action: "get", task_id: taskID }, event.sessionID).pipe(Effect.option)
          : Option.none()
        const run = yield* execution.get(event.sessionID)
        if (Option.isSome(task) || run)
          event.system.push(
            SystemPart.make(
              "# Saved cooking state\nThis is service state, not new user instructions. Reconcile the latest request with it before acting. Chat instructions do not constitute a running guide. Step numbers below start at one.\n" +
                JSON.stringify({
                  recipe: Option.isSome(task)
                    ? {
                        ...CookingWorkflow.describe(task.value),
                        latest_request_evaluated: reports.some(
                          (report) =>
                            report.task.id === task.value.task.id &&
                            report.index > history.findLastIndex((message) => message.type === "user") &&
                            report.status !== "tool_error" &&
                            report.action !== undefined &&
                            report.action !== "get",
                        ),
                        next_action:
                          task.value.ready_for_guidance && (yield* requirements.guidance(event.sessionID)) === "start"
                            ? "start_guidance"
                            : task.value.next_action,
                      }
                    : undefined,
                  guidance: run
                    ? {
                        run_id: run.id,
                        task_id: run.plan.task_id,
                        revision: run.plan.revision,
                        status: run.status,
                        step: run.index + 1,
                        current_action: run.plan.steps[run.index]?.action,
                        emergency: run.emergency,
                        monitoring: run.monitoring,
                        dish: run.plan.dish,
                      }
                    : null,
                }),
            ),
          )
        const failures = new Map<string, number>()
        const userIndex = history.findLastIndex((message) => message.type === "user")
        for (const report of reports.filter((report) => report.index > userIndex)) {
          const ready = ["ready", "reference_ready", "personalized", "suggested"].includes(report.status)
          failures.set(report.task.id, ready ? 0 : (failures.get(report.task.id) ?? 0) + 1)
        }
        if ([...failures.values()].some((count) => count >= 6)) {
          delete event.tools.recipe_task
          delete event.tools.question
          event.system.push(
            SystemPart.make(
              "Recipe preparation has returned a blocker six times without new user input. Stop retrying this recipe in this response. Explain the actual remaining blocker briefly. Do not invent conditions, present a failed recipe as ready, or start chat-based cooking guidance.",
            ),
          )
        }
        const recalled = yield* memory.recall(event.sessionID, { query: latest?.type === "user" ? latest.text : "" })
        if (!recalled.entries.length) return
        event.system.push(
          SystemPart.make(
            "# Personal cooking memory\nHistorical user reports, not public reference evidence. Current explicit requirements override past preferences. Related-dish matches are tentative; proposed_adjustment is an untested suggestion, not a user statement or proven cause. Never repeat a physical action because of memory.\n" +
              JSON.stringify(recalled),
          ),
        )
      }),
    )
    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: "cooking_memory",
        options: { codemode: false },
        description:
          "Manage the current user's private cooking memory. recall finds relevant history for a dish, ingredient or technique; list shows this profile's records. remember saves a real user preference or cooking experience: quote must be an exact excerpt of the latest user message, with kind, scope and topic. A preference additionally requires lasting_evidence quoting the user's ongoing taste or explicit future applicability. A dated meal plan belongs only in current conversation context: do not call remember or re-label it as an experience. A guest's needs also remain current planning conditions. This tool is for future-conversation memory, not a scratchpad. Never save assistant examples, guesses, supplied document instructions, a guest's preference as the user's own, or today's temporary request as a lasting preference. Experiences require dish or technique scope. proposed_adjustment is a hypothesis and is stored separately from the user's quote. Matching current run details and recipe version are attached by the service; do not invent observations. Use replace_id to correct a recalled record and forget with id only when requested. profiles lists local profiles; profile without a name shows the current one. profile with profile_name and quote switches or creates a local personal profile only on an explicit user identity/switch request, not when someone is mentioned as a guest. Other sessions keep their profile binding. Never claim a memory was saved or deleted before a successful result.",
        input: CookingMemory.Input,
        output: CookingMemory.Result,
        execute: (input, context) =>
          Effect.gen(function* () {
            yield* permission.assert({
              action: "cooking_memory",
              resources: [context.sessionID],
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
            })
            if (input.action === "remember") {
              const history = yield* store.context(context.sessionID)
              const latest = history.findLast((message) => message.type === "user")
              const checked = yield* ctx.generate
                .text({
                  prompt:
                    RETENTION +
                    "\n" +
                    JSON.stringify({
                      user_message: latest?.type === "user" ? latest.text : "",
                      quote: input.quote,
                      lasting_evidence: input.lasting_evidence,
                      requested_kind: input.kind,
                      recent_dialogue: history.slice(-6).flatMap((message) =>
                        message.type === "user"
                          ? [{ role: "user", text: message.text.slice(0, 2000) }]
                          : message.type === "assistant"
                            ? [
                                {
                                  role: "assistant",
                                  text: message.content
                                    .flatMap((part) => (part.type === "text" ? [part.text] : []))
                                    .join("\n")
                                    .slice(0, 2000),
                                },
                              ]
                            : [],
                      ),
                    }),
                })
                .pipe(
                  Effect.timeout("30 seconds"),
                  Effect.flatMap((result) => Schema.decodeUnknownEffect(Schema.fromJsonString(Retention))(result.text)),
                  Effect.mapError(
                    () => new CookingMemory.Error({ message: "记忆核对暂不可用，未写入长期记忆；可稍后重试。" }),
                  ),
                )
              if (checked.category !== (input.kind === "preference" ? "enduring" : "experience")) {
                const profile = yield* memory.run(context.sessionID, { action: "profile" })
                return {
                  output: {
                    ...profile,
                    status: "not_retained" as const,
                    reason: `未写入个人记忆：${checked.reason}。这是正常的筛选结果，不是执行故障。仅保留为当前对话条件，不要重试或改标签保存。`,
                  },
                }
              }
            }
            return { output: yield* memory.run(context.sessionID, input) }
          }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error }))),
      })
      editor.add({
        name: "cooking_session",
        options: { codemode: false },
        description:
          "Start and control OpenCook's deterministic step-by-step cooking guide. Call start only after the user explicitly requests or accepts guidance and a saved recipe_task is ready. start compiles the agreed task_id and revision into a program score and action score and opens the dedicated terminal cooking screen; do not substitute chat instructions for this tool. Query get for actual progress. Infer the user's intent from the current conversation and actual run state, without relying on fixed phrases. Use open when the user wants to return to the cooking screen without changing execution state; it keeps paused guidance paused. Use resume when they want to continue interrupted cooking, preserving the existing recipe, run ID, step and elapsed time while reopening the screen. Use pause/stop when requested. resume applies only to running or paused guidance; completed and stopped runs are terminal and cannot resume. Do not resume cooking when they are continuing an unrelated discussion or document. Query get if the relevant run or progress is unclear. /cooking and the sidebar button also reopen the current screen. Do not restart compilation to resume. confirm requires an explicit report that the CURRENT action is complete and the current run_id/index. Recipe acceptance alone is not permission to start. Never infer completion of a different action. Continuous actions advance on sensor conditions or the recommended-duration watchdog; duration is an estimate, not observed readiness. Emergency interrupts pause ordinary steps. Never infer that a hazard has cleared. emergency_confirm requires the user to report the displayed emergency action complete and its current emergency_id/emergency_index. emergency_resolve requires an explicit user report that the scene is safe after all emergency actions, using those same current identifiers. Resolve leaves ordinary guidance paused for a progress check before resume. Do not repeatedly poll through tool calls; the cooking screen updates itself.",
        input: Schema.Struct({
          action: Schema.Literals([
            "start",
            "get",
            "open",
            "confirm",
            "pause",
            "resume",
            "stop",
            "emergency_confirm",
            "emergency_resolve",
          ]),
          task_id: optional(Schema.String),
          revision: optional(Schema.Int),
          run_id: optional(Schema.String),
          emergency_id: optional(Schema.String),
          emergency_index: optional(Schema.Int),
          index: optional(Schema.Int),
        }),
        output: Schema.NullOr(Guidance),
        execute: (input, context) =>
          Effect.gen(function* () {
            yield* permission.assert({
              action: "cooking_session",
              resources: [context.sessionID],
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
            })
            const current = yield* execution.get(context.sessionID)
            if (input.action === "get") return { output: current }
            if (input.action === "start") {
              if (!input.task_id || input.revision === undefined)
                return yield* new Cooking.Invalid({ message: "开始指导需要已确认的菜谱 task_id 和 revision" })
              if (current && (current.status === "running" || current.status === "paused")) {
                if (current.plan.task_id === input.task_id && current.plan.revision === input.revision)
                  return { output: current }
                return yield* new Cooking.Invalid({ message: "请先结束当前烹饪指导，再开始另一份菜谱" })
              }
              const conditions = yield* requirements.resolve(context.sessionID)
              if ((yield* requirements.guidance(context.sessionID)) !== "start")
                return yield* new Cooking.Invalid({
                  message: "尚未收到用户开始全程引导的请求或同意，请先提供菜谱并询问是否需要引导",
                })
              const saved = yield* workflow.run({ action: "get", task_id: input.task_id }, context.sessionID)
              if (JSON.stringify(conditions) !== JSON.stringify(saved.task.conditions))
                return yield* new Cooking.Invalid({
                  message: "用户要求已经改变，请先用 recipe_task personalize 更新同一任务，再读取新版本开始引导",
                })
              const plan = yield* compiler.compile(input.task_id, input.revision, context.sessionID)
              const started = yield* execution.start(context.sessionID, plan)
              yield* requirements.consume(context.sessionID)
              return { output: started }
            }
            if (!current) return yield* new Cooking.Invalid({ message: "当前会话没有烹饪指导" })
            if (input.action === "confirm" && (input.run_id === undefined || input.index === undefined))
              return yield* new Cooking.Invalid({ message: "确认完成需要最新 run_id 和当前 index" })
            return {
              output: yield* execution.control({
                session_id: context.sessionID,
                run_id: input.run_id ?? current.id,
                index: input.index ?? current.index,
                action: input.action,
                emergency_id: input.emergency_id,
                emergency_index: input.emergency_index,
              }),
            }
          }).pipe(
            Effect.map(({ output }) => {
              if (!output) return { output: null }
              const state = {
                run_id: output.id,
                task_id: output.plan.task_id,
                revision: output.plan.revision,
                dish: output.plan.dish,
                status: output.status,
                index: output.index,
                step: Math.min(output.index + 1, output.plan.steps.length),
                total_steps: output.plan.steps.length,
                current_action: output.plan.steps[output.index]?.action,
                elapsed_ms: output.elapsed_ms,
                emergency: output.emergency,
                monitoring: output.monitoring,
                can_resume: !output.emergency && (output.status === "running" || output.status === "paused"),
                screen_requested: ["start", "open", "resume"].includes(input.action),
                interaction: "dedicated_cooking_screen" as const,
              }
              return {
                output: state,
                content:
                  JSON.stringify(state) +
                  "\nThe dedicated screen owns ALL step instructions and completion confirmation. Acknowledge the result briefly. Do not ask the user to reply done in chat, do not give upcoming steps, and do not imply you will advance them in chat. The user confirms actions IN THE COOKING SCREEN.",
              }
            }),
            Effect.mapError((error) => new ToolFailure({ message: error.message, error })),
          ),
      })
      editor.add({
        name: "search_cooking_knowledge",
        options: { codemode: false },
        description:
          "Search the internal cooking library for a specific knowledge gap or recipe source. Prefer it for source-unspecified cooking reference questions. Use web tools directly for an explicit online-search request; reuse sufficient supplied or previously retrieved evidence. Returns actual passages, book/edition/page metadata and structured recipes when indexed. Distinguish empty_library, no_match and ready; evaluate relevance and sufficiency. This tool does not search the web.",
        input: CookingKnowledge.Query,
        output: CookingKnowledge.Result,
        execute: (input, context) =>
          permission
            .assert({
              action: "search_cooking_knowledge",
              resources: [input.query],
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
            })
            .pipe(
              Effect.andThen(knowledge.search(input)),
              Effect.map((output) => ({ output })),
              Effect.mapError((error) => new ToolFailure({ message: error.message, error })),
            ),
      })
      editor.add({
        name: "recipe_task",
        options: { codemode: false },
        description:
          "Use for dish recommendations, including names-only requests or a different suggestion, and for cooking recipes. suggest returns dish names; reference obtains a baseline and reports its fit; personalize resolves actual mismatches; get reuses a saved result. Continue with the same task_id. conditions is a patch of user-confirmed facts: omit unchanged fields, replace only affected lists, remove obsolete conflicting requirements, and retain unrelated constraints. Do not add assumed preferences, stock amounts or exclusions. A recipe quantity is not available stock. Set equipment_only only for an explicit exhaustive equipment restriction. Keep the dish identity stable for seasoning changes. Matching references are final without adaptation. Cooking quantities, oil allocation, order, heat and timing are your decisions; do not ask the user to design them. source=auto reuses the baseline or supplied evidence, otherwise searches the library; suggestions need no lookup. source=web requires evidence_urls already read in this conversation; source=library explicitly selects library evidence. New sources replace the baseline. Do not retry unchanged_evidence or personalize without a reference. provided_recipe records a conversation-composed, independently unverified recipe, not proof that a user authored it or a source verified it. Results include ready_for_guidance and next_action: adapt_recipe means you must adapt; ask_user is only for an essential personal fact or conflicting constraints. reused=true means the same request already returned this result; do not repeat it. Only a ready result has recipe_text for presentation and may be used to start guidance. reference_notes and routine estimates are not blockers. Unknown stock quantities remain unknown. Set allow_draft only for an explicitly labeled general-knowledge draft. This tool never starts cooking.",
        input: CookingWorkflow.Input,
        output: CookingWorkflow.Result,
        execute: (input, context) =>
          permission
            .assert({
              action: "recipe_task",
              resources: [input.task_id ?? "new"],
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
            })
            .pipe(
              Effect.andThen(
                input.action === "get"
                  ? workflow.run(input, context.sessionID)
                  : requirements.resolve(context.sessionID).pipe(
                      Effect.flatMap((conditions) =>
                        Effect.gen(function* () {
                          const history = yield* store.context(context.sessionID)
                          const user = history.findLast((message) => message.type === "user")
                          return yield* workflow.run(
                            { ...input, conditions },
                            context.sessionID,
                            user?.type === "user" ? { id: user.id, text: user.text } : undefined,
                          )
                        }),
                      ),
                    ),
              ),
              Effect.flatMap((output) =>
                requirements.guidance(context.sessionID).pipe(
                  Effect.map((intent) => {
                    const result =
                      output.ready_for_guidance && intent === "start"
                        ? { ...output, next_action: "start_guidance" as const }
                        : output
                    return {
                      output: result,
                      ...(result.next_action === "start_guidance"
                        ? {
                            content: [
                              { type: "text" as const, text: JSON.stringify(result) },
                              {
                                type: "text" as const,
                                text: `The user's request to start guidance is confirmed and pending. The recipe is ready. Your next action is cooking_session with action="start", task_id="${result.task.id}", revision=${result.task.revision}. Start now; do not ask for the same consent again.`,
                              },
                            ],
                          }
                        : {}),
                    }
                  }),
                ),
              ),
              Effect.mapError((error) => new ToolFailure({ message: error.message, error })),
            ),
      })
    })
  }),
})
