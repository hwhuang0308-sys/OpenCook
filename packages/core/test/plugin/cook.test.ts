import { expect } from "bun:test"
import { OpenAIChat } from "@opencook/ai/protocols"
import { Agent } from "@opencook/core/agent"
import { Config } from "@opencook/core/config"
import { AppNodeBuilder } from "@opencook/core/effect/app-node-builder"
import { Location } from "@opencook/core/location"
import { PluginInternal } from "@opencook/core/plugin/internal"
import { SessionModelRequest } from "@opencook/core/session/model-request"
import { SessionRunnerModel } from "@opencook/core/session/runner/model"
import { Tool } from "@opencook/core/tool"
import { Bus } from "@opencook/core/bus"
import { CookingKnowledge } from "@opencook/core/cooking/knowledge"
import { CookingMemory } from "@opencook/core/cooking/memory"
import { CookingExecution } from "@opencook/core/cooking/execution"
import { CookingPlugin } from "@opencook/core/plugin/cooking"
import { AgentPlugin } from "@opencook/core/plugin/agent"
import { PluginHooks } from "@opencook/core/plugin/hooks"
import { Session } from "@opencook/core/session"
import { SessionEvent } from "@opencook/core/session/event"
import { SessionMessage } from "@opencook/core/session/message"
import { Model } from "@opencook/schema/model"
import { Provider } from "@opencook/schema/provider"
import { LayerNode } from "@opencook/util/effect/layer-node"
import { Effect, Layer, Schema } from "effect"
import { Generate } from "@opencook/core/generate"
import { Form } from "@opencook/core/form"
import { QuestionTool } from "@opencook/core/tool/plugin/question"
import { tempLocationLayer } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { agentHost, host } from "./host"
import { executeTool } from "../lib/tool"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([PluginInternal.requirements, PluginHooks.node]), [
    Location.node.replace(tempLocationLayer),
    Config.node.replace(Config.testLayer()),
    Generate.node.replace(
      Layer.succeed(
        Generate.Service,
        Generate.Service.of({ text: () => Effect.succeed(JSON.stringify({ changes: {}, evidence: [] })) }),
      ),
    ),
  ]),
)

it.live("returns current guidance state to Cook while keeping full scores in the execution service", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const location = yield* Location.Service
    const tools = yield* Tool.Service
    const agents = yield* Agent.Service
    const execution = yield* CookingExecution.Service
    const hooks = yield* PluginHooks.Service
    const context = host({
      agent: agentHost(agents),
      tool: { transform: tools.transform, list: tools.list, reload: tools.reload, hook: () => Effect.die("unused") },
      session: { hook: (name, callback) => hooks.register("session", name, callback) },
    })
    yield* AgentPlugin.Plugin.effect(context)
    yield* CookingPlugin.Plugin.effect(context)
    const session = yield* sessions.create({ location: Location.Ref.make({ directory: location.directory }) })
    const run = yield* execution.start(session.id, {
      task_id: "recipe-fixture",
      revision: 1,
      dish: "测试菜",
      recipe_text: "合成测试配方",
      program: "测试程序谱全文",
      actions: "测试动作谱全文",
      steps: [{ action: "清洗食材", continuous: false, seconds: 0, conditions: [], logic: "" }],
    })
    const state = yield* executeTool(tools, {
      sessionID: session.id,
      agent: Agent.defaultID,
      messageID: SessionMessage.ID.create(),
      call: { type: "tool-call", id: "get-current-guide", name: "cooking_session", input: { action: "get" } },
    })
    expect(state).toMatchObject({
      status: "completed",
      output: {
        run_id: run.id,
        index: 0,
        step: 1,
        current_action: "清洗食材",
        total_steps: 1,
        interaction: "dedicated_cooking_screen",
      },
    })
    expect(state.output).not.toHaveProperty("plan")
    expect(JSON.stringify(state.content)).not.toContain("测试动作谱全文")
    expect((yield* execution.get(session.id))?.plan.actions).toBe("测试动作谱全文")
  }),
)

