const express = require("express");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const { MongoClient } = require("mongodb");
const { Server } = require("socket.io");

const app = express();
const SServer = Number(process.env.STANDOFFX_HTTPS || 0); // 0 = HTTP, 1 = HTTPS
const PORT = Number(process.env.PORT) || (SServer ? 443 : 3000);
const ADMIN_ID = "Dev_01";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "sonia";


const ROOT = __dirname;
const USERS_PATH = path.join(ROOT, "account.json");
const CLANS_PATH = path.join(ROOT, "clans.json");
const MESSAGES_PATH = path.join(ROOT, "messages.json");
const MARKET_PATH = path.join(ROOT, "marketplace.json");
const INVENTORY_PATH = path.join(ROOT, "inventory.json");
const SKINS_PATH = path.join(ROOT, "skins.json");
const AVATARS_DIR = path.join(ROOT, "avatars");

for (const dir of [AVATARS_DIR, path.join(ROOT, "ranks")]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2) + "\n", "utf8");
      return fallback;
    }
    const raw = fs.readFileSync(file, "utf8").trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error("[JSON]", path.basename(file), err.message);
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

const DEFAULT_SKINS = {
  ak47_default: {
    name: "AKR",
    weapon: "AK-47",
    rarity: "common",
    type: "weapon",
    modelUrl: "ak-47.glb"
  },
  p90_default: {
    name: "P90",
    weapon: "P90",
    rarity: "rare",
    type: "weapon",
    modelUrl: "P90.glb"
  },
  revolver_default: {
    name: "Revolver",
    weapon: "Revolver",
    rarity: "epic",
    type: "weapon",
    modelUrl: "Revolver.glb"
  },
  shotgun_default: {
    name: "Shotgun",
    weapon: "Shotgun",
    rarity: "legendary",
    type: "weapon",
    modelUrl: "Shotgun.glb"
  },
  sniper_default: {
    name: "Sniper Rifle",
    weapon: "Sniper Rifle",
    rarity: "arcane",
    type: "weapon",
    modelUrl: "SniperRifle.glb"
  },
  pistol_default: {
    name: "Pistol",
    weapon: "Pistol",
    rarity: "common",
    type: "weapon",
    modelUrl: "Pistol.glb"
  }
};

let skins = readJson(SKINS_PATH, DEFAULT_SKINS);
if (!skins || Array.isArray(skins) || typeof skins !== "object") skins = DEFAULT_SKINS;
writeJson(SKINS_PATH, skins);

let users = readJson(USERS_PATH, []);
if (!Array.isArray(users)) users = [];
let clans = readJson(CLANS_PATH, {});
if (!clans || Array.isArray(clans) || typeof clans !== "object") clans = {};
let messages = readJson(MESSAGES_PATH, {});
if (!messages || typeof messages !== "object" || Array.isArray(messages)) messages = {};
let inventory = readJson(INVENTORY_PATH, {});
if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) inventory = {};
let market = readJson(MARKET_PATH, []);
if (!Array.isArray(market)) market = [];

function saveUsers() { writeJson(USERS_PATH, users); mongoSave("state_users", users); }
function saveClans() { writeJson(CLANS_PATH, clans); mongoSave("state_clans", clans); }
function saveMessages() { writeJson(MESSAGES_PATH, messages); mongoSave("state_messages", messages); }
function saveInventory() { writeJson(INVENTORY_PATH, inventory); mongoSave("state_inventory", inventory); }
let mongoClient = null;
let mongoDb = null;

async function initMongo() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) return false;
  try {
    mongoClient = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 5 });
    await mongoClient.connect();
    mongoDb = mongoClient.db(process.env.MONGODB_DB || "standoffx");
    const load = async (name, fallback) => {
      const doc = await mongoDb.collection(name).findOne({ _id: "main" });
      return doc && doc.data !== undefined ? doc.data : fallback;
    };
    users = await load("state_users", users);
    clans = await load("state_clans", clans);
    messages = await load("state_messages", messages);
    inventory = await load("state_inventory", inventory);
    market = await load("state_market", market);
    for (const user of users) ensureUserShape(user);
    console.log("[DB] MongoDB connected");
    return true;
  } catch (err) {
    console.error("[DB] MongoDB unavailable:", err.message);
    mongoDb = null;
    return false;
  }
}

function mongoSave(name, data) {
  if (!mongoDb) return;
  mongoDb.collection(name).replaceOne(
    { _id: "main" },
    { _id: "main", data },
    { upsert: true }
  ).catch(err => console.error("[DB]", err.message));
}

