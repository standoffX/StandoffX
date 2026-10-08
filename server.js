const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const { Server } = require("socket.io"); // Додаємо сокети
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
let matchmakingQueue = [];
const SServer = 1 // http - 1, https - 2 
// ----------------------------
const CLANS_PATH = path.join(__dirname, "clans.json");
function getClans() {
  try {
    if (!fs.existsSync(CLANS_PATH)) fs.writeFileSync(CLANS_PATH, JSON.stringify({}, null, 2));
    const data = JSON.parse(fs.readFileSync(CLANS_PATH, 'utf8'));
    return Array.isArray(data) ? {} : (data || {});
  } catch (err) {
    console.error("[CLANS]", err.message);
    return {};
  }
}
function saveClans(clans) {
  fs.writeFileSync(CLANS_PATH, JSON.stringify(clans || {}, null, 2), 'utf8');
}
function loadClans() {
  return {
    clans: Object.values(getClans()).map(clan => ({
      ...clan,
      tag: clan.tag || clan.name,
      members: Array.isArray(clan.members) ? clan.members : []
    }))
  };
}

let server = null;
const app = express();
const PORT = Number(process.env.PORT) || (SServer === 2 ? 443 : 3000);

if (SServer === 2) {
  const tlsOptions = {
    key: fs.readFileSync(path.join(__dirname, 'site.local-key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'site.local.pem'))
  };
  server = https.createServer(tlsOptions, app);
} else {
  server = http.createServer(app);
}
const io = new Server(server);
// --- БАЗА ДАНИХ В ПАМ'ЯТІ ---
// Це оголошення db, щоб твої роути кланів та заявок не падали

let db = {
  clans: [],
  clanRequests: [],
  clanMembers: [],
  clan_requests: [],
  clan_members: [],
  friend_requests: []
};
app.use(express.json({ limit: '10mb' }));

const storage = multer.diskStorage({
    destination: path.join(__dirname, 'avatars'),
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname).toLowerCase());
    }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    cb(allowed.has(file.mimetype) ? null : new Error('Дозволені тільки зображення'), allowed.has(file.mimetype));
  }
});

if (!fs.existsSync('avatars')) {
    fs.mkdirSync('avatars');
}

app.use(express.static(__dirname));
app.use('/avatars', express.static('avatars'));


let cachedUsers = null;
const SKINS_PATH = path.join(__dirname, "skins.json");
const INVENTORY_PATH = path.join(__dirname, "inventory.json");

// 1. Функція для отримання всіх скінів у грі
function getSkins() {
    try {
        if (!fs.existsSync(SKINS_PATH)) {
            // Створюємо базовий шаблон, якщо файлу немає
            const defaultSkins = {
                "akr_treasure": { 
                    "name": "AKR 'Treasure'", 
                    "image": "https://via.placeholder.com/150/dc2626", 
                    "rarity": "arcane", 
                    "modelUrl": "models/akr_treasure.gltf" 
                },
                "g22_frost": { 
                    "name": "G22 'Frost'", 
                    "image": "https://via.placeholder.com/150/3b82f6", 
                    "rarity": "rare", 
                    "modelUrl": "models/g22_frost.gltf" 
                }
            };
            fs.writeFileSync(SKINS_PATH, JSON.stringify(defaultSkins, null, 2));
        }
        return JSON.parse(fs.readFileSync(SKINS_PATH, 'utf8'));
    } catch (err) { return {}; }
}

// 2. Функція для отримання інвентарів гравців
function getInventory() {
    try {
        if (!fs.existsSync(INVENTORY_PATH)) {
            fs.writeFileSync(INVENTORY_PATH, JSON.stringify({}, null, 2));
        }
        return JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));
    } catch (err) { return {}; }
}

// Ендпоінт: Отримати всі існуючі скіни
app.get('/api/skins', (req, res) => {
    res.json(getSkins());
});

// Ендпоінт: Отримати інвентар конкретного гравця
app.post('/api/inventory/my', (req, res) => {
    const { userId } = req.body;
    const inventoryDB = getInventory();
    const allSkins = getSkins();
    
    // Отримуємо масив ID скінів користувача (або порожній масив, якщо інвентар пустий)
    const mySkinIds = inventoryDB[userId] || []; 
    
    // Об'єднуємо ID скінів з їхніми характеристиками з skins.json
    const mySkinsData = mySkinIds.map(skinId => {
        return { skinId: skinId, ...allSkins[skinId] };
    }).filter(skin => skin.name); // Відфільтровуємо помилкові, якщо скін видалили з бази

    res.json({ success: true, inventory: mySkinsData });
});
function getUsers() {
    if (cachedUsers) return cachedUsers; 
    try {
        if (!fs.existsSync('account.json')) {
            fs.writeFileSync('account.json', JSON.stringify([], null, 2));
        }
        const data = fs.readFileSync('account.json', 'utf8');
        cachedUsers = JSON.parse(data);
        return cachedUsers;
    } catch (err) {
        console.error("Помилка читання бази:", err);
        return [];
    }
}

// Функція тепер ОНОВЛЮЄ кеш і пише файл асинхронно
function saveUsers(users) {
    cachedUsers = Array.isArray(users) ? users : [];
    fs.writeFileSync('account.json', JSON.stringify(cachedUsers, null, 2), 'utf8');
}

