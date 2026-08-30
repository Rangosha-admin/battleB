const crypto = require('crypto');
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    maxHttpBufferSize: 1e7,
    // Разрешаем и polling, и websocket: некоторые мобильные сети/прокси не пропускают
    // прямой апгрейд до WebSocket, и раньше (только 'websocket') такие игроки вообще
    // не могли подключиться. socket.io сам апгрейднет до websocket, когда это возможно.
    transports: ['polling', 'websocket'],
    pingInterval: 20000,
    pingTimeout: 20000
});

app.use(express.static('public'));
const path = require('path');
const fs = require('fs');

// Раздавать статические файлы из текущей директории
app.use(express.static(__dirname));

// ==================== АККАУНТЫ И ЛИГА ====================
// Простое файловое хранилище — без внешней БД. ВАЖНО: на бесплатном тарифе
// Render диск не персистентный, и этот файл (а с ним рейтинги всех игроков)
// будет обнуляться при каждом новом деплое/перезапуске сервиса. Для боевого
// использования лиги стоит перейти на настоящую БД или платный диск Render.
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
let accounts = {};
let championUsername = null; // ник текущего обладателя титула (или null, если трон свободен)
try {
    const raw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    accounts = raw.accounts || {};
    championUsername = raw.championUsername || null;
} catch (e) {
    accounts = {};
    championUsername = null;
}
function saveAccounts() {
    fs.writeFile(ACCOUNTS_FILE, JSON.stringify({ accounts, championUsername }, null, 2), (err) => {
        if (err) console.error('Не удалось сохранить accounts.json:', err);
    });
}

function hashPassword(password, salt) {
    return crypto.createHash('sha256').update(salt + password).digest('hex');
}

// Токены "запомнить меня" — только в памяти, сбрасываются при рестарте сервера
// (это не влияет на сами рейтинги — только на автовход без пароля).
let sessionTokens = {};

// Дивизионы: пороги РО (рейтинговых очков), плата за вход в матч и вес убийств.
// Бронза защищена от потери РО — это можно и нужно менять под баланс игры.
const DIVISIONS = [
    { id: 'bronze',   name: 'Бронза',  min: -Infinity, max: 99,       entryCost: 0,  killMult: 1   },
    { id: 'silver',   name: 'Серебро', min: 100,       max: 299,      entryCost: 5,  killMult: 1   },
    { id: 'gold',     name: 'Золото',  min: 300,       max: 599,      entryCost: 10, killMult: 1.2 },
    { id: 'platinum', name: 'Платина', min: 600,       max: 999,      entryCost: 15, killMult: 1.5 },
    { id: 'diamond',  name: 'Алмаз',   min: 1000,      max: Infinity, entryCost: 20, killMult: 2   }
];
function getDivision(rating) {
    return DIVISIONS.find(d => rating >= d.min && rating <= d.max) || DIVISIONS[0];
}

// Очки за место (P). Проценты — от общего числа "мест" в финальной таблице
// (соло-игрок или команда = одно место). Пороги совпадают с примером
// "10 человек в лобби": 1 место (10%) / 2-3 место (30%) / 4-6 место (60%) / 7-10 (остальное).
function placementPoints(rankIndex, totalCount) {
    const percentile = (rankIndex + 1) / totalCount;
    if (percentile <= 0.10) return 50;
    if (percentile <= 0.30) return 30;
    if (percentile <= 0.60) return 10;
    return -20;
}
const KILL_BONUS_BASE = 5;     // базовый бонус РО за одно убийство (K множится на killMult дивизиона)
const ALLIANCE_BREAK_BONUS = 10; // бонус тому, кто разорвал союз и всё равно попал в топ-30%

// ==================== ТИТУЛ ЧЕМПИОНА (трон над Алмазом) ====================
// Титул — один на весь сервер, выдаётся ЛУЧШЕМУ игроку в высшем дивизионе (Алмаз).
// Логика "трона":
//  1. Если действующий чемпион выпал из Алмаза (рейтинг упал ниже порога) — трон
//     свободен, и его сразу забирает лучший из оставшихся алмазных игроков.
//  2. Если чемпион всё ещё в Алмазе — сместить его может только претендент,
//     чей рейтинг СТРОГО выше рейтинга действующего чемпиона (нельзя занять трон
//     "по инерции" при равенстве очков — только реальным превосходством).
// Вызывается после каждого начисления рейтинга по итогам матча.
const CHAMPION_TITLE = 'Чемпион';

