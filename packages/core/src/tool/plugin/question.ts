export * as QuestionTool from "./question.js"

import type { Context } from "@opencook/plugin/effect/plugin"
import { ToolFailure } from "@opencook/ai"
import { Effect, Schema } from "effect"
import { Form } from "../../form.js"
import { Permission } from "../../permission.js"
import { Question } from "@opencook/schema/question"
import { Agent } from "../../agent.js"
import { optional } from "../../schema.js"
import CLARIFICATION from "../../cooking/prompts/clarification.txt"

export const name = "question"

export const description = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Resolve consequential choices about servings, dietary needs, budget, equipment, or timing
4. Offer choices to the user about what direction to take.

Usage notes:
- Answer simple cooking questions directly
- Reuse facts from conversation history and ask only for missing information that affects the next decision
- Cook determines routine quantities, oil allocation, cutting, seasoning order, heat and timing; do not ask the user to design or approve these details
- Do not reopen an already answered question, ask whether an excluded ingredient may still be used, or request general medical screening for an ordinary recipe
- Prioritize one to three questions at a time; offer meaningful alternatives when useful
- A "Type your own answer" option is added automatically; don't include a separate option for free form answers
- Set \`multiple: true\` to allow selecting more than one option
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label`

export const Input = Schema.Struct({
  questions: Schema.Array(Question.Prompt).check(Schema.isNonEmpty()).annotate({ description: "Questions to ask" }),
})

export const Output = Schema.Struct({
  answers: Schema.Array(Question.Answer),
  skipped_questions: optional(Schema.Array(Schema.String)),
})
export type Output = typeof Output.Type

export class CancelledError extends Schema.TaggedError<CancelledError>()("QuestionTool.CancelledError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export const toModelContent = (questions: ReadonlyArray<Question.Prompt>, answers: ReadonlyArray<Question.Answer>) => {
  const formatted = questions
    .map(
      (question, index) =>
        `"${question.question}"="${answers[index]?.length ? answers[index].join(", ") : "Unanswered"}"`,
    )
    .join(", ")
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}

export const Plugin = {
  id: "opencook.tool.question",
  effect: Effect.fn("QuestionTool.Plugin")(function* (ctx: Context) {
    const forms = yield* Form.Service
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            permission
              .assert({
                action: "question",
                resources: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              .pipe(
                Effect.mapError((error) => new ToolFailure({ message: "Permission denied: question", error })),
                Effect.andThen(
                  Effect.gen(function* () {
                    if (context.agent !== Agent.defaultID) return input.questions.map((_, index) => index)
                    const history = yield* ctx.session.context({ sessionID: context.sessionID }).pipe(Effect.orDie)
                    const response = yield* ctx.generate
                      .text({
                        prompt:
                          CLARIFICATION +
                          "\nInput data:\n" +
                          JSON.stringify({
                            conversation: history.flatMap((message) =>
                              message.type === "user"
                                ? [{ role: "user", text: message.text }]
                                : message.type !== "assistant"
                                  ? []
                                  : message.content.flatMap((part) =>
                                      part.type === "tool" &&
                                      part.name === "question" &&
                                      part.state.status === "completed"
                                        ? [
                                            {
                                              role: "answered_questions",
                                              text: JSON.stringify({
                                                questions: part.state.input,
                                                answers: part.state.metadata?.answers,
                                              }),
                                            },
                                          ]
                                        : [],
                                    ),
                            ),
                            proposed_questions: input.questions,
                          }),
                      })
                      .pipe(
                        Effect.mapError(
                          (error) =>
                            new ToolFailure({ message: error instanceof Error ? error.message : String(error) }),
                        ),
                      )
                    const checked = yield* Schema.decodeUnknownEffect(
                      Schema.fromJsonString(
                        Schema.Struct({ ask_indices: Schema.Array(Schema.Int), reason: Schema.String }),
                      ),
                    )(response.text).pipe(
                      Effect.mapError(() => new ToolFailure({ message: "澄清问题核对失败，请保留已有要求并说明限制" })),
                    )
                    return [...new Set(checked.ask_indices)]
                      .filter((index) => index >= 0 && index < input.questions.length)
                      .slice(0, 3)
                  }),
                ),
                Effect.flatMap(
                  (
                    indices,
                  ): Effect.Effect<
                    { output: Output; content: string; metadata?: { answers: readonly Question.Answer[] } },
                    ToolFailure
                  > => {
                    const skipped = input.questions
                      .filter((_, index) => !indices.includes(index))
                      .map((question) => question.question)
                    if (!indices.length)
                      return Effect.succeed({
                        output: { answers: input.questions.map((): Question.Answer => []), skipped_questions: skipped },
                        content:
                          "These questions were not sent to the user because they are routine cooking decisions, already answered, or unnecessary for the requested task. Proceed using the stated conditions and recipe. Do not repeat these questions in chat or another tool call.",
                      })
                    return forms
                      .ask({
                        sessionID: context.sessionID,
                        title: "Questions",
                        metadata: { kind: "question", tool: { messageID: context.messageID, id: context.id } },
                        fields: [
                          toField(input.questions[indices[0]], indices[0]),
                          ...indices.slice(1).map((index) => toField(input.questions[index], index)),
                        ],
                      })
                      .pipe(
                        Effect.orDie,
                        Effect.flatMap((state) => {
                          if (state.status === "cancelled" && state.message !== undefined)
                            return Effect.fail(new ToolFailure({ message: state.message }))
                          if (state.status === "cancelled") return Effect.die(new CancelledError())
                          const output = {
                            answers: input.questions.map((_, index): Question.Answer => {
                              const value = state.answer[`q${index}`]
                              return value === undefined
                                ? []
                                : typeof value === "object"
                                  ? Array.from(value)
                                  : [String(value)]
                            }),
                            ...(skipped.length ? { skipped_questions: skipped } : {}),
                          }
                          return Effect.succeed({
                            output,
                            content:
                              toModelContent(
                                indices.map((index) => input.questions[index]),
                                indices.map((index) => output.answers[index]),
                              ) +
                              (skipped.length
                                ? "\nSome routine questions were not asked. Do not reopen them; Cook decides those recipe details."
                                : ""),
                            metadata: { answers: output.answers },
                          })
                        }),
                      )
                  },
                ),
              ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}

function toField(question: Question.Prompt, index: number): Form.Field {
  return {
    key: `q${index}`,
    title: question.header,
    description: question.question,
    type: question.multiple === true ? "multiselect" : "string",
    options: question.options.map((option) => ({
      value: option.label,
      label: option.label,
      description: option.description,
    })),
    custom: true,
  }
}
