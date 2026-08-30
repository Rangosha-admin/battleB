// Разрешаем polling как запасной транспорт: часть мобильных сетей/операторов
// блокирует прямой апгрейд до WebSocket, и раньше (только 'websocket', upgrade:false)
// в таких сетях игрок вообще не мог подключиться — карта других игроков не обновлялась.
// Теперь клиент стартует с polling и сам апгрейдится до WebSocket, когда это возможно.
const socket = io({
    transports: ['polling', 'websocket'],
    upgrade: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
});
const reconnectTokenKey = 'bubblBattleReconnectToken';
let reconnectToken = localStorage.getItem(reconnectTokenKey);
const gameCenter = [41.3138361, 69.2903755];
let map, myMarker;
const otherPlayers = {};
const gameBubbles = {};
let gameCheckpoints = [];
let myCurrentCheckpoint = null;
let matchEndTime = 0;

let myData = { activeEffects: {} };
let gamePlayers = {};
let gameTeams = {};
let teamPolylines = [];
let lastLocationEmitTime = 0;
const LOCATION_EMIT_INTERVAL_MS = 1200;

// Web Audio API генератор звуков
const AudioFX = {
    ctx: null,
    init() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); },
    playTone(freq, type, duration, delay = 0, gainVal = 0.2) {
        try {
            this.init();
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = type; osc.frequency.value = freq;
            osc.connect(gain); gain.connect(this.ctx.destination);
            const startTime = this.ctx.currentTime + delay;
            gain.gain.setValueAtTime(gainVal, startTime);
            osc.start(startTime); gain.gain.exponentialRampToValueAtTime(0.00001, startTime + duration);
            osc.stop(startTime + duration);
        } catch (e) { }
    },
    click() { this.playTone(600, 'sine', 0.05); },
    collect() { this.playTone(880, 'triangle', 0.12); },
    buy() { this.playTone(523.25, 'square', 0.15); },
    attack() { this.playTone(150, 'sawtooth', 0.3); },
    stop() { this.playTone(110, 'square', 0.6); },
    reveal() { this.playTone(660, 'triangle', 0.18); },
    tick() { this.playTone(440, 'square', 0.08); },
    victory() {
        this.init();
        const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
        notes.forEach((f, i) => this.playTone(f, 'triangle', 0.5, i * 0.15, 0.22));
    }
};

const SHOP_ITEMS = {
    'mul2': { name: 'Множитель x2', cost: 8, level: 'side', desc: 'Удваивает добычу' },
    'mul3': { name: 'Множитель x3', cost: 18, level: 'side', desc: 'Утраивает добычу' },
    'mul4': { name: 'Множитель x4', cost: 30, level: 'main', desc: 'Добыча x4' },
    'mul5': { name: 'Множитель x5', cost: 50, level: 'main', desc: 'Макс. добыча' },
    'scan': { name: 'Сканер пузырей', cost: 5, level: 'side', desc: 'Подсвечивает вражеские пузыри' },
    'dash': { name: 'Экстренный рывок', cost: 6, level: 'side', desc: 'Щит на 20 сек' },
    'smoke': { name: 'Маскировочный дым', cost: 8, level: 'side', desc: 'Невидимость на 35 сек' },
    'magnet': { name: 'Магнит добычи', cost: 15, level: 'main', desc: 'Радиус сбора 25м' },
    'jammer': { name: 'Глушилка радаров', cost: 20, level: 'main', desc: 'Скрывает карту врагам' },
    'trap': { name: 'Ловушка-пузырь', cost: 13, level: 'main', desc: 'Мина-обманка' },
    'trio': { name: 'Право на Трио', cost: 30, level: 'main', desc: 'Команда до 3 чел' }
};

const palette = ['#ff3b6b', '#1e88e5', '#2ecc71', '#f5c400', '#8e44ad', '#00bcd4', '#ff7f50', '#7cb342', '#ff5e5b', '#12b886'];

// ==================== ДИАГНОСТИКА ГЕОЛОКАЦИИ ====================
// Главная причина, по которой другие игроки "не появляются на карте" в реальных условиях —
// браузер блокирует Geolocation API вне защищённого контекста (HTTPS или localhost).
// Показываем явное предупреждение, чтобы это не выглядело как загадочный баг.

function showGeoWarning(message) {
    const banner = document.getElementById('geo-warning-banner');
    banner.innerText = message;
    banner.classList.add('show');
}

function hideGeoWarning() {
    document.getElementById('geo-warning-banner').classList.remove('show');
}

function handleGeoError(err) {
    console.error('Ошибка геолокации:', err);
    if (err.code === 1) {
        showGeoWarning('📍 Доступ к геопозиции запрещён. Разрешите доступ к местоположению в настройках браузера — иначе вы не будете видны другим игрокам.');
    } else if (err.code === 2) {
        showGeoWarning('📍 Не удаётся определить местоположение (нет сигнала GPS). Выйдите на открытое пространство.');
    } else if (err.code === 3) {
        showGeoWarning('📍 Превышено время ожидания GPS-сигнала. Проверьте, включена ли геолокация на устройстве.');
    }
}

function checkGeoSupport() {
    if (!window.isSecureContext) {
        showGeoWarning('⚠️ Сайт открыт не по HTTPS — браузер блокирует геолокацию. Откройте адрес через https:// (или ngrok/localtunnel), иначе игроки не будут видеть друг друга на карте.');
        return false;
    }
    if (!('geolocation' in navigator)) {
        showGeoWarning('⚠️ Этот браузер не поддерживает геолокацию.');
        return false;
    }
    return true;
}
checkGeoSupport();

let selectedColor = palette[0];
const colorPicker = document.getElementById('color-picker');
palette.forEach(color => {
    const btn = document.createElement('div'); btn.className = 'color-btn'; btn.style.backgroundColor = color;
    if (color === selectedColor) btn.classList.add('active');
    btn.onclick = () => {
        AudioFX.click();
        document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active'); selectedColor = color;
    };
    colorPicker.appendChild(btn);
});

