import mineflayer from 'mineflayer';
const bot = mineflayer.createBot({
    host: '192.168.1.7', port: 25565, username: 'CLAUDE', version: '1.21.4', auth: 'offline'
});
bot.once('spawn', () => {
    console.log('spawn OK', bot.entity.position);
    bot.chat('/time set day');
    setTimeout(() => { bot.quit(); process.exit(0); }, 2000);
});
bot.on('error', (e) => { console.error('error', e); process.exit(1); });
bot.on('kicked', (r) => { console.error('kicked', r); process.exit(1); });
