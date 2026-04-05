const { Telegraf, session } = require("telegraf");
const fs = require("fs");
const http = require("http");

const bot = new Telegraf(process.env.BOT_TOKEN);

const OWNER_ID = 7021210744;
const DATA_FILE = "./data.json";

/* ================= LOAD DATA ================= */

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE));
        }
    } catch (e) {
        console.log("load error", e);
    }
    return {
        premiumUsers: {},
        premiumGroups: [],
        rooms: {},
    };
}

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(database, null, 2));
    } catch (e) {
        console.log("save error", e);
    }
}

let database = loadData();

if (
    typeof database.premiumUsers !== "object" ||
    Array.isArray(database.premiumUsers)
) {
    database.premiumUsers = {};
}
if (!Array.isArray(database.premiumGroups)) {
    database.premiumGroups = [];
}
if (!database.rooms) {
    database.rooms = {};
}

/* ================= HELPERS ================= */

function getFee(betAmount) {
    if (betAmount >= 1000 && betAmount <= 1999) return 500;
    if (betAmount >= 2000 && betAmount <= 9000) return 1000;
    if (betAmount >= 10000 && betAmount <= 19000) return 2000;
    if (betAmount >= 20000 && betAmount <= 29000) return 3000;
    if (betAmount >= 30000 && betAmount <= 39000) return 4000;
    if (betAmount >= 40000 && betAmount <= 49000) return 5000;
    if (betAmount >= 50000 && betAmount <= 59000) return 6000;
    if (betAmount >= 60000 && betAmount <= 69000) return 7000;
    if (betAmount >= 70000 && betAmount <= 79000) return 8000;
    if (betAmount >= 80000 && betAmount <= 89000) return 9000;
    if (betAmount >= 90000 && betAmount <= 100000) return 10000;
    return 0;
}

function fmt(n) {
    if (n >= 1000 && n % 1000 === 0) return `${n / 1000}k`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return `${n}`;
}

function parseAmount(str) {
    if (!str) return 0;
    let cleanStr = str.replace(/lf/gi, "").trim();
    const kMatch = cleanStr.match(/([\d.]+)k/i);
    if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1000);
    const num = cleanStr.match(/[\d.]+/);
    return num ? Math.round(parseFloat(num[0])) : 0;
}

/* ================= UTANG (LF) ================= */

function parseUtang(lwText) {
    const lines = lwText.split("\n");
    let lfIndex = -1;
    const utang = {};

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().toUpperCase() === "LF") {
            lfIndex = i;
            break;
        }
    }

    if (lfIndex === -1) return { utang: {}, lfIndex: -1, utangIndices: [] };

    const utangIndices = [];
    for (let i = lfIndex + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === "") continue;
        const match = line.match(/^([A-Za-z0-9_]+)\s+(\d+)/i);
        if (match) {
            utang[match[1].toUpperCase()] = parseInt(match[2]);
            utangIndices.push(i);
        } else {
            break;
        }
    }

    return { utang, lfIndex, utangIndices };
}

function writeUtang(lwText, utang, lfIndex, utangIndices) {
    let lines = lwText.split("\n");

    if (utangIndices && utangIndices.length > 0) {
        [...utangIndices]
            .sort((a, b) => b - a)
            .forEach((idx) => lines.splice(idx, 1));
    }

    const newLines = Object.entries(utang)
        .filter(([, amt]) => amt > 0)
        .map(([name, amt]) => `${name} ${amt}`);

    if (newLines.length > 0) {
        if (lfIndex === -1 || lfIndex === undefined) {
            lines.push("", "LF");
            lines.push(...newLines);
        } else {
            lines.splice(lfIndex + 1, 0, ...newLines);
        }
    }

    return lines.join("\n");
}

/* ================= PARSING SALDO ================= */

function parseSaldo(lwText) {
    const lines = lwText.split("\n");
    let saldoLineIndex = -1;

    for (let i = 0; i < lines.length; i++) {
        if (/SALDO PEMAIN/i.test(lines[i])) {
            saldoLineIndex = i;
            break;
        }
    }

    if (saldoLineIndex === -1) return null;

    const players = {};
    const playerIndices = [];

    for (let i = saldoLineIndex + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === "") continue;
        if (line.toUpperCase() === "LF") break;

        const match = line.match(/^([A-Za-z0-9_]+)\s+(\d+)/i);
        if (match) {
            players[match[1].toUpperCase()] = parseInt(match[2]);
            playerIndices.push(i);
        } else {
            break;
        }
    }

    return { players, saldoLineIndex, playerIndices };
}