// Знайти і замінити блок app.get('/api/user-data', ...) у server.js
app.get('/api/user-data', (req, res) => {
  let userId = req.query.id;
  if (!userId) return res.status(400).json({ success: false, message: "ID не вказано" });

  // Авто-корекція ID (якщо прийшли тільки цифри)
  if (/^\d+$/.test(userId)) {
      userId = "ID_" + userId;
  }

  const users = getUsers();
  const user = users.find(u => u.id === userId);

  if (user) {
    // ЗБИРАЄМО ДАНІ ПРО ДРУЗІВ
    // Шукаємо в роуті app.get('/api/user-data', ...)
const allUsers = getUsers(); 

const friendsData = (user.friendsList || []).map(fId => {
    const friend = allUsers.find(u => u.id === fId);
    if (friend) {
        return { 
            id: friend.id, 
            nickname: friend.nickname, 
            playerAvatar: friend.playerAvatar,
            isVerified: friend.isVerified || false, // Твоя галочка
            status: friend.status || 'offline'      // Статус (онлайн/офлайн)
        };
    }
    return null;
}).filter(f => f !== null);
    // --- НОВИЙ БЛОК ВІДПОВІДІ ---
    const { password, ...fullUserData } = user; // Відсікаємо пароль, беремо ВСЕ інше

    res.json({
        success: true,
        user: fullUserData, // Тепер тут є MMR, інвентар, заявки і все-все-все
        friends: friendsData 
    });
    // ----------------------------
} else {
      res.status(404).json({ success: false, message: "Користувача не знайдено" });
  }
});

// 3. ОПТИМІЗАЦІЯ ПОШУКУ ДРУЗІВ (щоб не гальмувало при великій кількості гравців)
app.all('/api/get-my-friends', (req, res) => {
    let userId = req.query.userId || req.body.userId;
    if (!userId) return res.status(400).json({ success: false });

    if (/^\d+$/.test(userId)) userId = "ID_" + userId;

    const users = getUsers();
    const user = users.find(u => u.id === userId.toString());

    if (!user || !user.friendsList) return res.json({ success: true, friends: [] });

    // Створюємо Map для швидкого пошуку (O(1) замість O(N))
    const usersMap = new Map(users.map(u => [u.id, u]));

    const friendsData = user.friendsList.map(fId => {
        const f = usersMap.get(fId);
        return f ? {
            id: f.id,
            nickname: f.nickname,
            playerAvatar: f.playerAvatar || "/avatars/default.jpg",
            status: f.status || false
        } : null;
    }).filter(f => f !== null);

    res.json({ success: true, friends: friendsData });
});


// Цей рядок каже серверу: "Якщо просять файл з папки ranks, просто віддай його"
app.use('/ranks', express.static(path.join(__dirname, 'ranks')));
app.use('/avatars', express.static(path.join(__dirname, 'avatars')));

// Створимо папку ranks автоматично, якщо її немає, щоб не було помилок
if (!fs.existsSync('ranks')) {
    fs.mkdirSync('ranks');
}


const MARKET_PATH = path.join(__dirname, "marketplace.json");

// Функція для читання ринку
function getMarket() {
    try {
        if (!fs.existsSync(MARKET_PATH)) fs.writeFileSync(MARKET_PATH, JSON.stringify([], null, 2));
        return JSON.parse(fs.readFileSync(MARKET_PATH, 'utf8'));
    } catch (err) { return []; }
}

// Отримати всі лоти на ринку
app.get('/api/market/items', (req, res) => {
    const items = getMarket();
    res.json(items);
});

// Виставити скін на ринок
app.post('/api/market/sell', (req, res) => {
    const { userId, skinId, price, skinName, rarity } = req.body;
    let market = getMarket();
    let users = getUsers();
    let user = users.find(u => u.id === userId);

    if (!user) return res.json({ success: false, message: "Юзера не знайдено" });

    const newLot = {
        lotId: Date.now(),
        sellerId: userId,
        sellerNick: user.nickname,
        skinId: skinId,
        skinName: skinName,
        rarity: rarity, // 'rare', 'epic', 'arcane'
        price: numericPrice,
        date: new Date().toISOString()
    };

    market.push(newLot);
    fs.writeFileSync(MARKET_PATH, JSON.stringify(market, null, 2));
    res.json({ success: true, lot: newLot });
});
app.post('/api/clans/search', (req, res) => {
  const { query } = req.body;

  const results = db.clans.filter(c =>
      c.name.toLowerCase().includes(query.toLowerCase()) ||
      c.tag.toLowerCase().includes(query.toLowerCase())
  );

  res.json({ success: true, clans: results });
});
app.post('/api/clans/request', (req, res) => {
  const { userId, clanId } = req.body;

  const exists = db.clanRequests.find(r =>
      r.userId === userId &&
      r.clanId === clanId &&
      r.status === "pending"
  );

  if (exists)
      return res.json({ success: false, message: "Заявка вже подана" });

  db.clanRequests.push({
      id: Date.now(),
      clanId,
      userId,
      status: "pending"
  });

  res.json({ success: true });
});
app.post('/api/clans/requests', (req, res) => {
  const { userId } = req.body;

  const member = db.clanMembers.find(m => m.userId === userId);
  if (!member) return res.json({ success: false });

  if (!["owner","officer"].includes(member.role))
      return res.json({ success: false });

  const requests = db.clanRequests.filter(r =>
      r.clanId === member.clanId &&
      r.status === "pending"
  );

  res.json({ success: true, requests });
});
app.post('/api/clans/accept', (req, res) => {
  const { requestId } = req.body;

  const request = db.clanRequests.find(r => r.id === requestId);
  if (!request) return res.json({ success: false });

  request.status = "accepted";

  db.clanMembers.push({
      clanId: request.clanId,
      userId: request.userId,
      role: "member"
  });

  res.json({ success: true });
});
app.get("/api/clans", (req, res) => {
  const clansData = loadClans();
  res.json(clansData);
});

