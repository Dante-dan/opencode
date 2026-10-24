// Windows-only probe for the unintegrated native reference; not OpenCode QA.
const assert = require("node:assert/strict")
const { spawn, spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

if (process.argv[2] === "descendant") {
  process.send("ready")
  setInterval(() => {}, 1000)
} else if (process.argv[2] === "foreground") {
  const child = spawn(process.execPath, [__filename, "descendant"], {
    // Explicitly exercise Node's detached flag: it does not escape the Job.
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  })
  child.once("message", () => {
    fs.writeFileSync(process.argv[3], String(child.pid))
    child.disconnect()
    child.unref()
    process.stdout.write("foreground-out\n")
    process.stderr.write("foreground-err\n")
    process.exit(Number(process.argv[4]))
  })
} else {
  async function main() {
    assert.equal(process.platform, "win32", "requires a real Windows host")
    const helper = path.resolve(process.argv[2])
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-job-reference-"))
    const alive = (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        if (error.code === "ESRCH") return false
        throw error
      }
    }
    try {
      for (const code of [42, 0]) {
        const pidFile = path.join(dir, `child-${code}.pid`)
        let pid
        try {
          const result = spawnSync(helper, [process.execPath, __filename, "foreground", pidFile, String(code)], {
            encoding: "utf8",
            timeout: 15000,
          })
          assert.ifError(result.error)
          assert.equal(result.status, code, result.stderr)
          assert.equal(result.stdout, "foreground-out\n")
          assert.equal(result.stderr, "foreground-err\n")
          pid = Number(fs.readFileSync(pidFile, "utf8"))
          if (code === 42) {
            const end = Date.now() + 5000
            while (alive(pid) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20))
            assert.equal(alive(pid), false, "nonzero exit must terminate descendants")
          } else {
            assert.equal(alive(pid), true, "successful exit must preserve descendants")
          }
          console.log(
            `exit ${code}: descendant ${code === 0 ? "preserved" : "terminated"}; Node detached remains contained`,
          )
        } finally {
          if (!pid && fs.existsSync(pidFile)) pid = Number(fs.readFileSync(pidFile, "utf8"))
          if (pid && alive(pid)) process.kill(pid)
        }
      }
      const args = ["", "space here", 'embedded"quote', "trailing\\", "space and slash\\", "雪"]
      const roundtrip = spawnSync(
        helper,
        [process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", ...args],
        {
          encoding: "utf8",
          timeout: 15000,
        },
      )
      assert.ifError(roundtrip.error)
      assert.equal(roundtrip.status, 0, roundtrip.stderr)
      assert.deepEqual(JSON.parse(roundtrip.stdout), args)
      console.log("argv: empty, spaces, quotes, backslashes and Unicode preserved")
      const missing = spawnSync(helper, [path.join(dir, "missing.exe")], { encoding: "utf8", timeout: 15000 })
      assert.ifError(missing.error)
      assert.equal(missing.status, 125)
      assert.match(missing.stderr, /Win32 error/)
      console.log("spawn failure: reported without starting target")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
