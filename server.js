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
const ADMIN_ID = String(process.env.ADMIN_ID || "Dev_01").trim() || "Dev_01";
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
if (!ADMIN_PASSWORD) console.warn("[AUTH] ADMIN_PASSWORD is not set; master account login is disabled.");


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
let mongoConnecting = false;
const mongoStatus = {
  provider: "MongoDB Atlas",
  configured: Boolean(process.env.MONGODB_URI || process.env.MONGO_URI),
  connected: false,
  state: (process.env.MONGODB_URI || process.env.MONGO_URI) ? "connecting" : "not_configured",
  database: process.env.MONGODB_DB || "standoffx",
  lastError: null,
  connectedAt: null,
  lastCheckAt: null
};

function publicMongoStatus() {
  return {
    provider: mongoStatus.provider,
    configured: mongoStatus.configured,
    connected: Boolean(mongoDb && mongoStatus.connected),
    state: mongoStatus.state,
    database: mongoStatus.database,
    lastError: mongoStatus.lastError,
    connectedAt: mongoStatus.connectedAt,
    lastCheckAt: mongoStatus.lastCheckAt
  };
}

async function checkMongoConnection() {
  mongoStatus.lastCheckAt = new Date().toISOString();
  if (!mongoDb && mongoStatus.configured) {
    await initMongo();
  }
  if (!mongoDb) {
    mongoStatus.connected = false;
    return { ok: false, status: publicMongoStatus(), message: mongoStatus.configured
      ? (mongoStatus.lastError || "Atlas is not connected.")
      : "MONGODB_URI is not configured." };
  }
  try {
    await mongoDb.command({ ping: 1 });
    mongoStatus.connected = true;
    mongoStatus.state = "connected";
    mongoStatus.lastError = null;
    return { ok: true, status: publicMongoStatus(), message: "MongoDB Atlas ping succeeded." };
  } catch (err) {
    const failedClient = mongoClient;
    mongoClient = null;
    mongoDb = null;
    mongoStatus.connected = false;
    mongoStatus.state = "error";
    mongoStatus.lastError = cleanText(err.message, 240);
    try { await failedClient?.close(); } catch {}
    return { ok: false, status: publicMongoStatus(), message: mongoStatus.lastError };
  }
}

async function initMongo() {
  if (mongoConnecting) return false;
  mongoConnecting = true;
  mongoStatus.lastCheckAt = new Date().toISOString();
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  mongoStatus.configured = Boolean(uri);
  mongoStatus.database = process.env.MONGODB_DB || "standoffx";
  if (!uri) {
    mongoStatus.connected = false;
    mongoStatus.state = "not_configured";
    mongoStatus.lastError = "MONGODB_URI/MONGO_URI is missing; JSON fallback is active.";
    console.warn("[DB] MongoDB Atlas is NOT configured. Set MONGODB_URI in Render Environment.");
    mongoConnecting = false;
    return false;
  }
  mongoStatus.state = "connecting";
  mongoStatus.lastError = null;
  try {
    const atlasTlsRequired = /^mongodb\+srv:\/\//i.test(uri) || /\.mongodb\.net(?:[:/?]|$)/i.test(uri);
    const client = new MongoClient(uri, { ...(atlasTlsRequired ? { tls: true } : {}), serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000, maxPoolSize: 5, appName: "StandoffX" });
    mongoClient = client;
    client.on("close", () => {
      // Do not let an old client's close event clear a newer connection.
      if (mongoClient !== client) return;
      mongoClient = null;
      mongoDb = null;
      mongoStatus.connected = false;
      if (mongoStatus.state === "connected") mongoStatus.state = "disconnected";
      console.warn("[DB] MongoDB connection closed.");
    });
    await client.connect();
    if (mongoClient !== client) throw new Error("MongoDB client closed during connection.");
    mongoDb = client.db(mongoStatus.database);
    await mongoDb.command({ ping: 1 });
    mongoStatus.connected = true;
    mongoStatus.state = "connected";
    mongoStatus.connectedAt = new Date().toISOString();
    mongoStatus.lastCheckAt = mongoStatus.connectedAt;
    const load = async (name, fallback) => {
      const doc = await mongoDb.collection(name).findOne({ _id: "main" });
      return doc && doc.data !== undefined ? doc.data : fallback;
    };
    const localUsersSnapshot = users.map(user => ({ ...user }));
    const atlasUsers = await load("state_users", localUsersSnapshot);
    if (Array.isArray(atlasUsers)) {
      const keyOf = user => String(normalizeId(user?.id || "")).toLowerCase();
      const localById = new Map(localUsersSnapshot.map(user => [keyOf(user), user]).filter(([key]) => key));
      const localByUuid = new Map(localUsersSnapshot.filter(user => user?.uuid).map(user => [String(user.uuid), user]));
      const matchedLocalUsers = new Set();
      const mergedUsers = atlasUsers.filter(user => user && typeof user === "object" && !Array.isArray(user)).map(atlasUser => {
        const localUser = localById.get(keyOf(atlasUser)) || localByUuid.get(String(atlasUser.uuid || ""));
        if (localUser) matchedLocalUsers.add(localUser);
        return { ...(localUser || {}), ...atlasUser };
      });
      for (const localUser of localUsersSnapshot) {
        if (!matchedLocalUsers.has(localUser) && !mergedUsers.some(user => keyOf(user) && keyOf(user) === keyOf(localUser))) mergedUsers.push(localUser);
      }
      users = mergedUsers;
      for (const user of users) ensureUserShape(user);
      migratePlayerIds();
      saveUsers();
    }

    const atlasClans = await load("state_clans", clans);
    if (atlasClans && typeof atlasClans === "object" && !Array.isArray(atlasClans)) {
      clans = normalizeClanState(atlasClans);
    }

    const atlasMessages = await load("state_messages", messages);
    if (atlasMessages && typeof atlasMessages === "object" && !Array.isArray(atlasMessages)) messages = atlasMessages;

    const atlasInventory = await load("state_inventory", inventory);
    if (atlasInventory && typeof atlasInventory === "object" && !Array.isArray(atlasInventory)) inventory = atlasInventory;

    const atlasMarket = await load("state_market", market);
    if (Array.isArray(atlasMarket)) market = atlasMarket.filter(lot => lot && typeof lot === "object" && !Array.isArray(lot));

    for (const user of users) {
      ensureUserShape(user);
      if (user.clan && !clans[user.clan]) user.clan = null;
    }
    migratePlayerIds();
    saveUsers();
    saveClans();
    console.log("[DB] MongoDB Atlas connected:", mongoStatus.database);
    mongoConnecting = false;
    return true;
  } catch (err) {
    const failedClient = mongoClient;
    mongoClient = null;
    mongoDb = null;
    mongoStatus.connected = false;
    mongoStatus.state = "error";
    mongoStatus.lastError = cleanText(err.message, 240);
    try { await failedClient?.close(); } catch {}
    console.error("[DB] MongoDB Atlas connection failed:", mongoStatus.lastError);
    mongoConnecting = false;
    return false;
  }
}

const mongoReconnectTimer = setInterval(() => {
  if (!mongoStatus.configured || mongoDb || mongoConnecting) return;
  console.warn("[DB] Atlas is disconnected; retrying connection.");
  void initMongo();
}, 30000);
mongoReconnectTimer.unref?.();

function mongoSave(name, data) {
  if (!mongoDb) return;
  mongoDb.collection(name).replaceOne(
    { _id: "main" },
    { _id: "main", data },
    { upsert: true }
  ).catch(err => {
    mongoStatus.lastError = cleanText(err.message, 240);
    if (err.name === "MongoNetworkError" || err.name === "MongoServerSelectionError") {
      const failedClient = mongoClient;
      mongoClient = null;
      mongoDb = null;
      mongoStatus.connected = false;
      mongoStatus.state = "error";
      try { failedClient?.close().catch(() => {}); } catch {}
    }
    console.error("[DB] Write failed:", mongoStatus.lastError);
  });
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
  const q = cleanText(value, 80);
  if (/^ID_\d+$/i.test(q)) return q.slice(3);
  return q;
}

function displayId(id) {
  return normalizeId(id);
}

function playerIdExists(id) {
  const key = normalizeId(id).toLowerCase();
  return users.some(user => normalizeId(user.id).toLowerCase() === key);
}

function newPlayerId() {
  let id;
  do { id = String(crypto.randomInt(1000000, 10000000)); }
  while (id.toLowerCase() === ADMIN_ID.toLowerCase() || playerIdExists(id));
  return id;
}

function migratePlayerIds() {
  const seen = new Set();
  const ordered = [...users].sort((a, b) => Number(b.id === ADMIN_ID) - Number(a.id === ADMIN_ID));
  for (const user of ordered) {
    let id = normalizeId(user.id);
    if (!id || seen.has(id.toLowerCase()) || (id.toLowerCase() === ADMIN_ID.toLowerCase() && id !== ADMIN_ID)) {
      id = newPlayerId();
    }
    while (seen.has(id.toLowerCase())) id = newPlayerId();
    user.id = id;
    seen.add(id.toLowerCase());
  }
}

function findUser(idOrNickname, options = {}) {
  const q = normalizeId(idOrNickname);
  const qLower = q.toLowerCase();

  return users.find(u => {
    const uid = normalizeId(u.id).toLowerCase();
    if (uid === qLower) return true;
    return options.allowNickname !== false && String(u.nickname || "").toLowerCase() === qLower;
  });
}

function publicUser(user, options = {}) {
  if (!user) return null;
  const { password, passwordHash, uuid, messages: privateMessages, friendRequests, ...safe } = user;
  if (options.includeUuid === true && typeof uuid === "string") safe.uuid = uuid;
  safe.friendsList = Array.isArray(user.friendsList) ? user.friendsList : [];
  safe.incomingRequests = Array.isArray(user.incomingRequests) ? user.incomingRequests : [];
  safe.blocked = Array.isArray(user.blocked) ? user.blocked : [];
  safe.usedPromos = Array.isArray(user.usedPromos) ? user.usedPromos : [];
  return safe;
}

function ensureUserShape(user) {
  user.nickname = cleanText(user.nickname, 24);
  user.id = normalizeId(user.id);
  if (typeof user.uuid !== "string" || !/^[0-9a-f-]{36}$/i.test(user.uuid) || users.some(other => other !== user && other.uuid === user.uuid)) {
    do { user.uuid = crypto.randomUUID(); }
    while (users.some(other => other !== user && other.uuid === user.uuid));
  }
  if (!Array.isArray(user.friendsList)) user.friendsList = [];
  if (!Array.isArray(user.incomingRequests)) user.incomingRequests = [];
  if (!Array.isArray(user.blocked)) user.blocked = [];
  if (!Array.isArray(user.usedPromos)) user.usedPromos = [];
  user.XP = Number(user.XP) || 0;
  user.gold = Number(user.gold) || 0;
  user.MMRCompetitive = Number(user.MMRCompetitive) || 1000;
  user.MMRAllies = Number(user.MMRAllies) || 1000;
  user.status = Boolean(user.status);
  user.clan = user.clan ? cleanText(user.clan, 5).toUpperCase() : null;
  user.isVerified = Boolean(user.isVerified);
  user.isBanned = user.id === ADMIN_ID ? false : Boolean(user.isBanned);
  user.isAdmin = user.id === ADMIN_ID ? true : Boolean(user.isAdmin);
  user.isTester = user.id === ADMIN_ID ? true : Boolean(user.isTester);
}

function normalizeClanState(rawClans) {
  const source = rawClans && typeof rawClans === "object" && !Array.isArray(rawClans) ? rawClans : {};
  const normalized = {};
  for (const [key, raw] of Object.entries(source)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const tag = cleanText(raw.tag || key, 5).toUpperCase();
    if (!/^[A-Z0-9]{2,5}$/.test(tag)) continue;
    normalized[tag] = {
      ...raw,
      id: cleanText(raw.id || tag, 40),
      name: cleanText(raw.name || tag, 24),
      tag,
      ownerId: normalizeId(raw.ownerId || raw.owner || ""),
      description: cleanText(raw.description || "", 120),
      level: Math.max(1, Number(raw.level) || 1),
      xp: Math.max(0, Number(raw.xp) || 0),
      memberLimit: Math.max(5, Math.min(50, Number(raw.memberLimit) || 30)),
      officers: Array.isArray(raw.officers) ? [...new Set(raw.officers.map(normalizeId).filter(Boolean))] : [],
      requests: Array.isArray(raw.requests) ? [...new Set(raw.requests.map(normalizeId).filter(Boolean))] : [],
      avatar: cleanText(raw.avatar || "/avatars/default.jpg", 240)
    };
  }
  return normalized;
}

for (const user of users) ensureUserShape(user);
migratePlayerIds();
saveUsers();

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
clans = normalizeClanState(clans);
for (const user of users) {
  if (user.clan && !clans[user.clan]) user.clan = null;
}

saveClans();

const sessions = new Map();

function parseCookies(header = "") {
  const out = {};
  for (const item of header.split(";")) {
    const idx = item.indexOf("=");
    if (idx <= 0) continue;
    const key = item.slice(0, idx).trim();
    let value = item.slice(idx + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function sessionTokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  sessions.set(token, { userId, createdAt: now, expiresAt });

  // Keep only token hashes in the durable account record. This lets the HttpOnly
  // cookie remain valid when Render restarts the Node process and clears memory.
  const user = users.find(candidate => candidate.uuid === userId || candidate.id === userId);
  if (user) {
    const tokenHash = sessionTokenHash(token);
    const existing = Array.isArray(user.authSessions) ? user.authSessions : [];
    user.authSessions = [
      ...existing.filter(session => session && Number.isFinite(session.expiresAt) && session.expiresAt > now),
      { tokenHash, createdAt: now, expiresAt }
    ].slice(-10);
    saveUsers();
  }
  return token;
}

function sessionUserFromToken(token) {
  if (!token) return null;
  let data = sessions.get(token);
  if (!data) {
    // Socket.IO and HTTP share this path; restore a session from the saved user
    // snapshot/MongoDB Atlas after a cold start instead of forcing another login.
    const tokenHash = sessionTokenHash(token);
    const now = Date.now();
    const user = users.find(candidate => Array.isArray(candidate.authSessions) &&
      candidate.authSessions.some(session => session?.tokenHash === tokenHash &&
        Number.isFinite(session.expiresAt) && session.expiresAt > now));
    if (!user) return null;
    const stored = user.authSessions.find(session => session?.tokenHash === tokenHash);
    data = { userId: user.uuid || user.id, createdAt: stored.createdAt, expiresAt: stored.expiresAt };
    sessions.set(token, data);
    return user;
  }
  if (!Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  const user = users.find(u => u.uuid === data.userId) || users.find(u => u.id === data.userId);
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
  next();
}

function isAdmin(user) {
  return Boolean(user && (user.id === ADMIN_ID || user.isAdmin === true));
}

function requireAdmin(req, res, next) {
  const user = requestUser(req);
  if (!user) return res.status(401).json({ success: false, message: "Авторизація потрібна." });
  if (user.isBanned && user.id !== ADMIN_ID) return res.status(403).json({ success: false, message: "Акаунт заблоковано." });
  if (!isAdmin(user)) return res.status(403).json({ success: false, message: "Тільки адміністратор." });
  req.user = user;
  next();
}

function setSessionCookie(res, token) {
  const secureFlag = process.env.NODE_ENV === "production" || process.env.RENDER ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `standoffx_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
}

function clearSessionCookie(res) {
  const secureFlag = process.env.NODE_ENV === "production" || process.env.RENDER ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `standoffx_session=; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=0`
  );
}

app.disable("x-powered-by");
app.set("trust proxy", process.env.RENDER ? 1 : false);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

// Never expose server code, account JSON, database snapshots, or admin/menu HTML via static hosting.
const BLOCKED_STATIC_DIRS = new Set([".git", ".github", "node_modules", "scripts", "data"]);
const PROTECTED_STATIC_PAGES = new Set(["admin.html", "mainmenu.html"]);
app.use((req, res, next) => {
  let pathname = req.path;
  try {
    // Decode repeatedly so double-encoded filenames cannot bypass the static-file guard.
    for (let i = 0; i < 4; i += 1) {
      const decoded = decodeURIComponent(pathname);
      if (decoded === pathname) break;
      pathname = decoded;
    }
    if (/%[0-9a-f]{2}/i.test(pathname)) return res.status(400).end();
  } catch {
    return res.status(400).end();
  }
  const normalized = path.posix.normalize("/" + pathname.replace(/\\/g, "/")).replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  const rootName = (segments[0] || "").toLowerCase();
  const privateRootFile = segments.length === 1 && /\.(?:json|js|md|lock|ya?ml|env)$/i.test(rootName);
  const blockedDirectory = segments.some(segment => BLOCKED_STATIC_DIRS.has(segment.toLowerCase()));
  const protectedPage = segments.length === 1 && PROTECTED_STATIC_PAGES.has(rootName);
  if (privateRootFile || blockedDirectory || protectedPage) return res.status(404).end();
  next();
});
app.use(express.static(ROOT, { index: false, dotfiles: "deny" }));

const rateLimitBuckets = new Map();
function createRateLimit({ windowMs, max, message }) {
  return (req, res, next) => {
    const now = Date.now();
    const identity = String(req.ip || req.socket?.remoteAddress || "unknown");
    const key = identity + ":" + req.method + ":" + req.path;
    let bucket = rateLimitBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateLimitBuckets.set(key, bucket);
    }
    bucket.count += 1;

    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, max - bucket.count)));
    res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

    if (rateLimitBuckets.size > 1000) {
      for (const [bucketKey, value] of rateLimitBuckets) {
        if (value.resetAt <= now) rateLimitBuckets.delete(bucketKey);
      }
    }
    while (rateLimitBuckets.size > 5000) {
      rateLimitBuckets.delete(rateLimitBuckets.keys().next().value);
    }

    if (bucket.count > max) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return res.status(429).json({ success: false, message });
    }
    next();
  };
}
const loginRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Забагато спроб входу. Спробуй пізніше."
});
const registrationRateLimit = createRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 6,
  message: "Забагато реєстрацій із цієї адреси. Спробуй пізніше."
});
const transactionRateLimit = createRateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: "Забагато запитів. Спробуй трохи пізніше."
});
app.use("/avatars", express.static(AVATARS_DIR, { maxAge: "1d" }));

const IMAGE_EXTENSIONS = Object.freeze({
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif"
});
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AVATARS_DIR),
  filename: (_req, file, cb) => {
    const extension = IMAGE_EXTENSIONS[file.mimetype];
    if (!extension) return cb(new Error("Дозволені тільки зображення"));
    cb(null, `${Date.now()}-${crypto.randomBytes(3).toString("hex")}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!IMAGE_EXTENSIONS[file.mimetype]) return cb(new Error("Дозволені тільки зображення"));
    cb(null, true);
  }
});

app.get("/", (_req, res) => res.sendFile(path.join(ROOT, "auth.html")));
app.get("/game", (req, res) => {
  const user = requestUser(req);
  if (!user || (user.isBanned && user.id !== ADMIN_ID)) return res.redirect("/");
  res.sendFile(path.join(ROOT, "mainMenu.html"));
});

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    game: "StandoffX",
    version: "0.4.0",
    uptimeSeconds: Math.round(process.uptime()),
    database: mongoDb ? "MongoDB Atlas" : "JSON fallback",
    atlas: publicMongoStatus(),
    matchmaking: { queued: matchmakingQueue.length, activeMatches: activeMatches.size }
  });
});

app.post("/api/register", registrationRateLimit, (req, res) => {
  const nickname = cleanText(req.body.nickname, 24);
  const password = String(req.body.password || "");

  if (!/^[\p{L}\p{N}_-]{3,24}$/u.test(nickname)) {
    return res.status(400).json({ success: false, message: "Нік: 3–24 символи, літери/цифри/_/-." });
  }
  if (password.length < 6 || password.length > 128) {
    return res.status(400).json({ success: false, message: "Пароль має містити 6–128 символів." });
  }
  // Nicknames are display names and intentionally do not need to be unique.
  const id = newPlayerId();

  const user = {
    nickname,
    id,
    uuid: crypto.randomUUID(),
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
    isTester: false,
    friendsList: [],
    incomingRequests: [],
    blocked: [],
    usedPromos: []
  };

  users.push(user);
  inventory[user.id] = inventory[user.id] || [];
  ensureUserShape(user);
  saveUsers();
  saveInventory();

  const token = createSession(user.uuid || user.id);
  setSessionCookie(res, token);
  res.json({
    success: true,
    redirect: "/game",
    user: publicUser(user, { includeUuid: true }),
    createdId: user.id,
    message: "Акаунт створено."
  });
});