function saveMarket() {
  writeJson(MARKET_PATH, market);
  mongoSave("state_market", market);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;
  if (!stored.startsWith("scrypt:")) return stored === String(password);
  const [, salt, expectedHex] = stored.split(":");
  if (!salt || !expectedHex) return false;
  try {
    const actual = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(expectedHex, "hex");
    return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function cleanText(value, max = 120) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeId(value) {
  return cleanText(value, 80);
}

function findUser(idOrNickname) {
  const q = normalizeId(idOrNickname);
  const qLower = q.toLowerCase();
  const fixed = /^\d+$/.test(q) ? "ID_" + q : q;
  return users.find(u =>
    String(u.id).toLowerCase() === fixed.toLowerCase() ||
    String(u.nickname).toLowerCase() === qLower
  );
}

function isAdmin(user) {
  return Boolean(user && (user.id === ADMIN_ID || user.isAdmin === true));
}

function requireAdmin(req, res, next) {
  const user = requestUser(req);
  if (!user) return res.status(401).json({ success: false, message: "Авторизація потрібна." });
  if (!isAdmin(user)) return res.status(403).json({ success: false, message: "Потрібні права адміністратора." });
  req.user = user;
  next();
}

function publicUser(user) {
  if (!user) return null;
  const { password, passwordHash, ...safe } = user;
  safe.friendsList = Array.isArray(user.friendsList) ? user.friendsList : [];
  safe.incomingRequests = Array.isArray(user.incomingRequests) ? user.incomingRequests : [];
  safe.blocked = Array.isArray(user.blocked) ? user.blocked : [];
  safe.usedPromos = Array.isArray(user.usedPromos) ? user.usedPromos : [];
  return safe;
}

function ensureUserShape(user) {
  user.nickname = cleanText(user.nickname, 24);
  user.id = normalizeId(user.id);
  if (!Array.isArray(user.friendsList)) user.friendsList = [];
  if (!Array.isArray(user.incomingRequests)) user.incomingRequests = [];
  if (!Array.isArray(user.blocked)) user.blocked = [];
  if (!Array.isArray(user.usedPromos)) user.usedPromos = [];
  user.XP = Number(user.XP) || 0;
  user.gold = Number(user.gold) || 0;
  user.MMRCompetitive = Number(user.MMRCompetitive) || 1000;
  user.MMRAllies = Number(user.MMRAllies) || 1000;
  user.status = Boolean(user.status);
  user.isVerified = Boolean(user.isVerified);
  user.isBanned = Boolean(user.isBanned);
  user.isAdmin = Boolean(user.isAdmin);
}

for (const user of users) ensureUserShape(user);

if (users.some(u => u.clan === "67") && !clans["67"]) {
  clans["67"] = {
    name: "67",
    tag: "67",
    ownerId: users.find(u => u.clan === "67")?.id || "Dev_01",
    level: 1,
    xp: 0,
    createdAt: Date.now()
  };
  saveClans();
}
for (const clan of Object.values(clans)) {
  clan.name = cleanText(clan.name || clan.tag || "Clan", 24);
  clan.tag = cleanText(clan.tag || clan.name, 5).toUpperCase();
  clan.ownerId = normalizeId(clan.ownerId || clan.owner || "");
  clan.level = Number(clan.level) || 1;
  clan.xp = Number(clan.xp) || 0;
}
saveClans();

const sessions = new Map();

function parseCookies(header = "") {
  const out = {};
  for (const item of header.split(";")) {
    const idx = item.indexOf("=");
    if (idx <= 0) continue;
    const key = item.slice(0, idx).trim();
    const value = decodeURIComponent(item.slice(idx + 1).trim());
    out[key] = value;
  }
  return out;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { userId, createdAt: Date.now() });
  return token;
}

function sessionUserFromToken(token) {
  const data = token ? sessions.get(token) : null;
  if (!data) return null;
  const user = users.find(u => u.id === data.userId);
  if (!user) {
    sessions.delete(token);
    return null;
  }
  return user;
}

function requestUser(req) {
  return sessionUserFromToken(parseCookies(req.headers.cookie || "").standoffx_session);
}

function requireAuth(req, res, next) {
  const user = requestUser(req);
  if (!user) return res.status(401).json({ success: false, message: "Авторизуйся." });
  if (user.isBanned && user.id !== ADMIN_ID) return res.status(403).json({ success: false, message: "Акаунт заблоковано." });
  req.user = user;
}

function isAdmin(user) {
  return Boolean(user && (user.id === ADMIN_ID || user.isAdmin === true));
}

function requireAdmin(req, res, next) {
  const user = requestUser(req);
  if (!user) return res.status(401).json({ success: false, message: "Авторизація потрібна." });
  if (!isAdmin(user)) return res.status(403).json({ success: false, message: "Тільки адміністратор." });
  req.user = user;
  next();
}

function setSessionCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `standoffx_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    "standoffx_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
  );
}

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use(express.static(ROOT));
app.use("/avatars", express.static(AVATARS_DIR, { maxAge: "1d" }));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AVATARS_DIR),
  filename: (_req, file, cb) => {
    cb(null, `${Date.now()}-${crypto.randomBytes(3).toString("hex")}${path.extname(file.originalname).toLowerCase()}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
    cb(null, allowed.has(file.mimetype));
  }
});

app.get("/", (_req, res) => res.sendFile(path.join(ROOT, "auth.html")));
app.get("/game", (_req, res) => res.sendFile(path.join(ROOT, "mainMenu.html")));

app.get("/api/health", (_req, res) => {
  res.json({ success: true, game: "StandoffX", version: "0.2.0" });
});

app.post("/api/register", (req, res) => {
  const nickname = cleanText(req.body.nickname, 24);
  const password = String(req.body.password || "");

  if (!/^[\p{L}\p{N}_-]{3,24}$/u.test(nickname)) {
    return res.status(400).json({ success: false, message: "Нік: 3–24 символи, літери/цифри/_/-." });
  }
  if (password.length < 4 || password.length > 128) {
    return res.status(400).json({ success: false, message: "Пароль має містити 4–128 символів." });
  }
  if (users.some(u => String(u.nickname).toLowerCase() === nickname.toLowerCase())) {
    return res.status(409).json({ success: false, message: "Такий нік вже зайнятий." });
  }

  let id;
  do id = "ID_" + crypto.randomInt(100000, 1000000); while (users.some(u => u.id === id));

  const user = {
    nickname,
    id,
    passwordHash: hashPassword(password),
    playerAvatar: "/avatars/default.jpg",
    status: true,
    XP: 0,
    gold: 0,
    clan: null,
    MMRCompetitive: 1000,
    MMRAllies: 1000,
    isVerified: false,
    isBanned: false,
    isAdmin: false,
    friendsList: [],
    incomingRequests: [],
    blocked: [],
    usedPromos: []
  };

  users.push(user);
  inventory[user.id] = inventory[user.id] || [];
  saveUsers();
  saveInventory();

  const token = createSession(user.id);
  setSessionCookie(res, token);
  res.json({ success: true, redirect: "/game", user: publicUser(user) });
});

