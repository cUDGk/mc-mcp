#!/usr/bin/env node
// Headless render a Minecraft screenshot using prismarine-viewer's Viewer + node-canvas-webgl.
//
// DO NOT import this file from src/index.js (the MCP server). It writes diagnostic
// console.log to stdout, which would corrupt MCP JSON-RPC framing. It is meant to
// run as a standalone CLI (`node screenshot.js`).
import mineflayer from 'mineflayer';
import THREE from 'three';
import { Worker } from 'node:worker_threads';
import { createCanvas } from 'node-canvas-webgl';
import prismarineViewerLib from 'prismarine-viewer/viewer/index.js';
const { Viewer, WorldView, getBufferFromStream } = prismarineViewerLib;
import { Rcon } from 'rcon-client';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

global.THREE = THREE;
global.Worker = Worker;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CLI: --output=<path>  (or  --output <path>)
function parseOutput(argv) {
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--output=')) return a.slice('--output='.length);
        if (a === '--output' && i + 1 < argv.length) return argv[i + 1];
    }
    return null;
}

// Validate the --output path: resolve to absolute, require .png suffix, and
// reject obvious system locations. NOTE: this is a basic guard, not a chroot —
// a determined caller can still write inside their home dir. Don't run this
// CLI as root/admin.
function validateOutputPath(p) {
    const resolved = path.resolve(p);
    if (!resolved.toLowerCase().endsWith('.png')) {
        throw new Error(`--output must end with .png (got: ${resolved})`);
    }
    const lower = resolved.toLowerCase().replace(/\\/g, '/');
    const denied = [
        '/windows/', '/program files/', '/program files (x86)/',
        '/programdata/', '/system32/', '/etc/', '/bin/', '/sbin/',
        '/usr/', '/boot/', '/dev/', '/proc/', '/sys/',
    ];
    for (const seg of denied) {
        if (lower.includes(seg)) {
            throw new Error(`--output path rejected (system location): ${resolved}`);
        }
    }
    return resolved;
}

const HOST = process.env.MC_HOST ?? '192.168.1.7';
const RCON_PASSWORD = process.env.MC_RCON_PASSWORD;
if (!RCON_PASSWORD) {
    console.error('FATAL: MC_RCON_PASSWORD env var is required.');
    process.exit(1);
}
const BOT_NAME_RAW = process.env.MC_CAMERA_BOT ?? 'CAMERA';
if (!/^[A-Za-z0-9_]{1,16}$/.test(BOT_NAME_RAW)) {
    console.error('FATAL: MC_CAMERA_BOT must be 1-16 chars [A-Za-z0-9_], got:', BOT_NAME_RAW);
    process.exit(1);
}
const BOT_NAME = BOT_NAME_RAW;
const OUTPUT = (() => {
    const raw = parseOutput(process.argv) ?? path.join(__dirname, 'screenshot.png');
    try {
        return validateOutputPath(raw);
    } catch (e) {
        console.error('FATAL:', e.message);
        process.exit(1);
    }
})();

// Camera pose - isometric-ish south-east overhead, looking at fort center
const CAM = new THREE.Vector3(115, -45, 125);
const LOOK = new THREE.Vector3(99, -55, 99);
const FOV = 90;
const WIDTH = 1920;
const HEIGHT = 1080;
const VIEW_DISTANCE = 8;

async function rcon(cmd) {
    const TIMEOUT_MS = 8000;
    // Same pattern as src/index.js's rconConnectWithTimeout: hold the eventual
    // connection in a closure so a late-arriving socket can't leak when the
    // timeout fires first.
    const holder = { r: null };
    const connectP = Rcon.connect({ host: HOST, port: 25575, password: RCON_PASSWORD })
        .then(r => { holder.r = r; return r; });
    const timeoutP = new Promise((_, rej) => setTimeout(() => {
        rej(new Error('rcon connect timeout'));
        connectP.then(r => {
            try { r.socket?.destroy?.(); } catch { /* ignore */ }
            try { r.end?.(); } catch { /* ignore */ }
        }).catch(() => {});
    }, TIMEOUT_MS));
    try {
        const r = await Promise.race([connectP, timeoutP]);
        return await Promise.race([
            r.send(cmd),
            new Promise((_, rej) => setTimeout(() => rej(new Error('rcon send timeout')), TIMEOUT_MS)),
        ]);
    } finally {
        if (holder.r) { try { await holder.r.end(); } catch { /* ignore cleanup errors */ } }
    }
}

