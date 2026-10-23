# fivem-mcp — MCP server

A component of [fivem-mcp](../README.md). The MCP server that gives Claude a bridge into a
running FiveM client. The server hosts a local WebSocket endpoint; the NUI page of a FiveM
resource connects to it. Through that, Claude can run console commands in the game — exactly
what you would otherwise type into the F8 console by hand — and run Lua snippets in the client
context for everything that has no command.

```
Claude ──stdio (MCP)──> fivem-mcp ──ws://127.0.0.1:39271──> NUI page (CEF)
                                                             │ fetch()
                                                             ▼
                                                   client.lua: ExecuteCommand()
                                                               load(snippet)
```

**A development tool for the local machine.** See [Security](#security).

## Quick start

Every command runs in this folder (`mcp-server/`):

```bash
npm install
npm run build
```

The native index in `data/` ships with the repository; `npm run natives:sync` rebuilds it after
a FiveM update (see [Building the index](#building-the-index)).

Start the server once so the token and port become visible:

```bash
node dist/index.js
```

On stderr you get:

```
[INFO] Bridge token (generated): 42f5ab0b…
[INFO] Token file: <repo>\fivem-mcp-bridge\bridge.token
[INFO] Bridge listening on ws://127.0.0.1:39271
```

Test without FiveM — the mock client stands in for the resource:

```bash
node scripts/mock-nui.mjs
```

Every check at once — the native checks, the static checks of the resource, the skill-memory
leak check, and the end-to-end smoke test (starts the server as a real MCP client, stands in
for the NUI page, exercises every rejection case too). Builds once up front instead of once
per check:

```bash
npm test
```

Individually they are `npm run check:natives`, `npm run check:resource`, `npm run check:memory`
and `npm run smoke`.
During development, `npm run dev` watches `src/` with tsx and `npm run typecheck` runs the
compiler without emitting.

In Claude Code the server is registered through [.mcp.json](../.mcp.json) in the repo root,
which points at `mcp-server/dist/index.js`.

Note that an npm install of the `fivem-mcp` package ships only this MCP server — the game-side
resource lives outside the package. Clone the repository to get
[`fivem-mcp-bridge/`](../fivem-mcp-bridge).

## Tools

### `fivem_execute_command`

Runs a console command in the connected game client, as if it had been typed into F8.

| Parameter | Type | Description |
|---|---|---|
| `command` | string | The full command line, e.g. `fivem_ping` or `say hello` |
| `timeoutMs` | number, optional | How long to wait for the acknowledgement (default `requestTimeoutMs`, 100–30000) |
| `captureLog` | boolean, optional | Append the console output the command produced (default `clientLog.captureOnExecute`) |

Client-side only — this does **not** reach the FiveM server console.

The answer also contains whatever the client logged while it ran (see `fivem_read_log`).
`ExecuteCommand` returns no value of its own, so the log is the only source of truth for
whether the command actually did anything.

### `fivem_run_code`

Compiles a Lua snippet in the connected client and runs it — with the full client-side native
API. The tool for everything without a console command: walking, teleporting, reading world and
entity state, poking at other resources' exports.

| Parameter | Type | Description |
|---|---|---|
| `code` | string | Lua source. Receives `ctx` as its only argument (`local ctx = ...`) |
| `timeoutMs` | number, optional | How long to wait for the result (default `code.defaultTimeoutMs`, 100–30000) |
| `captureLog` | boolean, optional | Append the snippet's console output (default `clientLog.captureOnExecute`) |
| `nativeCheck` | `strict` \| `warn` \| `off`, optional | How to handle natives that do not resolve (default `natives.mode`) |

Before anything reaches the game, **every native the snippet calls is checked** — see
[Native checking](#native-checking).

The snippet runs **synchronously inside the NUI callback**, and its return value is the answer.
Anything that waits therefore belongs in `ctx.thread(...)` — otherwise it blocks the reply and
the tool runs into its timeout while the snippet keeps going in the game.

```lua
-- immediate: read the position
local c = GetEntityCoords(PlayerPedId())
return { x = c.x, y = c.y, z = c.z }
```

```lua
-- longer: walk somewhere without holding up the answer
local ctx = ...
ctx.thread(function()
    local ped = PlayerPedId()
    TaskGoToCoordAnyMeans(ped, 128.0, -1080.0, 29.2, 1.0, 0, 0, 786603, 0xbf800000)
    while ctx.alive() and #(GetEntityCoords(ped) - vector3(128.0, -1080.0, 29.2)) > 2.0 do
        Wait(500)
    end
    ctx.log('arrived: %s', GetEntityCoords(ped))
end)
return 'on my way'
```

`ctx` is deliberately small:

| Field | Meaning |
|---|---|
| `ctx.resource` | Name of the bridge resource |
| `ctx.alive()` | `false` once the payload was reloaded or stopped |
| `ctx.thread(fn)` | `CreateThread` wrapped in `pcall`; no longer starts after a dispose |
| `ctx.log(fmt, ...)` | `print` with the resource prefix, shows up in the client log |

**Long-lived loops must check `ctx.alive()`.** FiveM threads survive a `/fivem_reload`; without
the check, another copy of the loop runs after every reload.

Return values are flattened for transport: tables to depth 5 and 60 keys, while cycles and
anything non-serialisable (functions, userdata, `vector3`) become descriptive strings. Multiple
return values arrive as a list.

If snippets behave as if an outdated payload were still running, `/fivem_reload` in the game
pulls the current one.

### `fivem_read_log`

Reads the tail of the FiveM client log — the same output the F8 console shows, including
`print()` from resources and engine errors.

| Parameter | Type | Description |
|---|---|---|
| `lines` | number, optional | How many trailing lines (default `clientLog.defaultLines`, max 1000) |
| `cursor` | string, optional | Return only lines logged after this position, from a previous answer's `Next cursor` line. Omit for the recent tail |
| `filter` | string, optional | Case-insensitive substring filter, applied **before** taking the tail — e.g. `[my-resource]` |
| `filterRegex` | boolean, optional | Treat `filter` as a case-insensitive regular expression |
| `waitFor` | string, optional | Regex to wait for: the call blocks until a matching line arrives (from the cursor, or from "now" without one) or the timeout passes |
| `waitTimeoutMs` | number, optional | How long `waitFor` may block (default 30 000, cap 120 000) |
| `raw` | boolean, optional | Keeps the engine's `[timestamp] [process] thread/` prefix. Off by default |

It always reads the newest `CitizenFX_log_*.log` in the log directory, and only its tail — the
files grow to megabytes quickly. The game keeps writing to the file meanwhile, so the reader
opens it with shared access and trims the partial line at the start.

Every answer ends with `Next cursor: <file>:<offset>`; passing it back reads only what the
client logged since, instead of re-reading overlapping tails. A cursor from before a log
rotation (the game restarted) falls back to the tail of the new file and says so. `waitFor`
turns "sleep, then read the log again" into one call: *wait for `round ended`* returns the
moment the line appears. Filters and `waitFor` match the formatted lines — what you see in the
answer — not the raw engine prefix.

### `fivem_read_crash`

Reads the most recent client crash: when it happened, the unhandled exception and stack trace,
which engine debug-dump sections are available, and a list of older crashes. The first call to
make when the game vanished mid-test.

| Parameter | Type | Description |
|---|---|---|
| `id` | string, optional | Crash uuid or unique prefix from the "other recent crashes" list; default = the most recent crash |
| `section` | string, optional | One `.gamelog` section instead of the overview, e.g. `POOL INFO`; case-insensitive, a unique prefix like `pool` is enough |
| `filter` | string, optional | Case-insensitive substring filter on section lines; only meaningful with `section` |

A crash leaves `<uuid>.dmp` and usually `<uuid>.dmp.gamelog` in
`%LOCALAPPDATA%\FiveM\FiveM.app\crashes` — but neither holds the crash *reason*. That is
written by the DumpServer of another FiveM process into a `CitizenFX_log_*.log`, without ever
naming the dump's uuid. The tool therefore matches by wall-clock time (log filename timestamp
plus line offset against the dump's mtime) and names the log it took the block from. This
correlation reads the CitizenFX logs even when `clientLog.enabled` is `false`; overriding
`clientLog.directory` redirects it too.

The minidump itself is never parsed or symbolicated — stack frames stay `module.dll+offset`.
`.gamelog` sections (pool, streaming and script-thread state at the moment of the crash) come
back capped at 400 lines; `PACK INFO` alone is ~3900 lines, so narrow it with
`filter`. When the capturing log has been rotated away, the overview says so instead of
failing.

### `fivem_bridge_status`

No parameters. Shows whether a client is connected, which resource, since when, the last
heartbeat latency, the active command policy and the resource's most recent log lines. The
first call to make when something is not working.

### `fivem_native_info`

Looks natives up in the FiveM native reference: exact runtime spelling, parameters, return
type, namespace, client or server side.

| Parameter | Type | Description |
|---|---|---|
| `query` | string | Lua name (`SetEntityCoords`), reference name (`SET_ENTITY_COORDS`), hash (`0x06843DA7060A026B`) or keywords |
| `limit` | number, optional | Number of results for a keyword search (default 8, max 25) |
| `probeClient` | boolean, optional | Look each result up in the connected client (default `natives.probeClient`) |

Anything that is not an exact match is treated as a full-text search. If nothing matches at
all, the closest names come back — typos first, then substrings, and finally natives built from
the same words. That last step is the interesting one: an *invented* name is nobody's typo, but
it shares its words with the ones that really exist (`TaskMeleeAttackPed` →
`TaskPutPedDirectlyIntoMelee`).

A single hit comes back with the code examples from its documentation (~450 natives have some);
a list of hits only mentions them, to stay readable.

### Search

The search covers everything a native documents — name, namespace, description, parameters,
examples — so that a native can be found even when you do *not* know its name. That is the
actual purpose: "spawn a vehicle" should find `CreateVehicle`.

Results are weighted by field (a name counts ten times as much as an example) and by how rare
the word is, plus two corrections: matching more of the query ranks higher, and having the
match in your *own name* ranks higher than a long name that merely contains the words in
passing (`GetEntityCoords` beats `GetOffsetFromCoordAndHeadingInWorldCoords`).

Two gaps get bridged, both noticed on real questions:

- **Abbreviations.** Natives are called `Coord` and `Anim`, while the question asks about
  "coordinates" and "animation". Words sharing a prefix (from four characters) count too, at a
  discount.
- **Word choice.** The docs say `Create`, the question says "spawn". There is a short,
  hand-maintained synonym list for that — no thesaurus, only pairs where the FiveM docs
  genuinely diverge. `ped`/`player` is deliberately **not** in it: synonyms in English, two
  different things here, and both words far too common to conflate.

Fenced code blocks inside descriptions are **not** indexed. A few natives dump whole enums into
their docs — `SetCustomMpHudColor` lists 230 HUD colours — and indexing that makes the native an
answer to every question mentioning one of those constants. The block stays readable regardless.

The index is built at startup (~100 ms for 7170 natives), after which a query costs a few
milliseconds. No embeddings, no extra dependency, works offline. What it cannot do is answer a
question that shares no word with the docs: "teleport the player" finds `StartPlayerTeleport`,
not `SetEntityCoords` — whose documentation simply never uses the word "teleport".

### `fivem_screenshot`

Captures the FiveM window and returns it as an image — the only tool
here that can see what the game actually renders: the HUD, a NUI page, markers, whether a menu
really opened. By default the image is **cropped to the game window**, precisely so other
applications on that screen (chats, browsers, this very conversation) stay out of model
context; when no FiveM window is found, the whole display is captured and the caption says so.
The window is **read from the window itself** (`PrintWindow` with `PW_RENDERFULLCONTENT`), not
from the screen, so the game does not have to be in front: it can sit behind a browser or a chat
and the capture still shows the game. It only must not be minimised.

| Parameter | Type | Description |
|---|---|---|
| `display` | `auto` \| `primary` \| `all` \| number, optional | `auto` (default) is the monitor the FiveM window is on, `all` the whole virtual desktop, a number one specific display — the indexes are listed in every answer |
| `crop` | `window` \| `display`, optional | `window` (default) crops to the FiveM window; `display` keeps the whole monitor, for crash dialogs or the launcher next to the game. Only meaningful with `display: auto` |
| `method` | `auto` \| `window` \| `screen`, optional | `window` reads the window's own surface, so windows in front of the game do not matter; `screen` copies the desktop as it looks; `auto` (default `screenshot.method`) tries the window and falls back to the screen. Whole-display captures always use the screen |
| `maxWidth` | number, optional | Scale down to at most this width (default `screenshot.maxWidth`); `0` keeps the native resolution |
| `format` | `jpeg` \| `png`, optional | jpeg for looking at a scene, png for reading small UI text (default `screenshot.format`) |
| `quality` | number, optional | JPEG quality 1–100, ignored for png (default `screenshot.quality`) |
| `savePath` | string, optional | Also keep the file and report the path; relative paths resolve against `screenshot.saveDirectory` |

**This tool does not go through the bridge.** A screenshot is a property of the operating
system's desktop, not of the game, so it is taken by this process alone: no wire message,
nothing in `../fivem-mcp-bridge`. That is also what makes it useful when the bridge is
down — a crash dialog, a stuck loading screen or the launcher are all capturable while every
other tool here answers "not connected".

The work happens in a PowerShell child process (`src/capture/script.ts`, materialised into the
temp folder and run with `-ExecutionPolicy Bypass`) using `System.Drawing` plus a handful of
`user32` calls. Windows only, and no extra dependency for it.

Two details that are easy to get wrong and are handled here:

- **DPI awareness comes first.** PowerShell is not DPI aware by default, and every monitor
  rectangle then arrives multiplied by the *primary* display's scale factor. On a 4K/150 %
  primary next to a 1080p secondary, the secondary reports `2880x1620` and the capture is a
  stretched, wrongly placed region. The worker claims per-monitor-v2 awareness before it reads
  anything, and the answer says which mode it got — that line is the first thing to look at when
  a capture is cropped.
- **Exclusive fullscreen cannot be captured this way.** Direct3D in exclusive fullscreen is not
  part of the desktop surface, so the frame comes back black. The tool samples a grid and says
  so, with the remedy: run FiveM windowed or borderless windowed. A locked session and a
  disconnected remote desktop look identical.
- **Covered windows.** A desktop copy (BitBlt) shows whatever is on top, so a browser over the
  game ends up in the picture. `PrintWindow` with `PW_RENDERFULLCONTENT` (Windows 8.1+) asks DWM
  for the window's own surface instead, which works for a covered Direct3D window too
  (~40 ms for 1920x1080). A minimised window renders nothing; `auto` then falls back to the
  screen and the caption says so.

Payload sizes, measured on a 3840x2160 display:

| Setting | Bytes |
|---|---|
| `maxWidth: 1280`, jpeg q80 (the default) | ~80 KB |
| `maxWidth: 1280`, png | ~195 KB |
| `maxWidth: 0`, png (native 4K) | ~390 KB |

The bridge's websocket frame limit does **not** apply — nothing here crosses the bridge; a
normal capture is larger than it and would be wrongly rejected.

### `fivem_launch`

Starts the FiveM launcher with `+connect <host>:<port>`, so the agent can bring up a client
itself instead of asking for one. Like the screenshot it never goes through the bridge — the
whole point is to be useful when nothing is running.

| Parameter | Type | Description |
|---|---|---|
| `address` | string, optional | `host:port` of the server; the port defaults to `30120`. A `fivem://connect/...` link and a `cfx.re/join/<code>` shortcut are accepted too. Falls back to `launch.defaultAddress` |
| `force` | boolean, optional | Launch even though FiveM already seems to be running (default `false`) |
| `waitMs` | number, optional | Wait up to this long (0–180000, default `0`) for the client to reach the bridge before answering |

**The address is the whole tool.** With no `address` and no `launch.defaultAddress` configured,
the call comes back as an error that tells the agent to *ask the user* for the host and port —
deliberately, because a launch aimed at a guessed IP burns a full game start on a server nobody
is testing. Set `launch.defaultAddress` to your development server and the argument becomes
optional.

FiveM.exe is looked for in this order: `launch.executablePath`, then
`%LOCALAPPDATA%\FiveM\FiveM.exe`, then whatever registered itself as the `fivem://` protocol
handler (`HKCU\Software\Classes\fivem\shell\open\command`).

Before launching, `tasklist` is checked against `launch.processNames`. A running client means
nothing is started and the answer says which process and pid — a second launcher normally does
nothing anyway. `force: true` overrides that; a `tasklist` that cannot be run is reported as
inconclusive rather than treated as "nothing is running".

The game is spawned detached and unref'd, so it survives this server being restarted and is
never killed by its shutdown. Reaching a server takes a minute or two, which is why the answer
comes back immediately by default and points at `fivem_bridge_status`; `waitMs` polls the bridge
instead, and expiring is not an error.

### `fivem_server_console`

Reads the FiveM **server** console — resource prints, script errors, joins and leaves, exactly
what the txAdmin Live Console shows. The counterpart to `fivem_read_log`, which only ever sees
the game client. Off by default; setup in [Server console via txAdmin](#server-console-via-txadmin).

| Parameter | Type | Description |
|---|---|---|
| `cursor` | number, optional | Return only output that arrived after this position, taken from a previous answer's `Next cursor` line. Omit for the recent tail |
| `maxBytes` | number, optional | Cap on the returned text (default `txAdmin.defaultReadBytes`) |
| `filter` | string, optional | Case-insensitive substring filter applied per line, e.g. a resource name |
| `filterRegex` | boolean, optional | Treat `filter` as a case-insensitive regular expression |
| `waitFor` | string, optional | Regex to wait for: the call blocks until a matching line arrives (from the cursor, or from "now" without one) or the timeout passes |
| `waitTimeoutMs` | number, optional | How long `waitFor` may block (default 30 000, cap 120 000) |

Every answer ends with `Next cursor: <n>`; passing it back reads only what happened since —
the same bracketing idea as the client log tools, but over a live stream instead of a file. The
stream is buffered in this process (1 MiB ring buffer); a cursor that
has aged out of the buffer is reported honestly and answered with the recent tail instead.
ANSI colour codes are stripped before the text reaches the model.

### `fivem_server_command`

Runs a command in the FiveM **server** console through txAdmin, as if typed into the Live
Console — `restart myresource`, `ensure myresource`, `status`. The counterpart to
`fivem_execute_command`, which only reaches the game client.

| Parameter | Type | Description |
|---|---|---|
| `command` | string | The server console command line |
| `captureOutput` | boolean, optional | Append the console output that followed (default `true`; waits up to `txAdmin.captureWaitMs` for the first output, then until it has been quiet for `txAdmin.captureSettleMs`) |

txAdmin sends **no acknowledgement** for a console command — the only feedback is what appears
on the console stream. So the answer says "dispatched", appends the output that followed within
the settle window, and always names the bracketing cursor so late output can be read with
`fivem_server_console`. An empty capture is explained rather than glossed over: the command may
have run silently, may not exist, or the txAdmin account may lack the *Console: Write*
permission — txAdmin drops the command without any error in that case.

Commands run through their own policy (`txAdmin.commands`), separate from the client-side one.
The default denylist blocks only `quit` — it stops the whole server.

### `fivem_check_resource`

Statically lints a resource folder **before** it is deployed: parses `fxmanifest.lua`,
classifies every Lua file as client, server or shared (globs supported), syntax-checks each
one, and resolves every native call against the reference with the apiset matching the file's
side — the same check `fivem_run_code` applies to snippets, for a whole resource on disk.

| Parameter | Type | Description |
|---|---|---|
| `path` | string | Absolute path of the resource folder (the one containing `fxmanifest.lua`) |
| `probeClient` | boolean, optional | Also ask the connected game client which client-side names exist (default `true`; skipped silently without a client) |

Globals the resource defines itself — module tables, cross-file helpers — are collected across
*all* its files first and never flagged. A misspelled or invented native comes back as an error
with the correct spelling ("did you mean"), a native on the wrong side of the client/server
split is named as such, and suspicious argument counts warn. This is the tool that catches a
`SetCanAttackFriendlyPlayer` at lint time instead of as a half-executed SCRIPT ERROR after the
next restart.

### `fivem_server_run_code`

Runs a Lua snippet on the FiveM **server**, inside the bridge resource's server Lua state — the
counterpart to `fivem_run_code`. Reads server truth directly (`GetResourceState`, routing
buckets, player lists, another resource's exports) instead of compiling throwaway debug
commands into the resource under test. **Off by default on both sides**: `serverEval.enabled`
in `fivem-mcp.config.json` registers the tool, and `serverEval = true` in the resource's
`config.lua` registers the in-game HTTP handler (`refresh` + `restart` after changing it).

| Parameter | Type | Description |
|---|---|---|
| `code` | string | Lua source, server context; receives `ctx` (`ctx.resource`, `ctx.log`) as its only argument |
| `timeoutMs` | number, optional | Wait for the result (default `serverEval.defaultTimeoutMs`) |
| `nativeCheck` | `strict` \| `warn` \| `off`, optional | Default `warn` — server natives cannot be probed live, so the reference alone decides |

The transport is a loopback-only `POST /fivem-mcp-bridge/eval` on the FXServer game endpoint,
authenticated with the same `bridge.token` the NUI bridge uses (compared constant-time,
re-read per request). `ctx.log` lines come back in the tool answer *and* go to the server
console. `scripts/check-resource.mjs` enforces the handler's gates.

### `fivem_nui_frames`, `fivem_nui_snapshot`, `fivem_nui_click`, `fivem_nui_eval`

NUI debugging through FiveM's CEF DevTools endpoint (port 13172, the documented NUI debugging
port — open whenever the game runs, no launch flag needed). No bridge involved.

- **`fivem_nui_frames`** — lists every NUI frame with its owning resource and URL. Read-only.
- **`fivem_nui_snapshot`** `{ resource, screenshot? }` — compact DOM outline (tags, ids,
  classes, text, clickability), optionally plus a PNG of the NUI layer itself — UI only,
  transparent background, inherently privacy-safe. Read-only.
- **`fivem_nui_click`** `{ resource, selector }` — clicks an element through the page's real
  event handlers, no OS-level input. A missed selector answers with the clickable elements the
  frame actually has.
- **`fivem_nui_eval`** `{ resource, code, world? }` — evaluates JavaScript in the frame;
  `main` (default) sees the page's own functions, `isolated` always exists but sees only the DOM.

`click` and `eval` are code execution with the reach of the NUI page itself (they can trigger
the resource's NUI callbacks), so they are registered only while `code.enabled` is `true` —
the same flag as `fivem_run_code`. The endpoint is configurable as `nui.devtoolsEndpoint` and
pinned to loopback.

## Server console via txAdmin

The two `fivem_server_*` tools talk to [txAdmin](https://github.com/citizenfx/txAdmin), the
management panel that ships with FXServer, using the same interface the panel's own web UI
uses: a password login for a session cookie, then a socket.io connection into the `liveconsole`
room. One connection carries both directions — console output streams in, commands go out — and
every command is logged by txAdmin under the account's name, so the agent's actions show up in
the panel's history like any other admin's.

Setup:

1. In txAdmin, create a **dedicated admin account** for the MCP (Admin Manager → New Admin) and
   give it only the *Console: View* and *Console: Write* permissions. A separate account keeps
   the panel's action log attributable and lets you revoke the agent without touching your own
   login.
2. In `fivem-mcp.config.json`, set `txAdmin.enabled: true`, `txAdmin.username`, and — if the
   panel is not on `http://127.0.0.1:40120` — `txAdmin.url`.
3. Put the account's password in `.fivem-mcp/txadmin.password` at the repo root (or set
   `FIVEM_TXADMIN_PASSWORD`). The file is never generated for you: it has to match the account
   you just created.

Behaviour worth knowing:

- **Nothing dials until a server tool is first used.** The MCP starts fine with the server
  down; the first call connects, and the connection is then kept alive so the console buffer
  keeps filling between calls.
- **Reconnects re-login.** txAdmin sessions live in memory and die with a panel restart, so the
  reconnect loop (exponential backoff, 1 s → 30 s) always authenticates fresh, and the replayed
  recent-console buffer is deduplicated against what was already captured. A gap in the stream
  is marked with a `[fivem-mcp]` line rather than silently spliced.
- **A rejected login is never retried.** txAdmin temporarily bans an address after a handful of
  failed logins; wrong credentials would otherwise lock every admin out. Fix the credentials,
  then restart the MCP server.
- **txAdmin has no official public API.** This speaks what the web panel speaks (verified
  against txAdmin's source), which can change with a txAdmin update — failures say so and name
  the URL rather than pretending the server is down.

## Native checking

`fivem_run_code` sends no snippet into the game without first resolving every native it calls.
The reason is mundane: a plausible-sounding but invented name is by far the most common way for
a snippet to fail — and it fails mid-run, with `attempt to call a nil value`, after half of it
has already happened.

Two sources are consulted, because neither is sufficient alone:

| Source | Knows | Does not know |
|---|---|---|
| `data/natives-index.json` | Signature, namespace, apiset, spelling | whether this game build actually has it |
| The connected client | exactly that | everything else |

The client is asked by evaluating `_G[name]` — the same question the snippet itself asks.
Natives only materialise in `_G` on first access in FiveM, so `pairs(_G)` does *not* list them,
while an indexed access answers the question reliably. It costs one extra round trip
(single-digit milliseconds over loopback) and is the only way to tell a documented native from
one this build actually exposes. With no client connected, the reference decides alone.

That extra query counts against `rateLimit.commandsPerMinute` — so a `fivem_run_code` with
natives consumes two slots instead of one. At 120/minute nobody notices; anyone running a low
limit should know.

Per name, that yields:

| Reference | Client | Result |
|---|---|---|
| knows it | has it | runs |
| knows it | does not have it | rejected — documented, but not present in this build |
| knows it, server-side | — | rejected — snippets run client-side |
| does not know it | has it | runs — a runtime global, or another resource's global |
| does not know it | does not have it | rejected, with suggestions |

A native with both sides (`GetEntityCoords` exists client- *and* server-side, with different
hashes) counts as available client-side.

What the snippet defines itself is not checked: locals, function parameters, loop variables and
its own global functions are tracked while parsing. Member and method calls
(`ctx.thread(...)`, `obj:run()`) are not natives anyway. If the snippet does not parse, nothing
is checked — the error from the game is the better one in that case.

The argument count is only ever a **warning**, never a block: Lua is not passed the reference's
output parameters (`float*`) but receives them as extra return values, so the acceptable count
is a range.

`nativeCheck` lowers the strictness per call — for a native the reference does not know yet. If
a name came back as a typo, fix the name, not the check. The strictness cannot be raised beyond
the value in the configuration.

### Building the index

```bash
npm run natives:sync
```

Fetches [natives.json](https://runtime.fivem.net/doc/natives.json) and
[natives_cfx.json](https://runtime.fivem.net/doc/natives_cfx.json) and builds
`data/natives-index.json` from them (~7170 natives, ~2.9 MB, including descriptions, parameter
docs and code examples). `npm run natives:sync -- --offline` rebuilds from the raw-data cache
without network access. Worth re-running after a FiveM update.

The index is **committed**, so a fresh clone works offline with no sync step. It remains the
CitizenFX Collective's documentation under their terms, not part of the MIT grant — see
[Licence](../README.md#licence). Should the index ever be missing, the server still runs but
stops checking natives (`fivem_native_info` is then not even registered), and `npm test` aborts
with exactly that message.

Those two JSON documents **are** the compiled form of
[`ext/native-decls`](https://github.com/citizenfx/fivem/tree/master/ext/native-decls) and
[`citizenfx/natives`](https://github.com/citizenfx/natives) — the same Markdown files, only
already parsed: description, parameters, return value and examples all come along. Reading the
Markdown sources directly therefore gains nothing (counted: 943 CFX natives in the JSON against
865 `.md` files in git — the JSON has *more*).

The reference spells natives as `SET_ENTITY_COORDS`, while the Lua runtime exposes them as
`SetEntityCoords`. The transliteration has three rules, all verified against a running client
(220 samples, no deviation):

| Reference | Lua |
|---|---|
| `SET_ENTITY_COORDS` | `SetEntityCoords` |
| `_FORCE_VEHICLE_ENGINE_SYNTH` | `ForceVehicleEngineSynth` (leading underscore is dropped) |
| `GET_GROUND_Z_FOR_3D_COORD` | `GetGroundZFor_3dCoord` (the underscore stays in front of a segment starting with a digit) |
| unnamed | `N_0x` + hash in lowercase |

## The game side

The game side lives in [`fivem-mcp-bridge/`](../fivem-mcp-bridge) and has
[its own docs](../fivem-mcp-bridge/README.md). In short: player clients only ever receive a
loader, and the real bridge code is sent by the FiveM server exclusively to developers
authorized in `authorized.txt` or through ACE.

For the MCP server that means two things:

- **Token.** `tokenFile` points at the token file in the resource folder. It is deliberately
  **not** in `files {}` there — the FiveM server reads it with `LoadResourceFile` and delivers
  it over the gated channel. The built-in default, `../fivem-mcp-bridge/bridge.token`, is the
  resource folder in this repository — with a junction/symlink deployment there is nothing to
  configure. Start the MCP server first (it writes the file), then start the resource or run
  `/fivem_reload` in the game.

  **Remote game server?** When the FiveM server runs on another machine, the MCP server
  cannot write the token into its resource folder. Set a fixed token instead: put the same
  string (16+ characters) into `FIVEM_BRIDGE_TOKEN` on the MCP side and into
  `fivem-mcp-bridge/bridge.token` on the server. A fixed token also means no reload is needed
  after an MCP server restart.

- **Resource name.** The folder name inside `resources/` determines the resource name and thus
  the NUI origin. Once it is settled, it belongs in `allowedResources`.

Static checks of the resource (manifest invariant, Lua/JS syntax, hot-reload contract):

```bash
npm run check:resource
```

### Two pitfalls

- **The NUI page has to be loaded**, otherwise the bridge does not exist. An invisible
  `ui_page` is entirely enough; NUI focus (`SetNuiFocus`) is not needed for `fetch`.
- **`ws://localhost` from an `https://cfx-nui-*` origin** works because Chromium treats
  loopback as "potentially trustworthy" and exempts it from mixed-content blocking. Should some
  CEF version block it anyway, the error appears in the NUI DevTools (`nui_devtools` in F8) —
  that is the first place to look.

## Configuration

`fivem-mcp.config.json` in this folder, optional. Template:
[`fivem-mcp.config.example.json`](fivem-mcp.config.example.json). Every value has a default.

Relative paths (the config file, `tokenFile`, `passwordFile`) always resolve against the
`mcp-server/` folder, **not** against the working directory — an MCP client starts the process
from anywhere. The defaults reach out of the package via `..` because they assume the repo
layout (the bridge resource and the root `.fivem-mcp/` directory next to this package); a
standalone npm install has neither and sets explicit paths.

| Key | Default | Meaning |
|---|---|---|
| `host` | `127.0.0.1` | Loopback values only, otherwise startup aborts |
| `port` | `39271` | Port of the WebSocket server |
| `tokenFile` | `../fivem-mcp-bridge/bridge.token` | Where the shared secret lives |
| `allowedResources` | `[]` | Empty = any `cfx-nui-*` origin; otherwise an exact list of names |
| `allowNoOrigin` | `false` | Allow connections without an `Origin` header (for tests only) |
| `requestTimeoutMs` | `5000` | Default wait for a `result` |
| `rateLimit.commandsPerMinute` | `120` | Sliding window for outbound commands |
| `clientLog.enabled` | `true` | Turn the log tools off |
| `clientLog.directory` | `null` | `null` = auto-detect `%LOCALAPPDATA%\FiveM\FiveM.app\logs` |
| `clientLog.defaultLines` | `20` | Lines when `fivem_read_log` is given no number |
| `clientLog.captureOnExecute` | `true` | Append console output to the answer of `fivem_execute_command` |
| `crashes.enabled` | `true` | `false` does not even register `fivem_read_crash` |
| `crashes.directory` | `null` | `null` = auto-detect `%LOCALAPPDATA%\FiveM\FiveM.app\crashes` |
| `crashes.maxCrashes` | `10` | Entries in the "other recent crashes" list |
| `code.enabled` | `true` | `false` does not even register `fivem_run_code` |
| `code.maxBytes` | `16384` | Largest allowed snippet; must stay below the 65536-byte frame limit |
| `code.defaultTimeoutMs` | `10000` | Wait for `fivem_run_code` when the call names none |
| `natives.enabled` | `true` | `false` turns the check off and does not register `fivem_native_info` |
| `natives.mode` | `strict` | `strict` \| `warn` \| `off`; upper bound for the `nativeCheck` parameter |
| `natives.probeClient` | `true` | Look up in the client which names really exist before running |
| `commands.mode` | `denylist` | `denylist` or `allowlist` |
| `commands.denylist` | `quit, exit, connect, disconnect, loadlevel` | Blocked verbs in denylist mode |
| `commands.allowlist` | `[]` | Allowed verbs in allowlist mode |
| `screenshot.enabled` | `true` | `false` does not even register `fivem_screenshot` |
| `screenshot.processNames` | `FiveM_*GTAProcess, FiveM_GTAProcess, FiveM_b*, FiveM` | PowerShell `-like` patterns; the game is the GTAProcess, plain `FiveM` is the launcher |
| `screenshot.maxWidth` | `1280` | Width the image is scaled down to; `0` = native resolution |
| `screenshot.format` | `jpeg` | `jpeg` or `png` |
| `screenshot.quality` | `80` | JPEG quality, ignored for png |
| `screenshot.timeoutMs` | `15000` | How long PowerShell gets before the capture is abandoned |
| `screenshot.saveDirectory` | `null` | `null` = the OS temp folder; also the base for relative `savePath` values |
| `screenshot.fallbackToPrimary` | `true` | Capture the primary display when no FiveM window is found, instead of failing |
| `screenshot.method` | `auto` | `window` reads the game window itself (works behind other windows), `screen` copies the desktop, `auto` tries the window first |
| `txAdmin.enabled` | `false` | `true` registers `fivem_server_console` and `fivem_server_command` |
| `txAdmin.url` | `http://127.0.0.1:40120` | txAdmin panel origin; plain `http` off loopback logs a warning |
| `txAdmin.username` | `null` | The dedicated admin account the MCP logs in as |
| `txAdmin.passwordFile` | `../.fivem-mcp/txadmin.password` | Where the account's password lives (default: `.fivem-mcp/` at the repo root), unless `FIVEM_TXADMIN_PASSWORD` is set |
| `txAdmin.captureSettleMs` | `250` | Quiet period after which a command's output capture is complete |
| `txAdmin.captureWaitMs` | `1200` | How long `fivem_server_command` waits for a command's *first* output |
| `txAdmin.connectTimeoutMs` | `8000` | Budget for login + socket connect before a tool gives up |
| `txAdmin.defaultReadBytes` | `8192` | Bytes returned by `fivem_server_console` when the call names none |
| `txAdmin.commands.mode` | `denylist` | `denylist` or `allowlist`, separate from the client-side policy |
| `txAdmin.commands.denylist` | `quit` | Blocked server verbs in denylist mode |
| `txAdmin.commands.allowlist` | `[]` | Allowed server verbs in allowlist mode |
| `txAdmin.protectedResources` | `["fivem-mcp-bridge"]` | Resources `fivem_server_command` may not `stop`; a restart carries a warning |
| `launch.enabled` | `true` | `false` does not even register `fivem_launch` |
| `launch.executablePath` | `null` | `null` = `%LOCALAPPDATA%\FiveM\FiveM.exe`, then the `fivem://` protocol handler |
| `launch.defaultAddress` | `null` | Server used when the call names none; `null` makes the caller ask the user for one |
| `launch.allowedAddresses` | `[]` | Empty = any address; entries are `host` (any port) or `host:port` |
| `launch.processNames` | `FiveM.exe, FiveM_*GTAProcess.exe, FiveM_b*.exe` | `tasklist` image names that mean "already running"; `*` is a wildcard |
| `launch.probeTimeoutMs` | `5000` | Wait for `tasklist` / `reg query` before the lookup counts as inconclusive |
| `serverEval.enabled` | `false` | `true` registers `fivem_server_run_code`; the resource's `config.lua` must also set `serverEval = true` |
| `serverEval.gameEndpoint` | `127.0.0.1:30120` | FXServer game endpoint carrying the eval handler; loopback enforced |
| `serverEval.defaultTimeoutMs` | `10000` | Wait for `fivem_server_run_code` when the call names none |
| `nui.devtoolsEndpoint` | `127.0.0.1:13172` | FiveM's CEF DevTools endpoint for the `fivem_nui_*` tools; loopback enforced |
| `nui.timeoutMs` | `8000` | Budget for one DevTools operation |

ENV overrides: `FIVEM_BRIDGE_PORT`, `FIVEM_BRIDGE_TOKEN`, `FIVEM_BRIDGE_CONFIG`,
`FIVEM_BRIDGE_LOG_LEVEL` (`debug` | `info` | `warn` | `error`), `FIVEM_TXADMIN_URL`,
`FIVEM_TXADMIN_USERNAME`, `FIVEM_TXADMIN_PASSWORD`.

## Security

- **Loopback enforced.** `host` accepts only `127.0.0.1`, `::1`, `localhost`; anything else
  aborts startup with an error. On top of that, every upgrade request from a non-loopback
  address is rejected with HTTP 403 before the WebSocket handshake.
- **Token handshake.** 32 random bytes, compared with `crypto.timingSafeEqual`. The first
  message must be a valid `hello` within 3 s, otherwise the connection is closed.
- **Origin check.** Only `https://cfx-nui-<resource>` and `nui://<resource>` are allowed. The
  resource name given in `hello` must match the origin. The origin and resource checks run
  deliberately *after* the upgrade so the client gets a meaningful close code instead of a bare
  HTTP 403 — the hard boundary is the loopback check in front of it.
- **One session.** A new connection replaces the old one (close 4009), so game restarts leave
  no dead sockets behind.
- **Command policy.** The denylist default blocks `quit`, `exit`, `connect`, `disconnect` and
  `loadlevel`, because those can disconnect the client or send it to another server. Control
  characters in a command are rejected. For strict operation, `mode: "allowlist"`.
- **Code policy.** `fivem_run_code` is the widest capability this server has: a Lua `load()` in
  the client context, meaning everything the F8 console plus every native can do. Only what
  would break the transport or the `load()` is checked — size (`code.maxBytes`), empty input,
  NUL bytes and precompiled bytecode; client-side, `load(..., 't')` compiles source text only.
  There is deliberately no filtering of content: for a Turing-complete language it would be
  theatre. Anyone who does not want the capability sets `code.enabled` to `false`, and the tool
  is then not registered.
- **Screen capture.** By default `fivem_screenshot` reads only the game window itself, so other
  windows on that screen stay out. A whole-display capture (`crop: "display"`, a display
  selector, or the `screen` fallback) photographs the monitor as it looks, and anything else
  open on that screen is then in the image and goes to the model. It is the only
  tool here that can see outside the game, and the only one not gated by the token, the origin
  check or the resource's ACE list — it never touches the bridge, so none of those apply.
  `screenshot.enabled: false` is the off switch, and the tool is then not registered. The
  capture spawns `powershell.exe` with `-ExecutionPolicy Bypass`; that is a shape some EDR
  products alert on, which is worth knowing before it surprises somebody.
- **Launching the game.** `fivem_launch` starts a local process and points it at whatever
  address it is given, which is a capability none of the bridge tools have. It is bounded in
  three ways: it only ever connects at process start, so a session already in progress cannot be
  moved (that is what keeps `connect` on the command denylist meaningful); `launch.allowedAddresses`
  narrows it to named servers when an empty list is too open; and `launch.enabled: false` removes
  the tool entirely. The spawn is argv-based with no shell, and the address is parsed rather than
  passed through — a host has to be a hostname, an IPv4 or a bracketed IPv6 to reach the command
  line at all.
- **Server console via txAdmin.** The `fivem_server_*` tools hold real admin credentials and can
  run arbitrary server console commands — a materially wider capability than anything
  client-side, which is why the feature is off by default. Bound it with the dedicated account's
  txAdmin permissions (only *Console: View* / *Console: Write*), the separate
  `txAdmin.commands` policy, and `txAdmin.enabled: false` as the off switch. The panel URL may
  leave loopback — txAdmin authenticates its clients and commonly runs on a remote host — but
  plain `http` off loopback sends the password unencrypted and is warned about at startup.
- **Rate limit** of 120 requests/minute (commands and snippets share the window); nothing is
  sent once it is exceeded.
- **stdout stays clear.** MCP runs over stdio, so all output goes to stderr; `console.*` is
  defensively redirected to stderr at startup.

Honest limitations:

- The token only ever leaves the FiveM server towards authorized developer clients. Anyone who
  legitimately receives the payload has the token with it — the trust model is "I trust my
  development team", not "I trust the client".
- ACE permissions apply server-side, so the check sits where it belongs: in the resource's
  gatekeeper (`fivem-mcp-bridge/server/main.lua`), not here. The MCP server only ever sees
  already-authorized connections.
- The connection is unencrypted. On loopback that is acceptable; this server must not run over
  a network anyway.

## Wire protocol v1

JSON, one message per frame, type in the `t` field.

**Client → server**

| Message | Fields |
|---|---|
| `hello` | `{ t:"hello", protocol:1, token:string, resource:string, client?:string }` — must be the **first** message, within 3 s |
| `result` | `{ t:"result", id:string, ok:true, data?:unknown }` or `{ t:"result", id:string, ok:false, error:string }` |
| `pong` | `{ t:"pong", id:number }` |
| `log` | `{ t:"log", level?:"debug"\|"info"\|"warn"\|"error", message:string }` — optional, the last 50 entries show up in `fivem_bridge_status` |

**Server → client**

| Message | Fields |
|---|---|
| `welcome` | `{ t:"welcome", sessionId:string, serverVersion:string, protocol:1 }` |
| `command` | `{ t:"command", id:string, command:string, timeoutMs:number }` |
| `eval` | `{ t:"eval", id:string, code:string, timeoutMs:number }` |
| `ping` | `{ t:"ping", id:number }` — every 15 s; without a `pong` within 30 s the session is closed |

**Close codes**

| Code | Meaning |
|---|---|
| `4001` | Invalid token |
| `4002` | Handshake timeout, no `hello` first, protocol mismatch, malformed JSON |
| `4003` | Origin missing or not a NUI origin |
| `4004` | Resource not allowed, or does not match the origin |
| `4009` | Replaced by a newer session |
| `4010` | Heartbeat missed |
| `4011` | Server shutting down |

`ExecuteCommand` returns no value in FiveM, so the normal case is a bare ack. The protocol does
allow the resource to put its own structured answer into `data` (test results, for example);
the tool returns whatever arrives.

**Peers (multiple Claude sessions)**

Any number of `fivem-mcp` processes can run at once: the first to bind the port hosts the bridge,
every later one connects to it on path `/peer` and proxies its calls through it. When the host
exits, a surviving peer takes the port over and the game reconnects on its own within seconds.
Peers present the same `hello` (token and protocol checked; the origin and resource checks are
NUI-only) and are never sessions — they cannot displace the game client. On path `/peer`:

| Message | Fields |
|---|---|
| `request` | peer → host, `{ t:"request", id:string, kind:"command"\|"eval", body:string, timeoutMs:number }` — the host answers it with its own send/runCode, so rate limits stay in one place |
| `status-request` | peer → host, `{ t:"status-request", id:string }` |
| `welcome` | host → peer, `{ t:"welcome", role:"peer", serverVersion:string, protocol:1 }` — `role` is how a peer recognises a current host; its absence means an old one |
| `response` | host → peer, `{ t:"response", id:string, outcome:SendOutcome }` |
| `status` | host → peer, `{ t:"status", id:string, status:BridgeStatus }` |

`fivem_bridge_status` reports which role a session holds and, on the host, how many peers are
attached.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `fivem_bridge_status` says "not connected" | Game not started, resource not active, or your own identifier is missing from `fivem-mcp-bridge/authorized.txt` — the FiveM server console logs every rejection |
| Close `4001` in the NUI DevTools | The token in `bridge.token` and in the server differ — did you restart the MCP server? Run `/fivem_reload` in the game afterwards |
| Close `4003` | The page is not running as a NUI page (opened in a normal browser, for example) |
| Close `4004` | `allowedResources` does not match the resource name |
| A tool reports a timeout | The `execCommand` callback never calls `cb`, or the command blocks |
| `fivem_run_code` behaves as if a stale payload were running | An old payload survived a server update — run `/fivem_reload` in the game to pull the current one |
| A snippet runs into its timeout | It waits synchronously (`Wait`, a loop). Move it into `ctx.thread(...)` and fetch the result with `fivem_read_log` or a second snippet |
| `fivem_bridge_status` notes the port "is in use, but…" | Something that is not a fivem-mcp host owns the port (or an older fivem-mcp that predates multi-session support) — the note says which; set `FIVEM_BRIDGE_PORT` or restart the old session. Changing the port also requires the same value in `Config.bridgeUrl` in `fivem-mcp-bridge/config.lua`, or the bridge silently never connects. A second *current* fivem-mcp is not an error: it attaches as a peer |
| A screenshot comes back black | FiveM is in exclusive fullscreen — switch to borderless windowed. A locked session or a disconnected remote desktop does the same |
| A screenshot shows the wrong monitor, or a cropped one | Check the `DPI awareness` in the answer: anything but `per-monitor-v2` means the bounds may be scaled. Otherwise pass an explicit display index |
| `fivem_launch`: "Could not find FiveM.exe" | The install is not in `%LOCALAPPDATA%\FiveM` and no `fivem://` handler is registered — set `launch.executablePath` |
| `fivem_launch`: "FiveM already appears to be running" | Close the game, or pass `force: true`. The in-game `connect` command stays denylisted on purpose |
| `fivem_launch` refuses without an address | Intentional: pass `address`, or set `launch.defaultAddress` to your development server |

## Layout of this component

```
mcp-server/
  src/
    index.ts                   Config -> token -> bridge -> MCP stdio
    config.ts                  zod-validated config, ENV overrides, loopback enforcement
    logger.ts                  stderr-only logger + console guard
    runTool.ts                 shared runner for short-lived console tools (capture, probes)
    bridge/bridge.ts           the Bridge interface the tools talk to, status/outcome types
    bridge/elected.ts          host/peer election: bind the port or attach to whoever did
    bridge/protocol.ts         zod schemas for every wire message, close codes
    bridge/server.ts           ws server, origin/token checks, heartbeat, session, peers
    bridge/session.ts          request correlation, timeouts, rate limit
    logs/clientLog.ts          tail reader for the FiveM client log
    txadmin/client.ts          txAdmin session: login, socket.io liveconsole connection
    txadmin/consoleBuffer.ts   ring buffer over the streamed server console
    txadmin/credentials.ts     password from FIVEM_TXADMIN_PASSWORD or the password file
    crashes/crashDumps.ts      crash dump listing, gamelog sections, log-block correlation
    capture/screen.ts          spawns the capture worker, no bridge involved
    capture/script.ts          the PowerShell worker as a string (tsc copies no .ps1 into dist)
    launch/fivem.ts            finds FiveM.exe, checks what is running, starts it detached
    security/token.ts          generate/persist the token, timing-safe comparison
    security/commandPolicy.ts  denylist/allowlist check
    security/codePolicy.ts     size/format check for snippets
    security/nativeCheck.ts    reference + client -> a verdict per native called
    natives/catalog.ts         the loaded index: lookup, suggestions, keyword search
    natives/scanCode.ts        Lua AST: which natives does the snippet call?
    nui/devtools.ts            CEF DevTools client: frame discovery, snapshot, eval
    types/luaparse.d.ts        types for luaparse, which ships none itself
    tools/executeCommand.ts    MCP tool fivem_execute_command
    tools/runCode.ts           MCP tool fivem_run_code
    tools/bridgeStatus.ts      MCP tool fivem_bridge_status
    tools/readLog.ts           MCP tool fivem_read_log
    tools/readCrash.ts         MCP tool fivem_read_crash
    tools/nativeInfo.ts        MCP tool fivem_native_info
    tools/screenshot.ts        MCP tool fivem_screenshot
    tools/launchGame.ts        MCP tool fivem_launch
    tools/serverConsole.ts     MCP tool fivem_server_console (txAdmin)
    tools/serverCommand.ts     MCP tool fivem_server_command (txAdmin)
    tools/serverRunCode.ts     MCP tool fivem_server_run_code (FXServer eval endpoint)
    tools/checkResource.ts     MCP tool fivem_check_resource
    tools/nui.ts               MCP tools fivem_nui_frames/_snapshot/_click/_eval
    tools/support.ts           shared: text and image answers, log capture, native probe
  data/
    natives-index.json         the built native reference (committed; natives:sync rebuilds it)
    optional-params.json       hand-kept arity overlay: which trailing params are optional
  scripts/
    lib.mjs                    shared helpers for the check scripts
    mock-nui.mjs               fake NUI client, also for negative tests
    smoke-test.mjs             end-to-end check through a real MCP client
    check-resource.mjs         static checks for ../fivem-mcp-bridge
    check-memory.mjs           memory-file invariants: no machine facts in committed skill files
    sync-natives.mjs           builds data/natives-index.json from the FiveM reference
    check-natives.mjs          checks transliteration, scanner, catalog and verdicts
```

The other side of the bridge is its own component, in
[`../fivem-mcp-bridge/`](../fivem-mcp-bridge).

**Known gap in the test setup:** `smoke-test.mjs` and `mock-nui.mjs` each rebuild the wire
messages themselves — together with `payload/nui.js` the protocol therefore exists three times.
If somebody renamed a field in `payload/nui.js`, the suite would stay green; only the two regex
checks in `check-resource.mjs` would notice. A shared module for the framing would be the fix,
but it founders on `payload/nui.js` running inside CEF, where it cannot import anything.
