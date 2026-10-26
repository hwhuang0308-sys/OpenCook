import type { FileSystem } from "@opencook/core/filesystem"
import { Bus } from "@opencook/core/bus"
import { Image } from "@opencook/core/image"
import { LocationServiceMap } from "@opencook/core/location-service-map"
import type { LocationServices } from "@opencook/core/location-services"
import { Plugin } from "@opencook/core/plugin"
import { PluginHooks } from "@opencook/core/plugin/hooks"
import { Skill } from "@opencook/core/skill"
import type { Location } from "@opencook/schema/location"
import { makeGlobalNode } from "@opencook/util/effect/app-node"
import { LayerNode } from "@opencook/util/effect/layer-node"
import { Effect, Layer, LayerMap } from "effect"

// Plain-prompt unit fixtures use virtual directories.
export const promptLocationNode = makeGlobalNode({
  service: LocationServiceMap.Service,
  layer: Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      return yield* LayerMap.make(
        (_ref: Location.Ref) =>
          LayerNode.compile(LayerNode.group([PluginHooks.node, Image.node, Skill.node, Plugin.node]), {
            replacements: [
              Bus.node.replace(Layer.succeed(Bus.Service, bus)),
              Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
            ],
          }) as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>,
      )
    }),
  ),
  deps: [Bus.node],
})
