export * as Host from "./host.js"

import path from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { importModule, resolveModule } from "@opencode/util/runtime-import"

export interface Target {
  readonly directory: string
  readonly name?: string
}

export interface Entrypoints {
  readonly server?: string
  readonly tui?: string
  readonly rpc?: string
}

export function resolve(target: Target): Entrypoints {
  const file = path.join(target.directory, "package.json")
  const manifest: unknown = !target.name && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined
  const pkg = typeof manifest === "object" && manifest !== null ? manifest : undefined
  // A named local package with exports can use native package self-resolution,
  // preserving import conditions and export visibility just like an installed one.
  const name =
    target.name ?? (pkg && "exports" in pkg && "name" in pkg && typeof pkg.name === "string" ? pkg.name : undefined)
  const main = pkg && "main" in pkg && typeof pkg.main === "string" ? pkg.main : "index"
  const entry = (subpaths: readonly string[]) => {
    for (const subpath of subpaths) {
      const specifier = name
        ? [name, subpath].filter(Boolean).join("/")
        : path.resolve(target.directory, subpath || main)
      try {
        return resolveModule(specifier, target.directory)
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          ![
            "ENOENT",
            "ENOTDIR",
            "MODULE_NOT_FOUND",
            "ERR_MODULE_NOT_FOUND",
            "ERR_PACKAGE_PATH_NOT_EXPORTED",
            "ERR_UNSUPPORTED_DIR_IMPORT",
          ].includes(String(error.code))
        )
          throw error
      }
    }
    return undefined
  }
  return {
    server: entry(!name && main !== "index" ? ["server", "", "index"] : ["server", ""]),
    tui: entry(["tui"]),
    rpc: entry(["rpc"]),
  }
}

export function load(entrypoint: string): Promise<unknown> {
  return importModule(entrypoint)
}
