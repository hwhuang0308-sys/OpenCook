import { NodeFileSystem } from "@effect/platform-node"
import { compile, emitEffectImported, emitEffectShape, emitPromise, write } from "@opencook/httpapi-codegen"
import { ClientApi, effectOmitEndpoints, groupNames, promiseOmitEndpoints } from "@opencook/protocol/client"
import { Agent } from "@opencook/schema/agent"
import { Command } from "@opencook/schema/command"
import { Config } from "@opencook/schema/config"
import { Kitchen } from "@opencook/schema/kitchen"
import { Cooking } from "@opencook/schema/cooking"
import { Credential } from "@opencook/schema/credential"
import { Event } from "@opencook/schema/event"
import { EventLog } from "@opencook/schema/event-log"
import { FileDiff } from "@opencook/schema/file-diff"
import { FileSystem } from "@opencook/schema/filesystem"
import { Form } from "@opencook/schema/form"
import { Instruction } from "@opencook/schema/instruction"
import { InstructionEntry } from "@opencook/schema/instruction-entry"
import { Integration } from "@opencook/schema/integration"
import { Location } from "@opencook/schema/location"
import { Mcp } from "@opencook/schema/mcp"
import { Model } from "@opencook/schema/model"
import { Money } from "@opencook/schema/money"
import { Permission } from "@opencook/schema/permission"
import { PermissionSaved } from "@opencook/schema/permission-saved"
import { Plugin } from "@opencook/schema/plugin"
import { Project } from "@opencook/schema/project"
import { Worktree } from "@opencook/schema/worktree"
import { AgentAttachment, FileAttachment, Prompt, PromptMention } from "@opencook/schema/prompt"
import { PromptInput } from "@opencook/schema/prompt-input"
import { Provider } from "@opencook/schema/provider"
import { Pty } from "@opencook/schema/pty"
import { PtyTicket } from "@opencook/schema/pty-ticket"
import { Question } from "@opencook/schema/question"
import { Reference } from "@opencook/schema/reference"
import { AbsolutePath, RelativePath } from "@opencook/schema/schema"
import { Session } from "@opencook/schema/session"
import { SessionMessage } from "@opencook/schema/session-message"
import { SessionInbox } from "@opencook/schema/session-inbox"
import { Shell } from "@opencook/schema/shell"
import { Skill } from "@opencook/schema/skill"
import { Snapshot } from "@opencook/schema/snapshot"
import { Vcs } from "@opencook/schema/vcs"
import { WebSearch } from "@opencook/schema/websearch"
import { Workspace } from "@opencook/schema/workspace"
import { Effect, Schema } from "effect"
import { fileURLToPath } from "url"