function joinLobby() {
    AudioFX.click();
    const name = document.getElementById('username').value;
    const photoInput = document.getElementById('userphoto').files[0];
    if (!name) return alert("Введите имя!");
    myData = {
        name, color: selectedColor, photo: "", activeEffects: {}, reconnectToken,
        accountUsername: myAccount ? myAccount.username : null
    };
    if (photoInput) {
        const reader = new FileReader(); reader.onload = (e) => { myData.photo = e.target.result; socket.emit('joinLobby', myData); }; reader.readAsDataURL(photoInput);
    } else socket.emit('joinLobby', myData);
    document.getElementById('login-screen').style.display = 'none'; document.getElementById('lobby-screen').style.display = 'flex';
}

socket.on('connect', () => {
    hideConnectionWarning();
    if (reconnectToken) socket.emit('resumePlayer', reconnectToken);
});

// ==================== АККАУНТ / ЛИГА (стартовый экран) ====================

let myAccount = null; // { username, rating, divisionId, divisionName }
let authMode = 'login'; // 'login' | 'register'

function showOnlyScreen(id) {
    ['start-screen', 'auth-screen', 'league-screen', 'login-screen'].forEach((sid) => {
        const el = document.getElementById(sid);
        if (el) el.style.display = (sid === id) ? 'flex' : 'none';
    });
}

function backToStart() {
    AudioFX.click();
    showOnlyScreen('start-screen');
}

function renderAccountPill() {
    const pill = document.getElementById('start-account-pill');
    if (!pill) return;
    if (myAccount) {
        pill.style.display = 'block';
        const crown = myAccount.isChampion ? '👑 ' : '';
        pill.innerText = `${crown}${myAccount.username} · ${myAccount.isChampion ? CHAMPION_TITLE + ' · ' : ''}${myAccount.divisionName} · ${myAccount.rating} РО`;
        pill.classList.toggle('is-champion', !!myAccount.isChampion);
    } else {
        pill.style.display = 'none';
    }
}

const CHAMPION_TITLE = 'Чемпион';

// При первой загрузке пробуем автовойти по сохранённому токену ("запомнить меня").
(function tryAutoLogin() {
    const savedToken = localStorage.getItem('bb_session_token');
    if (savedToken) socket.emit('sessionLogin', savedToken);
})();

function onBubbleBattleClick() {
    AudioFX.click();
    if (myAccount) {
        // Уже вошли в аккаунт — сразу к настройке персонажа (имя предзаполнено).
        showOnlyScreen('login-screen');
        const input = document.getElementById('username');
        if (input) { input.value = myAccount.username; input.readOnly = true; }
    } else {
        authMode = 'login';
        updateAuthScreenTexts();
        document.getElementById('auth-error').classList.remove('show');
        showOnlyScreen('auth-screen');
    }
}

function toggleAuthMode() {
    authMode = (authMode === 'login') ? 'register' : 'login';
    updateAuthScreenTexts();
}

function updateAuthScreenTexts() {
    const isLogin = authMode === 'login';
    document.getElementById('auth-title').innerText = isLogin ? 'Вход в аккаунт' : 'Регистрация';
    document.querySelector('#auth-screen button[onclick="submitAuth()"]').innerText = isLogin ? 'Войти' : 'Создать аккаунт';
    document.getElementById('auth-toggle-link').parentElement.firstChild.textContent = isLogin ? 'Нет аккаунта? ' : 'Уже есть аккаунт? ';
    document.getElementById('auth-toggle-link').innerText = isLogin ? 'Зарегистрироваться' : 'Войти';
}

function submitAuth() {
    AudioFX.click();
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value.trim();
    const errEl = document.getElementById('auth-error');
    errEl.classList.remove('show');

    if (!username || !password) {
        errEl.innerText = 'Заполните ник и пароль';
        errEl.classList.add('show');
        return;
    }
    socket.emit(authMode, { username, password });
}

socket.on('authResult', (res) => {
    if (!res.ok) {
        if (res.mode === 'session') {
            // Токен истёк/недействителен — просто остаёмся неавторизованными.
            localStorage.removeItem('bb_session_token');
            return;
        }
        const errEl = document.getElementById('auth-error');
        errEl.innerText = res.error || 'Ошибка';
        errEl.classList.add('show');
        return;
    }

    myAccount = {
        username: res.username, rating: res.rating,
        divisionId: res.divisionId, divisionName: res.divisionName,
        isChampion: !!res.isChampion
    };
    if (res.token) localStorage.setItem('bb_session_token', res.token);
    renderAccountPill();

    if (res.mode !== 'session') {
        // После успешного входа/регистрации сразу переходим к настройке персонажа.
        showOnlyScreen('login-screen');
        const input = document.getElementById('username');
        if (input) { input.value = myAccount.username; input.readOnly = true; }
    }
});

// ==================== ЭКРАН ЛИГИ ====================

const DIVISION_ICONS = { bronze: '🥉', silver: '🥈', gold: '🥇', platinum: '💎', diamond: '👑' };

function openLeagueScreen() {
    AudioFX.click();
    showOnlyScreen('league-screen');
    document.getElementById('league-list').innerHTML = '<p style="text-align:center; opacity:0.6; font-size:13px;">Загрузка...</p>';
    socket.emit('getLeaderboard');
}

socket.on('leaderboardData', (data) => {
    const { list, champion } = data;
    const myStats = document.getElementById('league-my-stats');
    const throneEl = document.getElementById('league-throne');
    const listEl = document.getElementById('league-list');

    if (myAccount) {
        const crown = myAccount.isChampion ? '👑 ' : '';
        myStats.innerHTML = `${crown}Твой рейтинг: <b>${myAccount.rating} РО</b> · <span class="division-badge division-${myAccount.divisionId}">${DIVISION_ICONS[myAccount.divisionId] || ''} ${myAccount.divisionName}</span>`;
    } else {
        myStats.innerHTML = `Войдите в аккаунт, чтобы участвовать в рейтинге лиги.`;
    }

    if (champion) {
        throneEl.style.display = 'flex';
        throneEl.innerHTML = `
            <span class="league-throne-crown">👑</span>
            <div>
                <div class="league-throne-title">${CHAMPION_TITLE} сервера</div>
                <div class="league-throne-name">${escapeHtml(champion.username)} <span class="league-throne-rating">${champion.rating} РО</span></div>
            </div>
        `;
    } else {
        throneEl.style.display = 'flex';
        throneEl.innerHTML = `
            <span class="league-throne-crown" style="opacity:0.4;">👑</span>
            <div>
                <div class="league-throne-title">Трон ${CHAMPION_TITLE.toLowerCase()}а свободен</div>
                <div class="league-throne-name" style="opacity:0.7;">Станьте первым, кто дойдёт до Алмаза</div>
            </div>
        `;
    }

    if (!list.length) {
        listEl.innerHTML = '<p style="text-align:center; opacity:0.6; font-size:13px;">Пока никто не сыграл рейтинговый матч.</p>';
        return;
    }

    listEl.innerHTML = list.map((row) => `
        <div class="league-row ${myAccount && row.username === myAccount.username ? 'me' : ''}">
            <span class="league-rank">#${row.rank}</span>
            <span class="league-name">${row.isChampion ? '👑 ' : ''}${escapeHtml(row.username)}</span>
            <span class="division-badge division-${row.divisionId}">${DIVISION_ICONS[row.divisionId] || ''} ${row.divisionName}</span>
            <span class="league-rating">${row.rating}</span>
        </div>
    `).join('');
});

