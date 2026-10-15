// Fork-only evidence for the explicit Windows validation request in PR #55779.
import { $ } from "bun"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const [binaryArg, label, outputArg, checkout] = process.argv.slice(2)
const binary = path.resolve(binaryArg)
const output = path.resolve(outputArg)
await fs.mkdir(output, { recursive: true })
const root = await fs.mkdtemp(path.join(os.tmpdir(), `sse-55741-${label}-`))
const project = path.join(root, "project")
await fs.mkdir(project)
const env = Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined))
Object.assign(env, {
  OPENCODE_TEST_HOME: root,
  OPENCODE_PASSWORD: "sse-qa-local-only",
  OPENCODE_DB: path.join(root, "opencode.db"),
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_STATE_HOME: path.join(root, "state"),
  XDG_CACHE_HOME: path.join(root, "cache"),
})
const result = {
  label,
  head: (await $`git -C ${checkout} rev-parse HEAD`.text()).trim(),
  platform: process.platform,
  release: os.release(),
  bun: process.versions.bun,
  curl: undefined,
  tui: { status: "not_started" },
}
let server
let terminal
try {
  if (process.platform !== "win32") throw new Error("This review evidence must run on real Windows")
  server = Bun.spawn([binary, "serve", "--stdio", "--port", "0", "--hostname", "127.0.0.1"], {
    env, cwd: project, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  new Response(server.stderr).text().then((text) => { if (result.error) result.serverStderr = text.slice(-4000) })
  let startup = ""
  let url
  ;(async () => {
    let pending = ""
    for await (const bytes of server.stdout) {
      const chunk = new TextDecoder().decode(bytes)
      startup += chunk
      pending += chunk
      const lines = pending.split("\n")
      pending = lines.pop()
      for (const line of lines) {
        if (!line.startsWith("{")) continue
        const message = JSON.parse(line)
        if (message.url) url = message.url
      }
    }
  })()
  const deadline = Date.now() + 60_000
  while (!url && Date.now() < deadline && server.exitCode === null) await Bun.sleep(100)
  if (!url) throw new Error(`Server did not report ready: ${startup.slice(-2000)}`)
  const authorization = `Authorization: Basic ${btoa("opencode:sse-qa-local-only")}`
  const info = Bun.spawn(["curl.exe", "--silent", "--show-error", "--max-time", "10", "-H", authorization,
    "--write-out", "\nINFO_TIME_STARTTRANSFER=%{time_starttransfer}\n", `${url}/api/info`], { stdout: "pipe", stderr: "pipe" })
  result.infoCurl = await new Response(info.stdout).text()
  result.infoCurlExit = await info.exited
  const started = performance.now()
  const curl = Bun.spawn(["curl.exe", "-N", "--silent", "--show-error", "--max-time", "18", "-H", authorization,
    "--write-out", "\nCURL_TIME_STARTTRANSFER=%{time_starttransfer}\n", `${url}/api/event`], { stdout: "pipe", stderr: "pipe" })
  const curlError = new Response(curl.stderr).text()
  let received = ""
  let firstBodyMs
  let connectedFrameMs
  for await (const bytes of curl.stdout) {
    const chunk = new TextDecoder().decode(bytes)
    received += chunk
    if (firstBodyMs === undefined && !chunk.startsWith("\nCURL_TIME_STARTTRANSFER=")) firstBodyMs = performance.now() - started
    if (connectedFrameMs === undefined && /"type"\s*:\s*"server.connected"/.test(received) && received.includes("\n\n"))
      connectedFrameMs = performance.now() - started
  }
  result.curl = {
    firstBodyMs, connectedFrameMs,
    headerTimeStartTransferSeconds: received.match(/CURL_TIME_STARTTRANSFER=([\d.]+)/)?.[1],
    exit: await curl.exited,
    stderr: await curlError,
    connectedWithinClientDeadline: connectedFrameMs !== undefined && connectedFrameMs < 2_000,
    note: "18s curl timeout is expected for a live SSE stream; frame timing is independent of header timing",
  }
  await fs.writeFile(path.join(output, `${label}-curl.txt`), received)
  try {
    // Use the repository's installed real ConPTY-capable dependency, not a copied UI.
    const require = createRequire(path.join(checkout, "packages/core/package.json"))
    const { spawn } = require("bun-pty")
    const tuiStarted = performance.now()
    let rendered = ""
    let exited
    terminal = spawn(binary, ["--server", url, project], { name: "xterm-256color", cols: 120, rows: 40, cwd: project, env })
    terminal.onData((data) => { rendered = (rendered + data).slice(-60_000) })
    terminal.onExit((event) => { exited = event })
    let logs = ""
    let connectedObservedMs
    const logdir = path.join(root, "data", "opencode", "log")
    const limit = Date.now() + 25_000
    while (Date.now() < limit && !exited) {
      const names = await fs.readdir(logdir).catch(() => [])
      logs = (await Promise.all(names.filter((name) => name.endsWith(".log")).map((name) => fs.readFile(path.join(logdir, name), "utf8").catch(() => "")))).join("\n")
      if (logs.includes("event stream connected")) {
        connectedObservedMs = performance.now() - tuiStarted
        break
      }
      await Bun.sleep(100)
    }
    result.tui = {
      status: connectedObservedMs === undefined ? "connection_not_observed" : "connection_observed",
      firstObservedConnectedLogMs: connectedObservedMs,
      connectingLogCount: (logs.match(/event stream connecting/g) ?? []).length,
      timeoutLogCount: (logs.match(/Timed out connecting to server/g) ?? []).length,
      renderedBytes: Buffer.byteLength(rendered),
      exit: exited,
      note: "Real compiled TUI launched in ConPTY; log observation includes startup and 100ms polling, not a human visual/usability review",
    }
    await fs.writeFile(path.join(output, `${label}-tui-client-lines.txt`), logs.split("\n").filter((line) => line.includes("event stream ") || line.includes("Timed out connecting to server")).join("\n"))
    await fs.writeFile(path.join(output, `${label}-tui-output.txt`), rendered)
  } catch (error) {
    result.tui = { status: "ConPTY_startup_failed", error: String(error) }
  }
  if (result.curl.connectedFrameMs === undefined) throw new Error("No connected SSE frame observed in 18 seconds")
} catch (error) {
  result.error = String(error)
  process.exitCode = 1
} finally {
  if (terminal) { try { terminal.kill() } catch {} }
  if (server) {
    server.stdin.end()
    await Promise.race([server.exited, Bun.sleep(5_000)])
    if (server.exitCode === null) server.kill()
    await server.exited
  }
  await fs.writeFile(path.join(output, `${label}-summary.json`), JSON.stringify(result, null, 2) + "\n")
  console.log(JSON.stringify(result, null, 2))
}
