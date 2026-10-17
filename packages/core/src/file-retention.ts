export * as FileRetention from "./file-retention.js"

import { Duration, Effect, Option } from "effect"
import { Environment } from "./environment/index.js"
import path from "node:path"
import { FSUtil } from "@opencode/util/fs-util"

export const cleanup = Effect.fn("FileRetention.cleanup")(function* (
  fs: FSUtil.Interface,
  files: ReadonlyArray<string>,
  retention: Duration.Input,
) {
  const cutoff = Date.now() - Duration.toMillis(retention)
  yield* Effect.forEach(
    files,
    (file) =>
      Effect.gen(function* () {
        const info = yield* fs.stat(file).pipe(Effect.orElseSucceed(() => undefined))
        const mtime = info && Option.getOrUndefined(info.mtime)
        if (!mtime || mtime.getTime() >= cutoff) return
        yield* fs.remove(file).pipe(Effect.ignore)
      }),
    { concurrency: 8, discard: true },
  )
})

/** Sweep output in its owning execution environment, including remote workspaces. */
export const cleanupEnvironment = Effect.fn("FileRetention.cleanupEnvironment")(function* (
  files: Environment.Files,
  directory: string,
  retention: Duration.Input,
) {
  const cutoff = Date.now() - Duration.toMillis(retention)
  const entries = yield* files.list(directory).pipe(Effect.orElseSucceed(() => []))
  yield* Effect.forEach(
    entries.filter((entry) => entry.type === "file"),
    (entry) =>
      Effect.gen(function* () {
        const file = path.join(directory, entry.name)
        const info = yield* files.stat(file).pipe(Effect.orElseSucceed(() => undefined))
        if (!info || info.mtimeMs <= 0 || info.mtimeMs >= cutoff) return
        yield* files.remove(file).pipe(Effect.ignore)
      }),
    { concurrency: 8, discard: true },
  )
})