function recomputeChampion() {
    const oldKey = championUsername ? championUsername.toLowerCase() : null;
    const oldAcc = oldKey ? accounts[oldKey] : null;
    const oldHolderStillDiamond = !!(oldAcc && getDivision(oldAcc.rating).id === 'diamond');

    const diamondAccounts = Object.values(accounts).filter(a => getDivision(a.rating).id === 'diamond');

    const previousChampionName = oldAcc ? oldAcc.username : null;
    let newChampionName = previousChampionName;

    if (!oldHolderStillDiamond) {
        // Трон свободен — переходит к лучшему алмазному игроку, если такой есть.
        if (diamondAccounts.length > 0) {
            const best = diamondAccounts.reduce((a, b) => (b.rating > a.rating ? b : a));
            newChampionName = best.username;
        } else {
            newChampionName = null;
        }
    } else {
        // Чемпион всё ещё в Алмазе — ищем претендента, который строго его превзошёл.
        let bestChallenger = null;
        diamondAccounts.forEach((acc) => {
            if (acc === oldAcc) return;
            if (!bestChallenger || acc.rating > bestChallenger.rating) bestChallenger = acc;
        });
        if (bestChallenger && bestChallenger.rating > oldAcc.rating) {
            newChampionName = bestChallenger.username;
        }
    }

    const changed = (newChampionName || null) !== (previousChampionName || null);
    if (changed) championUsername = newChampionName;
    return { changed, newChampionName, previousChampionName };
}

function isChampionAccount(username) {
    return !!(username && championUsername && username.toLowerCase() === championUsername.toLowerCase());
}

// При запросе главной страницы отдавать index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let players = {};
let bubbles = {};
let teams = {};
let teamIdCounter = 0;
let checkpoints = [];
let bubbleIdCounter = 0;
const gameCenter = { lat: 41.3138361, lng: 69.2903755 };

// gameState: 'lobby' -> 'playing' -> 'finale_call' -> 'finale_countdown' -> 'finale_leaderboard' -> 'lobby'
let gameState = 'lobby';
let adminId = null;
let matchEndTime = 0;
let matchTimerInterval = null;
let bubbleSpawnInterval = null;
let finaleCountdownTimeout = null;

// Игровая зона: радиус карты + время на возврат
const ZONE_RADIUS = 375; // метров, совпадает с радиусом на клиенте
const ZONE_GRACE_MS = 90000; // 90 секунд на возврат в зону
let zoneCheckInterval = null;

// Настройки условий завершения матча (задаются Админом в лобби)
let settings = {
    timeLimit: { enabled: true, minutes: 20 },
    poLimit: { enabled: false, po: 100 },
    royale: { enabled: false }
};

const SHOP_DB = {
    'mul2': { cost: 8, type: 'passive', level: 'side', val: 2 },
    'mul3': { cost: 18, type: 'passive', level: 'side', val: 3 },
    'mul4': { cost: 30, type: 'passive', level: 'main', val: 4 },
    'mul5': { cost: 50, type: 'passive', level: 'main', val: 5 },
    'scan': { cost: 5, type: 'consumable', level: 'side' },
    'dash': { cost: 6, type: 'consumable', level: 'side' },
    'smoke': { cost: 8, type: 'consumable', level: 'side' },
    'magnet': { cost: 15, type: 'consumable', level: 'main' },
    'jammer': { cost: 20, type: 'consumable', level: 'main' },
    'trap': { cost: 13, type: 'consumable', level: 'main' },
    'trio': { cost: 30, type: 'passive', level: 'main' }
};

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
    const dp = (lat2 - lat1) * Math.PI / 180, dl = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function generateCheckpoints() {
    checkpoints = [{ id: 'cp_main', lat: gameCenter.lat, lng: gameCenter.lng, type: 'main' }];
    const minR = 185; const maxR = 375; const minDist = 150;
    for (let i = 0; i < 4; i++) {
        let valid = false, lat, lng, attempts = 0;
        while (!valid && attempts < 1000) {
            attempts++;
            const r = Math.sqrt(Math.random() * (maxR * maxR - minR * minR) + minR * minR);
            const theta = Math.random() * 2 * Math.PI;
            lat = gameCenter.lat + (r / 111300) * Math.cos(theta);
            lng = gameCenter.lng + (r / (111300 * Math.cos(gameCenter.lat * Math.PI / 180))) * Math.sin(theta);
            valid = true;
            for (let j = 1; j < checkpoints.length; j++) {
                if (getDistance(lat, lng, checkpoints[j].lat, checkpoints[j].lng) < minDist) { valid = false; break; }
            }
        }
        if (valid) checkpoints.push({ id: `cp_side_${i}`, lat, lng, type: 'side' });
    }
}

