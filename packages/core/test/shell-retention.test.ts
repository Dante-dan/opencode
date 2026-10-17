import { expect } from "bun:test"
import { existsSync } from "node:fs"
import { ToolOutput } from "@opencode/core/tool-output"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Deferred, Effect, Fiber, Layer, Queue, Scope, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { ExitCode, makeHandle, ProcessId } from "effect/process/ChildProcessSpawner"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Shell } from "@opencode/core/shell"
import { Workspace } from "@opencode/core/workspace"
import { Global } from "@opencode/util/global"
import { hostEnvironmentLayer } from "./fixture/environment"
import { tempGlobalLayer } from "./fixture/global"
import { location, tempLocationLayer } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

it.live("eviction makes progress past an already-removed shell", () =>
  Effect.gen(function* () {
    const completions = yield* Queue.unbounded<Effect.Effect<void>>()
    const environment = Layer.effect(
      Environment.Service,
      Effect.gen(function* () {
        const host = yield* Environment.Service
        const scope = yield* Scope.Scope
        return Environment.Service.of({
          ...host,
          spawner: ChildProcessSpawner.make((invocation) =>
            Effect.gen(function* () {
              const exited = yield* Deferred.make<ExitCode>()
              const observer = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>()
              yield* Queue.offer(
                completions,
                Effect.gen(function* () {
                  yield* Deferred.succeed(exited, ExitCode(0))
                  // Shell.wait resolves before retention runs; join the whole exit handler instead.
                  const fiber = yield* Deferred.await(observer)
                  yield* Fiber.join(fiber).pipe(Effect.orDie)
                }),
              )
              const output = Stream.succeed(Buffer.from("hello")).pipe(
                Stream.concat(
                  invocation._tag === "StandardCommand" && invocation.args.includes("removed")
                    ? Stream.never
                    : Stream.empty,
                ),
              )
              return makeHandle({
                pid: ProcessId(1),
                exitCode: Effect.withFiber((fiber) =>
                  Scope.addFinalizer(scope, Fiber.interrupt(fiber)).pipe(
                    Effect.andThen(Deferred.succeed(observer, fiber)),
                    Effect.andThen(Deferred.await(exited)),
                  ),
                ),
                isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
                kill: () => Deferred.succeed(exited, ExitCode(0)).pipe(Effect.asVoid),
                stdin: Sink.drain,
                stdout: output,
                stderr: Stream.empty,
                all: output,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
                unref: Effect.succeed(Effect.void),
              })
            }),
          ),
        })
      }),
    ).pipe(Layer.provide(hostEnvironmentLayer))

    yield* Effect.gen(function* () {
      const shell = yield* Shell.Service
      const removed = yield* shell.create({ shell: "sh", command: "removed", timeout: 0 })
      const finishRemoved = yield* Queue.take(completions)
      yield* shell.remove(removed.id)
      expect((yield* shell.result(removed)).capture).toBeUndefined()
      yield* finishRemoved

      const complete = Effect.gen(function* () {
        const info = yield* shell.create({ shell: "sh", command: "hello", timeout: 0 })
        const finish = yield* Queue.take(completions)
        yield* finish
        return info
      })
      const oldest = yield* complete
      // Exceed the 25-entry retention cap with the removed ID at the head of exitOrder.
      yield* Effect.forEach(Array.from({ length: 25 }), () => complete, { discard: true })
      expect(yield* shell.get(oldest.id).pipe(Effect.flip)).toBeInstanceOf(Shell.NotFoundError)

      const survivor = yield* complete
      expect(yield* shell.result(survivor)).toMatchObject({
        info: { status: "exited", exit: 0 },
        capture: { output: "hello", truncated: false },
      })
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(Shell.node, [
          Location.node.replace(tempLocationLayer),
          Global.node.replace(tempGlobalLayer),
          Config.node.replace(Config.testLayer()),
          Environment.node.replace(environment),
        ]),
      ),
    )
  }),
)

