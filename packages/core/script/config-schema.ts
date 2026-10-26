import { Schema } from "effect"
import { Kitchen } from "@opencook/schema/kitchen"
import { Info } from "@opencook/schema/config"
import { format } from "prettier"

const document = Schema.toJsonSchemaDocument(Schema.Struct({ ...Info.fields, cooking_models: Schema.optionalKey(Kitchen.ModelConfig) }), {
  onExcessProperty: "error",
})
await Bun.write(
  new URL("../../../docs/schemas/opencook.schema.json", import.meta.url),
  await format(
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:opencook:project-config",
      ...document.schema,
      ...(Object.keys(document.definitions).length ? { $defs: document.definitions } : {}),
    }),
    { parser: "json" },
  ),
)
