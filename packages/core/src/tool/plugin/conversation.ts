export * as ConversationTools from "./conversation.js"

import { ToolFailure } from "@opencook/ai"
import { define } from "@opencook/plugin/effect/plugin"
import { Session } from "@opencook/schema/session"
import { Effect, Schema } from "effect"

export const RenameInput = Schema.Struct({
  sessionID: Schema.optionalKey(Session.ID).annotate({ description: "Omit to rename the current session." }),
  title: Schema.Trim.check(Schema.isNonEmpty()),
})

export const Plugin = define({
  id: "opencook.conversations",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.tool.transform((draft) => {
      draft.namespace({ name: "opencook", description: "Organize OpenCook conversations." })
      draft.add({
        name: "session_rename",
        description:
          "Rename a session, or omit sessionID to rename the current session. Use a short, specific title that summarizes the work being done.",
        input: RenameInput,
        output: Schema.Struct({ sessionID: Session.ID, title: Schema.String }),
        options: { namespace: "opencook", codemode: true },
        execute: (input, context) => {
          const sessionID = input.sessionID ?? context.sessionID
          const title = input.title.trim()
          if (!title) return Effect.fail(new ToolFailure({ message: "Session title must not be empty" }))
          return ctx.session.update({ sessionID, title }).pipe(
            Effect.as({
              output: { sessionID, title },
              content: `Renamed session ${sessionID} to ${title}.`,
            }),
            Effect.mapError((error) => new ToolFailure({ message: `Unable to rename session ${sessionID}`, error })),
          )
        },
      })
    })
  }),
})