app.post("/send-friend-request", (req, res) => {
  const from = req.user.id
  const to = Number(req.body.userId)

  if (from === to)
    return res.json({ error: "Нельзя добавить себя" })

  const exists = db.friend_requests.find(r =>
    r.from === from && r.to === to && r.status === "pending"
  )

  if (exists)
    return res.json({ error: "Заявка уже отправлена" })

  db.friend_requests.push({
    from,
    to,
    status: "pending"
  })

  res.json({ success: true })
})
app.post("/decline-friend", (req, res) => {
  const requestId = req.body.id
  const request = db.friend_requests.find(r => r.id === requestId)

  if (!request)
    return res.json({ error: "Не найдена" })

  request.status = "declined"
  res.json({ success: true })
})
app.post("/send-clan-request", (req, res) => {
  const userId = req.user.id
  const clanId = Number(req.body.clanId)

  const exists = db.clan_requests.find(r =>
    r.userId === userId &&
    r.clanId === clanId &&
    r.status === "pending"
  )

  if (exists)
    return res.json({ error: "Заявка уже отправлена" })

  db.clan_requests.push({
    clanId,
    userId,
    status: "pending"
  })

  res.json({ success: true })
})
app.post("/accept-clan-request", (req, res) => {
  const requestId = req.body.id
  const request = db.clan_requests.find(r => r.id === requestId)

  if (!request)
    return res.json({ error: "Не найдена" })

  request.status = "accepted"

  db.clan_members.push({
    clanId: request.clanId,
    userId: request.userId,
    role: "member"
  })

  res.json({ success: true })
})
// 2. ФІКС API ДЛЯ ДРУЗІВ (Помилка 404)
// Ми робимо обробник саме для GET, бо в консолі видно: GET .../api/get-my-friends

// 3. ФІКС ВІДПРАВКИ ПОВІДОМЛЕНЬ (якщо раптом не було)
app.post('/api/send-message', (req, res) => {
    const { fromId, toId, text } = req.body;
    let users = getUsers();
    
    const targetIndex = users.findIndex(u => u.id === toId);
    const sender = users.find(u => u.id === fromId);

    if (targetIndex !== -1 && sender) {
        if (!users[targetIndex].messages) users[targetIndex].messages = [];
        
        users[targetIndex].messages.push({
            from: sender.nickname,
            fromId: sender.id,
            text: text,
            time: new Date().toLocaleTimeString()
        });
        
        saveUsers(users);
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false, message: "Гравця не знайдено" });
    }
});
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'auth.html')));
app.get('/game', (req, res) => res.sendFile(path.join(__dirname, 'mainMenu.html')));


// Щоб ранги працювали, додай роздачу папки (якщо вона є)
app.use('/ranks', express.static('ranks'));
// ОНОВЛЕНИЙ ЛОГІН
app.post('/api/login', (req, res) => {
    let { nickname, password } = req.body;
    
    // Якщо ввели просто цифри, автоматично додаємо ID_
    if (/^\d+$/.test(nickname)) {
        nickname = "ID_" + nickname;
    }

    const users = getUsers();
    const user = users.find(u =>
        (u.id === nickname || u.nickname === nickname) &&
        verifyPassword(password, u.passwordHash || u.password)
    );

    if (user) {
        if (user.isBanned) {
            return res.status(403).json({ success: false, message: "Ваш акаунт заблоковано!" });
        }
        const { password, passwordHash, ...userData } = user;
        res.json({ success: true, redirect: '/game', user: userData });
    } else {
        res.status(401).json({ success: false, message: "Невірний нік/ID або пароль!" });
    }
});

// НОВА РЕЄСТРАЦІЯ
app.post('/api/register', (req, res) => {
    const { nickname, password } = req.body;
    
    if (!nickname || !password) {
        return res.status(400).json({ success: false, message: "Заповніть всі поля!" });
    }

    const users = getUsers();
    
    if (users.find(u => u.nickname.toLowerCase() === nickname.toLowerCase())) {
        return res.status(400).json({ success: false, message: "Цей нікнейм вже зайнятий!" });
    }

    // Генеруємо випадковий ID з 6 цифр
    const newId = "ID_" + Math.floor(100000 + Math.random() * 900000);

    // В середині app.post('/api/register')
const newUser = {
  nickname,
  password,
  id: newId,
  playerAvatar: "/avatars/default_avatar.jpg",
  status: true,
  XP: 0,
  gold: 0, // Початковий баланс, щоб вистачило на клан
  clan: null,
  MMRCompetitive: 1000,
  MMRAllies: 1000,
  isVerified: false,
  isBanned: false,
  isAdmin: false,
  friendsList: [],
  incomingRequests: [], // Вхідні заявки
  blocked: []           // Заблоковані
};

    users.push(newUser);
    saveUsers(users);

    const { password, passwordHash, ...userData } = newUser;
    res.json({ success: true, redirect: '/game', user: userData });
});