function writeSaldo(lwText, players, saldoLineIndex, playerIndices) {
    let lines = lwText.split("\n");

    const total = Object.values(players).reduce((a, b) => a + b, 0);

    const saldoLine = lines[saldoLineIndex];
    if (/\(.*?\)/.test(saldoLine)) {
        lines[saldoLineIndex] = saldoLine.replace(/\(.*?\)/, `(${total})`);
    } else {
        lines[saldoLineIndex] = saldoLine.trimEnd() + ` (${total})`;
    }

    [...playerIndices]
        .sort((a, b) => b - a)
        .forEach((idx) => lines.splice(idx, 1));

    const newLines = Object.entries(players)
        .filter(([, amt]) => amt > 0)
        .map(([name, amt]) => `${name} ${amt}`);

    if (newLines.length > 0) {
        lines.splice(saldoLineIndex + 1, 0, ...newLines);
    }

    return lines.join("\n");
}

function createEmptyLW() {
    return "SALDO PEMAIN : (0)";
}

/* ================= ROOM SYSTEM ================= */

function getRoom(chatId) {
    if (!database.rooms[chatId]) {
        database.rooms[chatId] = {
            tempLW: createEmptyLW(),
            history: [],
            bets: { K: {}, B: {} },
            state: { step: 0, mode: "", m1: "", m2: "", m3: "" },
        };
    }
    if (!database.rooms[chatId].bets) {
        database.rooms[chatId].bets = { K: {}, B: {} };
    }
    if (
        !database.rooms[chatId].tempLW ||
        database.rooms[chatId].tempLW === ""
    ) {
        database.rooms[chatId].tempLW = createEmptyLW();
    }
    return database.rooms[chatId];
}

/* ================= ACCESS CONTROL ================= */

function isAllowed(ctx) {
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    if (userId === OWNER_ID) return true;
    if (
        database.premiumUsers[userId] &&
        Date.now() < database.premiumUsers[userId]
    )
        return true;
    if (database.premiumGroups.includes(chatId)) return true;
    return false;
}

bot.use(session());
bot.use((ctx, next) => {
    if (!ctx.message) return next();
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    if (userId === OWNER_ID) return next();
    if (
        database.premiumUsers[userId] &&
        Date.now() < database.premiumUsers[userId]
    )
        return next();
    if (database.premiumGroups.includes(chatId)) return next();
    return ctx.reply("❌ Bot private. Minta akses ke owner.");
});

/* ================= PREMIUM COMMAND ================= */

bot.command("addprem", (ctx) => {
    if (ctx.from.id !== OWNER_ID) return;
    const args = ctx.message.text.split(" ");
    const id = args[1];
    const hours = args[2];
    if (!id || !hours) return ctx.reply("Format: /addprem USERID JAM");
    database.premiumUsers[id] = Date.now() + Number(hours) * 60 * 60 * 1000;
    saveData();
    ctx.reply(`✅ User ${id} premium selama ${hours} jam.`);
});

bot.command("addgroup", (ctx) => {
    if (ctx.from.id !== OWNER_ID) return;
    const chatId = ctx.chat.id;
    if (!database.premiumGroups.includes(chatId))
        database.premiumGroups.push(chatId);
    saveData();
    ctx.reply("✅ Grup ini sekarang premium.");
});

bot.command("delprem", (ctx) => {
    if (ctx.from.id !== OWNER_ID) return;
    const id = ctx.message.text.split(" ")[1];
    if (!id) return ctx.reply("Format: /delprem USERID");
    if (!database.premiumUsers[id])
        return ctx.reply("User tidak ada di premium.");
    delete database.premiumUsers[id];
    saveData();
    ctx.reply(`❌ User ${id} dihapus dari premium.`);
});

bot.command("cekprem", (ctx) => {
    if (ctx.from.id !== OWNER_ID) return;
    const users = Object.keys(database.premiumUsers);
    if (users.length === 0) return ctx.reply("Tidak ada user premium.");
    let msg = "👑 LIST USER PREMIUM\n\n";
    users.forEach((id, i) => {
        const sisa = Math.floor(
            (database.premiumUsers[id] - Date.now()) / 3600000,
        );
        msg += `${i + 1}. ${id} (${sisa} jam lagi)\n`;
    });
    ctx.reply(msg);
});

/* ================= BOT COMMAND ================= */

