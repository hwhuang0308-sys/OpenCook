import { HttpRecorder } from "@opencook/http-recorder"
import { OpenAIChat } from "@opencook/ai/protocols/openai-chat"
import { Auth, LLMClient, type LLMClientService, RequestExecutor } from "@opencook/ai/route"
import { Model } from "@opencook/core/model"
import { Database } from "@opencook/core/database/database"
import { AppNodeBuilder } from "@opencook/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencook/core/effect/app-node-platform"
import { LayerNode } from "@opencook/util/effect/layer-node"
import { Bus } from "@opencook/core/bus"
import { EventTable } from "@opencook/core/event/sql"
import { Permission } from "@opencook/core/permission"
import { Agent } from "@opencook/core/agent"
import { Config } from "@opencook/core/config"
import { Project } from "@opencook/core/project"
import { ProjectTable } from "@opencook/core/project/sql"
import { AbsolutePath } from "@opencook/core/schema"
import { Session } from "@opencook/core/session"
import { Snapshot } from "@opencook/core/snapshot"
import { SessionProjector } from "@opencook/core/session/projector"
import { SessionExecution } from "@opencook/core/session/execution"
import { SessionRunCoordinator } from "@opencook/core/session/run-coordinator"
import { SessionRunner } from "@opencook/core/session/runner/index"
import { SessionRunnerLLM } from "@opencook/core/session/runner/llm"
import { SessionRunnerModel } from "@opencook/core/session/runner/model"
import { Tool } from "@opencook/core/tool"
import { SessionTable } from "@opencook/core/session/sql"
import { SessionStore } from "@opencook/core/session/store"
import { Location } from "@opencook/core/location"
import { InstructionBuiltIns } from "@opencook/core/instructions/builtins"
import { InstructionDiscovery } from "@opencook/core/instruction-discovery"
import { Instructions } from "@opencook/core/instructions/index"
import { SkillInstructions } from "@opencook/core/skill/instructions"
import { ReferenceInstructions } from "@opencook/core/reference/instructions"
import { McpInstructions } from "@opencook/core/mcp/instructions"
import { PluginSupervisor } from "@opencook/core/plugin/supervisor"
import { Plugin } from "@opencook/core/plugin"
import { PluginHooks } from "@opencook/core/plugin/hooks"
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import path from "node:path"
import { testEffect } from "./lib/effect"
import { LocationServiceMap } from "@opencook/core/location-service-map"
import { promptLocationNode } from "./fixture/prompt-location"
import { permissionLayer } from "./lib/permission"

const cassetteName = "session-runner/openai-chat-streams-text"
const cassetteDirectory = path.resolve(import.meta.dir, "fixtures/recordings")
// This test owns transport replay and durable events. Pin its historical request prompt
// to the cassette so changes to the product's Cook instructions do not require a paid recording.
const transportPrompt =
  process.env.RECORD === "true"
    ? "Return a brief greeting."
    : Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            interactions: Schema.Array(Schema.Struct({ request: Schema.Struct({ body: Schema.String }) })),
          }),
        ),
      )(await Bun.file(path.join(cassetteDirectory, `${cassetteName}.json`)).text()).interactions.map(
        (interaction) =>
          Schema.decodeUnknownSync(
            Schema.fromJsonString(
              Schema.Struct({ messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.String })) }),
            ),
          )(interaction.request.body).messages.find((message) => message.role === "system")?.content,
      )[0]