it.live("filters routine questions before showing a form while retaining an essential user-requested question", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const location = yield* Location.Service
    const bus = yield* Bus.Service
    const tools = yield* Tool.Service
    const forms = yield* Form.Service
    const agents = yield* Agent.Service
    const decisions = [[], [0]]
    const context = host({
      agent: agentHost(agents),
      tool: { transform: tools.transform, list: tools.list, reload: tools.reload, hook: () => Effect.die("unused") },
      session: { context: (input) => sessions.context(input.sessionID) },
      generate: {
        text: () =>
          Effect.succeed({ text: JSON.stringify({ ask_indices: decisions.shift(), reason: "测试外部判断边界" }) }),
      },
    })
    yield* AgentPlugin.Plugin.effect(context)
    yield* QuestionTool.Plugin.effect(context)
    const session = yield* sessions.create({ location: Location.Ref.make({ directory: location.directory }) })
    const user = yield* sessions.prompt({
      sessionID: session.id,
      text: "两个鸡蛋三个西红柿，给我推荐一道菜",
      resume: false,
    })
    yield* bus.publish(SessionEvent.InboxDelivered, { sessionID: session.id, inboxID: user.id })
    const suppressed = yield* executeTool(tools, {
      sessionID: session.id,
      agent: Agent.defaultID,
      messageID: user.id,
      call: {
        type: "tool-call",
        id: "routine-question",
        name: "question",
        input: {
          questions: [
            {
              question: "要先放水还是先放老抽？",
              header: "顺序",
              options: [{ label: "先放水", description: "水先下锅" }],
            },
          ],
        },
      },
    })
    expect(suppressed).toMatchObject({ status: "completed", output: { skipped_questions: ["要先放水还是先放老抽？"] } })
    expect(yield* forms.list({ sessionID: session.id })).toHaveLength(0)
    const next = yield* sessions.prompt({ sessionID: session.id, text: "我要办宴席，你先问人数", resume: false })
    yield* bus.publish(SessionEvent.InboxDelivered, { sessionID: session.id, inboxID: next.id })
    yield* Effect.acquireRelease(
      bus.listen((event) => {
        if (event.type !== Form.Event.Created.type) return Effect.void
        const form = Schema.decodeUnknownSync(Form.Event.Created.data)(event.data).form
        return forms.reply({ id: form.id, answer: { q0: "8人" } }).pipe(Effect.orDie)
      }),
      (unsubscribe) => unsubscribe,
    )
    const asked = yield* executeTool(tools, {
      sessionID: session.id,
      agent: Agent.defaultID,
      messageID: next.id,
      call: {
        type: "tool-call",
        id: "essential-question",
        name: "question",
        input: {
          questions: [{ question: "几个人吃？", header: "人数", options: [{ label: "8人", description: "八人一桌" }] }],
        },
      },
    })
    expect(asked).toMatchObject({ status: "completed", output: { answers: [["8人"]] } })
  }),
)