function escapeHtml(str) {
    const div = document.createElement('div');
    div.innerText = str;
    return div.innerHTML;
}

// ==================== СТАБИЛЬНОСТЬ СОЕДИНЕНИЯ ====================
// Без явной индикации разрыва связи игрок долго не понимал, почему его
// координаты "зависли" на карте у остальных — соединение обрывалось молча.

function showConnectionWarning(message) {
    const banner = document.getElementById('geo-warning-banner');
    banner.innerText = message;
    banner.classList.add('show');
}
function hideConnectionWarning() {
    const banner = document.getElementById('geo-warning-banner');
    if (banner.innerText.includes('связь') || banner.innerText.includes('Соединение')) {
        banner.classList.remove('show');
    }
}

socket.on('disconnect', () => {
    showConnectionWarning('🔌 Соединение с сервером потеряно — пытаемся восстановить связь...');
});

socket.io.on('reconnect_attempt', () => {
    showConnectionWarning('🔌 Восстанавливаем связь с сервером...');
});

socket.io.on('reconnect', () => {
    showConnectionWarning('✅ Связь восстановлена!');
    setTimeout(hideConnectionWarning, 2000);
    // На всякий случай форсируем свежий GPS-фикс сразу после восстановления связи,
    // чтобы остальные игроки не видели устаревшую позицию.
    if (window.isSecureContext && 'geolocation' in navigator) {
        navigator.geolocation.getCurrentPosition(
            (pos) => { if (typeof updatePosition === 'function' && myData.lat !== undefined) updatePosition(pos); },
            () => {},
            { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
        );
    }
});

// ==================== УСТАНОВКА ПРИЛОЖЕНИЯ (PWA) ====================

let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const btn = document.getElementById('install-app-btn');
    if (btn) btn.classList.add('show');
});

function installApp() {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then(() => {
        deferredInstallPrompt = null;
        document.getElementById('install-app-btn').classList.remove('show');
    });
}

window.addEventListener('appinstalled', () => {
    const btn = document.getElementById('install-app-btn');
    if (btn) btn.classList.remove('show');
});

// iOS Safari не поддерживает beforeinstallprompt — показываем инструкцию вручную.
(function showIosHintIfNeeded() {
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
    if (isIos && !isStandalone) {
        const hint = document.getElementById('ios-install-hint');
        if (hint) hint.classList.add('show');
    }
})();

socket.on('playerSession', (data) => {
    reconnectToken = data.reconnectToken;
    localStorage.setItem(reconnectTokenKey, reconnectToken);
});

socket.on('updateLobby', (playersList) => {
    const listDiv = document.getElementById('players-list'); listDiv.innerHTML = '';
    const currentIds = new Set(playersList.map(p => p.id));
    for (const id of Object.keys(gamePlayers)) {
        if (!currentIds.has(id)) delete gamePlayers[id];
    }
    playersList.forEach(p => {
        gamePlayers[p.id] = p;
        listDiv.innerHTML += `<div class="player-item"><div class="player-color-dot" style="background-color: ${p.color}"></div><span>${p.name} ${p.isAdmin ? '👑' : ''}</span></div>`;
    });

    // Самовосстановление: если матч уже идёт и для какого-то игрока уже известны координаты,
    // а маркера на карте почему-то нет (например, из-за пропущенного события при реконнекте) — создаём его.
    if (map && document.getElementById('map').style.display === 'block') {
        for (const id in gamePlayers) {
            const pl = gamePlayers[id];
            if (id !== socket.id && pl.lat != null && pl.lng != null) createOtherPlayerMarker(pl);
        }
        updateVisibility();
    }
});

socket.on('lobbyState', (data) => {
    if (data.gameState === 'lobby') {
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('lobby-screen').style.display = 'flex';
    }
    if (data.isAdmin) {
        document.getElementById('admin-settings').style.display = 'block';
        document.getElementById('wait-text').style.display = 'none';
        document.getElementById('admin-controls').style.display = 'block';
    } else {
        document.getElementById('admin-settings').style.display = 'none';
        document.getElementById('wait-text').style.display = 'block';
        document.getElementById('admin-controls').style.display = 'none';
    }
});

// ==================== НАСТРОЙКИ УСЛОВИЙ ЗАВЕРШЕНИЯ (АДМИН) ====================

const timeToggle = document.getElementById('cond-time-toggle');
const timeValue = document.getElementById('cond-time-value');
const timeDisplay = document.getElementById('cond-time-display');
const poToggle = document.getElementById('cond-po-toggle');
const poValue = document.getElementById('cond-po-value');
const poDisplay = document.getElementById('cond-po-display');

function formatMinutes(mins) {
    mins = parseInt(mins);
    if (mins < 60) return `${mins} мин.`;
    const h = Math.floor(mins / 60); const m = mins % 60;
    return m === 0 ? `${h} ч.` : `${h} ч. ${m} мин.`;
}

timeValue.addEventListener('input', () => { timeDisplay.innerText = formatMinutes(timeValue.value); });
poValue.addEventListener('input', () => { poDisplay.innerText = `${poValue.value} ПО`; });
timeDisplay.innerText = formatMinutes(timeValue.value);
poDisplay.innerText = `${poValue.value} ПО`;