it.live("does not inherit host process.env when creating a shell in a workspace-backed location", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    let capturedEnv: Record<string, string | undefined> | undefined
    yield* Effect.gen(function* () {
      const shell = yield* Shell.Service
      const info = yield* shell.create({ shell: "/bin/sh", command: "printf ok", timeout: 0 }, (invocation) =>
        Effect.sync(() => {
          capturedEnv = { ...invocation.env }
        }),
      )
      expect(yield* shell.result(info)).toMatchObject({
        info: { status: "exited" },
      })
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(Shell.node, [
          Location.node.replace(
            Layer.succeed(
              Location.Service,
              Location.Service.of(
                location(
                  Location.Ref.make({
                    directory: AbsolutePath.make(tmp.path),
                    workspaceID: Workspace.ID.make("wrk_workspace"),
                  }),
                ),
              ),
            ),
          ),
          Global.node.replace(tempGlobalLayer),
          Config.node.replace(Config.testLayer()),
          Environment.node.replace(hostEnvironmentLayer),
        ]),
      ),
    )

    expect(process.env.PATH).toBeDefined()
    expect(capturedEnv).toEqual({
      TERM: "xterm-256color",
      OPENCODE_TERMINAL: "1",
    })
  }),
)

it.live("keeps large shell and tool output in the workspace filesystem and honors its temporary storage", () =>
  Effect.gen(function* () {
    const memory = Environment.makeMemoryDriver()
    const temporary: string[] = []
    const storage = Environment.makeFiles(memory)
    const files = Environment.makeFiles({
      ...memory,
      overrides: {
        ...memory.overrides,
        stat: (file) =>
          storage.stat(file).pipe(
            Effect.map((info) => ({
              ...info,
              mtimeMs: file.endsWith(".expired")
                ? Date.now() - 8 * 24 * 60 * 60 * 1_000
                : file.endsWith(".epoch")
                  ? 0
                  : info.mtimeMs,
            })),
          ),
        tempDirectory: Effect.sync(() => {
          temporary.push("requested")
          return "/workspace/output-cache"
        }),
      },
    })
    const bytes = Buffer.from("123456789\n".repeat(200_000))
    const output = Stream.fromIterable([bytes.subarray(0, 100), bytes.subarray(100)])
    const environment = Layer.succeed(
      Environment.Service,
      Environment.Service.of({
        files,
        spawner: ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeHandle({
              pid: ProcessId(1),
              exitCode: Effect.succeed(ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: output,
              stderr: Stream.empty,
              all: output,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            }),
          ),
        ),
      }),
    )
    yield* Effect.gen(function* () {
      const shell = yield* Shell.Service
      const tool = yield* ToolOutput.Service
      yield* tool.truncate({ content: [{ type: "text", text: "small output" }] })
      expect(temporary).toEqual([])
      const info = yield* shell.create({ shell: "sh", command: "large output", timeout: 0 })
      const result = yield* shell.result(info)
      expect(result.capture?.truncated).toBe(true)
      expect(info.file.startsWith("/workspace/output-cache/")).toBe(true)
      expect(existsSync(info.file)).toBe(false)
      expect((yield* files.stat(info.file)).size).toBe(bytes.length)
      expect(Buffer.from((yield* files.read(info.file)).bytes)).toEqual(bytes)
      expect(yield* shell.output(info.id, { cursor: 98, limit: 5 })).toMatchObject({
        output: bytes.subarray(98, 103).toString(),
        cursor: 103,
        size: bytes.length,
      })
      const truncated = yield* tool.truncate({ content: [{ type: "text", text: bytes.toString() }] })
      const file = truncated.metadata?.outputPath
      expect(typeof file).toBe("string")
      if (typeof file !== "string") return
      expect(file.startsWith("/workspace/output-cache/")).toBe(true)
      expect(existsSync(file)).toBe(false)
      expect(Buffer.from((yield* files.read(file)).bytes)).toEqual(bytes)
      yield* files.write(file + ".expired", bytes)
      yield* files.write(file + ".epoch", bytes)
      yield* tool.cleanup()
      expect(yield* files.stat(file + ".expired").pipe(Effect.flip)).toBeInstanceOf(Environment.NotFound)
      expect((yield* files.stat(file + ".epoch")).size).toBe(bytes.length)
      expect((yield* files.stat(file)).size).toBe(bytes.length)
      yield* shell.remove(info.id)
      expect(yield* files.stat(info.file).pipe(Effect.flip)).toBeInstanceOf(Environment.NotFound)
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Shell.node, ToolOutput.node]), [
          Location.node.replace(
            Layer.succeed(
              Location.Service,
              Location.Service.of(
                location(
                  Location.Ref.make({
                    directory: AbsolutePath.make("/workspace"),
                    workspaceID: Workspace.ID.make("wrk_output"),
                  }),
                ),
              ),
            ),
          ),
          Global.node.replace(tempGlobalLayer),
          Config.node.replace(Config.testLayer()),
          Environment.node.replace(environment),
        ]),
      ),
    )
  }),
)
