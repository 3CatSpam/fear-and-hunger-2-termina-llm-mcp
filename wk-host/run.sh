#!/bin/zsh
# Launch the WebKit build. (Double-clicking the .app also works; this is the fallback if LaunchServices refuses.)
APP="$(cd "$(dirname "$0")/.." && pwd)/build/Fear and Hunger 2 Termina (WebKit).app"
exec "$APP/Contents/MacOS/FungerWK"