function adminStartGame() {
    AudioFX.click();
    const timeEnabled = timeToggle.checked;
    const poEnabled = poToggle.checked;
    const royaleEnabled = document.getElementById('cond-royale-toggle').checked;

    if (!timeEnabled && !poEnabled && !royaleEnabled) {
        return alert("Выберите хотя бы одно условие завершения матча!");
    }

    socket.emit('startGame', {
        timeLimit: { enabled: timeEnabled, minutes: parseInt(timeValue.value) },
        poLimit: { enabled: poEnabled, po: parseInt(poValue.value) },
        royale: { enabled: royaleEnabled }
    });
}

function confirmStopGame() {
    AudioFX.click();
    if (confirm("Вы уверены, что хотите принудительно завершить игру?")) {
        if (confirm("Это действие сбросит прогресс всех игроков. Завершить?")) {
            socket.emit('adminStopGame');
            closeModals();
        }
    }
}

socket.on('gameStarted', (data) => {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('lobby-screen').style.display = 'none';
    document.getElementById('map').style.display = 'block';
    document.getElementById('ui-container').style.display = 'block';
    document.getElementById('btn-inventory').style.display = 'block';
    document.getElementById('btn-center-player').style.display = 'block';
    document.getElementById('stop-notice').style.display = 'none';

    matchEndTime = data.matchEndTime;
    document.getElementById('timer-row').style.display = matchEndTime > 0 ? 'block' : 'none';

    gamePlayers = data.players; myData = gamePlayers[socket.id]; gameTeams = data.teams || {};
    initMap();

    for (const id of Object.keys(otherPlayers)) {
        if (!gamePlayers[id] || id === socket.id) {
            map.removeLayer(otherPlayers[id]);
            delete otherPlayers[id];
        }
    }
    for (const id in gamePlayers) {
        const player = gamePlayers[id];
        if (id !== socket.id && player.lat != null && player.lng != null) createOtherPlayerMarker(player);
    }

    for (let id in data.bubbles) { gameBubbles[id] = data.bubbles[id]; }
    updateVisibility();

    gameCheckpoints = data.checkpoints;
    for (let cp of gameCheckpoints) spawnCheckpoint(cp);

    setInterval(updateUI, 1000);
});

socket.on('gameReset', (data) => {
    AudioFX.stop();
    document.getElementById('map').style.display = 'none';
    document.getElementById('ui-container').style.display = 'none';
    document.getElementById('btn-inventory').style.display = 'none';
    document.getElementById('btn-center-player').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('lobby-screen').style.display = 'none';
    document.getElementById('finale-call-overlay').classList.remove('show');
    document.getElementById('finale-leaderboard-overlay').classList.remove('show');
    hideZoneWarning();
    document.getElementById('zone-death-toast').classList.remove('show');

    document.getElementById('username').value = '';
    const notice = document.getElementById('stop-notice');
    notice.innerText = data.reason || "Матч завершен.";
    notice.style.display = 'block';

    if (map) { map.remove(); map = null; }
    myMarker = null;
    for (let id in otherPlayers) { delete otherPlayers[id]; }
    for (let id in gameBubbles) { delete gameBubbles[id]; }
    teamPolylines = [];
    closeModals();
});

// ==================== ФИНАЛ: ЭТАП 1 — ПРИЗЫВ НА БАЗУ ====================

socket.on('finaleStageOne', (data) => {
    AudioFX.stop();
    document.getElementById('finale-call-title').innerText = data.title;
    document.getElementById('finale-call-message').innerText = data.message;
    document.getElementById('finale-countdown-block').style.display = 'none';
    document.getElementById('finale-waiting-status').style.display = 'block';
    document.getElementById('finale-call-overlay').classList.add('show');
});

socket.on('finaleCountdownStart', (data) => {
    document.getElementById('finale-waiting-status').style.display = 'none';
    const cdBlock = document.getElementById('finale-countdown-block');
    cdBlock.style.display = 'block';
    let n = data.seconds;
    const numEl = document.getElementById('countdown-number');
    numEl.innerText = n;
    AudioFX.tick();

    const iv = setInterval(() => {
        n--;
        if (n <= 0) {
            clearInterval(iv);
            numEl.innerText = '0';
        } else {
            numEl.innerText = n;
            AudioFX.tick();
        }
    }, 1000);
});

// ==================== ФИНАЛ: ЭТАП 2 — ЛИДЕРБОРД ====================

socket.on('finaleLeaderboard', (data) => {
    document.getElementById('finale-call-overlay').classList.remove('show');
    showLeaderboardAnimation(data.entries, data.ratingResults || []);

    if (myAccount) {
        const mine = (data.ratingResults || []).find(r => r.username === myAccount.username);
        if (mine) {
            myAccount.rating = mine.newRating;
            myAccount.divisionId = mine.divisionId;
            myAccount.divisionName = mine.divisionName;
            myAccount.isChampion = !!mine.isChampion;
            renderAccountPill();
        }
    }

    if (data.championChange) {
        const { newChampionName, previousChampionName } = data.championChange;
        let text;
        if (newChampionName && previousChampionName) {
            text = `👑 ${newChampionName} сверг ${previousChampionName} и стал новым ${CHAMPION_TITLE}ом сервера!`;
        } else if (newChampionName) {
            text = `👑 ${newChampionName} — первый ${CHAMPION_TITLE} сервера!`;
        } else {
            text = `👑 Трон ${CHAMPION_TITLE.toLowerCase()}а опустел...`;
        }
        setTimeout(() => showChampionAnnouncement(text), 1200);
    }
});

function showChampionAnnouncement(text) {
    const el = document.createElement('div');
    el.className = 'champion-announcement';
    el.innerText = text;
    document.body.appendChild(el);
    AudioFX.victory && AudioFX.victory();
    setTimeout(() => el.classList.add('show'), 20);
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 500); }, 5000);
}

function lbAvatarHtml(photo, colorBorder) {
    return `<div class="lb-avatar" style="border-color:${colorBorder}">${photo ? `<img src="${photo}">` : '<div class="lb-avatar-placeholder"></div>'}</div>`;
}