bot.command("help", (ctx) => {
    ctx.reply(`📌 DAFTAR PERINTAH BOT REKAP KB

/svlw : (Reply pesan LW) Simpan list pasang
/rekapwin : Mulai proses rekap
/rekap : Tampilkan LW
/resetlw : Hapus LW
/cancel : Batalkan proses
/help : Menu user
/bet : (Reply pesan taruhan) Hitung taruhan
/depo : Tambah saldo pemain
/win : Proses kemenangan manual
/lunaslf : Lunasi utang pemain
/lunaslfnom : Lunasi utang pemain nyicil
/ceklf : Cek daftar utang
/owner : Info owner & harga sewa
/harga : Harga sewa bot
/sosmed : Sosial media owner


💡 Tips: Saat rekapwin, ikuti instruksi bot (Balas MPL/1M, lalu K/B).
Gunakan "lf" di akhir taruhan untuk utang. Contoh: REY 10000 lf`);
});

bot.command("helpown", (ctx) => {
    if (ctx.from.id !== OWNER_ID) return;
    ctx.reply(`👑 OWNER PANEL

USER COMMAND:
/svlw, /rekapwin, /rekap, /resetlw, /cancel, /bet, /depo, /win, /lunaslf, /ceklf

INFO & SEWA:
/owner, /harga, /sosmed

OWNER COMMAND:
/addprem, /addgroup, /delprem, /cekprem, /helpown

FITUR LF (UTANG):
- Taruhan dengan "lf": REY 10000 lf
- Kalah: otomatis masuk daftar LF
- Menang: potong utang dulu baru masuk saldo
- /lunaslf NAMA NOMINAL - lunasi utang
- /ceklf - cek daftar utang`);
});

bot.command("bet", async (ctx) => {
    if (!ctx.message.reply_to_message) {
        return ctx.reply("Reply pesan taruhan dulu.");
    }

    const room = getRoom(ctx.chat.id);
    const text = ctx.message.reply_to_message.text;
    const lines = text.split("\n");

    let currentSide = "";
    const bets = { K: {}, B: {} };

    lines.forEach((line) => {
        const clean = line.trim().toUpperCase();
        if (clean === "K") {
            currentSide = "K";
            return;
        }
        if (clean === "B") {
            currentSide = "B";
            return;
        }
        if (!currentSide) return;

        const match = line.trim().match(/^(\S+)\s+(.+)$/);
        if (match) {
            let name = match[1].toUpperCase();
            let amountStr = match[2];
            let isUtang = false;

            if (name.endsWith("LF")) {
                name = name.replace(/LF$/, "");
                isUtang = true;
            }
            if (amountStr.toLowerCase().includes("lf")) {
                amountStr = amountStr.replace(/lf/gi, "").trim();
                isUtang = true;
            }

            const amount = parseAmount(amountStr);
            if (amount > 0) {
                if (!bets[currentSide][name]) {
                    bets[currentSide][name] = { amount: 0, utang: false };
                }
                bets[currentSide][name].amount += amount;
                if (isUtang) {
                    bets[currentSide][name].utang = true;
                }
            }
        }
    });

    room.bets = bets;

    if (room.tempLW) {
        const saldoData = parseSaldo(room.tempLW);
        if (saldoData) {
            let updated = false;
            for (const side of ["K", "B"]) {
                for (const name of Object.keys(bets[side])) {
                    if (!(name in saldoData.players)) {
                        saldoData.players[name] = 0;
                        updated = true;
                    }
                }
            }
            if (updated) {
                room.tempLW = writeSaldo(
                    room.tempLW,
                    saldoData.players,
                    saldoData.saldoLineIndex,
                    saldoData.playerIndices,
                );
                saveData();
            }
        }
    }

    let totalK = 0;
    let totalB = 0;
    for (const [name, data] of Object.entries(bets.K)) {
        totalK += data.amount;
    }
    for (const [name, data] of Object.entries(bets.B)) {
        totalB += data.amount;
    }

    let result = "";
    let winner = "";
    let warning = "";

    if (totalB > totalK) {
        result = `🐠K masih kekurangan ${fmt(totalB - totalK)} untuk menyamai B.`;
        winner = "B";
    } else if (totalK > totalB) {
        result = `🐠B masih kekurangan ${fmt(totalK - totalB)} untuk menyamai K.`;
        winner = "K";
    } else {
        result = `⚖️ B dan K sudah seimbang.`;
        warning = `\n(CEK NAMA + NOMINAL MASING² KALAU UDAH MAEN BARU PROTES BRRTI HANGUS)`;
    }

    let lfList = "";
    for (const side of ["K", "B"]) {
        for (const [name, data] of Object.entries(bets[side])) {
            if (data.utang) {
                lfList += `⚠️ ${name} (${side}) bertaruh dengan status UTANG\n`;
            }
        }
    }
    if (lfList) {
        lfList = "\n📌 STATUS UTANG (LF):\n" + lfList;
    }

    ctx.reply(
        `🔵 B: [${fmt(totalB)}] = ${fmt(totalB)}\n\n🔵 K: [${fmt(totalK)}] = ${fmt(totalK)}\n\n${result}\n\n💰 Saldo Anda seharusnya: ${fmt(Math.max(totalB, totalK))}${winner ? " " + winner : ""}${warning}${lfList}`,
    );
});

