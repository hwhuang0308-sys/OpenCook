import type { OpenCook } from "./client.js"

export * from "./generated/index.js"
export { OpenCook } from "./client.js"
export type {
  AgentApi,
  CommandApi,
  ConfigApi,
  EventApi,
  IntegrationApi,
  ModelApi,
  PluginApi,
  ProviderApi,
  ReferenceApi,
  RpcApi,
  RpcCallOptions,
  RpcClient,
  RpcEventPayload,
  WebSearchApi,
  SessionApi,
  SkillApi,
} from "./api.js"
export type { EventSubscribeOutput as OpenCookEvent } from "./generated/types.js"
export type OpenCookClient = ReturnType<typeof OpenCook.make>