function ratingChipHtml(name, ratingResults) {
    const r = (ratingResults || []).find(r => r.username === name);
    if (!r) return '';
    const sign = r.delta > 0 ? '+' : '';
    const color = r.delta > 0 ? '#4caf50' : (r.delta < 0 ? '#ff5252' : '#9aa5ff');
    const crown = r.isChampion ? '👑 ' : '';
    return ` <span style="font-size:11px; font-weight:700; color:${color};">${crown}${sign}${r.delta} РО</span>`;
}

function showLeaderboardAnimation(entries, ratingResults) {
    const overlay = document.getElementById('finale-leaderboard-overlay');
    const list = document.getElementById('leaderboard-list');
    const menuBtn = document.getElementById('finale-menu-btn');
    list.innerHTML = '';
    menuBtn.style.display = 'none';
    overlay.classList.add('show');

    if (!entries || entries.length === 0) {
        menuBtn.style.display = 'inline-block';
        return;
    }

    const reversed = [...entries].reverse(); // от последнего места к первому
    const total = reversed.length;
    let idx = 0;

    function revealNext() {
        if (idx >= total) {
            setTimeout(() => { menuBtn.style.display = 'inline-block'; }, 700);
            return;
        }

        const entry = reversed[idx];
        const place = total - idx;
        const isWinner = place === 1;

        const row = document.createElement('div');
        row.className = 'leaderboard-row lb-pop-in' + (isWinner ? ' winner-row' : '');

        let namesHtml, avatarsHtml;
        if (entry.type === 'team') {
            namesHtml = entry.members.map(m => m.name + ratingChipHtml(m.name, ratingResults)).join(' &amp; ');
            avatarsHtml = `<div class="lb-avatars-group">${entry.members.map(m => lbAvatarHtml(m.photo, entry.color)).join('')}</div>`;
        } else {
            namesHtml = entry.name + ratingChipHtml(entry.name, ratingResults);
            avatarsHtml = `<div class="lb-avatars-group">${lbAvatarHtml(entry.photo, entry.color)}</div>`;
        }

        row.innerHTML = `
            <div class="lb-place" style="${isWinner ? 'color:gold;' : ''}">#${place}</div>
            ${avatarsHtml}
            <div class="lb-name">${namesHtml}</div>
            <div class="lb-po">${entry.po} ПО</div>
        `;
        list.prepend(row);

        AudioFX.reveal();

        if (isWinner) {
            setTimeout(() => {
                row.classList.add('winner-final');
                document.getElementById('leaderboard-title').innerText = '🏆 ПОБЕДИТЕЛЬ! 🏆';
                AudioFX.victory();
            }, 500);
        }

        idx++;
        setTimeout(revealNext, isWinner ? 2600 : 1700);
    }

    document.getElementById('leaderboard-title').innerText = 'Итоги матча';
    revealNext();
}

function returnToMenu() {
    AudioFX.click();
    socket.emit('finaleAcknowledge');
}

// ==================== ВЫХОД ЗА ПРЕДЕЛЫ ИГРОВОЙ ЗОНЫ ====================

let zoneWarningInterval = null;
let zoneWarningRemaining = 0;

function showZoneWarning(seconds) {
    const overlay = document.getElementById('zone-warning-overlay');
    const numEl = document.getElementById('zone-countdown-number');
    overlay.classList.add('show');

    zoneWarningRemaining = seconds;
    numEl.innerText = zoneWarningRemaining;

    if (zoneWarningInterval) clearInterval(zoneWarningInterval);
    AudioFX.tick();
    zoneWarningInterval = setInterval(() => {
        zoneWarningRemaining--;
        if (zoneWarningRemaining <= 0) {
            numEl.innerText = '0';
            clearInterval(zoneWarningInterval);
            zoneWarningInterval = null;
        } else {
            numEl.innerText = zoneWarningRemaining;
            if (zoneWarningRemaining <= 10) AudioFX.tick();
        }
    }, 1000);
}

function hideZoneWarning() {
    document.getElementById('zone-warning-overlay').classList.remove('show');
    if (zoneWarningInterval) { clearInterval(zoneWarningInterval); zoneWarningInterval = null; }
}

function showZoneDeathToast() {
    const toast = document.getElementById('zone-death-toast');
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 4500);
}

socket.on('zoneWarningStart', (data) => { showZoneWarning(data.seconds); });
socket.on('zoneWarningClear', () => { hideZoneWarning(); });
socket.on('zoneDeath', () => {
    hideZoneWarning();
    AudioFX.stop();
    showZoneDeathToast();
});

function activateKillMode() { AudioFX.attack(); socket.emit('activateKillMode'); }

function openShop() {
    if (!myData.inCheckpoint) return;
    AudioFX.click();
    const isMain = myCurrentCheckpoint && myCurrentCheckpoint.startsWith('cp_main');
    document.getElementById('shop-convert-box').style.display = isMain ? 'block' : 'none';

    const list = document.getElementById('shop-items-list'); list.innerHTML = '';
    for (const [id, item] of Object.entries(SHOP_ITEMS)) {
        if (item.level === 'main' && !isMain) continue;
        if (id === 'trio' && myData.canTrio) continue;
        list.innerHTML += `<div class="shop-item"><div><b>${item.name}</b><br><small style="color:gray;">${item.desc}</small></div><button onclick="buyItem('${id}')" style="background: #4caf50;">${item.cost} 🟡</button></div>`;
    }
    showModal('shop-modal');
}

function openTeamManage() {
    if (!myData.inCheckpoint) return;
    AudioFX.click();
    document.getElementById('team-invite-actions').style.display = myData.pendingInvite ? 'block' : 'none';
    document.getElementById('team-leave-actions').style.display = myData.teamId ? 'block' : 'none';
    if (myData.teamId && gameTeams[myData.teamId]) document.getElementById('team-po-display').innerText = gameTeams[myData.teamId].totalPO;

    showModal('team-modal');
}

function buyItem(itemId) { AudioFX.buy(); socket.emit('buyItem', itemId); }
function useItem(itemId) { AudioFX.click(); socket.emit('useItem', itemId); closeModals(); }
function acceptInvite() { socket.emit('acceptInvite'); closeModals(); }
function declineInvite() { socket.emit('declineInvite'); closeModals(); }
function leaveTeam() { socket.emit('leaveTeam'); closeModals(); }