bot.command("svlw", (ctx) => {
    const room = getRoom(ctx.chat.id);
    if (ctx.message.reply_to_message) {
        room.tempLW = ctx.message.reply_to_message.text;
        saveData();
        return ctx.reply("✅ LW disimpan.");
    }
    ctx.reply("Reply pesan LW.");
});

bot.command("rekap", (ctx) => {
    const room = getRoom(ctx.chat.id);
    if (!room.tempLW) return ctx.reply("Belum ada LW.");
    ctx.reply(room.tempLW);
});

bot.command("resetlw", (ctx) => {
    const room = getRoom(ctx.chat.id);
    room.tempLW = createEmptyLW();
    room.history = [];
    room.bets = { K: {}, B: {} };
    room.state = { step: 0, mode: "", m1: "", m2: "", m3: "" };
    saveData();
    ctx.reply("✅ LW direset.");
});

bot.command("cancel", (ctx) => {
    const room = getRoom(ctx.chat.id);
    room.state = { step: 0, mode: "", m1: "", m2: "", m3: "" };
    ctx.reply("❌ Proses dibatalkan.");
});

bot.command("rekapwin", (ctx) => {
    const room = getRoom(ctx.chat.id);
    if (!room.tempLW) return ctx.reply("Simpan LW dulu pakai /svlw");
    room.state = { step: 1, mode: "", m1: "", m2: "", m3: "" };
    ctx.reply("Pilih Mode:\nMPL\n1M");
});

bot.command("depo", (ctx) => {
    if (!isAllowed(ctx)) return ctx.reply("❌ Akses ditolak.");
    const args = ctx.message.text.split(" ");
    const name = args[1]?.toUpperCase();
    const amount = parseAmount(args[2]);
    if (!name || !amount)
        return ctx.reply("Format: /depo NAMA NOMINAL\nContoh: /depo LEVIN 50k");
    const room = getRoom(ctx.chat.id);
    let saldoData = parseSaldo(room.tempLW);
    if (!saldoData) {
        room.tempLW = createEmptyLW();
        saldoData = parseSaldo(room.tempLW);
    }
    const prev = saldoData.players[name] || 0;
    saldoData.players[name] = prev + amount;
    room.tempLW = writeSaldo(
        room.tempLW,
        saldoData.players,
        saldoData.saldoLineIndex,
        saldoData.playerIndices,
    );
    saveData();
    ctx.reply(
        `✅ Depo ${name}: +${fmt(amount)}\nSaldo: ${fmt(prev)} → ${fmt(saldoData.players[name])}\n\n📋 LW:\n${room.tempLW}`,
    );
});

