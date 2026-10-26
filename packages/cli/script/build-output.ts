import path from "node:path"

export function checkBuildOutput(directory: string, output: string) {
  const relative = path.relative(output, directory)
  if (
    output === path.parse(output).root ||
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
    throw new Error("--outdir must not be the package directory or an ancestor directory")
}
