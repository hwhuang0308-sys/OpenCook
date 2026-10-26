// Opt-in live evaluation. It runs the production SessionRunner and cooking tools
// in an isolated in-memory database. Only reference/search I/O is fixture-driven.
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { Auth, LLM, LLMClient, ToolFailure } from "@opencook/ai"
import { RequestExecutor } from "@opencook/ai/route"
import { OpenAIChat } from "@opencook/ai/protocols"
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { Agent } from "../src/agent.js"
import { Bus } from "../src/bus.js"
import { Config } from "../src/config.js"
import { CookingExecution } from "../src/cooking/execution.js"
import { CookingKnowledge } from "../src/cooking/knowledge.js"
import { CookingMemory } from "../src/cooking/memory.js"
import { CookingRecipe } from "../src/cooking/recipe.js"
import { CookingWorkflow } from "../src/cooking/workflow.js"
import { AppNodeBuilder } from "../src/effect/app-node-builder.js"
import { LayerNodePlatform } from "../src/effect/app-node-platform.js"
import { Form } from "../src/form.js"
import { Generate } from "../src/generate.js"
import { InstructionBuiltIns } from "../src/instructions/builtins.js"
import { Instructions } from "../src/instructions/index.js"
import { InstructionDiscovery } from "../src/instruction-discovery.js"
import { Location } from "../src/location.js"
import { KV } from "../src/kv.js"
import { LocationServiceMap } from "../src/location-service-map.js"
import { McpInstructions } from "../src/mcp/instructions.js"
import { Model } from "../src/model.js"
import { Permission } from "../src/permission.js"
import { AgentPlugin } from "../src/plugin/agent.js"
import { CookingPlugin } from "../src/plugin/cooking.js"
import { PluginHooks } from "../src/plugin/hooks.js"
import { PluginInternal } from "../src/plugin/internal.js"
import { Plugin } from "../src/plugin.js"
import { PluginSupervisor } from "../src/plugin/supervisor.js"
import { ToolInputRepairPlugin } from "../src/plugin/tool-input-repair.js"
import { ReferenceInstructions } from "../src/reference/instructions.js"
import { Session } from "../src/session.js"
import { SessionExecution } from "../src/session/execution.js"
import { SessionRunnerLLM } from "../src/session/runner/llm.js"
import { SessionRunner } from "../src/session/runner/index.js"
import { SessionRunnerModel } from "../src/session/runner/model.js"
import { SessionStore } from "../src/session/store.js"
import { SkillInstructions } from "../src/skill/instructions.js"
import { Snapshot } from "../src/snapshot.js"
import { Tool } from "../src/tool.js"
import { QuestionTool } from "../src/tool/plugin/question.js"
import { LayerNode } from "@opencook/util/effect/layer-node"
import { tempLocationLayer } from "../test/fixture/location.js"
import { promptLocationNode } from "../test/fixture/prompt-location.js"
import { permissionLayer } from "../test/lib/permission.js"
import { agentHost, host } from "../test/plugin/host.js"
import { cases, type Scenario } from "./cooking-eval/cases.js"
import { audit, Transcript } from "./cooking-eval/audit.js"

const baseURL = process.env.OPENCOOK_EVAL_BASE_URL
const apiKey = process.env.OPENCOOK_EVAL_API_KEY
const modelID = process.env.OPENCOOK_EVAL_MODEL
if (!baseURL || !apiKey || !modelID)
  throw new Error("Set OPENCOOK_EVAL_BASE_URL, OPENCOOK_EVAL_API_KEY and OPENCOOK_EVAL_MODEL")
const output = path.resolve(
  process.argv.includes("--output")
    ? process.argv[process.argv.indexOf("--output") + 1]
    : path.join(tmpdir(), `opencook-eval-${Date.now()}`),
)
const selected = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1].split(",")
  : undefined
const scenarios = cases.filter((item) => !selected || selected.includes(item.id))
if (!scenarios.length) throw new Error("No matching evaluation scenarios")
await mkdir(output, { recursive: true })

