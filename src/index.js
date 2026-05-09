#!/usr/bin/env node
// IMPORTANT: redirect console.log to stderr BEFORE importing mineflayer.
// mineflayer (and some of its deps) write debug noise via console.log,
// and stdout is reserved for MCP JSON-RPC framing.
console.log = (...a) => process.stderr.write(a.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(' ') + '\n');

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Rcon } from 'rcon-client';
import vec3 from 'vec3';
import net from 'node:net';
import dns from 'node:dns/promises';

const { pathfinder, Movements, goals } = pathfinderPkg;

const SERVER_HOST = process.env.MC_HOST ?? '192.168.1.7';
const SERVER_PORT = Number(process.env.MC_PORT ?? 25565);
const MC_VERSION = process.env.MC_VERSION ?? '1.21.4';
const RCON_HOST = process.env.MC_RCON_HOST ?? SERVER_HOST;
const RCON_PORT = Number(process.env.MC_RCON_PORT ?? 25575);
const RCON_PASSWORD = process.env.MC_RCON_PASSWORD;
const DEFAULT_BOT = process.env.MC_DEFAULT_BOT ?? 'CLAUDE';
const MAX_BOTS_RAW = Number(process.env.MAX_BOTS ?? 4);
if (!Number.isInteger(MAX_BOTS_RAW) || MAX_BOTS_RAW < 1 || MAX_BOTS_RAW > 64) {
    process.stderr.write(`FATAL: MAX_BOTS must be an integer between 1 and 64 (got ${process.env.MAX_BOTS ?? '(unset, default 4)'})\n`);
    process.exit(1);
}
const MAX_BOTS = MAX_BOTS_RAW;

if (!RCON_PASSWORD) {
    process.stderr.write('FATAL: MC_RCON_PASSWORD env var is required. Set it to the rcon.password value from server.properties.\n');
    process.exit(1);
}

// Bot allowlist: only names in this list can be spawned (and auto-opped).
const DEFAULT_BOT_ALLOWLIST = ['CLAUDE', 'CAMERA'];
const BOT_ALLOWLIST = (process.env.MC_BOT_ALLOWLIST
    ? process.env.MC_BOT_ALLOWLIST.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_BOT_ALLOWLIST);

// RCON verb allowlist. Anything not in this list is rejected.
// Override with MC_RCON_ALLOW="verb1,verb2,...". Set to "*" to disable filtering (NOT recommended).
const DEFAULT_RCON_ALLOW = [
    'time', 'weather', 'gamerule', 'give', 'tp', 'teleport', 'setblock', 'fill',
    'summon', 'kill', 'effect', 'enchant', 'gamemode', 'tellraw', 'title',
    'playsound', 'particle', 'difficulty', 'seed', 'list', 'help', 'me', 'say',
    'clear', 'spreadplayers', 'locate', 'forceload', 'data', 'datapack',
    'recipe', 'advancement', 'attribute', 'spawnpoint', 'worldborder',
];
const RCON_ALLOW_RAW = process.env.MC_RCON_ALLOW;
const RCON_ALLOW_ANY = RCON_ALLOW_RAW === '*';
const RCON_ALLOW = RCON_ALLOW_ANY ? null : new Set(
    (RCON_ALLOW_RAW ? RCON_ALLOW_RAW.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_RCON_ALLOW)
        .map(s => s.toLowerCase())
);
// Verbs we always block, even if user passes a permissive allowlist.
const RCON_DENY = new Set([
    'op', 'deop', 'ban', 'ban-ip', 'pardon', 'pardon-ip', 'whitelist',
    'stop', 'save-off', 'save-all', 'save-on', 'execute', 'reload',
    'plugin', 'plugins', 'kick', 'pex', 'lp', 'luckperms',
    'schedule', 'function', 'jfr',
]);