app.post("/api/login", (req, res) => {
  let nickname = cleanText(req.body.nickname, 80);
  const password = String(req.body.password || "");
  if (/^\d+$/.test(nickname)) nickname = "ID_" + nickname;

  let user = findUser(nickname);

  // Master account: ID завжди Dev_01, пароль задається тільки через Render Secret.
  if (nickname === ADMIN_ID && ADMIN_PASSWORD && password === ADMIN_PASSWORD) {
    user = user || { id: ADMIN_ID, nickname: "SofterX" };
    user.id = ADMIN_ID;
    user.nickname = "SofterX";
    user.isAdmin = true;
    user.isBanned = false;
    user.passwordHash = hashPassword(ADMIN_PASSWORD);
    ensureUserShape(user);
    if (!users.some(u => u.id === ADMIN_ID)) users.push(user);
    saveUsers();
  }

  if (!user || !verifyPassword(password, user.passwordHash || user.password)) {
    return res.status(401).json({ success: false, message: "Невірний нік/ID або пароль." });
  }
  if (user.isBanned && user.id !== ADMIN_ID) return res.status(403).json({ success: false, message: "Акаунт заблоковано." });

  if (!user.passwordHash) {
    user.passwordHash = hashPassword(password);
    delete user.password;
    saveUsers();
  }

  user.status = true;
  saveUsers();

  const token = createSession(user.id);
  setSessionCookie(res, token);
  res.json({ success: true, redirect: "/game", user: publicUser(user) });
});

app.post("/api/logout", requireAuth, (req, res) => {
  const cookies = parseCookies(req.headers.cookie || "");
  if (cookies.standoffx_session) sessions.delete(cookies.standoffx_session);
  req.user.status = false;
  saveUsers();
  clearSessionCookie(res);
  res.json({ success: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ success: true, user: publicUser(req.user) });
});

app.get("/api/user-data", requireAuth, (req, res) => {
  const target = findUser(req.query.id || req.user.id);
  if (!target) return res.status(404).json({ success: false, message: "Користувача не знайдено." });
  const friends = (target.friendsList || [])
    .map(id => users.find(u => u.id === id))
    .filter(Boolean)
    .map(publicUser);
  res.json({ success: true, user: publicUser(target), friends });
});

app.post("/api/sync-user", requireAuth, (req, res) => {
  const id = normalizeId(req.body.id || req.user.id);
  const target = users.find(u => u.id === id);
  if (!target) return res.status(404).json({ success: false });
  res.json({ success: true, user: publicUser(target) });
});

app.get("/api/get-my-friends", requireAuth, (req, res) => {
  const friends = (req.user.friendsList || [])
    .map(id => users.find(u => u.id === id))
    .filter(Boolean)
    .map(publicUser);
  res.json({ success: true, friends });
});

app.post("/api/search-user", requireAuth, (req, res) => {
  const query = cleanText(req.body.query, 80);
  const target = findUser(query);
  if (!target || target.id === req.user.id) {
    return res.status(404).json({ success: false, message: "Гравця не знайдено." });
  }
  res.json({
    success: true,
    user: {
      id: target.id,
      nickname: target.nickname,
      playerAvatar: target.playerAvatar,
      isVerified: target.isVerified
    }
  });
});

app.post("/api/friends/request", requireAuth, (req, res) => {
  const from = req.user;
  const to = users.find(u => u.id === normalizeId(req.body.toId));
  if (!to) return res.status(404).json({ success: false, message: "Гравця не знайдено." });
  if (to.id === from.id) return res.status(400).json({ success: false, message: "Не можна додати себе." });
  if ((from.blocked || []).includes(to.id) || (to.blocked || []).includes(from.id)) {
    return res.status(403).json({ success: false, message: "Користувач недоступний." });
  }
  if ((from.friendsList || []).includes(to.id)) {
    return res.status(400).json({ success: false, message: "Ви вже друзі." });
  }
  to.incomingRequests = to.incomingRequests || [];
  if (to.incomingRequests.includes(from.id)) {
    return res.status(400).json({ success: false, message: "Заявка вже відправлена." });
  }
  to.incomingRequests.push(from.id);
  saveUsers();
  res.json({ success: true });
});

app.post("/api/friends/incoming", requireAuth, (req, res) => {
  const incoming = (req.user.incomingRequests || [])
    .map(id => users.find(u => u.id === id))
    .filter(Boolean)
    .map(publicUser);
  res.json({ success: true, incoming });
});

app.post("/api/friends/accept", requireAuth, (req, res) => {
  const friend = users.find(u => u.id === normalizeId(req.body.friendId));
  if (!friend) return res.status(404).json({ success: false, message: "Гравця не знайдено." });
  if (!(req.user.incomingRequests || []).includes(friend.id)) {
    return res.status(400).json({ success: false, message: "Заявку не знайдено." });
  }

  req.user.friendsList = req.user.friendsList || [];
  friend.friendsList = friend.friendsList || [];
  if (!req.user.friendsList.includes(friend.id)) req.user.friendsList.push(friend.id);
  if (!friend.friendsList.includes(req.user.id)) friend.friendsList.push(req.user.id);
  req.user.incomingRequests = req.user.incomingRequests.filter(id => id !== friend.id);
  saveUsers();
  res.json({ success: true });
});