// Покращений пошук (виправляє баг "не знайдено")
app.post('/api/search-user', (req, res) => {
  const { query } = req.body;
  const users = getUsers();
  if (!query) return res.status(400).json({ success: false });

  const q = query.toString().trim();
  // Шукаємо за ніком або за ID (ігноруючи регістр та префікс)
  const user = users.find(u => 
      u.nickname.toLowerCase() === q.toLowerCase() || 
      u.id.toLowerCase() === q.toLowerCase() ||
      u.id.toLowerCase() === (q.toLowerCase().startsWith('id_') ? q.toLowerCase() : 'id_' + q.toLowerCase())
  );

  if (user) {
      res.json({ success: true, user: { nickname: user.nickname, id: user.id, playerAvatar: user.playerAvatar } });
  } else {
      res.json({ success: false, message: "Користувача не знайдено" });
  }
});



// --- ВІДПРАВКА ЗАПИТУ В ДРУЗІ (Фікс) ---


// --- СТВОРЕННЯ КЛАНУ (Фікс) ---
app.post('/api/create-clan', (req, res) => {
  const { userId, clanTag } = req.body;
  let users = getUsers();
  let clans = getClans();
  const user = users.find(u => u.id === userId);

  if (!user || user.gold < 500) return res.json({ success: false, message: "Недостатньо голди (500)" });
  if (user.clan) return res.json({ success: false, message: "Ви вже в клані" });

  const cleanTag = clanTag.toUpperCase().trim();
  if (clans[cleanTag]) return res.json({ success: false, message: "Такий тег зайнятий" });

  // Оновлюємо користувача
  user.gold -= 500;
  user.clan = cleanTag;

  // Реєструємо клан у системі
  clans[cleanTag] = {
      owner: user.id,
      members: [user.id],
      name: clanTag,
      created: new Date().toISOString()
  };

  saveUsers(users);
  saveClans(clans);
  res.json({ success: true, newGold: user.gold });
});
// АКТИВАЦІЯ ПРОМОКОДУ
app.post('/api/use-promo', (req, res) => {
  const { nickname, code } = req.body;
  const users = getUsers();
  const user = users.find(u => u.nickname === nickname);

  // Приклад промокоду на 1000 голди
  if (code === "SOFTERX-2024") {
      user.gold += 1000;
      saveUsers(users);
      return res.json({ success: true, message: "Нараховано 1000 голди!", gold: user.gold });
  }
  
  res.status(400).json({ success: false, message: "Невірний або прострочений код" });
});
// ВІДПРАВИТИ ЗАПИТ


// ПРИЙНЯТИ ЗАПИТ

app.post('/api/sync', (req, res) => {
  const { nickname } = req.body;
  const users = getUsers();
  const user = users.find(u => u.nickname === nickname);

  if (user) {
      // Создаем копию объекта пользователя, чтобы не портить оригинал
      const fullUserData = { ...user };

      // ПРЕВРАЩАЕМ МАССИВ ID В МАССИВ ОБЪЕКТОВ
      if (Array.isArray(user.friendsList)) {
          fullUserData.friendsList = user.friendsList
              .map(friendId => {
                  // Ищем друга в общем списке пользователей по его ID
                  const foundFriend = users.find(u => u.id === friendId);
                  
                  // Если нашли — возвращаем только нужные данные
                  if (foundFriend) {
                      return {
                          id: foundFriend.id,
                          nickname: foundFriend.nickname,
                          playerAvatar: foundFriend.playerAvatar,
                          status: foundFriend.status // статус берем из базы
                      };
                  }
                  return null; // Если не нашли (удален)
              })
              .filter(f => f !== null); // Очищаем список от "ненайденных" (null)
      }

      res.json({ success: true, user: fullUserData });
  } else {
      res.status(404).json({ success: false });
  }
});

app.post('/api/upload-clan-avatar', upload.single('avatar'), (req, res) => {
  const { userId, clanTag } = req.body;
  let clans = getClans();
  const clan = clans[clanTag];

  if (clan && clan.leaderId === userId && req.file) {
      clan.avatar = '/avatars/' + req.file.filename;
      saveClans(clans);
      res.json({ success: true, newPath: clan.avatar });
  } else {
      res.status(403).json({ success: false, message: "Ви не лідер або файл не обрано" });
  }
});
app.get('/api/sync/:nickname', (req, res) => {
  const users = getUsers();
  const user = users.find(u => u.nickname === req.params.nickname);
  if (user) {
      const { password, ...userData } = user;
      res.json(userData);
  } else {
      res.status(404).send();
  }
});
// ОНОВЛЕННЯ ДАНИХ (щоб підвантажувати нові повідомлення та друзів)
app.post('/api/sync-user', (req, res) => {
  const { id } = req.body;
  const users = getUsers();
  const user = users.find(u => u.id === id);
  if (user) {
      const { password, ...userData } = user;
      res.json({ success: true, user: userData });
  } else {
      res.status(404).json({ success: false });
  }
});

