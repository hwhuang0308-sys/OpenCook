import { Effect, Schema } from "effect"
import type { Generate } from "../../src/generate.js"
import JUDGE from "./judge.txt"

export const Transcript = Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String }))
export const Judgment = Schema.Struct({
  issues: Schema.Array(Schema.Struct({ kind: Schema.String, quote: Schema.String, reason: Schema.String })),
})

export const audit = (generate: Generate.Interface, transcript: typeof Transcript.Type) =>
  Effect.gen(function* () {
    const initial = yield* generate.text({ prompt: JUDGE + "\nTranscript:\n" + JSON.stringify(transcript) })
    const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Judgment))
    const proposed = yield* decode(initial)
    const verification = proposed.issues.length
      ? yield* generate.text({
          prompt:
            JUDGE +
            "\nVerify the proposed issues below independently. Keep only a concrete violation supported by this transcript. Drop permitted guidance offers, consistent recipe paraphrases, recipe characterizations and post-cooking feedback invitations. Do not report an issue whose own explanation says it is allowed. You may only retain a proposed kind/quote, not invent new ones. Return the same JSON shape.\nProposed issues:\n" +
            initial +
            "\nTranscript:\n" +
            JSON.stringify(transcript),
        })
      : initial
    const checked = yield* decode(verification)
    const assistantText = transcript
      .filter((message) => message.role === "assistant")
      .map((message) => message.text)
      .join("\n")
    return {
      initial,
      verification,
      issues: checked.issues,
      grounded: checked.issues.every(
        (issue) =>
          assistantText.includes(issue.quote) &&
          proposed.issues.some((original) => original.kind === issue.kind && original.quote === issue.quote),
      ),
    }
  })