function spawnBubble(ownerPlayer = null) {
    if (gameState !== 'playing') return;
    const r = (375 / 111300) * Math.sqrt(Math.random());
    const theta = Math.random() * 2 * Math.PI;
    const lat = gameCenter.lat + r * Math.cos(theta);
    const lng = gameCenter.lng + r * Math.sin(theta) / Math.cos(gameCenter.lat * Math.PI / 180);
    const playerKeys = Object.keys(players);
    if (playerKeys.length === 0) return;

    const randomPlayer = ownerPlayer || players[playerKeys[Math.floor(Math.random() * playerKeys.length)]];
    const id = bubbleIdCounter++;

    let bColor = randomPlayer.color;
    if (randomPlayer.teamId && teams[randomPlayer.teamId]) {
        bColor = teams[randomPlayer.teamId].leaderColor;
    }

    bubbles[id] = { id, lat, lng, color: bColor, ownerId: randomPlayer.id, type: 'normal' };
    io.emit('newBubble', bubbles[id]);
}

// ==================== ЗАВЕРШЕНИЕ / СБРОС ИГРЫ ====================

function stopEntireGame(reason) {
    gameState = 'lobby';
    if (matchTimerInterval) clearInterval(matchTimerInterval);
    if (bubbleSpawnInterval) clearInterval(bubbleSpawnInterval);
    if (finaleCountdownTimeout) clearTimeout(finaleCountdownTimeout);
    if (zoneCheckInterval) clearInterval(zoneCheckInterval);
    matchTimerInterval = null;
    bubbleSpawnInterval = null;
    finaleCountdownTimeout = null;
    zoneCheckInterval = null;
    matchEndTime = 0;

    bubbles = {};
    checkpoints = [];
    teams = {};
    teamIdCounter = 0;
    players = {};
    adminId = null;
    settings = {
        timeLimit: { enabled: true, minutes: 20 },
        poLimit: { enabled: false, po: 100 },
        royale: { enabled: false }
    };

    io.emit('gameReset', { reason });
}

// ==================== ПРОВЕРКА УСЛОВИЙ ПОБЕДЫ ====================

function checkWinConditions() {
    if (gameState !== 'playing') return;

    // Графа 1: лимит времени
    if (settings.timeLimit.enabled && Date.now() >= matchEndTime) {
        triggerFinale('ВРЕМЯ ВЫШЛО!', 'Срочно вернитесь на Главный чекпоинт для подведения итогов!');
        return;
    }

    // Графа 2: лимит победных очков (с учетом альянсов)
    if (settings.poLimit.enabled) {
        let maxPo = 0;
        for (let id in players) {
            let po = players[id].po;
            if (players[id].teamId && teams[players[id].teamId]) po = teams[players[id].teamId].totalPO;
            if (po > maxPo) maxPo = po;
        }
        if (maxPo >= settings.poLimit.po) {
            triggerFinale('ЦЕЛЬ ДОСТИГНУТА!', 'Лимит победных очков набран! Срочно вернитесь на Главный чекпоинт для подведения итогов!');
            return;
        }
    }

    // Графа 3: королевская битва / выживание
    if (settings.royale.enabled) {
        const totalCount = Object.keys(players).length;
        const aliveCount = Object.values(players).filter(p => !p.isDead).length;
        if (totalCount > 1 && aliveCount <= 1) {
            triggerFinale('ПОСЛЕДНИЙ ВЫЖИВШИЙ!', 'В живых остался только один боец! Срочно вернитесь на Главный чекпоинт для подведения итогов!');
            return;
        }
    }
}

// ==================== ИГРОВАЯ ЗОНА ====================

function checkZoneExpirations() {
    if (gameState !== 'playing') return;
    const now = Date.now();
    for (let id in players) {
        const p = players[id];
        if (p.isDead) continue;

        const staleMs = p.lastLocationAt ? now - p.lastLocationAt : Infinity;
        if (staleMs > 30000 && p.lat != null && p.lng != null) {
            const dist = getDistance(p.lat, p.lng, gameCenter.lat, gameCenter.lng);
            if (dist > ZONE_RADIUS) {
                killByZone(p);
                continue;
            }
        }

        if (!p.zoneWarningActive) continue;
        if (now < p.zoneWarningEnd) continue;

        if (p.lat != null && p.lng != null) {
            const dist = getDistance(p.lat, p.lng, gameCenter.lat, gameCenter.lng);
            if (dist > ZONE_RADIUS) {
                killByZone(p);
            } else {
                p.zoneWarningActive = false; p.zoneWarningEnd = 0;
                io.to(p.id).emit('zoneWarningClear');
            }
        } else {
            killByZone(p);
        }
    }
}