// WorldEdit allowed sub-commands (without the leading //).
const WE_ALLOW = new Set([
    'pos1', 'pos2', 'set', 'replace', 'sphere', 'cyl', 'copy', 'paste',
    'undo', 'redo', 'sel', 'size', 'wand', 'hsphere', 'hcyl', 'pyramid',
    'hpyramid', 'walls', 'outline', 'move', 'stack', 'rotate', 'flip',
    'count', 'distr', 'expand', 'contract', 'shift', 'inset', 'outset',
]);
const WE_DENY = new Set(['schem', 'schematic', 'cs', 'calc', 'eval', 'reload', '/', 'snapshot']);

// ---- Validators (shared) ----
const BotName = z.string().regex(/^[A-Za-z0-9_]{1,16}$/, 'invalid bot name (1-16 chars, [A-Za-z0-9_])');
const ItemId = z.string().regex(/^[a-z0-9_]+(\[[^\]\s\x00-\x1f]*\])?$/, 'invalid item id (no whitespace in component spec)');
// Minecraft world coordinate range: world border max is +/-30,000,000.
const MC_COORD_MIN = -30_000_000;
const MC_COORD_MAX = 30_000_000;
const McCoord = z.number().finite().min(MC_COORD_MIN).max(MC_COORD_MAX);

const bots = new Map();

// ---- Helpers ----
function getEntity(b) {
    if (!b || !b.entity) throw new Error('bot has no entity (disconnected or not yet spawned?)');
    return b.entity;
}

function summarizePos(p) {
    return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, z: Math.round(p.z * 100) / 100 };
}