bot.command("win", (ctx) => {
    const args = ctx.message.text.split(" ");
    const winner = args[1]?.trim().toUpperCase();

    if (winner !== "K" && winner !== "B") {
        return ctx.reply("Format: /win K atau /win B");
    }

    const room = getRoom(ctx.chat.id);
    const bets = room.bets || { K: {}, B: {} };
    const totalBets = Object.keys(bets.K).length + Object.keys(bets.B).length;

    if (totalBets === 0) {
        return ctx.reply("❌ Belum ada taruhan. Gunakan /bet dulu.");
    }

    if (!room.tempLW) {
        return ctx.reply("❌ Tidak ada LW tersimpan.");
    }

    const saldoData = parseSaldo(room.tempLW);
    if (!saldoData) {
        return ctx.reply("❌ Tidak ada bagian SALDO PEMAIN di LW.");
    }

    const { players } = saldoData;
    const loser = winner === "K" ? "B" : "K";
    let log = `🏆 HASIL — ${winner} MENANG\n\n`;

    for (const [name, data] of Object.entries(bets[winner])) {
        const bet = data.amount || data;
        const isUtang = data.utang || false;
        const gross = bet * 2;
        const fee = getFee(bet);
        let net = gross - fee;

        if (isUtang) {
            const utangData = parseUtang(room.tempLW);
            const utangAmount = utangData.utang[name] || 0;
            if (utangAmount > 0) {
                const potongan = Math.min(net, utangAmount);
                net -= potongan;
                utangData.utang[name] = utangAmount - potongan;
                if (utangData.utang[name] <= 0) delete utangData.utang[name];
                room.tempLW = writeUtang(
                    room.tempLW,
                    utangData.utang,
                    utangData.lfIndex,
                    utangData.utangIndices,
                );
                log += `   (Potong utang: ${fmt(potongan)})\n`;
            }
        }

        const prev = players[name] || 0;
        players[name] = prev + net;
        log += `✅ ${name}: bet ${fmt(bet)} → +${fmt(net)} (fee ${fmt(fee)})\n`;
        log += `   Saldo: ${fmt(prev)} → ${fmt(players[name])}\n\n`;
    }

    for (const [name, data] of Object.entries(bets[loser])) {
        const bet = data.amount || data;
        const isUtang = data.utang || false;
        const prev = players[name] || 0;

        if (isUtang) {
            const utangData = parseUtang(room.tempLW);
            utangData.utang[name] = (utangData.utang[name] || 0) + bet;
            room.tempLW = writeUtang(
                room.tempLW,
                utangData.utang,
                utangData.lfIndex,
                utangData.utangIndices,
            );
            log += `❌ ${name}: kalah ${fmt(bet)} → UTANG +${fmt(bet)}\n`;
            log += `   Saldo: ${fmt(prev)} → ${fmt(players[name])}\n\n`;
        } else {
            players[name] = Math.max(0, prev - bet);
            log += `❌ ${name}: kalah ${fmt(bet)}\n`;
            log += `   Saldo: ${fmt(prev)} → ${fmt(players[name])}\n\n`;
        }
    }

    room.tempLW = writeSaldo(
        room.tempLW,
        players,
        saldoData.saldoLineIndex,
        saldoData.playerIndices,
    );
    room.bets = { K: {}, B: {} };
    saveData();

    ctx.reply(log + `\n📋 LW:\n${room.tempLW}`);
});

/* ================= LUNASTF (LUNAS UTANG) ================= */

bot.command("lunaslf", (ctx) => {
    if (!isAllowed(ctx)) return ctx.reply("❌ Akses ditolak.");

    const args = ctx.message.text.split(" ");
    const name = args[1]?.toUpperCase();

    if (!name) {
        return ctx.reply(
            "Format: /lunaslf NAMA\n\nContoh:\n/lunaslf REY\n\nUtang akan langsung lunas semua.",
        );
    }

    const room = getRoom(ctx.chat.id);
    if (!room.tempLW) return ctx.reply("❌ Tidak ada LW tersimpan.");

    // Ambil data utang saat ini
    const utangData = parseUtang(room.tempLW);
    const currentUtang = utangData.utang[name] || 0;

    if (currentUtang === 0) {
        return ctx.reply(`✅ ${name} tidak memiliki utang.`);
    }

    // Ambil data saldo pemain
    let saldoData = parseSaldo(room.tempLW);
    if (!saldoData) {
        room.tempLW = createEmptyLW();
        saldoData = parseSaldo(room.tempLW);
    }

    const currentSaldo = saldoData.players[name] || 0;

    if (currentSaldo < currentUtang) {
        return ctx.reply(
            `❌ Saldo ${name} tidak cukup: ${fmt(currentSaldo)} < ${fmt(currentUtang)}\n\nGunakan /depo dulu untuk menambah saldo.`,
        );
    }

    // Proses pelunasan FULL: kurangi saldo, hapus utang
    saldoData.players[name] = currentSaldo - currentUtang;
    delete utangData.utang[name];

    // Update LW
    room.tempLW = writeSaldo(
        room.tempLW,
        saldoData.players,
        saldoData.saldoLineIndex,
        saldoData.playerIndices,
    );
    room.tempLW = writeUtang(
        room.tempLW,
        utangData.utang,
        utangData.lfIndex,
        utangData.utangIndices,
    );
    saveData();

    ctx.reply(
        `✅ ${name} melunasi semua utang: ${fmt(currentUtang)}\n   Saldo: ${fmt(currentSaldo)} → ${fmt(saldoData.players[name])}\n   Status: LUNAS TOTAL 🎉`,
    );
});