function killByZone(p) {
    p.isDead = true;
    p.zoneWarningActive = false;
    p.zoneWarningEnd = 0;
    p.shieldEnd = 0; p.killModeEnd = 0;
    if (p.activeEffects) p.activeEffects.dash = 0;

    // Игрок теряет половину своих сырых очков (с учетом альянса)
    if (p.teamId && teams[p.teamId]) {
        const t = teams[p.teamId];
        const lost = Math.floor(t.totalPO / 2);
        t.totalPO -= lost;
        io.emit('teamUpdated', teams);
    } else {
        const lost = Math.floor(p.po / 2);
        p.po -= lost;
    }

    io.to(p.id).emit('zoneDeath');
    io.emit('playerStateChanged', p);
    checkWinConditions();
}

function triggerFinale(title, message) {
    if (gameState !== 'playing') return;
    gameState = 'finale_call';
    if (matchTimerInterval) clearInterval(matchTimerInterval);
    matchTimerInterval = null;

    io.emit('finaleStageOne', { title, message });

    // На случай если все игроки уже физически стоят на базе в момент срабатывания условия
    checkAllAtMainCheckpoint();
}

function checkAllAtMainCheckpoint() {
    if (gameState !== 'finale_call') return;
    const allIds = Object.keys(players);
    if (allIds.length === 0) return;

    const allThere = allIds.every(id => players[id].currentCheckpointId === 'cp_main');
    if (!allThere) return;

    gameState = 'finale_countdown';
    io.emit('finaleCountdownStart', { seconds: 10 });

    finaleCountdownTimeout = setTimeout(() => {
        showFinaleLeaderboard();
    }, 10000);
}

function showFinaleLeaderboard() {
    gameState = 'finale_leaderboard';

    const entries = [];
    const countedTeams = new Set();

    for (let id in players) {
        const p = players[id];
        if (p.teamId && teams[p.teamId]) {
            if (countedTeams.has(p.teamId)) continue;
            countedTeams.add(p.teamId);
            const t = teams[p.teamId];
            entries.push({
                type: 'team',
                teamId: p.teamId,
                color: t.leaderColor,
                po: t.totalPO,
                memberIds: t.members.filter(m => players[m]),
                members: t.members.filter(m => players[m]).map(m => ({ name: players[m].name, photo: players[m].photo }))
            });
        } else {
            entries.push({ type: 'solo', id: p.id, name: p.name, color: p.color, photo: p.photo, po: p.po });
        }
    }

    entries.sort((a, b) => b.po - a.po);

    // ==================== НАЧИСЛЕНИЕ РЕЙТИНГА (РО) ====================
    // ΔR = (P - C) + (K · M)
    // C (стоимость входа) уже списана в startGame — здесь начисляем P и K·M.
    const totalEntries = entries.length;
    const ratingResults = [];

    entries.forEach((entry, index) => {
        const P = totalEntries > 0 ? placementPoints(index, totalEntries) : 0;
        const memberIds = entry.type === 'team' ? entry.memberIds : [entry.id];
        // Победа/место союза делится между участниками — соло-победа выгоднее рейтингово.
        const perMemberP = entry.type === 'team' ? Math.floor(P / memberIds.length) : P;
        const isTopThird = (index + 1) / totalEntries <= 0.3;

        memberIds.forEach((pid) => {
            const p = players[pid];
            if (!p || !p.accountUsername) return;
            const acc = accounts[p.accountUsername.toLowerCase()];
            if (!acc) return;

            const div = getDivision(acc.rating);
            const kills = p.kills || 0;
            const killBonus = Math.round(kills * KILL_BONUS_BASE * div.killMult);
            let delta = perMemberP + killBonus;

            // Бонус за агрессивную игру: разорвал союз и всё равно попал в топ-30%.
            if (p.brokeAllianceThisMatch && isTopThird) {
                delta += ALLIANCE_BREAK_BONUS;
            }

            // Бронза защищена от потери РО по итогам матча (штраф за место не применяется).
            if (div.id === 'bronze' && delta < 0) delta = 0;

            acc.rating = Math.max(0, acc.rating + delta);
            if (index === 0) acc.wins = (acc.wins || 0) + 1;

            const newDiv = getDivision(acc.rating);
            ratingResults.push({
                playerId: pid, username: acc.username, place: index + 1,
                delta, newRating: acc.rating, divisionId: newDiv.id, divisionName: newDiv.name
            });
        });
    });

    if (ratingResults.length > 0) saveAccounts();

    // ===== Пересчёт трона чемпиона после обновления всех рейтингов =====
    const champResult = recomputeChampion();
    if (champResult.changed) saveAccounts();
    ratingResults.forEach((r) => { r.isChampion = isChampionAccount(r.username); });

    io.emit('finaleLeaderboard', {
        entries, ratingResults,
        championChange: champResult.changed ? champResult : null
    });
}