function openInventory() {
    AudioFX.click();
    const list = document.getElementById('inventory-items-list'); list.innerHTML = ''; let hasItems = false;
    if (myData.inventory) {
        for (const [id, count] of Object.entries(myData.inventory)) {
            if (count > 0) {
                hasItems = true;
                list.innerHTML += `<div class="inv-item"><div><b>${SHOP_ITEMS[id].name}</b> <span style="color:#ff4081;">x${count}</span></div><button onclick="useItem('${id}')" style="background: #2196f3;">Исп.</button></div>`;
            }
        }
    }
    if (!hasItems) list.innerHTML = '<i>Здесь пока пусто...</i>';
    showModal('inventory-modal');
}

function showModal(id) {
    document.getElementById('modal-overlay').classList.add('show');
    document.getElementById(id).classList.add('show');
}

function closeModals() {
    document.getElementById('modal-overlay').classList.remove('show');
    ['shop-modal', 'inventory-modal', 'team-modal', 'info-modal'].forEach(id => document.getElementById(id).classList.remove('show'));
}

// ==================== СПРАВКА ПО МЕХАНИКАМ ====================

function openInfoModal(sectionId) {
    AudioFX.click();
    showModal('info-modal');
    if (sectionId) setTimeout(() => scrollInfoTo(sectionId), 50);
}

function scrollInfoTo(sectionId) {
    const el = document.getElementById(sectionId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function createBubbleIcon(player) {
    const now = Date.now(); let cssClass = 'bubble-marker-icon '; let extraHtml = '';
    if (player.inCheckpoint) cssClass += 'in-checkpoint';
    else if (player.isDead) { cssClass += 'bubble-dead'; extraHtml = '<div class="dead-overlay">💀</div>'; }
    else if (player.killModeEnd && now < player.killModeEnd) cssClass += 'bubble-attack';
    else if (player.killCooldown && now < (player.killModeEnd + 90000)) cssClass += 'bubble-cooldown';

    let pColor = player.color;
    if (player.teamId && gameTeams[player.teamId]) pColor = gameTeams[player.teamId].leaderColor;

    const html = `<div class="${cssClass}" style="width: 45px; height: 45px; background-color: ${pColor}; border-radius: 50%; border: 3px solid white; display: flex; align-items: center; justify-content: center; position: relative; overflow: hidden;">
            ${player.photo ? `<img src="${player.photo}" style="width: 100%; height: 100%; object-fit: cover;">` : ''} ${extraHtml}
        </div><div style="text-align: center; font-weight: bold; color: black; text-shadow: 1px 1px 2px white; margin-left: -20px; width: 85px;">${player.name}</div>`;
    return L.divIcon({ className: '', html: html, iconSize: [45, 45], iconAnchor: [22, 22] });
}

function createCoinIcon(color) { return L.divIcon({ className: '', html: `<div style="width: 20px; height: 20px; background: radial-gradient(circle, ${color}, #fff); border-radius: 50%; border: 2px solid white; box-shadow: 0 0 5px rgba(0,0,0,0.5);"></div>`, iconSize: [20, 20], iconAnchor: [10, 10] }); }

function spawnCheckpoint(cp) {
    const isMain = cp.type === 'main';
    const icon = L.divIcon({ className: '', html: `<div style="font-size: 30px; text-shadow: 0 0 5px black; text-align: center;">${isMain ? '🏆' : '🏳️'}</div>`, iconSize: [30, 30], iconAnchor: [15, 30] });
    L.circle([cp.lat, cp.lng], { color: '#4caf50', fillColor: '#4caf50', fillOpacity: 0.3, radius: 8 }).addTo(map);
    L.marker([cp.lat, cp.lng], { icon }).addTo(map).bindPopup(isMain ? 'Главная База' : 'База');
}

// Радиус игровой зоны + буфер, за пределами которого тайлы карты вообще не подгружаются.
// Это экономит трафик и разгружает рендер на слабых мобильных устройствах.
const ZONE_RADIUS_M = 375;
const TILE_LOAD_PADDING_M = 300;

function metersToLatLngBounds(centerLat, centerLng, radiusM) {
    const latDelta = radiusM / 111320;
    const lngDelta = radiusM / (111320 * Math.cos(centerLat * Math.PI / 180));
    return L.latLngBounds(
        [centerLat - latDelta, centerLng - lngDelta],
        [centerLat + latDelta, centerLng + lngDelta]
    );
}

function initMap() {
    if (map) return;

    const tileBounds = metersToLatLngBounds(gameCenter[0], gameCenter[1], ZONE_RADIUS_M + TILE_LOAD_PADDING_M);

    map = L.map('map', {
        preferCanvas: true,
        zoomControl: true,
        maxBounds: tileBounds,
        maxBoundsViscosity: 1.0,
        minZoom: 14,
        maxZoom: 19
    }).setView(gameCenter, 16);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        minZoom: 14,
        bounds: tileBounds,
        keepBuffer: 2,
        updateWhenZooming: false
    }).addTo(map);

    L.circle(gameCenter, { color: '#ff2e93', weight: 2, fillColor: '#ff2e93', fillOpacity: 0.06, radius: ZONE_RADIUS_M }).addTo(map);

    if (!checkGeoSupport()) return;

    let geoWatchId = null;
    let geoLastFixTime = Date.now();
    let geoFallbackTimer = null;

    function handleGeoPosition(pos) {
        geoLastFixTime = Date.now();
        hideGeoWarning();
        updatePosition(pos);
    }

    function restartGeoWatch() {
        if (geoWatchId !== null) navigator.geolocation.clearWatch(geoWatchId);
        geoWatchId = navigator.geolocation.watchPosition(
            handleGeoPosition,
            handleGeoError,
            { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 }
        );
    }

    function scheduleGeoFallback() {
        if (geoFallbackTimer) clearInterval(geoFallbackTimer);

        geoFallbackTimer = setInterval(() => {
            const staleMs = Date.now() - geoLastFixTime;
            const shouldRefresh = staleMs > 12000 || document.visibilityState === 'hidden';

            if (shouldRefresh) {
                navigator.geolocation.getCurrentPosition(
                    handleGeoPosition,
                    (err) => {
                        if (err.code === 1) handleGeoError(err);
                        else if (Date.now() - geoLastFixTime > 30000) {
                            console.warn('Статус геолокации задержан — пробуем повторно после таймаута.');
                        }
                    },
                    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
                );
            }
        }, 8000);
    }

    restartGeoWatch();
    scheduleGeoFallback();
    requestWakeLock();

    // Мобильные браузеры (особенно iOS) часто "замораживают" watchPosition,
    // пока вкладка/приложение свёрнуто, и не всегда возобновляют его сами
    // при возврате — поэтому перезапускаем слежение на обоих переходах.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            restartGeoWatch();
        } else {
            restartGeoWatch();
            requestWakeLock();
            navigator.geolocation.getCurrentPosition(handleGeoPosition, handleGeoError, {
                enableHighAccuracy: true,
                maximumAge: 2000,
                timeout: 15000
            });
        }
    });
}

