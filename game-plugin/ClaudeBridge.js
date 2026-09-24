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

    if (typeof require !== 'function') { return; }

    var PORT = 7777;
    var HOST = '127.0.0.1';
    var ALLOW_EVAL = false; // cheating hatch; only flip for debugging the bridge itself

    var http = require('http');
    var fs = require('fs');
    var os = require('os');
    var path = require('path');
    var crypto = require('crypto');

    //-------------------------------------------------------------------------
    // Auth token
    //-------------------------------------------------------------------------

    var tokenPath = path.join(os.homedir(), '.fear-hunger-bridge-token');
    var TOKEN = '';
    try { TOKEN = fs.readFileSync(tokenPath, 'utf8').trim(); } catch (e) { /* first run */ }
    if (!TOKEN) {
        TOKEN = crypto.randomBytes(24).toString('hex');
        fs.writeFileSync(tokenPath, TOKEN, { mode: 384 }); // 0600
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
    var TRIGGERS = ['action', 'player-touch', 'event-touch', 'autorun', 'parallel'];
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
    // Event inspection
    //-------------------------------------------------------------------------

    function itemName(type, id) {
        var db = type === 'weapon' ? $dataWeapons : type === 'armor' ? $dataArmors : $dataItems;
        return db[id] ? db[id].name : type + '#' + id;
    }

    // Turn an event command list into human-readable lines.
    function decode(list) {
        var out = [];
        var say = null;
        function flush() { if (say !== null) { out.push('SAY: ' + say); say = null; } }
        (list || []).forEach(function (c) {
            var p = c.parameters;
            if (c.code !== 401) { flush(); }
            switch (c.code) {
            case 0: break;
            case 101: break;
            case 401: say = (say === null ? '' : say + ' ') + stripCodes(p[0]); break;
            case 102: out.push('CHOICES: ' + p[0].map(stripCodes).join(' | ')); break;
            case 402: out.push('  when choice "' + stripCodes(p[1]) + '":'); break;
            case 404: break;
            case 108: case 408: out.push('COMMENT: ' + p[0]); break;
            case 111: out.push('IF ' + decodeCondition(p)); break;
            case 411: out.push('ELSE'); break;
            case 412: out.push('END IF'); break;
            case 112: out.push('LOOP'); break;
            case 113: out.push('BREAK LOOP'); break;
            case 115: out.push('EXIT EVENT'); break;
            case 117: out.push('COMMON EVENT: ' + (($dataCommonEvents[p[0]] || {}).name || p[0])); break;
            case 121: out.push('SWITCH ' + p[0] + (p[1] !== p[0] ? '..' + p[1] : '') + ' = ' + (p[2] === 0 ? 'ON' : 'OFF')); break;
            case 122: out.push('VARIABLE ' + p[0] + (p[1] !== p[0] ? '..' + p[1] : '') + ' op' + p[2] + ' (type ' + p[3] + ', ' + p[4] + ')'); break;
            case 123: out.push('SELF SWITCH ' + p[0] + ' = ' + (p[1] === 0 ? 'ON' : 'OFF')); break;
            case 125: out.push('GOLD ' + (p[0] === 0 ? '+' : '-') + (p[1] === 0 ? p[2] : 'var' + p[2])); break;
            case 126: out.push('ITEM ' + (p[1] === 0 ? '+' : '-') + (p[2] === 0 ? p[3] : 'var' + p[3]) + ' ' + itemName('item', p[0])); break;
            case 127: out.push('WEAPON ' + (p[1] === 0 ? '+' : '-') + ' ' + itemName('weapon', p[0])); break;
            case 128: out.push('ARMOR ' + (p[1] === 0 ? '+' : '-') + ' ' + itemName('armor', p[0])); break;
            case 201:
                out.push(p[0] === 0
                    ? 'TRANSFER -> map ' + p[1] + ' (' + p[2] + ',' + p[3] + ')' + mapNameHint(p[1])
                    : 'TRANSFER -> (variable-designated)');
                break;
            case 205: out.push('MOVE ROUTE'); break;
            case 211: case 212: case 213: break;
            case 221: case 222: case 223: case 224: case 225: break;
            case 230: out.push('WAIT ' + p[0]); break;
            case 241: out.push('BGM: ' + (p[0] && p[0].name)); break;
            case 250: out.push('SE: ' + (p[0] && p[0].name)); break;
            case 301: {
                var tid = p[0] === 0 ? p[1] : null;
                out.push('BATTLE: ' + (tid ? (($dataTroops[tid] || {}).name || 'troop ' + tid) : '(variable troop)') +
                    (p[2] ? ' [can escape]' : '') + (p[3] ? ' [can lose]' : ''));
                break;
            }
            case 601: out.push('  on win:'); break;
            case 602: out.push('  on escape:'); break;
            case 603: out.push('  on lose:'); break;
            case 302: out.push('SHOP'); break;
            case 311: out.push('CHANGE HP'); break;
            case 313: out.push('CHANGE STATE ' + (p[3] === 0 ? '+' : '-') + ' ' + (($dataStates[p[4]] || {}).name || p[4])); break;
            case 314: out.push('RECOVER ALL'); break;
            case 355: say = null; out.push('SCRIPT: ' + p[0]); break;
            case 655: out.push('  ...' + p[0]); break;
            case 356: out.push('PLUGIN CMD: ' + p[0]); break;
            case 132: case 133: case 134: case 135: case 136: case 137: case 138: break;
            default: out.push('(cmd ' + c.code + ')'); break;
            }
        });
        flush();
        return out;
    }

    function mapNameHint(id) {
        var info = window.$dataMapInfos && $dataMapInfos[id];
        return info ? ' "' + info.name + '"' : '';
    }

    function decodeCondition(p) {
        switch (p[0]) {
        case 0: return 'switch ' + p[1] + ' is ' + (p[2] === 0 ? 'ON' : 'OFF');
        case 1: return 'variable ' + p[1] + ' ' + ['==', '>=', '<=', '>', '<', '!='][p[4]] + ' ' + (p[2] === 0 ? p[3] : 'var' + p[3]);
        case 2: return 'self-switch ' + p[1] + ' is ' + (p[2] === 0 ? 'ON' : 'OFF');
        case 3: return 'timer';
        case 4: return 'actor ' + p[1] + ' cond ' + p[2] + ' ' + p[3];
        case 5: return 'enemy';
        case 6: return 'character facing';
        case 7: return 'gold ' + ['>=', '<=', '<'][p[2]] + ' ' + p[1];
        case 8: return 'has item ' + itemName('item', p[1]);
        case 9: return 'has weapon ' + itemName('weapon', p[1]);
        case 10: return 'has armor ' + itemName('armor', p[1]);
        case 11: return 'button ' + p[1];
        case 12: return 'script: ' + p[1];
        default: return 'cond ' + p[0];
        }
    }

    function eventById(id) {
        var ev = $gameMap.event(id);
        if (!ev) { throw new Error('No event with id ' + id + ' on this map'); }
        return ev;
    }

    function isSolid(ev) { return ev.isNormalPriority() && !ev.isThrough(); }

    function eventBrief(ev, px, py) {
        var list = ev.list();
        var lines = decode(list);
        var say = lines.filter(function (l) { return l.indexOf('SAY: ') === 0; })[0];
        var transfer = lines.filter(function (l) { return l.indexOf('TRANSFER') === 0; })[0];
        var battle = lines.filter(function (l) { return l.indexOf('BATTLE') === 0; })[0];
        var b = {
            id: ev.eventId(),
            name: ev.event().name,
            x: ev.x,
            y: ev.y,
            dist: Math.abs(ev.x - px) + Math.abs(ev.y - py),
            facing: DIR_NAMES[ev.direction()],
            sprite: ev.characterName() || '',
            trigger: TRIGGERS[ev._trigger],
            solid: isSolid(ev)
        };
        if (ev.event().note) { b.note = ev.event().note; }
        if (say) { b.says = say.slice(5, 80); }
        if (transfer) { b.transfer = transfer.slice(12); }
        if (battle) { b.battle = battle.slice(8); }
        if (!ev.characterName() && !ev.isTile) { b.invisible = true; }
        b.commands = list.length - 1;
        return b;
    }

    function isInteresting(ev) {
        if (ev._erased || ev._pageIndex < 0) { return false; }
        if (ev.characterName()) { return true; }
        if (ev.list().length <= 1 || ev._trigger > 2) { return false; }
        return ev.list().some(function (c) { return c.code === 401 || c.code === 201 || c.code === 301 || c.code === 126 || c.code === 127 || c.code === 128; });
    }

    // Invisible touch trigger that does nothing obviously notable (fog reveals, sound cues, traps...).
    function isHiddenTrigger(ev) {
        return !ev._erased && ev._pageIndex >= 0 && ev._trigger >= 1 && ev._trigger <= 2 &&
            ev.list().length > 1 && !isInteresting(ev);
    }

    function nearbyEvents(radius, all) {
        var px = $gamePlayer.x, py = $gamePlayer.y;
        var out = [];
        $gameMap.events().forEach(function (ev) {
            if (!all && !isInteresting(ev)) { return; }
            if (all && (ev._erased || ev._pageIndex < 0)) { return; }
            var d = Math.abs(ev.x - px) + Math.abs(ev.y - py);
            if (radius != null && d > radius) { return; }
            out.push(eventBrief(ev, px, py));
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
        var events = $gameMap.events().filter(function (ev) {
            return isInteresting(ev) && ev.x >= x0 && ev.x <= x1 && ev.y >= y0 && ev.y <= y1;
        }).sort(function (a, b) {
            return (Math.abs(a.x - px) + Math.abs(a.y - py)) - (Math.abs(b.x - px) + Math.abs(b.y - py));
        });
        var at = {};
        var hidden = {};
        $gameMap.events().forEach(function (ev) { if (isHiddenTrigger(ev)) { hidden[ev.x + ',' + ev.y] = true; } });
        var legend = [];
        events.forEach(function (ev, i) {
            var g = GLYPHS.charAt(i) || '?';
            var key = ev.x + ',' + ev.y;
            var stacked = !!at[key];
            if (!stacked) { at[key] = g; }
            legend.push(g + ' #' + ev.eventId() + ' ' + ev.event().name + ' (' + ev.x + ',' + ev.y + ') ' +
                TRIGGERS[ev._trigger] + (isSolid(ev) ? '' : ' walkable') + (stacked ? ' [stacked]' : ''));
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
                else if (hidden[x + ',' + y]) { ch = '~'; }
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
            key: '@ you, # blocked, . floor, ~ hidden touch-trigger (unknown effect), digits/letters are events (see legend); y down, x right'
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

    function startWalk(steps, opts) {
        return new Promise(function (resolve) {
            walk = { steps: steps.slice(), total: steps.length, stall: 0, idle: 0, evFrames: 0, dash: !!opts.dash, faceDir: opts.faceDir || 0, resolve: resolve };
            if (walk.dash) { keyDown('shift', true); }
            if (!steps.length) { finishWalk('arrived'); }
        });
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
            out.events = nearbyEvents(radius, false);
            out.hidden_triggers_nearby = $gameMap.events().filter(function (ev) {
                return isHiddenTrigger(ev) && Math.abs(ev.x - $gamePlayer.x) + Math.abs(ev.y - $gamePlayer.y) <= radius;
            }).length;
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

    H.look = function (p) { return lookAround(p.radius != null ? p.radius : 8, !!p.whole); };

    H.events = function (p) {
        needMap();
        return nearbyEvents(p.radius != null ? p.radius : null, !!p.all);
    };

    H.peek_event = function (p) {
        needMap();
        var ev = eventById(p.id);
        var brief = eventBrief(ev, $gamePlayer.x, $gamePlayer.y);
        brief.commands_decoded = decode(ev.list());
        brief.page_index = ev._pageIndex;
        brief.pages_total = ev.event().pages.length;
        brief.note = ev.event().note || undefined;
        return brief;
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

    H.ui_choose = function (p) {
        var w = activeWindow();
        if (!w) { throw new Error('No active menu/choice window. Current UI: ' + JSON.stringify(uiInfo())); }
        var i = p.index;
        if (i < 0 || i >= w.maxItems()) { throw new Error('Index out of range 0..' + (w.maxItems() - 1)); }
        w.select(i);
        var enabled = windowItemEnabled(w, i);
        if (p.confirm === false) { return frames(2).then(uiInfo); }
        if (!enabled) { return uiInfo(); }
        return tap('ok').then(function () { return frames(4); }).then(uiInfo);
    };

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
                return Promise.resolve({ stopped: 'choice', text: seen, ui: uiInfo() });
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
        if (p.until_choice_only) { max = 500; }
        return loop();
    };

    H.walk_to = function (p) {
        return Promise.resolve(checkCanStartWalk()).then(function () {
            var tx = p.x, ty = p.y, adjacent = !!p.adjacent;
            if (p.event_id != null) {
                var ev = eventById(p.event_id);
                tx = ev.x; ty = ev.y;
                if (p.adjacent == null) { adjacent = isSolid(ev) || ev._trigger === 0; }
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
            var started;
            try { started = Promise.resolve(fn(msg.params || {})); } catch (e) { started = Promise.reject(e); }
            started.then(
                function (r) { send(200, { result: r }); },
                function (e) { send(200, { error: String(e && e.message || e) }); }
            );
        });
    });

    server.on('error', function (e) { console.error('[ClaudeBridge] server error', e && e.message); });
    server.listen(PORT, HOST, function () { console.log('[ClaudeBridge] listening on ' + HOST + ':' + PORT); });

    window.ClaudeBridge = { handlers: H, server: server };
})();
