import path from "node:path"
import { OPENCOOK_CHANNEL } from "./version"

export function databasePath(data: string) {
  const filename =
    process.env.OPENCOOK_DB ??
    (["latest", "dev", "beta", "next", "prod"].includes(OPENCOOK_CHANNEL) ||
    process.env.OPENCOOK_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCOOK_DISABLE_CHANNEL_DB === "true"
      ? "opencook.db"
      : `opencook-${OPENCOOK_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
  return filename === ":memory:" ? filename : path.resolve(data, filename)
}
