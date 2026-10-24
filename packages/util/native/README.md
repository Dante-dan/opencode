# Windows failed-command launcher reference

This is an **unintegrated reference for #57813**, not an OpenCode fix or a published binary. `CrossSpawnSpawner` does not call it. No Windows execution result is implied by the source.

The launcher takes an absolute executable path and argv, inherits cwd/environment and standard streams, waits for the foreground process, and terminates its per-command Job after a nonzero exit. `PROC_THREAD_ATTRIBUTE_JOB_LIST` attaches the Job during `CreateProcessW` on Windows 10+, removing the suspended-create/assignment/resume gap. No host process is placed in the Job. Explicit handle inheritance excludes unrelated handles.

The Job has `BREAKAWAY_OK`, but neither `SILENT_BREAKAWAY_OK` nor `KILL_ON_JOB_CLOSE`. A successful command and launcher/server death leave surviving descendants alone. A native descendant requesting `CREATE_BREAKAWAY_FROM_JOB` can escape. Node/libuv `detached: true` does **not** request this flag, so a detached Node grandchild would still be contained. This differs from POSIX process-group detachment and must not be described as equivalent behavior.

Build with a Windows SDK C compiler, or cross-compile from macOS:

```sh
zig cc -target x86_64-windows-gnu -std=c11 -Wall -Wextra -Werror -municode windows-job-launch.c -o windows-job-launch.exe
```

No generated executable should be committed.

Remaining integration work:

- Preserve `cross-spawn` executable resolution, `.cmd` quoting and shell semantics before invoking the helper; these are not handled here.
- Define the observable process PID and cancellation contract: the helper stays alive until foreground exit, while the current handle represents the command itself. This reference does not implement scoped cancellation or an asynchronous control protocol.
- Carry additional CRT descriptors / `additionalFds`, which are currently unsupported; only stdin/stdout/stderr are forwarded.
- Package signed/traceable x64 and arm64 helper artifacts for both Node and Bun CLI distributions; the current FFF-specific `ffi-rs` loader is not a general native-process interface.
- Adapt the repository's existing `cross-spawn-spawner` tests to cover failed-command descendants while preserving successful-exit capture, explicit detachment, pipelines, environment, `.cmd` and cancellation behavior. The current held-stdio fixture intentionally spawns a detached child and exits successfully; it cannot be counted as failed-command coverage.

Sources: [Microsoft process attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute), [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), and [libuv Windows process implementation](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c).