app.post("/api/friends/decline", requireAuth, (req, res) => {
  const friendId = normalizeId(req.body.friendId);
  req.user.incomingRequests = (req.user.incomingRequests || []).filter(id => id !== friendId);
  saveUsers();
  res.json({ success: true });
});

app.post("/api/friends/remove", requireAuth, (req, res) => {
  const friendId = normalizeId(req.body.friendId);
  const friend = users.find(u => u.id === friendId);
  req.user.friendsList = (req.user.friendsList || []).filter(id => id !== friendId);
  if (friend) friend.friendsList = (friend.friendsList || []).filter(id => id !== req.user.id);
  saveUsers();
  res.json({ success: true });
});

app.post("/api/friends/block", requireAuth, (req, res) => {
  const targetId = normalizeId(req.body.userId);
  if (targetId === req.user.id) return res.status(400).json({ success: false });
  req.user.blocked = Array.from(new Set([...(req.user.blocked || []), targetId]));
  req.user.friendsList = (req.user.friendsList || []).filter(id => id !== targetId);
  const target = users.find(u => u.id === targetId);
  if (target) target.friendsList = (target.friendsList || []).filter(id => id !== req.user.id);
  saveUsers();
  res.json({ success: true });
});

app.get("/api/clans", requireAuth, (_req, res) => {
  const list = Object.values(clans).map(c => ({
    ...c,
    members: users.filter(u => u.clan === c.tag).map(u => u.id)
  }));
  res.json({ success: true, clans: list });
});

app.post("/api/clans/search", requireAuth, (req, res) => {
  const q = cleanText(req.body.query, 40).toLowerCase();
  const result = Object.values(clans).filter(c =>
    c.name.toLowerCase().includes(q) || c.tag.toLowerCase().includes(q)
  ).map(c => ({
    ...c,
    members: users.filter(u => u.clan === c.tag).length
  }));
  res.json({ success: true, clans: result });
});

app.post("/api/clans/create", requireAuth, (req, res) => {
  if (req.user.clan) return res.status(400).json({ success: false, message: "Ти вже в клані." });
  if (req.user.gold < 500) return res.status(400).json({ success: false, message: "Потрібно 500 Gold." });

  const tag = cleanText(req.body.tag, 5).toUpperCase();
  const name = cleanText(req.body.name || tag, 24);
  if (!/^[A-Z0-9]{2,5}$/.test(tag)) {
    return res.status(400).json({ success: false, message: "Тег: 2–5 латинських символів/цифр." });
  }
  if (clans[tag]) return res.status(409).json({ success: false, message: "Такий тег вже зайнятий." });

  clans[tag] = {
    name,
    tag,
    ownerId: req.user.id,
    level: 1,
    xp: 0,
    createdAt: Date.now()
  };
  req.user.gold -= 500;
  req.user.clan = tag;
  saveClans();
  saveUsers();
  res.json({ success: true, clan: clans[tag], gold: req.user.gold });
});

app.post("/api/clans/my", requireAuth, (req, res) => {
  const clan = req.user.clan ? clans[req.user.clan] : null;
  if (!clan) return res.json({ success: true, clan: null, members: [] });

  const members = users.filter(u => u.clan === clan.tag).map(u => ({
    userId: u.id,
    nickname: u.nickname,
    playerAvatar: u.playerAvatar,
    role: u.id === clan.ownerId ? "owner" : "member"
  }));
  res.json({
    success: true,
    clan,
    members,
    myRole: req.user.id === clan.ownerId ? "owner" : "member"
  });
});

app.post("/api/clans/request", requireAuth, (req, res) => {
  const tag = cleanText(req.body.clanId || req.body.tag, 5).toUpperCase();
  const clan = clans[tag];
  if (!clan) return res.status(404).json({ success: false, message: "Клан не знайдено." });
  if (req.user.clan) return res.status(400).json({ success: false, message: "Спочатку вийди з поточного клану." });

  clan.requests = Array.isArray(clan.requests) ? clan.requests : [];
  if (!clan.requests.includes(req.user.id)) clan.requests.push(req.user.id);
  saveClans();
  res.json({ success: true });
});

app.post("/api/clans/requests", requireAuth, (req, res) => {
  if (!req.user.clan) return res.json({ success: true, requests: [] });
  const clan = clans[req.user.clan];
  if (!clan || clan.ownerId !== req.user.id) return res.status(403).json({ success: false });
  const requests = (clan.requests || [])
    .map(id => users.find(u => u.id === id))
    .filter(Boolean)
    .map(publicUser);
  res.json({ success: true, requests });
});

app.post("/api/clans/accept", requireAuth, (req, res) => {
  const clan = req.user.clan ? clans[req.user.clan] : null;
  if (!clan || clan.ownerId !== req.user.id) return res.status(403).json({ success: false });
  const targetId = normalizeId(req.body.userId);
  const target = users.find(u => u.id === targetId);
  if (!target || !(clan.requests || []).includes(targetId)) {
    return res.status(404).json({ success: false, message: "Заявку не знайдено." });
  }
  target.clan = clan.tag;
  clan.requests = clan.requests.filter(id => id !== targetId);
  saveUsers();
  saveClans();
  res.json({ success: true });
});

app.post("/api/clans/decline", requireAuth, (req, res) => {
  const clan = req.user.clan ? clans[req.user.clan] : null;
  if (!clan || clan.ownerId !== req.user.id) return res.status(403).json({ success: false });
  const targetId = normalizeId(req.body.userId);
  clan.requests = (clan.requests || []).filter(id => id !== targetId);
  saveClans();
  res.json({ success: true });
});

