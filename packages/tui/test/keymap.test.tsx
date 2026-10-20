/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { CliRenderEvents } from "@opentui/core"
import { expect, test } from "bun:test"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

test.each([CliRenderEvents.BLUR, CliRenderEvents.FOCUS])("terminal %s clears pending key sequences", async (event) => {
  const calls: string[] = []
  let pending = () => [] as readonly unknown[]

  function Harness() {
    pending = Keymap.usePendingSequence()
    Keymap.createLayer(() => ({
      commands: [
        { id: "demo.sequence", bind: "gg", run: () => void calls.push("sequence") },
        { id: "demo.leader", bind: "<leader>x", run: () => void calls.push("leader") },
      ],
    }))
    return <box />
  }

  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig()}>
        <Keymap.Provider>
          <Harness />
        </Keymap.Provider>
      </ConfigProvider>
    ),
    { width: 80, height: 24, kittyKeyboard: true },
  )
  try {
    app.mockInput.pressKey("g")
    expect(pending()).toHaveLength(1)
    app.renderer.emit(event)
    expect(pending()).toHaveLength(0)
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("x")
    expect(calls).toEqual(["leader"])

    app.mockInput.pressKey("x", { ctrl: true })
    expect(pending()).toHaveLength(1)
    app.renderer.emit(event)
    expect(pending()).toHaveLength(0)
    app.mockInput.pressKey("g")
    app.mockInput.pressKey("g")
    expect(calls).toEqual(["leader", "sequence"])
  } finally {
    app.renderer.destroy()
  }
})

test("legacy page key aliases compile as page keys", async () => {
  let read = () => ({ up: "", down: "" })

  function Harness() {
    const shortcuts = Keymap.useShortcuts()
    Keymap.createLayer(() => ({
      commands: [
        { id: "session.page.up", run() {} },
        { id: "session.page.down", run() {} },
      ],
    }))
    read = () => ({
      up: shortcuts.get("session.page.up") ?? "",
      down: shortcuts.get("session.page.down") ?? "",
    })
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider
      config={createTuiResolvedConfig({
        keybinds: {
          "session.page.up": "pgup",
          "session.page.down": "pgdown",
        },
      })}
    >
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    expect(read()).toEqual({ up: "pgup", down: "pgdn" })
  } finally {
    app.renderer.destroy()
  }
})

test("formats navigation keys as arrows", async () => {
  let read = () => ({}) as Record<string, string>
  const commands = ["session.parent", "session.child.first"]

  function Harness() {
    const shortcuts = Keymap.useShortcuts()
    Keymap.createLayer(() => ({
      commands: commands.map((id) => ({ id, run() {} })),
    }))
    read = () => Object.fromEntries(commands.map((id) => [id, shortcuts.get(id) ?? ""]))
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    expect(read()).toEqual({
      "session.parent": "↑",
      "session.child.first": "↓",
    })
  } finally {
    app.renderer.destroy()
  }
})

test("returns every formatted command shortcut", async () => {
  let read = () => [] as readonly string[]

  function Harness() {
    const shortcuts = Keymap.useShortcuts()
    Keymap.createLayer(() => ({
      commands: [{ id: "demo.command", bind: "x,y", run() {} }],
    }))
    read = () => shortcuts.list("demo.command")
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    expect(read()).toEqual(["x", "y"])
  } finally {
    app.renderer.destroy()
  }
})

test("global commands stay reachable when the mode changes", async () => {
  const calls: string[] = []
  let exercise = () => {}

  function Harness() {
    const keymap = Keymap.use()
    Keymap.createLayer(() => ({
      mode: "global",
      commands: [{ id: "session.list", run: () => void calls.push("global") }],
    }))
    Keymap.createLayer(() => ({
      commands: [{ id: "model.list", run: () => void calls.push("base") }],
    }))

    exercise = () => {
      keymap.dispatch("session.list")
      keymap.dispatch("model.list")
      const pop = keymap.mode.push("question")
      keymap.dispatch("session.list")
      keymap.dispatch("model.list")
      pop()
    }
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    exercise()
    expect(calls).toEqual(["global", "base", "global"])
  } finally {
    app.renderer.destroy()
  }
})