// ДОДАВАННЯ ДРУГА
// Функція для збереження юзерів (переконайся, що вона у тебе є)


// --- РОУТ ДОДАВАННЯ В ДРУЗІ ---
app.post('/api/add-friend', (req, res) => {
  try {
      const { fromId, toId } = req.body;
      let users = getUsers();

      const sender = users.find(u => u.id === fromId);
      const target = users.find(u => u.id === toId);

      if (!sender || !target) {
          return res.status(404).json({ success: false, message: "Користувача не знайдено" });
      }

      // Ініціалізуємо масиви, якщо їх немає
      if (!sender.friendsList) sender.friendsList = [];
      if (!target.friendsList) target.friendsList = [];

      // Перевірка, чи вже не друзі
      if (sender.friendsList.includes(toId)) {
          return res.json({ success: false, message: "Вже у друзях" });
      }

      // Додаємо обом (взаємна дружба)
      sender.friendsList.push(toId);
      target.friendsList.push(fromId);

      saveUsers(users);
      console.log(`Успіх: ${sender.nickname} додав ${target.nickname}`);
      
      res.json({ success: true });
  } catch (err) {
      console.error("Помилка на сервері:", err);
      res.status(500).json({ success: false, message: "Помилка сервера" });
  }
});
// ВІДПРАВКА ПОВІДОМЛЕННЯ

app.post('/api/upload-avatar', upload.single('avatar'), (req, res) => {
  const { nickname } = req.body;
  const users = getUsers();
  const userIndex = users.findIndex(u => u.nickname === nickname);

  if (userIndex !== -1 && req.file) {
      // Зберігаємо шлях з початковим слешем для зручності фронтенду
      const newPath = '/avatars/' + req.file.filename;
      users[userIndex].playerAvatar = newPath;
      saveUsers(users);
      res.json({ success: true, newPath: newPath });
  } else {
      res.status(400).json({ success: false, message: "Файл не завантажено" });
  }
});
 // Черга гравців

 

// Встав це ПЕРЕД io.on('connection')
let activeMatches = {}; 