it.live("stores quoted feedback through Cook's tool and supplies private memory to later cooking conversations", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const location = yield* Location.Service
    const bus = yield* Bus.Service
    const tools = yield* Tool.Service
    const hooks = yield* PluginHooks.Service
    const agents = yield* Agent.Service
    const memory = yield* CookingMemory.Service
    const checks = ["enduring", "temporary", "temporary", "experience", undefined]
    yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agents) }))
    yield* CookingPlugin.Plugin.effect(
      host({
        generate: {
          text: () => Effect.succeed({ text: JSON.stringify({ category: checks.shift(), reason: "测试语义分类" }) }),
        },
        tool: {
          transform: tools.transform,
          list: () => Effect.die("unused"),
          reload: tools.reload,
          hook: () => Effect.die("unused"),
        },
        session: { hook: (name, callback) => hooks.register("session", name, callback) },
      }),
    )
    const session = yield* sessions.create({ location: Location.Ref.make({ directory: location.directory }) })
    const user = yield* sessions.prompt({ sessionID: session.id, text: "我一直不喜欢甜口", resume: false })
    yield* bus.publish(SessionEvent.InboxDelivered, { sessionID: session.id, inboxID: user.id })
    const saved = yield* executeTool(tools, {
      sessionID: session.id,
      agent: Agent.defaultID,
      messageID: user.id,
      call: {
        type: "tool-call",
        id: "remember",
        name: "cooking_memory",
        input: {
          action: "remember",
          kind: "preference",
          scope: "general",
          quote: "我一直不喜欢甜口",
          lasting_evidence: "我一直不喜欢甜口",
          topic: "甜度",
        },
      },
    })
    expect(saved).toMatchObject({ status: "completed", output: { status: "saved" } })
    const temporary = yield* sessions.prompt({ sessionID: session.id, text: "明天我想清淡一点", resume: false })
    yield* bus.publish(SessionEvent.InboxDelivered, { sessionID: session.id, inboxID: temporary.id })
    const rejected = yield* executeTool(tools, {
      sessionID: session.id,
      agent: Agent.defaultID,
      messageID: temporary.id,
      call: {
        type: "tool-call",
        id: "temporary",
        name: "cooking_memory",
        input: {
          action: "remember",
          kind: "preference",
          scope: "general",
          quote: "明天我想清淡一点",
          lasting_evidence: "明天我想清淡一点",
          topic: "清淡",
        },
      },
    })
    expect(rejected).toMatchObject({ status: "completed", output: { status: "not_retained" } })
    expect((yield* memory.run(session.id, { action: "list" })).entries).toHaveLength(1)
    const relabeled = yield* executeTool(tools, {
      sessionID: session.id,
      agent: Agent.defaultID,
      messageID: temporary.id,
      call: {
        type: "tool-call",
        id: "relabeled-temporary",
        name: "cooking_memory",
        input: {
          action: "remember",
          kind: "experience",
          scope: "dish",
          dish: "蒸土豆",
          quote: "明天我想清淡一点",
          topic: "清淡",
        },
      },
    })
    expect(relabeled).toMatchObject({ status: "completed", output: { status: "not_retained" } })
    expect((yield* memory.run(session.id, { action: "list" })).entries).toHaveLength(1)
    const feedback = yield* sessions.prompt({ sessionID: session.id, text: "这次蒸土豆太咸了", resume: false })
    yield* bus.publish(SessionEvent.InboxDelivered, { sessionID: session.id, inboxID: feedback.id })
    const experience = {
      action: "remember" as const,
      kind: "experience" as const,
      scope: "dish" as const,
      dish: "蒸土豆",
      quote: "这次蒸土豆太咸了",
      topic: "咸度",
    }
    expect(
      yield* executeTool(tools, {
        sessionID: session.id,
        agent: Agent.defaultID,
        messageID: feedback.id,
        call: { type: "tool-call", id: "experience", name: "cooking_memory", input: experience },
      }),
    ).toMatchObject({ status: "completed", output: { status: "saved" } })
    expect(
      yield* executeTool(tools, {
        sessionID: session.id,
        agent: Agent.defaultID,
        messageID: feedback.id,
        call: { type: "tool-call", id: "unavailable-check", name: "cooking_memory", input: experience },
      }),
    ).toMatchObject({ status: "error" })
    expect((yield* memory.run(session.id, { action: "list" })).entries).toHaveLength(2)
    const next = yield* sessions.create({ location: Location.Ref.make({ directory: location.directory }) })
    const event = yield* hooks.trigger("session", "context", {
      sessionID: next.id,
      agent: Agent.defaultID,
      model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("test") }),
      system: [],
      messages: [],
      tools: {},
      options: {},
    })
    expect(JSON.stringify(event.system)).toContain("我一直不喜欢甜口")
    const entry = (yield* memory.run(next.id, { action: "list" })).entries[0].entry
    yield* memory.run(next.id, { action: "forget", id: entry.id })
    const cleared = yield* hooks.trigger("session", "context", { ...event, system: [] })
    expect(JSON.stringify(cleared.system)).not.toContain("我一直不喜欢甜口")
  }),
)

