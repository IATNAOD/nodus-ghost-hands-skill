# GhostHelper

Native Windows helper for the **Ghost Hands** Electron client. It performs the
privileged / native desktop operations that are awkward from Node.js: audio
volume, window enumeration and focus, process management, power/display actions,
Start-menu app listing, registry reads, NIC info, and file version info.

The Electron main process spawns `GhostHelper.exe`, writes JSON requests to its
**stdin**, and reads JSON responses/events from its **stdout** (JSON Lines).

- Target: **.NET Framework 4.8**, `WinExe` (no console window), AnyCPU (runs
  64-bit on 64-bit Windows).
- No runtime NuGet dependencies. JSON is handled by a tiny built-in
  serializer/parser (`Json.cs`); audio uses direct Core Audio COM interop.

---

## Build

```powershell
# From client\helper
./build-helper.ps1
```

This runs `dotnet build -c Release` and copies the result to
`..\resources\helper\GhostHelper.exe`. It exits non-zero on any failure.

The project references `Microsoft.NETFramework.ReferenceAssemblies` as a
**build-only** package (`PrivateAssets="all"`) so `dotnet build` can target
net48. It is not a runtime dependency and is not shipped.

Direct build is also fine:

```powershell
dotnet build -c Release GhostHelper.csproj
# output: bin\Release\GhostHelper.exe
```

### `-UseCsc` fallback — not supported

`build-helper.ps1 -UseCsc` is wired up but intentionally refuses: the in-box
compiler `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` only
understands **C# 5**, while this code uses C# 7+ features (pattern matching,
`out var`, expression-bodied members, tuple/indexer initializers). Build with
the .NET SDK (`dotnet build`) instead.

---

## Test

```powershell
./test-helper.ps1
```

Launches the helper, sends a set of **safe, read-only** commands (`ping`,
`selftest`, `volume.get`, `windows.list`, `startapps.list`, `registry.read`,
`nic.info`, `process.list` under `C:\Windows`), plus an unknown-command and a
malformed-JSON robustness check. Prints a pass/fail summary and exits 0 when all
checks pass. It never changes volume, never closes/kills other processes, and
never locks/sleeps the PC or turns the display off.

CLI self-test (one JSON line, exit 0/1):

```powershell
./bin/Release/GhostHelper.exe selftest
# {"version":"1.0.0","audio":true,"windows":4,"startapps":336,"registry":true,"nic":7}
```

---

## Protocol

### Startup / lifetime

- `GhostHelper.exe --parent <pid>` — run as a child: exit when the parent
  process dies (waits on the parent handle) **or** stdin is closed.
- `GhostHelper.exe` (no args) — same loop, without the parent-death check.
- `GhostHelper.exe selftest` — run the self-test, print one JSON line, exit
  `0` (healthy) or `1`.

### Framing

- stdin/stdout are **UTF-8 without BOM**, **JSON Lines** (one JSON object per
  line, `\n`-terminated).
- Request: `{"id": <number>, "cmd": "<name>", "args": { ... }}`
- Success: `{"id": <same>, "ok": true, "data": <any>}`
- Error:   `{"id": <same>, "ok": false, "code": "<kebab-case>", "message": "<text>"}`
- Unsolicited event: `{"event": "<name>", "data": <any>}`

Rules:
- Each request is handled on its own task, so a slow command (e.g.
  `process.close`) never blocks others.
- COM calls that require STA (Shell.Application) run on a dedicated STA thread.
- Malformed JSON → `{"ok":false,"code":"bad-request","id":null}`. Unknown
  command → `code:"unknown-command"`. Any command exception →
  `code:"internal"`. The process never dies from a bad request.
- Logs go to **stderr** only.

Error codes used: `bad-request`, `unknown-command`, `invalid-args`,
`internal`, `no-audio-device`, `not-found`, `cancelled`, `launch-failed`,
and per-pid kill codes `access-denied` / `not-found` / `protected`.

---

## Commands