const model = OpenAIChat.route
  .with({
    endpoint: { baseURL },
    auth: Auth.bearer(apiKey),
    generation: { temperature: 0, maxTokens: 8192 },
  })
  .model({ id: modelID })
const client = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer))))
const auxiliary: { prompt: string; text: string }[] = []
const resolved = SessionRunnerModel.resolved(model, {
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: [],
  limit: { context: 128000, output: 8192 },
})
const generation = Layer.effect(
  Generate.Service,
  Effect.gen(function* () {
    const llm = yield* LLMClient.Service
    return Generate.Service.of({
      text: (input) =>
        Effect.sync(() => console.log(`  auxiliary: ${input.prompt.split("\n")[0].slice(0, 90)}`)).pipe(
          Effect.andThen(llm.generate(LLM.request({ model, prompt: input.prompt }))),
          Effect.tap((value) => Effect.sync(() => auxiliary.push({ prompt: input.prompt, text: value.text }))),
          Effect.map((value) => value.text),
          Effect.mapError((error) => new Generate.UnavailableError({ message: error.message })),
        ),
    })
  }),
).pipe(Layer.provide(client))
const graph = AppNodeBuilder.build(
  LayerNode.group([PluginInternal.requirements, PluginHooks.node, SessionRunnerLLM.node, Session.node, Generate.node]),
  [
    LayerNodePlatform.llmClient.replace(client),
    Generate.node.replace(generation),
    SessionRunnerModel.node.replace(
      Layer.succeed(
        SessionRunnerModel.Service,
        SessionRunnerModel.Service.of({ resolve: () => Effect.succeed(resolved) }),
      ),
    ),
    Model.node.replace(
      Layer.mock(Model.Service, {
        get: () => Effect.undefined,
        all: () => Effect.succeed([]),
        available: () => Effect.succeed([]),
        default: () => Effect.undefined,
        small: () => Effect.undefined,
      }),
    ),
    Location.node.replace(tempLocationLayer),
    LocationServiceMap.node.replace(promptLocationNode),
    Config.node.replace(Config.testLayer()),
    Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
    SessionExecution.node.replace(SessionExecution.noopLayer),
    Snapshot.node.replace(Snapshot.noopLayer),
    PluginSupervisor.node.replace(Layer.empty),
    Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
    InstructionBuiltIns.node.replace(
      Layer.mock(InstructionBuiltIns.Service, { load: () => Effect.succeed(Instructions.empty) }),
    ),
    InstructionDiscovery.node.replace(
      Layer.mock(InstructionDiscovery.Service, {
        project: false,
        global: false,
        load: () => Effect.succeed(Instructions.empty),
      }),
    ),
    SkillInstructions.node.replace(
      Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
    ),
    ReferenceInstructions.node.replace(
      Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
    ),
    McpInstructions.node.replace(
      Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
    ),
  ],
)