it.live("leaves source selection to Cook and retrieves attributed passages only through an explicit tool call", () =>
  Effect.gen(function* () {
    const knowledge = yield* CookingKnowledge.Service
    const sessions = yield* Session.Service
    const location = yield* Location.Service
    const hooks = yield* PluginHooks.Service
    const bus = yield* Bus.Service
    const tools = yield* Tool.Service
    const agents = yield* Agent.Service
    yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agents) }))
    yield* knowledge.import([
      {
        id: "fixture-potato",
        title: "土豆处理测试资料",
        author: "测试夹具",
        edition: "test",
        locator: "fixture 2",
        source: "fixture://potato",
        text: "土豆烹饪测试段落。",
        tags: ["土豆"],
      },
    ])
    yield* CookingPlugin.Plugin.effect(
      host({
        tool: {
          transform: tools.transform,
          list: () => Effect.die("unused"),
          reload: tools.reload,
          hook: () => Effect.die("unused"),
        },
        session: { hook: (name, callback) => hooks.register("session", name, callback) },
      }),
    )
    const session = yield* sessions.create({ location: Location.Ref.make({ directory: location.directory }) })
    const input = yield* sessions.prompt({ sessionID: session.id, text: "请去网上搜索土豆的各种做法。", resume: false })
    yield* bus.publish(SessionEvent.InboxDelivered, { sessionID: session.id, inboxID: input.id })
    const event = yield* hooks.trigger("session", "context", {
      sessionID: session.id,
      agent: Agent.defaultID,
      model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("test") }),
      system: [],
      messages: [],
      tools: {},
      options: {},
    })
    expect(event.system).toHaveLength(0)
    const found = yield* executeTool(tools, {
      sessionID: session.id,
      agent: Agent.defaultID,
      messageID: input.id,
      call: { type: "tool-call", id: "knowledge", name: "search_cooking_knowledge", input: { query: "土豆处理" } },
    })
    expect(found).toMatchObject({
      status: "completed",
      output: {
        status: "ready",
        query: "土豆处理",
        hits: [{ document: { id: "fixture-potato", source: "fixture://potato" } }],
      },
    })
    yield* knowledge.import([
      {
        id: "fixture-steamed",
        title: "蒸土豆测试菜谱",
        author: "测试夹具",
        edition: "test",
        locator: "fixture 3",
        source: "fixture://steamed",
        text: "蒸土豆测试配方",
        tags: ["土豆"],
        recipe: {
          name: "蒸土豆",
          servings: 1,
          minutes: 10,
          equipment: ["蒸锅"],
          source_ids: ["fixture-steamed"],
          ingredients: [{ name: "土豆", quantity: 100, unit: "克", estimated: false }],
          seasonings: [],
          steps: [{ text: "土豆切片蒸熟。", uses: ["土豆"] }],
        },
      },
    ])
    const result = yield* executeTool(tools, {
      sessionID: session.id,
      agent: Agent.defaultID,
      messageID: input.id,
      call: { type: "tool-call", id: "reference", name: "recipe_task", input: { action: "reference", dish: "蒸土豆" } },
    })
    expect(result).toMatchObject({ status: "completed" })
    expect(result.content?.[0]).toMatchObject({ type: "text", text: expect.stringContaining('"reference_ready"') })
    const guidance = yield* executeTool(tools, {
      sessionID: session.id,
      agent: Agent.defaultID,
      messageID: input.id,
      call: { type: "tool-call", id: "guidance-state", name: "cooking_session", input: { action: "get" } },
    })
    expect(guidance).toMatchObject({ status: "completed", output: null })
  }),
)

it.live("uses one Cook profile without coding prompt plugins for any configured model", () =>
  Effect.gen(function* () {
    const definitions = yield* PluginInternal.list()
    const plugins = [...definitions.pre, ...definitions.post]
    const ids = plugins.map((plugin) => plugin.id)
    expect(ids).not.toContain("opencook.plan")
    for (const model of ["openai", "anthropic", "kimi", "arcee", "meta"])
      expect(ids).not.toContain(`opencook.prompt.${model}`)
    for (const id of [
      "opencook.skill",
      "opencook.config.instruction",
      "opencook.config.command",
      "opencook.config.skill",
    ])
      expect(ids).not.toContain(id)

    const agents = yield* Agent.Service
    const tools = yield* Tool.Service
    const pluginHost = host({
      agent: agentHost(agents),
      tool: {
        transform: tools.transform,
        list: () => Effect.die("unused tool.list"),
        reload: () => Effect.die("unused tool.reload"),
        hook: () => Effect.die("OpenCook must not register a worktree reminder"),
      },
    })
    for (const plugin of plugins.filter((plugin) =>
      ["opencook.agent", "opencook.config.agent", "opencook.conversations"].includes(plugin.id),
    ))
      yield* plugin.effect(pluginHost)

    expect(
      (yield* agents.list())
        .filter((agent) => agent.mode !== "subagent" && !agent.hidden)
        .map((agent) => String(agent.name)),
    ).toEqual(["Cook"])
    const cook = yield* agents.resolve()
    if (!cook) throw new Error("expected default Cook")
    const snapshot = yield* tools.snapshot()
    expect(yield* agents.get(Agent.ID.make("plan"))).toBeUndefined()
    expect(yield* agents.resolve("plan")).toBeUndefined()
    yield* agents.reload()
    expect(yield* agents.resolve("plan")).toBeUndefined()
    const prompts = ["gpt-6-astra", "kimi", "claude"].map((id) =>
      SessionModelRequest.baseTranscript({
        agent: cook,
        model: SessionRunnerModel.resolved(OpenAIChat.route.model({ id, provider: "test" }), {
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          cost: [],
          limit: { context: 100_000, output: 8_000 },
        }),
        tools: snapshot,
        initial: "",
        messages: [],
      }),
    )
    expect(prompts[0]?.system).toEqual(prompts[1]?.system)
    expect(prompts[1]?.system).toEqual(prompts[2]?.system)
    expect(prompts[0]?.system[0]?.text).toStartWith("You are Cook")
    expect(prompts[0]?.system[0]?.text).not.toContain("${OPENCOOK_TOOL_GUIDANCE}")
  }),
)
