export * as CookingKnowledge from "./knowledge.js"

import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencook/util/effect/app-node"
import { KV } from "../kv.js"
import { CookingRecipe } from "./recipe.js"
import { optional } from "../schema.js"

const Text = Schema.Trim.check(Schema.isNonEmpty())
export const Document = Schema.Struct({
  id: Text,
  title: Text,
  author: Text,
  edition: Text,
  locator: Text,
  source: Text,
  text: Text,
  tags: Schema.Array(Text),
  recipe: Schema.optional(CookingRecipe.Recipe),
})
export type Document = typeof Document.Type
export const Query = Schema.Struct({
  query: Text,
  limit: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))),
})
export const Result = Schema.Struct({
  status: Schema.Literals(["ready", "empty_library", "no_match"]),
  query: Schema.String,
  hits: Schema.Array(Schema.Struct({ document: Document, score: Schema.Number })),
  external: Schema.optional(Schema.Array(Document)),
})
export type Result = typeof Result.Type

export interface Interface {
  readonly search: (query: typeof Query.Type) => Effect.Effect<Result>
  readonly import: (documents: ReadonlyArray<Document>) => Effect.Effect<void>
  readonly recordPage: (sessionID: string, url: string, text: string) => Effect.Effect<void>
  readonly pages: (sessionID: string, urls: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Document>>
}
export class Service extends Context.Service<Service, Interface>()("@opencook/CookingKnowledge") {}

function tokens(text: string) {
  const normalized = text.normalize("NFKC").toLowerCase()
  return [
    ...new Set([
      ...(normalized.match(/[a-z0-9]+/g) ?? []),
      ...(normalized.match(/[\p{Script=Han}]+/gu) ?? []).flatMap((word) =>
        word.length === 1
          ? [word]
          : Array.from(word)
              .slice(1)
              .map((_, index) => word.slice(index, index + 2)),
      ),
    ]),
  ]
}

const prefix = "cooking/library/"
const decode = Schema.decodeUnknownSync(Schema.toCodecJson(Document))
const encode = Schema.encodeSync(Schema.toCodecJson(Document))
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service
    return Service.of({
      import: (documents) =>
        Effect.forEach(documents, (document) => kv.set(`${prefix}${document.id}`, encode(document)), { discard: true }),
      recordPage: (sessionID, url, text) =>
        kv.set(
          `cooking/web/${sessionID}/${encodeURIComponent(url)}`,
          encode({
            id: `web:${url}`,
            title: url,
            author: "网页来源（作者待核实）",
            edition: "web",
            locator: url,
            source: url,
            text: text.length > 30000 ? `${text.slice(0, 30000)}\n[来源内容已截断]` : text,
            tags: [],
          }),
        ),
      pages: (sessionID, urls) =>
        Effect.forEach(urls, (url) => kv.get(`cooking/web/${sessionID}/${encodeURIComponent(url)}`)).pipe(
          Effect.map((values) => values.filter((value) => value !== undefined).map((value) => decode(value))),
        ),
      search: (input) =>
        Effect.gen(function* () {
          const documents: Document[] = []
          let after: string | undefined
          do {
            const page = yield* kv.scan({ prefix, after, limit: 1000 })
            documents.push(...page.entries.map((entry) => decode(entry.value)))
            after = page.next
          } while (after !== undefined)
          const terms = tokens(input.query)
          const hits = documents
            .map((document) => {
              const title = tokens([document.title, ...document.tags, document.recipe?.name ?? ""].join(" "))
              const body = tokens(document.text)
              const matched = terms.filter(
                (term) =>
                  title.includes(term) || body.includes(term) || (term.length === 1 && document.text.includes(term)),
              )
              const score = terms.length
                ? matched.reduce((sum, term) => sum + (title.includes(term) ? 3 : 1), 0) / terms.length
                : 0
              return { document, score }
            })
            .filter((hit) => hit.score > 0)
            .sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id))
            .slice(0, input.limit ?? 5)
          return {
            status: !documents.length ? "empty_library" : hits.length ? "ready" : "no_match",
            query: input.query,
            hits,
          }
        }),
    })
  }),
)
export const node = makeGlobalNode({ service: Service, layer, deps: [KV.node] })
