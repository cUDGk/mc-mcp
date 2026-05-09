// End-to-end test: spawn mc-mcp as child, drive it via MCP protocol over stdio.
import { spawn } from 'node:child_process';

const srv = spawn('node', ['src/index.js'], { stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '';
const pending = new Map();
srv.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
            const msg = JSON.parse(line);
            if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
        } catch {}
    }
});

let nextId = 1;
function rpc(method, params) {
    const id = nextId++;
    return new Promise((resolve) => {
        pending.set(id, resolve);
        srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
}
function notify(method, params) {
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

async function call(name, args) {
    const r = await rpc('tools/call', { name, arguments: args });
    const txt = r.result?.content?.[0]?.text ?? JSON.stringify(r);
    const err = r.result?.isError ? ' [ERROR]' : '';
    console.log(`\n>>> ${name}(${JSON.stringify(args)})${err}`);
    console.log(txt.length > 500 ? txt.slice(0, 500) + '...' : txt);
    return r;
}

try {
    const init = await rpc('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' }
    });
    console.log('initialize:', init.result?.serverInfo);
    notify('notifications/initialized');

    const list = await rpc('tools/list', {});
    console.log(`tools: ${list.result.tools.length} registered`);

    await call('spawn_bot', { name: 'TESTBOT' });
    await call('get_position', { name: 'TESTBOT' });
    await call('worldedit', { name: 'TESTBOT', command: 'pos1' });
    await call('worldedit', { name: 'TESTBOT', command: 'pos2 ~5 ~3 ~5' });
    await call('worldedit', { name: 'TESTBOT', command: 'set minecraft:diamond_block' });
    await new Promise(r => setTimeout(r, 1500));
    await call('scan_area', { name: 'TESTBOT', radius: 5 });
    await call('rcon', { command: 'time query daytime' });
    await call('list_bots', {});
    await call('disconnect_bot', { name: 'TESTBOT' });
    await new Promise(r => setTimeout(r, 500));
    console.log('\n=== ALL OK ===');
} catch (e) {
    console.error('FAILED:', e);
} finally {
    srv.kill();
    process.exit(0);
}
