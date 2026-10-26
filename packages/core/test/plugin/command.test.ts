import { expect } from "bun:test"
import { Effect } from "effect"
import { Command } from "@opencook/core/command"
import { Bus } from "@opencook/core/bus"
import { AppNodeBuilder } from "@opencook/core/effect/app-node-builder"
import { Mcp } from "@opencook/core/mcp/index"
import { CommandPlugin } from "@opencook/core/plugin/command"
import { LayerNode } from "@opencook/util/effect/layer-node"
import { emptyMcpLayer } from "../fixture/mcp"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Command.node, Mcp.node, Bus.node]), [Mcp.node.replace(emptyMcpLayer)]),
)

it.effect("does not expose repository setup and code review commands in OpenCook", () =>
  Effect.gen(function* () {
    const command = yield* Command.Service
    yield* CommandPlugin.Plugin.effect(
      host({
        command: {
          list: () => Effect.die("unused command.list"),
          transform: command.transform,
          reload: command.reload,
        },
      }),
    )
    expect(yield* command.get("init")).toBeUndefined()
    expect(yield* command.get("review")).toBeUndefined()
  }),
)
