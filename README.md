# fear-hunger-mcp

Setup: `cd server && npm install`, then `./install.sh install`. Requires the game (RPG Maker MV / NW.js build) installed at `/Applications/Fear and Hunger 2 Termina.app` (override with `GAME_APP`). Contains no game assets, only the plugin, server and installer.

Lets Claude see and drive Fear & Hunger 2: Termina.

- `game-plugin/ClaudeBridge.js` - RPG Maker MV plugin. Runs a loopback-only HTTP server (127.0.0.1:7777) inside the game, protected by a token in `~/.fear-hunger-bridge-token`.
- `server/index.js` - MCP server (stdio) that forwards tools to the plugin.
- `install.sh` - copies the plugin into the game and registers it (backs up `plugins.js` first).

```
./install.sh install      # then (re)start the game
./install.sh uninstall    # restores the original plugins.js
```

Start Claude Code in this folder (`.mcp.json` registers the server), or:
`claude mcp add fear-hunger -- node /path/to/repo/server/index.js`

Tools: observe, look, events, peek_event, walk_to, walk, stop_walk, face, interact,
advance_dialogue, ui, ui_choose, ui_cancel, press, wait, party, inventory, battle,
screenshot. (`debug_eval` exists only if FUNGER_ALLOW_EVAL=1 and the plugin flag is flipped - off by default, it is a cheat hatch.)

Notes: the game window must stay visible (not minimised) or it stops rendering frames.
Re-run `./install.sh install` after any game update that overwrites plugins.js.

## Fair-play rules for Claude
No teleporting, wall-walking, forcing dialogue options/skills/items the game doesn't offer, targeting hidden enemy parts, or editing game state. Use only the game's own menus and movement. Event info (`observe`, `look`, `events`, `peek_event`) only covers what a player has seen: visible sprites, remembered at their last known position once out of view. It never decodes what an event does.

## Native WebKit / arm64 launcher

`wk-host/` builds **Termina WebKit Launcher.app**: a universal (arm64 + Intel) Swift app that runs the game in Apple's WebKit
instead of the old Intel-only NW.js. It contains **no game data**: it finds (or asks for) your own copy of the game and serves it
in place, unmodified, injecting its shims at runtime.

```
./wk-host/build.sh       # -> build/Termina WebKit Launcher.app
./wk-host/run.sh         # dev launch with the MCP bridge enabled (FUNGER_BRIDGE=1)
./wk-host/make-dmg.sh    # -> build/Termina-WebKit-Launcher.dmg (launcher only; refuses to build if game files are inside)
```

- Saves are files in `~/Library/Application Support/FungerWK/store` (not shared with the NW.js version).
- The MCP `/rpc` endpoint is **off** unless `FUNGER_BRIDGE=1`; only one instance at a time (port 7777).
- WebKit runs at 30 fps in Low Power Mode or when the window isn't frontmost; 60 fps when you play in it.
- `perf` (bridge method) reports fps, frame-time percentiles and lag-spike counts. `DEBUG_EVAL=1 ./wk-host/build.sh` enables the eval hatch (testing only).
- Please don't distribute the game itself; the DMG intentionally ships only the launcher.