app.post("/api/clans/leave", requireAuth, (req, res) => {
  if (!req.user.clan) return res.json({ success: true });
  const clan = clans[req.user.clan];
  if (clan && clan.ownerId === req.user.id) {
    const members = users.filter(u => u.clan === clan.tag && u.id !== req.user.id);
    if (members.length) {
      clan.ownerId = members[0].id;
    } else {
      delete clans[clan.tag];
    }
  }
  req.user.clan = null;
  saveUsers();
  saveClans();
  res.json({ success: true });
});

app.get("/api/skins", requireAuth, (_req, res) => res.json({ success: true, skins }));

app.post("/api/inventory/my", requireAuth, (req, res) => {
  const ids = Array.isArray(inventory[req.user.id]) ? inventory[req.user.id] : [];
  res.json({
    success: true,
    inventory: ids.map(skinId => ({ skinId, ...(skins[skinId] || {}) })).filter(item => item.name)
  });
});

app.get("/api/market/items", requireAuth, (_req, res) => res.json({ success: true, items: market }));

app.post("/api/market/sell", requireAuth, (req, res) => {
  const skinId = cleanText(req.body.skinId, 64);
  const price = Number(req.body.price);
  const owned = Array.isArray(inventory[req.user.id]) && inventory[req.user.id].includes(skinId);
  if (!owned) return res.status(400).json({ success: false, message: "Цього предмета немає в інвентарі." });
  if (!Number.isFinite(price) || price <= 0 || price > 1000000) {
    return res.status(400).json({ success: false, message: "Некоректна ціна." });
  }

  inventory[req.user.id] = inventory[req.user.id].filter(id => id !== skinId);
  const lot = {
    lotId: crypto.randomBytes(8).toString("hex"),
    sellerId: req.user.id,
    sellerNick: req.user.nickname,
    skinId,
    skinName: skins[skinId]?.name || skinId,
    rarity: skins[skinId]?.rarity || "common",
    price,
    date: Date.now()
  };
  market.push(lot);
  saveInventory();
  saveMarket();
  res.json({ success: true, lot });
});

app.post("/api/market/buy", requireAuth, (req, res) => {
  const lotIndex = market.findIndex(l => String(l.lotId) === String(req.body.lotId));
  if (lotIndex === -1) return res.status(404).json({ success: false, message: "Лот уже продано або видалено." });
  const lot = market[lotIndex];
  if (lot.sellerId === req.user.id) return res.status(400).json({ success: false, message: "Не можна купити власний лот." });
  const price = Number(lot.price);
  if (req.user.gold < price) return res.status(400).json({ success: false, message: "Недостатньо Gold." });

  const seller = users.find(u => u.id === lot.sellerId);
  if (!seller) return res.status(404).json({ success: false, message: "Продавця не знайдено." });

  req.user.gold -= price;
  seller.gold += price;
  inventory[req.user.id] = Array.isArray(inventory[req.user.id]) ? inventory[req.user.id] : [];
  inventory[req.user.id].push(lot.skinId);
  market.splice(lotIndex, 1);
  saveUsers();
  saveInventory();
  saveMarket();
  res.json({ success: true, gold: req.user.gold, item: lot });
});

app.post("/api/use-promo", requireAuth, (req, res) => {
  const code = cleanText(req.body.code, 80);
  const valid = cleanText(process.env.STANDOFFX_PROMO_CODE || "SOFTERX-2024", 80);
  if (code !== valid) return res.status(400).json({ success: false, message: "Невірний промокод." });

  req.user.usedPromos = Array.isArray(req.user.usedPromos) ? req.user.usedPromos : [];
  if (req.user.usedPromos.includes(code)) {
    return res.status(400).json({ success: false, message: "Цей промокод уже використаний." });
  }

  req.user.usedPromos.push(code);
  req.user.gold += 1000;
  saveUsers();
  res.json({ success: true, gold: req.user.gold });
});

app.get("/api/chat/active-dialogs/:userId", requireAuth, (req, res) => {
  if (normalizeId(req.params.userId) !== req.user.id) return res.status(403).json({ success: false });
  const partnerIds = new Set();
  for (const room of Object.keys(messages)) {
    const ids = room.split("_");
    if (ids.includes(req.user.id)) ids.filter(id => id !== req.user.id).forEach(id => partnerIds.add(id));
  }
  const dialogs = users.filter(u => partnerIds.has(u.id)).map(publicUser);
  res.json(dialogs);
});

function chatRoom(a, b) {
  return [String(a), String(b)].sort().join("_");
}

function areFriends(a, b) {
  return (a.friendsList || []).includes(b.id) || a.id === b.id;
}

app.post("/api/upload-avatar", requireAuth, upload.single("avatar"), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "Немає коректного зображення." });
  req.user.playerAvatar = "/avatars/" + req.file.filename;
  saveUsers();
  res.json({ success: true, newPath: req.user.playerAvatar });
});

// ---------- MATCHMAKING / GAME ----------

const matchmakingQueue = [];
const activeMatches = new Map();
const MATCH_SIZE = 3;
const GAME_SECONDS = 300;
const WARMUP_SECONDS = 5;
const SPAWNS = [
  { x: 5, y: 0, z: 5 },
  { x: 25, y: 0, z: 25 },
  { x: 15, y: 0, z: 5 }
];

function removeFromQueue(userId) {
  const idx = matchmakingQueue.findIndex(p => p.userId === userId);
  if (idx !== -1) {
    matchmakingQueue.splice(idx, 1);
    return true;
  }
  return false;
}

