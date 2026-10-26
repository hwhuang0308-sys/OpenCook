import path from "node:path"
import { createRequire } from "node:module"

const require = createRequire(new URL("../../core/package.json", import.meta.url))

export async function writeNotices(directory: string) {
  for (const name of ["LICENSE", "NOTICE"])
    await Bun.write(path.join(directory, name), Bun.file(new URL(`../../../${name}`, import.meta.url)))
  for (const [name, file] of [
    ["serialport", "LICENSE"],
    ["@techstark/opencv-js", "LICENSE"],
    ["@silvia-odwyer/photon-node", "LICENSE.md"],
  ])
    await Bun.write(
      path.join(directory, `LICENSE.${name.replaceAll("/", "-").replaceAll("@", "")}`),
      Bun.file(path.join(path.dirname(require.resolve(`${name}/package.json`)), file)),
    )
}
