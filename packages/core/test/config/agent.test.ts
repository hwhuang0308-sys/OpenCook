import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Agent } from "@opencook/core/agent"
import { Bus } from "@opencook/core/bus"
import { Config } from "@opencook/core/config"
import { Document, Info } from "@opencook/schema/config"
import { ConfigAgentPlugin } from "@opencook/core/config/plugin/agent"
import { AppNodeBuilder } from "@opencook/core/effect/app-node-builder"
import { LayerNode } from "@opencook/util/effect/layer-node"
import { Global } from "@opencook/util/global"
import { Permission } from "@opencook/core/permission"
import { AgentPlugin } from "@opencook/core/plugin/agent"
import { testEffect } from "../lib/effect"
import { agentHost, host } from "../plugin/host"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, Global.node])))
const decode = Schema.decodeUnknownSync(Info)

it.effect("keeps OpenCook roles and prompts while applying configured permissions", () =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agents) }))
    const original = yield* agents.get(Agent.defaultID)
    yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
      Effect.provide(
        Config.testLayer([
          new Document({
            type: "document",
            info: decode({
              default_agent: "plan",
              permissions: [{ action: "edit", resource: "*", effect: "deny" }],
              agents: {
                cook: {
                  disabled: true,
                  system: "You are a coding agent",
                  mode: "subagent",
                  model: { providerID: "custom", model: "custom" },
                  permissions: [{ action: "read", resource: "private.txt", effect: "deny" }],
                },
                general: { system: "Write code instead" },
                plan: { mode: "primary", system: "Plan code changes" },
              },
            }),
          }),
        ]),
      ),
    )
    const cook = yield* agents.resolve()
    expect(cook).toMatchObject({ id: Agent.defaultID, name: "Cook", mode: "primary", system: original?.system })
    expect(cook?.model).toBeUndefined()
    expect(yield* agents.get(Agent.ID.make("plan"))).toBeUndefined()
    expect((yield* agents.get(Agent.ID.make("general")))?.system).not.toBe("Write code instead")
    expect(Permission.evaluate("edit", "menu.md", cook?.permissions ?? []).effect).toBe("deny")
    expect(Permission.evaluate("read", "private.txt", cook?.permissions ?? []).effect).toBe("deny")
  }),
)