const recipe: CookingRecipe.Recipe = {
  name: "西红柿炒鸡蛋",
  servings: 2,
  minutes: 15,
  equipment: ["炒锅"],
  source_ids: ["eval-tomato"],
  ingredients: [
    { name: "西红柿", quantity: 2, unit: "个", estimated: false },
    { name: "鸡蛋", quantity: 3, unit: "个", estimated: false },
  ],
  seasonings: [
    { name: "食用油", quantity: 25, unit: "毫升", estimated: true },
    { name: "盐", quantity: 2, unit: "克", estimated: true },
    { name: "糖", quantity: 3, unit: "克", estimated: true },
  ],
  steps: [
    { text: "西红柿洗净去蒂切块，鸡蛋打散。", uses: ["西红柿", "鸡蛋"] },
    { text: "锅中加入20毫升油，中火炒鸡蛋至刚凝固后盛出。", uses: ["鸡蛋", "食用油"] },
    { text: "加入剩余5毫升油，中火炒西红柿至变软出汁，加盐和糖翻匀。", uses: ["西红柿", "食用油", "盐", "糖"] },
    { text: "鸡蛋回锅，小火翻匀约20秒，关火盛出。", uses: ["鸡蛋", "西红柿"] },
  ],
}
const document: CookingKnowledge.Document = {
  id: "eval-tomato",
  title: "合成测试资料：西红柿炒鸡蛋",
  author: "测试夹具",
  edition: "test",
  locator: "fixture 1",
  source: "fixture://tomato",
  text: "先把鸡蛋炒至刚凝固盛出，再炒番茄出汁，最后合炒，避免鸡蛋长时间受热。" + CookingRecipe.render(recipe),
  tags: ["番茄", "西红柿", "鸡蛋"],
  recipe,
}
const alternateReference =
  "合成测试资料B：西红柿炒鸡蛋。作者：测试厨师乙；独立于库内资料A的第二个配方，仅用于评测。" +
  CookingRecipe.render({
    ...recipe,
    ingredients: [
      { name: "西红柿", quantity: 3, unit: "个", estimated: false },
      { name: "鸡蛋", quantity: 2, unit: "个", estimated: false },
    ],
    seasonings: [
      { name: "食用油", quantity: 18, unit: "毫升", estimated: true },
      { name: "盐", quantity: 1.5, unit: "克", estimated: true },
      { name: "糖", quantity: 2, unit: "克", estimated: true },
    ],
    steps: [
      recipe.steps[0],
      { text: "锅中加入15毫升油，中火炒鸡蛋至刚凝固后盛出。", uses: ["鸡蛋", "食用油"] },
      { text: "加入剩余3毫升油，中火炒西红柿至变软出汁，加盐和糖翻匀。", uses: ["西红柿", "食用油", "盐", "糖"] },
      recipe.steps[3],
    ],
  })

