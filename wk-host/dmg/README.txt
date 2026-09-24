Termina WebKit Launcher
=======================

An unofficial, native macOS launcher (Apple Silicon + Intel) for YOUR OWN copy of
"Fear & Hunger 2: Termina". It does NOT contain the game. You need to own the game
(Steam / itch.io) - please buy it from its creator
(the developer is Miro Haverinen; this project is not affiliated with him).

Why? It runs the game in Apple's WebKit instead of the old Intel-only NW.js it ships with,
so it is native on Apple Silicon, uses less CPU/battery, and keeps running smoothly.
Your game files are never modified.

Install
-------
1. Drag "Termina WebKit Launcher" onto Applications.
2. First launch: macOS will say it can't verify the app (it is not notarized). Either
   - right-click the app > Open > Open, or
   - run:  xattr -dr com.apple.quarantine "/Applications/Termina WebKit Launcher.app"
3. It looks for your game automatically (Applications, Steam folder). If it can't
   find it, pick the game (.app, or its folder) when asked. It remembers your choice.
   ("Choose Game Location..." in the app menu resets it.)

Notes
-----
- Saves are stored in ~/Library/Application Support/FungerWK/store (NOT shared with the
  original app's saves). Copy that folder to back them up.
- Fullscreen: F4 or Ctrl+Cmd+F. Reload (if it ever freezes): Cmd+R.
- WebKit caps the game at 30 fps while macOS "Low Power Mode" is on, or while the game window is not the frontmost app (60 fps when you are playing in it).
- Only one instance can run at a time (it uses 127.0.0.1:7777 locally).
- Requires macOS 13.3 or newer.
