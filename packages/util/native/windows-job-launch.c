// Reference launcher for #57813. Not connected to CrossSpawnSpawner or shipped.
// Requires Windows 10+: JOB_LIST associates the child during CreateProcessW,
// before any target code executes, without a suspended/unassigned interval.
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

// Quote an argv element using the Windows C runtime's backslash/quote rules.
// The caller supplies an absolute executable path, not shell source or a .cmd.
static WCHAR *quote(WCHAR *out, const WCHAR *arg) {
  *out++ = L'"';
  for (;;) {
    size_t slashes = 0;
    while (*arg == L'\\') {
      slashes++;
      arg++;
    }
    const size_t count = (*arg == L'"' || *arg == L'\0') ? slashes * 2 : slashes;
    for (size_t n = 0; n < count; n++) *out++ = L'\\';
    if (*arg == L'\0') break;
    if (*arg == L'"') *out++ = L'\\';
    *out++ = *arg++;
  }
  *out++ = L'"';
  return out;
}

int wmain(int argc, WCHAR **argv) {
  if (argc < 2) {
    fputws(L"usage: windows-job-launch.exe <absolute executable> [args...]\n", stderr);
    return 125;
  }

  DWORD error = ERROR_SUCCESS;
  DWORD code = 125;
  HANDLE job = NULL;
  HANDLE handles[3] = {NULL, NULL, NULL};
  PROCESS_INFORMATION child = {0};
  STARTUPINFOEXW startup = {0};
  BOOL initialized = FALSE;
  WCHAR *command = NULL;
  const HANDLE self = GetCurrentProcess();
  const DWORD ids[3] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
  SIZE_T bytes = 0;
  size_t length = 1;

  // CreateProcessW accepts at most 32,767 characters including its terminator.
  for (int n = 1; n < argc; n++) {
    const size_t size = wcslen(argv[n]);
    if (size > 16382 || length > 32767 - (size * 2 + 3)) {
      error = ERROR_BAD_LENGTH;
      goto cleanup;
    }
    length += size * 2 + 3;
  }
  command = calloc(length, sizeof(WCHAR));
  if (!command) {
    error = ERROR_NOT_ENOUGH_MEMORY;
    goto cleanup;
  }
  WCHAR *out = command;
  for (int n = 1; n < argc; n++) {
    if (n > 1) *out++ = L' ';
    out = quote(out, argv[n]);
  }
  *out = L'\0';

  job = CreateJobObjectW(NULL, NULL);
  if (!job) {
    error = GetLastError();
    goto cleanup;
  }
  // No SILENT_BREAKAWAY_OK and no KILL_ON_JOB_CLOSE: success and launcher death
  // preserve survivors. Only an observed failed command terminates this Job.
  // Explicit CREATE_BREAKAWAY_FROM_JOB remains available to native descendants.
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    error = GetLastError();
    goto cleanup;
  }
  for (size_t n = 0; n < 3; n++) {
    if (!DuplicateHandle(self, GetStdHandle(ids[n]), self, &handles[n], 0, TRUE, DUPLICATE_SAME_ACCESS)) {
      error = GetLastError();
      goto cleanup;
    }
  }

  InitializeProcThreadAttributeList(NULL, 2, 0, &bytes);
  startup.lpAttributeList = HeapAlloc(GetProcessHeap(), 0, bytes);
  if (!startup.lpAttributeList) {
    error = ERROR_NOT_ENOUGH_MEMORY;
    goto cleanup;
  }
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 2, 0, &bytes)) {
    error = GetLastError();
    goto cleanup;
  }
  initialized = TRUE;
  if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                                 &job, sizeof(job), NULL, NULL) ||
      !UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                 handles, sizeof(handles), NULL, NULL)) {
    error = GetLastError();
    goto cleanup;
  }
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = handles[0];
  startup.StartupInfo.hStdOutput = handles[1];
  startup.StartupInfo.hStdError = handles[2];
  // The executable is explicit, avoiding CreateProcess's ambiguous unquoted-path
  // search. The caller owns PATH/.cmd/shell resolution before using this helper.
  if (!CreateProcessW(argv[1], command, NULL, NULL, TRUE, EXTENDED_STARTUPINFO_PRESENT,
                      NULL, NULL, &startup.StartupInfo, &child)) {
    error = GetLastError();
    goto cleanup;
  }
  CloseHandle(child.hThread);
  child.hThread = NULL;
  // Do not retain duplicate pipe writers while waiting for the foreground exit.
  for (size_t n = 0; n < 3; n++) {
    CloseHandle(handles[n]);
    handles[n] = NULL;
  }
  if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0 ||
      !GetExitCodeProcess(child.hProcess, &code)) {
    error = GetLastError();
    TerminateJobObject(job, 125);
    goto cleanup;
  }
  if (code != 0 && !TerminateJobObject(job, code)) error = GetLastError();

cleanup:
  if (initialized) DeleteProcThreadAttributeList(startup.lpAttributeList);
  if (startup.lpAttributeList) HeapFree(GetProcessHeap(), 0, startup.lpAttributeList);
  for (size_t n = 0; n < 3; n++) if (handles[n]) CloseHandle(handles[n]);
  if (child.hThread) CloseHandle(child.hThread);
  if (child.hProcess) CloseHandle(child.hProcess);
  if (job) CloseHandle(job);
  free(command);
  if (error != ERROR_SUCCESS) {
    fwprintf(stderr, L"windows-job-launch: Win32 error %lu\n", (unsigned long)error);
    return 125;
  }
  ExitProcess(code);
}
