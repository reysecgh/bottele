const { Telegraf } = require('telegraf');
const http = require('http');

// 1. Inisialisasi Bot dengan Token dari Secrets
const bot = new Telegraf(process.env.BOT_TOKEN);

// 2. Fitur Bot Sederhana
bot.start((ctx) => ctx.reply('Halo! Bot kamu sudah aktif di Replit.'));
bot.help((ctx) => ctx.reply('Ketik sesuatu untuk tes respon bot.'));
bot.on('text', (ctx) => ctx.reply(`Respon: ${ctx.message.text}`));

// 3. Menjalankan Bot
bot.launch().then(() => {
    console.log("✅ Bot sedang jalan...");
});

// 4. Server Tambahan (Agar Replit memberikan URL untuk di-ping)
http.createServer((req, res) => {
    res.write("Bot is alive!");
    res.end();
}).listen(8080);

// Stop bot dengan aman
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
