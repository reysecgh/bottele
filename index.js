const { Telegraf } = require('telegraf');

// Render akan mengambil token dari menu Environment Variables yang kita isi nanti
const bot = new Telegraf(process.env.BOT_TOKEN);

// Perintah /start
bot.start((ctx) => {
    ctx.reply(`Halo ${ctx.from.first_name}! Bot kamu sudah berhasil berjalan di Render.`);
});

// Perintah /help
bot.help((ctx) => ctx.reply('Ada yang bisa saya bantu? Silakan kirim pesan apa saja.'));

// Respon otomatis jika ada teks "halo"
bot.hears('halo', (ctx) => ctx.reply('Halo juga! Selamat datang.'));

// Menangkap semua pesan teks
bot.on('text', (ctx) => {
    const pesan = ctx.message.text;
    ctx.reply(`Kamu mengirim pesan: ${pesan}`);
});

// Menjalankan bot
bot.launch().then(() => {
    console.log('Bot sedang berjalan...');
});

// Penanganan error ringan agar bot tidak crash
bot.catch((err, ctx) => {
    console.log(`Ooops, encountered an error for ${ctx.updateType}`, err);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));