// ==================== WAKE LOCK ====================
// Пока экран не гаснет, GPS-модуль и watchPosition работают заметно стабильнее —
// на многих телефонах при блокировке экрана обновления геопозиции почти
// прекращаются. Держим экран активным, пока идёт игра.

let wakeLockRef = null;

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLockRef = await navigator.wakeLock.request('screen');
            wakeLockRef.addEventListener('release', () => { wakeLockRef = null; });
        }
    } catch (e) {
        console.warn('Wake Lock недоступен:', e);
    }
}

function updateVisibility() {
    const now = Date.now();
    const canScan = myData.activeEffects && now < myData.activeEffects.scan;
    const amIJammed = myData.activeEffects && now < myData.activeEffects.jammed;

    for (let id in gameBubbles) {
        const b = gameBubbles[id];
        let isFriendly = b.ownerId === socket.id;
        if (myData.teamId && gameTeams[myData.teamId] && gameTeams[myData.teamId].members.includes(b.ownerId)) isFriendly = true;

        const isTrap = b.type === 'trap';
        let visible = isFriendly || canScan || isTrap;

        if (visible) {
            if (!b.marker) {
                let renderColor = (isTrap && !isFriendly) ? myData.color : b.color;
                b.marker = L.marker([b.lat, b.lng], { icon: createCoinIcon(renderColor) }).addTo(map);
            }
        } else {
            if (b.marker) { map.removeLayer(b.marker); b.marker = null; }
        }
    }

    teamPolylines.forEach(pl => map.removeLayer(pl)); teamPolylines = [];
    if (myData.teamId && gameTeams[myData.teamId]) {
        const tColor = gameTeams[myData.teamId].leaderColor;
        const members = gameTeams[myData.teamId].members.filter(m => m !== socket.id && gamePlayers[m] && gamePlayers[m].lat);
        members.forEach(m => {
            const pl = L.polyline([[myData.lat, myData.lng], [gamePlayers[m].lat, gamePlayers[m].lng]], { color: tColor, dashArray: '5, 5', weight: 3 }).addTo(map);
            teamPolylines.push(pl);
        });
    }

    for (let id in otherPlayers) {
        const p = gamePlayers[id];
        if (!p) continue;
        const isSmoked = p.activeEffects && now < p.activeEffects.smoke;
        let isFriendly = myData.teamId && p.teamId === myData.teamId;

        let visible = (!amIJammed && !isSmoked) || isFriendly;

        if (visible) {
            otherPlayers[id].setLatLng([p.lat, p.lng]);
            otherPlayers[id].setIcon(createBubbleIcon(p));
            if (!map.hasLayer(otherPlayers[id])) map.addLayer(otherPlayers[id]);
        } else {
            if (map.hasLayer(otherPlayers[id])) map.removeLayer(otherPlayers[id]);
        }
    }
}

function createOtherPlayerMarker(player) {
    if (player.id === socket.id || player.lat == null || player.lng == null || otherPlayers[player.id]) return;

    const marker = L.marker([player.lat, player.lng], { icon: createBubbleIcon(player) });
    marker.on('click', () => {
        if (confirm(`Предложить союз игроку ${gamePlayers[player.id].name}?`)) {
            socket.emit('invitePlayer', player.id);
        }
    });
    otherPlayers[player.id] = marker;
    marker.addTo(map);
}

function centerOnPlayer() {
    if (!map || !myMarker) return;
    map.flyTo(myMarker.getLatLng(), Math.max(map.getZoom(), 17), { duration: 0.5 });
}

function updatePosition(position) {
    myData.lat = position.coords.latitude; myData.lng = position.coords.longitude;
    const myLatLng = L.latLng(myData.lat, myData.lng);

    if (!myMarker) {
        myMarker = L.marker(myLatLng, { icon: createBubbleIcon(myData) }).addTo(map);
        map.setView(myLatLng, 17);
    } else {
        myMarker.setLatLng(myLatLng);
    }

    // Троттлинг: шлём координаты на сервер не чаще раза в ~1.2с. Без этого при нескольких игроках
    // сервер рассылает каждому все чужие 'playerMoved' пропорционально частоте GPS-колбэков —
    // трафик и нагрузка растут квадратично от числа игроков.
    const nowTs = Date.now();
    if (nowTs - lastLocationEmitTime >= LOCATION_EMIT_INTERVAL_MS) {
        lastLocationEmitTime = nowTs;
        socket.emit('updateLocation', { lat: myData.lat, lng: myData.lng });
    }

    let closestCP = null; let minDist = Infinity;
    for (let cp of gameCheckpoints) {
        const dist = myLatLng.distanceTo(L.latLng(cp.lat, cp.lng));
        if (dist < minDist) { minDist = dist; closestCP = cp.id; }
    }

    if (minDist <= 8) {
        if (myCurrentCheckpoint !== closestCP) { myCurrentCheckpoint = closestCP; socket.emit('enterCheckpoint', closestCP); }
    } else {
        if (myCurrentCheckpoint !== null) { myCurrentCheckpoint = null; socket.emit('leaveCheckpoint'); closeModals(); }
    }

    if (myData.isDead) return;

    const pickupRadius = (myData.activeEffects && Date.now() < myData.activeEffects.magnet) ? 25 : 10;

    for (let id in gameBubbles) {
        if (myLatLng.distanceTo(L.latLng(gameBubbles[id].lat, gameBubbles[id].lng)) < pickupRadius) {
            AudioFX.collect();
            socket.emit('collectBubble', id);
            if (gameBubbles[id].marker) map.removeLayer(gameBubbles[id].marker);
            delete gameBubbles[id];
        }
    }

    const now = Date.now();
    if (myData.killModeEnd && now < myData.killModeEnd && !myData.inCheckpoint) {
        for (let id in otherPlayers) {
            const targetP = gamePlayers[id];
            if (!targetP || targetP.isDead || targetP.inCheckpoint) continue;
            if (myLatLng.distanceTo(L.latLng(targetP.lat, targetP.lng)) <= 5) socket.emit('tryKill', id);
        }
    }
}

