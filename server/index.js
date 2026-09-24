#!/usr/bin/env node
// MCP server for Fear & Hunger 2: Termina. Talks to the ClaudeBridge plugin
// running inside the game (see ../game-plugin/ClaudeBridge.js).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BRIDGE_URL = process.env.FUNGER_BRIDGE_URL ?? 'http://127.0.0.1:7777/rpc';
const TOKEN_PATH = path.join(os.homedir(), '.fear-hunger-bridge-token');
const TIMEOUT_MS = 120_000;

async function rpc(method, params = {}) {
  let token;
  try {
    token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  } catch {
    throw new Error('Bridge token missing. Run ./install.sh and start the game once.');
  }
  let res;
  try {
    res = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': token },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Cannot reach the game bridge at ${BRIDGE_URL}. Is Fear & Hunger 2 running with the ClaudeBridge plugin? (${e.message})`);
  }
  if (!res.ok) throw new Error(`Bridge returned HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error);
  return body.result;
}

const asText = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
const asError = (e) => ({ isError: true, content: [{ type: 'text', text: String(e.message ?? e) }] });

const server = new McpServer({ name: 'fear-hunger', version: '0.1.0' });

/** Register a tool that forwards to a bridge method. */
function bridgeTool(name, description, shape, method = name, format = asText) {
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try {
      return format(await rpc(method, args));
    } catch (e) {
      return asError(e);
    }
  });
}

const dir = z.enum(['up', 'down', 'left', 'right']);

bridgeTool(
  'observe',
  'One-call situational awareness: scene, map, player position/facing, visible or remembered nearby events (sprite, position), party HP/states, any open dialogue or menu, and battle state. Call this first and after every action.',
  { radius: z.number().int().min(1).max(40).optional().describe('Event radius in tiles (default 7)') },
);

server.registerTool(
  'look',
  {
    description: 'ASCII map around the player with a legend of events you have seen. # blocked, . floor, @ you, digits/letters are events (see legend). Use whole=true for the full map.',
    inputSchema: {
      radius: z.number().int().min(1).max(40).optional().describe('Tiles in each direction (default 8)'),
      whole: z.boolean().optional().describe('Show the entire map'),
    },
  },
  async (args) => {
    try {
      const r = await rpc('look', args);
      const text = [
        `${r.map.name} "${r.map.displayName}" (${r.map.width}x${r.map.height}, id ${r.map.id})`,
        `you: (${r.player.x},${r.player.y}) facing ${r.player.facing}`,
        r.ascii,
        r.key,
        ...r.legend,
      ].join('\n');
      return asText(text);
    } catch (e) {
      return asError(e);
    }
  },
);

bridgeTool(
  'events',
  'List events you have seen on this map (on screen now, or remembered from earlier at their last known position), sorted by distance.',
  {
    radius: z.number().int().min(1).optional().describe('Only events within this many tiles'),
  },
);

bridgeTool(
  'peek_event',
  'Details of an event you have already seen (visible sprite, position, solidity, whether it is out of view). Does not reveal what it does; interact to find out.',
  { id: z.number().int().describe('Event id from observe/look/events') },
);

bridgeTool(
  'walk_to',
  'Pathfind and walk to a tile or next to an event, using the game\'s own passability. Stops if dialogue or an event starts. With event_id it stands adjacent and faces the event (ready for interact).',
  {
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    event_id: z.number().int().optional().describe('Walk to this event instead of x/y'),
    adjacent: z.boolean().optional().describe('Stand next to the target and face it (default true for solid/action events)'),
    dash: z.boolean().optional().describe('Hold dash while walking'),
    allow_hazards: z.boolean().optional().describe('Allow crossing transfer/battle/damage touch events'),
  },
);

bridgeTool(
  'walk',
  'Walk raw steps, e.g. [{dir:"up",n:3},{dir:"left",n:2}]. Stops on blockage or when an event/dialogue starts.',
  {
    steps: z.array(z.object({ dir, n: z.number().int().min(1).max(100).optional() })).min(1),
    dash: z.boolean().optional(),
  },
);

bridgeTool('stop_walk', 'Cancel an in-progress walk.', {});
bridgeTool('face', 'Turn to face a direction without moving.', { dir });
bridgeTool(
  'interact',
  'Press the action button facing the current (or given) direction. Returns whether an event started and its first message. Follow with advance_dialogue.',
  { dir: dir.optional() },
);

bridgeTool(
  'advance_dialogue',
  'Press OK through dialogue until a choice appears or the event ends; returns all text shown. Stops at choices - answer them with ui_choose.',
  { max: z.number().int().min(1).max(500).optional().describe('Max text boxes to advance (default 60)') },
);

bridgeTool('ui', 'Read the current dialogue box and all visible menus/choice lists with indexes and enabled flags (battle commands, skills, items, targets, save slots, title menu...).', {});
bridgeTool(
  'ui_choose',
  'Select item `index` in the active menu/choice list and confirm it (confirm=false only moves the cursor). Returns the resulting UI.',
  { index: z.number().int().min(0), confirm: z.boolean().optional() },
);
bridgeTool('ui_cancel', 'Press cancel/escape (back out of a menu; opens the menu on the map).', {});

bridgeTool(
  'press',
  'Press raw keys in order: ok, escape, up, down, left, right, shift, pageup, pagedown, tab, control. Each entry is a name or {key,count}. Use for anything the structured tools do not cover (e.g. picture-based menus).',
  {
    keys: z.array(z.union([z.string(), z.object({ key: z.string(), count: z.number().int().min(1).max(50).optional() })])).min(1),
    hold: z.number().int().min(1).max(60).optional().describe('Frames to hold each key (default 3)'),
  },
);
bridgeTool('wait', 'Wait N game frames (60 = 1s), then observe.', { frames: z.number().int().min(1).max(600).optional() });

bridgeTool('party', 'Party members: HP/MP, states (injuries, bleeding, etc.), equipment, and optionally full skill lists.', { skills: z.boolean().optional() });
bridgeTool('inventory', 'Gold, items, weapons and armor with counts and descriptions.', {});
bridgeTool(
  'battle',
  'Full battle state: phase, turn, party, every enemy body part with HP/states (targets), plus the current battle UI menus. Errors if not in battle.',
  {},
);

server.registerTool(
  'screenshot',
  {
    description: 'Screenshot of the game screen. Use when text state is not enough (picture-based screens, lighting, what the sprites look like).',
    inputSchema: {},
  },
  async () => {
    try {
      const r = await rpc('screenshot');
      return { content: [{ type: 'image', data: r.data, mimeType: r.mime }] };
    } catch (e) {
      return asError(e);
    }
  },
);

// Cheating hatch: not registered unless the player explicitly opts in.
if (process.env.FUNGER_ALLOW_EVAL === '1') {
  bridgeTool('debug_eval', 'DEBUG ONLY: run JS inside the game. Never use this to change game state while playing.', { code: z.string() }, 'eval');
}

await server.connect(new StdioServerTransport());