const evaluate = (scenario: Scenario) =>
  Effect.gen(function* () {
    auxiliary.length = 0
    const sessions = yield* Session.Service
    const runner = yield* SessionRunner.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const tools = yield* Tool.Service
    const hooks = yield* PluginHooks.Service
    const agents = yield* Agent.Service
    const knowledge = yield* CookingKnowledge.Service
    const execution = yield* CookingExecution.Service
    const memory = yield* CookingMemory.Service
    const forms = yield* Form.Service
    const bus = yield* Bus.Service
    const generate = yield* Generate.Service
    const kv = yield* KV.Service
    const context = host({
      agent: agentHost(agents),
      tool: {
        transform: tools.transform,
        reload: tools.reload,
        list: tools.list,
        hook: (name, callback) => hooks.register("tool", name, callback),
      },
      generate: { text: (input) => generate.text(input).pipe(Effect.map((text) => ({ text }))) },
      session: {
        hook: (name, callback) => hooks.register("session", name, callback),
        context: (input) => store.context(input.sessionID),
      },
    })
    yield* AgentPlugin.Plugin.effect(context)
    yield* CookingPlugin.Plugin.effect(context)
    yield* QuestionTool.Plugin.effect(context)
    yield* ToolInputRepairPlugin.Plugin.effect(context)
    yield* tools.transform((editor) => {
      editor.add({
        name: "websearch",
        options: { codemode: false },
        description: "Search the web for cooking sources.",
        input: Schema.Struct({ query: Schema.String }),
        output: Schema.String,
        execute: (input) =>
          Effect.succeed({
            output:
              scenario.id === "replan-replace-reference"
                ? "合成网络测试结果：测试厨师乙的另一份西红柿炒鸡蛋配方，https://example.test/new-reference。需读取页面。"
                : input.query.includes("红烧肉")
                  ? "合成网络测试结果：[红烧肉炒糖色版](https://example.test/braised-sugar)，[红烧肉酱油调色版](https://example.test/braised-soy)。这是评测夹具，需读取对应页面后比较。"
                  : `合成网络测试结果：${input.query}，例示菜谱页面 https://example.test/recipe。`,
          }),
      })
      editor.add({
        name: "webfetch",
        options: { codemode: false },
        description: "Read a cooking web page.",
        input: Schema.Struct({ url: Schema.String }),
        output: Schema.String,
        execute: (input, toolContext) =>
          scenario.web_unavailable
            ? Effect.fail(new ToolFailure({ message: "HTTP 403: synthetic unavailable reference source" }))
            : knowledge
                .recordPage(
                  toolContext.sessionID,
                  input.url,
                  input.url === "https://example.test/new-reference"
                    ? alternateReference
                    : input.url.includes("braised")
                      ? "合成评测菜谱：红烧肉。五花肉500克切块焯水。炒糖色版先炒冰糖调色再加热水炖至软烂；酱油版不炒糖色，以生抽调味、少量老抽调色，再加热水炖至软烂。两者区别在颜色与甜味的来源，不代表地区或权威标准。"
                      : document.text,
                )
                .pipe(
                  Effect.map(() => ({
                    output:
                      input.url === "https://example.test/new-reference"
                        ? alternateReference
                        : input.url.includes("braised")
                          ? "合成评测菜谱：红烧肉。五花肉500克切块焯水。炒糖色版先炒冰糖调色再加热水炖至软烂；酱油版不炒糖色，以生抽调味、少量老抽调色，再加热水炖至软烂。两者区别在颜色与甜味的来源，不代表地区或权威标准。"
                          : document.text,
                  })),
                ),
      })
    })
    if (scenario.library !== "empty")
      yield* knowledge.import([
        document,
        {
          ...document,
          id: "eval-soup",
          title: "合成测试资料：西红柿鸡蛋汤",
          source: "fixture://soup",
          tags: ["西红柿", "鸡蛋", "汤"],
          text: "西红柿炒软后加水煮开，淋入蛋液煮至凝固。",
          recipe: {
            ...recipe,
            name: "西红柿鸡蛋汤",
            source_ids: ["eval-soup"],
            ingredients: [...recipe.ingredients, { name: "水", quantity: 500, unit: "毫升", estimated: true }],
            seasonings: recipe.seasonings.filter((item) => item.name !== "糖"),
            steps: [
              { text: "西红柿洗净切块，鸡蛋打散。", uses: ["西红柿", "鸡蛋"] },
              { text: "加入食用油，中火炒软西红柿。", uses: ["食用油", "西红柿"] },
              { text: "加水大火煮开，淋入蛋液，煮至蛋花凝固，加盐后关火盛出。", uses: ["水", "鸡蛋", "盐"] },
            ],
          },
        },
      ])
    const session = yield* sessions.create({
      location: Location.Ref.make({ directory: location.directory }),
      title: `评测：${scenario.id}`,
    })
    if (scenario.legacy)
      yield* kv.set(
        "cooking/task/recipe_legacy_cooking_eval",
        Schema.encodeSync(Schema.toCodecJson(CookingWorkflow.Task))({
          id: "recipe_legacy_cooking_eval",
          session_id: session.id,
          revision: 26,
          conditions: {
            ...CookingRecipe.emptyConditions(),
            ingredients: [
              { name: "鸡蛋", quantity: 2, unit: "个" },
              { name: "西红柿", quantity: 3, unit: "个" },
            ],
          },
          candidates: [],
          dish: recipe.name,
          reference: recipe,
          evidence: { status: "ready", query: recipe.name, hits: [{ document, score: 1 }] },
          assessment: {
            needs_adaptation: true,
            reasons: ["参考配方需要调整"],
            questions: ["30毫升水和15毫升老抽怎么下锅？", "是否需要每一步等待用户确认？"],
          },
        }),
      )
    const questions: string[] = []
    const checks: { check: string; pass: boolean; detail?: string }[] = []
    yield* Effect.acquireRelease(
      bus.listen((event) => {
        if (event.type !== Form.Event.Created.type) return Effect.void
        const form = Schema.decodeUnknownSync(Form.Event.Created.data)(event.data).form
        if (form.sessionID !== session.id) return Effect.void
        questions.push(JSON.stringify(form.fields))
        // Keep unexpected questions visible in the trace, without hanging evaluation.
        return forms
          .reply({
            id: form.id,
            answer: Object.fromEntries(
              form.fields.map((field) => [
                field.key,
                field.type === "multiselect"
                  ? ["家人朋友聚餐，没有忌口，家用厨房"]
                  : scenario.intent === "clarify"
                    ? "8人，预算500元，没有忌口，家用厨房"
                    : "按我已经说的要求，你决定常规烹饪细节，不用逐项问我",
              ]),
            ),
          })
          .pipe(Effect.orDie)
      }),
      (unsubscribe) => unsubscribe,
    )
    let beforeRun: string | undefined
    let pausedProgress: { index: number; completed: number; elapsed: number } | undefined
    let beforeRecipe: CookingWorkflow.Result | undefined
    const readResult = Schema.decodeUnknownOption(Schema.fromJsonString(CookingWorkflow.Result))
    const readAction = Schema.decodeUnknownOption(Schema.Struct({ action: Schema.String }))
    for (const [index, turn] of scenario.turns.entries()) {
      console.log(`${scenario.id} ${index + 1}/${scenario.turns.length}: ${turn.text}`)
      yield* sessions.prompt({ sessionID: session.id, text: turn.text, resume: false })
      const response = yield* runner
        .drain({ sessionID: session.id, force: false })
        .pipe(Effect.timeout("240 seconds"), Effect.result)
      checks.push({
        check: `turn-${index + 1}: completed`,
        pass: response._tag === "Success",
        detail: response._tag === "Failure" ? String(response.failure) : undefined,
      })
      const turnHistory = yield* store.context(session.id)
      const turnMessages = turnHistory.slice(turnHistory.findLastIndex((message) => message.type === "user") + 1)
      const turnCalls = turnMessages.flatMap((message) =>
        message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
      )
      const turnRecipes = turnCalls.flatMap((call) =>
        call.name !== "recipe_task" || call.state.status !== "completed"
          ? []
          : call.state.content.flatMap((part) => {
              if (part.type !== "text") return []
              const value = readResult(part.text)
              return value._tag === "Some" ? [value.value] : []
            }),
      )
      const currentRecipe = turnRecipes.at(-1) ?? beforeRecipe
      if (turn.servings)
        checks.push({
          check: `turn-${index + 1}: saved recipe serves ${turn.servings}`,
          pass: (currentRecipe?.task.personalized ?? currentRecipe?.task.reference)?.servings === turn.servings,
        })
      if (turn.replan === "adapt")
        checks.push({
          check: `turn-${index + 1}: adapts the existing reference without restarting retrieval`,
          pass:
            !!beforeRecipe?.task.reference &&
            currentRecipe?.task.id === beforeRecipe.task.id &&
            currentRecipe.ready_for_guidance &&
            JSON.stringify(currentRecipe.task.reference) === JSON.stringify(beforeRecipe.task.reference) &&
            turnRecipes.length > 0 &&
            turnRecipes.every(
              (value) => value.transition?.reference === "reused" && value.transition.source_action === "none",
            ) &&
            !turnCalls.some((call) => ["websearch", "webfetch", "search_cooking_knowledge"].includes(call.name)),
        })
      if (turn.replan === "keep")
        checks.push({
          check: `turn-${index + 1}: explanation preserves the saved recipe`,
          pass:
            !!beforeRecipe &&
            turnRecipes.every(
              (value) =>
                value.task.id === beforeRecipe!.task.id &&
                value.task.revision === beforeRecipe!.task.revision &&
                JSON.stringify(value.task.reference) === JSON.stringify(beforeRecipe!.task.reference) &&
                JSON.stringify(value.task.personalized) === JSON.stringify(beforeRecipe!.task.personalized),
            ) &&
            turnCalls.every((call) => {
              if (!["recipe_task", "cooking_session"].includes(call.name)) return true
              const action = readAction(call.state.input)
              return action._tag === "Some" && action.value.action === "get"
            }),
        })
      if (turn.replan === "replace_reference")
        checks.push({
          check: `turn-${index + 1}: explicitly replaces the baseline from a newly read web source`,
          pass:
            !!beforeRecipe?.task.reference &&
            currentRecipe?.task.id === beforeRecipe.task.id &&
            currentRecipe.ready_for_guidance &&
            !!currentRecipe.task.reference?.source_ids.some((id) => id.startsWith("web:")) &&
            JSON.stringify(currentRecipe.task.reference.source_ids) !==
              JSON.stringify(beforeRecipe.task.reference.source_ids) &&
            turnRecipes.some((value) => value.transition?.cause === "new_reference") &&
            turnCalls.some((call) => call.name === "websearch") &&
            turnCalls.some((call) => call.name === "webfetch"),
        })
      if (turn.replan === "change_dish")
        checks.push({
          check: `turn-${index + 1}: changing dish invalidates the previous recipe`,
          pass:
            !!beforeRecipe?.task.reference &&
            !!currentRecipe?.task.reference &&
            CookingMemory.dishKey(currentRecipe.task.reference.name) !==
              CookingMemory.dishKey(beforeRecipe.task.reference.name) &&
            currentRecipe.ready_for_guidance,
        })
      beforeRecipe = currentRecipe
      if (turn.recipe) {
        const text = turnMessages
          .flatMap((message) =>
            message.type === "assistant"
              ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
              : [],
          )
          .join("\n")
        checks.push({
          check: `turn-${index + 1}: requested recipe is actually presented`,
          pass: [/(?:所需)?食材|用料/u, /(?:所需)?调料|调味料/u, /烹饪步骤|步骤|做法/u].every((section) =>
            section.test(text),
          ),
        })
      }
      const run = yield* execution.get(session.id)
      if (turn.guide)
        checks.push({
          check: `turn-${index + 1}: guide=${turn.guide}`,
          pass: turn.guide === "none" ? !run : run?.status === turn.guide,
          detail: run?.status ?? "none",
        })
      if (turn.same_run) checks.push({ check: "resume keeps the same run", pass: run?.id === beforeRun })
      if (turn.same_run && run && pausedProgress)
        checks.push({
          check: "resume retains actual progress",
          pass:
            run.index >= pausedProgress.index &&
            run.completions.length >= pausedProgress.completed &&
            (run.index !== pausedProgress.index || run.elapsed_ms >= pausedProgress.elapsed),
        })
      if (turn.new_run)
        checks.push({ check: "restart creates a new run after termination", pass: !!run && run.id !== beforeRun })
      beforeRun = run?.id
      if (run && turn.after === "pause") {
        for (let step = 0; step < Math.min(2, run.plan.steps.length - 1); step++)
          yield* execution.control({ session_id: session.id, run_id: run.id, index: step, action: "confirm" })
        const paused = yield* execution.control({ session_id: session.id, run_id: run.id, index: 0, action: "pause" })
        pausedProgress = { index: paused.index, completed: paused.completions.length, elapsed: paused.elapsed_ms }
      }
      if (run && turn.after === "complete") {
        for (const [step] of run.plan.steps.entries())
          yield* execution.control({ session_id: session.id, run_id: run.id, index: step, action: "confirm" })
        yield* sessions.synthetic({
          sessionID: session.id,
          text: JSON.stringify({
            type: "cooking_guidance_finished",
            dish: run.plan.dish,
            status: "completed",
            completed_steps: run.plan.steps.length,
            total_steps: run.plan.steps.length,
            can_resume: false,
          }),
          resume: false,
        })
        yield* runner.drain({ sessionID: session.id, force: false })
      }
    }
    const messages = yield* store.context(session.id)
    const calls = messages.flatMap((message) =>
      message.type !== "assistant" ? [] : message.content.filter((part) => part.type === "tool"),
    )
    const recipeResults = calls.flatMap((call) =>
      call.name !== "recipe_task" || call.state.status !== "completed"
        ? []
        : call.state.content.flatMap((part) => {
            if (part.type !== "text") return []
            const result = readResult(part.text)
            return result._tag === "Some" ? [result.value] : []
          }),
    )
    checks.push({
      check: "recipe choices never become numeric seasoning stock",
      pass: recipeResults.every((result) =>
        result.task.conditions.seasonings.every((stock) => stock.quantity === undefined),
      ),
    })
    const finalRecipe = recipeResults.at(-1)?.task.personalized ?? recipeResults.at(-1)?.task.reference
    const forbidden =
      scenario.id === "successive-corrections"
        ? ["糖", "酱油", "生抽", "老抽"]
        : ["identity-replan", "recipe-decisions", "feedback-memory", "disordered-emotional"].includes(scenario.id)
          ? ["糖", "生抽"]
          : []
    if (forbidden.length)
      checks.push({
        check: "latest taste correction applies to the saved recipe",
        pass:
          !!finalRecipe &&
          [...finalRecipe.ingredients, ...finalRecipe.seasonings].every(
            (item) => !forbidden.includes(CookingRecipe.canonical(item.name)),
          ),
      })
    if (["identity-replan", "recipe-decisions"].includes(scenario.id))
      checks.push({
        check: "actual dark soy variety retained",
        pass: !!finalRecipe?.seasonings.some((item) => item.name === "老抽"),
      })
    if (scenario.id === "disordered-emotional") {
      const conditions = recipeResults.at(-1)?.task.conditions
      checks.push({
        check: "disordered input retains counts and emotional context",
        pass:
          conditions?.ingredients.some((item) => item.name === "鸡蛋" && item.quantity === 2 && item.unit === "个") ===
            true &&
          conditions.regional_context.some((text) => text.includes("北京")) &&
          conditions.emotional_context.some((text) => text.includes("想家")),
      })
    }
    if (scenario.id === "new-recommendations") {
      const previousNames = new Set(recipeResults[0]?.task.candidates.map((item) => item.name) ?? [])
      const next = recipeResults.at(-1)?.task.candidates ?? []
      checks.push({
        check: "a new user request gets different recommendations",
        pass: recipeResults.length >= 2 && next.length > 0 && next.every((item) => !previousNames.has(item.name)),
      })
    }
    const condensed = messages.flatMap((message) => {
      if (message.type === "user") return [{ role: "user", text: message.text }]
      if (message.type !== "assistant") return []
      return message.content.flatMap((part) => {
        if (part.type === "text") return [{ role: "assistant", text: part.text }]
        if (part.type !== "tool" || part.state.status !== "completed") return []
        if (part.name === "question" && part.state.metadata?.answers)
          return [
            {
              role: "user_answers",
              text: JSON.stringify({ questions: part.state.input, answers: part.state.metadata.answers }),
            },
          ]
        if (part.name === "cooking_session")
          return part.state.content.flatMap((item) =>
            item.type !== "text" ? [] : [{ role: "guide_tool", text: item.text }],
          )
        if (part.name !== "recipe_task") return []
        return part.state.content.flatMap((item) =>
          item.type !== "text" ? [] : [{ role: "recipe_tool", text: item.text }],
        )
      })
    })
    const judgment = yield* audit(generate, condensed)
    checks.push({
      check: "conversation audit is grounded in actual assistant text",
      pass: judgment.grounded,
    })
    checks.push({
      check: "no routine questions, invented facts or parallel chat guide",
      pass: judgment.grounded && judgment.issues.length === 0,
      detail: judgment.verification,
    })
    checks.push({
      check: "bounded consequential questions",
      pass: questions.length <= scenario.max_questions,
      detail: `${questions.length}/${scenario.max_questions}`,
    })
    checks.push({
      check: "no unexpected tool errors",
      pass: !calls.some(
        (call) => call.state.status === "error" && !(scenario.web_unavailable && call.name === "webfetch"),
      ),
    })
    if (scenario.web_unavailable) {
      checks.push({
        check: "unavailable sources do not produce a ready recipe",
        pass: !recipeResults.some((result) => result.ready_for_guidance),
      })
      checks.push({ check: "bounded source retries", pass: calls.length <= 12, detail: String(calls.length) })
    }
    if (scenario.stock_only)
      checks.push({
        check: "strict inventory remains feasible",
        pass:
          !!finalRecipe &&
          [...finalRecipe.ingredients, ...finalRecipe.seasonings].every((item) =>
            ["番茄", "鸡蛋", "食用油", "盐"].includes(CookingRecipe.canonical(item.name)),
          ),
      })
    if (scenario.dish)
      checks.push({
        check: "dish switch reaches the new guide",
        pass: (yield* execution.get(session.id))?.plan.dish.includes(scenario.dish) === true,
      })
    if (scenario.intent === "names")
      checks.push({
        check: "names only, no forced full workflow",
        pass:
          calls.some((call) => call.name === "recipe_task") &&
          !calls.some((call) => call.name === "cooking_session") &&
          calls
            .filter((call) => call.name === "recipe_task")
            .every((call) => {
              const value = readAction(call.state.input)
              return value._tag === "Some" && value.value.action === "suggest"
            }),
      })
    if (scenario.intent === "knowledge")
      checks.push({
        check: "knowledge question does not create recipe or guide",
        pass:
          calls.some((call) => call.name === "search_cooking_knowledge") &&
          !calls.some((call) => ["recipe_task", "cooking_session"].includes(call.name)),
      })
    if (scenario.intent === "web")
      checks.push({
        check: "explicit web request bypasses recipe workflow and RAG",
        pass:
          calls.some((call) => call.name === "websearch") &&
          !calls.some((call) => ["recipe_task", "search_cooking_knowledge"].includes(call.name)),
      })
    if (scenario.id === "empty-library-draft")
      checks.push({
        check: "no web when forbidden",
        pass: !calls.some((call) => ["websearch", "webfetch"].includes(call.name)),
      })
    if (scenario.intent === "clarify")
      checks.push({ check: "asks essential personal conditions", pass: questions.length === 1 })
    if (scenario.intent === "direct_knowledge")
      checks.push({
        check: "stable explanation can answer directly without a recipe",
        pass: !calls.some((call) => ["recipe_task", "cooking_session"].includes(call.name)),
      })
    const memories = yield* memory.run(session.id, { action: "list" })
    if (scenario.memory)
      checks.push({
        check: "actual feedback saved",
        pass: memories.entries.some(
          ({ entry }) => entry.quote.includes("鸡蛋有点老") && entry.episode?.status === "completed",
        ),
      })
    if (scenario.memory) {
      const episode = memories.entries.find(({ entry }) => entry.quote.includes("鸡蛋有点老"))?.entry.episode
      const originalSoy = episode?.recipe_text.match(/老抽([\d.]+)毫升/)
      const finalSoy = finalRecipe?.seasonings.find((item) => item.name === "老抽")
      checks.push({
        check: "feedback recalled and actual soy amount reduced",
        pass:
          !!originalSoy &&
          !!finalSoy &&
          finalSoy.unit === "毫升" &&
          finalSoy.quantity < Number(originalSoy[1]) &&
          recipeResults.at(-1)?.task.memory?.entries.some(({ entry }) => entry.quote.includes("鸡蛋有点老")) === true,
      })
    }
    const trace = {
      scenario: scenario.id,
      model: modelID,
      session_id: session.id,
      references: "synthetic fixtures",
      checks,
      questions,
      memories,
      messages,
      auxiliary_generations: auxiliary.slice(),
      audit: judgment,
      audit_input: condensed,
      run: yield* execution.get(session.id),
    }
    yield* Effect.promise(() => Bun.write(path.join(output, `${scenario.id}.json`), JSON.stringify(trace, null, 2)))
    return {
      scenario: scenario.id,
      pass: checks.every((check) => check.pass),
      checks,
      tool_calls: calls.length,
      main_steps: messages.filter((message) => message.type === "assistant").length,
    }
  })

const results = []
if (process.argv.includes("--audit-only")) {
  const filename = process.argv[process.argv.indexOf("--audit-only") + 1]
  const input = Schema.decodeUnknownSync(Schema.Struct({ transcript: Transcript }))(await Bun.file(filename).json())
  const checked = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* Generate.Service
      return yield* audit(service, input.transcript)
    }).pipe(Effect.provide(generation)),
  )
  await Bun.write(filename + ".review.json", JSON.stringify(checked, null, 2))
  process.exit(checked.grounded && !checked.issues.length ? 0 : 1)
}
for (const scenario of scenarios) {
  const result = await Effect.runPromise(evaluate(scenario).pipe(Effect.scoped, Effect.provide(graph)))
  results.push(result)
  console.log(JSON.stringify(result))
  await Bun.write(path.join(output, "summary.json"), JSON.stringify(results, null, 2))
}
if (results.some((result) => !result.pass)) process.exitCode = 1
