// Third-party PTY service; keep its published package name.
import { binaryPath } from "@opencode-ai/pty"

const binding: string | { readonly path: string; readonly version: string; readonly sha256: string } | undefined =
  binaryPath

export default binding