bot.command("lunaslfnom", (ctx) => {
    if (!isAllowed(ctx)) return ctx.reply("❌ Akses ditolak.");

    const args = ctx.message.text.split(" ");
    const name = args[1]?.toUpperCase();
    const amount = parseAmount(args[2]);

    if (!name || !amount) {
        return ctx.reply(
            "Format: /lunaslfnom NAMA NOMINAL\n\nContoh:\n/lunaslfnom REY 5000\n\nUntuk lunas semua pakai /lunaslf REY",
        );
    }

    const room = getRoom(ctx.chat.id);
    if (!room.tempLW) return ctx.reply("❌ Tidak ada LW tersimpan.");

    const utangData = parseUtang(room.tempLW);
    const currentUtang = utangData.utang[name] || 0;

    if (currentUtang === 0) {
        return ctx.reply(`✅ ${name} tidak memiliki utang.`);
    }

    if (amount > currentUtang) {
        return ctx.reply(
            `❌ Utang ${name} hanya ${fmt(currentUtang)}. Tidak bisa lunasi lebih dari itu.\n\nGunakan /lunaslf ${name} untuk lunas semua.`,
        );
    }

    let saldoData = parseSaldo(room.tempLW);
    if (!saldoData) {
        room.tempLW = createEmptyLW();
        saldoData = parseSaldo(room.tempLW);
    }

    const currentSaldo = saldoData.players[name] || 0;

    if (currentSaldo < amount) {
        return ctx.reply(
            `❌ Saldo ${name} tidak cukup: ${fmt(currentSaldo)} < ${fmt(amount)}`,
        );
    }

    saldoData.players[name] = currentSaldo - amount;
    utangData.utang[name] = currentUtang - amount;

    if (utangData.utang[name] <= 0) {
        delete utangData.utang[name];
    }

    room.tempLW = writeSaldo(
        room.tempLW,
        saldoData.players,
        saldoData.saldoLineIndex,
        saldoData.playerIndices,
    );
    room.tempLW = writeUtang(
        room.tempLW,
        utangData.utang,
        utangData.lfIndex,
        utangData.utangIndices,
    );
    saveData();

    const sisaUtang = utangData.utang[name] || 0;
    ctx.reply(
        `✅ ${name} melunasi utang: ${fmt(amount)}\n   Saldo: ${fmt(currentSaldo)} → ${fmt(saldoData.players[name])}\n   Utang: ${fmt(currentUtang)} → ${fmt(sisaUtang)}`,
    );
});

bot.command("ceklf", (ctx) => {
    const room = getRoom(ctx.chat.id);
    if (!room.tempLW) return ctx.reply("❌ Tidak ada LW tersimpan.");

    const utangData = parseUtang(room.tempLW);
    const utangList = Object.entries(utangData.utang);

    if (utangList.length === 0) {
        return ctx.reply("✅ Tidak ada pemain yang memiliki utang (LF).");
    }

    let msg = "📋 DAFTAR UTANG (LF)\n\n";
    utangList.forEach(([name, amount], i) => {
        msg += `${i + 1}. ${name} : ${fmt(amount)}\n`;
    });
    msg += `\n💡 Gunakan /lunaslf NAMA NOMINAL untuk melunasi.`;

    ctx.reply(msg);
});

/* ================= OWNER SOCIAL MEDIA & SEWA BOT ================= */

const OWNER_SOCIAL = {
    instagram: "https://instagram.com/rey_wkw",
    whatsapp: "https://wa.me/62895708952299",
    telegram: "https://t.me/laaskidipapap",
};

const SEWA_BOT = {
    harian: { harga: 5000, keterangan: "Premium 24 jam + akses full fitur" },
    mingguan: { harga: 15000, keterangan: "Premium 7 hari + akses full fitur" },
    bulanan: {
        harga: 50000,
        keterangan: "Premium 30 hari + akses full fitur + prioritas support",
    },
};
/* ================= TAG ALL MEMBER ================= */

bot.command("tagall", async (ctx) => {
    // Cek apakah di grup
    if (ctx.chat.type === "private") {
        return ctx.reply(
            "❌ Perintah /tagall hanya bisa digunakan di dalam grup.",
        );
    }

    // Cek akses premium
    if (!isAllowed(ctx)) {
        return ctx.reply(
            "❌ Fitur tagall hanya untuk grup premium. Hubungi owner untuk info sewa.\n\nKetik /owner",
        );
    }

    // Ambil teks setelah command
    let pesan = ctx.message.text.replace("/tagall", "").trim();
    if (!pesan) {
        pesan = "Ada pemberitahuan penting dari admin!";
    }

    // Kirim pesan dengan @all
    await ctx.reply(`📢 *PENGUMUMAN*\n\n${pesan}\n\n@all`, {
        parse_mode: "Markdown",
    });

    // Hapus perintah user biar tidak berantakan
    try {
        await ctx.deleteMessage(ctx.message.message_id);
    } catch (e) {}
});