function playerMatch(userId) {
  for (const match of activeMatches.values()) {
    if (match.players.some(p => p.userId === userId)) return match;
  }
  return null;
}

function emitQueueCount(io) {
  io.emit("queue_update", { count: matchmakingQueue.length });
}

function createMatch(io) {
  if (matchmakingQueue.length < MATCH_SIZE) return;
  const players = matchmakingQueue.splice(0, MATCH_SIZE);
  const matchId = "match_" + Date.now() + "_" + crypto.randomBytes(2).toString("hex");
  const hunterIndex = crypto.randomInt(0, players.length);

  const match = {
    id: matchId,
    map: players[0].map || "M3_Maze",
    players: players.map((p, i) => ({
      socketId: p.socketId,
      userId: p.userId,
      nickname: p.nickname,
      role: i === hunterIndex ? "hunter" : "runner",
      score: 0,
      spawn: { ...SPAWNS[i] },
      pos: { ...SPAWNS[i] },
      rotY: 0,
      anim: "Idle",
      lastMoveAt: 0
    })),
    started: false,
    finished: false,
    timer: null,
    phaseTimer: null,
    remaining: GAME_SECONDS
  };

  activeMatches.set(matchId, match);
  emitQueueCount(io);

  for (const p of match.players) {
    io.to(p.socketId).emit("match_found", {
      matchId,
      userId: p.userId,
      map: match.map
    });
  }
}

function cleanMatch(io, matchId, returnToMenu = true) {
  const match = activeMatches.get(matchId);
  if (!match) return;
  if (match.timer) clearInterval(match.timer);
  if (match.phaseTimer) clearInterval(match.phaseTimer);
  if (returnToMenu) io.to(matchId).emit("go_to_menu");
  activeMatches.delete(matchId);
}

function startMatchWhenReady(io, match) {
  if (match.started || match.players.some(p => !p.socketId)) return;
  match.started = true;

  let warmup = WARMUP_SECONDS;
  io.to(match.id).emit("match_phase", { phase: "warmup", time: warmup });
  match.phaseTimer = setInterval(() => {
    warmup -= 1;
    io.to(match.id).emit("timer_update", { time: warmup, phase: "warmup" });
    if (warmup <= 0) {
      clearInterval(match.phaseTimer);
      io.to(match.id).emit("match_start_now");
      match.remaining = GAME_SECONDS;
      match.timer = setInterval(() => {
        match.remaining -= 1;
        io.to(match.id).emit("timer_update", { time: match.remaining, phase: "game" });
        if (match.remaining <= 0) finishMatch(io, match.id);
      }, 1000);
    }
  }, 1000);
}

function finishMatch(io, matchId) {
  const match = activeMatches.get(matchId);
  if (!match || match.finished) return;
  match.finished = true;

  if (match.timer) clearInterval(match.timer);
  if (match.phaseTimer) clearInterval(match.phaseTimer);

  const ranked = [...match.players].sort((a, b) => b.score - a.score);
  const maxScore = ranked[0]?.score || 0;

  for (const p of match.players) {
    const user = users.find(u => u.id === p.userId);
    if (!user) continue;
    const goldReward = maxScore > 0 && p.score === maxScore ? 10 : 2;
    const xpReward = 50 + p.score * 20;
    user.gold += goldReward;
    user.XP += xpReward;
    io.to(p.socketId).emit("show_results", {
      xp: xpReward,
      gold: goldReward,
      score: p.score,
      msg: `Матч завершено. +${xpReward} XP / +${goldReward} Gold`
    });
  }
  saveUsers();

  setTimeout(() => cleanMatch(io, matchId, true), 7000);
}

function validateMove(player, data) {
  const now = Date.now();
  if (now - player.lastMoveAt < 33) return false;
  player.lastMoveAt = now;

  const x = Number(data.x), y = Number(data.y), z = Number(data.z), rotY = Number(data.rotY);
  if (![x, y, z, rotY].every(Number.isFinite)) return false;

  const prev = player.pos;
  const elapsed = Math.min(0.25, Math.max(0.033, (now - (player.prevMoveTime || now)) / 1000));
  player.prevMoveTime = now;

  const maxStep = Math.max(0.35, 18 * elapsed);
  const dx = x - prev.x;
  const dz = z - prev.z;
  const planarDistance = Math.hypot(dx, dz);

  if (planarDistance > maxStep) {
    const scale = maxStep / planarDistance;
    player.pos.x += dx * scale;
    player.pos.z += dz * scale;
  } else {
    player.pos.x = x;
    player.pos.z = z;
  }
  player.pos.y = Math.max(-2, Math.min(100, y));
  player.rotY = rotY;
  player.anim = ["Idle", "Running", "Jump", "Walking"].includes(data.anim) ? data.anim : "Idle";
  return true;
}

function handleCatch(io, match, hunter) {
  if (hunter.role !== "hunter") return;

  for (const target of match.players) {
    if (target.role !== "runner") continue;
    const dx = hunter.pos.x - target.pos.x;
    const dz = hunter.pos.z - target.pos.z;
    if (Math.hypot(dx, dz) > 2.2) continue;

    hunter.score += 1;
    for (const p of match.players) {
      p.role = p.userId === target.userId ? "hunter" : "runner";
      p.pos = { ...p.spawn };
      p.rotY = 0;
      p.anim = "Idle";
    }

    io.to(match.id).emit("roles_updated", {
      players: match.players.map(p => ({
        userId: p.userId,
        role: p.role,
        score: p.score,
        spawn: p.spawn
      })),
      message: `${hunter.nickname} спіймав ${target.nickname}! Тепер ${target.nickname} — мисливець.`
    });
    break;
  }
}

