#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Rcon } from 'rcon-client';
import vec3 from 'vec3';

const { pathfinder, Movements, goals } = pathfinderPkg;

const SERVER_HOST = process.env.MC_HOST ?? '192.168.1.7';
const SERVER_PORT = Number(process.env.MC_PORT ?? 25565);
const MC_VERSION = process.env.MC_VERSION ?? '1.21.4';
const RCON_HOST = process.env.MC_RCON_HOST ?? SERVER_HOST;
const RCON_PORT = Number(process.env.MC_RCON_PORT ?? 25575);
const RCON_PASSWORD = process.env.MC_RCON_PASSWORD ?? 'botmcp_local';
const DEFAULT_BOT = process.env.MC_DEFAULT_BOT ?? 'CLAUDE';

const bots = new Map();

async function rcon(command) {
    const r = await Rcon.connect({ host: RCON_HOST, port: RCON_PORT, password: RCON_PASSWORD });
    const out = await r.send(command);
    await r.end();
    return out;
}

async function createBot(username) {
    if (bots.has(username)) throw new Error(`bot '${username}' already connected`);
    const bot = mineflayer.createBot({
        host: SERVER_HOST, port: SERVER_PORT, username, version: MC_VERSION, auth: 'offline'
    });
    bot.loadPlugin(pathfinder);
    await new Promise((resolve, reject) => {
        const onSpawn = () => { cleanup(); resolve(); };
        const onError = (err) => { cleanup(); reject(err); };
        const onKick = (reason) => { cleanup(); reject(new Error(`kicked: ${JSON.stringify(reason)}`)); };
        const onEnd = (reason) => { cleanup(); reject(new Error(`ended before spawn: ${reason}`)); };
        const cleanup = () => {
            bot.off('spawn', onSpawn);
            bot.off('error', onError);
            bot.off('kicked', onKick);
            bot.off('end', onEnd);
        };
        bot.once('spawn', onSpawn);
        bot.once('error', onError);
        bot.once('kicked', onKick);
        bot.once('end', onEnd);
    });
    const movements = new Movements(bot);
    movements.allowParkour = true;
    movements.canDig = true;
    bot.pathfinder.setMovements(movements);
    bot.on('end', () => bots.delete(username));
    bot.on('kicked', () => bots.delete(username));
    bots.set(username, bot);
    try { await rcon(`op ${username}`); } catch {}
    try { await rcon(`gamemode creative ${username}`); } catch {}
    return bot;
}

function getBot(name) {
    const key = name ?? DEFAULT_BOT;
    const bot = bots.get(key);
    if (!bot) throw new Error(`bot '${key}' not connected. call spawn_bot first`);
    return bot;
}

function summarizePos(p) { return { x: Math.round(p.x*100)/100, y: Math.round(p.y*100)/100, z: Math.round(p.z*100)/100 }; }
function ok(data) { return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }; }
function fail(err) { return { content: [{ type: 'text', text: `error: ${err.message ?? err}` }], isError: true }; }

const server = new McpServer({ name: 'mc-mcp', version: '0.1.0' });

server.tool(
    'spawn_bot',
    'Connect a new bot to the Minecraft server. The bot is automatically opped and set to creative mode.',
    { name: z.string().default(DEFAULT_BOT).describe('bot username (default: CLAUDE)') },
    async ({ name }) => {
        try {
            await createBot(name);
            const b = bots.get(name);
            return ok({ bot: name, pos: summarizePos(b.entity.position), dim: b.game.dimension, health: b.health });
        } catch (e) { return fail(e); }
    }
);

server.tool(
    'disconnect_bot',
    'Disconnect a bot.',
    { name: z.string().default(DEFAULT_BOT) },
    async ({ name }) => {
        try {
            const b = getBot(name);
            b.quit();
            bots.delete(name);
            return ok(`disconnected ${name}`);
        } catch (e) { return fail(e); }
    }
);

server.tool(
    'list_bots',
    'List connected bots with position and health.',
    {},
    async () => {
        const rows = [...bots.entries()].map(([n, b]) => ({
            name: n, pos: summarizePos(b.entity.position), dim: b.game.dimension, health: b.health, food: b.food
        }));
        return ok(rows.length ? rows : '(no bots connected)');
    }
);

server.tool(
    'chat',
    'Send a chat message or slash command as a bot. Prefix with / for commands (e.g. "/time set day"). Prefix with // for WorldEdit.',
    { name: z.string().default(DEFAULT_BOT), message: z.string() },
    async ({ name, message }) => {
        try {
            const b = getBot(name);
            b.chat(message);
            return ok(`sent: ${message}`);
        } catch (e) { return fail(e); }
    }
);

server.tool(
    'worldedit',
    'Run a WorldEdit command as the bot (auto-prefixes //). Examples: "pos1", "pos2", "set stone", "sphere glass 10", "cyl oak_log 5 20", "copy", "paste", "undo".',
    { name: z.string().default(DEFAULT_BOT), command: z.string().describe('WorldEdit command without the leading //') },
    async ({ name, command }) => {
        try {
            const b = getBot(name);
            const msg = `//${command}`;
            b.chat(msg);
            return ok(`sent: ${msg}`);
        } catch (e) { return fail(e); }
    }
);

server.tool(
    'rcon',
    'Run a console command on the server via RCON (admin, no bot needed). Use for /gamerule, /time, /weather, /give, /tp, /setblock, /fill, etc.',
    { command: z.string() },
    async ({ command }) => {
        try { const out = await rcon(command); return ok(out || '(no output)'); }
        catch (e) { return fail(e); }
    }
);