bot.command("owner", (ctx) => {
    ctx.reply(`👑 OWNER BOT REKAP KB

📱 SOSIAL MEDIA
• Instagram : ${OWNER_SOCIAL.instagram}
• WhatsApp  : ${OWNER_SOCIAL.whatsapp}
• Telegram  : ${OWNER_SOCIAL.telegram} 

💰 HARGA SEWA BOT
• Harian   : Rp${SEWA_BOT.harian.harga.toLocaleString()} (${SEWA_BOT.harian.keterangan})
• Mingguan : Rp${SEWA_BOT.mingguan.harga.toLocaleString()} (${SEWA_BOT.mingguan.keterangan})
• Bulanan  : Rp${SEWA_BOT.bulanan.harga.toLocaleString()} (${SEWA_BOT.bulanan.keterangan})

💡 CARA SEWA
Chat owner via WhatsApp/Telegram di atas

© 2024 - Bot Rekap KB | @rey_wkw`);
});

bot.command("harga", (ctx) => {
    ctx.reply(`💰 HARGA SEWA BOT REKAP KB

• Harian   : Rp${SEWA_BOT.harian.harga.toLocaleString()}
  ${SEWA_BOT.harian.keterangan}

• Mingguan : Rp${SEWA_BOT.mingguan.harga.toLocaleString()}
  ${SEWA_BOT.mingguan.keterangan}

• Bulanan  : Rp${SEWA_BOT.bulanan.harga.toLocaleString()}
  ${SEWA_BOT.bulanan.keterangan}

📞 Untuk info lebih lanjut, ketik /owner`);
});

bot.command("sosmed", (ctx) => {
    ctx.reply(`📱 SOSIAL MEDIA OWNER

• Instagram : ${OWNER_SOCIAL.instagram}
• WhatsApp  : ${OWNER_SOCIAL.whatsapp}
• Telegram  : ${OWNER_SOCIAL.telegram} "-"}

💬 Chat owner untuk info sewa bot (ketik /harga)`);
});

/* ================= GAME INPUT ================= */

bot.on("text", (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    const room = getRoom(ctx.chat.id);
    const state = room.state;
    const input = ctx.message.text.toUpperCase();
    if (state.step === 1) {
        if (input === "1M") {
            state.mode = "1M";
            state.step = 2;
            return ctx.reply("Siapa menang? K/B");
        }
        if (input === "MPL") {
            state.mode = "MPL";
            state.step = 2;
            return ctx.reply("M1 siapa menang? K/B");
        }
    }
    if (state.step === 2) {
        if (input === "K" || input === "B") {
            state.m1 = input;
            if (state.mode === "1M") return finish(ctx, room, `${input} 1-0`);
            state.step = 3;
            return ctx.reply("M2 siapa menang?");
        }
    }
    if (state.step === 3) {
        if (input === "K" || input === "B") {
            state.m2 = input;
            if (state.m1 === state.m2) return finish(ctx, room, `${input} 2-0`);
            state.step = 4;
            return ctx.reply("M3 penentuan.");
        }
    }
    if (state.step === 4) {
        if (input === "K" || input === "B")
            return finish(ctx, room, `${input} 2-1`);
    }
});