const createServer = () => {
  if (!SServer) return http.createServer(app);
  const keyPath = process.env.TLS_KEY_PATH || path.join(ROOT, "site.local-key.pem");
  const certPath = process.env.TLS_CERT_PATH || path.join(ROOT, "site.local.pem");
  return https.createServer({
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  }, app);
};

const server = createServer();
const io = new Server(server, {
  cors: { origin: true, credentials: true }
});

io.on("connection", socket => {
  const cookies = parseCookies(socket.handshake.headers.cookie || "");
  socket.user = sessionUserFromToken(cookies.standoffx_session);

  if (!socket.user) {
    socket.emit("auth_required");
    socket.disconnect(true);
    return;
  }

  socket.user.status = true;
  saveUsers();

  socket.on("start_search", data => {
    const user = socket.user;
    if (playerMatch(user.id)) return socket.emit("search_error", { message: "Ти вже в матчі." });
    if (matchmakingQueue.some(p => p.userId === user.id)) return;

    removeFromQueue(user.id);
    matchmakingQueue.push({
      socketId: socket.id,
      userId: user.id,
      nickname: user.nickname,
      map: cleanText(data?.map || "M3_Maze", 32)
    });

    socket.emit("search_started");
    emitQueueCount(io);
    createMatch(io);
  });

  socket.on("cancel_search", () => {
    if (removeFromQueue(socket.user.id)) emitQueueCount(io);
  });

  socket.on("join_room", data => {
    const matchId = cleanText(data?.matchId, 100);
    const match = activeMatches.get(matchId);
    if (!match) return socket.emit("kick_to_menu", { reason: "Матч не знайдено." });

    const player = match.players.find(p => p.userId === socket.user.id);
    if (!player) return socket.emit("kick_to_menu", { reason: "Гравця немає в цьому матчі." });

    player.socketId = socket.id;
    socket.join(matchId);

    const connected = match.players.filter(p => p.socketId).length;
    io.to(matchId).emit("match_waiting", {
      connected,
      required: match.players.length,
      players: match.players.map(p => ({ userId: p.userId, nickname: p.nickname, connected: Boolean(p.socketId) }))
    });

    socket.emit("init_match", {
      matchId,
      map: match.map,
      me: {
        userId: player.userId,
        nickname: player.nickname,
        role: player.role,
        score: player.score,
        spawn: player.spawn
      },
      players: match.players.map(p => ({
        userId: p.userId,
        nickname: p.nickname,
        role: p.role,
        score: p.score,
        x: p.pos.x,
        y: p.pos.y,
        z: p.pos.z,
        rotY: p.rotY,
        anim: p.anim
      }))
    });

    // Передаємо клієнту вже підключених суперників для миттєвого рендера.
    match.players.forEach(other => {
      if (other.userId !== player.userId && other.socketId) {
        socket.emit("enemy_moved", {
          id: other.socketId,
          userId: other.userId,
          nickname: other.nickname,
          role: other.role,
          x: other.pos.x,
          y: other.pos.y,
          z: other.pos.z,
          rotY: other.rotY,
          anim: other.anim,
          score: other.score
        });
      }
    });

    socket.to(matchId).emit("player_joined", {
      userId: player.userId,
      nickname: player.nickname,
      role: player.role,
      x: player.pos.x,
      y: player.pos.y,
      z: player.pos.z,
      rotY: player.rotY,
      anim: player.anim
    });

    const connectedNow = match.players.filter(p => p.socketId).length;
    io.to(matchId).emit("match_waiting", {
      connected: connectedNow,
      required: match.players.length,
      players: match.players.map(p => ({ userId: p.userId, nickname: p.nickname, connected: Boolean(p.socketId) }))
    });

    startMatchWhenReady(io, match);
  });

  socket.on("player_moved", data => {
    const match = activeMatches.get(cleanText(data?.matchId, 100));
    if (!match) return;
    const player = match.players.find(p => p.userId === socket.user.id);
    if (!player || player.socketId !== socket.id) return;
    if (!validateMove(player, data)) return;

    handleCatch(io, match, player);

    socket.to(match.id).emit("enemy_moved", {
      id: socket.id,
      userId: player.userId,
      nickname: player.nickname,
      role: player.role,
      x: player.pos.x,
      y: player.pos.y,
      z: player.pos.z,
      rotY: player.rotY,
      anim: player.anim,
      score: player.score
    });
  });

  socket.on("join_chat", ({ friendId } = {}) => {
    const user = socket.user;
    const friend = users.find(u => u.id === normalizeId(friendId));
    if (!friend || !areFriends(user, friend)) return socket.emit("chat_error", { message: "Можна писати лише друзям." });

    const room = chatRoom(user.id, friend.id);
    socket.join(room);
    socket.emit("chat_history", messages[room] || []);
  });

  socket.on("send_msg", ({ toId, text } = {}) => {
    const user = socket.user;
    const friend = users.find(u => u.id === normalizeId(toId));
    const body = cleanText(text, 1000);
    if (!friend || !body || !areFriends(user, friend)) return;

    const room = chatRoom(user.id, friend.id);
    const msg = {
      senderId: user.id,
      senderName: user.nickname,
      text: body,
      time: new Date().toISOString()
    };
    messages[room] = Array.isArray(messages[room]) ? messages[room] : [];
    messages[room].push(msg);
    if (messages[room].length > 200) messages[room].splice(0, messages[room].length - 200);
    saveMessages();
    io.to(room).emit("new_msg", msg);
  });

  socket.on("disconnect", () => {
    removeFromQueue(socket.user?.id);
    if (socket.user) {
      socket.user.status = false;
      saveUsers();
    }

    for (const [matchId, match] of activeMatches.entries()) {
      const p = match.players.find(x => x.socketId === socket.id);
      if (!p) continue;

      p.socketId = null;
      io.to(matchId).emit("player_left", { userId: p.userId });

      if (!match.started) {
        cleanMatch(io, matchId, true);
      }
    }
    emitQueueCount(io);
  });
});


