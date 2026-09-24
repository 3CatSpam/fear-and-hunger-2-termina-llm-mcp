#!/bin/zsh
# Dev launcher: runs the launcher against the installed game with the MCP bridge enabled.
APP="$(cd "$(dirname "$0")/.." && pwd)/build/Termina WebKit Launcher.app"
export FUNGER_BRIDGE=1
export FUNGER_ROOT="${FUNGER_ROOT:-/Applications/Fear and Hunger 2 Termina.app/Contents/Resources/app.nw}"
exec "$APP/Contents/MacOS/FungerWK"