if (process.env.RECORD === "true") {
  if (process.env.CI !== undefined) throw new Error("Unset CI before recording HTTP cassettes")
  HttpRecorder.removeCassetteSync(cassetteName, { directory: cassetteDirectory })
}
const cassette = HttpRecorder.layerFetch(cassetteName, { directory: cassetteDirectory })
const executor = RequestExecutor.layer.pipe(Layer.provide(cassette))
const client = LLMClient.layer.pipe(Layer.provide(executor))
const permission = permissionLayer()
const model = OpenAIChat.route
  .with({
    endpoint: { baseURL: "https://api.openai.com/v1" },
    auth: Auth.bearer(process.env.OPENAI_API_KEY ?? "fixture"),
    generation: { maxTokens: 20, temperature: 0 },
  })
  .model({ id: "gpt-4o-mini", compatibility: { supportsPromptCacheKey: true } })
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: () =>
    Effect.succeed(
      SessionRunnerModel.resolved(model, {
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 20 },
      }),
    ),
})
const systemContext = Layer.mock(InstructionBuiltIns.Service, { load: () => Effect.succeed(Instructions.empty) })
const instructionContext = Layer.mock(InstructionDiscovery.Service, {
  project: true,
  global: true,
  load: () => Effect.succeed(Instructions.empty),
})
const skillInstructions = Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const referenceInstructions = Layer.mock(ReferenceInstructions.Service, {
  load: () => Effect.succeed(Instructions.empty),
})
const mcpInstructions = Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const config = Config.testLayer()
const promptModels = Layer.mock(Model.Service, {
  get: () => Effect.undefined,
  all: () => Effect.succeed([]),
  available: () => Effect.succeed([]),
  default: () => Effect.undefined,
  small: () => Effect.undefined,
})
const runnerLayer = (llmClient: Layer.Layer<LLMClientService>) =>
  AppNodeBuilder.build(SessionRunnerLLM.node, [
    Snapshot.node.replace(Snapshot.noopLayer),
    LayerNodePlatform.llmClient.replace(llmClient),
    SessionRunnerModel.node.replace(models),
    InstructionBuiltIns.node.replace(systemContext),
    InstructionDiscovery.node.replace(instructionContext),
    Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    SkillInstructions.node.replace(skillInstructions),
    ReferenceInstructions.node.replace(referenceInstructions),
    McpInstructions.node.replace(mcpInstructions),
    Config.node.replace(config),
    Permission.node.replace(permission),
    PluginSupervisor.node.replace(Layer.empty),
    Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
  ])
const execution = (llmClient: Layer.Layer<LLMClientService>) =>
  Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const sessionRunner = yield* SessionRunner.Service
      const coordinator = yield* SessionRunCoordinator.make<Session.ID, SessionRunner.RunError>({
        drain: (sessionID, force) => sessionRunner.drain({ sessionID, force }).pipe(Effect.asVoid),
      })
      return SessionExecution.Service.of({
        active: coordinator.active,
        isActive: coordinator.isActive,
        resume: coordinator.run,
        wake: coordinator.wake,
        interrupt: (sessionID) => coordinator.interrupt(sessionID),
        awaitIdle: coordinator.awaitIdle,
      })
    }),
  ).pipe(Layer.provide(runnerLayer(llmClient)), Layer.orDie)
const testLayer = (llmClient: Layer.Layer<LLMClientService>) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Agent.node,
      Model.node,
      PluginHooks.node,
      Tool.node,
      SessionRunnerModel.node,
      InstructionBuiltIns.node,
      InstructionDiscovery.node,
      SkillInstructions.node,
      ReferenceInstructions.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      Session.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      LocationServiceMap.node.replace(promptLocationNode),
      LayerNodePlatform.llmClient.replace(llmClient),
      Permission.node.replace(permission),
      Model.node.replace(promptModels),
      SessionRunnerModel.node.replace(models),
      InstructionBuiltIns.node.replace(systemContext),
      InstructionDiscovery.node.replace(instructionContext),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
      SkillInstructions.node.replace(skillInstructions),
      ReferenceInstructions.node.replace(referenceInstructions),
      Config.node.replace(config),
      Snapshot.node.replace(Snapshot.noopLayer),
      PluginSupervisor.node.replace(Layer.empty),
      Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
      SessionExecution.node.replace(execution(llmClient)),
    ],
  )
const it = testEffect(testLayer(client))
const sessionID = Session.ID.make("ses_runner_recorded")

describe("SessionRunnerLLM recorded", () => {
  it.effect("executes one recorded prompt through the recorded HTTP transport", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.defaultID, (agent) => {
          agent.mode = "primary"
          agent.system = transportPrompt
          agent.permissions.push({ action: "execute", resource: "*", effect: "deny" })
        }),
      )
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const session = yield* Session.Service
      const prompt = yield* session.prompt({
        sessionID,
        text: "Say hello in one short sentence.",
        resume: false,
      })

      yield* session.resume(sessionID)

      const messages = yield* session.context(sessionID)
      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({ id: prompt.id, type: "user", text: "Say hello in one short sentence." })
      expect(messages[1]).toMatchObject({ type: "assistant", agent: "cook", finish: "stop" })
      expect(messages[1]?.type === "assistant" ? messages[1].content : []).toMatchObject([
        { type: "text", text: "Hello!" },
      ])
      expect(
        (yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .orderBy(EventTable.seq)
          .all()).map((event) => event.type),
      ).toEqual([
        "session.inbox.enqueued.1",
        "session.instructions.updated.2",
        "session.inbox.delivered.1",
        "session.step.started.1",
        "session.text.started.1",
        "session.text.ended.1",
        "session.step.streamed.1",
        "session.step.ended.1",
      ])
    }),
  )
})
