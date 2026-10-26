import { describe, expect, test } from "bun:test"
import { Effect, Logger } from "effect"
import { AppNodeBuilder } from "@opencook/core/effect/app-node-builder"
import { LayerNode } from "@opencook/util/effect/layer-node"
import { Database } from "@opencook/core/database/database"
import { Bus } from "@opencook/core/bus"
import { EventLogger } from "@opencook/core/event-logger"
import { Agent } from "@opencook/schema/agent"
import { Model } from "@opencook/schema/model"
import { Provider } from "@opencook/schema/provider"
import { Command } from "@opencook/schema/command"
import { Config } from "@opencook/schema/config"
import { McpEvent } from "@opencook/schema/mcp-event"

const UnlistedUpdated = Bus.ephemeral({ type: "test.updated", schema: {} })

describe("EventLogger", () => {
  test("logs explicitly listed updated events", async () => {
    const output = new Array<ReturnType<typeof Logger.formatStructured.log>>()
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      output.push(entry)
    })

    await Effect.gen(function* () {
      const bus = yield* Bus.Service
      yield* bus.publish(Agent.Event.Updated, {})
      yield* bus.publish(Provider.Event.Updated, {})
      yield* bus.publish(Model.Event.Updated, {})
      yield* bus.publish(Command.Event.Updated, {})
      yield* bus.publish(Config.Event.Updated, {})
      yield* bus.publish(McpEvent.StatusChanged, { server: "example" })
      yield* bus.publish(UnlistedUpdated, {})
    }).pipe(
      Effect.provide(AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, EventLogger.node]))),
      Effect.provide(Logger.layer([logger])),
      Effect.scoped,
      Effect.runPromise,
    )

    expect(
      output.flatMap((entry) => (Array.isArray(entry.message) && entry.message[0] === "event" ? [entry.message] : [])),
    ).toEqual([
      ["event", { event: expect.objectContaining({ type: "agent.updated" }) }],
      ["event", { event: expect.objectContaining({ type: "provider.updated" }) }],
      ["event", { event: expect.objectContaining({ type: "model.updated" }) }],
      ["event", { event: expect.objectContaining({ type: "command.updated" }) }],
      ["event", { event: expect.objectContaining({ type: "config.updated" }) }],
    ])
  })
})