function sendPlayerState(socket, player) {
    socket.emit('playerSession', { reconnectToken: player.reconnectToken });
    socket.emit('updateLobby', Object.values(players));
    socket.emit('lobbyState', { isAdmin: player.id === adminId, gameState });

    if (gameState === 'playing') {
        socket.emit('gameStarted', { players, bubbles, checkpoints, teams, matchEndTime, settings });
    }
}

function rebindPlayer(socket, player) {
    const oldId = player.id;
    if (oldId !== socket.id) {
        delete players[oldId];
        player.id = socket.id;
        players[socket.id] = player;

        for (const team of Object.values(teams)) {
            team.members = team.members.map(id => id === oldId ? socket.id : id);
        }
        for (const bubble of Object.values(bubbles)) {
            if (bubble.ownerId === oldId) bubble.ownerId = socket.id;
        }
        if (adminId === oldId) adminId = socket.id;
        io.emit('playerDisconnected', oldId);
        // Сообщаем всем клиентам о переподключившемся игроке под новым id и его последней позиции,
        // иначе его маркер на карте у остальных пропадёт до следующего обновления геолокации
        io.emit('playerStateChanged', player);
    }
    player.connected = true;
    socket.data.playerId = socket.id;
    sendPlayerState(socket, player);
    io.emit('updateLobby', Object.values(players));
}

// ==================== SOCKET HANDLERS ====================

