//=============================================================================
// ClaudeBridge.js
//=============================================================================
/*:
 * @plugindesc Loopback RPC bridge so an MCP server can observe and drive the game.
 * @author laggyo + Claude
 *
 * @help
 * Starts an HTTP server on 127.0.0.1:7777 (POST /rpc, JSON body
 * {"method": "...", "params": {...}}). Requests must carry the shared secret
 * from ~/.fear-hunger-bridge-token in an X-Bridge-Token header.
 *
 * Put this plugin LAST in the plugin list.
 */

(function () {
    'use strict';

    // Under NW.js we host the HTTP server ourselves. Under a native WebKit host
    // there is no Node; the host calls window.ClaudeBridge.call() instead.
    var HAS_NODE = typeof require === 'function';

    var PORT = 7777;
    var HOST = '127.0.0.1';
    var ALLOW_EVAL = false; // cheating hatch; only flip for debugging the bridge itself

    var http, TOKEN = '';
    if (HAS_NODE) {
        http = require('http');
        var fs = require('fs');
        var os = require('os');
        var path = require('path');
        var crypto = require('crypto');

        var tokenPath = path.join(os.homedir(), '.fear-hunger-bridge-token');
        try { TOKEN = fs.readFileSync(tokenPath, 'utf8').trim(); } catch (e) { /* first run */ }
        if (!TOKEN) {
            TOKEN = crypto.randomBytes(24).toString('hex');
            fs.writeFileSync(tokenPath, TOKEN, { mode: 384 }); // 0600
        }
    }

    //-------------------------------------------------------------------------
    // Native WebKit host: saves live in files managed by the host (localStorage is ~5MB,
    // a single save here is >1MB), and some plugins drop globalId from save info.
    //-------------------------------------------------------------------------

    if (!HAS_NODE) {
        var storeReq = function (method, key, body) {
            var x = new XMLHttpRequest();
            x.open(method, '/store/' + encodeURIComponent(key), false);
            x.setRequestHeader('X-Fung-Store', '1');
            x.send(body || null);
            return x;
        };
        StorageManager.saveToWebStorage = function (id, json) {
            var x = storeReq('PUT', this.webStorageKey(id), LZString.compressToBase64(json));
            if (x.status !== 200) { throw new Error('save failed: HTTP ' + x.status); }
        };
        StorageManager.loadFromWebStorage = function (id) {
            var x = storeReq('GET', this.webStorageKey(id));
            return x.status === 200 ? LZString.decompressFromBase64(x.responseText) : null;
        };
        StorageManager.webStorageExists = function (id) {
            return storeReq('HEAD', this.webStorageKey(id)).status === 200;
        };
        StorageManager.removeWebStorage = function (id) {
            storeReq('DELETE', this.webStorageKey(id));
        };
        var _makeSavefileInfo = DataManager.makeSavefileInfo;
        DataManager.makeSavefileInfo = function () {
            var info = _makeSavefileInfo.apply(this, arguments);
            info.globalId = this._globalId;
            return info;
        };
        DataManager.isThisGameFile = function (id) {
            var gi = this.loadGlobalInfo();
            return !!(gi && gi[id]) && StorageManager.exists(id);
        };
    }

    //-------------------------------------------------------------------------
    // Frame pump: lets async handlers wait for N rendered frames
    //-------------------------------------------------------------------------

    var waiters = [];
    var frameHooks = [];

    function frames(n) {
        return new Promise(function (resolve) { waiters.push({ n: n, resolve: resolve }); });
    }

    function tick() {
        for (var i = 0; i < frameHooks.length; i++) { frameHooks[i](); }
        var still = [];
        for (var j = 0; j < waiters.length; j++) {
            var w = waiters[j];
            if (--w.n <= 0) { w.resolve(); } else { still.push(w); }
        }
        waiters = still;
    }

    var _SceneManager_update = SceneManager.update;
    SceneManager.update = function () {
        _SceneManager_update.apply(this, arguments);
        try { tick(); } catch (e) { console.error('[ClaudeBridge] tick', e); }
    };

    //-------------------------------------------------------------------------
    // Helpers
    //-------------------------------------------------------------------------

    var DIR_NAMES = { 2: 'down', 4: 'left', 6: 'right', 8: 'up' };
    var DIR_CODES = { down: 2, left: 4, right: 6, up: 8 };
    var DIR_KEYS = [2, 4, 6, 8];
    var KEYS = ['ok', 'escape', 'up', 'down', 'left', 'right', 'shift', 'pageup', 'pagedown', 'tab', 'control'];

    function sceneName() {
        var s = SceneManager._scene;
        return s ? s.constructor.name : null;
    }

    function onMap() { return sceneName() === 'Scene_Map'; }

    function needMap() {
        if (!onMap()) { throw new Error('Not on the map (scene is ' + sceneName() + ')'); }
        if (!$gamePlayer || !$gameMap) { throw new Error('No game loaded'); }
    }

    function stripCodes(text) {
        return String(text == null ? '' : text)
            .replace(/\\(?:n|nc|nr|np|nl)<([^>]*)>/gi, '[$1] ')
            .replace(/\x1b(?:n|nc|nr|np|nl)<([^>]*)>/gi, '[$1] ')
            .replace(/\\[A-Za-z]+\[\d+\]/g, '')
            .replace(/\x1b[A-Za-z]+\[\d+\]/g, '')
            .replace(/[\\\x1b][.|!<>{}^$]/g, '');
    }

    function keyDown(name, down) { Input._currentState[name] = !!down; }

    function tap(name, hold) {
        keyDown(name, true);
        return frames(hold || 3).then(function () {
            keyDown(name, false);
            return frames(2);
        });
    }

    function safe(fn, fallback) {
        try { return fn(); } catch (e) { return fallback; }
    }

    //-------------------------------------------------------------------------
    // Event knowledge
    //-------------------------------------------------------------------------

    function isSolid(ev) { return ev.isNormalPriority() && !ev.isThrough(); }

    // Fair-play event knowledge: only things a player could have seen on screen
    // (a visible sprite, inside the viewport). Sightings are remembered per map
    // (saved with the game) so something that walks out of view is still known
    // to exist, at its last seen position, until we see that it is gone.
    function isVisibleSprite(ev) {
        return !ev._erased && ev._pageIndex >= 0 && !ev.isTransparent() &&
            !!(ev.characterName() || ev.tileId() > 0);
    }

    function onScreen(ev) {
        var dx = $gameMap.displayX(), dy = $gameMap.displayY();
        return ev.x >= dx - 1 && ev.x <= dx + $gameMap.screenTileX() &&
            ev.y >= dy - 1 && ev.y <= dy + $gameMap.screenTileY();
    }

    function seenStore() {
        if (!$gameSystem._claudeSeen) { $gameSystem._claudeSeen = {}; }
        var id = $gameMap.mapId();
        return $gameSystem._claudeSeen[id] || ($gameSystem._claudeSeen[id] = {});
    }

    function updateSeen() {
        var store = seenStore();
        $gameMap.events().forEach(function (ev) {
            if (!onScreen(ev)) { return; }
            var id = ev.eventId();
            if (isVisibleSprite(ev)) {
                store[id] = { x: ev.x, y: ev.y, sprite: ev.characterName() || 'tile', solid: isSolid(ev) };
            } else {
                delete store[id];
            }
        });
    }

    function eventBrief(id, rec, px, py) {
        var ev = $gameMap.event(id);
        var live = !!ev && onScreen(ev) && isVisibleSprite(ev);
        var b = { id: id, x: live ? ev.x : rec.x, y: live ? ev.y : rec.y, sprite: rec.sprite, solid: live ? isSolid(ev) : rec.solid };
        b.dist = Math.abs(b.x - px) + Math.abs(b.y - py);
        if (live) { b.facing = DIR_NAMES[ev.direction()]; } else { b.remembered = true; }
        return b;
    }

    function knownEvent(id) {
        updateSeen();
        var rec = seenStore()[id];
        if (!rec) { throw new Error('You have not seen an event with id ' + id + ' on this map'); }
        return rec;
    }

    function nearbyEvents(radius) {
        updateSeen();
        var px = $gamePlayer.x, py = $gamePlayer.y;
        var store = seenStore();
        var out = [];
        Object.keys(store).forEach(function (id) {
            var b = eventBrief(+id, store[id], px, py);
            if (radius == null || b.dist <= radius) { out.push(b); }
        });
        out.sort(function (a, b) { return a.dist - b.dist; });
        return out;
    }

    //-------------------------------------------------------------------------
    // Map view
    //-------------------------------------------------------------------------

    var GLYPHS = '123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

    function tilePassable(x, y) {
        return DIR_KEYS.some(function (d) { return $gameMap.isPassable(x, y, d); });
    }

    function lookAround(radius, whole) {
        needMap();
        var px = $gamePlayer.x, py = $gamePlayer.y;
        var x0, x1, y0, y1;
        if (whole) {
            x0 = 0; y0 = 0; x1 = $gameMap.width() - 1; y1 = $gameMap.height() - 1;
        } else {
            x0 = Math.max(0, px - radius); x1 = Math.min($gameMap.width() - 1, px + radius);
            y0 = Math.max(0, py - radius); y1 = Math.min($gameMap.height() - 1, py + radius);
        }
        var events = nearbyEvents(null).filter(function (b) {
            return b.x >= x0 && b.x <= x1 && b.y >= y0 && b.y <= y1;
        });
        var at = {};
        var legend = [];
        events.forEach(function (b, i) {
            var g = GLYPHS.charAt(i) || '?';
            var key = b.x + ',' + b.y;
            var stacked = !!at[key];
            if (!stacked) { at[key] = g; }
            legend.push(g + ' #' + b.id + ' ' + b.sprite + ' (' + b.x + ',' + b.y + ')' +
                (b.solid ? '' : ' walkable') + (b.remembered ? ' [remembered, out of view]' : '') + (stacked ? ' [stacked]' : ''));
        });
        var rows = [];
        var header = '     ';
        for (var x = x0; x <= x1; x++) { header += (x % 10); }
        rows.push(header);
        for (var y = y0; y <= y1; y++) {
            var line = ('   ' + y).slice(-3) + '  ';
            for (x = x0; x <= x1; x++) {
                var ch;
                if (x === px && y === py) { ch = '@'; }
                else if (at[x + ',' + y]) { ch = at[x + ',' + y]; }
                else { ch = tilePassable(x, y) ? '.' : '#'; }
                line += ch;
            }
            rows.push(line);
        }
        return {
            map: mapInfo(),
            player: playerInfo(),
            view: { x0: x0, y0: y0, x1: x1, y1: y1 },
            ascii: rows.join('\n'),
            legend: legend,
            key: '@ you, # blocked, . floor, digits/letters are events (see legend); y down, x right'
        };
    }

    function mapInfo() {
        var id = $gameMap.mapId();
        var info = window.$dataMapInfos && $dataMapInfos[id];
        return {
            id: id,
            name: info ? info.name : '',
            displayName: $gameMap.displayName(),
            width: $gameMap.width(),
            height: $gameMap.height()
        };
    }

    function playerInfo() {
        return {
            x: $gamePlayer.x,
            y: $gamePlayer.y,
            facing: DIR_NAMES[$gamePlayer.direction()],
            moving: $gamePlayer.isMoving(),
            dashing: $gamePlayer.isDashing(),
            canMove: $gamePlayer.canMove()
        };
    }

    //-------------------------------------------------------------------------
    // Party / battle
    //-------------------------------------------------------------------------

    function battlerBrief(b) {
        return {
            name: b.name(),
            hp: b.hp, mhp: b.mhp,
            mp: b.mp, mmp: b.mmp,
            tp: b.tp,
            states: b.states().map(function (s) { return s.name; }),
            dead: b.isDead()
        };
    }

    function partyInfo(withSkills) {
        return $gameParty.members().map(function (a, i) {
            var m = battlerBrief(a);
            m.index = i;
            m.level = a.level;
            m.class = a.currentClass().name;
            m.equips = a.equips().filter(Boolean).map(function (e) { return e.name; });
            if (withSkills) {
                m.skills = a.skills().map(function (s) {
                    return { id: s.id, name: s.name, mp: a.skillMpCost(s), tp: a.skillTpCost(s), desc: stripCodes(s.description) };
                });
            }
            return m;
        });
    }

    function battleInfo() {
        if (!$gameParty.inBattle()) { return null; }
        var actor = safe(function () { return BattleManager.actor(); }, null);
        return {
            phase: BattleManager._phase,
            turn: $gameTroop.turnCount(),
            inputting: actor ? actor.name() : null,
            party: $gameParty.battleMembers().map(function (a, i) {
                var b = battlerBrief(a); b.index = i; return b;
            }),
            enemies: $gameTroop.members().map(function (e, i) {
                var b = battlerBrief(e); b.index = i;
                delete b.mp; delete b.mmp; delete b.tp;
                if (!b.states.length) { delete b.states; }
                if (!b.dead) { delete b.dead; }
                if (e.isHidden()) { b.hidden = true; b.untargetable = 'hidden - do not target'; }
                return b;
            })
        };
    }

    function inventoryInfo() {
        function rows(list, type) {
            return list.map(function (it) {
                return { id: it.id, type: type, name: it.name, count: $gameParty.numItems(it), desc: stripCodes(it.description) };
            });
        }
        return {
            gold: $gameParty.gold(),
            items: rows($gameParty.items(), 'item'),
            weapons: rows($gameParty.weapons(), 'weapon'),
            armors: rows($gameParty.armors(), 'armor')
        };
    }

    //-------------------------------------------------------------------------
    // UI state (message box, choice lists, battle menus, etc.)
    //-------------------------------------------------------------------------

    function messageInfo() {
        if (!$gameMessage || !$gameMessage.isBusy()) { return null; }
        var m = {
            text: stripCodes($gameMessage.allText()),
            choices: $gameMessage.isChoice() ? $gameMessage.choices().map(stripCodes) : null,
            numberInput: $gameMessage.isNumberInput(),
            itemChoice: $gameMessage.isItemChoice()
        };
        if ($gameMessage._speakerName) { m.speaker = stripCodes($gameMessage._speakerName); }
        return m;
    }

    function windowItemText(w, i) {
        var t = safe(function () {
            if (typeof w.commandName === 'function' && w._list) { return w.commandName(i); }
            if (/Savefile/.test(w.constructor.name)) {
                var info = DataManager.loadSavefileInfo(i + 1);
                return info ? 'slot ' + (i + 1) + ': ' + (info.title || '') + ' ' + (info.playtime || '') : '';
            }
            if (typeof w.table === 'function' && w._page != null) { return w.table()[w._page][i] || ''; }
            if (w._enemies && w._enemies[i]) { return w._enemies[i].name(); }
            if (w._data && w._data[i]) { return w._data[i].name; }
            if (/Actor|Status/.test(w.constructor.name)) {
                var a = $gameParty.battleMembers()[i] || $gameParty.members()[i];
                return a ? a.name() : '';
            }
            return '';
        }, '');
        return stripCodes(t);
    }

    function windowItemEnabled(w, i) {
        return safe(function () {
            if (typeof w.isCommandEnabled === 'function' && w._list) { return !!w.isCommandEnabled(i); }
            if (w._data && typeof w.isEnabled === 'function') { return !!w.isEnabled(w._data[i]); }
            return true;
        }, true);
    }

    function describeWindow(w) {
        var d = { type: w.constructor.name, active: !!w.active };
        if (w instanceof Window_Selectable) {
            var n = w.maxItems();
            d.index = w.index();
            d.total = n;
            var start = Math.max(0, Math.min(w.index() - 20, n - 40));
            d.items = [];
            for (var i = start; i < Math.min(n, start + 40); i++) {
                var it = { i: i, text: windowItemText(w, i) };
                if (/Savefile/.test(w.constructor.name) && !it.text) { continue; }
                if (!windowItemEnabled(w, i)) { it.enabled = false; }
                d.items.push(it);
            }
        } else if (w instanceof Window_Help && w._text) {
            d.text = stripCodes(w._text);
        }
        return d;
    }

    function visibleWindows() {
        var s = SceneManager._scene;
        if (!s || !s._windowLayer) { return []; }
        return s._windowLayer.children.filter(function (w) {
            return w instanceof Window_Base && w.visible && w.isOpen();
        });
    }

    function uiInfo() {
        var out = { scene: sceneName(), message: messageInfo(), windows: [] };
        visibleWindows().forEach(function (w) {
            if (w instanceof Window_BattleLog) { return; }
            if (w instanceof Window_Selectable || w instanceof Window_Help) {
                out.windows.push(describeWindow(w));
            }
        });
        return out;
    }

    function pictureInfo() {
        var out = [];
        if (!$gameScreen || !$gameScreen._pictures) { return out; }
        $gameScreen._pictures.forEach(function (pic, i) {
            if (pic && pic.name() && pic.opacity() > 0) {
                out.push({ id: i, name: pic.name(), x: Math.round(pic.x()), y: Math.round(pic.y()), opacity: Math.round(pic.opacity()) });
            }
        });
        return out;
    }

    function activeWindow() {
        var ws = visibleWindows().filter(function (w) { return w.active && w instanceof Window_Selectable; });
        return ws.length ? ws[ws.length - 1] : null;
    }

    //-------------------------------------------------------------------------
    // Walking
    //-------------------------------------------------------------------------

    var walk = null;

    function finishWalk(status, note) {
        if (!walk) { return; }
        var w = walk;
        walk = null;
        if (w.dash) { keyDown('shift', false); }
        var res = {
            status: status,
            x: $gamePlayer.x,
            y: $gamePlayer.y,
            steps_taken: w.total - w.steps.length,
            steps_total: w.total,
            scene: sceneName()
        };
        if (note) { res.note = note; }
        if (status === 'arrived' && w.faceDir) { $gamePlayer.setDirection(w.faceDir); res.facing = DIR_NAMES[w.faceDir]; }
        var msg = messageInfo();
        if (msg) { res.message = msg; }
        w.resolve(res);
    }

    var _Game_Player_moveByInput = Game_Player.prototype.moveByInput;
    Game_Player.prototype.moveByInput = function () {
        if (walk) {
            if (!this.isMoving() && this.canMove()) {
                if (!walk.steps.length) { finishWalk('arrived'); return; }
                var d = walk.steps[0];
                $gameTemp.clearDestination();
                this.moveStraight(d);
                if (this.isMovementSucceeded()) {
                    walk.steps.shift();
                    walk.stall = 0;
                } else if (++walk.stall > 3) {
                    finishWalk('blocked', 'something is in the way at ' + DIR_NAMES[d] + ' of (' + this.x + ',' + this.y + ')');
                }
            }
            return;
        }
        _Game_Player_moveByInput.call(this);
    };

    var seenTick = 0;
    frameHooks.push(function () {
        if (++seenTick % 6 === 0 && onMap() && $gameSystem && $gameMap.events) { updateSeen(); }
    });

    frameHooks.push(function () {
        if (!walk) { return; }
        if (!onMap()) { finishWalk('interrupted', 'scene changed to ' + sceneName()); return; }
        if ($gameMessage.isBusy()) { finishWalk('interrupted', 'dialogue started'); return; }
        if ($gameMap.isEventRunning()) {
            if (++walk.evFrames > 45) { finishWalk('interrupted', 'an event is running'); return; }
        } else {
            walk.evFrames = 0;
        }
        if (!walk.steps.length && !$gamePlayer.isMoving()) { finishWalk('arrived'); return; }
        if (!$gamePlayer.canMove() && !$gamePlayer.isMoving() && ++walk.idle > 180) {
            finishWalk('interrupted', 'player cannot move');
        }
    });

    // Breadth-first search using the game's own passability rules.
    function findPath(sx, sy, isGoal, hazards) {
        var W = $gameMap.width();
        var prev = {};
        var start = sx + ',' + sy;
        prev[start] = null;
        var queue = [[sx, sy]];
        for (var qi = 0; qi < queue.length; qi++) {
            var cx = queue[qi][0], cy = queue[qi][1];
            if (isGoal(cx, cy)) {
                var steps = [];
                var k = cx + ',' + cy;
                while (prev[k]) { steps.unshift(prev[k].d); k = prev[k].from; }
                return steps;
            }
            for (var i = 0; i < 4; i++) {
                var d = DIR_KEYS[i];
                var nx = $gameMap.roundXWithDirection(cx, d);
                var ny = $gameMap.roundYWithDirection(cy, d);
                var nk = nx + ',' + ny;
                if (nk in prev) { continue; }
                if (!$gamePlayer.canPass(cx, cy, d)) { continue; }
                if (hazards && hazards[nk] && !isGoal(nx, ny)) { continue; }
                prev[nk] = { from: cx + ',' + cy, d: d };
                queue.push([nx, ny]);
            }
        }
        return null;
    }

    // Touch-trigger events that transfer, start battles, or hurt (or visible chasers).
    var HAZARD_CODES = [201, 301, 311, 313, 322, 339];

    function hazardMap() {
        var h = {};
        $gameMap.events().forEach(function (ev) {
            if (ev._erased || ev._pageIndex < 0) { return; }
            if (ev._trigger !== 1 && ev._trigger !== 2) { return; }
            var list = ev.list();
            var dangerous = list.some(function (c) { return HAZARD_CODES.indexOf(c.code) >= 0; }) ||
                (ev._trigger === 2 && ev.characterName() && list.length > 1);
            if (dangerous) { h[ev.x + ',' + ev.y] = ev.event().name + '#' + ev.eventId(); }
        });
        return h;
    }

    var WALK_REPLY_MS = 45000;

    function startWalk(steps, opts) {
        var p = new Promise(function (resolve) {
            walk = { steps: steps.slice(), total: steps.length, stall: 0, idle: 0, evFrames: 0, dash: !!opts.dash, faceDir: opts.faceDir || 0, resolve: resolve };
            if (walk.dash) { keyDown('shift', true); }
            if (!steps.length) { finishWalk('arrived'); }
        });
        // Reply before the MCP client times out; the walk keeps going.
        var timer;
        var deadline = new Promise(function (resolve) {
            timer = setTimeout(function () {
                resolve({ status: 'walking', x: $gamePlayer.x, y: $gamePlayer.y,
                    note: 'still walking; call observe to check progress or stop_walk to cancel' });
            }, WALK_REPLY_MS);
        });
        return Promise.race([p, deadline]).then(function (r) { clearTimeout(timer); return r; });
    }

    function checkCanStartWalk() {
        needMap();
        if (walk) { throw new Error('A walk is already in progress'); }
        if ($gameMessage.isBusy() || $gameMap.isEventRunning()) {
            throw new Error('Cannot walk: dialogue/event is active. Use advance_dialogue first.');
        }
        if ($gamePlayer.isMoving()) { return frames(20); }
        return Promise.resolve();
    }

    //-------------------------------------------------------------------------
    // RPC handlers
    //-------------------------------------------------------------------------

    var H = {};

    H.ping = function () {
        return { ok: true, scene: sceneName(), title: document.title };
    };

    H.observe = function (p) {
        var radius = p.radius != null ? p.radius : 7;
        var out = { scene: sceneName() };
        if ($gameParty && $gameParty.inBattle()) {
            out.battle = battleInfo();
        } else if (onMap() && $gamePlayer) {
            out.map = mapInfo();
            out.player = playerInfo();
            out.events = nearbyEvents(radius);
            out.walking = !!walk;
        }
        if (window.$gameParty && $gameParty.members) {
            out.party = $gameParty.members().map(function (a) {
                var b = battlerBrief(a); return b;
            });
            out.gold = $gameParty.gold();
        }
        var pics = pictureInfo();
        if (pics.length) { out.pictures = pics; }
        var ui = uiInfo();
        out.message = ui.message;
        out.windows = ui.windows;
        return out;
    };

    // Measures how fast the game loop actually runs (updates per second over ~2s).
    H.perf = function () {
        var n = 0;
        var hook = function () { n++; };
        frameHooks.push(hook);
        var t0 = Date.now();
        return new Promise(function (resolve) {
            setTimeout(function () {
                frameHooks.splice(frameHooks.indexOf(hook), 1);
                var secs = (Date.now() - t0) / 1000;
                resolve({ fps: Math.round(n / secs * 10) / 10, seconds: secs, scene: sceneName(),
                          focus: document.hasFocus(), visibility: document.visibilityState });
            }, 2000);
        });
    };

    H.look = function (p) { return lookAround(p.radius != null ? p.radius : 8, !!p.whole); };

    H.events = function (p) {
        needMap();
        return nearbyEvents(p.radius != null ? p.radius : null);
    };

    H.peek_event = function (p) {
        needMap();
        var rec = knownEvent(p.id);
        return eventBrief(p.id, rec, $gamePlayer.x, $gamePlayer.y);
    };

    H.party = function (p) { return { gold: $gameParty.gold(), members: partyInfo(!!p.skills) }; };
    H.inventory = function () { return inventoryInfo(); };
    H.battle = function () {
        var b = battleInfo();
        if (!b) { throw new Error('Not in battle'); }
        b.ui = uiInfo();
        return b;
    };
    H.ui = function () { return uiInfo(); };

    // Wait (up to ~1.5s) for a selectable window to finish opening and become active.
    function whenWindowActive(tries) {
        var w = activeWindow();
        if (w || tries <= 0) { return Promise.resolve(w); }
        return frames(3).then(function () { return whenWindowActive(tries - 3); });
    }

    H.ui_choose = function (p) {
        return whenWindowActive(90).then(function (w) { return chooseIn(w, p); });
    };

    function chooseIn(w, p) {
        if (!w) { throw new Error('No active menu/choice window. Current UI: ' + JSON.stringify(uiInfo())); }
        var i = p.index;
        if (i < 0 || i >= w.maxItems()) { throw new Error('Index out of range 0..' + (w.maxItems() - 1)); }
        w.select(i);
        var enabled = windowItemEnabled(w, i);
        if (p.confirm === false) { return frames(2).then(uiInfo); }
        if (!enabled) { return uiInfo(); }
        return tap('ok').then(function () { return frames(4); }).then(uiInfo);
    }

    H.ui_cancel = function () {
        return tap('escape').then(function () { return frames(4); }).then(uiInfo);
    };

    H.press = function (p) {
        var seq = p.keys || [];
        var chain = Promise.resolve();
        seq.forEach(function (k) {
            var name = typeof k === 'string' ? k : k.key;
            var count = typeof k === 'string' ? 1 : (k.count || 1);
            if (KEYS.indexOf(name) < 0) { throw new Error('Unknown key ' + name + '; use one of ' + KEYS.join(', ')); }
            for (var i = 0; i < count; i++) {
                chain = chain.then(function () { return tap(name, p.hold); });
            }
        });
        return chain.then(function () { return frames(3); }).then(uiInfo);
    };

    H.wait = function (p) {
        return frames(Math.max(1, Math.min(600, p.frames || 30))).then(function () { return H.observe({}); });
    };

    H.advance_dialogue = function (p) {
        var max = p.max || 60;
        var seen = [];
        var iter = 0;
        var quiet = 0;
        function record() {
            var m = messageInfo();
            if (!m) { return null; }
            var line = (m.speaker ? '[' + m.speaker + '] ' : '') + m.text;
            if (seen[seen.length - 1] !== line) { seen.push(line); }
            return m;
        }
        function loop() {
            var m = record();
            if (m && (m.choices || m.numberInput || m.itemChoice)) {
                return whenWindowActive(90).then(function () { return { stopped: 'choice', text: seen, ui: uiInfo() }; });
            }
            if (!m) {
                if (++quiet > 8 || !$gameMap || !$gameMap.isEventRunning()) {
                    return Promise.resolve({ stopped: 'done', text: seen, ui: uiInfo() });
                }
                return frames(3).then(loop);
            }
            quiet = 0;
            if (++iter > max) { return Promise.resolve({ stopped: 'max', text: seen, ui: uiInfo() }); }
            return frames(6).then(function () { record(); return tap('ok'); }).then(loop);
        }
        return loop();
    };

    H.walk_to = function (p) {
        return Promise.resolve(checkCanStartWalk()).then(function () {
            var tx = p.x, ty = p.y, adjacent = !!p.adjacent;
            if (p.event_id != null) {
                var rec = knownEvent(p.event_id);
                var ev = $gameMap.event(p.event_id);
                var seenNow = ev && onScreen(ev) && isVisibleSprite(ev);
                tx = seenNow ? ev.x : rec.x; ty = seenNow ? ev.y : rec.y;
                if (p.adjacent == null) { adjacent = rec.solid; }
            }
            if (tx == null || ty == null) { throw new Error('Give x and y, or event_id'); }
            var px = $gamePlayer.x, py = $gamePlayer.y;
            var goalKey = {};
            if (adjacent) {
                DIR_KEYS.forEach(function (d) {
                    goalKey[$gameMap.roundXWithDirection(tx, d) + ',' + $gameMap.roundYWithDirection(ty, d)] = d;
                });
            } else {
                goalKey[tx + ',' + ty] = 0;
            }
            var isGoal = function (x, y) { return (x + ',' + y) in goalKey; };
            var hazards = p.allow_hazards ? null : hazardMap();
            var steps = findPath(px, py, isGoal, hazards);
            if (!steps && hazards) {
                var risky = findPath(px, py, isGoal, null);
                if (risky) {
                    var cx = px, cy = py, crossed = [];
                    risky.forEach(function (d) {
                        cx = $gameMap.roundXWithDirection(cx, d); cy = $gameMap.roundYWithDirection(cy, d);
                        if (hazards[cx + ',' + cy]) { crossed.push(hazards[cx + ',' + cy] + ' at (' + cx + ',' + cy + ')'); }
                    });
                    return { status: 'no_safe_path', crosses: crossed, x: px, y: py,
                        note: 'Only path crosses touch-trigger events that transfer/battle/hurt. Retry with allow_hazards=true to accept.' };
                }
            }
            if (!steps) { return { status: 'no_path', note: 'target unreachable', x: px, y: py }; }
            var faceDir = 0;
            if (adjacent) {
                // face the target from the tile we end on
                var ex = px, ey = py;
                steps.forEach(function (d) { ex = $gameMap.roundXWithDirection(ex, d); ey = $gameMap.roundYWithDirection(ey, d); });
                DIR_KEYS.forEach(function (d) {
                    if ($gameMap.roundXWithDirection(ex, d) === tx && $gameMap.roundYWithDirection(ey, d) === ty) { faceDir = d; }
                });
            }
            return startWalk(steps, { dash: p.dash, faceDir: faceDir });
        });
    };

    H.walk = function (p) {
        return Promise.resolve(checkCanStartWalk()).then(function () {
            var steps = [];
            (p.steps || []).forEach(function (s) {
                var d = DIR_CODES[s.dir];
                if (!d) { throw new Error('Bad dir ' + s.dir); }
                for (var i = 0; i < (s.n || 1); i++) { steps.push(d); }
            });
            return startWalk(steps, { dash: p.dash });
        });
    };

    H.stop_walk = function () {
        finishWalk('interrupted', 'stopped by request');
        return playerInfo();
    };

    H.face = function (p) {
        needMap();
        var d = DIR_CODES[p.dir];
        if (!d) { throw new Error('Bad dir'); }
        $gamePlayer.setDirection(d);
        return playerInfo();
    };

    H.interact = function (p) {
        needMap();
        if ($gameMessage.isBusy()) { throw new Error('Dialogue already active; use advance_dialogue'); }
        if (p.dir) { $gamePlayer.setDirection(DIR_CODES[p.dir]); }
        var px = $gamePlayer.x, py = $gamePlayer.y;
        var d = $gamePlayer.direction();
        var fx = $gameMap.roundXWithDirection(px, d), fy = $gameMap.roundYWithDirection(py, d);
        return tap('ok').then(function () { return frames(6); }).then(function () {
            return {
                facing: DIR_NAMES[d],
                target_tile: { x: fx, y: fy },
                event_started: $gameMap.isEventRunning() || $gameMessage.isBusy(),
                message: messageInfo(),
                scene: sceneName()
            };
        });
    };

    H.screenshot = function () {
        var bmp = SceneManager.snap();
        var url = bmp.canvas.toDataURL('image/png');
        return { mime: 'image/png', data: url.replace(/^data:image\/png;base64,/, ''), width: bmp.width, height: bmp.height };
    };

    H.eval = function (p) {
        if (!ALLOW_EVAL) { throw new Error('eval disabled'); }
        /* eslint-disable no-eval */
        var r = (0, eval)(p.code);
        return Promise.resolve(r).then(function (v) {
            try { return JSON.parse(JSON.stringify(v === undefined ? null : v)); } catch (e) { return String(v); }
        });
    };

    //-------------------------------------------------------------------------
    // HTTP server
    //-------------------------------------------------------------------------

    // Every handler runs one at a time so overlapping calls can't fight over
    // the same input/menu state. stop_walk and ping bypass the queue so a
    // long walk can still be interrupted.
    var queue = Promise.resolve();
    var UNQUEUED = { stop_walk: 1, ping: 1 };
    function run(method, fn, params) {
        function exec() {
            try { return Promise.resolve(fn(params)); } catch (e) { return Promise.reject(e); }
        }
        if (UNQUEUED[method]) { return exec(); }
        var result = queue.then(exec);
        queue = result.then(function () {}, function () {});
        return result;
    }

    var server = null;
    if (HAS_NODE) {
        var server = http.createServer(function (req, res) {
            function send(code, obj) {
                var body = JSON.stringify(obj);
                res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
                res.end(body);
            }
            if (req.method !== 'POST' || req.url !== '/rpc') { return send(404, { error: 'not found' }); }
            if (req.headers.origin || req.headers['x-bridge-token'] !== TOKEN) { return send(403, { error: 'forbidden' }); }
            var chunks = [];
            var size = 0;
            req.on('data', function (c) {
                size += c.length;
                if (size > 1e6) { req.destroy(); return; }
                chunks.push(c);
            });
            req.on('end', function () {
                var msg;
                try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return send(400, { error: 'bad json' }); }
                var fn = H[msg.method];
                if (!fn) { return send(200, { error: 'unknown method ' + msg.method }); }
                var started = run(msg.method, fn, msg.params || {});
                started.then(
                    function (r) { send(200, { result: r }); },
                    function (e) { send(200, { error: String(e && e.message || e) }); }
                );
            });
        });

        server.on('error', function (e) { console.error('[ClaudeBridge] server error', e && e.message); });
        server.listen(PORT, HOST, function () { console.log('[ClaudeBridge] listening on ' + HOST + ':' + PORT); });

    }

    window.ClaudeBridge = {
        handlers: H,
        server: server,
        call: function (method, params) {
            var fn = H[method];
            if (!fn) { return Promise.reject(new Error('unknown method ' + method)); }
            return run(method, fn, params || {});
        }
    };
})();
