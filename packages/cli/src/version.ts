import { Option, Schema } from "effect"

declare const OPENCOOK_VERSION: string
declare const OPENCOOK_CHANNEL: string
declare const OPENCOOK_ARTIFACT: string
declare const OPENCOOK_RELEASE_HIGHLIGHTS: string

const version = typeof OPENCOOK_VERSION === "string" ? OPENCOOK_VERSION : "local"
const channel = typeof OPENCOOK_CHANNEL === "string" ? OPENCOOK_CHANNEL : "local"
const artifact = typeof OPENCOOK_ARTIFACT === "string" ? OPENCOOK_ARTIFACT : "cli"
// Stable release builds embed the release notes' Highlights; every other build has none.
const highlights =
  typeof OPENCOOK_RELEASE_HIGHLIGHTS === "string"
    ? Option.getOrElse(
        Schema.decodeUnknownOption(
          Schema.fromJsonString(Schema.Array(Schema.Struct({ title: Schema.String, body: Schema.String }))),
        )(OPENCOOK_RELEASE_HIGHLIGHTS),
        () => [],
      )
    : []

export {
  version as OPENCOOK_VERSION,
  channel as OPENCOOK_CHANNEL,
  artifact as OPENCOOK_ARTIFACT,
  highlights as OPENCOOK_HIGHLIGHTS,
}
export const OPENCOOK_LOCAL = channel === "local"
