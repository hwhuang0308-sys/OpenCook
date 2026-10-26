import { expect } from "bun:test"
import { Effect } from "effect"
import { Bus } from "@opencook/core/bus"
import { Database } from "@opencook/core/database/database"
import { KitchenSettings } from "@opencook/core/cooking/settings"
import { Location } from "@opencook/core/location"
import { Plugin } from "@opencook/core/plugin"
import { PluginHost } from "@opencook/core/plugin/host"
import { AgentPlugin } from "@opencook/core/plugin/agent"
import { ModelRuntimePlugin } from "@opencook/core/plugin/model-runtime"
import { Session } from "@opencook/core/session"
import { SessionContext } from "@opencook/core/session/context"
import { SessionEvent } from "@opencook/core/session/event"
import { SessionMessage } from "@opencook/core/session/message"
import { InstructionState } from "@opencook/core/session/instruction-state"
import { testEffect } from "./lib/effect"
import { makePluginTestLayer } from "./plugin/fixture"

const it = testEffect(makePluginTestLayer(undefined, SessionContext.node))

for (const image of [false, true]) {
  it.effect(
    `routes ${image ? "image context to vision" : "text context to chat"} through the configured school model`,
    () =>
      Effect.gen(function* () {
        const settings = yield* KitchenSettings.Service
        const plugins = yield* Plugin.Service
        const bus = yield* Bus.Service
        const sessions = yield* Session.Service
        const context = yield* SessionContext.Service
        const location = yield* Location.Service
        const database = yield* Database.Service
        const profile = {
          enabled: true,
          base_url: "https://school.test/v1",
          model: "ecnu-max",
          context: 10000,
          output: 1000,
        }
        yield* settings.updateModel({ role: "chat", profile, api_key: "school-fixture-key" })
        yield* settings.updateModel({
          role: "vision",
          profile: { ...profile, model: "ecnu-plus" },
          api_key: "school-fixture-key",
        })
        const host = yield* PluginHost.make(plugins)
        yield* ModelRuntimePlugin.Plugin.effect(host)
        yield* AgentPlugin.Plugin.effect(host)
        const session = yield* sessions.create({ location: Location.Ref.make({ directory: location.directory }) })
        const inboxID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.InboxEnqueued, {
          sessionID: session.id,
          inboxID,
          item: {
            type: "user",
            delivery: "steer",
            payload: {
              text: image ? "看看锅里的菜" : "推荐一道家常菜",
              files: image ? [{ source: { type: "inline" }, mime: "image/png", data: "AAAA" }] : undefined,
            },
          },
        })
        yield* bus.publish(SessionEvent.InboxDelivered, { sessionID: session.id, inboxID })
        const selection = yield* context.select(session.id)
        yield* InstructionState.prepare(database.db, bus, selection.instructions, session.id)
        const loaded = yield* context.load(selection)
        expect(String(loaded.model.model.id)).toBe(image ? "ecnu-plus" : "ecnu-max")
        expect(String(loaded.model.ref.providerID)).toBe(image ? "opencook-vision" : "opencook")
        expect(
          loaded.messages.some(
            (message) => message.type === "user" && message.text === (image ? "看看锅里的菜" : "推荐一道家常菜"),
          ),
        ).toBe(true)
        if (image) expect(loaded.model.capabilities.input).toContain("image")
      }),
  )
}
