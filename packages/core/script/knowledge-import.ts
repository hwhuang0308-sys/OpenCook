import { Effect, Schema } from "effect"
import { CookingKnowledge } from "../src/cooking/knowledge.js"
import { AppNodeBuilder } from "../src/effect/app-node-builder.js"

const file = process.argv[2]
if (!file) throw new Error("Usage: bun script/knowledge-import.ts <curated-passages.json>")
const documents = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(CookingKnowledge.Document)))(
  await Bun.file(file).text(),
)
await Effect.runPromise(
  Effect.gen(function* () {
    const library = yield* CookingKnowledge.Service
    yield* library.import(documents)
  }).pipe(Effect.provide(AppNodeBuilder.build(CookingKnowledge.node)), Effect.scoped),
)
process.stdout.write(`Imported ${documents.length} cooking-library passages.\n`)
