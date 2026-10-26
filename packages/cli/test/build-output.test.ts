import { expect, test } from "bun:test"
import path from "node:path"
import { checkBuildOutput } from "../script/build-output"

const root = path.parse(process.cwd()).root
const directory = path.join(root, "project", "packages", "cli")

test.each([directory, path.dirname(directory), path.join(root, "project"), root])(
  "rejects a destructive build destination: %s",
  (output) => expect(() => checkBuildOutput(directory, output)).toThrow("ancestor directory"),
)

test.each([path.join(directory, "dist"), path.join(root, "project-artifacts")])(
  "accepts an independent build destination: %s",
  (output) => expect(() => checkBuildOutput(directory, output)).not.toThrow(),
)