app.get("/admin", requireAdmin, (_req, res) => {
  res.sendFile(path.join(ROOT, "admin.html"));
});

app.get("/api/admin/overview", requireAdmin, (_req, res) => {
  res.json({
    success: true,
    database: mongoDb ? "MongoDB Atlas" : "JSON",
    users: users.length,
    online: users.filter(u => u.status).length,
    clans: Object.keys(clans).length,
    market: market.length,
    messages: Object.values(messages).reduce((n, x) => n + (Array.isArray(x) ? x.length : 0), 0)
  });
});

app.get("/api/admin/users", requireAdmin, (_req, res) => {
  res.json({ success: true, users: users.map(publicUser) });
});

app.post("/api/admin/users/update", requireAdmin, (req, res) => {
  const u = findUser(req.body.userId);
  if (!u) return res.status(404).json({ success: false, message: "User not found" });
  if (u.id !== ADMIN_ID) {
    if (req.body.gold != null) u.gold = Math.max(0, Number(req.body.gold) || 0);
    if (req.body.XP != null) u.XP = Math.max(0, Number(req.body.XP) || 0);
    if (req.body.isBanned != null) u.isBanned = Boolean(req.body.isBanned);
    if (req.body.isAdmin != null) u.isAdmin = Boolean(req.body.isAdmin);
  }
  u.isAdmin = u.id === ADMIN_ID ? true : Boolean(u.isAdmin);
  saveUsers();
  res.json({ success: true, user: publicUser(u) });
});

app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  if (req.params.id === ADMIN_ID) return res.status(400).json({ success: false, message: "Master account cannot be deleted." });
  const i = users.findIndex(u => u.id === req.params.id);
  if (i < 0) return res.status(404).json({ success: false, message: "User not found" });
  users.splice(i, 1);
  delete inventory[req.params.id];
  saveUsers(); saveInventory();
  res.json({ success: true });
});

app.get("/api/admin/database", requireAdmin, (_req, res) => {
  res.json({ success: true, storage: mongoDb ? "MongoDB Atlas" : "JSON", users: users.map(publicUser), clans, messages, inventory, market });
});

app.post("/api/admin/save", requireAdmin, (_req, res) => {
  saveUsers(); saveClans(); saveMessages(); saveInventory(); saveMarket();
  res.json({ success: true, storage: mongoDb ? "MongoDB Atlas" : "JSON" });
});


app.get("/admin", requireAdmin, (_req, res) => {
  res.sendFile(path.join(ROOT, "admin.html"));
});

app.get("/api/admin/overview", requireAdmin, (_req, res) => {
  res.json({
    success: true,
    storage: mongoDb ? "MongoDB Atlas" : "JSON fallback",
    users: users.length,
    online: users.filter(u => u.status).length,
    clans: Object.keys(clans).length,
    market: market.length
  });
});

app.get("/api/admin/users", requireAdmin, (_req, res) => {
  res.json({ success: true, users: users.map(publicUser) });
});

app.post("/api/admin/users/update", requireAdmin, (req, res) => {
  const u = findUser(req.body.userId);
  if (!u) return res.status(404).json({ success: false, message: "User not found" });
  if (u.id === ADMIN_ID) {
    u.isAdmin = true;
    u.isBanned = false;
  } else {
    if (req.body.gold !== undefined) u.gold = Math.max(0, Number(req.body.gold) || 0);
    if (req.body.XP !== undefined) u.XP = Math.max(0, Number(req.body.XP) || 0);
    if (req.body.isBanned !== undefined) u.isBanned = Boolean(req.body.isBanned);
    if (req.body.isAdmin !== undefined) u.isAdmin = Boolean(req.body.isAdmin);
  }
  saveUsers();
  res.json({ success: true, user: publicUser(u) });
});

app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  const id = normalizeId(req.params.id);
  if (id === ADMIN_ID) return res.status(400).json({ success: false, message: "Master account cannot be deleted." });
  const i = users.findIndex(u => u.id === id);
  if (i < 0) return res.status(404).json({ success: false, message: "User not found" });
  users.splice(i, 1);
  delete inventory[id];
  saveUsers();
  saveInventory();
  res.json({ success: true });
});

app.get("/api/admin/database", requireAdmin, (_req, res) => {
  res.json({ success: true, storage: mongoDb ? "MongoDB Atlas" : "JSON fallback", users: users.map(publicUser), clans, messages, inventory, market });
});

app.use((err, _req, res, _next) => {
  console.error("[HTTP]", err);
  if (err instanceof multer.MulterError || err?.message === "Дозволені тільки зображення") {
    return res.status(400).json({ success: false, message: err.message || "Файл відхилено." });
  }
  res.status(500).json({ success: false, message: "Внутрішня помилка сервера." });
});

async function bootstrap() {
  await initMongo();
  server.listen(PORT, () => {
    console.log("====================================");
    console.log(" StandoffX server");
    console.log(` HTTP : ${SServer ? "HTTPS" : "HTTP"}`);
    console.log(` PORT : ${PORT}`);
    console.log(` DB   : ${mongoDb ? "MongoDB" : "JSON"}`);
    console.log("====================================");
  });
}
bootstrap().catch(err => { console.error("[BOOT]", err); process.exit(1); });