| cmd | args | data |
|---|---|---|
| `ping` | — | `{version, pid}` |
| `selftest` | — | `{version, audio, windows, startapps, registry, nic}` (changes nothing) |
| `volume.get` | — | `{level:0..100, muted:bool}` |
| `volume.set` | `{level}` | `{level, muted}` |
| `volume.change` | `{delta}` | `{level, muted}` (clamped 0..100; `delta>0` unmutes) |
| `volume.mute` | `{muted:bool}` | `{level, muted}` |
| `media.key` | `{key}` | `{}` — key ∈ `play_pause|next|prev|stop` (SendInput) |
| `windows.list` | — | `[{pid, exe, name, product, description, aumid, foreground, fullscreen}]` |
| `windows.watch` | `{intervalMs:2000}` | `{}` then `{"event":"windows","data":[...]}` on change (first snapshot immediately) |
| `windows.unwatch` | — | `{}` |
| `process.list` | `{underDirs:[], exes:[]}` | `[{pid, ppid, exe, name}]` (both empty → all with a readable path) |
| `process.close` | `{pids:[], softMs:3000}` | `{closed:[], pending:[]}` (posts WM_CLOSE to visible top-level windows) |
| `process.kill` | `{pids:[], tree:bool}` | `{killed:[], failed:[{pid, code}]}` |
| `process.start` | `{path, args?, cwd?}` | `{pid:number|null}` (ShellExecute; supports shortcuts & UAC) |
| `foreground.allow` | — | `{}` (`AllowSetForegroundWindow(ASFW_ANY)`) |
| `window.focus` | `{pid}` | `{focused:bool}` |
| `power.lock` | — | `{}` (`LockWorkStation`) |
| `power.sleep` | — | `{}` now, then suspends ~700 ms later |
| `display.off` | — | `{}` (monitor power off, broadcast) |
| `desktop.show` | — | `{}` (Shell `MinimizeAll`, STA) |
| `startapps.list` | — | `[{name, appId, target}]` from `shell:AppsFolder` (STA; names localized/UTF-8) |
| `registry.read` | `{hive, path, name, view?}` | `{value}` or `{value:null}` |
| `registry.enum` | `{hive, path, view?}` | `{values:{...}, subkeys:[{name, values:{...}}]}` (one level deep) |
| `nic.info` | — | `[{name, description, mac, type, up, ipv4:[{address, mask}]}]` |
| `file.info` | `{path}` | `{exists, product, description, company, version}` |

### Notes on specific commands

- **Window filtering** (`windows.list`): visible, unowned, not
  `WS_EX_TOOLWINDOW`, not DWM-cloaked, non-empty title, and not a shell window
  (`Shell_TrayWnd` / `Progman` / `WorkerW`). The helper's own pid is excluded.
  Titles themselves are **not** returned (privacy). `name` =
  FileDescription || ProductName || exe base name. `exe` is `null` when the
  path is not readable. `aumid` is the window's AppUserModelID or `null`.
- **Registry**: `hive` ∈ `HKCU|HKLM|HKCR`; `view` ∈ `32|64|default`. Value
  types map to: string, number (DWORD→int, QWORD→long), string array
  (MultiString), or base64 string (Binary). `name:""` (or omitted) reads the
  key's **default** value. Reads only; never writes.
- **Protected processes** (never closed/killed): the helper's own pid, the
  parent pid, any pid ≤ 4, and `explorer`, `csrss`, `winlogon`, `services`,
  `lsass`, `smss`, `wininit`, `dwm`. For `process.kill` these are reported as
  `{code:"protected"}`.

---

## Source layout

| file | area |
|---|---|
| `Program.cs` | main loop, request dispatcher, stdout writer, parent watch, selftest |
| `Json.cs` | minimal JSON parser + serializer |
| `Common.cs` | `HelperException`, typed `args` access, stderr logging |
| `Native.cs` | P/Invoke declarations, Win32 constants, `IPropertyStore` |
| `Audio.cs` | Core Audio COM interop (volume) |
| `Windows.cs` | window enumeration, AUMID, fullscreen, focus, watcher |
| `Processes.cs` | Toolhelp snapshot, process list/close/kill/start |
| `Power.cs` | lock / sleep / display-off |
| `Input.cs` | media keys (SendInput) |
| `Shell.cs` | STA executor + Shell.Application (startapps, desktop.show) |
| `Registry.cs` | registry read/enum |
| `Network.cs` | NIC info |
| `FileInfoCmd.cs` | file.info |

---

## Known limitations

- **PowerShell 5.1 `ConvertFrom-Json`** cannot represent a JSON object whose key
  is an empty string. A registry **default value** serializes as `{"": ...}`, so
  parsing a `registry.enum` response with `ConvertFrom-Json` throws. The output
  is valid JSON (Node's `JSON.parse`, used by the Electron client, handles it
  fine); this is only a Windows PowerShell quirk. `test-helper.ps1` avoids it by
  using `registry.read` rather than `registry.enum`.
- `aumid` / `startapps` rely on the shell property system and Shell.Application;
  on a stripped Server Core install these may be unavailable.
- `process.start` returns `pid:null` when the shell hands the launch to an
  already-running instance (e.g. some single-instance apps) and no new process
  is created.
- `window.focus` obeys Windows' foreground-lock rules; `foreground.allow`
  (called by the client beforehand) improves reliability but focus can still be
  denied by the OS in some states.
- The `-UseCsc` build fallback is not supported (see **Build**).
