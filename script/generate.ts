#!/usr/bin/env bun
import { $ } from "bun"

await $`bun run generate`.cwd("packages/protocol")
await $`bun run generate`.cwd("packages/client")
await $`bun script/config-schema.ts`.cwd("packages/core")
await $`bun script/schema.ts ../../docs/schemas/cli.schema.json`.cwd("packages/cli")