// --- ОБ'ЄДНАНИЙ БЛОК CONNECTION ---
io.on('connection', (socket) => {
  console.log(`\x1b[36m[CONN]\x1b[0m Нове підключення: ${socket.id}`);

  // ========================
  // 1. СИСТЕМА МАТЧМЕЙКІНГУ
  // ========================
  socket.on('start_search', (data) => {
      console.log(`\x1b[33m[QUEUE]\x1b[0m Гравець ${data.nickname} (ID: ${data.userId}) став у чергу.`);
      
      const isAlreadyInQueue = matchmakingQueue.some(p => p.userId === data.userId);
      if (!isAlreadyInQueue) {
          matchmakingQueue.push({ 
              socketId: socket.id, 
              userId: data.userId, 
              nickname: data.nickname 
          });
      }
      
      io.emit('queue_update', { count: matchmakingQueue.length });

      if (matchmakingQueue.length >= 3) {
          const players = matchmakingQueue.splice(0, 3);
          const matchId = 'match_' + Date.now();
          const hunterIndex = Math.floor(Math.random() * players.length);
         
            const spawns = [{x: 5, y: 0, z: 5}, {x: 25, y: 0, z: 25}, {x: 15, y: 0, z: 5}];

          players.forEach((p, i) => {
              p.role = (i === hunterIndex) ? 'hunter' : 'runner';
              p.score = 0;
              p.spawnPos = spawns[i];
              p.pos = spawns[i];
          });

          activeMatches[matchId] = { players, isStarted: false };
          console.log(`\x1b[32m[MATCH_CREATED]\x1b[0m Матч ${matchId} сформовано!`);
          
          players.forEach(p => {
              io.to(p.socketId).emit('match_found', { matchId: matchId, userId: p.userId });
          });
      }
  });

  // ========================
  // 2. ВХІД В ІГРОВУ КІМНАТУ
  // ========================
  socket.on('join_room', (data) => {
      const currentId = data.userId ? String(data.userId).trim() : null;
      const matchId = data.matchId;
      const match = activeMatches[matchId];

      if (!match) return socket.emit('kick_to_menu', { reason: "Матч не знайдено" });

      const player = match.players.find(p => String(p.userId) === currentId);
      if (!player) return socket.emit('kick_to_menu');

      player.socketId = socket.id;
      socket.join(matchId);
      
      socket.emit('init_player', {
          role: player.role,
          spawn: player.spawnPos,
          nickname: player.nickname
      });

      if (!match.isStarted) {
          match.isStarted = true;
          startMainMatch(matchId); // Твоя функція таймера
      }
  });

  // ========================
  // 3. РУХ ТА ЛОГІКА ЛОВЛІ
  // ========================
  socket.on('player_moved', (data) => {
      if (!data.matchId || !data.userId) return;
      const match = activeMatches[data.matchId];
      if (!match) return;

      const currentPlayer = match.players.find(p => p.userId === data.userId);
      if (!currentPlayer) return;

      currentPlayer.pos = { x: data.x, y: data.y, z: data.z };

      // ЛОГІКА ЛОВЛІ
      if (currentPlayer.role === 'hunter') {
          match.players.forEach(p => {
              if (p.role === 'runner' && p.pos) {
                  const dist = Math.sqrt(
                      Math.pow(currentPlayer.pos.x - p.pos.x, 2) + 
                      Math.pow(currentPlayer.pos.z - p.pos.z, 2)
                  );

                  if (dist < 1.8) { // Дистанція лову
                      console.log(`\x1b[31m[CATCH]\x1b[0m ${currentPlayer.nickname} зловив ${p.nickname}`);
                      
                      // 1. Додаємо +1 в статистику хантеру
                      currentPlayer.score += 1;

                      // 2. ПЕРЕОБИРАННЯ РОЛЕЙ: Зловлений стає новим хантером
                      match.players.forEach(playerInMatch => {
                          if (playerInMatch.userId === p.userId) {
                              playerInMatch.role = 'hunter';
                          } else {
                              playerInMatch.role = 'runner';
                          }
                          // Респавн всіх на їх початкові точки
                          playerInMatch.pos = playerInMatch.spawnPos;
                      });

                      // 3. Відправляємо всім сигнал про оновлення ролей та позицій
                      io.to(data.matchId).emit('roles_updated', {
                          players: match.players.map(pl => ({
                              userId: pl.userId,
                              role: pl.role,
                              score: pl.score,
                              spawn: pl.spawnPos
                          })),
                          message: `${currentPlayer.nickname} спіймав ${p.nickname}! Тепер ${p.nickname} - мисливець!`
                      });
                  }
              }
          });
      }

      socket.to(data.matchId).emit('enemy_moved', { 
          id: socket.id,
          userId: currentPlayer.userId,
          x: data.x, y: data.y, z: data.z, 
          rotY: data.rotY,
          role: currentPlayer.role, 
          nickname: currentPlayer.nickname 
      });
  });

  // ========================
  // 4. СИСТЕМА ЧАТУ (ПРИВАТ)
  // ========================
  socket.on('join_chat', ({ userId, friendId }) => {
      const roomId = getRoomId(userId, friendId);
      socket.join(roomId);
      const allMsgs = getMessages();
      socket.emit('chat_history', allMsgs[roomId] || []);
  });

  socket.on('send_msg', ({ fromId, toId, text, senderName }) => {
      const roomId = getRoomId(fromId, toId);
      const msgData = {
          senderId: fromId,
          senderName: senderName,
          text: text,
          time: new Date().toLocaleTimeString()
      };

      let allMsgs = getMessages();
      if (!allMsgs[roomId]) allMsgs[roomId] = [];
      allMsgs[roomId].push(msgData);
      saveMessages(allMsgs);

      io.to(roomId).emit('new_msg', msgData);
  });

  socket.on('disconnect', () => {
      console.log(`\x1b[90m[DISCONN]\x1b[0m Сокет від'єднався: ${socket.id}`);
      matchmakingQueue = matchmakingQueue.filter(p => p.socketId !== socket.id);
  });
});
// --- ФІКС КЛАНІВ ---
app.post('/api/clans/create', (req, res) => {
  const { userId, tag } = req.body; // Використовуємо tag, як у тебе на фронті
  let users = getUsers();
  let clans = getClans();
  const user = users.find(u => u.id === userId || u.nickname === req.body.nickname);

  if (!user || user.gold < 500) return res.json({ success: false, message: "Недостатньо голди (500)" });
  if (user.clan) return res.json({ success: false, message: "Ви вже в клані" });

  const cleanTag = tag.toUpperCase().trim();
  if (clans[cleanTag]) return res.json({ success: false, message: "Такий тег вже зайнятий" });

  // Знімаємо голду і прописуємо тег клану
  user.gold -= 500;
  user.clan = cleanTag;

  clans[cleanTag] = {
      name: cleanTag, // Або можна додати окреме поле для повної назви
      tag: cleanTag,
      ownerId: user.id,
      level: 1,
      exp: 0,
      createdAt: Date.now()
  };

  saveUsers(users);
  saveClans(clans);
  res.json({ success: true, gold: user.gold, clan: cleanTag });
});