app.post("/api/login", loginRateLimit, (req, res) => {
  const id = normalizeId(req.body.id || req.body.userId || req.body.uuid || "");
  const password = String(req.body.password || "");

  if (!id) {
    return res.status(400).json({ success: false, message: "Введи свій ID." });
  }
  if (!password) {
    return res.status(400).json({ success: false, message: "Введи пароль." });
  }

  let user = null;
  if (id === ADMIN_ID) {
    if (!ADMIN_PASSWORD) {
      return res.status(503).json({
        success: false,
        message: "Вхід master-акаунта вимкнено: задай ADMIN_PASSWORD у Render Environment."
      });
    }
    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, message: "Невірний ID або пароль." });
    }

    user = findUser(id, { allowNickname: false }) || { id: ADMIN_ID, nickname: "SofterX" };
    user.id = ADMIN_ID;
    user.nickname = user.nickname || "SofterX";
    user.isAdmin = true;
    user.isTester = true;
    user.isBanned = false;
    user.passwordHash = hashPassword(ADMIN_PASSWORD);
    ensureUserShape(user);
    if (!users.some(u => u.id === ADMIN_ID)) users.push(user);
    saveUsers();
  } else {
    // UUID is the stable, globally unique identity; Player ID remains a shorter public identifier.
    user = users.find(candidate => candidate.uuid === id) || findUser(id, { allowNickname: false });
  }

  if (!user || !verifyPassword(password, user.passwordHash || user.password)) {
    return res.status(401).json({ success: false, message: "Невірний ID або пароль." });
  }
  if (user.isBanned && user.id !== ADMIN_ID) {
    return res.status(403).json({ success: false, message: "Акаунт заблоковано." });
  }

  if (!user.passwordHash) {
    user.passwordHash = hashPassword(password);
    delete user.password;
  }

  user.status = true;
  ensureUserShape(user);
  saveUsers();

  const token = createSession(user.uuid || user.id);
  setSessionCookie(res, token);
  res.json({ success: true, redirect: "/game", user: publicUser(user, { includeUuid: true }) });
});

app.post("/api/logout", requireAuth, (req, res) => {
  const cookies = parseCookies(req.headers.cookie || "");
  if (cookies.standoffx_session) {
    sessions.delete(cookies.standoffx_session);
    const tokenHash = sessionTokenHash(cookies.standoffx_session);
    req.user.authSessions = (Array.isArray(req.user.authSessions) ? req.user.authSessions : [])
      .filter(session => session?.tokenHash !== tokenHash);
  }
  req.user.status = false;
  saveUsers();
  clearSessionCookie(res);
  res.json({ success: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ success: true, user: publicUser(req.user, { includeUuid: true }) });
});

app.post("/api/settings/keybinds", requireAuth, (req, res) => {
  const allowedActions = new Set(["spawnBot", "removeBot", "push", "kick", "boost", "resetBot", "resetSession", "menu"]);
  const incoming = req.body?.keybinds && typeof req.body.keybinds === "object" ? req.body.keybinds : {};
  const current = req.user.settings && typeof req.user.settings === "object" ? req.user.settings : {};
  const keybinds = { ...(current.keybinds || {}) };
  for (const [action, code] of Object.entries(incoming)) {
    if (!allowedActions.has(action) || typeof code !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(code)) continue;
    keybinds[action] = code;
  }
  req.user.settings = { ...current, keybinds };
  saveUsers();
  res.json({ success: true, keybinds });
});