function updateUI() {
    const now = Date.now();
    const btnKill = document.getElementById('btn-kill');
    const btnShop = document.getElementById('btn-shop');
    const btnTeam = document.getElementById('btn-team-manage');
    const status = document.getElementById('status-text');
    const timerDisplay = document.getElementById('match-timer');

    if (matchEndTime > 0) {
        const remainingMs = Math.max(0, matchEndTime - now);
        const totalSec = Math.floor(remainingMs / 1000);
        const hrs = Math.floor(totalSec / 3600);
        const mins = Math.floor((totalSec % 3600) / 60);
        const secs = totalSec % 60;

        timerDisplay.innerText = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

        if (totalSec <= 300 && totalSec > 0) timerDisplay.classList.add('timer-warning');
        else timerDisplay.classList.remove('timer-warning');
    }

    let displayPO = myData.po || 0;
    if (myData.teamId && gameTeams[myData.teamId]) displayPO = gameTeams[myData.teamId].totalPO;
    document.getElementById('val-po').innerText = displayPO;

    document.getElementById('val-coins').innerText = myData.coins || 0;
    document.getElementById('val-mult').innerText = myData.multiplier || 1;

    if (myData.pendingInvite) {
        document.getElementById('invite-toast').innerText = `${myData.pendingInvite.fromName} предлагает союз! Зайдите в базу.`;
        document.getElementById('invite-toast').style.display = 'block';
    } else {
        document.getElementById('invite-toast').style.display = 'none';
    }

    if (myData.inCheckpoint) {
        status.innerText = "В БЕЗОПАСНОЙ ЗОНЕ"; status.style.color = "gold";
        btnKill.style.display = "none"; btnShop.style.display = "inline-block";
        if (myData.pendingInvite || myData.teamId) btnTeam.style.display = "inline-block"; else btnTeam.style.display = "none";
    } else {
        btnShop.style.display = "none"; btnTeam.style.display = "none";
        if (myData.isDead) { status.innerText = "ВЫ МЕРТВЫ 💀"; status.style.color = "gray"; btnKill.style.display = "none"; }
        else if (myData.shieldEnd && now < myData.shieldEnd) {
            status.innerText = `Щит: ${Math.ceil((myData.shieldEnd - now) / 1000)} сек.`; status.style.color = "#4caf50"; btnKill.style.display = "none";
        } else if (myData.killModeEnd && now < myData.killModeEnd) {
            status.innerText = `Атака: ${Math.ceil((myData.killModeEnd - now) / 1000)} сек.`; status.style.color = "red"; btnKill.style.display = "none";
        } else if (myData.killCooldown && now < myData.killCooldown) {
            status.innerText = `Перезарядка: ${Math.ceil((myData.killCooldown - now) / 1000)} сек.`; status.style.color = "orange"; btnKill.style.display = "none";
        } else {
            status.innerText = "Готов к бою"; status.style.color = "black"; btnKill.style.display = "block";
        }
    }

    if (myData.activeEffects) {
        const effs = myData.activeEffects;
        document.getElementById('buff-scan').style.display = effs.scan > now ? 'block' : 'none'; if (effs.scan > now) document.querySelector('#buff-scan .time').innerText = Math.ceil((effs.scan - now) / 1000) + 'с';
        document.getElementById('buff-dash').style.display = effs.dash > now ? 'block' : 'none'; if (effs.dash > now) document.querySelector('#buff-dash .time').innerText = Math.ceil((effs.dash - now) / 1000) + 'с';
        document.getElementById('buff-smoke').style.display = effs.smoke > now ? 'block' : 'none'; if (effs.smoke > now) document.querySelector('#buff-smoke .time').innerText = Math.ceil((effs.smoke - now) / 1000) + 'с';
        document.getElementById('buff-magnet').style.display = effs.magnet > now ? 'block' : 'none'; if (effs.magnet > now) document.querySelector('#buff-magnet .time').innerText = Math.ceil((effs.magnet - now) / 1000) + 'с';
        document.getElementById('buff-jammed').style.display = effs.jammed > now ? 'block' : 'none'; if (effs.jammed > now) document.querySelector('#buff-jammed .time').innerText = Math.ceil((effs.jammed - now) / 1000) + 'с';
    }

    if (myMarker) myMarker.setIcon(createBubbleIcon(myData));
    updateVisibility();
}

socket.on('playerStateChanged', (updatedPlayer) => {
    gamePlayers[updatedPlayer.id] = updatedPlayer;
    if (updatedPlayer.id === socket.id) { myData = updatedPlayer; updateUI(); }
    else if (map && updatedPlayer.lat != null) {
        createOtherPlayerMarker(updatedPlayer);
        updateVisibility();
    }
});

socket.on('teamUpdated', (ts) => { gameTeams = ts; updateUI(); });
socket.on('newBubble', (bubble) => { gameBubbles[bubble.id] = bubble; updateVisibility(); });
socket.on('bubbleCollected', (id) => { if (gameBubbles[id] && gameBubbles[id].marker) { map.removeLayer(gameBubbles[id].marker); } delete gameBubbles[id]; });

socket.on('playerMoved', (data) => {
    if (gamePlayers[data.id]) {
        gamePlayers[data.id].lat = data.coords.lat; gamePlayers[data.id].lng = data.coords.lng;
        if (document.getElementById('map').style.display === 'block') createOtherPlayerMarker(gamePlayers[data.id]);
        if (otherPlayers[data.id]) otherPlayers[data.id].setLatLng([data.coords.lat, data.coords.lng]);
    }
});

socket.on('playerDisconnected', (id) => { if (otherPlayers[id]) { map.removeLayer(otherPlayers[id]); delete otherPlayers[id]; } });