app.post('/api/clans/my', (req, res) => {
  const { userId } = req.body;
  const users = getUsers();
  const clans = getClans();
  const user = users.find(u => u.id === userId);

  if (!user || !user.clan) return res.json({ success: true, clan: null });

  const clan = clans[user.clan];
  if (!clan) return res.json({ success: true, clan: null });

  // Знаходимо всіх учасників клану
  const members = users.filter(u => u.clan === clan.tag).map(u => ({
      userId: u.id,
      nickname: u.nickname,
      role: clan.ownerId === u.id ? 'owner' : 'member'
  }));

  res.json({
      success: true,
      clan: clan,
      members: members,
      myRole: clan.ownerId === userId ? 'owner' : 'member'
  });
});
// Прийняти запит
app.post('/api/friends/accept', (req, res) => {
  const { myId, friendId } = req.body; // Змінено на myId
  let users = getUsers();
  let user = users.find(u => u.id == myId);
  let friend = users.find(u => u.id == friendId);

  if (user && friend) {
      user.friendsList = user.friendsList || [];
      friend.friendsList = friend.friendsList || [];
      
      if (!user.friendsList.includes(friendId)) user.friendsList.push(friendId);
      if (!friend.friendsList.includes(myId)) friend.friendsList.push(myId);
      
      // Видаляємо із заявок
      user.incomingRequests = (user.incomingRequests || []).filter(id => id != friendId);
      
      saveUsers(users);
      res.json({ success: true });
  } else {
      res.json({ success: false, message: "Гравця не знайдено" });
  }
});
app.post('/api/clans/leave', (req, res) => {
  const { userId } = req.body;
  let users = getUsers();
  const userIndex = users.findIndex(u => u.id === userId);

  if (userIndex !== -1 && users[userIndex].clan) {
      users[userIndex].clan = null; // Видаляємо з клану
      saveUsers(users);
      return res.json({ success: true });
  }
  res.json({ success: false, message: "Ви не в клані" });
});
// --- РОБОТА З ПОВІДОМЛЕННЯМИ ---
const MESSAGES_PATH = path.join(__dirname, 'messages.json');

function getMessages() {
    try {
        if (!fs.existsSync(MESSAGES_PATH)) fs.writeFileSync(MESSAGES_PATH, JSON.stringify({}));
        return JSON.parse(fs.readFileSync(MESSAGES_PATH, 'utf8'));
    } catch (err) { return {}; }
}

function saveMessages(msgs) {
    fs.writeFileSync(MESSAGES_PATH, JSON.stringify(msgs, null, 2));
}


// Отримати список активних діалогів (з ким є історія в messages.json)
app.get('/api/chat/active-dialogs/:userId', (req, res) => {
  const userId = req.params.userId;
  const allMsgs = getMessages();
  const users = getUsers();
  let dialogPartners = new Set();

  // Шукаємо всі кімнати, де є ID нашого користувача
  Object.keys(allMsgs).forEach(roomId => {
      const ids = roomId.split('_');
      if (ids.includes(userId)) {
          const partnerId = ids.find(id => id !== userId);
          if (partnerId) dialogPartners.add(partnerId);
      }
  });

  // Отримуємо дані цих користувачів (нік, аватар)
  const result = users
      .filter(u => dialogPartners.has(u.id.toString()))
      .map(u => ({ id: u.id, nickname: u.nickname, playerAvatar: u.playerAvatar }));

  res.json(result);
});
// Функція для створення ID кімнати (завжди однакова для двох гравців)
function getRoomId(id1, id2) {
    return [id1.toString(), id2.toString()].sort().join('_');
}

// --- API ДЛЯ ДРУЗІВ ---
// --- API ДЛЯ ДРУЗІВ ---

// Надіслати запит
app.post('/api/friends/request', (req, res) => {
    const { fromId, toId } = req.body;
    let users = getUsers();
    let target = users.find(u => u.id == toId);
    
    if (!target) return res.json({ success: false, message: "Гравця не знайдено" });
    if (fromId == toId) return res.json({ success: false, message: "Не можна додати себе" });

    // Використовуємо incomingRequests, бо ти його задаєш при реєстрації!
    if (!target.incomingRequests) target.incomingRequests = [];
    if (target.incomingRequests.includes(fromId)) return res.json({ success: false, message: "Запит уже надіслано" });
    
    target.incomingRequests.push(fromId);
    saveUsers(users);
    res.json({ success: true });
});

// Отримати вхідні запити
app.post('/api/friends/incoming', (req, res) => {
    const { userId } = req.body;
    const users = getUsers();
    const user = users.find(u => u.id == userId);

    if (!user) return res.status(404).json({ success: false, message: "Користувача не знайдено" });

    // Отримуємо дані тих, хто надіслав запит (теж incomingRequests)
    const incomingRequestsData = (user.incomingRequests || []).map(senderId => {
        const sender = users.find(u => u.id == senderId);
        return sender ? { id: sender.id, nickname: sender.nickname, playerAvatar: sender.playerAvatar } : null;
    }).filter(u => u !== null);

    res.json({ success: true, incoming: incomingRequestsData });
});



async function runMatchLifecycle(matchId) {
    console.log(`[LIFECYCLE] Початок розминки для ${matchId}`);
    
    // 1. РОЗМИНКА (15 сек)
    let warmup = 15;
    let warmupInterval = setInterval(() => {
        warmup--;
        io.to(matchId).emit('timer_update', { time: warmup, status: "Розминка" });
        if (warmup <= 0) {
            clearInterval(warmupInterval);
            console.log(`[LIFECYCLE] Розминка закінчена. Починаємо гру!`);
            startMainMatch(matchId);
        }
    }, 1000);
}