server.tool(
    'get_position',
    'Get a bot\'s current position and rotation.',
    { name: z.string().default(DEFAULT_BOT) },
    async ({ name }) => {
        try {
            const b = getBot(name);
            return ok({
                pos: summarizePos(b.entity.position),
                yaw: Math.round(b.entity.yaw*180/Math.PI),
                pitch: Math.round(b.entity.pitch*180/Math.PI),
                onGround: b.entity.onGround, dimension: b.game.dimension
            });
        } catch (e) { return fail(e); }
    }
);

server.tool(
    'move_to',
    'Pathfind and walk a bot to x,y,z. Returns when the bot arrives or times out. For creative fly, set fly=true.',
    {
        name: z.string().default(DEFAULT_BOT),
        x: z.number(), y: z.number(), z: z.number(),
        range: z.number().default(1).describe('distance to target at which to stop'),
        timeout_ms: z.number().default(30000),
        fly: z.boolean().default(false).describe('use creative flight (teleport-style) instead of walking')
    },
    async ({ name, x, y, z, range, timeout_ms, fly }) => {
        try {
            const b = getBot(name);
            if (fly) {
                await rcon(`tp ${name} ${x} ${y} ${z}`);
                return ok({ teleported: true, pos: summarizePos(b.entity.position) });
            }
            const goal = new goals.GoalNear(x, y, z, range);
            await Promise.race([
                b.pathfinder.goto(goal),
                new Promise((_, rej) => setTimeout(() => rej(new Error('pathfind timeout')), timeout_ms))
            ]);
            return ok({ arrived: true, pos: summarizePos(b.entity.position) });
        } catch (e) { return fail(e); }
    }
);

server.tool(
    'look_at',
    'Make a bot look at x,y,z.',
    { name: z.string().default(DEFAULT_BOT), x: z.number(), y: z.number(), z: z.number() },
    async ({ name, x, y, z }) => {
        try {
            const b = getBot(name);
            await b.lookAt(vec3(x, y, z), true);
            return ok({ looked: { x, y, z } });
        } catch (e) { return fail(e); }
    }
);

server.tool(
    'get_block',
    'Inspect the block at x,y,z. Returns name and properties.',
    { name: z.string().default(DEFAULT_BOT), x: z.number(), y: z.number(), z: z.number() },
    async ({ name, x, y, z }) => {
        try {
            const b = getBot(name);
            const block = b.blockAt(vec3(x, y, z));
            if (!block) return ok('(no block / out of view distance)');
            return ok({ name: block.name, pos: { x, y, z }, light: block.light, hardness: block.hardness });
        } catch (e) { return fail(e); }
    }
);

server.tool(
    'scan_area',
    'Scan a cube around the bot and return counts of block types (excluding air). Useful for terrain survey.',
    {
        name: z.string().default(DEFAULT_BOT),
        radius: z.number().default(8).describe('half-size of cube in blocks'),
    },
    async ({ name, radius }) => {
        try {
            const b = getBot(name);
            const p = b.entity.position.floored();
            const counts = {};
            for (let dx = -radius; dx <= radius; dx++) {
                for (let dy = -radius; dy <= radius; dy++) {
                    for (let dz = -radius; dz <= radius; dz++) {
                        const blk = b.blockAt(p.offset(dx, dy, dz));
                        if (!blk || blk.name === 'air') continue;
                        counts[blk.name] = (counts[blk.name] ?? 0) + 1;
                    }
                }
            }
            return ok({ center: summarizePos(p), radius, blocks: counts });
        } catch (e) { return fail(e); }
    }
);

server.tool(
    'get_inventory',
    'List items in a bot\'s inventory.',
    { name: z.string().default(DEFAULT_BOT) },
    async ({ name }) => {
        try {
            const b = getBot(name);
            const items = b.inventory.items().map(i => ({ name: i.name, count: i.count, slot: i.slot }));
            return ok(items.length ? items : '(empty)');
        } catch (e) { return fail(e); }
    }
);

server.tool(
    'give_item',
    'Give an item to a bot via RCON (requires the bot to be connected).',
    {
        name: z.string().default(DEFAULT_BOT),
        item: z.string().describe('minecraft item id, e.g. "stone", "diamond_pickaxe"'),
        count: z.number().default(1)
    },
    async ({ name, item, count }) => {
        try {
            getBot(name);
            const out = await rcon(`give ${name} minecraft:${item} ${count}`);
            return ok(out);
        } catch (e) { return fail(e); }
    }
);

server.tool(
    'set_time',
    'Set time of day.',
    { value: z.enum(['day', 'noon', 'night', 'midnight']).default('day') },
    async ({ value }) => { try { return ok(await rcon(`time set ${value}`)); } catch (e) { return fail(e); } }
);

server.tool(
    'teleport',
    'Teleport a bot to absolute coords (admin, instant).',
    { name: z.string().default(DEFAULT_BOT), x: z.number(), y: z.number(), z: z.number() },
    async ({ name, x, y, z }) => {
        try { getBot(name); return ok(await rcon(`tp ${name} ${x} ${y} ${z}`)); }
        catch (e) { return fail(e); }
    }
);

process.on('SIGINT', () => { for (const b of bots.values()) try { b.quit(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { for (const b of bots.values()) try { b.quit(); } catch {} process.exit(0); });

const transport = new StdioServerTransport();
await server.connect(transport);