const bot = mineflayer.createBot({
    host: HOST, port: 25565, username: BOT_NAME, version: '1.21.4', auth: 'offline'
});
await new Promise((res, rej) => {
    bot.once('spawn', res);
    bot.once('error', rej);
    bot.once('kicked', (r) => rej(new Error('kicked: ' + JSON.stringify(r))));
    bot.once('end', (reason) => rej(new Error('ended before spawn: ' + reason)));
});
console.log('bot spawned at', bot.entity.position);

await rcon(`gamemode spectator ${BOT_NAME}`);
// teleport bot to camera position so its chunk loader spans the fort
await rcon(`tp ${BOT_NAME} ${CAM.x} ${CAM.y} ${CAM.z}`);
console.log('teleported, waiting for chunks');
await new Promise(r => setTimeout(r, 5000));
console.log('bot pos after wait:', bot.entity.position);

const canvas = createCanvas(WIDTH, HEIGHT);
const renderer = new THREE.WebGLRenderer({ canvas });
renderer.setSize(WIDTH, HEIGHT, false);

const viewer = new Viewer(renderer);
if (!viewer.setVersion(bot.version)) {
    console.error('unsupported version', bot.version);
    process.exit(1);
}

// Override camera with our custom pose + FOV
viewer.camera.fov = FOV;
viewer.camera.aspect = WIDTH / HEIGHT;
viewer.camera.near = 0.1;
viewer.camera.far = 2000;
viewer.camera.position.copy(CAM);
viewer.camera.lookAt(LOOK);
viewer.camera.updateProjectionMatrix();

const worldView = new WorldView(bot.world, VIEW_DISTANCE, bot.entity.position);
viewer.listen(worldView);
worldView.listenToBot(bot);

let chunks = 0;
worldView.on('loadChunk', () => { chunks++; });

// wait for bot to actually receive chunks
console.log('waiting for chunks to arrive at bot.world...');
await new Promise(r => setTimeout(r, 4000));

await worldView.init(bot.entity.position);
console.log(`init done. chunks loaded so far: ${chunks}`);

// give WorldRenderer worker time to build meshes + textures to load
console.log('waiting for meshes + textures...');
await new Promise(r => setTimeout(r, 10000));
if (typeof viewer.waitForChunksToRender === 'function') {
    try { await Promise.race([viewer.waitForChunksToRender(), new Promise(r => setTimeout(r, 15000))]); console.log('chunks rendered signal'); } catch {}
}
// additional wait for texture loading
await new Promise(r => setTimeout(r, 3000));
console.log(`final chunks: ${chunks}, meshes: ${Object.keys(viewer.world.sectionMeshs).length}, textureLoaded: ${!!viewer.world.material.map}`);

// Debug: count non-air blocks in fort area
{
    const { Vec3 } = await import('vec3');
    let nonAir = 0;
    const types = {};
    for (let x = 89; x <= 110; x++) for (let y = -64; y <= -50; y++) for (let z = 89; z <= 110; z++) {
        const b = bot.blockAt(new Vec3(x, y, z));
        if (b && b.name !== 'air') { nonAir++; types[b.name] = (types[b.name] ?? 0) + 1; }
    }
    console.log('non-air blocks in fort area (bot.world):', nonAir, types);
}

// Re-apply camera pose (in case something reset it)
viewer.camera.position.copy(CAM);
viewer.camera.lookAt(LOOK);
viewer.camera.updateProjectionMatrix();

// Debug: disable alphaTest to see if UV maps to transparent atlas area
viewer.world.material.alphaTest = 0;
viewer.world.material.transparent = false;
viewer.world.material.needsUpdate = true;

viewer.update();
renderer.render(viewer.scene, viewer.camera);
console.log('rendered');

// node-canvas-webgl: use toBuffer for PNG
let pngBuffer;
if (typeof canvas.toBuffer === 'function') {
    pngBuffer = canvas.toBuffer('image/png');
} else if (typeof canvas.createPNGStream === 'function') {
    pngBuffer = await getBufferFromStream(canvas.createPNGStream());
} else {
    throw new Error('no PNG export method on canvas');
}
await writeFile(OUTPUT, pngBuffer);
console.log('saved', OUTPUT, pngBuffer.length, 'bytes');

try { bot.quit(); } catch {}
process.exit(0);
