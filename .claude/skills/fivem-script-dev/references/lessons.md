# Lessons — accumulated runtime learnings

What past sessions tried that did not work as expected. **Read this at preflight; append an
entry the moment a surprise is resolved** — not at session end, when the detail is already
fading. Entries here are portable: true on any machine running this stack. Machine facts
(paths, server addresses, display setup) go in `.fivem-mcp/memory.md` at the repo root
instead — `mcp-server/scripts/check-memory.mjs` fails `npm test` if they leak in here.

**Record** when: a debugging detour ends in a non-obvious cause; a prototyped approach
failed for a reason the docs don't state; a native behaved differently than its reference
suggests. **Don't record**: one-off typos, transient environment hiccups, or anything the
skill references already cover — a duplicate entry is noise that costs every future
preflight.

**Format** — one `###` per lesson, all four fields, no essays:

```
### Imperative one-line takeaway
- **Date**: YYYY-MM-DD · **Area**: natives | deploy | bridge | server | tooling
- **Tried**: what was attempted
- **Happened**: the observed surprise
- **Instead**: what to do
```

**Compaction**: hard caps (enforced by `check-memory.mjs`) are 40 entries / 400 lines. When
close, compact: merge near-duplicates, delete entries the references have since absorbed,
and *graduate* stable symptom-shaped lessons into the failure-signature table in
`references/debugging.md` (then delete them here). `debugging.md` is curated canon; this
file is its inbox.

## Entries

### Never return a table whose keys mix numbers and strings through the bridge
- **Date**: 2026-10-23 · **Area**: bridge
- **Tried**: fivem_run_code returning a list of every object from GetGamePool within 15 m (more than MAX_KEYS = 60 entries)
- **Happened**: the client crashed with `msgpack::v1::type_error` in `nui-resources.dll` -- the old marshal truncated the array and added a `'…'` string key, and the NUI callback's msgpack -> JSON step throws on a map with non-string keys, killing the game
- **Instead**: marshal.lua now keeps arrays as arrays (truncation note as the last element) and stringifies all other keys; the resource needs a restart to load it

### A cold fivem_launch can die at the Rockstar handoff -- relaunch with force
- **Date**: 2026-08-08 · **Area**: tooling
- **Tried**: fivem_launch with waitMs 180000 as the first game start after a PC reboot
- **Happened**: the client log stopped right after `pre-gameload component gta:game:five` / ROSLauncher `SetGameLaunchState -> running`, the FiveM process exited leaving only `launcher-x64` alive, and fivem_read_crash showed no new crash -- a silent exit, not a crash, so nothing in the logs explains it
- **Instead**: treat "log static + FiveM process gone + no new crash" as the ROS/Epic launcher not being warm yet; call fivem_launch again with `force: true` (the second attempt connected in 40 s). Do not spend the wait re-reading an empty log -- check `Get-Process FiveM*` to tell "still loading" from "already exited"

### A stopping resource gets onResourceStop, never onClientResourceStop
- **Date**: 2026-08-07 · **Area**: natives
- **Tried**: teardown via AddEventHandler('onClientResourceStop') in the resource being stopped, plus server farewell events to the client
- **Happened**: neither fired -- onClientResourceStop is not delivered to the stopping resource itself, and server events queued during the stop never arrive
- **Instead**: handle `onResourceStop` (compare the name argument to GetCurrentResourceName()) and make the client self-restore; never rely on the server saying goodbye

### Teardown handlers die at their first Wait()
- **Date**: 2026-08-07 · **Area**: natives
- **Tried**: onResourceStop handler that faded the screen and Wait()ed between restore steps
- **Happened**: the coroutine is destroyed at its first yield during resource stop; everything after the first Wait() silently never ran
- **Instead**: teardown must be strictly synchronous -- no Wait(), no CreateThread; do every restore call inline before returning

### Do risky player setup before fading the screen out
- **Date**: 2026-08-07 · **Area**: deploy
- **Tried**: DoScreenFadeOut, then teleport/model/loadout setup, then fade in
- **Happened**: a throw between the fades stranded the player on a black screen with no error visible in-game
- **Instead**: run everything that can throw while the screen is still visible, and fade only around the instant switch; guard the fade-in in a pcall-else path

### A dropped SetHttpHandler leaves a hanging mount until full server restart
- **Date**: 2026-08-07 · **Area**: server
- **Tried**: registering SetHttpHandler behind a config flag, then restarting the resource with the flag off
- **Happened**: requests to the resource's HTTP path neither ran the old handler nor got a 404 -- they hung until client timeout; only a resource that never registered a handler 404s instantly
- **Instead**: treat handler removal as needing a full FXServer restart to take effect cleanly; design HTTP handlers to check their flag per-request if instant disable matters

### Rapid MCP restarts trip txAdmin's login rate limit
- **Date**: 2026-08-07 · **Area**: server
- **Tried**: driving tools by spawning a fresh MCP server process per call; each one logged into txAdmin anew
- **Happened**: after a burst of logins txAdmin banned the IP for 15 minutes ("Too many attempts"), taking fivem_server_console/fivem_server_command down with it
- **Instead**: keep one MCP process alive and reuse its session; if scripting tool calls, drive one long-lived process instead of one process per call

### Spawn protection needs SetPlayerInvincible, not SetEntityInvincible
- **Date**: 2026-08-07 · **Area**: natives
- **Tried**: granting post-respawn invincibility with SetEntityInvincible(ped, true) and asserting it with GetPlayerInvincible
- **Happened**: GetPlayerInvincible kept returning false -- the entity flag and the player flag are separate, so the protection window was not observable from a probe (and looked like a bug that was not one)
- **Instead**: use SetPlayerInvincible(PlayerId(), true/false) for player protection; it is what GetPlayerInvincible reports, so the window can be proven with a sampling probe

### A table member written inside `local t = { ... }` cannot call its siblings
- **Date**: 2026-08-07 · **Area**: server
- **Tried**: a provider table `local items = { count = function() end, canCarry = function(...) return items.count(...) end }`, then calling it through a `pcall` wrapper
- **Happened**: `items` is not in scope inside its own constructor, so the sibling call indexed a nil global and threw; the `pcall` turned that into a plain `false`, which read as "player cannot carry that" and sent the debugging hours in the wrong direction
- **Instead**: declare `local t = {}` first and add members with `function t.name() end`; and never let a `pcall` wrapper swallow the error message -- log it, or a broken integration is indistinguishable from a legitimate refusal

### Drive a keybind path with SetControlNormal instead of leaving it untested
- **Date**: 2026-08-07 · **Area**: natives
- **Tried**: verifying an `IsControlJustReleased` interaction, which no MCP tool can press
- **Happened**: the temp-command pattern would have skipped the real trigger wiring entirely
- **Instead**: hold the control from a `ctx.thread` with `SetControlNormal(0, control, 1.0)` and `Wait(0)` for a few frames, then stop setting it -- the release edge fires in the resource under test, so the actual keybind path gets exercised

### fivem_run_code sees only the bridge resource's globals
- **Date**: 2026-08-07 · **Area**: bridge
- **Tried**: reading a resource-under-test's module table (a global in that resource) from a fivem_run_code snippet
- **Happened**: nil -- snippets eval in the bridge resource's own Lua state, and Lua states are per-resource by design
- **Instead**: go through the other resource's exports, events, or registered commands; the tool description now says so too
