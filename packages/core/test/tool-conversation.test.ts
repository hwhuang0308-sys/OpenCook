import { expect } from "bun:test"
import { Effect } from "effect"
import { Location } from "@opencook/core/location"
import { Plugin } from "@opencook/core/plugin"
import { PluginHost } from "@opencook/core/plugin/host"
import { Session } from "@opencook/core/session"
import { Tool } from "@opencook/core/tool"
import { ConversationTools } from "@opencook/core/tool/plugin/conversation"
import { testEffect } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)
it.effect("renames a cooking conversation through the production tool", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const sessions = yield* Session.Service
    const location = yield* Location.Service
    yield* ConversationTools.Plugin.effect(yield* PluginHost.make(plugins))
    expect(
      (yield* tools.list()).filter((tool) => tool.options?.namespace === "opencook").map((tool) => tool.name),
    ).toEqual(["session_rename"])
    const session = yield* sessions.create({ location: Location.Ref.make({ directory: location.directory }) })
    const result = yield* executeTool(tools, {
      sessionID: session.id,
      ...toolIdentity,
      call: {
        type: "tool-call",
        id: "rename",
        name: "execute",
        input: { code: 'return await tools.opencook.session_rename({title:"家宴菜单"})' },
      },
    })
    expect(result.status).toBe("completed")
    expect((yield* sessions.get(session.id)).title).toBe("家宴菜单")
  }),
)