app.get("/api/user-data", requireAuth, (req, res) => {
  const target = findUser(req.query.id || req.user.id);
  if (!target) return res.status(404).json({ success: false, message: "Користувача не знайдено." });
  const friends = (target.friendsList || [])
    .map(id => users.find(u => u.id === id))
    .filter(Boolean)
    .map(publicUser);
  res.json({ success: true, user: publicUser(target, { includeUuid: target.id === req.user.id }), friends });
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

app.post("/api/friends/request", transactionRateLimit, requireAuth, (req, res) => {
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
  const list = Object.values(clans).map(c => {
    const members = users.filter(u => u.clan === c.tag);
    return {
      ...c, avatar: c.avatar || "/avatars/default.jpg",
      members: members.map(u => ({ userId: u.id, nickname: u.nickname, playerAvatar: u.playerAvatar || "/avatars/default.jpg", isVerified: Boolean(u.isVerified), online: Boolean(u.status) })),
      memberCount: members.length
    };
  });
  res.json({ success: true, clans: list });
});

app.get("/api/clans/:tag", requireAuth, (req, res) => {
  const tag = cleanText(req.params.tag, 5).toUpperCase();
  const clan = clans[tag];
  if (!clan) return res.status(404).json({ success: false, message: "Клан не знайдено." });
  const members = users.filter(user => user.clan === clan.tag).map(user => ({
    userId: user.id, nickname: user.nickname, playerAvatar: user.playerAvatar || "/avatars/default.jpg",
    isVerified: Boolean(user.isVerified), online: Boolean(user.status),
    role: user.id === clan.ownerId ? "owner" : (clan.officers || []).includes(user.id) ? "officer" : "member"
  }));
  res.json({ success: true, clan: { ...clan, avatar: clan.avatar || "/avatars/default.jpg", memberCount: members.length }, members });
});

app.post("/api/clans/search", requireAuth, (req, res) => {
  const q = cleanText(req.body.query, 40).toLowerCase();
  const result = Object.values(clans).filter(c =>
    c.name.toLowerCase().includes(q) ||
    c.tag.toLowerCase().includes(q) ||
    String(c.description || "").toLowerCase().includes(q)
  ).map(c => {
    const members = users.filter(u => u.clan === c.tag);
    return { ...c, avatar: c.avatar || "/avatars/default.jpg",
      members: members.map(u => ({ userId: u.id, nickname: u.nickname, playerAvatar: u.playerAvatar || "/avatars/default.jpg", isVerified: Boolean(u.isVerified), online: Boolean(u.status), role: u.id === c.ownerId ? "owner" : (c.officers || []).includes(u.id) ? "officer" : "member" })),
      memberCount: members.length, isFull: members.length >= c.memberLimit };
  });
  res.json({ success: true, clans: result });
});

app.post("/api/clans/create", transactionRateLimit, requireAuth, (req, res) => {
  if (req.user.clan) return res.status(400).json({ success: false, message: "Ти вже в клані." });
  if (req.user.gold < 500) return res.status(400).json({ success: false, message: "Потрібно 500 Gold." });

  const tag = cleanText(req.body.tag, 5).toUpperCase();
  const name = cleanText(req.body.name || tag, 24);
  const description = cleanText(req.body.description || "", 120);

  if (!/^[A-Z0-9]{2,5}$/.test(tag)) {
    return res.status(400).json({ success: false, message: "Тег: 2–5 латинських символів/цифр." });
  }
  if (!/^[\p{L}\p{N} _-]{3,24}$/u.test(name)) {
    return res.status(400).json({ success: false, message: "Назва клану: 3–24 символи." });
  }
  if (clans[tag]) return res.status(409).json({ success: false, message: "Такий тег вже зайнятий." });

  clans[tag] = {
    id: tag,
    name,
    tag,
    description,
    ownerId: req.user.id,
    officers: [],
    requests: [],
    avatar: "/avatars/default.jpg",
    level: 1,
    xp: 0,
    memberLimit: 30,
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

  const members = users
    .filter(u => u.clan === clan.tag)
    .map(u => ({
      userId: u.id,
      nickname: u.nickname,
      playerAvatar: u.playerAvatar,
      role: u.id === clan.ownerId ? "owner" : (clan.officers || []).includes(u.id) ? "officer" : "member",
      online: Boolean(u.status)
    }));

  res.json({
    success: true,
    clan: {
      ...clan,
      memberCount: members.length,
      isFull: members.length >= clan.memberLimit
    },
    members,
    myRole: req.user.id === clan.ownerId ? "owner" : (clan.officers || []).includes(req.user.id) ? "officer" : "member"
  });
});

app.post("/api/clans/update", transactionRateLimit, requireAuth, (req, res) => {
  const clan = req.user.clan ? clans[req.user.clan] : null;
  if (!clan || clan.ownerId !== req.user.id) {
    return res.status(403).json({ success: false, message: "Редагувати клан може лише власник." });
  }

  const name = cleanText(req.body.name ?? clan.name, 24);
  const description = cleanText(req.body.description ?? clan.description, 120);
  const limit = req.body.memberLimit === undefined ? clan.memberLimit : Number(req.body.memberLimit);
  const memberCount = users.filter(user => user.clan === clan.tag).length;

  if (!/^[\p{L}\p{N} _-]{3,24}$/u.test(name)) {
    return res.status(400).json({ success: false, message: "Назва клану: 3–24 символи." });
  }
  if (!Number.isInteger(limit) || limit < 5 || limit > 50 || limit < memberCount) {
    return res.status(400).json({ success: false, message: "Ліміт має бути 5–50 і не меншим за кількість учасників." });
  }

  clan.name = name;
  clan.description = description;
  clan.memberLimit = limit;
  saveClans();
  res.json({ success: true, clan });
});

app.post("/api/clans/transfer", transactionRateLimit, requireAuth, (req, res) => {
  const clan = req.user.clan ? clans[req.user.clan] : null;
  if (!clan || clan.ownerId !== req.user.id) {
    return res.status(403).json({ success: false, message: "Передати клан може лише власник." });
  }

  const targetId = normalizeId(req.body.userId);
  const target = users.find(user => user.id === targetId && user.clan === clan.tag);
  if (!target) return res.status(404).json({ success: false, message: "Новий власник має бути учасником клану." });
  if (target.id === req.user.id) return res.status(400).json({ success: false, message: "Ти вже власник клану." });

  const previousOwnerId = clan.ownerId;
  clan.ownerId = target.id;
  clan.officers = Array.isArray(clan.officers) ? clan.officers.filter(id => id !== target.id) : [];
  if (!clan.officers.includes(previousOwnerId)) clan.officers.push(previousOwnerId);
  saveClans();
  res.json({ success: true, clan });
});

app.post("/api/clans/request", transactionRateLimit, requireAuth, (req, res) => {
  const tag = cleanText(req.body.clanId || req.body.tag, 5).toUpperCase();
  const clan = clans[tag];
  if (!clan) return res.status(404).json({ success: false, message: "Клан не знайдено." });
  if (req.user.clan) return res.status(400).json({ success: false, message: "Спочатку вийди з поточного клану." });

  const count = users.filter(u => u.clan === clan.tag).length;
  if (count >= clan.memberLimit) return res.status(400).json({ success: false, message: "Клан заповнений." });

  clan.requests = Array.isArray(clan.requests) ? clan.requests : [];
  if (!clan.requests.includes(req.user.id)) clan.requests.push(req.user.id);
  saveClans();

  const recipientIds = new Set([clan.ownerId, ...(clan.officers || [])]);
  for (const client of io.sockets.sockets.values()) {
    if (client.user && recipientIds.has(client.user.id)) {
      client.emit("clan_request_notification", {
        tag: clan.tag,
        clanName: clan.name,
        userId: req.user.id,
        nickname: req.user.nickname
      });
    }
  }

  res.json({ success: true, message: "Заявку відправлено." });
});

app.post("/api/clans/requests", requireAuth, (req, res) => {
  if (!req.user.clan) return res.json({ success: true, requests: [] });
  const clan = clans[req.user.clan];
  if (!clan || (clan.ownerId !== req.user.id && !(clan.officers || []).includes(req.user.id))) {
    return res.status(403).json({ success: false });
  }

  const requests = (clan.requests || [])
    .map(id => users.find(u => u.id === id))
    .filter(Boolean)
    .map(publicUser);

  res.json({ success: true, requests });
});

app.post("/api/clans/accept", requireAuth, (req, res) => {
  const clan = req.user.clan ? clans[req.user.clan] : null;
  if (!clan || (clan.ownerId !== req.user.id && !(clan.officers || []).includes(req.user.id))) {
    return res.status(403).json({ success: false });
  }

  const targetId = normalizeId(req.body.userId);
  const target = users.find(u => u.id === targetId);
  if (!target || !(clan.requests || []).includes(targetId)) {
    return res.status(404).json({ success: false, message: "Заявку не знайдено." });
  }
  if (target.clan) return res.status(400).json({ success: false, message: "Гравець вже в клані." });
  if (users.filter(u => u.clan === clan.tag).length >= clan.memberLimit) {
    return res.status(400).json({ success: false, message: "Клан вже заповнений." });
  }

  target.clan = clan.tag;
  clan.requests = clan.requests.filter(id => id !== targetId);
  saveUsers();
  saveClans();
  res.json({ success: true });
});

app.post("/api/clans/decline", requireAuth, (req, res) => {
  const clan = req.user.clan ? clans[req.user.clan] : null;
  if (!clan || (clan.ownerId !== req.user.id && !(clan.officers || []).includes(req.user.id))) {
    return res.status(403).json({ success: false });
  }
  const targetId = normalizeId(req.body.userId);
  clan.requests = (clan.requests || []).filter(id => id !== targetId);
  saveClans();
  res.json({ success: true });
});

app.post("/api/clans/kick", requireAuth, (req, res) => {
  const clan = req.user.clan ? clans[req.user.clan] : null;
  if (!clan || (clan.ownerId !== req.user.id && !(clan.officers || []).includes(req.user.id))) {
    return res.status(403).json({ success: false, message: "Немає прав." });
  }
  const targetId = normalizeId(req.body.userId);
  if (targetId === clan.ownerId || targetId === req.user.id) {
    return res.status(400).json({ success: false, message: "Не можна виключити власника/себе." });
  }
  const target = users.find(u => u.id === targetId && u.clan === clan.tag);
  if (!target) return res.status(404).json({ success: false, message: "Гравця не знайдено." });

  if ((clan.officers || []).includes(target.id) && clan.ownerId !== req.user.id) {
    return res.status(403).json({ success: false, message: "Тільки власник може виключати офіцерів." });
  }
  target.clan = null;
  clan.officers = (clan.officers || []).filter(id => id !== target.id);
  for (const client of io.sockets.sockets.values()) {
    if (client.user?.id === target.id) {
      client.leave("clan:" + clan.tag);
      client.emit("clan_chat_error", { message: "Тебе виключили з клану." });
    }
  }
  saveUsers();
  saveClans();
  res.json({ success: true });
});

app.post("/api/clans/promote", requireAuth, (req, res) => {
  const clan = req.user.clan ? clans[req.user.clan] : null;
  if (!clan || clan.ownerId !== req.user.id) return res.status(403).json({ success: false });
  const targetId = normalizeId(req.body.userId);
  const target = users.find(u => u.id === targetId && u.clan === clan.tag);
  if (!target || target.id === clan.ownerId) return res.status(404).json({ success: false, message: "Гравця не знайдено." });

  clan.officers = Array.isArray(clan.officers) ? clan.officers : [];
  if (!clan.officers.includes(target.id)) clan.officers.push(target.id);
  saveClans();
  res.json({ success: true });
});

app.post("/api/clans/demote", requireAuth, (req, res) => {
  const clan = req.user.clan ? clans[req.user.clan] : null;
  if (!clan || clan.ownerId !== req.user.id) return res.status(403).json({ success: false });
  const targetId = normalizeId(req.body.userId);
  clan.officers = (clan.officers || []).filter(id => id !== targetId);
  saveClans();
  res.json({ success: true });
});

app.post("/api/clans/disband", requireAuth, (req, res) => {
  const clan = req.user.clan ? clans[req.user.clan] : null;
  if (!clan || clan.ownerId !== req.user.id) return res.status(403).json({ success: false });

  const dissolvedTag = clan.tag;
  const affectedIds = new Set(users.filter(user => user.clan === dissolvedTag).map(user => user.id));
  for (const u of users) {
    if (affectedIds.has(u.id)) u.clan = null;
  }
  for (const client of io.sockets.sockets.values()) {
    if (client.user && affectedIds.has(client.user.id)) {
      client.leave("clan:" + dissolvedTag);
      client.emit("clan_chat_error", { message: "Клан розпущено." });
    }
  }
  delete clans[dissolvedTag];
  delete messages["clan:" + dissolvedTag];
  saveUsers();
  saveClans();
  saveMessages();
  res.json({ success: true });
});

app.post("/api/clans/leave", requireAuth, (req, res) => {
  if (!req.user.clan) return res.json({ success: true });
  const leavingTag = req.user.clan;
  const clan = clans[leavingTag];
  if (!clan) {
    req.user.clan = null;
    saveUsers();
    return res.json({ success: true });
  }

  if (clan.ownerId === req.user.id) {
    const candidates = users
      .filter(u => u.clan === clan.tag && u.id !== req.user.id)
      .sort((a, b) => ((clan.officers || []).includes(a.id) ? 0 : 1) - ((clan.officers || []).includes(b.id) ? 0 : 1));

    if (candidates.length) {
      clan.ownerId = candidates[0].id;
      clan.officers = (clan.officers || []).filter(id => id !== candidates[0].id);
      req.user.clan = null;
    } else {
      delete clans[clan.tag];
      req.user.clan = null;
    }
  } else {
    req.user.clan = null;
    clan.officers = (clan.officers || []).filter(id => id !== req.user.id);
  }

  for (const client of io.sockets.sockets.values()) {
    if (client.user?.id === req.user.id) client.leave("clan:" + leavingTag);
  }
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

app.post("/api/market/sell", transactionRateLimit, requireAuth, (req, res) => {
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

app.post("/api/market/buy", transactionRateLimit, requireAuth, (req, res) => {
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

app.post("/api/use-promo", transactionRateLimit, requireAuth, (req, res) => {
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
  for (const other of users) {
    if (other.id === req.user.id) continue;
    const room = chatRoom(req.user.id, other.id);
    if (messages[room]) partnerIds.add(other.id);
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

app.post("/api/clans/avatar", requireAuth, (req, res, next) => {
  const clan = req.user.clan ? clans[req.user.clan] : null;
  if (!clan) return res.status(403).json({ success: false, message: "Спочатку вступи до клану." });
  if (clan.ownerId !== req.user.id && !(clan.officers || []).includes(req.user.id)) {
    return res.status(403).json({ success: false, message: "Змінювати аватар може лише власник або офіцер." });
  }
  req.clanForAvatar = clan;
  next();
}, upload.single("avatar"), (req, res) => {
  const clan = req.clanForAvatar;
  if (!req.file) return res.status(400).json({ success: false, message: "Вибери зображення." });
  clan.avatar = "/avatars/" + req.file.filename;
  saveClans();
  res.json({ success: true, newPath: clan.avatar });
});

// ---------- MATCHMAKING / GAME ----------

const matchmakingQueue = [];
const activeMatches = new Map(); // in-memory only; never written to MongoDB
const trainingSessions = new Map(); // private tester sessions; never written to MongoDB
const activeLobbies = new Map(); // transient party lobbies; never persisted
const lobbyByUser = new Map();
const lobbyInvites = new Map();
const DEFAULT_MATCH_SIZE = 3;
const GAME_SECONDS = 300;
const WARMUP_SECONDS = 10;
const COUNTDOWN_SECONDS = 15;
const JOIN_TIMEOUT_SECONDS = 90;

const PLAYABLE_MAPS = Object.freeze({
  SANDSTONE: { id: "SANDSTONE", name: "SANDSTONE", kind: "tight-defuse" },
  SMALL_YARD: { id: "SMALL_YARD", name: "SMALL YARD", kind: "small-arena" },
  M3_Maze: { id: "M3_Maze", name: "M3 MAZE", kind: "model" },
  FIELD_ARENA: { id: "FIELD_ARENA", name: "FIELD ARENA", kind: "arena" },
  NEON_YARD: { id: "NEON_YARD", name: "NEON YARD", kind: "neon" },
  HILL_TOWN: { id: "HILL_TOWN", name: "HILL TOWN", kind: "hill-town" }
});
function normalizeMapId(value) {
  const id = cleanText(value, 32);
  return Object.prototype.hasOwnProperty.call(PLAYABLE_MAPS, id) ? id : "M3_Maze";
}

const MODE_CONFIGS = {
  allies: {
    id: "allies",
    name: "СОЮЗНИКИ · 2×2",
    short: "2V2",
    map: "SANDSTONE",
    requiredPlayers: 4
  },
  hide_seek: {
    id: "hide_seek",
    name: "HIDE & SEEK",
    short: "HS",
    map: "M3_Maze",
    requiredPlayers: 3
  },
  team_fight: {
    id: "team_fight",
    name: "КБ · 1×1×1",
    short: "FFA",
    map: "SMALL_YARD",
    requiredPlayers: 3
  }
};

const ALLIES_BUY_PRICES = Object.freeze({ akr: 2700, p350: 300, knife: 0 });

const TESTER_MODE_CONFIGS = {
  training: { id: "training", name: "TRAINING", map: "HILL_TOWN", kind: "bot-training" },
  field_test: { id: "field_test", name: "FIELD TEST", map: "HILL_TOWN", kind: "free-range" }
};

function canUseTesterModes(user) {
  return Boolean(user && (user.id === ADMIN_ID || user.isTester === true));
}

const SPAWNS = [
  { x: 5, y: 0, z: 5 },
  { x: 25, y: 0, z: 25 },
  { x: 15, y: 0, z: 5 },
  { x: 15, y: 0, z: 25 }
];
const HILL_TOWN_SPAWNS = [
  { x: -42, y: 0, z: -28 },
  { x: 42, y: 0, z: -28 },
  { x: -42, y: 0, z: 28 },
  { x: 42, y: 0, z: 28 }
];
const HILL_TOWN_DOOR_CENTERS = [[0, -28], [0, 0], [0, 28]];
const HILL_TOWN_BARRICADES = [
  { x: -25, z: -28 }, { x: 25, z: -28 },
  { x: -25, z: 0 }, { x: 25, z: 0 },
  { x: -25, z: 28 }, { x: 25, z: 28 }
];
const HILL_TOWN_PLANKS_PER_BARRICADE = 6;
function createMapInteractionState() {
  return { doors: [false, false, false], destroyedWood: [] };
}

function getModeConfig(mode) {
  return MODE_CONFIGS[mode] || MODE_CONFIGS.allies;
}

function getRequiredPlayers(mode) {
  return Number(getModeConfig(mode).requiredPlayers) || DEFAULT_MATCH_SIZE;
}

function removeFromQueue(identity, socketId = null) {
  const idx = matchmakingQueue.findIndex(p =>
    (p.uuid === identity || (!p.uuid && p.userId === identity)) &&
    (!socketId || p.socketId === socketId)
  );
  if (idx !== -1) {
    matchmakingQueue.splice(idx, 1);
    return true;
  }
  return false;
}

function playerMatch(identity) {
  for (const match of activeMatches.values()) {
    if (match.players.some(p => p.uuid === identity || (!p.uuid && p.userId === identity))) return match;
  }
  return null;
}

function emitQueueCount(io) {
  for (const entry of matchmakingQueue) {
    const modePlayers = matchmakingQueue.filter(p => p.mode === entry.mode && p.map === entry.map);
    io.to(entry.socketId).emit("queue_update", {
      count: modePlayers.length,
      required: getRequiredPlayers(entry.mode),
      mode: entry.mode,
      map: entry.map,
      mapName: PLAYABLE_MAPS[entry.map]?.name || PLAYABLE_MAPS.M3_Maze.name,
      players: modePlayers.map(p => ({
        userId: p.userId,
        nickname: p.nickname,
        playerAvatar: p.playerAvatar || "/avatars/default.jpg",
        connected: true,
        ready: false
      }))
    });
  }
}

function createMatch(io, mode, mapId = "M3_Maze", forcedCandidates = null) {
  const requestedMap = normalizeMapId(mapId);
  const safeMapId = mode === "allies" ? "SANDSTONE"
    : mode === "team_fight" ? (requestedMap === "NEON_YARD" ? "NEON_YARD" : "SMALL_YARD")
    : requestedMap;
  const candidates = Array.isArray(forcedCandidates) ? forcedCandidates : matchmakingQueue.filter(p => p.mode === mode && p.map === safeMapId);
  const requiredPlayers = getRequiredPlayers(mode);
  if (candidates.length < requiredPlayers) return;

  const players = candidates.slice(0, requiredPlayers);
  const prototypeBotMatch = players.some(p => p.prototypeBot === true);
  const lobbyMatch = players.some(p => p.lobbyMatch === true);
  for (const p of players) if (!p.isBot) removeFromQueue(p.uuid || p.userId);

  const cfg = getModeConfig(mode);
  const matchId = "match_" + Date.now() + "_" + crypto.randomBytes(2).toString("hex");
  const hunterIndex = mode === "hide_seek" ? crypto.randomInt(0, players.length) : -1;
  const MATCH_SPAWNS = {
    HILL_TOWN: [{x:-42,y:0,z:-28},{x:42,y:0,z:-28},{x:-42,y:0,z:28},{x:42,y:0,z:28}],
    SANDSTONE: [{x:-8.75,y:0,z:-50},{x:8.75,y:0,z:-50},{x:-8.75,y:0,z:50},{x:8.75,y:0,z:50}],
    SMALL_YARD: [{x:-23,y:0,z:-23},{x:23,y:0,z:-23},{x:0,y:0,z:24}],
    M3_Maze: [{x:-195,y:0,z:-195},{x:195,y:0,z:-195},{x:-195,y:0,z:195},{x:195,y:0,z:195}],
    NEON_YARD: [{x:-82,y:0,z:-82},{x:82,y:0,z:-82},{x:-82,y:0,z:82},{x:82,y:0,z:82}],
    FIELD_ARENA: [{x:-110,y:0,z:-110},{x:110,y:0,z:-110},{x:-110,y:0,z:110},{x:110,y:0,z:110}]
  };
  const matchSpawns = MATCH_SPAWNS[safeMapId] || (safeMapId === "HILL_TOWN" ? HILL_TOWN_SPAWNS : SPAWNS);

  const match = {
    id: matchId,
    mode: cfg.id,
    modeName: cfg.name,
    prototypeBotMatch,
    lobbyMatch,
    map: safeMapId,
    mapName: PLAYABLE_MAPS[safeMapId]?.name || PLAYABLE_MAPS.M3_Maze.name,
    mapState: safeMapId === "HILL_TOWN" ? createMapInteractionState() : null,
    players: players.map((p, i) => ({
      socketId: p.socketId || null,
      userId: p.userId,
      uuid: p.uuid || "",
      isBot: Boolean(p.isBot),
      nickname: p.nickname,
      playerAvatar: p.playerAvatar || "/avatars/default.jpg",
      role: mode === "hide_seek" ? (i === hunterIndex ? "hunter" : "runner")
        : mode === "allies" ? (i < 2 ? "teamA" : "teamB")
        : (i % 2 === 0 ? "teamA" : "teamB"),
      team: mode === "allies"
        ? ((prototypeBotMatch || lobbyMatch) ? (i < 2 ? "A" : "B") : (players.some(candidate => candidate.isBot) ? (p.isBot ? "B" : "A") : (i < 2 ? "A" : "B")))
        : mode === "team_fight"
          ? (prototypeBotMatch ? ["A", "B", "C"][i % 3] : (players.some(candidate => candidate.isBot) ? (p.isBot ? "B" : ["A", "B", "C"][i % 3]) : ["A", "B", "C"][i % 3]))
          : null,
      hp: 100,
      score: 0,
      kills: 0,
      deaths: 0,
      spawn: { ...matchSpawns[i % matchSpawns.length] },
      pos: { ...matchSpawns[i % matchSpawns.length] },
      rotY: 0,
      anim: "Idle",
      lastMoveAt: 0,
      prevMoveTime: 0,
      ready: Boolean(p.isBot),
      cash: mode === "allies" ? 800 : 0,
      weapons: mode === "allies" ? ["p350", "knife"] : ["akr", "p350", "knife"],
      equippedWeapon: mode === "allies" ? "p350" : "akr",
      joinedAt: null,
      disconnectTimer: null
    })),
    phase: "waiting",
    phaseRemaining: null,
    started: false,
    finished: false,
    timer: null,
    phaseTimer: null,
    joinTimer: null,
    roundTimer: null,
    bombActionTimer: null,
    bomb: null,
    droppedItems: [],
    roundNumber: 0,
    roundWins: { A: 0, B: 0 },
    attackingTeam: "A",
    defendingTeam: "B",
    roundRemaining: 0,
    remaining: GAME_SECONDS
  };

  activeMatches.set(matchId, match);
  emitQueueCount(io);

  for (const p of match.players) {
    if (!p.socketId || p.isBot) continue;
    io.to(p.socketId).emit("match_found", {
      matchId,
      userId: p.userId,
      uuid: p.uuid,
      mode: cfg.id,
      modeName: cfg.name,
      map: match.map,
      prototype: Boolean(match.prototypeBotMatch)
    });
  }

  armMatchJoinTimeout(io, match);
}

function publicLobby(lobby) {
  return {
    id: lobby.id,
    ownerId: lobby.ownerId,
    mode: lobby.mode,
    modeName: getModeConfig(lobby.mode).name,
    map: lobby.map,
    mapName: PLAYABLE_MAPS[lobby.map]?.name || lobby.map,
    maxPlayers: lobby.maxPlayers,
    createdAt: lobby.createdAt,
    members: lobby.members.map(member => ({
      userId: member.userId,
      nickname: member.nickname,
      playerAvatar: member.playerAvatar || "/avatars/default.jpg",
      isOwner: member.userId === lobby.ownerId,
      connected: Boolean(member.socketId && ioSocketExists(member.socketId))
    }))
  };
}
function ioSocketExists(socketId) {
  return Boolean(globalSocketServer?.sockets?.sockets?.has(socketId));
}
let globalSocketServer = null;
function emitLobbyState(io, lobby) {
  if (!lobby || !activeLobbies.has(lobby.id)) return;
  const payload = publicLobby(lobby);
  for (const member of lobby.members) {
    if (member.socketId && io.sockets.sockets.has(member.socketId)) io.to(member.socketId).emit("lobby_state", payload);
  }
}
function emitLobbyError(socket, message, eventName = "lobby_error") {
  socket.emit(eventName, { message });
}
function removeLobbyMember(io, userId, socketId = null, reason = "Гравець вийшов із лобі.") {
  const lobbyId = lobbyByUser.get(String(userId));
  if (!lobbyId) return;
  const lobby = activeLobbies.get(lobbyId);
  lobbyByUser.delete(String(userId));
  lobbyInvites.delete(String(userId));
  if (!lobby) return;
  const existing = lobby.members.find(member => member.userId === String(userId));
  if (socketId && existing && existing.socketId !== socketId) {
    lobbyByUser.set(String(userId), lobbyId);
    return;
  }
  lobby.members = lobby.members.filter(member => member.userId !== String(userId));
  if (!lobby.members.length) {
    activeLobbies.delete(lobbyId);
    for (const [inviteeId, invite] of lobbyInvites) if (invite.lobbyId === lobbyId) lobbyInvites.delete(inviteeId);
    return;
  }
  if (!lobby.members.some(member => member.userId === lobby.ownerId)) {
    lobby.ownerId = lobby.members[0].userId;
    const newOwner = lobby.members[0];
    if (newOwner.socketId) io.to(newOwner.socketId).emit("lobby_notice", { message: "Ти став лідером лобі." });
  }
  emitLobbyState(io, lobby);
  for (const member of lobby.members) if (member.socketId) io.to(member.socketId).emit("lobby_notice", { message: reason });
}
function lobbyMemberFromSocket(socket) {
  if (!socket?.user) return null;
  const lobbyId = lobbyByUser.get(String(socket.user.id));
  const lobby = lobbyId ? activeLobbies.get(lobbyId) : null;
  const member = lobby?.members.find(item => item.userId === String(socket.user.id) && item.socketId === socket.id);
  return member ? { lobby, member } : null;
}
function inviteFriendToLobby(io, socket, targetId) {
  const current = lobbyMemberFromSocket(socket);
  const target = users.find(user => user.id === targetId);
  if (!current) return emitLobbyError(socket, "Спочатку створи або приєднайся до лобі.", "lobby_invite_result");
  if (!target || target.id === socket.user.id) return emitLobbyError(socket, "Гравця не знайдено.", "lobby_invite_result");
  if (!(socket.user.friendsList || []).includes(target.id)) return emitLobbyError(socket, "Запрошувати можна лише друзів.", "lobby_invite_result");
  if (lobbyByUser.has(target.id)) return emitLobbyError(socket, "Гравець уже перебуває в лобі.", "lobby_invite_result");
  if (playerMatch(target.uuid || target.id)) return emitLobbyError(socket, "Гравець уже в матчі.", "lobby_invite_result");
  if (current.lobby.members.length >= current.lobby.maxPlayers) return emitLobbyError(socket, "Лобі заповнене.", "lobby_invite_result");
  let targetSocket = null;
  for (const candidate of io.sockets.sockets.values()) {
    if (candidate.user?.id === target.id) targetSocket = candidate;
  }
  if (!targetSocket) return emitLobbyError(socket, "Друг зараз не в мережі.", "lobby_invite_result");
  lobbyInvites.set(target.id, {
    lobbyId: current.lobby.id,
    invitedBy: socket.user.id,
    expiresAt: Date.now() + 60000
  });
  targetSocket.emit("lobby_invite_received", {
    lobbyId: current.lobby.id,
    lobbyName: socket.user.nickname + " · ЛОБІ",
    inviterId: socket.user.id,
    inviterNickname: socket.user.nickname,
    mode: current.lobby.mode,
    modeName: getModeConfig(current.lobby.mode).name,
    map: current.lobby.map,
    mapName: PLAYABLE_MAPS[current.lobby.map]?.name || current.lobby.map,
    expiresIn: 60
  });
  socket.emit("lobby_invite_result", { success: true, message: "Запрошення надіслано: " + target.nickname });
}
function createLobbyMatch(io, socket, data = {}) {
  const current = lobbyMemberFromSocket(socket);
  if (!current) return emitLobbyError(socket, "Спочатку створи або приєднайся до лобі.", "lobby_start_error");
  const lobby = current.lobby;
  if (lobby.ownerId !== socket.user.id) return emitLobbyError(socket, "Почати матч може лише лідер лобі.", "lobby_start_error");
  const mode = lobby.mode;
  const map = mode === "allies" ? "SANDSTONE" : lobby.map;
  const required = getRequiredPlayers(mode);
  const members = [...lobby.members];
  if (members.length > required) return emitLobbyError(socket, "У лобі більше гравців, ніж підтримує цей режим.", "lobby_start_error");
  for (const member of members) {
    if (!member.socketId || !io.sockets.sockets.has(member.socketId)) return emitLobbyError(socket, "Не всі гравці підключені до лобі.", "lobby_start_error");
    const user = users.find(candidate => candidate.id === member.userId);
    if (!user || playerMatch(user.uuid || user.id)) return emitLobbyError(socket, "Один із гравців уже перебуває в матчі.", "lobby_start_error");
  }
  const fillBots = data.fillWithBots !== false;
  if (members.length < required && !fillBots) return emitLobbyError(socket, "Додай друзів або ввімкни заповнення ботами.", "lobby_start_error");
  const candidates = members.map(member => {
    const user = users.find(candidate => candidate.id === member.userId);
    return {
      socketId: member.socketId,
      userId: member.userId,
      nickname: member.nickname,
      playerAvatar: member.playerAvatar || "/avatars/default.jpg",
      uuid: user?.uuid || "",
      isBot: false,
      lobbyMatch: true,
      mode, map
    };
  });
  for (let index = candidates.length; index < required; index++) {
    const userId = "lobby_bot_" + crypto.randomBytes(8).toString("hex");
    candidates.push({
      socketId: null, userId, uuid: "", isBot: true, lobbyMatch: true,
      nickname: "BOT · " + String(index + 1).padStart(2, "0"),
      playerAvatar: "/avatars/default.jpg", mode, map, ready: true
    });
  }
  activeLobbies.delete(lobby.id);
  for (const member of lobby.members) {
    lobbyByUser.delete(member.userId);
    if (member.socketId) io.to(member.socketId).emit("lobby_closed", { reason: "Матч запускається." });
  }
  for (const [inviteeId, invite] of lobbyInvites) if (invite.lobbyId === lobby.id) lobbyInvites.delete(inviteeId);
  createMatch(io, mode, map, candidates);
}

function armMatchJoinTimeout(io, match) {
  if (!match || match.started || match.finished) return;
  if (match.joinTimer) clearTimeout(match.joinTimer);
  match.joinTimer = setTimeout(() => {
    const current = activeMatches.get(match.id);
    if (!current || current.started || current.finished) return;
    const connected = current.players.filter(p => p.isBot || Boolean(p.socketId)).length;
    const ready = current.players.filter(p => p.isBot || p.ready).length;
    if (connected < current.players.length || ready < current.players.length) {
      const message = connected < current.players.length
        ? "Не всі гравці підключилися до матчу."
        : "Не всі гравці встигли завантажити карту.";
      for (const p of current.players) {
        if (p.socketId) io.to(p.socketId).emit("search_error", { message });
      }
      cleanMatch(io, current.id, true);
    }
  }, JOIN_TIMEOUT_SECONDS * 1000);
}

function emitMatchWaiting(io, match) {
  const connected = match.players.filter(p => p.isBot || Boolean(p.socketId)).length;
  const ready = match.players.filter(p => p.isBot || p.ready).length;
  io.to(match.id).emit("match_waiting", {
    connected,
    ready,
    required: match.players.length,
    mode: match.mode,
    modeName: match.modeName,
    players: match.players.map(p => ({
      userId: p.userId,
      nickname: p.nickname,
      playerAvatar: p.playerAvatar || "/avatars/default.jpg",
      connected: p.isBot || Boolean(p.socketId),
      ready: p.isBot || Boolean(p.ready),
      isBot: Boolean(p.isBot),
      hp: p.hp,
      team: p.team
    }))
  });
}

function cleanMatch(io, matchId, returnToMenu = true) {
  const match = activeMatches.get(matchId);
  if (!match) return;
  if (match.timer) clearInterval(match.timer);
  if (match.phaseTimer) clearInterval(match.phaseTimer);
  if (match.joinTimer) clearTimeout(match.joinTimer);
  if (match.roundTimer) clearInterval(match.roundTimer);
  if (match.bombActionTimer) clearInterval(match.bombActionTimer);
  if (match.bomb?.explodeTimer) clearTimeout(match.bomb.explodeTimer);
  if (returnToMenu) io.to(match.id).emit("go_to_menu");
  for (const p of match.players) {
    if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
    p.disconnectTimer = null;
    p.socketId = null;
  }
  activeMatches.delete(matchId);
}

function startMatchWhenReady(io, match) {
  if (match.started || match.phase !== "waiting") return;
  const allConnected = match.players.every(p => p.isBot || Boolean(p.socketId));
  const allReady = match.players.every(p => p.isBot || p.ready);
  if (!allConnected || !allReady) {
    emitMatchWaiting(io, match);
    // A previous socket disconnect clears this timer while the page navigates
    // from lobby to gameplay. Re-arm it after the new socket joins so the
    // waiting screen cannot remain stuck forever.
    if (!match.joinTimer) armMatchJoinTimeout(io, match);
    return;
  }

  match.started = true;
  if (match.joinTimer) clearTimeout(match.joinTimer);

  if (match.mode === "allies") {
    startAlliesRound(io, match, true);
    return;
  }

  if (match.players.some(p => p.isBot) && !match.prototypeBotMatch) {
    match.phase = "game";
    match.remaining = GAME_SECONDS;
    io.to(match.id).emit("match_phase", { phase: "game", time: match.remaining, mode: match.mode, modeName: match.modeName });
    io.to(match.id).emit("match_start_now", { mode: match.mode, modeName: match.modeName, testerBots: true });
    match.timer = setInterval(() => {
      match.remaining -= 1;
      io.to(match.id).emit("timer_update", { time: match.remaining, phase: "game" });
      if (match.remaining <= 0) finishMatch(io, match.id);
    }, 1000);
    return;
  }

  match.phase = "warmup";
  let warmup = WARMUP_SECONDS;
  match.phaseRemaining = warmup;
  io.to(match.id).emit("match_phase", {
    phase: "warmup",
    time: warmup,
    mode: match.mode,
    modeName: match.modeName
  });

  match.phaseTimer = setInterval(() => {
    warmup -= 1;
    match.phaseRemaining = warmup;
    io.to(match.id).emit("timer_update", { time: warmup, phase: "warmup" });

    if (warmup <= 0) {
      clearInterval(match.phaseTimer);
      match.phase = "countdown";
      let countdown = COUNTDOWN_SECONDS;
      match.phaseRemaining = countdown;
      io.to(match.id).emit("match_phase", {
        phase: "countdown",
        time: countdown,
        mode: match.mode,
        modeName: match.modeName
      });

      match.phaseTimer = setInterval(() => {
        countdown -= 1;
        match.phaseRemaining = countdown;
        io.to(match.id).emit("timer_update", { time: countdown, phase: "countdown" });

        if (countdown <= 0) {
          clearInterval(match.phaseTimer);
          match.phase = "game";
          match.remaining = GAME_SECONDS;
          io.to(match.id).emit("match_start_now", {
            mode: match.mode,
            modeName: match.modeName
          });

          match.timer = setInterval(() => {
            match.remaining -= 1;
            io.to(match.id).emit("timer_update", { time: match.remaining, phase: "game" });
            if (match.remaining <= 0) finishMatch(io, match.id);
          }, 1000);
        }
      }, 1000);
    }
  }, 1000);
}

function finishMatch(io, matchId) {
  const match = activeMatches.get(matchId);
  if (!match || match.finished) return;

  match.finished = true;
  match.phase = "finished";
  if (match.timer) clearInterval(match.timer);
  if (match.phaseTimer) clearInterval(match.phaseTimer);
  if (match.joinTimer) clearTimeout(match.joinTimer);

  const ranked = [...match.players].sort((a, b) => match.mode === "allies"
    ? (match.roundWins?.[b.team] || 0) - (match.roundWins?.[a.team] || 0) || b.score - a.score
    : b.score - a.score);
  const highestScore = ranked[0]?.score || 0;
  const winningTeam = match.mode === "allies"
    ? (match.roundWins.A === match.roundWins.B ? null : (match.roundWins.A > match.roundWins.B ? "A" : "B"))
    : null;

  for (const player of match.players) {
    const user = users.find(u => u.id === player.userId);
    if (!user) continue;

    const won = match.mode === "allies"
      ? Boolean(winningTeam && player.team === winningTeam)
      : highestScore > 0 && player.score === highestScore;
    const gold = won ? 10 : 2;
    const xp = 50 + player.score * 20;
    user.gold = (Number(user.gold) || 0) + gold;
    user.XP = (Number(user.XP) || 0) + xp;

    if (player.socketId) {
      io.to(player.socketId).emit("show_results", {
        xp,
        gold,
        score: player.score,
        msg: "Матч завершено. +" + xp + " XP / +" + gold + " Gold"
      });
    }
  }

  saveUsers();
  io.to(match.id).emit("match_finished", {
    mode: match.mode,
    roundWins: match.mode === "allies" ? match.roundWins : null,
    winnerTeam: winningTeam,
    scores: ranked.map(p => ({ userId: p.userId, nickname: p.nickname, score: p.score, team: p.team }))
  });

  setTimeout(() => cleanMatch(io, matchId, true), 8000);
}

function respawnPlayer(match, player) {
  player.pos = { ...player.spawn };
  player.hp = 100;
  player.rotY = 0;
  player.anim = "Idle";
}

const SANDSTONE_BOMB_SITES = Object.freeze({
  A: Object.freeze({ x: 37.5, z: -33.75 }),
  B: Object.freeze({ x: 22.5, z: 37.5 })
});

function alliesSide(match, team) {
  return team === match.attackingTeam ? "attack" : "defense";
}

function playerNearBombSite(player, site, radius = 5.2) {
  const center = SANDSTONE_BOMB_SITES[site];
  return Boolean(center && player && Math.hypot(player.pos.x - center.x, player.pos.z - center.z) <= radius);
}

function bombPublicState(match) {
  const bomb = match.bomb || {};
  return {
    state: bomb.state || "carried",
    site: bomb.site || null,
    carrierUserId: bomb.carrierUserId || null,
    actorUserId: bomb.action?.userId || null,
    action: bomb.action?.kind || null,
    actionStartedAt: bomb.action?.startedAt || null,
    plantedAt: bomb.plantedAt || null,
    explodeAt: bomb.explodeAt || null,
    roundNumber: match.roundNumber,
    roundWins: { ...(match.roundWins || { A: 0, B: 0 }) },
    attackingTeam: match.attackingTeam,
    defendingTeam: match.defendingTeam,
    roundRemaining: match.roundRemaining || 0,
    position: bomb.state === "dropped" && bomb.droppedPosition ? { ...bomb.droppedPosition } : null
  };
}

function alliesRoundPayload(match) {
  return {
    matchId: match.id,
    mode: match.mode,
    modeName: match.modeName,
    map: match.map,
    roundNumber: match.roundNumber,
    roundWins: { ...match.roundWins },
    attackingTeam: match.attackingTeam,
    defendingTeam: match.defendingTeam,
    phase: match.phase,
    roundRemaining: match.roundRemaining,
    bomb: bombPublicState(match),
    players: match.players.map(player => ({
      userId: player.userId, nickname: player.nickname,
      playerAvatar: player.playerAvatar || "/avatars/default.jpg",
      isBot: Boolean(player.isBot),
      team: player.team, hp: player.hp, score: Number(player.score) || 0,
      kills: Number(player.kills) || 0, deaths: Number(player.deaths) || 0,
      cash: Number(player.cash) || 0, equippedWeapon: player.equippedWeapon || "p350",
      x: player.pos.x, y: player.pos.y, z: player.pos.z,
      rotY: player.rotY, spawn: { ...player.spawn },
      alive: player.hp > 0, connected: player.isBot || Boolean(player.socketId)
    }))
  };
}

function alliesLoadoutPayload(player) {
  return { cash: Math.max(0, Number(player.cash) || 0), weapons: Array.isArray(player.weapons) ? [...new Set(player.weapons)] : ["p350", "knife"], equippedWeapon: player.equippedWeapon || "p350", prices: { ...ALLIES_BUY_PRICES } };
}
function emitAlliesLoadout(io, match, player) {
  if (player?.socketId) io.to(player.socketId).emit("allies_loadout", alliesLoadoutPayload(player));
}
function handleAlliesBuy(io, match, player, data = {}) {
  if (!match || match.mode !== "allies" || match.phase !== "round_start" || player.hp <= 0) return;
  const weaponId = cleanText(data?.weapon, 20).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(ALLIES_BUY_PRICES, weaponId)) return;
  const price = ALLIES_BUY_PRICES[weaponId];
  if (!Array.isArray(player.weapons)) player.weapons = ["p350", "knife"];
  if (player.weapons.includes(weaponId)) { player.equippedWeapon = weaponId; emitAlliesLoadout(io, match, player); return; }
  if ((Number(player.cash) || 0) < price) {
    io.to(player.socketId).emit("allies_buy_result", { success: false, message: "Не вистачає грошей на цю зброю." });
    emitAlliesLoadout(io, match, player); return;
  }
  player.cash = Math.max(0, Number(player.cash) || 0) - price;
  player.weapons.push(weaponId); player.equippedWeapon = weaponId;
  io.to(player.socketId).emit("allies_buy_result", { success: true, message: weaponId === "akr" ? "AKR придбано." : "Зброю вибрано." });
  emitAlliesLoadout(io, match, player);
}
function handleAlliesSelectWeapon(io, match, player, data = {}) {
  if (!match || match.mode !== "allies" || !["round_start", "game"].includes(match.phase) || player.hp <= 0) return;
  const weaponId = cleanText(data?.weapon, 20).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(ALLIES_BUY_PRICES, weaponId) || !Array.isArray(player.weapons) || !player.weapons.includes(weaponId)) return;
  player.equippedWeapon = weaponId;
  emitAlliesLoadout(io, match, player);
}
function stopAlliesRoundTimers(match) {
  if (match.roundTimer) clearInterval(match.roundTimer);
  if (match.bombActionTimer) clearInterval(match.bombActionTimer);
  if (match.bomb?.explodeTimer) clearTimeout(match.bomb.explodeTimer);
  match.roundTimer = null;
  match.bombActionTimer = null;
  if (match.bomb) match.bomb.explodeTimer = null;
}

function finishAlliesRound(io, match, winningTeam, reason) {
  if (!match || match.finished || match.mode !== "allies" || match.phase === "round_end") return;
  stopAlliesRoundTimers(match);
  match.phase = "round_end";
  match.phaseRemaining = 5;
  match.roundWins[winningTeam] = (match.roundWins[winningTeam] || 0) + 1;
  for (const player of match.players) player.cash = Math.min(16000, Math.max(0, Number(player.cash) || 0) + (player.team === winningTeam ? 3250 : 1900));
  const players = match.players.map(player => ({
    userId: player.userId,
    nickname: player.nickname,
    playerAvatar: player.playerAvatar || "/avatars/default.jpg",
    isBot: Boolean(player.isBot),
    team: player.team,
    hp: player.hp,
    alive: player.hp > 0,
    x: Number(player.pos?.x) || 0,
    y: Number(player.pos?.y) || 0,
    z: Number(player.pos?.z) || 0,
    score: Number(player.score) || 0,
    kills: Number(player.kills) || 0,
    deaths: Number(player.deaths) || 0,
    cash: Number(player.cash) || 0,
    equippedWeapon: player.equippedWeapon || "p350"
  }));
  const mvp = [...players].sort((a, b) => b.kills - a.kills || b.score - a.score || a.deaths - b.deaths)[0] || null;
  const payload = {
    ...alliesRoundPayload(match),
    phase: "round_end",
    winningTeam,
    reason,
    roundWins: { ...match.roundWins },
    attackingTeam: match.attackingTeam,
    defendingTeam: match.defendingTeam,
    players,
    mvp: mvp ? { userId: mvp.userId, nickname: mvp.nickname, kills: mvp.kills } : null,
    nextRoundIn: 5
  };
  io.to(match.id).emit("allies_round_end", payload);
  io.to(match.id).emit("match_phase", {
    phase: "round_end", time: 5, mode: match.mode, modeName: match.modeName,
    roundNumber: match.roundNumber, roundWins: { ...match.roundWins },
    winningTeam, reason
  });
  const reachedTarget = match.roundWins.A >= 8 || match.roundWins.B >= 8;
  const reachedMaxRounds = match.roundNumber >= 15;
  match.phaseTimer = setTimeout(() => {
    const current = activeMatches.get(match.id);
    if (!current || current.finished) return;
    if (reachedTarget || reachedMaxRounds) finishMatch(io, current.id);
    else startAlliesRound(io, current, false);
  }, 5000);
}

function checkAlliesRoundWin(io, match) {
  if (!match || match.mode !== "allies" || match.phase !== "game" || match.finished) return;
  const attackAlive = match.players.some(p => p.team === match.attackingTeam && p.hp > 0);
  const defenseAlive = match.players.some(p => p.team === match.defendingTeam && p.hp > 0);
  if (!defenseAlive) {
    finishAlliesRound(io, match, match.attackingTeam, "elimination");
    return;
  }
  if (!attackAlive && match.bomb?.state !== "planted" && match.bomb?.state !== "planting") {
    finishAlliesRound(io, match, match.defendingTeam, "elimination");
  }
}

function startAlliesRound(io, match, initial = false) {
  if (!match || match.finished) return;
  if (match.phaseTimer) { clearTimeout(match.phaseTimer); clearInterval(match.phaseTimer); }
  stopAlliesRoundTimers(match);
  match.droppedItems = [];
  io.to(match.id).emit("dropped_items_state", []);
  if (match.roundNumber > 0 && match.roundNumber % 7 === 0) {
    const previousAttacker = match.attackingTeam;
    match.attackingTeam = match.defendingTeam;
    match.defendingTeam = previousAttacker;
  }
  match.roundNumber += 1;
  match.phase = "round_start";
  match.phaseRemaining = 10;
  match.roundRemaining = 110;
  match.bomb = {
    state: "carried",
    carrierUserId: match.players.find(p => p.team === match.attackingTeam && !p.isBot)?.userId
      || match.players.find(p => p.team === match.attackingTeam)?.userId || null,
    site: null,
    plantedAt: null,
    explodeAt: null,
    action: null,
    explodeTimer: null
  };
  // Match the 1.25x Sandstone geometry scale used by the client and bomb sites.
  const sideSpawns = {
    attack: [{ x: -8.75, y: 0, z: -50 }, { x: 8.75, y: 0, z: -50 }],
    defense: [{ x: -8.75, y: 0, z: 50 }, { x: 8.75, y: 0, z: 50 }]
  };
  const teamIndices = { A: 0, B: 0 };
  for (const player of match.players) {
    if (match.roundNumber > 1 && player.hp <= 0) { player.weapons = ["p350", "knife"]; player.equippedWeapon = "p350"; }
    if (!Array.isArray(player.weapons) || !player.weapons.length) player.weapons = ["p350", "knife"];
    if (!player.weapons.includes(player.equippedWeapon)) player.equippedWeapon = player.weapons.includes("p350") ? "p350" : player.weapons[0];
    player.cash = Math.max(0, Number.isFinite(Number(player.cash)) ? Number(player.cash) : 800);
    player.hp = 100;
    player.lastShotAt = 0;
    player.roundAlive = true;
    const side = alliesSide(match, player.team);
    const spawnList = sideSpawns[side];
    const spawnIndex = Math.min(teamIndices[player.team] || 0, spawnList.length - 1);
    teamIndices[player.team] = spawnIndex + 1;
    player.spawn = { ...spawnList[spawnIndex] };
    player.pos = { ...player.spawn };
    player.rotY = side === "attack" ? Math.PI : 0;
    player.anim = "Idle";
    emitAlliesLoadout(io, match, player);
  }
  if (initial) {
    io.to(match.id).emit("match_start_now", {
      mode: match.mode, modeName: match.modeName, bombMode: true
    });
  }
  io.to(match.id).emit("allies_round_start", alliesRoundPayload(match));
  io.to(match.id).emit("bomb_state", bombPublicState(match));
  io.to(match.id).emit("match_phase", {
    phase: "round_start", time: 10, mode: match.mode, modeName: match.modeName,
    roundNumber: match.roundNumber, roundWins: { ...match.roundWins },
    attackingTeam: match.attackingTeam, defendingTeam: match.defendingTeam
  });
  match.phaseTimer = setInterval(() => {
    const current = activeMatches.get(match.id);
    if (!current || current.finished || current.phase !== "round_start") { clearInterval(match.phaseTimer); return; }
    current.phaseRemaining = Math.max(0, (Number(current.phaseRemaining) || 0) - 1);
    io.to(current.id).emit("timer_update", { phase: "round_start", time: current.phaseRemaining, roundNumber: current.roundNumber, roundWins: { ...current.roundWins }, attackingTeam: current.attackingTeam, defendingTeam: current.defendingTeam });
    if (current.phaseRemaining > 0) return;
    clearInterval(current.phaseTimer);
    current.phaseTimer = null;
    current.phase = "game";
    current.phaseRemaining = null;
    if (current.prototypeBotMatch && current.mode === "allies" && current.bomb?.state === "carried") {
      const carrier = current.players.find(p => p.userId === current.bomb.carrierUserId);
      current.bomb.botPlantAt = carrier?.isBot ? Date.now() + 15000 : null;
    }
    io.to(current.id).emit("allies_round_live", alliesRoundPayload(current));
    io.to(current.id).emit("match_phase", {
      phase: "game", time: current.roundRemaining, mode: current.mode,
      modeName: current.modeName, roundNumber: current.roundNumber,
      roundWins: { ...current.roundWins }, attackingTeam: current.attackingTeam,
      defendingTeam: current.defendingTeam
    });
    current.roundTimer = setInterval(() => {
      if (current.phase !== "game" || current.finished) return;
      if (current.bomb?.state === "planted") {
        const bombRemaining = Math.max(0, Math.ceil((Number(current.bomb.explodeAt) - Date.now()) / 1000));
        io.to(current.id).emit("timer_update", { phase: "bomb", time: bombRemaining, roundNumber: current.roundNumber, roundWins: { ...current.roundWins }, attackingTeam: current.attackingTeam, defendingTeam: current.defendingTeam });
        return;
      }
      current.roundRemaining = Math.max(0, current.roundRemaining - 1);
      io.to(current.id).emit("timer_update", {
        phase: "game", time: current.roundRemaining,
        roundNumber: current.roundNumber, roundWins: { ...current.roundWins },
        attackingTeam: current.attackingTeam, defendingTeam: current.defendingTeam
      });
      if (current.roundRemaining <= 0 && current.bomb?.state !== "planted") {
        finishAlliesRound(io, current, current.defendingTeam, "time");
      }
    }, 1000);
    current.bombActionTimer = setInterval(() => {
      if (current.phase !== "game" || current.finished || !current.bomb) return;
      maintainBombCarrier(io, current);
      if (current.phase !== "game" || current.finished) return;
      const bomb = current.bomb;
      const action = bomb.action;
      if (current.prototypeBotMatch && bomb.state === "carried" && bomb.botPlantAt && Date.now() >= bomb.botPlantAt) {
        const carrier = current.players.find(p => p.userId === bomb.carrierUserId);
        if (carrier?.isBot && carrier.team === current.attackingTeam) {
          const site = Object.entries(SANDSTONE_BOMB_SITES).sort((a, b) =>
            Math.hypot(carrier.pos.x - a[1].x, carrier.pos.z - a[1].z) -
            Math.hypot(carrier.pos.x - b[1].x, carrier.pos.z - b[1].z)
          )[0]?.[0] || "A";
          bomb.state = "planted";
          bomb.site = site;
          bomb.plantedAt = Date.now();
          bomb.explodeAt = bomb.plantedAt + 40000;
          bomb.botPlantAt = null;
          bomb.action = null;
          current.roundRemaining = null;
          io.to(current.id).emit("bomb_state", bombPublicState(current));
          io.to(current.id).emit("bomb_planted", { site, explodeAt: bomb.explodeAt, attackingTeam: current.attackingTeam, prototypeAuto: true });
        } else {
          bomb.botPlantAt = null;
        }
      }
      if (bomb.state === "planted" && bomb.explodeAt && Date.now() >= bomb.explodeAt) {
        finishAlliesRound(io, current, current.attackingTeam, "bomb_exploded");
        return;
      }
      if (!action) return;
      const actor = current.players.find(p => p.userId === action.userId);
      if (!actor || actor.hp <= 0 || actor.team !== (action.kind === "plant" ? current.attackingTeam : current.defendingTeam)) {
        bomb.action = null;
        if (bomb.state === "planting") bomb.state = "carried";
        io.to(current.id).emit("bomb_state", bombPublicState(current));
        checkAlliesRoundWin(io, current);
        return;
      }
        if (action.kind === "plant") {
        if (!playerNearBombSite(actor, action.site, 5.2)) {
          bomb.state = "carried"; bomb.action = null;
          io.to(current.id).emit("bomb_state", bombPublicState(current));
          return;
        }
        if (Date.now() - action.startedAt >= 3000) {
          bomb.state = "planted";
          bomb.site = action.site;
          bomb.plantedAt = Date.now();
          bomb.explodeAt = bomb.plantedAt + 40000;
          actor.cash = Math.min(16000, (Number(actor.cash) || 0) + 300);
          emitAlliesLoadout(io, current, actor);
          bomb.action = null;
          current.roundRemaining = null;
          io.to(current.id).emit("bomb_state", bombPublicState(current));
          io.to(current.id).emit("bomb_planted", {
            site: bomb.site, explodeAt: bomb.explodeAt, attackingTeam: current.attackingTeam
          });
        }
      } else if (action.kind === "defuse") {
        if (bomb.state !== "planted" || bomb.site !== action.site || !playerNearBombSite(actor, action.site, 5.2)) {
          bomb.action = null;
          io.to(current.id).emit("bomb_state", bombPublicState(current));
          return;
        }
        if (Date.now() - action.startedAt >= 5000) {
          bomb.state = "defused";
          actor.cash = Math.min(16000, (Number(actor.cash) || 0) + 300);
          emitAlliesLoadout(io, current, actor);
          bomb.action = null;
          io.to(current.id).emit("bomb_state", bombPublicState(current));
          finishAlliesRound(io, current, current.defendingTeam, "bomb_defused");
        }
      }
    }, 100);
  }, 1000);
}

function maintainBombCarrier(io, match) {
  const bomb = match?.bomb;
  if (!match || match.mode !== "allies" || match.phase !== "game" || !bomb || ["planted", "defused", "dropped"].includes(bomb.state)) return;
  const carrier = match.players.find(player => player.userId === bomb.carrierUserId);
  if (carrier && carrier.hp > 0 && carrier.socketId) return;
  const replacement = match.players.find(player => player.team === match.attackingTeam && player.hp > 0 && player.socketId);
  if (replacement) {
    bomb.carrierUserId = replacement.userId;
    bomb.state = "carried";
    bomb.site = null;
    bomb.action = null;
    io.to(match.id).emit("bomb_state", bombPublicState(match));
    return;
  }
  bomb.state = "carried";
  bomb.site = null;
  bomb.action = null;
  checkAlliesRoundWin(io, match);
  io.to(match.id).emit("bomb_state", bombPublicState(match));
}

function droppedItemsPayload(match) {
  return (Array.isArray(match?.droppedItems) ? match.droppedItems : []).map(item => ({
    id: item.id, type: item.type, weapon: item.weapon || null,
    position: { ...item.position }, ownerId: item.ownerId || null
  }));
}
function emitDroppedItems(io, match) {
  io.to(match.id).emit("dropped_items_state", droppedItemsPayload(match));
}
function handleDropItem(io, match, player, data = {}) {
  if (!match || match.finished || match.phase !== "game" || player.hp <= 0) return;
  const itemType = cleanText(data?.itemType, 12).toLowerCase();
  if (itemType === "bomb") {
    if (match.mode !== "allies" || match.bomb?.state !== "carried" || match.bomb.carrierUserId !== player.userId || player.team !== match.attackingTeam) {
      if (player.socketId) io.to(player.socketId).emit("drop_item_result", { success: false, message: "Ти не несеш C4." });
      return;
    }
    match.bomb.state = "dropped";
    match.bomb.droppedPosition = {
      x: player.pos.x + Math.sin(Number(player.rotY) || 0) * 0.8,
      y: 0.12,
      z: player.pos.z + Math.cos(Number(player.rotY) || 0) * 0.8
    };
    match.bomb.carrierUserId = null;
    match.bomb.site = null;
    match.bomb.action = null;
    match.bomb.botPlantAt = null;
    io.to(match.id).emit("bomb_state", bombPublicState(match));
    io.to(match.id).emit("drop_item_result", { success: true, itemType: "bomb" });
    return;
  }
  const weaponId = normalizeWeaponId(data?.weapon || player.equippedWeapon);
  if (!weaponId || weaponId === "knife" || weaponId !== player.equippedWeapon ||
      !Array.isArray(player.weapons) || !player.weapons.includes(weaponId)) {
    if (player.socketId) io.to(player.socketId).emit("drop_item_result", { success: false, message: "Ніж не можна викинути." });
    return;
  }
  const position = {
    x: player.pos.x + Math.sin(Number(player.rotY) || 0) * 0.85,
    y: 0.15,
    z: player.pos.z + Math.cos(Number(player.rotY) || 0) * 0.85
  };
  const item = {
    id: "drop_" + crypto.randomBytes(10).toString("hex"),
    type: "weapon", weapon: weaponId, ownerId: player.userId, position
  };
  match.droppedItems = Array.isArray(match.droppedItems) ? match.droppedItems : [];
  match.droppedItems.push(item);
  player.weapons = player.weapons.filter(id => id !== weaponId);
  if (!player.weapons.includes("knife")) player.weapons.push("knife");
  player.equippedWeapon = player.weapons.includes("p350") ? "p350" : "knife";
  emitDroppedItems(io, match);
  emitAlliesLoadout(io, match, player);
  io.to(match.id).emit("weapon_dropped", { userId: player.userId, weapon: weaponId, itemId: item.id });
  if (player.socketId) io.to(player.socketId).emit("drop_item_result", { success: true, itemType: "weapon", weapon: weaponId });
}
function handlePickupItem(io, match, player, data = {}) {
  if (!match || match.finished || match.phase !== "game" || player.hp <= 0) return;
  const itemId = cleanText(data?.itemId, 100);
  if (match.mode === "allies" && match.bomb?.state === "dropped" && itemId === "bomb") {
    if (player.team !== match.attackingTeam || !match.bomb.droppedPosition ||
        Math.hypot(player.pos.x - match.bomb.droppedPosition.x, player.pos.z - match.bomb.droppedPosition.z) > 3.4) return;
    match.bomb.state = "carried";
    match.bomb.carrierUserId = player.userId;
    match.bomb.droppedPosition = null;
    match.bomb.site = null;
    match.bomb.action = null;
    io.to(match.id).emit("bomb_state", bombPublicState(match));
    io.to(match.id).emit("item_picked_up", { userId: player.userId, itemId: "bomb", type: "bomb" });
    return;
  }
  const items = Array.isArray(match.droppedItems) ? match.droppedItems : [];
  const index = items.findIndex(item => item.id === itemId);
  if (index < 0) return;
  const item = items[index];
  if (item.type !== "weapon" || !WEAPON_BALANCE[item.weapon] || item.weapon === "knife") return;
  if (Math.hypot(player.pos.x - item.position.x, player.pos.z - item.position.z) > 3.4) return;
  player.weapons = Array.isArray(player.weapons) ? player.weapons : [];
  if (player.weapons.includes(item.weapon)) {
    if (player.socketId) io.to(player.socketId).emit("drop_item_result", { success: false, message: "У тебе вже є ця зброя." });
    return;
  }
  player.weapons.push(item.weapon);
  player.equippedWeapon = item.weapon;
  match.droppedItems.splice(index, 1);
  emitDroppedItems(io, match);
  emitAlliesLoadout(io, match, player);
  io.to(match.id).emit("item_picked_up", { userId: player.userId, itemId: item.id, type: "weapon", weapon: item.weapon });
  if (player.socketId) io.to(player.socketId).emit("drop_item_result", { success: true, itemType: "weapon", weapon: item.weapon });
}

function handleBombAction(io, match, player, data = {}) {
  if (!match || match.mode !== "allies" || match.phase !== "game" || player.hp <= 0 || !match.bomb) return;
  const action = cleanText(data.action, 16).toLowerCase();
  const site = data.site === "A" || data.site === "B" ? data.site : null;
  const bomb = match.bomb;
  const now = Date.now();
  if (action === "cancel") {
    if (bomb.action?.userId === player.userId) {
      bomb.action = null;
      if (bomb.state === "planting") bomb.state = "carried";
      io.to(match.id).emit("bomb_state", bombPublicState(match));
    }
    return;
  }
  if (action === "plant") {
    if (player.team !== match.attackingTeam || player.userId !== bomb.carrierUserId || bomb.state !== "carried" || !site || !playerNearBombSite(player, site)) return;
    bomb.state = "planting";
    bomb.site = site;
    bomb.action = { kind: "plant", userId: player.userId, site, startedAt: now };
    io.to(match.id).emit("bomb_state", bombPublicState(match));
    return;
  }
  if (action === "defuse") {
    if (player.team !== match.defendingTeam || bomb.state !== "planted" || !site || bomb.site !== site || !playerNearBombSite(player, site)) return;
    if (bomb.action?.kind === "defuse") {
      if (bomb.action.userId !== player.userId) return;
      bomb.action = null;
      io.to(match.id).emit("bomb_state", bombPublicState(match));
      return;
    }
    bomb.action = { kind: "defuse", userId: player.userId, site, startedAt: now };
    io.to(match.id).emit("bomb_state", bombPublicState(match));
  }
}

const WEAPON_BALANCE = Object.freeze({
  akr: Object.freeze({
    id: "akr", label: "AKR", type: "rifle", magazine: 30,
    reloadMs: 1800, fireDelay: 115, range: 60, ads: true,
    damage: Object.freeze({
      head: [164, 162, 159, 153, 148],
      body: [35, 34, 34, 33, 32],
      stomach: [45, 44, 44, 42, 41],
      legs: [27, 27, 26, 25, 24]
    })
  }),
  p350: Object.freeze({
    id: "p350", label: "P350", type: "pistol", magazine: 13,
    reloadMs: 1350, fireDelay: 260, range: 29, ads: false,
    damage: Object.freeze({
      head: [151, 139, 121, 85, 51],
      body: [38, 35, 30, 21, 13],
      stomach: [49, 43, 38, 26, 16],
      legs: [30, 26, 22, 16, 10]
    })
  }),
  knife: Object.freeze({
    id: "knife", label: "НІЖ", type: "melee", magazine: Infinity,
    reloadMs: 0, fireDelay: 420, range: 2.8, ads: false,
    damage: Object.freeze({
      head: [180], body: [110], stomach: [110], legs: [110]
    })
  })
});

function normalizeWeaponId(value) {
  const id = cleanText(value, 20).toLowerCase();
  return Object.prototype.hasOwnProperty.call(WEAPON_BALANCE, id) ? id : "akr";
}

function calculateWeaponDamage(weaponId, zone, distance) {
  const weapon = WEAPON_BALANCE[normalizeWeaponId(weaponId)];
  const points = weapon.damage[zone] || weapon.damage.body;
  if (weapon.type === "melee" || points.length === 1) return points[0];
  const d = Math.max(5, Math.min(25, Number.isFinite(Number(distance)) ? Number(distance) : 5));
  const position = (d - 5) / 5;
  const low = Math.floor(position);
  const high = Math.min(points.length - 1, low + 1);
  return Math.max(1, Math.round(points[low] + (points[high] - points[low]) * (position - low)));
}

function detectWeaponHitZone(shooterPos, targetPos, aim, horizontalDistance) {
  const horizontalAim = Math.max(0.01, Math.hypot(aim.x, aim.z));
  const targetHeight = (Number(shooterPos.y) || 0) + 1.55
    + (aim.y / horizontalAim) * horizontalDistance
    - (Number(targetPos.y) || 0);
  if (targetHeight >= 1.35) return "head";
  if (targetHeight < 0.55) return "legs";
  if (targetHeight < 0.98) return "stomach";
  return "body";
}

const HILL_TOWN_BUILDINGS = [
  { x: -20, z: -15, halfX: 5.05, halfZ: 4.5 },
  { x: -20, z: 15, halfX: 5.05, halfZ: 4.5 },
  { x: 20, z: -15, halfX: 5.05, halfZ: 4.5 },
  { x: 20, z: 15, halfX: 5.05, halfZ: 4.5 }
];
const HILL_TOWN_COVER = [
  [-36,-28,1.85,1.0],[-13,-28,1.45,1.05],[13,-28,1.45,1.05],[36,-28,1.85,1.0],
  [-36,0,1.85,1.0],[-13,0,1.45,1.05],[13,0,1.45,1.05],[36,0,1.85,1.0],
  [-36,28,1.85,1.0],[-13,28,1.45,1.05],[13,28,1.45,1.05],[36,28,1.85,1.0],
  [-30,-12,1.35,1.35],[30,12,1.35,1.35],[-30,12,1.35,1.35],[30,-12,1.35,1.35],
  [-11,-37,.95,.95],[11,-37,.95,.95],[-11,37,.95,.95],[11,37,.95,.95],
  [-32,-8,.95,.95],[32,8,.95,.95],[-32,8,.95,.95],[32,-8,.95,.95]
];

function hillTownPositionBlocked(x,z,mapState={},radius=.42){
  if(x < -54.35 || x > 54.35 || z < -46.35 || z > 46.35) return true;
  const doors=Array.isArray(mapState?.doors)?mapState.doors:[false,false,false];
  // Central wall at x=0. Only the three physical door gaps can cross it.
  if(Math.abs(x)<.9){
    const doorIndex=HILL_TOWN_DOOR_CENTERS.findIndex(([,centerZ])=>Math.abs(z-centerZ)<1.82);
    if(doorIndex<0 || doors[doorIndex]!==true) return true;
  }
  for(const building of HILL_TOWN_BUILDINGS){
    if(Math.abs(x-building.x)<building.halfX+radius && Math.abs(z-building.z)<building.halfZ+radius) return true;
  }
  for(const [cx,cz,halfX,halfZ] of HILL_TOWN_COVER){
    if(Math.abs(x-cx)<halfX+radius && Math.abs(z-cz)<halfZ+radius) return true;
  }
  const destroyed=Array.isArray(mapState?.destroyedWood)?mapState.destroyedWood:[];
  for(let b=0;b<HILL_TOWN_BARRICADES.length;b++){
    const barrier=HILL_TOWN_BARRICADES[b];
    const first=b*HILL_TOWN_PLANKS_PER_BARRICADE;
    const remainingPlanks=[0,1,2,3].some(part=>!destroyed.includes(first+part));
    if(remainingPlanks && Math.abs(x-barrier.x)<.55+radius && Math.abs(z-barrier.z)<1.83+radius) return true;
  }
  return false;
}

function hillTownPathBlocked(from,to,mapState={}){
  const dx=Number(to.x)-Number(from.x),dz=Number(to.z)-Number(from.z);
  const distance=Math.hypot(dx,dz);
  const steps=Math.max(1,Math.ceil(distance/.22));
  for(let i=1;i<=steps;i++){
    const t=i/steps;
    if(hillTownPositionBlocked(Number(from.x)+dx*t,Number(from.z)+dz*t,mapState)) return true;
  }
  return false;
}

function segmentIntersectsRect2d(from,to,rect){
  const dx=to.x-from.x,dz=to.z-from.z;
  let tMin=0,tMax=1;
  for(const [origin,delta,min,max] of [[from.x,dx,rect.minX,rect.maxX],[from.z,dz,rect.minZ,rect.maxZ]]){
    if(Math.abs(delta)<1e-8){if(origin<min||origin>max)return false;continue}
    let t1=(min-origin)/delta,t2=(max-origin)/delta;
    if(t1>t2)[t1,t2]=[t2,t1];
    tMin=Math.max(tMin,t1);tMax=Math.min(tMax,t2);
    if(tMin>tMax)return false;
  }
  return tMax>=0&&tMin<=1;
}

const SERVER_MAP_LIMITS = Object.freeze({
  // Keep server limits just inside the physical perimeter walls built by the client.
  SANDSTONE: { x: 60, z: 60 },
  SMALL_YARD: { x: 32, z: 32 },
  M3_Maze: { x: 225.5, z: 225.5 },
  FIELD_ARENA: { x: 291.5, z: 291.5 },
  NEON_YARD: { x: 167.5, z: 167.5 }
});
const SERVER_MAP_BLOCKERS = Object.freeze({
  SANDSTONE: [
    { minX: -37, maxX: -24, minZ: -22, maxZ: 1 },
    { minX: 21, maxX: 36, minZ: -19, maxZ: 2 },
    { minX: -37, maxX: -21, minZ: 20, maxZ: 35 },
    { minX: 30.5, maxX: 43.5, minZ: 2.5, maxZ: 19.5 },
    { minX: -12, maxX: -9, minZ: -23, maxZ: -12 },
    { minX: 9, maxX: 12, minZ: -8, maxZ: 4 },
    { minX: -11, maxX: -4, minZ: 5, maxZ: 7 },
    { minX: 5, maxX: 12, minZ: 12, maxZ: 14 },
    { minX: -44, maxX: -40, minZ: -4, maxZ: 7 },
    { minX: 38, maxX: 42, minZ: 7, maxZ: 20 },
    { minX: 25, maxX: 32, minZ: -34, maxZ: -31 },
    { minX: 13, maxX: 20, minZ: 34, maxZ: 37 },
    // Extra corridor walls on the expanded Sandstone layout.
    { minX: -21, maxX: -11, minZ: -29.55, maxZ: -28.45 },
    { minX: -0.6, maxX: 0.6, minZ: -39, maxZ: -31 },
    { minX: 12.5, maxX: 21.5, minZ: -20.6, maxZ: -19.4 },
    { minX: -29.5, maxX: -18.5, minZ: 7.45, maxZ: 8.55 },
    { minX: 3.45, maxX: 4.55, minZ: 16.5, maxZ: 25.5 },
    { minX: 2.5, maxX: 11.5, minZ: -7.45, maxZ: -6.55 },
    { minX: -9, maxX: -1, minZ: 16.55, maxZ: 17.45 }
  ].map(blocker => ({
    minX: blocker.minX * 1.25,
    maxX: blocker.maxX * 1.25,
    minZ: blocker.minZ * 1.25,
    maxZ: blocker.maxZ * 1.25
  })),
  SMALL_YARD: [
    { minX: -28, maxX: -16, minZ: -11, maxZ: 11 },
    { minX: 16, maxX: 28, minZ: -11, maxZ: 11 },
    { minX: -5, maxX: 5, minZ: -5, maxZ: 5 },
    { minX: -13, maxX: -6, minZ: 15, maxZ: 17 },
    { minX: 6, maxX: 13, minZ: -17, maxZ: -15 },
    { minX: 8, maxX: 16, minZ: 23, maxZ: 25 },
    { minX: -16, maxX: -8, minZ: -25, maxZ: -23 }
  ],
  FIELD_ARENA: [
    { minX: -38, maxX: -26, minZ: 9, maxZ: 19 },
    { minX: 17, maxX: 31, minZ: 31, maxZ: 41 },
    { minX: 36, maxX: 52, minZ: -29, maxZ: -19 },
    { minX: -58, maxX: -42, minZ: -41, maxZ: -31 },
    { minX: -12, maxX: 12, minZ: 65, maxZ: 75 },
    { minX: 71, maxX: 81, minZ: 44, maxZ: 68 },
    { minX: -205, maxX: -175, minZ: -7, maxZ: 7 },
    { minX: 175, maxX: 205, minZ: -7, maxZ: 7 },
    { minX: -19, maxX: 19, minZ: 182, maxZ: 198 },
    { minX: -19, maxX: 19, minZ: -198, maxZ: -182 },
    { minX: -190, maxX: -170, minZ: 170, maxZ: 190 },
    { minX: 170, maxX: 190, minZ: -190, maxZ: -170 }
  ],
  NEON_YARD: [
    { minX: -57, maxX: -39, minZ: -47, maxZ: -33 },
    { minX: 39, maxX: 57, minZ: -47, maxZ: -33 },
    { minX: -57, maxX: -39, minZ: 33, maxZ: 47 },
    { minX: 39, maxX: 57, minZ: 33, maxZ: 47 },
    { minX: -9, maxX: 9, minZ: -83, maxZ: -69 },
    { minX: -9, maxX: 9, minZ: 69, maxZ: 83 },
    { minX: -5, maxX: 5, minZ: -16, maxZ: 16 }
  ],
  // M3 Maze is fully procedural now; every solid wall/cover rectangle is shared
  // with the client builder so movement and shot line-of-sight agree.
  M3_Maze: [
    { minX: -78, maxX: -74, minZ: -180, maxZ: -130 },
    { minX: -78, maxX: -74, minZ: -100, maxZ: -30 },
    { minX: -78, maxX: -74, minZ: 0, maxZ: 70 },
    { minX: -78, maxX: -74, minZ: 100, maxZ: 180 },
    { minX: 74, maxX: 78, minZ: -180, maxZ: -110 },
    { minX: 74, maxX: 78, minZ: -95, maxZ: -45 },
    { minX: 74, maxX: 78, minZ: -10, maxZ: 60 },
    { minX: 74, maxX: 78, minZ: 110, maxZ: 180 },
    { minX: -2, maxX: 2, minZ: -205, maxZ: -165 },
    { minX: -2, maxX: 2, minZ: -155, maxZ: -105 },
    { minX: -2, maxX: 2, minZ: -62.5, maxZ: -17.5 },
    { minX: -2, maxX: 2, minZ: 55, maxZ: 95 },
    { minX: -2, maxX: 2, minZ: 137.5, maxZ: 182.5 },
    { minX: -180, maxX: -130, minZ: -78, maxZ: -74 },
    { minX: -110, maxX: -60, minZ: -78, maxZ: -74 },
    { minX: 0, maxX: 70, minZ: -78, maxZ: -74 },
    { minX: 100, maxX: 180, minZ: -78, maxZ: -74 },
    { minX: -180, maxX: -130, minZ: 74, maxZ: 78 },
    { minX: -100, maxX: -30, minZ: 74, maxZ: 78 },
    { minX: 0, maxX: 80, minZ: 74, maxZ: 78 },
    { minX: 120, maxX: 180, minZ: 74, maxZ: 78 },
    { minX: -156, maxX: -144, minZ: -156, maxZ: -144 },
    { minX: 143, maxX: 157, minZ: -160, maxZ: -140 },
    { minX: -159, maxX: -141, minZ: 145, maxZ: 155 },
    { minX: 140, maxX: 160, minZ: 144, maxZ: 156 },
    { minX: -32, maxX: -18, minZ: -137, maxZ: -123 },
    { minX: 16, maxX: 28, minZ: 131, maxZ: 149 },
    { minX: -156, maxX: -134, minZ: 19, maxZ: 31 },
    { minX: 137.5, maxX: 152.5, minZ: -6, maxZ: 6 },
    { minX: -6, maxX: 6, minZ: -30, maxZ: -10 }
  ]
});

function mapPathBlocked(mapId, from, to, mapState = {}, radius = .42) {
  if (mapId === "HILL_TOWN") return hillTownPathBlocked(from, to, mapState);
  const bounds = SERVER_MAP_LIMITS[mapId];
  if (!bounds) return false;
  if (Math.abs(to.x) > bounds.x || Math.abs(to.z) > bounds.z) return true;

  for (const rect of (SERVER_MAP_BLOCKERS[mapId] || [])) {
    const expanded = {
      minX: rect.minX - radius, maxX: rect.maxX + radius,
      minZ: rect.minZ - radius, maxZ: rect.maxZ + radius
    };
    if (segmentIntersectsRect2d(from, to, expanded)) return true;
  }
  return false;
}

function nonHillMapShotBlocked(mapId, from, to) {
  const bounds = SERVER_MAP_LIMITS[mapId];
  if (!bounds) return false;
  if (Math.abs(to.x) > bounds.x || Math.abs(to.z) > bounds.z) return true;
  return (SERVER_MAP_BLOCKERS[mapId] || []).some(rect => segmentIntersectsRect2d(from, to, rect));
}

function isHillTownShotBlocked(from,to,mapState={}){
  if(Math.abs(to.x)>55||Math.abs(to.z)>47)return true;
  const doors=Array.isArray(mapState?.doors)?mapState.doors:[false,false,false];
  const crossesDivider=(from.x<0&&to.x>=0)||(from.x>0&&to.x<=0);
  if(crossesDivider){
    const denominator=to.x-from.x;
    const t=Math.abs(denominator)<1e-8?0:(0-from.x)/denominator;
    const z=from.z+(to.z-from.z)*t;
    const doorIndex=HILL_TOWN_DOOR_CENTERS.findIndex(([,centerZ])=>Math.abs(z-centerZ)<1.78);
    if(doorIndex<0||doors[doorIndex]!==true)return true;
  }
  for(const building of HILL_TOWN_BUILDINGS){
    if(segmentIntersectsRect2d(from,to,{minX:building.x-building.halfX,maxX:building.x+building.halfX,minZ:building.z-building.halfZ,maxZ:building.z+building.halfZ}))return true;
  }
  for(const [cx,cz,halfX,halfZ] of HILL_TOWN_COVER){
    if(segmentIntersectsRect2d(from,to,{minX:cx-halfX,maxX:cx+halfX,minZ:cz-halfZ,maxZ:cz+halfZ}))return true;
  }
  const destroyed=Array.isArray(mapState?.destroyedWood)?mapState.destroyedWood:[];
  for(let b=0;b<HILL_TOWN_BARRICADES.length;b++){
    const barrier=HILL_TOWN_BARRICADES[b],first=b*HILL_TOWN_PLANKS_PER_BARRICADE;
    if([0,1,2,3].some(part=>!destroyed.includes(first+part)) &&
      segmentIntersectsRect2d(from,to,{minX:barrier.x-.35,maxX:barrier.x+.35,minZ:barrier.z-1.7,maxZ:barrier.z+1.7}))return true;
  }
  return false;
}

function validateMapLineOfSight(mapId,from,to,mapState){
  if(mapId==="HILL_TOWN")return !isHillTownShotBlocked(from,to,mapState);
  return !nonHillMapShotBlocked(mapId,from,to);
}

function handleTeamShot(io, match, shooter, data) {
  if (!["team_fight", "allies"].includes(match.mode) || match.phase !== "game") return;

  const weaponId = normalizeWeaponId(data?.weapon);
  if (match.mode === "allies" && (!Array.isArray(shooter.weapons) || !shooter.weapons.includes(weaponId) || shooter.equippedWeapon !== weaponId)) return;
  const weapon = WEAPON_BALANCE[weaponId];
  const dx = Number(data?.dx), dy = Number(data?.dy), dz = Number(data?.dz);
  if (![dx, dy, dz].every(Number.isFinite)) return;
  const aim = new THREE_LIKE_VECTOR(dx, dy, dz);
  if (aim.length() < 0.01) return;
  aim.normalize();
  if (Math.hypot(aim.x, aim.z) < 0.01) return;

  const now = Date.now();
  if (now - (shooter.lastShotAt || 0) < weapon.fireDelay) return;
  shooter.lastShotAt = now;

  let best = null, bestDistance = Infinity;
  for (const target of match.players) {
    if (target.userId === shooter.userId || target.team === shooter.team || target.hp <= 0) continue;
    const vx = target.pos.x - shooter.pos.x, vz = target.pos.z - shooter.pos.z;
    const dist = Math.hypot(vx, vz);
    if (weapon.type === "melee" ? (dist > weapon.range || dist < 0.25) : (dist > weapon.range || dist < 0.5)) continue;
    const dot = (aim.x * vx + aim.z * vz) / (Math.max(0.01, Math.hypot(aim.x, aim.z)) * dist);
    if (dot < (weapon.type === "melee" ? 0.72 : 0.985)) continue;
    if (dist < bestDistance) { best = target; bestDistance = dist; }
  }

  const targetBlocked = Boolean(best) && !validateMapLineOfSight(match.map, shooter.pos, best.pos, match.mapState || {});
  if (weapon.type !== "melee") {
    const supplied = data?.impact;
    const suppliedDistance = supplied && [supplied.x, supplied.y, supplied.z].every(value => Number.isFinite(Number(value)))
      ? Math.hypot(Number(supplied.x) - shooter.pos.x, Number(supplied.y) - (shooter.pos.y + 1.42), Number(supplied.z) - shooter.pos.z)
      : Infinity;
    let impact = suppliedDistance <= weapon.range + 1
      ? { x: Number(supplied.x), y: Number(supplied.y), z: Number(supplied.z) }
      : null;
    // The server is authoritative about a hit impact; clients only suggest impacts on scenery.
    if (best && !targetBlocked) impact = { x: best.pos.x, y: best.pos.y + 1.05, z: best.pos.z };
    io.to(match.id).emit("player_shot", {
      shooterId: shooter.userId,
      x: shooter.pos.x, y: shooter.pos.y + 1.42, z: shooter.pos.z,
      dx: aim.x, dy: aim.y, dz: aim.z, weapon: weaponId, impact
    });
  }

  if (!best || targetBlocked) return;
  const hitZone = detectWeaponHitZone(shooter.pos, best.pos, aim, bestDistance);
  const damage = calculateWeaponDamage(weaponId, hitZone, bestDistance);
  best.hp = Math.max(0, best.hp - damage);
  const killed = best.hp <= 0;
  if (killed) {
    best.deaths += 1; shooter.kills += 1; shooter.score += 1;
    if (match.mode === "allies") shooter.cash = Math.min(16000, (Number(shooter.cash) || 0) + 300);
  }

  io.to(match.id).emit("player_hit", {
    shooterId: shooter.userId, targetId: best.userId,
    weapon: weaponId, hitZone, damage, killed, hp: best.hp, score: shooter.score
  });
  if (!killed) return;
  if (match.mode === "allies") {
    checkAlliesRoundWin(io, match);
    return;
  }

  setTimeout(() => {
    if (!activeMatches.has(match.id) || match.finished) return;
    respawnPlayer(match, best);
    io.to(match.id).emit("player_respawn", {
      userId: best.userId, x: best.pos.x, y: best.pos.y, z: best.pos.z, hp: best.hp
    });
  }, 1200);
}

class THREE_LIKE_VECTOR {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  normalize() {
    const len = this.length() || 1;
    this.x /= len; this.y /= len; this.z /= len;
    return this;
  }
}

function validateMove(player, data, mapId = null, mapState = {}) {
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
  let targetX=x,targetZ=z;
  if(planarDistance>maxStep){
    const scale=maxStep/planarDistance;
    targetX=prev.x+dx*scale;
    targetZ=prev.z+dz*scale;
  }
  if(mapId&&mapPathBlocked(mapId,prev,{x:targetX,z:targetZ},mapState))return false;
  // Player capsules block movement even when another player stands still.
  if (typeof activeMatches !== "undefined") {
    const liveMatch = [...activeMatches.values()].find(match => match.players.includes(player));
    if (liveMatch && liveMatch.phase === "game") {
      for (const other of liveMatch.players) {
        if (other === player || other.hp <= 0) continue;
        const previousDistance = Math.hypot(prev.x - other.pos.x, prev.z - other.pos.z);
        const targetDistance = Math.hypot(targetX - other.pos.x, targetZ - other.pos.z);
        if (targetDistance < 0.82 && targetDistance < previousDistance - 0.015) return false;
      }
    }
  }
  player.pos.x=targetX;
  player.pos.z=targetZ;
  player.pos.y = Math.max(0, Math.min(2.25, y));
  player.rotY = rotY;
  player.anim = ["Idle", "Running", "Jump", "Walking", "Crouch"].includes(data.anim) ? data.anim : "Idle";
  return true;
}

function handleCatch(io, match, hunter) {
  if (match.mode !== "hide_seek" || match.phase !== "game" || hunter.role !== "hunter") return;

  for (const target of match.players) {
    if (target.role !== "runner") continue;
    const dx = hunter.pos.x - target.pos.x;
    const dz = hunter.pos.z - target.pos.z;
    if (Math.hypot(dx, dz) > 2.2) continue;

    hunter.score += 1;
    for (const p of match.players) {
      p.role = p.userId === target.userId ? "hunter" : "runner";
      respawnPlayer(match, p);
    }

    io.to(match.id).emit("roles_updated", {
      players: match.players.map(p => ({
        userId: p.userId,
        role: p.role,
        score: p.score,
        spawn: p.spawn
      })),
      message: hunter.nickname + " спіймав " + target.nickname + "!"
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
  globalSocketServer = io;
  const cookies = parseCookies(socket.handshake.headers.cookie || "");
  socket.user = sessionUserFromToken(cookies.standoffx_session);

  if (!socket.user || (socket.user.isBanned && socket.user.id !== ADMIN_ID)) {
    socket.emit("auth_required");
    socket.disconnect(true);
    return;
  }

  socket.user.status = true;
  saveUsers();

  socket.on("start_training", data => {
    const user = socket.user;
    const mode = cleanText(data?.mode, 32);
    const cfg = TESTER_MODE_CONFIGS[mode];
    if (!cfg) return socket.emit("training_error", { message: "Невідомий тестовий режим." });
    if (!canUseTesterModes(user) && mode !== "field_test") {
      return socket.emit("training_error", { message: "Цей режим доступний лише тестерам." });
    }

    const prototype = mode === "field_test" && data?.prototype === true;
    const gameMode = ["allies", "team_fight"].includes(data?.gameMode) ? data.gameMode : "team_fight";
    const previous = trainingSessions.get(user.id);
    const sessionMap = ["field_test", "training"].includes(mode) ? normalizeMapId(data?.map) : cfg.map;
    const TRAINING_SPAWNS = {
      HILL_TOWN: {x:-42,y:0,z:0},
      NEON_YARD: {x:0,y:0,z:115},
      SANDSTONE: {x:0,y:0,z:0},
      SMALL_YARD: {x:0,y:0,z:0},
      FIELD_ARENA: {x:0,y:0,z:0},
      M3_Maze: {x:5,y:0,z:5}
    };
    const spawnPosition = { ...(TRAINING_SPAWNS[sessionMap] || {x:0,y:0,z:0}) };
    const session = {
      id: "practice_" + crypto.randomBytes(10).toString("hex"),
      userId: user.id,
      nickname: user.nickname,
      mode: cfg.id,
      gameMode: prototype ? gameMode : null,
      prototype,
      modeName: prototype ? (gameMode === "allies" ? "ПРОТОТИП · СОЮЗНИКИ" : "ПРОТОТИП · КБ") : cfg.name,
      map: sessionMap,
      mapState: sessionMap === "HILL_TOWN" ? createMapInteractionState() : null,
      socketId: socket.id,
      playerPos: spawnPosition,
      playerRotY: 0,
      bot: ["field_test", "training"].includes(mode) ? { id: "training_bot", nickname: "ТРЕНУВАЛЬНА МІШЕНЬ", role: "runner", team: "B", hp: 100, maxHp: 100, hits: 0, x: spawnPosition.x, y: 0, z: spawnPosition.z - 8, rotY: Math.PI, action: "idle", updatedAt: Date.now() } : null,
      spawnPosition: { ...spawnPosition },
      lastMoveAt: 0,
      lastActionAt: 0,
      lastShotAt: 0,
      createdAt: Date.now()
    };
    if (previous?.bot?.despawnTimer) clearTimeout(previous.bot.despawnTimer);
    if (previous?.botTimer) clearInterval(previous.botTimer);
    trainingSessions.set(user.id, session);
    if(session.mode==="field_test"&&session.bot&&!session.prototype){
      session.botTimer=setInterval(()=>{
        const current=trainingSessions.get(user.id);
        if(current!==session||!current.bot||current.bot.hp<=0||!current.socketId)return;
        const bot=current.bot,p=current.playerPos;
        const dx=p.x-bot.x,dz=p.z-bot.z,dist=Math.hypot(dx,dz)||1;
        bot.rotY=Math.atan2(-dx,-dz);
        if(dist>3){
          const step=Math.min(.48,dist-2.4),target={x:bot.x+dx/dist*step,z:bot.z+dz/dist*step};
          if(current.map!=="HILL_TOWN"||!hillTownPathBlocked({x:bot.x,z:bot.z},target,current.mapState||{})){
            bot.x=target.x;bot.z=target.z;bot.action="running";
          }else{
            bot.rotY+=Math.PI/2;bot.action="idle";
          }
        }else{
          bot.action="idle";
        }
        bot.updatedAt=Date.now();
        io.to(current.id).emit("training_state",{bot});
      },260);
    }
    socket.emit("training_started", {
      trainingId: session.id,
      userId: user.id,
      mode: cfg.id,
      gameMode: session.gameMode,
      prototype: session.prototype,
      modeName: session.modeName,
      map: session.map,
      uuid: user.uuid
    });
  });

  socket.on("join_training", data => {
    const user = socket.user;
    const session = trainingSessions.get(user.id);
    if (!session || (!canUseTesterModes(user) && session.mode !== "field_test")) {
      return socket.emit("kick_to_menu", { reason: "Режим доступний лише для дозволених тестових сесій." });
    }
    if (session.id !== cleanText(data?.trainingId, 100)) {
      return socket.emit("kick_to_menu", { reason: "Тренувальну сесію не знайдено." });
    }
    session.socketId = socket.id;
    socket.join(session.id);
    socket.emit("training_init", {
      trainingId: session.id,
      mode: session.mode,
      gameMode: session.gameMode,
      prototype: session.prototype,
      modeName: session.modeName,
      map: session.map,
      mapState: session.mapState || null,
      spawn: { ...session.playerPos },
      bot: session.bot
    });
    if (session.bot) socket.emit("training_state", { bot: session.bot });
  });

  socket.on("training_move", data => {
    const session = trainingSessions.get(socket.user?.id);
    if (!session || session.socketId !== socket.id || session.id !== cleanText(data?.trainingId, 100)) return;
    const now = Date.now();
    if (now - session.lastMoveAt < 33) return;
    session.lastMoveAt = now;
    const x = Number(data.x), y = Number(data.y), z = Number(data.z), rotY = Number(data.rotY);
    const viewY = Number(data.viewY);
    if (![x, y, z, rotY].every(Number.isFinite)) return;

    const previous = session.playerPos;
    const maxStep = 0.9;
    const dx = x - previous.x, dz = z - previous.z;
    const distance = Math.hypot(dx, dz);
    const target=distance>maxStep
      ?{x:previous.x+dx/distance*maxStep,z:previous.z+dz/distance*maxStep}
      :{x,z};
    if(mapPathBlocked(session.map,previous,target,session.mapState||{})){
      socket.emit("player_position_correction",{
        trainingId:session.id,x:previous.x,y:previous.y,z:previous.z,rotY:session.playerRotY||0
      });
      return;
    }
    previous.x=target.x;
    previous.z=target.z;
    previous.y = Math.max(0, Math.min(2.25, y));
    session.playerRotY = Number.isFinite(viewY) ? viewY : rotY;
  });

  socket.on("training_spawn_bot", data => {
    const session = trainingSessions.get(socket.user?.id);
    if (!session || session.prototype || session.socketId !== socket.id || session.id !== cleanText(data?.trainingId, 100)) return;
    if (session.bot) {
      socket.emit("training_state", { bot: session.bot, message: "Бот уже створений." });
      return;
    }
    const now = Date.now();
    if (now - session.lastActionAt < 250) return;
    session.lastActionAt = now;

    const p = session.playerPos;
    const angle = session.playerRotY || 0;
    session.bot = {
      id: "training_bot",
      nickname: "Training Bot",
      role: "runner",
      team: "B",
      hp: 100,
      maxHp: 100,
      hits: 0,
      x: p.x - Math.sin(angle) * 3,
      y: 0,
      z: p.z - Math.cos(angle) * 3,
      rotY: angle + Math.PI,
      action: "idle",
      updatedAt: Date.now()
    };
    io.to(session.id).emit("training_state", { bot: session.bot, message: "Бота створено." });
  });

  socket.on("training_remove_bot", data => {
    const session = trainingSessions.get(socket.user?.id);
    if (!session || session.prototype || session.socketId !== socket.id || session.id !== cleanText(data?.trainingId, 100)) return;
    const now = Date.now();
    if (now - session.lastActionAt < 180) return;
    session.lastActionAt = now;
    session.bot = null;
    io.to(session.id).emit("training_state", { bot: null, message: "Бота видалено." });
  });

  socket.on("training_bot_action", data => {
    const session = trainingSessions.get(socket.user?.id);
    if (!session || session.prototype || session.socketId !== socket.id || session.id !== cleanText(data?.trainingId, 100) || !session.bot) return;
    const now = Date.now();
    if (now - session.lastActionAt < 180) return;
    session.lastActionAt = now;

    const action = cleanText(data?.action, 16);
    const bot = session.bot;
    const p = session.playerPos;
    let dx = bot.x - p.x, dz = bot.z - p.z;
    let dist = Math.hypot(dx, dz) || 1;
    dx /= dist; dz /= dist;

    if (action === "push" || action === "kick") {
      const force = action === "kick" ? 4.5 : 2.0;
      bot.x += dx * force;
      bot.z += dz * force;
      bot.hp = Math.max(0, bot.hp - (action === "kick" ? 25 : 8));
      bot.hits += 1;
      bot.action = action;
      if (bot.hp <= 0) {
        bot.action = "knocked-out";
        bot.x = p.x + dx * 2.5;
        bot.z = p.z + dz * 2.5;
        setTimeout(() => {
          const current = trainingSessions.get(session.userId);
          if (!current || current.id !== session.id || !current.bot || current.bot.id !== bot.id) return;
          current.bot.hp = current.bot.maxHp;
          current.bot.action = "idle";
          current.bot.updatedAt = Date.now();
          io.to(current.id).emit("training_state", { bot: current.bot, message: "Бот відновився." });
        }, 1200);
      }
    } else if (action === "boost") {
      bot.y = 1.5;
      bot.action = "boost";
      setTimeout(() => {
        const current = trainingSessions.get(session.userId);
        if (!current || current.id !== session.id || current.bot !== bot) return;
        bot.y = 0;
        bot.action = "idle";
        io.to(current.id).emit("training_state", { bot });
      }, 650);
    } else if (action === "reset") {
      bot.x = p.x + dx * 3;
      bot.y = 0;
      bot.z = p.z + dz * 3;
      bot.hp = bot.maxHp;
      bot.action = "idle";
    } else {
      return;
    }

    bot.updatedAt = Date.now();
    io.to(session.id).emit("training_state", { bot, message: action });
  });

  socket.on("training_shoot", data => {
    const session = trainingSessions.get(socket.user?.id);
    if (!session || session.socketId !== socket.id || session.id !== cleanText(data?.trainingId, 100) || !session.bot) return;
    if (session.mode !== "field_test" && session.mode !== "training") return;

    const weaponId = normalizeWeaponId(data?.weapon);
    const weapon = WEAPON_BALANCE[weaponId];
    const dx = Number(data.dx), dy = Number(data.dy), dz = Number(data.dz);
    if (![dx, dy, dz].every(Number.isFinite)) return;
    const length = Math.hypot(dx, dy, dz) || 1;
    const aim = { x: dx / length, y: dy / length, z: dz / length };
    if (Math.hypot(aim.x, aim.z) < 0.01) return;
    const now = Date.now();
    if (now - (session.lastShotAt || 0) < weapon.fireDelay) return;
    session.lastShotAt = now;

    const bot = session.bot;
    const vx = bot.x - session.playerPos.x;
    const vz = bot.z - session.playerPos.z;
    const dist = Math.hypot(vx, vz);
    if (weapon.type === "melee" ? (dist > weapon.range || dist < 0.25) : (dist > weapon.range || dist < 0.5)) return;
    const dot = (aim.x * vx + aim.z * vz) / (Math.max(0.01, Math.hypot(aim.x, aim.z)) * dist);
    if (dot < (weapon.type === "melee" ? 0.72 : 0.975)) return;

    const hitZone = detectWeaponHitZone(session.playerPos, { x: bot.x, y: bot.y || 0, z: bot.z }, aim, dist);
    const damage = calculateWeaponDamage(weaponId, hitZone, dist);
    bot.hp = Math.max(0, bot.hp - damage);
    bot.hits += 1;
    bot.action = bot.hp <= 0 ? "knocked-out" : "hit";
    bot.updatedAt = now;
    io.to(session.id).emit("training_state", { bot, hit: true, hitDamage: damage, hitZone, weapon: weaponId, message: "HIT" });
    if (bot.hp <= 0) {
      setTimeout(() => {
        const current = trainingSessions.get(session.userId);
        if (!current || current.id !== session.id || !current.bot) return;
        current.bot.hp = current.bot.maxHp;
        current.bot.action = "idle";
        current.bot.updatedAt = Date.now();
        io.to(current.id).emit("training_state", { bot: current.bot, message: "Бот відновився." });
      }, 1200);
    }
  });

  socket.on("training_reset", data => {
    const session = trainingSessions.get(socket.user?.id);
    if (!session || session.socketId !== socket.id || session.id !== cleanText(data?.trainingId, 100)) return;
    session.playerPos = { ...(session.spawnPosition || (session.mode === "training" ? { x: 5, y: 0, z: 5 } : { x: 0, y: 0, z: 0 })) };
    session.playerRotY = 0;
    session.bot = {
      id: "training_bot", nickname: "ТРЕНУВАЛЬНА МІШЕНЬ", role: "runner", team: "B",
      hp: 100, maxHp: 100, hits: 0,
      x: session.playerPos.x, y: 0, z: session.playerPos.z - 8,
      rotY: Math.PI, action: "idle", updatedAt: Date.now()
    };
    io.to(session.id).emit("training_state", { bot: session.bot, spawn: { ...session.playerPos }, reset: true, message: "Тренування скинуто." });
  });

  socket.on("end_training", data => {
    const session = trainingSessions.get(socket.user?.id);
    if (!session || session.id !== cleanText(data?.trainingId, 100)) return;
    if (session.socketId !== null && session.socketId !== socket.id) return;
    if(session.botTimer)clearInterval(session.botTimer);
    trainingSessions.delete(socket.user.id);
  });

  socket.on("lobby_state_request", () => {
    const current = lobbyMemberFromSocket(socket);
    if (current) emitLobbyState(io, current.lobby);
    else socket.emit("lobby_left", { reason: "Ти не перебуваєш у лобі." });
  });
  socket.on("lobby_create", data => {
    const user = socket.user;
    if (!user || playerMatch(user.uuid || user.id)) return emitLobbyError(socket, "Ти вже перебуваєш у матчі.");
    if (lobbyByUser.has(user.id)) return emitLobbyError(socket, "Ти вже в лобі.");
    const mode = ["allies", "team_fight"].includes(data?.mode) ? data.mode : "allies";
    const requestedMap = normalizeMapId(data?.map);
    const map = mode === "allies" ? "SANDSTONE" : (requestedMap === "NEON_YARD" ? "NEON_YARD" : "SMALL_YARD");
    const lobbyId = "lobby_" + crypto.randomBytes(7).toString("hex");
    const lobby = {
      id: lobbyId, ownerId: user.id, mode, map, maxPlayers: getRequiredPlayers(mode),
      createdAt: Date.now(),
      members: [{
        userId: user.id, uuid: user.uuid || "", socketId: socket.id,
        nickname: user.nickname, playerAvatar: user.playerAvatar || "/avatars/default.jpg"
      }]
    };
    activeLobbies.set(lobbyId, lobby);
    lobbyByUser.set(user.id, lobbyId);
    socket.emit("lobby_created", { lobbyId });
    emitLobbyState(io, lobby);
  });
  socket.on("lobby_invite", data => inviteFriendToLobby(io, socket, normalizeId(data?.userId)));
  socket.on("lobby_invite_response", data => {
    const targetId = socket.user?.id;
    const invite = targetId ? lobbyInvites.get(targetId) : null;
    if (!invite || invite.lobbyId !== cleanText(data?.lobbyId, 100) || invite.expiresAt < Date.now()) {
      if (targetId) lobbyInvites.delete(targetId);
      return emitLobbyError(socket, "Запрошення вже недійсне.", "lobby_invite_response_result");
    }
    lobbyInvites.delete(targetId);
    if (data?.accept !== true) {
      socket.emit("lobby_invite_response_result", { success: true, accepted: false, message: "Запрошення відхилено." });
      const lobby = activeLobbies.get(invite.lobbyId);
      const inviter = lobby?.members.find(member => member.userId === invite.invitedBy);
      if (inviter?.socketId) io.to(inviter.socketId).emit("lobby_notice", { message: socket.user.nickname + " відхилив запрошення." });
      return;
    }
    if (lobbyByUser.has(targetId) || playerMatch(socket.user.uuid || socket.user.id)) {
      return emitLobbyError(socket, "Ти вже в лобі або матчі.", "lobby_invite_response_result");
    }
    const lobby = activeLobbies.get(invite.lobbyId);
    if (!lobby || lobby.members.length >= lobby.maxPlayers) return emitLobbyError(socket, "Лобі вже заповнене або закрите.", "lobby_invite_response_result");
    const user = users.find(candidate => candidate.id === targetId);
    if (!user) return emitLobbyError(socket, "Акаунт не знайдено.", "lobby_invite_response_result");
    lobby.members.push({
      userId: user.id, uuid: user.uuid || "", socketId: socket.id,
      nickname: user.nickname, playerAvatar: user.playerAvatar || "/avatars/default.jpg"
    });
    lobbyByUser.set(user.id, lobby.id);
    socket.join(lobby.id);
    socket.emit("lobby_invite_response_result", { success: true, accepted: true, message: "Ти приєднався до лобі." });
    emitLobbyState(io, lobby);
  });
  socket.on("lobby_leave", () => {
    removeLobbyMember(io, socket.user?.id, socket.id);
    socket.emit("lobby_left", { reason: "Ти вийшов із лобі." });
  });
  socket.on("lobby_kick", data => {
    const current = lobbyMemberFromSocket(socket);
    if (!current || current.lobby.ownerId !== socket.user.id) return emitLobbyError(socket, "Видаляти гравців може лише лідер лобі.");
    const targetId = normalizeId(data?.userId);
    if (targetId === socket.user.id) return;
    const target = current.lobby.members.find(member => member.userId === targetId);
    if (!target) return;
    removeLobbyMember(io, targetId, target.socketId, "Тебе видалили з лобі.");
    if (target.socketId) io.to(target.socketId).emit("lobby_left", { reason: "Тебе видалили з лобі." });
  });
  socket.on("lobby_start_match", data => createLobbyMatch(io, socket, data || {}));

  socket.on("start_prototype_match", data => {
    const user = socket.user;
    if (!user || (user.isBanned && user.id !== ADMIN_ID)) {
      socket.emit("auth_required");
      return;
    }
    if (playerMatch(user.uuid || user.id)) {
      socket.emit("search_error", { message: "Ти вже перебуваєш у матчі." });
      return;
    }

    const mode = ["allies", "team_fight"].includes(data?.mode) ? data.mode : "allies";
    const requestedMap = normalizeMapId(data?.map);
    const map = mode === "allies" ? "SANDSTONE" : (requestedMap === "NEON_YARD" ? "NEON_YARD" : "SMALL_YARD");
    removeFromQueue(user.uuid || user.id);

    const botCandidate = (nickname, suffix) => ({
      socketId: null,
      userId: "prototype_bot_" + crypto.randomBytes(8).toString("hex"),
      uuid: "",
      isBot: true,
      prototypeBot: true,
      nickname,
      playerAvatar: "/avatars/default.jpg",
      mode,
      map,
      botSlot: suffix
    });
    const humanCandidate = {
      socketId: socket.id,
      userId: user.id,
      nickname: user.nickname,
      playerAvatar: user.playerAvatar || "/avatars/default.jpg",
      uuid: user.uuid || "",
      isBot: false,
      mode,
      map
    };
    const bots = mode === "allies"
      ? [botCandidate("BOT · СОЮЗНИК", "ally"), botCandidate("BOT · ПРОТИВНИК 1", "enemy1"), botCandidate("BOT · ПРОТИВНИК 2", "enemy2")]
      : [botCandidate("BOT · ПРОТИВНИК 1", "enemy1"), botCandidate("BOT · ПРОТИВНИК 2", "enemy2")];
    createMatch(io, mode, map, [humanCandidate, ...bots]);
  });

  socket.on("start_search", data => {
    const user = socket.user;
    if (playerMatch(user.uuid || user.id)) return socket.emit("search_error", { message: "Ти вже в матчі." });
    const existingQueueIndex = matchmakingQueue.findIndex(p => p.userId === user.id);
    if (existingQueueIndex !== -1) {
      const [existing] = matchmakingQueue.splice(existingQueueIndex, 1);
      if (existing.socketId && existing.socketId !== socket.id) {
        io.to(existing.socketId).emit("search_error", { message: "Пошук перенесено в інше вікно." });
      }
    }

    const mode = ["allies", "team_fight"].includes(data?.mode) ? data.mode : "allies";
    const requestedMap = normalizeMapId(data?.map);
    const map = mode === "allies" ? "SANDSTONE" : (requestedMap === "NEON_YARD" ? "NEON_YARD" : "SMALL_YARD");
    removeFromQueue(user.uuid || user.id);

    matchmakingQueue.push({
      socketId: socket.id,
      userId: user.id,
      nickname: user.nickname,
      playerAvatar: user.playerAvatar || "/avatars/default.jpg",
      uuid: user.uuid,
      mode,
      map
    });

    socket.emit("search_started", { mode, modeName: MODE_CONFIGS[mode].name, map, mapName: PLAYABLE_MAPS[map].name });
    emitQueueCount(io);
    createMatch(io, mode, map);
  });

  socket.on("cancel_search", () => {
    if (removeFromQueue(socket.user.uuid || socket.user.id, socket.id)) emitQueueCount(io);
  });

  socket.on("leave_match", data => {
    const matchId = cleanText(data?.matchId, 100);
    const match = activeMatches.get(matchId);
    if (!match) return;

    const index = match.players.findIndex(p => (p.uuid ? p.uuid === socket.user.uuid : p.userId === socket.user.id));
    if (index < 0) return;

    const player = match.players[index];
    if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
    if (player.socketId && player.socketId !== socket.id) {
      const gameplaySocket = io.sockets.sockets.get(player.socketId);
      if (gameplaySocket) {
        gameplaySocket.emit("go_to_menu");
        gameplaySocket.leave(matchId);
      }
    }
    player.socketId = null;
    socket.leave(matchId);

    if (match.phase !== "game") {
      cleanMatch(io, matchId, true);
      return;
    }

    match.players.splice(index, 1);
    io.to(matchId).emit("player_left", { userId: player.userId });
    if (match.players.filter(p => !p.isBot).length === 0 || match.players.length < 2) cleanMatch(io, matchId, true);
    else emitMatchWaiting(io, match);
  });

  socket.on("join_room", data => {
    const matchId = cleanText(data?.matchId, 100);
    const match = activeMatches.get(matchId);
    if (!match) return socket.emit("kick_to_menu", { reason: "Матч не знайдено." });

    const player = match.players.find(p => p.uuid ? p.uuid === socket.user.uuid : p.userId === socket.user.id);
    if (!player) return socket.emit("kick_to_menu", { reason: "Гравця немає в цьому матчі." });

    // A reconnect replaces the old socket for this user.
    if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
    player.socketId = socket.id;
    player.disconnectTimer = null;
    player.joinedAt = Date.now();
    socket.join(matchId);
    io.to(matchId).emit("player_connection_state", { userId: player.userId, connected: true });

    socket.emit("init_match", {
      matchId,
      map: match.map,
      mode: match.mode,
      modeName: match.modeName,
      prototype: Boolean(match.prototypeBotMatch),
      mapState: match.mapState || null,
      round: match.mode === "allies" ? alliesRoundPayload(match) : null,
      droppedItems: Array.isArray(match.droppedItems) ? match.droppedItems.map(item => ({ ...item, position: { ...item.position } })) : [],
      me: {
        userId: player.userId,
        uuid: player.uuid || "",
        nickname: player.nickname,
        playerAvatar: player.playerAvatar || "/avatars/default.jpg",
        role: player.role,
        team: player.team,
        hp: player.hp,
        score: player.score,
        spawn: player.spawn,
        position: player.pos
      },
      players: match.players.map(p => ({
        userId: p.userId,
        nickname: p.nickname,
        playerAvatar: p.playerAvatar || "/avatars/default.jpg",
        isBot: Boolean(p.isBot),
        role: p.role,
        team: p.team,
        score: p.score,
        hp: p.hp,
        x: p.pos.x,
        y: p.pos.y,
        z: p.pos.z,
        rotY: p.rotY,
        anim: p.anim,
        connected: p.isBot || Boolean(p.socketId)
      }))
    });
    if (match.mode === "allies") emitAlliesLoadout(io, match, player);

    for (const other of match.players) {
      if ((other.uuid ? other.uuid !== player.uuid : other.userId !== player.userId) && other.socketId) {
        socket.emit("enemy_moved", {
          id: other.socketId,
          userId: other.userId,
          nickname: other.nickname,
          role: other.role,
          team: other.team,
          hp: other.hp,
          x: other.pos.x,
          y: other.pos.y,
          z: other.pos.z,
          rotY: other.rotY,
          anim: other.anim,
          score: other.score
        });
      }
    }

    emitMatchWaiting(io, match);
    if (match.mode === "allies") {
      socket.emit("allies_round_start", alliesRoundPayload(match));
      socket.emit("bomb_state", bombPublicState(match));
      if (match.phase === "game") socket.emit("allies_round_live", alliesRoundPayload(match));
      socket.emit("match_phase", {
        phase: match.phase,
        time: match.phase === "round_start" ? match.phaseRemaining : match.roundRemaining,
        mode: match.mode, modeName: match.modeName,
        roundNumber: match.roundNumber, roundWins: { ...match.roundWins },
        attackingTeam: match.attackingTeam, defendingTeam: match.defendingTeam
      });
    }
    if (match.phase === "game") {
      socket.emit("match_phase", {
        phase: "game",
        time: match.mode === "allies" ? match.roundRemaining : match.remaining,
        mode: match.mode,
        modeName: match.modeName
      });
      socket.emit("match_start_now", { mode: match.mode, modeName: match.modeName, reconnect: true });
      socket.emit("timer_update", { phase: "game", time: match.mode === "allies" ? match.roundRemaining : match.remaining });
    } else if (match.phase === "round_start" || match.phase === "round_end") {
      // The reconnecting player receives the current round/intermission state above.
    } else {
      startMatchWhenReady(io, match);
    }
  });

  socket.on("client_ready", data => {
    const matchId = cleanText(data?.matchId, 100);
    const match = activeMatches.get(matchId);
    if (!match) return;

    const player = match.players.find(p => p.uuid ? p.uuid === socket.user.uuid : p.userId === socket.user.id);
    if (!player || player.socketId !== socket.id) return;

    player.ready = true;
    emitMatchWaiting(io, match);
    startMatchWhenReady(io, match);
  });

  socket.on("drop_item", data => {
    const match = activeMatches.get(cleanText(data?.matchId, 100));
    if (!match) return;
    const player = match.players.find(p => (p.uuid ? p.uuid === socket.user.uuid : p.userId === socket.user.id) && p.socketId === socket.id);
    if (!player) return;
    handleDropItem(io, match, player, data);
  });
  socket.on("pickup_item", data => {
    const match = activeMatches.get(cleanText(data?.matchId, 100));
    if (!match) return;
    const player = match.players.find(p => (p.uuid ? p.uuid === socket.user.uuid : p.userId === socket.user.id) && p.socketId === socket.id);
    if (!player) return;
    handlePickupItem(io, match, player, data);
  });
  socket.on("allies_buy", data => {
    const match = activeMatches.get(cleanText(data?.matchId, 100));
    if (!match) return;
    const player = match.players.find(p => (p.uuid ? p.uuid === socket.user.uuid : p.userId === socket.user.id) && p.socketId === socket.id);
    if (!player) return;
    handleAlliesBuy(io, match, player, data);
  });
  socket.on("allies_select_weapon", data => {
    const match = activeMatches.get(cleanText(data?.matchId, 100));
    if (!match) return;
    const player = match.players.find(p => (p.uuid ? p.uuid === socket.user.uuid : p.userId === socket.user.id) && p.socketId === socket.id);
    if (!player) return;
    handleAlliesSelectWeapon(io, match, player, data);
  });
  socket.on("team_shoot", data => {
    const match = activeMatches.get(cleanText(data?.matchId, 100));
    if (!match) return;
    const player = match.players.find(p => (p.uuid ? p.uuid === socket.user.uuid : p.userId === socket.user.id) && p.socketId === socket.id);
    if (!player || player.hp <= 0) return;
    handleTeamShot(io, match, player, data);
  });

  socket.on("bomb_action", data => {
    const match = activeMatches.get(cleanText(data?.matchId, 100));
    if (!match) return;
    const player = match.players.find(p => (p.uuid ? p.uuid === socket.user.uuid : p.userId === socket.user.id) && p.socketId === socket.id);
    if (!player || player.hp <= 0) return;
    handleBombAction(io, match, player, data);
  });

  socket.on("map_door_shot", data => {
    const doorIndex=Number(data?.doorIndex),weaponId=normalizeWeaponId(data?.weapon),weapon=WEAPON_BALANCE[weaponId];
    if(!Number.isInteger(doorIndex)||doorIndex<0||doorIndex>=HILL_TOWN_DOOR_CENTERS.length||weapon.type==="melee")return;
    const dx=Number(data?.dx),dy=Number(data?.dy),dz=Number(data?.dz);
    if(![dx,dy,dz].every(Number.isFinite))return;
    const aimLength=Math.hypot(dx,dy,dz);
    if(aimLength<.01)return;
    const aim={x:dx/aimLength,y:dy/aimLength,z:dz/aimLength};
    const checkHit=(position)=>{
      const [x,z]=HILL_TOWN_DOOR_CENTERS[doorIndex],vx=x-position.x,vz=z-position.z,dist=Math.hypot(vx,vz);
      const horizontalAim=Math.hypot(aim.x,aim.z);
      if(dist<.5||dist>weapon.range||horizontalAim<.01)return false;
      const dot=(aim.x*vx+aim.z*vz)/(horizontalAim*dist);
      const offAxis=Math.abs(aim.x*vz-aim.z*vx)/horizontalAim;
      const predictedY=(Number(position.y)||0)+1.42+(aim.y/horizontalAim)*dist;
      return dot>.994&&offAxis<1.65&&predictedY>.05&&predictedY<2.7;
    };
    const match=activeMatches.get(cleanText(data?.matchId,100));
    if(match){
      const player=match.players.find(p=>(p.uuid?p.uuid===socket.user.uuid:p.userId===socket.user.id)&&p.socketId===socket.id);
      if(!player||player.hp<=0||match.phase!=="game"||match.map!=="HILL_TOWN"||!checkHit(player.pos))return;
      if(!match.mapState)match.mapState=createMapInteractionState();
      if(match.mapState.doors[doorIndex])return;
      match.mapState.doors[doorIndex]=true;
      io.to(match.id).emit("map_door_state",{doorIndex,open:true,byShot:true});
      return;
    }
    const session=trainingSessions.get(socket.user?.id);
    if(!session||session.socketId!==socket.id||session.id!==cleanText(data?.trainingId,100)||session.map!=="HILL_TOWN"||!checkHit(session.playerPos))return;
    if(!session.mapState)session.mapState=createMapInteractionState();
    if(session.mapState.doors[doorIndex])return;
    session.mapState.doors[doorIndex]=true;
    io.to(session.id).emit("map_door_state",{doorIndex,open:true,byShot:true});
  });

  socket.on("map_door_state", data => {
    const doorIndex = Number(data?.doorIndex);
    const open = data?.open === true;
    if (!Number.isInteger(doorIndex) || doorIndex < 0 || doorIndex >= HILL_TOWN_DOOR_CENTERS.length) return;
    const match = activeMatches.get(cleanText(data?.matchId, 100));
    if (match) {
      const player = match.players.find(p => (p.uuid ? p.uuid === socket.user.uuid : p.userId === socket.user.id) && p.socketId === socket.id);
      if (!player || player.hp <= 0 || match.map !== "HILL_TOWN") return;
      const [x,z] = HILL_TOWN_DOOR_CENTERS[doorIndex];
      if (Math.hypot(player.pos.x-x, player.pos.z-z) > 7.5) return;
      if (!match.mapState) match.mapState=createMapInteractionState();
      match.mapState.doors[doorIndex]=open;
      io.to(match.id).emit("map_door_state", { doorIndex, open });
      return;
    }
    const session = trainingSessions.get(socket.user?.id);
    if (!session || session.socketId !== socket.id || session.id !== cleanText(data?.trainingId, 100) || session.map !== "HILL_TOWN") return;
    const [x,z] = HILL_TOWN_DOOR_CENTERS[doorIndex];
    if (Math.hypot(session.playerPos.x-x, session.playerPos.z-z) > 7.5) return;
    if (!session.mapState) session.mapState=createMapInteractionState();
    session.mapState.doors[doorIndex]=open;
    io.to(session.id).emit("map_door_state", { doorIndex, open });
  });

  socket.on("map_wood_destroyed", data => {
    const woodIndex = Number(data?.woodIndex);
    const totalWoodParts = HILL_TOWN_BARRICADES.length * HILL_TOWN_PLANKS_PER_BARRICADE;
    if (!Number.isInteger(woodIndex) || woodIndex < 0 || woodIndex >= totalWoodParts) return;
    const barricade = HILL_TOWN_BARRICADES[Math.floor(woodIndex / HILL_TOWN_PLANKS_PER_BARRICADE)];
    const match = activeMatches.get(cleanText(data?.matchId, 100));
    if (match) {
      const player = match.players.find(p => (p.uuid ? p.uuid === socket.user.uuid : p.userId === socket.user.id) && p.socketId === socket.id);
      if (!player || player.hp <= 0 || match.map !== "HILL_TOWN") return;
      if (Math.hypot(player.pos.x-barricade.x, player.pos.z-barricade.z) > 20) return;
      if (!match.mapState) match.mapState=createMapInteractionState();
      if (!match.mapState.destroyedWood.includes(woodIndex)) match.mapState.destroyedWood.push(woodIndex);
      io.to(match.id).emit("map_wood_destroyed", { woodIndex });
      return;
    }
    const session = trainingSessions.get(socket.user?.id);
    if (!session || session.socketId !== socket.id || session.id !== cleanText(data?.trainingId, 100) || session.map !== "HILL_TOWN") return;
    if (Math.hypot(session.playerPos.x-barricade.x, session.playerPos.z-barricade.z) > 20) return;
    if (!session.mapState) session.mapState=createMapInteractionState();
    if (!session.mapState.destroyedWood.includes(woodIndex)) session.mapState.destroyedWood.push(woodIndex);
    io.to(session.id).emit("map_wood_destroyed", { woodIndex });
  });

  socket.on("player_moved", data => {
    const match = activeMatches.get(cleanText(data?.matchId, 100));
    if (!match) return;
    const player = match.players.find(p => p.userId === socket.user.id);
    if (!player || player.socketId !== socket.id || player.hp <= 0) return;
    if (match.mode === "allies" && match.phase !== "game") return;
    if (!validateMove(player, data, match.map, match.mapState || {})) {
      socket.emit("player_position_correction", {
        matchId: match.id, x: player.pos.x, y: player.pos.y, z: player.pos.z, rotY: player.rotY
      });
      return;
    }

    if (match.phase === "game") handleCatch(io, match, player);

    socket.to(match.id).emit("enemy_moved", {
      id: socket.id,
      userId: player.userId,
      nickname: player.nickname,
      role: player.role,
      team: player.team,
      hp: player.hp,
      x: player.pos.x,
      y: player.pos.y,
      z: player.pos.z,
      rotY: player.rotY,
      anim: player.anim,
      score: player.score
    });
  });

  socket.on("join_clan_chat", ({ tag } = {}) => {
    const user = socket.user;
    const clanTag = cleanText(tag || user.clan, 5).toUpperCase();
    const clan = clans[clanTag];
    if (!clan || user.clan !== clanTag) {
      return socket.emit("clan_chat_error", { message: "Чат доступний лише учасникам свого клану." });
    }

    const room = "clan:" + clanTag;
    socket.join(room);
    socket.emit("clan_chat_history", {
      tag: clanTag,
      messages: Array.isArray(messages[room]) ? messages[room] : []
    });
  });

  socket.on("leave_clan_chat", ({ tag } = {}) => {
    const clanTag = cleanText(tag, 5).toUpperCase();
    if (clanTag) socket.leave("clan:" + clanTag);
  });

  socket.on("send_clan_msg", ({ tag, text } = {}) => {
    const user = socket.user;
    const clanTag = cleanText(tag || user.clan, 5).toUpperCase();
    const clan = clans[clanTag];
    const body = cleanText(text, 1000);
    if (!clan || user.clan !== clanTag) {
      return socket.emit("clan_chat_error", { message: "Ти більше не учасник цього клану." });
    }
    if (!body) return;

    const room = "clan:" + clanTag;
    const msg = {
      senderId: user.id,
      senderName: user.nickname,
      text: body,
      time: new Date().toISOString(),
      clanTag
    };
    messages[room] = Array.isArray(messages[room]) ? messages[room] : [];
    messages[room].push(msg);
    if (messages[room].length > 200) messages[room].splice(0, messages[room].length - 200);
    saveMessages();
    io.to(room).emit("clan_chat_message", msg);
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
    if (socket.user?.id) removeLobbyMember(io, socket.user.id, socket.id, "Гравець відключився.");
    removeFromQueue(socket.user?.uuid || socket.user?.id, socket.id);

    if (socket.user) {
      socket.user.status = false;
      saveUsers();
    }

    const practice = socket.user ? trainingSessions.get(socket.user.id) : null;
    if (practice && practice.socketId === socket.id) practice.socketId = null;

    for (const [matchId, match] of activeMatches.entries()) {
      const player = match.players.find(p => p.socketId === socket.id);
      if (!player) continue;

      player.socketId = null;
      player.ready = false;
      io.to(matchId).emit("player_connection_state", { userId: player.userId, connected: false, reconnectSeconds: 300 });

      if (match.phase === "waiting") {
        // A navigation or dropped connection can take a moment; pause the initial
        // join timeout and give the new socket the same reconnect grace period.
        if (match.joinTimer) clearTimeout(match.joinTimer);
        match.joinTimer = null;
      }

      if (match.phase !== "game" && !(match.mode === "allies" && ["round_start", "round_end"].includes(match.phase))) {
        // Keep the match recoverable during warmup/countdown too; a fresh socket
        // will reclaim the same slot through join_room and restart readiness.
        if (match.phaseTimer) clearInterval(match.phaseTimer);
        match.phaseTimer = null;
        match.phase = "waiting";
        match.started = false;
        match.phaseRemaining = null;
        emitMatchWaiting(io, match);
      }

      if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
      player.disconnectTimer = setTimeout(() => {
        const current = activeMatches.get(matchId);
        if (!current) return;
        const stillDisconnected = current.players.find(p => p.userId === player.userId && !p.socketId);
        if (!stillDisconnected) return;
        stillDisconnected.disconnectTimer = null;
        // The reconnect window is five minutes. After it expires, remove only that
        // disconnected player and let the remaining live match continue.
        if (current.phase === "game") {
          const liveIndex = current.players.findIndex(p => p.userId === player.userId && !p.socketId);
          if (liveIndex < 0) return;
          const [expiredPlayer] = current.players.splice(liveIndex, 1);
          io.to(matchId).emit("player_connection_state", { userId: expiredPlayer.userId, connected: false, reconnectExpired: true });
          io.to(matchId).emit("player_left", { userId: expiredPlayer.userId });
          if (current.players.filter(p => !p.isBot).length < 2) cleanMatch(io, matchId, true);
          else emitMatchWaiting(io, current);
          return;
        }
        // Before the round starts, remove only the missing roster slot after grace;
        // do not destroy the match for everyone else.
        const index = current.players.findIndex(p => p.userId === player.userId && !p.socketId);
        if (index < 0) return;
        current.players.splice(index, 1);
        current.started = false;
        current.phase = "waiting";
        emitMatchWaiting(io, current);
        if (current.players.length >= 2 && current.players.some(p => !p.isBot)) startMatchWhenReady(io, current);
        else cleanMatch(io, matchId, true);
      }, 5 * 60 * 1000);
    }

    emitQueueCount(io);
  });
});


function replaceUserIdReferences(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;

  for (const u of users) {
    if (Array.isArray(u.friendsList)) u.friendsList = u.friendsList.map(id => id === oldId ? newId : id);
    if (Array.isArray(u.incomingRequests)) u.incomingRequests = u.incomingRequests.map(id => id === oldId ? newId : id);
    if (Array.isArray(u.blocked)) u.blocked = u.blocked.map(id => id === oldId ? newId : id);
  }

  for (const clan of Object.values(clans)) {
    if (clan.ownerId === oldId) clan.ownerId = newId;
    clan.officers = Array.isArray(clan.officers) ? clan.officers.map(id => id === oldId ? newId : id) : [];
    clan.requests = Array.isArray(clan.requests) ? clan.requests.map(id => id === oldId ? newId : id) : [];
  }

  if (inventory[oldId] !== undefined) {
    inventory[newId] = inventory[oldId];
    delete inventory[oldId];
  }

  market = market.map(lot => lot.sellerId === oldId ? { ...lot, sellerId: newId } : lot);

  const nextMessages = {};
  const knownOthers = users.map(u => u.id).filter(id => id && id !== oldId);
  for (const otherId of knownOthers) {
    const oldRoom = chatRoom(oldId, otherId);
    const newRoom = chatRoom(newId, otherId);
    if (messages[oldRoom] !== undefined) {
      nextMessages[newRoom] = Array.isArray(messages[oldRoom])
        ? messages[oldRoom].map(msg => ({ ...msg, senderId: msg.senderId === oldId ? newId : msg.senderId }))
        : messages[oldRoom];
    }
  }
  for (const [room, list] of Object.entries(messages)) {
    if (knownOthers.some(otherId => room === chatRoom(oldId, otherId))) continue;
    nextMessages[room] = list;
  }
  messages = nextMessages;

  for (const [token, data] of sessions.entries()) {
    if (data.userId === oldId) data.userId = newId;
  }
}

app.get("/admin", requireAdmin, (_req, res) => {
  res.sendFile(path.join(ROOT, "admin.html"));
});

app.get("/api/admin/overview", requireAdmin, (_req, res) => {
  res.json({
    success: true,
    storage: mongoDb ? "MongoDB Atlas" : "JSON fallback",
    atlas: publicMongoStatus(),
    users: users.length,
    online: users.filter(u => u.status).length,
    testers: users.filter(u => u.isTester || u.id === ADMIN_ID).length,
    clans: Object.keys(clans).length,
    market: market.length,
    messages: Object.values(messages).reduce((n, x) => n + (Array.isArray(x) ? x.length : 0), 0)
  });
});

app.post("/api/admin/atlas/check", requireAdmin, async (_req, res) => {
  const result = await checkMongoConnection();
  res.status(result.ok ? 200 : 503).json({ success: result.ok, ...result });
});

app.get("/api/admin/users", requireAdmin, (_req, res) => {
  res.json({ success: true, users: users.map(publicUser) });
});

app.post("/api/admin/users/update", requireAdmin, (req, res) => {
  const lookupId = normalizeId(req.body.userId);
  const u = findUser(lookupId, { allowNickname: false });
  if (!u) return res.status(404).json({ success: false, message: "User not found" });

  const isMaster = u.id === ADMIN_ID;
  const nextIdRaw = normalizeId(req.body.id ?? u.id);
  const nextNick = cleanText(req.body.nickname ?? u.nickname, 24);
  const nextClan = cleanText(req.body.clan ?? "", 5).toUpperCase();
  const nextPassword = req.body.password === undefined ? "" : String(req.body.password);
  if (!isMaster && req.body.password !== undefined && nextPassword.length && (nextPassword.length < 6 || nextPassword.length > 128)) {
    return res.status(400).json({ success: false, message: "Пароль: 6–128 символів." });
  }

  if (!/^[\p{L}\p{N}_-]{3,24}$/u.test(nextNick)) {
    return res.status(400).json({ success: false, message: "Некоректний nickname." });
  }
  if (!nextIdRaw) {
    return res.status(400).json({ success: false, message: "Player ID не може бути порожнім." });
  }
  const changingId = !isMaster && nextIdRaw !== u.id;
  if (changingId && !/^\d{6,10}$/.test(nextIdRaw)) {
    return res.status(400).json({ success: false, message: "Новий Player ID має містити 6–10 цифр." });
  }
  if (changingId && (playerIdExists(nextIdRaw) || nextIdRaw.toLowerCase() === ADMIN_ID.toLowerCase())) {
    return res.status(409).json({ success: false, message: "Такий ID вже зайнятий або зарезервований." });
  }
  if (nextClan && !clans[nextClan]) {
    return res.status(404).json({ success: false, message: "Такого клану немає." });
  }

  const oldId = u.id;
  const previousClanForMove = u.clan || null;
  if (!isMaster) {
    if (nextIdRaw === ADMIN_ID) {
      return res.status(400).json({ success: false, message: "Dev_01 зарезервований для master." });
    }
    u.id = nextIdRaw;
  } else {
    u.id = ADMIN_ID;
  }

  u.nickname = nextNick;
  if (!isMaster && req.body.password !== undefined && nextPassword.length) {
    u.passwordHash = hashPassword(nextPassword);
    delete u.password;
  }
  if (req.body.gold !== undefined) u.gold = Math.max(0, Number(req.body.gold) || 0);
  if (req.body.XP !== undefined) u.XP = Math.max(0, Number(req.body.XP) || 0);
  if (req.body.MMRCompetitive !== undefined) u.MMRCompetitive = Math.max(0, Number(req.body.MMRCompetitive) || 0);
  if (req.body.MMRAllies !== undefined) u.MMRAllies = Math.max(0, Number(req.body.MMRAllies) || 0);
  if (req.body.isBanned !== undefined) u.isBanned = Boolean(req.body.isBanned);
  if (req.body.isVerified !== undefined) u.isVerified = Boolean(req.body.isVerified);
  if (!isMaster && req.body.isAdmin !== undefined) u.isAdmin = Boolean(req.body.isAdmin);
  if (!isMaster && req.body.isTester !== undefined) u.isTester = Boolean(req.body.isTester);
  if (isMaster) {
    u.isAdmin = true;
    u.isTester = true;
    u.isBanned = false;
  }

  if (req.body.clan !== undefined) u.clan = nextClan || null;

  replaceUserIdReferences(oldId, u.id);

  if (req.body.clan !== undefined && previousClanForMove && previousClanForMove !== u.clan && clans[previousClanForMove]) {
    const previousClan = clans[previousClanForMove];
    previousClan.officers = (previousClan.officers || []).filter(id => id !== u.id && id !== oldId);
    previousClan.requests = (previousClan.requests || []).filter(id => id !== u.id && id !== oldId);
    if (previousClan.ownerId === u.id) {
      const nextOwner = users
        .filter(member => member.id !== u.id && member.clan === previousClanForMove)
        .sort((a, b) => ((previousClan.officers || []).includes(a.id) ? 0 : 1) - ((previousClan.officers || []).includes(b.id) ? 0 : 1))[0];
      if (nextOwner) {
        previousClan.ownerId = nextOwner.id;
        previousClan.officers = (previousClan.officers || []).filter(id => id !== nextOwner.id);
      } else {
        delete clans[previousClanForMove];
      }
    }
  }

  ensureUserShape(u);
  saveUsers();
  saveClans();
  saveInventory();
  saveMessages();
  saveMarket();

  res.json({ success: true, user: publicUser(u) });
});

app.post("/api/admin/users/create", requireAdmin, (req, res) => {
  const nickname = cleanText(req.body.nickname, 24);
  const password = String(req.body.password || "");
  let id = normalizeId(req.body.id || "");

  if (!/^[\p{L}\p{N}_-]{3,24}$/u.test(nickname)) {
    return res.status(400).json({ success: false, message: "Некоректний nickname." });
  }
  if (password.length < 6 || password.length > 128) {
    return res.status(400).json({ success: false, message: "Пароль: 6–128 символів." });
  }
  if (id && !/^\d{6,10}$/.test(id)) {
    return res.status(400).json({ success: false, message: "Player ID має містити 6–10 цифр." });
  }
  if (id && id.toLowerCase() === ADMIN_ID.toLowerCase()) {
    return res.status(409).json({ success: false, message: "Цей ID зарезервований для master-акаунта." });
  }
  if (id && (playerIdExists(id) || id.toLowerCase() === ADMIN_ID.toLowerCase())) {
    return res.status(409).json({ success: false, message: "Такий ID вже зайнятий або зарезервований." });
  }
  if (!id) id = newPlayerId();

  const user = {
    nickname, id, uuid: crypto.randomUUID(), passwordHash: hashPassword(password), playerAvatar: "/avatars/default.jpg",
    status:false, XP:0, gold:0, clan:null, MMRCompetitive:1000, MMRAllies:1000,
    isVerified:false, isBanned:false, isAdmin:Boolean(req.body.isAdmin), isTester:Boolean(req.body.isTester),
    friendsList:[], incomingRequests:[], blocked:[], usedPromos:[]
  };
  ensureUserShape(user);
  users.push(user);
  inventory[id] = [];
  saveUsers(); saveInventory();
  res.json({ success:true, user:publicUser(user) });
});

app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  const id = normalizeId(req.params.id);
  if (id === ADMIN_ID) return res.status(400).json({ success: false, message: "Master account cannot be deleted." });
  for (const client of io.sockets.sockets.values()) {
    if (client.user?.id === id) client.disconnect(true);
  }
  const i = users.findIndex(u => u.id === id);
  if (i < 0) return res.status(404).json({ success: false, message: "User not found" });
  users.splice(i, 1);
  delete inventory[id];
  for (const u of users) {
    u.friendsList = (u.friendsList || []).filter(x => x !== id);
    u.incomingRequests = (u.incomingRequests || []).filter(x => x !== id);
    u.blocked = (u.blocked || []).filter(x => x !== id);
  }
  for (const [tag, clan] of Object.entries(clans)) {
    clan.requests = (clan.requests || []).filter(x => x !== id);
    clan.officers = (clan.officers || []).filter(x => x !== id);
    if (clan.ownerId === id) {
      const members = users
        .filter(user => user.clan === tag)
        .sort((a, b) => ((clan.officers || []).includes(a.id) ? 0 : 1) - ((clan.officers || []).includes(b.id) ? 0 : 1));
      if (members.length) {
        clan.ownerId = members[0].id;
        clan.officers = (clan.officers || []).filter(memberId => memberId !== members[0].id);
      } else {
        delete clans[tag];
        delete messages["clan:" + tag];
      }
    }
  }
  for (const [token, data] of sessions.entries()) if (data.userId === id) sessions.delete(token);
  delete inventory[id];
  saveUsers();
  saveClans();
  saveInventory();
  saveMessages();
  res.json({ success: true });
});

app.post("/api/admin/clans/update", transactionRateLimit, requireAdmin, (req, res) => {
  const tag = cleanText(req.body.tag, 5).toUpperCase();
  const clan = clans[tag];
  if (!clan) return res.status(404).json({ success: false, message: "Клан не знайдено." });

  const name = cleanText(req.body.name ?? clan.name, 24);
  const description = cleanText(req.body.description ?? clan.description, 120);
  const limit = req.body.memberLimit === undefined ? clan.memberLimit : Number(req.body.memberLimit);
  const memberCount = users.filter(user => user.clan === tag).length;
  if (!/^[\p{L}\p{N} _-]{3,24}$/u.test(name)) {
    return res.status(400).json({ success: false, message: "Назва клану: 3–24 символи." });
  }
  if (!Number.isInteger(limit) || limit < 5 || limit > 50 || limit < memberCount) {
    return res.status(400).json({ success: false, message: "Ліміт має бути 5–50 і не меншим за кількість учасників." });
  }

  clan.name = name;
  clan.description = description;
  clan.memberLimit = limit;
  saveClans();
  res.json({ success: true, clan });
});

app.post("/api/admin/clans/delete", transactionRateLimit, requireAdmin, (req, res) => {
  const tag = cleanText(req.body.tag, 5).toUpperCase();
  const clan = clans[tag];
  if (!clan) return res.status(404).json({ success: false, message: "Клан не знайдено." });

  const affectedIds = new Set(users.filter(user => user.clan === tag).map(user => user.id));
  for (const user of users) if (affectedIds.has(user.id)) user.clan = null;
  for (const client of io.sockets.sockets.values()) {
    if (client.user && affectedIds.has(client.user.id)) {
      client.leave("clan:" + tag);
      client.emit("clan_chat_error", { message: "Клан було видалено адміністрацією." });
    }
  }
  delete clans[tag];
  delete messages["clan:" + tag];
  saveUsers();
  saveClans();
  saveMessages();
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