io.on('connection', (socket) => {

    // ==================== АККАУНТЫ И ЛИГА ====================
    socket.on('register', (data) => {
        const username = ((data && data.username) || '').trim();
        const password = ((data && data.password) || '').trim();
        const key = username.toLowerCase();

        if (username.length < 3 || username.length > 16) {
            socket.emit('authResult', { ok: false, mode: 'register', error: 'Ник должен быть от 3 до 16 символов' });
            return;
        }
        if (password.length < 4) {
            socket.emit('authResult', { ok: false, mode: 'register', error: 'Пароль должен быть от 4 символов' });
            return;
        }
        if (accounts[key]) {
            socket.emit('authResult', { ok: false, mode: 'register', error: 'Такой ник уже занят' });
            return;
        }

        const salt = crypto.randomBytes(8).toString('hex');
        accounts[key] = {
            username, salt, passwordHash: hashPassword(password, salt),
            rating: 0, matchesPlayed: 0, wins: 0, createdAt: Date.now()
        };
        saveAccounts();

        const token = crypto.randomUUID();
        sessionTokens[token] = key;
        const div = getDivision(0);
        socket.emit('authResult', { ok: true, token, username, rating: 0, divisionId: div.id, divisionName: div.name, isChampion: isChampionAccount(username) });
    });

    socket.on('login', (data) => {
        const username = ((data && data.username) || '').trim();
        const password = ((data && data.password) || '').trim();
        const key = username.toLowerCase();
        const acc = accounts[key];

        if (!acc || hashPassword(password, acc.salt) !== acc.passwordHash) {
            socket.emit('authResult', { ok: false, mode: 'login', error: 'Неверный ник или пароль' });
            return;
        }

        const token = crypto.randomUUID();
        sessionTokens[token] = key;
        const div = getDivision(acc.rating);
        socket.emit('authResult', { ok: true, token, username: acc.username, rating: acc.rating, divisionId: div.id, divisionName: div.name, isChampion: isChampionAccount(acc.username) });
    });

    socket.on('sessionLogin', (token) => {
        const key = sessionTokens[token];
        const acc = key && accounts[key];
        if (!acc) { socket.emit('authResult', { ok: false, mode: 'session' }); return; }
        const div = getDivision(acc.rating);
        socket.emit('authResult', { ok: true, token, username: acc.username, rating: acc.rating, divisionId: div.id, divisionName: div.name, isChampion: isChampionAccount(acc.username) });
    });

    socket.on('getLeaderboard', () => {
        const list = Object.values(accounts)
            .sort((a, b) => b.rating - a.rating)
            .slice(0, 50)
            .map((a, i) => ({
                rank: i + 1, username: a.username, rating: a.rating,
                divisionId: getDivision(a.rating).id, divisionName: getDivision(a.rating).name,
                matchesPlayed: a.matchesPlayed || 0, wins: a.wins || 0,
                isChampion: isChampionAccount(a.username)
            }));
        const champAcc = championUsername ? accounts[championUsername.toLowerCase()] : null;
        socket.emit('leaderboardData', {
            list,
            champion: champAcc ? { username: champAcc.username, rating: champAcc.rating, title: CHAMPION_TITLE } : null
        });
    });

    socket.on('joinLobby', (playerData) => {
        const reconnectToken = playerData && playerData.reconnectToken;
        const existingPlayer = Object.values(players).find(p => p.reconnectToken === reconnectToken);
        if (existingPlayer) {
            rebindPlayer(socket, existingPlayer);
            return;
        }

        if (!adminId) adminId = socket.id;
        players[socket.id] = {
            id: socket.id, isAdmin: socket.id === adminId, isDead: false,
            shieldEnd: 0, killModeEnd: 0, killCooldown: 0, inCheckpoint: false, currentCheckpointId: null,
            coins: 0, po: 0, multiplier: 1, inventory: {}, activeEffects: {},
            teamId: null, pendingInvite: null, teamCooldown: 0, canTrio: false,
            zoneWarningActive: false, zoneWarningEnd: 0, lastLocationAt: 0,
            kills: 0, brokeAllianceThisMatch: false, accountUsername: null,
            ...playerData,
            reconnectToken: crypto.randomUUID(), connected: true
        };
        socket.data.playerId = socket.id;
        socket.emit('playerSession', { reconnectToken: players[socket.id].reconnectToken });
        io.emit('updateLobby', Object.values(players));
        socket.emit('lobbyState', { isAdmin: socket.id === adminId, gameState });
    });

    socket.on('resumePlayer', (reconnectToken) => {
        const player = Object.values(players).find(p => p.reconnectToken === reconnectToken);
        if (player) rebindPlayer(socket, player);
    });

    socket.on('startGame', (data) => {
        if (socket.id === adminId && gameState === 'lobby') {
            gameState = 'playing';

            settings = {
                timeLimit: {
                    enabled: !!(data && data.timeLimit && data.timeLimit.enabled),
                    minutes: (data && data.timeLimit && parseInt(data.timeLimit.minutes)) || 20
                },
                poLimit: {
                    enabled: !!(data && data.poLimit && data.poLimit.enabled),
                    po: (data && data.poLimit && parseInt(data.poLimit.po)) || 100
                },
                royale: {
                    enabled: !!(data && data.royale && data.royale.enabled)
                }
            };

            // Если админ ничего не выбрал — подстраховка: включаем лимит времени по умолчанию
            if (!settings.timeLimit.enabled && !settings.poLimit.enabled && !settings.royale.enabled) {
                settings.timeLimit.enabled = true;
                settings.timeLimit.minutes = 20;
            }

            const now = Date.now();
            matchEndTime = settings.timeLimit.enabled ? now + (settings.timeLimit.minutes * 60 * 1000) : 0;

            for (let id in players) players[id].shieldEnd = now + 300000;

            // ===== Плата за вход в матч (списывается сразу для Серебра и выше) =====
            for (let id in players) {
                const p = players[id];
                p.kills = 0; p.brokeAllianceThisMatch = false;
                if (p.accountUsername) {
                    const acc = accounts[p.accountUsername.toLowerCase()];
                    if (acc) {
                        const div = getDivision(acc.rating);
                        if (div.entryCost > 0) {
                            acc.rating = Math.max(0, acc.rating - div.entryCost);
                        }
                        acc.matchesPlayed = (acc.matchesPlayed || 0) + 1;
                    }
                }
            }
            saveAccounts();

            generateCheckpoints();
            for (let i = 0; i < 50; i++) spawnBubble();

            io.emit('gameStarted', { players, bubbles, checkpoints, teams, matchEndTime, settings });

            if (matchTimerInterval) clearInterval(matchTimerInterval);
            matchTimerInterval = setInterval(() => { checkWinConditions(); }, 1000);

            if (bubbleSpawnInterval) clearInterval(bubbleSpawnInterval);
            bubbleSpawnInterval = setInterval(() => {
                const count = Math.floor(Math.random() * 8) + 8;
                for (let i = 0; i < count; i++) spawnBubble();
            }, 10 * 60 * 1000);

            if (zoneCheckInterval) clearInterval(zoneCheckInterval);
            zoneCheckInterval = setInterval(() => { checkZoneExpirations(); }, 1000);
        }
    });

    socket.on('adminStopGame', () => {
        if (socket.id === adminId) {
            stopEntireGame('Игра остановлена администратором.');
        }
    });

    socket.on('finaleAcknowledge', () => {
        if (gameState === 'finale_leaderboard') {
            stopEntireGame('Матч завершен! Спасибо за игру.');
        }
    });

    socket.on('updateLocation', (coords) => {
        const p = players[socket.id];
        if (p) {
            p.lat = coords.lat; p.lng = coords.lng;
            p.lastLocationAt = Date.now();
            socket.broadcast.emit('playerMoved', { id: socket.id, coords });

            if (gameState === 'playing' && !p.isDead) {
                const dist = getDistance(coords.lat, coords.lng, gameCenter.lat, gameCenter.lng);
                const outOfZone = dist > ZONE_RADIUS;

                if (outOfZone && !p.zoneWarningActive) {
                    p.zoneWarningActive = true;
                    p.zoneWarningEnd = Date.now() + ZONE_GRACE_MS;
                    io.to(p.id).emit('zoneWarningStart', { seconds: ZONE_GRACE_MS / 1000 });
                } else if (!outOfZone && p.zoneWarningActive) {
                    p.zoneWarningActive = false;
                    p.zoneWarningEnd = 0;
                    io.to(p.id).emit('zoneWarningClear');
                }
            }
        }
    });

    socket.on('collectBubble', (bId) => {
        const p = players[socket.id];
        const b = bubbles[bId];
        if (b && p && !p.isDead) {
            delete bubbles[bId];
            io.emit('bubbleCollected', bId);

            let isFriendly = b.ownerId === p.id;
            if (p.teamId && teams[p.teamId] && teams[p.teamId].members.includes(b.ownerId)) isFriendly = true;

            if (b.type === 'trap') {
                if (!isFriendly) p.coins = Math.max(0, p.coins - 5);
            } else if (isFriendly) {
                p.coins += (1 * p.multiplier);
                setTimeout(spawnBubble, 3000);
            } else {
                setTimeout(spawnBubble, 3000);
            }
            io.emit('playerStateChanged', p);
        }
    });

    // ТИМИНГ
    socket.on('invitePlayer', (targetId) => {
        const p = players[socket.id]; const target = players[targetId]; const now = Date.now();
        if (!p || !target || p.isDead || target.isDead) return;
        if (now < p.shieldEnd || now < target.shieldEnd || now < p.teamCooldown || now < target.teamCooldown) return;
        if (target.pendingInvite || p.pendingInvite) return;

        let maxMembers = p.canTrio ? 3 : 2;
        if (p.teamId && teams[p.teamId] && teams[p.teamId].members.length >= maxMembers) return;
        if (target.teamId) return;

        target.pendingInvite = { from: p.id, fromName: p.name };
        io.emit('playerStateChanged', target);
    });

    socket.on('acceptInvite', () => {
        const p = players[socket.id];
        if (!p || !p.pendingInvite || !p.inCheckpoint || p.isDead) return;
        const leader = players[p.pendingInvite.from];
        if (!leader || leader.isDead) { p.pendingInvite = null; io.emit('playerStateChanged', p); return; }

        if (!leader.teamId) {
            leader.teamId = `team_${teamIdCounter++}`;
            teams[leader.teamId] = { members: [leader.id], totalPO: leader.po, leaderColor: leader.color };
            leader.po = 0;
        }

        p.teamId = leader.teamId;
        teams[leader.teamId].members.push(p.id);
        teams[leader.teamId].totalPO += p.po;
        p.po = 0; p.pendingInvite = null;

        io.emit('teamUpdated', teams);
        io.emit('playerStateChanged', leader); io.emit('playerStateChanged', p);
        checkWinConditions();
    });

    socket.on('declineInvite', () => {
        const p = players[socket.id];
        if (p && p.pendingInvite && p.inCheckpoint) { p.pendingInvite = null; io.emit('playerStateChanged', p); }
    });

    socket.on('leaveTeam', () => {
        const p = players[socket.id];
        if (!p || !p.teamId || !p.inCheckpoint || p.coins < 5) return;
        const t = teams[p.teamId]; if (!t) return;

        p.coins -= 5; p.brokeAllianceThisMatch = true; const now = Date.now();
        const splitAmount = Math.floor(t.totalPO / t.members.length);
        const remainder = t.totalPO % t.members.length;

        t.members.forEach(mId => {
            if (players[mId]) {
                players[mId].po = splitAmount + (mId === p.id ? remainder : 0);
                players[mId].teamId = null;
                players[mId].teamCooldown = now + 300000;
                io.emit('playerStateChanged', players[mId]);
            }
        });
        delete teams[p.teamId];
        io.emit('teamUpdated', teams);
    });

    socket.on('buyItem', (itemId) => {
        const p = players[socket.id];
        if (!p || !p.inCheckpoint) return;

        if (itemId === 'convert') {
            if (p.coins >= 3) {
                p.coins -= 3;
                if (p.teamId && teams[p.teamId]) { teams[p.teamId].totalPO += 1; io.emit('teamUpdated', teams); }
                else { p.po += 1; }
                io.emit('playerStateChanged', p);
                checkWinConditions();
            }
            return;
        }
        const item = SHOP_DB[itemId];
        if (item && p.coins >= item.cost) {
            p.coins -= item.cost;
            if (itemId === 'trio') p.canTrio = true;
            else if (item.type === 'passive') p.multiplier = item.val;
            else p.inventory[itemId] = (p.inventory[itemId] || 0) + 1;
            io.emit('playerStateChanged', p);
        }
    });

    socket.on('useItem', (itemId) => {
        const p = players[socket.id]; const now = Date.now();
        if (p && p.inventory[itemId] > 0 && !p.isDead) {
            p.inventory[itemId] -= 1;
            if (itemId === 'scan') p.activeEffects.scan = now + 30000;
            if (itemId === 'dash') p.activeEffects.dash = now + 20000;
            if (itemId === 'smoke') p.activeEffects.smoke = now + 35000;
            if (itemId === 'magnet') p.activeEffects.magnet = now + 45000;
            if (itemId === 'jammer') {
                for (let pid in players) {
                    if (pid !== p.id) { players[pid].activeEffects.jammed = now + 30000; io.emit('playerStateChanged', players[pid]); }
                }
            }
            if (itemId === 'trap') {
                const id = bubbleIdCounter++;
                bubbles[id] = { id, lat: p.lat, lng: p.lng, color: p.color, ownerId: p.id, type: 'trap' };
                io.emit('newBubble', bubbles[id]);
            }
            io.emit('playerStateChanged', p);
        }
    });

    socket.on('enterCheckpoint', (cpId) => {
        const p = players[socket.id];
        if (p) {
            p.inCheckpoint = true;
            p.currentCheckpointId = cpId || 'cp_main';
            if (p.isDead) p.isDead = false;
            io.emit('playerStateChanged', p);

            if (gameState === 'finale_call') checkAllAtMainCheckpoint();
        }
    });

    socket.on('leaveCheckpoint', () => {
        const p = players[socket.id];
        if (p) {
            p.inCheckpoint = false;
            p.currentCheckpointId = null;
            io.emit('playerStateChanged', p);
        }
    });

    socket.on('activateKillMode', () => {
        const p = players[socket.id]; const now = Date.now();
        if (p && !p.isDead && !p.inCheckpoint && now > p.killCooldown && now > p.shieldEnd) {
            p.killModeEnd = now + 60000; p.killCooldown = now + 240000; p.activeEffects.dash = 0; io.emit('playerStateChanged', p);
        }
    });

    socket.on('tryKill', (targetId) => {
        const killer = players[socket.id]; const target = players[targetId]; const now = Date.now();
        if (!killer || !target || killer.isDead || target.isDead) return;
        if (killer.inCheckpoint || target.inCheckpoint) return;
        if (killer.teamId && killer.teamId === target.teamId) return;

        const targetHasShield = (now < target.shieldEnd) || (now < target.activeEffects.dash);
        if (now > killer.killModeEnd || targetHasShield || now < target.killModeEnd) return;

        target.isDead = true; target.shieldEnd = 0; target.killModeEnd = 0; target.activeEffects.dash = 0;
        const stolen = Math.floor(target.coins / 2);
        target.coins -= stolen; killer.coins += stolen;
        killer.kills = (killer.kills || 0) + 1;

        io.emit('playerStateChanged', target); io.emit('playerStateChanged', killer);
        checkWinConditions();
    });

    socket.on('disconnect', () => {
        const p = players[socket.id];
        if (p) p.connected = false;
    });
});

const PORT = 3000;
http.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`));