const promiseContract = compile(ClientApi, { groupNames, omitEndpoints: promiseOmitEndpoints })
const effectContract = compile(ClientApi, { groupNames, omitEndpoints: effectOmitEndpoints })
const effectTypeReferences = [
  ...namespaceTypes("Kitchen", "@opencook/schema/kitchen", Kitchen),
  ...namespaceTypes("Cooking", "@opencook/schema/cooking", Cooking),
  ...namespaceTypes("Agent", "@opencook/schema/agent", Agent),
  ...namespaceTypes("Command", "@opencook/schema/command", Command),
  ...namespaceTypes("Config", "@opencook/schema/config", Config),
  ...namespaceTypes("Credential", "@opencook/schema/credential", Credential),
  ...namespaceTypes("Event", "@opencook/schema/event", Event),
  ...namespaceTypes("EventLog", "@opencook/schema/event-log", EventLog),
  ...namespaceTypes("FileDiff", "@opencook/schema/file-diff", FileDiff),
  ...namespaceTypes("FileSystem", "@opencook/schema/filesystem", FileSystem),
  ...namespaceTypes("Form", "@opencook/schema/form", Form),
  ...namespaceTypes("Instruction", "@opencook/schema/instruction", Instruction),
  ...namespaceTypes("InstructionEntry", "@opencook/schema/instruction-entry", InstructionEntry),
  ...namespaceTypes("Integration", "@opencook/schema/integration", Integration),
  typeReference("Location.PublicRef", "@opencook/schema/location", Location.PublicRef),
  typeReference("Location.PublicInfo", "@opencook/schema/location", Location.PublicInfo),
  ...namespaceTypes("Mcp", "@opencook/schema/mcp", Mcp),
  ...namespaceTypes("Model", "@opencook/schema/model", Model),
  ...namespaceTypes("Money", "@opencook/schema/money", Money),
  ...namespaceTypes("Permission", "@opencook/schema/permission", Permission),
  ...namespaceTypes("PermissionSaved", "@opencook/schema/permission-saved", PermissionSaved),
  ...namespaceTypes("Plugin", "@opencook/schema/plugin", Plugin),
  ...namespaceTypes("Project", "@opencook/schema/project", Project),
  ...namespaceTypes("Worktree", "@opencook/schema/worktree", Worktree),
  ...namespaceTypes("PromptInput", "@opencook/schema/prompt-input", PromptInput),
  ...namespaceTypes("Provider", "@opencook/schema/provider", Provider),
  ...namespaceTypes("Pty", "@opencook/schema/pty", Pty),
  ...namespaceTypes("PtyTicket", "@opencook/schema/pty-ticket", PtyTicket),
  ...namespaceTypes("Question", "@opencook/schema/question", Question),
  ...namespaceTypes("Reference", "@opencook/schema/reference", Reference),
  ...namespaceTypes("Session", "@opencook/schema/session", Session),
  ...namespaceTypes("SessionMessage", "@opencook/schema/session-message", SessionMessage),
  ...namespaceTypes("SessionInbox", "@opencook/schema/session-inbox", SessionInbox),
  ...namespaceTypes("Shell", "@opencook/schema/shell", Shell),
  ...namespaceTypes("Skill", "@opencook/schema/skill", Skill),
  ...namespaceTypes("Snapshot", "@opencook/schema/snapshot", Snapshot),
  ...namespaceTypes("Vcs", "@opencook/schema/vcs", Vcs),
  ...namespaceTypes("WebSearch", "@opencook/schema/websearch", WebSearch),
  ...namespaceTypes("Workspace", "@opencook/schema/workspace", Workspace),
  typeReference("Prompt", "@opencook/schema/prompt", Prompt),
  typeReference("PromptMention", "@opencook/schema/prompt", PromptMention),
  typeReference("FileAttachment", "@opencook/schema/prompt", FileAttachment),
  typeReference("AgentAttachment", "@opencook/schema/prompt", AgentAttachment),
  typeReference("AbsolutePath", "@opencook/schema/schema", AbsolutePath),
  typeReference("RelativePath", "@opencook/schema/schema", RelativePath),
]

await Effect.runPromise(
  Effect.all(
    [
      write(
        emitPromise(promiseContract, {
          mutableOutputs: true,
        }),
        fileURLToPath(new URL("../src/promise/generated", import.meta.url)),
      ),
      write(
        emitEffectImported(effectContract, {
          module: "../../contract",
          api: "ClientApi",
          shapeModule: "../api/api.js",
        }),
        fileURLToPath(new URL("../src/effect/generated", import.meta.url)),
      ),
      write(
        emitEffectShape(effectContract, {
          typeReferences: effectTypeReferences,
          outputTypes: {
            "event.subscribe": {
              name: "OpenCookEvent",
              import: 'import type { OpenCookEvent } from "@opencook/protocol/groups/event"',
            },
          },
        }),
        fileURLToPath(new URL("../src/effect/api", import.meta.url)),
      ),
    ],
    { concurrency: 3, discard: true },
  ).pipe(Effect.provide(NodeFileSystem.layer)),
)

function namespaceTypes(namespace: string, module: string, values: object) {
  return Object.entries(values).flatMap(([name, schema]) =>
    Schema.isSchema(schema) ? [typeReference(`${namespace}.${name}`, module, schema)] : [],
  )
}

function typeReference(name: string, module: string, schema: Schema.Top) {
  return {
    schema,
    name,
    import: `import type { ${name.split(".")[0]} } from ${JSON.stringify(module)}`,
  }
}