function startMainMatch(matchId) {
  const match = activeMatches[matchId];
  if (!match) return;

  let matchTime = 300; // 5 хвилин (300 секунд)
  io.to(matchId).emit('match_start_now');

  // Очищуємо старий інтервал, якщо він був (профілактика багів)
  if (match.timer) clearInterval(match.timer);

  match.timer = setInterval(() => {
      matchTime--;
      
      // Відправляємо оновлення таймера всім у кімнаті
      io.to(matchId).emit('timer_update', { 
          time: matchTime, 
          status: "ГРА ЙДЕ!" 
      });
      
      if (matchTime <= 0) {
          clearInterval(match.timer);
          console.log(`[LIFECYCLE] Час вийшов для матчу ${matchId}`);
          finishMatch(matchId);
      }
  }, 1000);
}

function finishMatch(matchId) {
  const match = activeMatches[matchId];
  if (!match) return;

  console.log(`[LIFECYCLE] Завершення матчу ${matchId}, розрахунок нагород...`);

  let users = getUsers(); // Завантажуємо актуальний список юзерів з файлу

  // Знаходимо гравця з найбільшим рахунком (переможця)
  const sortedPlayers = [...match.players].sort((a, b) => b.score - a.score);
  const maxScore = sortedPlayers[0].score;

  match.players.forEach(playerInMatch => {
      const userIndex = users.findIndex(u => u.id === playerInMatch.userId);
      
      if (userIndex !== -1) {
          // Логіка нагород:
          // Переможцю (якщо score > 0) даємо 10 голди, іншим 2.
          const goldReward = (playerInMatch.score === maxScore && maxScore > 0) ? 10 : 2;
          const xpReward = playerInMatch.score + 50; // Базові 50 XP + очки за гру

          // Оновлюємо дані в масиві
          users[userIndex].gold = (users[userIndex].gold || 0) + goldReward;
          users[userIndex].XP = (users[userIndex].XP || 0) + xpReward;

          // Відправляємо результат конкретному гравцю через його сокет
          io.to(playerInMatch.socketId).emit('show_results', { 
              xp: xpReward, 
              gold: goldReward,
              msg: `Матч завершено! Ти отримав ${goldReward} Gold та ${xpReward} XP.`
          });
      }
  });

  // Зберігаємо оновлені дані всіх гравців у файл account.json
  saveUsers(users);

  // Через 10 секунд повертаємо всіх у меню і видаляємо матч з пам'яті
  setTimeout(() => {
      io.to(matchId).emit('go_to_menu');
      delete activeMatches[matchId];
      console.log(`[LIFECYCLE] Матч ${matchId} видалено, гравці повернуті в меню.`);
  }, 10000);
}

app.post('/api/market/buy', (req, res) => {
  const { userId, lotId } = req.body;
  const users = getUsers();
  const market = getMarket();
  const buyer = users.find(u => u.id === userId);
  const index = market.findIndex(lot => String(lot.lotId) === String(lotId));

  if (!buyer) return res.status(404).json({ success: false, message: "Покупця не знайдено" });
  if (index === -1) return res.status(404).json({ success: false, message: "Лот уже недоступний" });

  const lot = market[index];
  const price = Number(lot.price);
  if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ success: false, message: "Некоректний лот" });
  if (lot.sellerId === buyer.id) return res.status(400).json({ success: false, message: "Не можна купити власний лот" });
  if (Number(buyer.gold || 0) < price) return res.status(400).json({ success: false, message: "Недостатньо голди" });

  const seller = users.find(u => u.id === lot.sellerId);
  if (!seller) return res.status(404).json({ success: false, message: "Продавця не знайдено" });

  const inventory = getInventory();
  inventory[buyer.id] = Array.isArray(inventory[buyer.id]) ? inventory[buyer.id] : [];
  inventory[buyer.id].push(lot.skinId);

  buyer.gold = Number(buyer.gold || 0) - price;
  seller.gold = Number(seller.gold || 0) + price;
  market.splice(index, 1);

  fs.writeFileSync(INVENTORY_PATH, JSON.stringify(inventory, null, 2));
  fs.writeFileSync(MARKET_PATH, JSON.stringify(market, null, 2));
  saveUsers(users);

  res.json({ success: true, gold: buyer.gold, item: lot });
});

app.post('/api/match-results', (req, res) => {
    const { userId, caughtCount, isWinner } = req.body;
    let users = getUsers();
    let user = users.find(u => u.id === userId);

    if (user) {
        const earnedXP = caughtCount * 20;
        user.XP += earnedXP;
        
        if (isWinner) {
            user.gold += 5;
        }

        saveUsers(users);
        res.json({ success: true, xp: earnedXP, gold: isWinner ? 5 : 0 });
    }
});


// 4. ЗАПУСК З АВТО-ПОСИЛАННЯМ
server.listen(PORT, () => {
    let protocol = "http";
    if (SServer === 2) {
        protocol = "https";
    }
    
    let host = protocol + "://localhost:" + PORT;
    if (process.env.RENDER_EXTERNAL_URL) {
        host = process.env.RENDER_EXTERNAL_URL;
    }

    console.log("--------------------------");
    console.log("СЕРВЕР ЗАПУЩЕНО!");
    console.log("ПОСИЛАННЯ: " + host);
    console.log("ПОРТ: " + PORT);
    console.log("--------------------------");
});
