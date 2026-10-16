export * as SkillFile from "./skill-file.js"

import path from "path"
import { Effect, Result, Schema, type SchemaIssue, SchemaParser } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { ConfigMarkdown } from "../markdown.js"
import { AbsolutePath } from "../../schema.js"
import { Skill } from "../../skill.js"

const Frontmatter = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  metadata: Schema.Unknown.pipe(Schema.optional),
  "disable-model-invocation": Schema.Unknown.pipe(Schema.optional),
})
const decodeFrontmatter = SchemaParser.decodeUnknownResult(Frontmatter)

export type ParseResult =
  | { readonly _tag: "Parsed"; readonly skill: Skill.Info }
  | { readonly _tag: "Skipped"; readonly reason: "markdown" }
  | { readonly _tag: "Skipped"; readonly reason: "frontmatter"; readonly issue: SchemaIssue.Issue }

const metadataBoolean = (metadata: unknown, key: string) => {
  if (metadata === undefined || metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined
  }
  return booleanValue((metadata as Record<string, unknown>)[key])
}

const booleanValue = (value: unknown) => {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined
  if (typeof value !== "string") return undefined
  const normalized = value.trim().toLowerCase()
  if (["true", "yes", "on", "1"].includes(normalized)) return true
  if (["false", "no", "off", "0"].includes(normalized)) return false
  return undefined
}

export function parse(directory: string, filepath: string, content: string): ParseResult {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return { _tag: "Skipped", reason: "markdown" }
  const decoded = decodeFrontmatter(markdown.data)
  if (Result.isFailure(decoded)) return { _tag: "Skipped", reason: "frontmatter", issue: decoded.failure }
  const frontmatter = decoded.success
  const id =
    path.dirname(filepath) === directory && path.basename(filepath) !== "SKILL.md"
      ? path.basename(filepath, ".md")
      : path.basename(path.dirname(filepath))
  const opencodeAutoinvoke = metadataBoolean(frontmatter.metadata, "opencode/autoinvoke")
  const disableModelInvocation = booleanValue(frontmatter["disable-model-invocation"])
  const autoinvoke = opencodeAutoinvoke ?? (disableModelInvocation ? false : undefined)
  return {
    _tag: "Parsed",
    skill: {
      id: Skill.ID.make(id),
      name: Skill.Name.make(frontmatter.name ?? id),
      ...(frontmatter.description === undefined ? {} : { description: frontmatter.description }),
      ...(autoinvoke === undefined ? {} : { autoinvoke }),
      path: AbsolutePath.make(filepath),
      content: markdown.content,
    },
  }
}

// Follow symlinked skills, but never expand the same physical directory twice.
export const scan = Effect.fn("SkillFile.scan")(function* (fs: FSUtil.Interface, directory: string) {
  const pending = [directory]
  const visited = new Set<string>()
  const files: string[] = []
  while (pending.length > 0) {
    const current = pending.pop()!
    const resolved = yield* fs.realPath(current).pipe(Effect.orElseSucceed(() => undefined))
    if (!resolved || visited.has(resolved)) continue
    visited.add(resolved)
    const entries = yield* fs.readDirectoryEntries(current).pipe(Effect.orElseSucceed(() => []))
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const filepath = path.join(current, entry.name)
      const type =
        entry.type === "symlink"
          ? (yield* fs.stat(filepath).pipe(Effect.orElseSucceed(() => undefined)))?.type
          : entry.type === "directory"
            ? "Directory"
            : entry.type === "file"
              ? "File"
              : undefined
      if (type === "Directory") pending.push(filepath)
      if (type === "File" && (entry.name === "SKILL.md" || (current === directory && entry.name.endsWith(".md")))) {
        files.push(filepath)
      }
    }
  }
  return files
})