function finish(ctx, room, result) {
    let lines = room.tempLW.split("\n");
    let gameLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        if (/GAME\s+\d+\s*:\s*$/i.test(lines[i])) {
            gameLineIndex = i;
            break;
        }
    }
    if (gameLineIndex !== -1) {
        lines[gameLineIndex] = lines[gameLineIndex] + ` ${result}`;
    } else {
        let lastGameIndex = -1,
            lastGameNumber = 0;
        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(/GAME\s+(\d+)/i);
            if (match) {
                lastGameIndex = i;
                lastGameNumber = Number(match[1]);
            }
        }
        const nextGame = lastGameNumber + 1;
        if (lastGameIndex !== -1) {
            lines.splice(lastGameIndex + 1, 0, `GAME ${nextGame} : ${result}`);
        } else {
            const saldoIndex = lines.findIndex((line) =>
                line.toUpperCase().includes("SALDO PEMAIN"),
            );
            if (saldoIndex !== -1)
                lines.splice(saldoIndex, 0, `GAME ${nextGame} : ${result}`);
            else lines.push(`GAME ${nextGame} : ${result}`);
        }
    }
    const bets = room.bets || { K: {}, B: {} };
    const totalBets = Object.keys(bets.K).length + Object.keys(bets.B).length;
    const [winner] = result.split(" ");
    let logBonus = "";
    if (totalBets > 0 && room.tempLW) {
        const saldoData = parseSaldo(lines.join("\n"));
        if (saldoData) {
            const { players } = saldoData;
            const loser = winner === "K" ? "B" : "K";
            logBonus = `\n💰 PEMBAYARAN OTOMATIS (${winner} menang ${result.split(" ")[1]})\n\n`;
            for (const [name, data] of Object.entries(bets[winner])) {
                const bet = data.amount || data;
                const isUtang = data.utang || false;
                const net = bet * 2 - getFee(bet);
                let finalNet = net;
                if (isUtang) {
                    const utangData = parseUtang(lines.join("\n"));
                    const utangAmount = utangData.utang[name] || 0;
                    if (utangAmount > 0) {
                        const potongan = Math.min(finalNet, utangAmount);
                        finalNet -= potongan;
                        utangData.utang[name] = utangAmount - potongan;
                        if (utangData.utang[name] <= 0)
                            delete utangData.utang[name];
                        lines = writeUtang(
                            lines.join("\n"),
                            utangData.utang,
                            utangData.lfIndex,
                            utangData.utangIndices,
                        ).split("\n");
                        logBonus += `   (Potong utang: ${fmt(potongan)})\n`;
                    }
                }
                const prev = players[name] || 0;
                players[name] = prev + finalNet;
                logBonus += `✅ ${name}: bet ${fmt(bet)} → +${fmt(finalNet)}\n   Saldo: ${fmt(prev)} → ${fmt(players[name])}\n\n`;
            }
            for (const [name, data] of Object.entries(bets[loser])) {
                const bet = data.amount || data;
                const isUtang = data.utang || false;
                const prev = players[name] || 0;
                if (isUtang) {
                    const utangData = parseUtang(lines.join("\n"));
                    utangData.utang[name] = (utangData.utang[name] || 0) + bet;
                    lines = writeUtang(
                        lines.join("\n"),
                        utangData.utang,
                        utangData.lfIndex,
                        utangData.utangIndices,
                    ).split("\n");
                    logBonus += `❌ ${name}: kalah ${fmt(bet)} → UTANG +${fmt(bet)}\n   Saldo: ${fmt(prev)} → ${fmt(players[name])}\n\n`;
                } else {
                    players[name] = Math.max(0, prev - bet);
                    logBonus += `❌ ${name}: kalah ${fmt(bet)}\n   Saldo: ${fmt(prev)} → ${fmt(players[name])}\n\n`;
                }
            }
            lines = writeSaldo(
                lines.join("\n"),
                players,
                saldoData.saldoLineIndex,
                saldoData.playerIndices,
            ).split("\n");
            room.bets = { K: {}, B: {} };
        }
    }
    room.tempLW = lines.join("\n");
    room.history.push(result);
    room.state = { step: 0, mode: "", m1: "", m2: "", m3: "" };
    saveData();
    ctx.reply((logBonus ? logBonus + "\n📋 LW:\n" : "") + room.tempLW);
}

/* ================= START BOT ================= */

bot.launch().then(async () => {
    console.log("✅ Bot aktif");
    await bot.telegram.setMyCommands([
        { command: "svlw", description: "Reply pesan LW untuk disimpan" },
        { command: "rekapwin", description: "Mulai proses rekap" },
        { command: "rekap", description: "Tampilkan LW yang tersimpan" },
        { command: "resetlw", description: "Hapus LW yang tersimpan" },
        { command: "cancel", description: "Batalkan proses rekap" },
        { command: "bet", description: "Reply pesan taruhan untuk dihitung" },
        { command: "depo", description: "Tambah saldo pemain" },
        { command: "win", description: "Proses kemenangan manual" },
        { command: "lunaslf", description: "Lunasi utang pemain" },
        { command: "ceklf", description: "Cek daftar utang" },
        { command: "help", description: "Daftar perintah" },
        { command: "owner", description: "Info owner & harga sewa" },
        { command: "harga", description: "Harga sewa bot" },
        { command: "sosmed", description: "Sosial media owner" },
    ]);
});

http.createServer((req, res) => {
    res.write("Bot Active");
    res.end();
}).listen(5000);