function ok(data) {
    return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function fail(err) {
    let text;
    try {
        text = String(err?.message ?? JSON.stringify(err) ?? err);
    } catch {
        text = String(err);
    }
    return { content: [{ type: 'text', text: `error: ${text}` }], isError: true };
}

function validateRconCommand(command) {
    if (typeof command !== 'string') throw new Error('command must be a string');
    const trimmedFull = command.trim();
    if (trimmedFull.length === 0) throw new Error('empty command');
    if (Buffer.byteLength(command, 'utf8') > 1024) throw new Error('command too long (>1024 UTF-8 bytes)');
    // Reject newlines, semicolons, NUL, and other control chars (rcon framing & multi-cmd attempts).
    if (/[\x00-\x1f\x7f;]/.test(command)) {
        throw new Error('command contains forbidden characters (newline / control / semicolon)');
    }
    const trimmed = trimmedFull.replace(/^\/+/, ''); // accept "/give ..." or "give ..."
    const verb = trimmed.split(/\s+/, 1)[0].toLowerCase();
    if (RCON_DENY.has(verb)) {
        throw new Error(`rcon verb '${verb}' is permanently blocked (admin/destructive). Edit code, not env, to bypass.`);
    }
    if (!RCON_ALLOW_ANY && !RCON_ALLOW.has(verb)) {
        throw new Error(`rcon verb '${verb}' not in allowlist. Set MC_RCON_ALLOW="${verb},..." to enable, or use a specialized tool.`);
    }
    return trimmed;
}

const RCON_TIMEOUT_MS = 5000;
const RCON_END_TIMEOUT_MS = 2000;

// Cleanly close the rcon connection while bounding how long .end() can hang.
// rcon-client's .end() awaits a socket close that may never fire if the peer
// vanishes, so we race it against a hard timeout that destroys the socket.
async function rconCleanup(holder) {
    if (!holder.r) return;
    const r = holder.r;
    holder.r = null;
    let endP;
    try {
        const maybe = r.end?.();
        endP = (maybe && typeof maybe.then === 'function')
            ? maybe.catch(() => {})
            : Promise.resolve();
    } catch {
        endP = Promise.resolve();
    }
    await Promise.race([
        endP,
        new Promise((res) => setTimeout(() => {
            try { r.socket?.destroy?.(); } catch { /* ignore */ }
            res();
        }, RCON_END_TIMEOUT_MS)),
    ]);
}

// Build a connect promise plus a timeout that destroys the late-arriving socket.
function rconConnectWithTimeout(holder) {
    const connectPromise = Rcon
        .connect({ host: RCON_HOST, port: RCON_PORT, password: RCON_PASSWORD })
        .then(r => { holder.r = r; return r; });
    const timeoutPromise = new Promise((_, rej) => setTimeout(() => {
        rej(new Error('rcon connect timeout'));
        // If connect resolves after the timeout, make sure the socket isn't leaked.
        connectPromise.then(r => {
            try { r.socket?.destroy?.(); } catch { /* ignore */ }
            try { r.end?.(); } catch { /* ignore */ }
        }).catch(() => {});
    }, RCON_TIMEOUT_MS));
    return Promise.race([connectPromise, timeoutPromise]);
}

async function runRcon(command) {
    const safe = validateRconCommand(command);
    const holder = { r: null };
    try {
        const r = await rconConnectWithTimeout(holder);
        const out = await Promise.race([
            r.send(safe),
            new Promise((_, rej) => setTimeout(() => rej(new Error('rcon send timeout')), RCON_TIMEOUT_MS)),
        ]);
        return out;
    } finally {
        await rconCleanup(holder);
    }
}

// Internal RCON used by spawn flow (auto-op / auto-gamemode). Bypasses verb allowlist
// because op/gamemode are required for the spawn contract, but still validates chars
// and uses the same timeout logic.
async function runRconInternal(command) {
    if (typeof command !== 'string' || /[\x00-\x1f\x7f;]/.test(command)) {
        throw new Error('internal rcon: forbidden chars');
    }
    const holder = { r: null };
    try {
        const r = await rconConnectWithTimeout(holder);
        return await Promise.race([
            r.send(command),
            new Promise((_, rej) => setTimeout(() => rej(new Error('rcon send timeout')), RCON_TIMEOUT_MS)),
        ]);
    } finally {
        await rconCleanup(holder);
    }
}

async function createBot(username) {
    if (!BOT_ALLOWLIST.includes(username)) {
        throw new Error(`bot name '${username}' not in MC_BOT_ALLOWLIST (${BOT_ALLOWLIST.join(', ')})`);
    }
    if (bots.has(username)) throw new Error(`bot '${username}' already connected`);
    if (bots.size >= MAX_BOTS) {
        throw new Error(`MAX_BOTS=${MAX_BOTS} reached; disconnect a bot before spawning more`);
    }
    // Reserve the slot synchronously to prevent a TOCTOU race when two spawn_bot
    // calls land in the same tick.
    bots.set(username, { __pending: true });
    let bot;
    try {
        bot = mineflayer.createBot({
            host: SERVER_HOST, port: SERVER_PORT, username, version: MC_VERSION,
            auth: 'offline', hideErrors: true, logErrors: false,
        });
        // Replace the pending sentinel with the real bot BEFORE attaching listeners,
        // so that an early 'end' can free the slot via the permanent handler.
        bots.set(username, bot);

        // Permanent listeners. Without these, post-spawn errors crash the process,
        // and a network blip could leave a stale entry in `bots`.
        bot.on('error', (err) => process.stderr.write(`[bot ${username}] ${err?.message ?? err}\n`));
        bot.on('end', () => { if (bots.get(username) === bot) bots.delete(username); });
        bot.on('kicked', (reason) => {
            process.stderr.write(`[bot ${username}] kicked: ${JSON.stringify(reason)}\n`);
            if (bots.get(username) === bot) bots.delete(username);
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
        movements.canDig = false; // safe default; pathfinder will path around obstacles instead of mining them
        bot.pathfinder.setMovements(movements);

        try {
            await runRconInternal(`op ${username}`);
        } catch (e) {
            process.stderr.write(`[spawn ${username}] auto-op failed: ${e.message}\n`);
        }
        try {
            await runRconInternal(`gamemode creative ${username}`);
        } catch (e) {
            process.stderr.write(`[spawn ${username}] auto-gamemode failed: ${e.message}\n`);
        }
        return bot;
    } catch (e) {
        // On failure, release the reservation so the caller can retry.
        if (bots.get(username) === bot || bots.get(username)?.__pending) bots.delete(username);
        // Only quit() a fully-constructed bot. The pending sentinel is a plain
        // object with no quit; calling .quit on a partially-initialized bot can
        // throw inside mineflayer.
        if (bot && typeof bot.quit === 'function' && !bot.__pending) {
            try { bot.quit(); } catch { /* ignore */ }
        }
        throw e;
    }
}

function getBot(name) {
    const wasDefault = name == null;
    const key = name ?? DEFAULT_BOT;
    const bot = bots.get(key);
    if (!bot || bot.__pending) {
        const label = wasDefault ? `default bot '${key}'` : `bot '${key}'`;
        throw new Error(`${label} not connected. call spawn_bot first`);
    }
    return bot;
}

// ---- Startup safety check ----
async function startupSafetyCheck() {
    try {
        // Resolve host. If it's already an IP, dns.lookup just echoes it back.
        const { address } = await dns.lookup(SERVER_HOST);
        const isPrivate =
            net.isIP(address) === 0 ||
            /^10\./.test(address) ||
            /^192\.168\./.test(address) ||
            /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(address) ||
            /^127\./.test(address) ||
            /^169\.254\./.test(address) ||
            /^::1$/.test(address) ||
            /^fc/i.test(address) ||
            /^fd/i.test(address) ||
            /^fe80:/i.test(address);
        if (!isPrivate) {
            process.stderr.write(
                `\n!!! WARNING: MC_HOST=${SERVER_HOST} resolves to PUBLIC IP ${address}.\n` +
                `!!! mc-mcp assumes a trusted LAN/offline server. If this server runs in offline-mode,\n` +
                `!!! ANYONE on the internet can join with any name. Verify online-mode=true or move it behind\n` +
                `!!! a firewall/VPN.\n\n`
            );
        }
    } catch (e) {
        process.stderr.write(`[startup] could not resolve MC_HOST=${SERVER_HOST}: ${e.message}\n`);
    }
}

// ---- Process-wide error handlers ----
process.on('unhandledRejection', (e) => process.stderr.write('unhandled rejection: ' + (e?.stack ?? e) + '\n'));
process.on('uncaughtException', (e) => process.stderr.write('uncaught exception: ' + (e?.stack ?? e) + '\n'));

// server name == the key passed to 'claude mcp add'
const server = new McpServer({ name: 'mc-mcp', version: '0.1.0' });

server.tool(
    'spawn_bot',
    'Connect a new bot to the Minecraft server. The name must be in MC_BOT_ALLOWLIST (default: CLAUDE,CAMERA). The bot is auto-opped and set to creative.',
    { name: BotName.default(DEFAULT_BOT).describe('bot username; must be in MC_BOT_ALLOWLIST') },
    async ({ name }) => {
        try {
            await createBot(name);
            const b = bots.get(name);
            const ent = getEntity(b);
            return ok({ bot: name, pos: summarizePos(ent.position), dim: b.game.dimension, health: b.health });
        } catch (e) { return fail(e); }
    }
);

server.tool(
    'disconnect_bot',
    'Disconnect a bot and wait for the connection to fully close.',
    { name: BotName.default(DEFAULT_BOT).describe('bot username') },
    async ({ name }) => {
        try {
            const b = getBot(name);
            const ended = new Promise((resolve) => { b.once('end', () => resolve(true)); });
            try { b.quit(); } catch { /* ignore */ }
            const wasEnded = await Promise.race([
                ended,
                new Promise(r => setTimeout(() => r(false), 3000)),
            ]);
            if (wasEnded) {
                // Permanent 'end' listener (registered in createBot) already removed the entry.
                return ok({ disconnected: true });
            }
            return ok({
                disconnected: false,
                warning: 'bot did not confirm end within 3s; slot retained',
            });
        } catch (e) { return fail(e); }
    }
);

server.tool(
    'list_bots',
    'List connected bots with position and health. Disconnected/dead entries are surfaced rather than crashing.',
    {},
    async () => {
        const rows = [];
        for (const [n, b] of [...bots.entries()]) {
            try {
                if (b.__pending) { rows.push({ name: n, status: 'pending' }); continue; }
                const ent = getEntity(b);
                rows.push({
                    name: n,
                    pos: summarizePos(ent.position),
                    dim: b.game?.dimension,
                    health: b.health,
                    food: b.food,
                });
            } catch (e) {
                rows.push({ name: n, status: 'dead', error: String(e?.message ?? e) });
            }
        }
        return ok(rows);
    }
);

server.tool(
    'chat',
    'Send a plain chat message as a bot. Leading slashes ("/" or "//") are stripped to prevent slash-command injection. For admin commands use the rcon tool; for WorldEdit use the worldedit tool.',
    {
        name: BotName.default(DEFAULT_BOT).describe('bot username'),
        message: z.string().min(1).refine(
            (v) => Buffer.byteLength(v, 'utf8') <= 256,
            { message: 'chat message must be <= 256 UTF-8 bytes (Mineflayer protocol limit is byte-based)' }
        ).describe('chat text (max 256 UTF-8 bytes); leading / and // are stripped')
    },
    async ({ name, message }) => {
        try {
            const b = getBot(name);
            const stripped = message.replace(/^\/+/, '').trim();
            if (stripped.length === 0) throw new Error('message empty after stripping leading slashes / whitespace');
            if (/[\x00-\x1f\x7f]/.test(stripped)) throw new Error('message contains control characters');
            b.chat(stripped);
            return ok(`sent: ${stripped}`);
        } catch (e) { return fail(e); }
    }
);

server.tool(
    'worldedit',
    'Run a WorldEdit command as the bot (auto-prefixes //). The bot must be opped (auto-op happens at spawn). ' +
        `Allowed: ${[...WE_ALLOW].join(', ')}. ` +
        `Blocked: ${[...WE_DENY].join(', ')}. ` +
        'Watch volume: //set/sphere on huge regions can lag the server; keep selections under ~1M blocks unless you raised //limit.',
    {
        name: BotName.default(DEFAULT_BOT).describe('bot username'),
        command: z.string().min(1).refine(
            (v) => Buffer.byteLength('//' + v.replace(/^\/+/, '').trim(), 'utf8') <= 256,
            { message: 'worldedit command too long (//+command must fit 256 UTF-8 bytes; Mineflayer chat is byte-based)' }
        ).describe('WorldEdit command without the leading // (the prefixed "//<cmd>" must fit 256 UTF-8 bytes)')
    },
    async ({ name, command }) => {
        try {
            const b = getBot(name);
            if (/[\x00-\x1f\x7f]/.test(command)) throw new Error('command contains control characters');
            const trimmed = command.replace(/^\/+/, '').trim();
            const verb = trimmed.split(/\s+/, 1)[0].toLowerCase();
            if (WE_DENY.has(verb)) throw new Error(`worldedit verb '${verb}' is blocked`);
            if (!WE_ALLOW.has(verb)) throw new Error(`worldedit verb '${verb}' not in allowlist`);
            const msg = `//${trimmed}`;
            b.chat(msg);
            return ok(`sent: ${msg}`);
        } catch (e) { return fail(e); }
    }
);

server.tool(
    'rcon',
    'Run a console command on the server via RCON. PREFER specialized tools when available (set_time, teleport, give_item, get_block, etc.). ' +
        `Verbs blocked unconditionally: ${[...RCON_DENY].join(', ')}. ` +
        (RCON_ALLOW_ANY
            ? 'WARNING: MC_RCON_ALLOW="*" is set — all non-blocked verbs are allowed.'
            : `Verbs allowed (configurable via MC_RCON_ALLOW): ${[...RCON_ALLOW].join(', ')}.`),
    { command: z.string().min(1).max(1024).describe('full command, with or without leading slash') },
    async ({ command }) => {
        try { const out = await runRcon(command); return ok(out || '(no output)'); }
        catch (e) { return fail(e); }
    }
);

server.tool(
    'get_position',
    "Get a bot's current position and rotation.",
    { name: BotName.default(DEFAULT_BOT).describe('bot username') },
    async ({ name }) => {
        try {
            const b = getBot(name);
            const ent = getEntity(b);
            return ok({
                pos: summarizePos(ent.position),
                yaw: Math.round(ent.yaw * 180 / Math.PI),
                pitch: Math.round(ent.pitch * 180 / Math.PI),
                onGround: ent.onGround,
                dimension: b.game?.dimension,
            });
        } catch (e) { return fail(e); }
    }
);

server.tool(
    'move_to',
    'Pathfind and walk a bot to x,y,z. Returns when the bot arrives or times out. For creative fly, set fly=true (uses /tp via rcon). ' +
        'Digging is OFF by default to prevent griefing — set allow_dig=true to opt in.',
    {
        name: BotName.default(DEFAULT_BOT).describe('bot username'),
        x: McCoord.describe('X coordinate (target)'),
        y: McCoord.describe('Y coordinate (target)'),
        z: McCoord.describe('Z coordinate (target)'),
        range: z.number().finite().min(0).max(64).default(1).describe('stop when within this many blocks of target (default 1)'),
        timeout_ms: z.number().int().min(1000).max(300000).default(30000).describe('hard cap on pathfinding time in milliseconds (default 30000)'),
        fly: z.boolean().default(false).describe('use creative flight (teleport via rcon) instead of walking'),
        allow_dig: z.boolean().default(false).describe('allow pathfinder to dig through blocks (OFF by default)')
    },
    async ({ name, x, y, z, range, timeout_ms, fly, allow_dig }) => {
        try {
            const b = getBot(name);
            const ent = getEntity(b);
            if (fly) {
                await runRconInternal(`tp ${name} ${x} ${y} ${z}`);
                // After /tp, mineflayer's local entity position lags until the
                // server sends a position update. Wait briefly for 'forcedMove'
                // (or fall back to a 500ms timeout) so the returned pos reflects
                // the teleport.
                await new Promise((resolve) => {
                    const t = setTimeout(resolve, 500);
                    b.once('forcedMove', () => { clearTimeout(t); resolve(); });
                });
                return ok({ teleported: true, pos: summarizePos(getEntity(b).position) });
            }
            // Per-call movements so allow_dig is per-request, not sticky.
            const movements = new Movements(b);
            movements.allowParkour = true;
            movements.canDig = !!allow_dig;
            b.pathfinder.setMovements(movements);

            const goal = new goals.GoalNear(x, y, z, range);
            let timer;
            const startedAt = Date.now();
            const timeoutP = new Promise((_, rej) => {
                timer = setTimeout(() => {
                    try { b.pathfinder.stop(); } catch { /* ignore */ }
                    const elapsed = Date.now() - startedAt;
                    rej(new Error(`pathfind timeout: target=(${x},${y},${z}) elapsed=${elapsed}ms (limit=${timeout_ms}ms)`));
                }, timeout_ms);
            });
            try {
                await Promise.race([b.pathfinder.goto(goal), timeoutP]);
            } finally {
                if (timer) clearTimeout(timer);
            }
            return ok({ arrived: true, pos: summarizePos(ent.position) });
        } catch (e) { return fail(e); }
    }
);

server.tool(
    'look_at',
    'Make a bot look at x,y,z.',
    {
        name: BotName.default(DEFAULT_BOT).describe('bot username'),
        x: McCoord.describe('X coordinate (target)'),
        y: McCoord.describe('Y coordinate (target)'),
        z: McCoord.describe('Z coordinate (target)'),
    },
    async ({ name, x, y, z }) => {
        try {
            const b = getBot(name);
            getEntity(b); // ensure spawned
            await b.lookAt(vec3(x, y, z), true);
            return ok({ looked: { x, y, z } });
        } catch (e) { return fail(e); }
    }
);

server.tool(
    'get_block',
    'Inspect the block at x,y,z. Returns name and properties.',
    {
        name: BotName.default(DEFAULT_BOT).describe('bot username'),
        x: McCoord.describe('X coordinate (block, world)'),
        y: McCoord.describe('Y coordinate (block, world)'),
        z: McCoord.describe('Z coordinate (block, world)'),
    },
    async ({ name, x, y, z }) => {
        try {
            const b = getBot(name);
            getEntity(b); // ensure spawned / alive
            const block = b.blockAt(vec3(x, y, z));
            if (!block) return fail(new Error('block unavailable: chunk not loaded or out of range'));
            return ok({
                name: block.name,
                pos: { x, y, z },
                light: block.light,
                hardness: block.hardness,
                properties: typeof block.getProperties === 'function' ? block.getProperties() : {},
            });
        } catch (e) { return fail(e); }
    }
);

server.tool(
    'scan_area',
    'Scan a cube around the bot and return counts of block types (excluding air). Useful for terrain survey. Radius is validated to [1, 32].',
    {
        name: BotName.default(DEFAULT_BOT).describe('bot username'),
        radius: z.number().int().min(1).max(32).default(8).describe('half-size of cube in blocks (max 32 -> 65³ = 274,625 blocks)'),
    },
    async ({ name, radius }) => {
        try {
            const b = getBot(name);
            const ent = getEntity(b);
            const p = ent.position.floored();
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
    "List items in a bot's inventory.",
    { name: BotName.default(DEFAULT_BOT).describe('bot username') },
    async ({ name }) => {
        try {
            const b = getBot(name);
            const items = b.inventory.items().map(i => ({ name: i.name, count: i.count, slot: i.slot }));
            return ok(items);
        } catch (e) { return fail(e); }
    }
);

server.tool(
    'give_item',
    'Give an item to a bot via RCON (requires the bot to be connected).',
    {
        name: BotName.default(DEFAULT_BOT).describe('bot username (must be connected)'),
        item: ItemId.describe('minecraft item id, e.g. "stone", "diamond_pickaxe", or "diamond_sword[enchantments={sharpness:5}]"'),
        count: z.number().int().min(1).max(64).default(1).describe('stack count (1-64)')
    },
    async ({ name, item, count }) => {
        try {
            getBot(name);
            const nsItem = item.includes(':') ? item : `minecraft:${item}`;
            const out = await runRconInternal(`give ${name} ${nsItem} ${count}`);
            return ok(out);
        } catch (e) { return fail(e); }
    }
);

server.tool(
    'set_time',
    'Set time of day. For numeric ticks use rcon { "command": "time set 6000" }.',
    { value: z.enum(['day', 'noon', 'night', 'midnight']).default('day').describe('time-of-day preset') },
    async ({ value }) => {
        try { return ok(await runRconInternal(`time set ${value}`)); }
        catch (e) { return fail(e); }
    }
);

server.tool(
    'teleport',
    'Teleport a bot to absolute coords (admin, instant).',
    {
        name: BotName.default(DEFAULT_BOT).describe('bot username (must be connected)'),
        x: McCoord.describe('X coordinate (target)'),
        y: McCoord.describe('Y coordinate (target)'),
        z: McCoord.describe('Z coordinate (target)'),
    },
    async ({ name, x, y, z }) => {
        try {
            getBot(name);
            return ok(await runRconInternal(`tp ${name} ${x} ${y} ${z}`));
        } catch (e) { return fail(e); }
    }
);

const sigHandler = async () => {
    const promises = [];
    for (const [name, b] of bots) {
        if (!b || b.__pending) continue;
        const ended = new Promise((r) => b.once('end', r));
        try { b.quit(); } catch { /* ignore */ }
        promises.push(Promise.race([
            ended,
            new Promise((r) => setTimeout(r, 3000)),
        ]).catch(() => {}));
        // Avoid leaking the bot ref via the closure-captured listener if the
        // process happens to live past exit (shouldn't, but be defensive).
        void name;
    }
    await Promise.all(promises);
    process.exit(0);
};
process.on('SIGINT', sigHandler);
process.on('SIGTERM', sigHandler);

await startupSafetyCheck();

const transport = new StdioServerTransport();
await server.connect(transport);
