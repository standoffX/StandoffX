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
const DATA_DIR = path.join(ROOT, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const USERS_PATH = path.join(DATA_DIR, "users.local.json");
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
    mongoStatus.lastError = safeMongoError(err);
    try { await failedClient?.close(); } catch {}
    return { ok: false, status: publicMongoStatus(), message: mongoStatus.lastError };
  }
}

async function initMongo() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  mongoStatus.configured = Boolean(uri);
  mongoStatus.database = process.env.MONGODB_DB || "standoffx";
  if (!uri) {
    mongoStatus.connected = false;
    mongoStatus.state = "not_configured";
    mongoStatus.lastError = "MONGODB_URI/MONGO_URI is missing; JSON fallback is active.";
    console.warn("[DB] MongoDB Atlas is NOT configured. Set MONGODB_URI in Render Environment.");
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
    const atlasUsers = await load("state_users", users);
    if (Array.isArray(atlasUsers)) {
      users = atlasUsers.filter(user => user && typeof user === "object" && !Array.isArray(user));
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
    // The verified badge is always manual. Clear legacy defaults once, then let admins grant it.
    const verificationMigration = "verified-defaults-off-v1";
    const alreadyMigrated = await mongoDb.collection("schema_migrations").findOne({ _id: verificationMigration });
    if (!alreadyMigrated) {
      for (const user of users) user.isVerified = false;
      await mongoDb.collection("state_users").replaceOne(
        { _id: "main" }, { _id: "main", data: users }, { upsert: true }
      );
      await mongoDb.collection("schema_migrations").insertOne({ _id: verificationMigration, appliedAt: new Date() });
    }
    saveUsers();
    saveClans();
    console.log("[DB] MongoDB Atlas connected:", mongoStatus.database);
    return true;
  } catch (err) {
    const failedClient = mongoClient;
    mongoClient = null;
    mongoDb = null;
    mongoStatus.connected = false;
    mongoStatus.state = "error";
    mongoStatus.lastError = safeMongoError(err);
    try { await failedClient?.close(); } catch {}
    console.error("[DB] MongoDB Atlas connection failed:", mongoStatus.lastError);
    return false;
  }
}

const mongoWriteQueues = new Map();
function safeMongoError(err) {
  return cleanText(err?.message || "Unknown MongoDB error", 240)
    .replace(/mongodb(?:\\+srv)?:\\/\\/[^\\s@]+@/gi, "mongodb+srv://[credentials-redacted]@")
    .replace(/password=[^&\\s]+/gi, "password=[redacted]");
}
function mongoSave(name, data) {
  if (!mongoDb) return;
  const db = mongoDb;
  const snapshot = JSON.parse(JSON.stringify(data));
  const previous = mongoWriteQueues.get(name) || Promise.resolve();
  const write = previous.catch(() => {}).then(() => db.collection(name).replaceOne(
    { _id: "main" },
    { _id: "main", data: snapshot },
    { upsert: true }
  )).catch(err => {
    mongoStatus.lastError = safeMongoError(err);
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
  mongoWriteQueues.set(name, write);
  write.finally(() => { if (mongoWriteQueues.get(name) === write) mongoWriteQueues.delete(name); });
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
  const { password, passwordHash, uuid, ...safe } = user;

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
      requests: Array.isArray(raw.requests) ? [...new Set(raw.requests.map(normalizeId).filter(Boolean))] : []
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

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  sessions.set(token, { userId, createdAt: now, expiresAt: now + SESSION_TTL_MS });
  return token;
}

function sessionUserFromToken(token) {
  const data = token ? sessions.get(token) : null;
  if (!data || !Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
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
    user: publicUser(user),
    createdId: user.id,
    message: "Акаунт створено."
  });
});

app.post("/api/login", loginRateLimit, (req, res) => {
  const id = normalizeId(req.body.id || "");
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
    // UUID remains an internal reference. Login accepts the public Player ID only.
    user = findUser(id, { allowNickname: false });
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
  const list = Object.values(clans).map(c => ({
    ...c,
    members: users.filter(u => u.clan === c.tag).map(u => u.id).filter(Boolean),
    memberCount: users.filter(u => u.clan === c.tag).length
  }));
  res.json({ success: true, clans: list });
});

app.post("/api/clans/search", requireAuth, (req, res) => {
  const q = cleanText(req.body.query, 40).toLowerCase();
  const result = Object.values(clans).filter(c =>
    c.name.toLowerCase().includes(q) ||
    c.tag.toLowerCase().includes(q) ||
    String(c.description || "").toLowerCase().includes(q)
  ).map(c => ({
    ...c,
    memberCount: users.filter(u => u.clan === c.tag).length,
    isFull: users.filter(u => u.clan === c.tag).length >= c.memberLimit
  }));
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

// ---------- MATCHMAKING / GAME ----------

const matchmakingQueue = [];
const matchmakingFillTimers = new Map();
const MATCHMAKING_FILL_WINDOW_MS = 3500;
const MATCHMAKING_MIN_PLAYERS = 2;
const activeMatches = new Map(); // in-memory only; never written to MongoDB
const trainingSessions = new Map(); // private tester sessions; never written to MongoDB
const DEFAULT_MATCH_SIZE = 3;
const GAME_SECONDS = 300;
const WARMUP_SECONDS = 10;
const COUNTDOWN_SECONDS = 15;
const JOIN_TIMEOUT_SECONDS = 35;

const PLAYABLE_MAPS = Object.freeze({
  M3_Maze: { id: "M3_Maze", name: "M3 MAZE", kind: "model" },
  FIELD_ARENA: { id: "FIELD_ARENA", name: "FIELD ARENA", kind: "arena" },
  NEON_YARD: { id: "NEON_YARD", name: "NEON YARD", kind: "neon" },
  HILL_TOWN: { id: "HILL_TOWN", name: "HILL TOWN", kind: "hill-town" },
  TF_COURTYARD: { id: "TF_COURTYARD", name: "COURTYARD", kind: "team-fight" },
  TF_DEPOT: { id: "TF_DEPOT", name: "DEPOT", kind: "team-fight" },
  BOMB_RAVINE: { id: "BOMB_RAVINE", name: "RAVINE A/B", kind: "bomb-sites" }
});
function normalizeMapId(value) {
  const id = cleanText(value, 32);
  return Object.prototype.hasOwnProperty.call(PLAYABLE_MAPS, id) ? id : "M3_Maze";
}

const MODE_CONFIGS = {
  allies: { id: "allies", name: "СОЮЗНИКИ", short: "AL", map: "HILL_TOWN", requiredPlayers: 4 },
  hide_seek: { id: "hide_seek", name: "HIDE & SEEK", short: "HS", map: "M3_Maze", requiredPlayers: 3 },
  team_fight: { id: "team_fight", name: "КОМАНДНИЙ БІЙ", short: "TF", map: "TF_COURTYARD", requiredPlayers: 6 },
  bomb: { id: "bomb", name: "ЗАКЛАДКА БОМБИ", short: "BOMB", map: "BOMB_RAVINE", requiredPlayers: 6 }
};
const MODE_MAPS = Object.freeze({
  allies: ["HILL_TOWN", "BOMB_RAVINE"],
  team_fight: ["TF_COURTYARD", "TF_DEPOT"],
  bomb: ["BOMB_RAVINE"]
});
function normalizeMapForMode(mode, mapId) {
  const allowed = MODE_MAPS[mode] || MODE_MAPS.allies;
  const requested = normalizeMapId(mapId);
  return allowed.includes(requested) ? requested : MODE_CONFIGS[mode]?.map || "HILL_TOWN";
}

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
  { x: -20, y: 0, z: -14 },
  { x: 20, y: 0, z: 14 },
  { x: -20, y: 0, z: 14 },
  { x: 20, y: 0, z: -14 }
];

function getModeConfig(mode) {
  return MODE_CONFIGS[mode] || MODE_CONFIGS.allies;
}

function getRequiredPlayers(mode) {
  return Number(getModeConfig(mode).requiredPlayers) || DEFAULT_MATCH_SIZE;
}
function getMinimumPlayers(mode) {
  // Team Fight and Bomb must be full 3v3, not accidental 1v1 or 2v2.
  if (["team_fight", "bomb"].includes(mode)) return getRequiredPlayers(mode);
  return mode === "allies" ? MATCHMAKING_MIN_PLAYERS : getRequiredPlayers(mode);
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
        connected: true,
        ready: false
      }))
    });
  }
}

function createMatch(io, mode, mapId = "M3_Maze", forcedCandidates = null) {
  const safeMapId = normalizeMapId(mapId);
  const candidates = Array.isArray(forcedCandidates) ? forcedCandidates : matchmakingQueue.filter(p => p.mode === mode && p.map === safeMapId);
  const requiredPlayers = getRequiredPlayers(mode);
  const minimumPlayers = getMinimumPlayers(mode);
  if (candidates.length < minimumPlayers) return;

  // Give up to four players a short chance to arrive; then start a smaller match if needed.
  const players = candidates.slice(0, requiredPlayers);
  for (const p of players) if (!p.isBot) removeFromQueue(p.uuid || p.userId);

  const cfg = getModeConfig(mode);
  const matchId = "match_" + Date.now() + "_" + crypto.randomBytes(2).toString("hex");
  const hunterIndex = mode === "hide_seek" ? crypto.randomInt(0, players.length) : -1;
  const MATCH_SPAWNS = {
    HILL_TOWN: HILL_TOWN_SPAWNS,
    NEON_YARD: [{x:-82,y:0,z:-82},{x:82,y:0,z:-82},{x:-82,y:0,z:82},{x:82,y:0,z:82}],
    FIELD_ARENA: [{x:-110,y:0,z:-110},{x:110,y:0,z:-110},{x:-110,y:0,z:110},{x:110,y:0,z:110}],
    TF_COURTYARD: [{x:-28,y:0,z:-13},{x:-28,y:0,z:0},{x:-28,y:0,z:13},{x:28,y:0,z:-13},{x:28,y:0,z:0},{x:28,y:0,z:13}],
    TF_DEPOT: [{x:-29,y:0,z:-12},{x:-29,y:0,z:0},{x:-29,y:0,z:12},{x:29,y:0,z:-12},{x:29,y:0,z:0},{x:29,y:0,z:12}],
    BOMB_RAVINE: [{x:-4,y:0,z:40},{x:0,y:0,z:42},{x:4,y:0,z:40},{x:-4,y:0,z:-40},{x:0,y:0,z:-42},{x:4,y:0,z:-40}]
  };
  const matchSpawns = MATCH_SPAWNS[safeMapId] || (safeMapId === "HILL_TOWN" ? HILL_TOWN_SPAWNS : SPAWNS);

  const match = {
    id: matchId,
    mode: cfg.id,
    modeName: cfg.name,
    map: safeMapId,
    mapName: PLAYABLE_MAPS[safeMapId]?.name || PLAYABLE_MAPS.M3_Maze.name,
    players: players.map((p, i) => ({
      socketId: p.socketId || null,
      userId: p.userId,
      uuid: p.uuid || "",
      isBot: Boolean(p.isBot),
      nickname: p.nickname,
      role: mode === "hide_seek"
        ? (i === hunterIndex ? "hunter" : "runner")
        : mode === "bomb" ? (i < Math.ceil(players.length / 2) ? "terrorist" : "counter_terrorist")
        : (i % 2 === 0 ? "teamA" : "teamB"),
      team: ["team_fight", "allies", "bomb"].includes(mode)
        ? (players.some(candidate => candidate.isBot)
          ? (p.isBot ? "B" : "A")
          : (i < Math.ceil(players.length / 2) ? "A" : "B"))
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
    remaining: GAME_SECONDS,
    doorOpen: [false, false, false, false],
    woodDestroyed: [],
    bomb: mode === "bomb" ? {
      round: 1,
      roundWins: { A: 0, B: 0 },
      attackTeam: "A",
      winnerTeam: null,
      status: "carried",
      carrierId: players[0]?.userId || null,
      site: null,
      plantedAt: null,
      actionPlayerId: null,
      actionTimer: null,
      explosionTimer: null,
      reason: ""
    } : null
  };

  activeMatches.set(matchId, match);
  emitQueueCount(io);

  for (const p of match.players) {
    if (!p.socketId || p.isBot) continue;
    io.to(p.socketId).emit("match_found", {
      matchId,
      userId: p.userId,
      mode: cfg.id,
      modeName: cfg.name,
      map: match.map
    });
  }

  match.joinTimer = setTimeout(() => {
    const current = activeMatches.get(matchId);
    if (!current || current.started || current.finished) return;
    const connected = current.players.filter(p => p.isBot || Boolean(p.socketId)).length;
    const ready = current.players.filter(p => p.isBot || p.ready).length;
    if (connected < current.players.length || ready < current.players.length) {
      for (const p of current.players) {
        if (p.socketId) io.to(p.socketId).emit("search_error", {
          message: connected < current.players.length
            ? "Не всі гравці підключилися до матчу."
            : "Не всі гравці встигли завантажити карту."
        });
      }
      cleanMatch(io, matchId, true);
    }
  }, JOIN_TIMEOUT_SECONDS * 1000);
}

function scheduleMatchmaking(io, mode, mapId) {
  const key = mode + ":" + mapId;
  if (matchmakingFillTimers.has(key)) return;
  const timer = setTimeout(() => {
    matchmakingFillTimers.delete(key);
    const candidates = matchmakingQueue.filter(p => p.mode === mode && p.map === mapId);
    if (candidates.length >= getMinimumPlayers(mode)) createMatch(io, mode, mapId);
    emitQueueCount(io);
  }, MATCHMAKING_FILL_WINDOW_MS);
  matchmakingFillTimers.set(key, timer);
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
      connected: p.isBot || Boolean(p.socketId),
      ready: p.isBot || Boolean(p.ready),
      isBot: Boolean(p.isBot)
    }))
  });
}

function cleanMatch(io, matchId, returnToMenu = true) {
  const match = activeMatches.get(matchId);
  if (!match) return;
  if (match.timer) clearInterval(match.timer);
  if (match.phaseTimer) clearInterval(match.phaseTimer);
  if (match.joinTimer) clearTimeout(match.joinTimer);
  clearBombAction(match);
  if (match.bomb?.explosionTimer) clearTimeout(match.bomb.explosionTimer);
  if (match.bomb?.roundTimer) clearTimeout(match.bomb.roundTimer);
  if (returnToMenu) io.to(match.id).emit("go_to_menu");
  for (const p of match.players) {
    if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
    p.disconnectTimer = null;
    p.socketId = null;
  }
  activeMatches.delete(matchId);
}

function bombStatePayload(match) {
  if (!match?.bomb) return null;
  const bomb = match.bomb;
  return {
    round: bomb.round,
    roundWins: { ...bomb.roundWins },
    attackTeam: bomb.attackTeam,
    status: bomb.status,
    carrierId: bomb.carrierId,
    site: bomb.site,
    plantedAt: bomb.plantedAt,
    fuseSeconds: ["planted", "defusing"].includes(bomb.status) ? Math.max(0, Math.ceil((40_000 - (Date.now() - (bomb.plantedAt || Date.now()))) / 1000)) : null,
    actionPlayerId: bomb.actionPlayerId
  };
}

function clearBombAction(match) {
  const bomb = match?.bomb;
  if (!bomb) return;
  if (bomb.actionTimer) clearTimeout(bomb.actionTimer);
  bomb.actionTimer = null;
  bomb.actionPlayerId = null;
}

function finishBombRound(io, match, winnerTeam, reason) {
  if (!match || match.finished || match.mode !== "bomb" || match.phase !== "game" || !match.bomb) return;
  const bomb = match.bomb;
  if (!["A", "B"].includes(winnerTeam)) return;
  if (match.timer) clearInterval(match.timer);
  match.timer = null;
  clearBombAction(match);
  if (bomb.explosionTimer) clearTimeout(bomb.explosionTimer);
  bomb.explosionTimer = null;
  bomb.status = reason === "defused" ? "defused" : (reason === "bomb_exploded" ? "exploded" : bomb.status);
  bomb.reason = reason;
  bomb.roundWins[winnerTeam] = (bomb.roundWins[winnerTeam] || 0) + 1;
  for (const player of match.players) {
    if (player.team === winnerTeam) player.score += 1;
  }
  match.phase = "round_end";
  match.phaseRemaining = 4;
  io.to(match.id).emit("bomb_state", bombStatePayload(match));
  io.to(match.id).emit("bomb_round_end", {
    winnerTeam, reason, round: bomb.round, roundWins: { ...bomb.roundWins },
    nextRound: bomb.round < 7 && Math.max(bomb.roundWins.A, bomb.roundWins.B) < 4
  });
  const gameOver = Math.max(bomb.roundWins.A, bomb.roundWins.B) >= 4 || bomb.round >= 7;
  if (gameOver) {
    bomb.winnerTeam = bomb.roundWins.A === bomb.roundWins.B
      ? winnerTeam
      : (bomb.roundWins.A > bomb.roundWins.B ? "A" : "B");
    bomb.reason = reason;
    setTimeout(() => finishMatch(io, match.id), 3500);
    return;
  }
  bomb.roundTimer = setTimeout(() => {
    if (!activeMatches.has(match.id) || match.finished) return;
    bomb.round += 1;
    if (bomb.round === 4) bomb.attackTeam = bomb.attackTeam === "A" ? "B" : "A";
    startBombRound(io, match);
  }, 3500);
}

function startBombRound(io, match) {
  if (!match || match.finished || match.mode !== "bomb" || !match.bomb) return;
  if (match.timer) clearInterval(match.timer);
  const bomb = match.bomb;
  clearBombAction(match);
  if (bomb.explosionTimer) clearTimeout(bomb.explosionTimer);
  bomb.explosionTimer = null;
  match.phase = "game";
  match.phaseRemaining = null;
  match.remaining = 110;
  bomb.status = "carried";
  bomb.site = null;
  bomb.plantedAt = null;
  bomb.reason = "";
  const attackers = match.players.filter(player => player.team === bomb.attackTeam);
  bomb.carrierId = attackers.find(player => player.hp > 0)?.userId || attackers[0]?.userId || null;
  for (const player of match.players) {
    const attacking = player.team === bomb.attackTeam;
    player.role = attacking ? "terrorist" : "counter_terrorist";
    player.hp = 100;
    player.pos = { ...player.spawn };
    const sideIndex = match.players.filter(other => other.team === player.team).indexOf(player);
    player.spawn = {
      x: [-4, 0, 4][Math.max(0, sideIndex) % 3],
      y: 0,
      z: attacking ? 40 + (sideIndex === 1 ? 1 : 0) : -40 - (sideIndex === 1 ? 1 : 0)
    };
    player.pos = { ...player.spawn };
    player.rotY = attacking ? 0 : Math.PI;
    player.anim = "Idle";
  }
  io.to(match.id).emit("bomb_round_start", {
    round: bomb.round, roundWins: { ...bomb.roundWins }, attackTeam: bomb.attackTeam,
    players: match.players.map(player => ({
      userId: player.userId, team: player.team, role: player.role,
      hp: player.hp, x: player.pos.x, y: player.pos.y, z: player.pos.z,
      rotY: player.rotY
    }))
  });
  io.to(match.id).emit("bomb_state", bombStatePayload(match));
  io.to(match.id).emit("match_phase", { phase: "game", time: match.remaining, mode: match.mode, modeName: match.modeName });
  match.timer = setInterval(() => {
    if (match.phase !== "game" || match.finished) return;
    match.remaining -= 1;
    io.to(match.id).emit("timer_update", { time: match.remaining, phase: "game" });
    if (match.remaining <= 0 && bomb.status !== "planted") {
      finishBombRound(io, match, bomb.attackTeam === "A" ? "B" : "A", "time");
    }
  }, 1000);
}

function bombSiteForPosition(position) {
  for (const site of [
    { id: "A", x: -45, z: -4 },
    { id: "B", x: 45, z: -4 }
  ]) {
    if (Math.hypot(position.x - site.x, position.z - site.z) <= 7.5) return site.id;
  }
  return null;
}

function handleBombInteraction(io, match, player, action) {
  const bomb = match?.bomb;
  if (!bomb || match.mode !== "bomb" || match.phase !== "game" || !player || player.hp <= 0) return;
  if (action === "cancel") {
    if (bomb.actionPlayerId !== player.userId) return;
    clearBombAction(match);
    if (bomb.status === "planting") bomb.status = "carried";
    if (bomb.status === "defusing") bomb.status = "planted";
    io.to(match.id).emit("bomb_state", bombStatePayload(match));
    return;
  }
  if (action !== "begin" || bomb.actionPlayerId) return;
  if (bomb.status === "carried" && player.team === bomb.attackTeam && player.userId === bomb.carrierId) {
    const site = bombSiteForPosition(player.pos);
    if (!site) return;
    bomb.status = "planting";
    bomb.site = site;
    bomb.actionPlayerId = player.userId;
    io.to(match.id).emit("bomb_state", bombStatePayload(match));
    bomb.actionTimer = setTimeout(() => {
      const current = activeMatches.get(match.id);
      const stillThere = current?.players.find(p => p.userId === player.userId);
      if (!current || current.finished || current.phase !== "game" || !stillThere || stillThere.hp <= 0 ||
          stillThere.team !== bomb.attackTeam || bomb.actionPlayerId !== player.userId ||
          bombSiteForPosition(stillThere.pos) !== site) {
        if (current) {
          clearBombAction(current);
          if (bomb.status === "planting") bomb.status = "carried";
          io.to(match.id).emit("bomb_state", bombStatePayload(current));
        }
        return;
      }
      clearBombAction(current);
      bomb.status = "planted";
      bomb.site = site;
      bomb.carrierId = null;
      bomb.plantedAt = Date.now();
      bomb.explosionTimer = setTimeout(() => {
        const active = activeMatches.get(match.id);
        if (!active || active.finished || active.phase !== "game" || bomb.status !== "planted") return;
        finishBombRound(io, active, bomb.attackTeam, "bomb_exploded");
      }, 40_000);
      io.to(match.id).emit("bomb_state", bombStatePayload(current));
    }, 2_000);
    return;
  }
  if (bomb.status === "planted" && player.team !== bomb.attackTeam) {
    const site = bombSiteForPosition(player.pos);
    if (!site || site !== bomb.site) return;
    bomb.status = "defusing";
    bomb.actionPlayerId = player.userId;
    io.to(match.id).emit("bomb_state", bombStatePayload(match));
    bomb.actionTimer = setTimeout(() => {
      const current = activeMatches.get(match.id);
      const stillThere = current?.players.find(p => p.userId === player.userId);
      if (!current || current.finished || current.phase !== "game" || !stillThere || stillThere.hp <= 0 ||
          stillThere.team === bomb.attackTeam || bomb.status !== "defusing" ||
          bomb.actionPlayerId !== player.userId || bombSiteForPosition(stillThere.pos) !== bomb.site) {
        if (current) {
          clearBombAction(current);
          if (bomb.status === "defusing") bomb.status = "planted";
          io.to(match.id).emit("bomb_state", bombStatePayload(current));
        }
        return;
      }
      finishBombRound(io, current, bomb.attackTeam === "A" ? "B" : "A", "defused");
    }, 5_000);
  }
}

function checkBombElimination(io, match) {
  const bomb = match?.bomb;
  if (!bomb || match.mode !== "bomb" || match.phase !== "game") return;
  if (bomb.actionPlayerId && match.players.find(player => player.userId === bomb.actionPlayerId)?.hp <= 0) {
    const previousAction = bomb.status;
    clearBombAction(match);
    if (previousAction === "planting") bomb.status = "carried";
    if (previousAction === "defusing") bomb.status = "planted";
  }
  const aliveAttackers = match.players.filter(player => player.team === bomb.attackTeam && player.hp > 0).length;
  const aliveDefenders = match.players.filter(player => player.team !== bomb.attackTeam && player.hp > 0).length;
  if (bomb.status !== "planted" && aliveAttackers === 0) {
    finishBombRound(io, match, bomb.attackTeam === "A" ? "B" : "A", "team_eliminated");
    return;
  }
  if (aliveDefenders === 0) finishBombRound(io, match, bomb.attackTeam, "team_eliminated");
  if (bomb.status === "carried") {
    const carrier = match.players.find(player => player.userId === bomb.carrierId);
    if (!carrier || carrier.hp <= 0) {
      bomb.carrierId = match.players.find(player => player.team === bomb.attackTeam && player.hp > 0)?.userId || null;
      io.to(match.id).emit("bomb_state", bombStatePayload(match));
    }
  }
}

function startMatchWhenReady(io, match) {
  if (match.started || match.phase !== "waiting") return;
  const allConnected = match.players.every(p => p.isBot || Boolean(p.socketId));
  const allReady = match.players.every(p => p.isBot || p.ready);
  if (!allConnected || !allReady) {
    emitMatchWaiting(io, match);
    return;
  }

  match.started = true;
  if (match.joinTimer) clearTimeout(match.joinTimer);

  if (match.players.some(p => p.isBot)) {
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
          if (match.mode === "bomb") {
            startBombRound(io, match);
            return;
          }

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
  clearBombAction(match);
  if (match.bomb?.explosionTimer) clearTimeout(match.bomb.explosionTimer);
  if (match.bomb?.roundTimer) clearTimeout(match.bomb.roundTimer);

  const ranked = [...match.players].sort((a, b) => b.score - a.score);
  const highestScore = ranked[0]?.score || 0;

  for (const player of match.players) {
    const user = users.find(u => u.id === player.userId);
    if (!user) continue;

    const won = match.mode === "bomb" && match.bomb?.winnerTeam
      ? player.team === match.bomb.winnerTeam
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
    scores: ranked.map(p => ({ userId: p.userId, nickname: p.nickname, score: p.score }))
  });

  setTimeout(() => cleanMatch(io, matchId, true), 8000);
}

function respawnPlayer(match, player) {
  player.pos = { ...player.spawn };
  player.hp = 100;
  player.rotY = 0;
  player.anim = "Idle";
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

function planeCrossing(a, b, plane) {
  return (a < plane - 0.001 && b > plane + 0.001) || (a > plane + 0.001 && b < plane - 0.001);
}

function hillTownCrossingBlocked(from, to, doorOpen = []) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  for (const zWall of [-10, 10]) {
    if (!planeCrossing(from.z, to.z, zWall) || Math.abs(dz) < 1e-6) continue;
    const t = (zWall - from.z) / dz;
    const xAtWall = from.x + dx * t;
    if (Math.abs(xAtWall) > 1.85) return true;
    const doorIndex = zWall === -10 ? 0 : 1;
    if (doorOpen[doorIndex] !== true) return true;
  }
  for (const xWall of [-10, 10]) {
    if (!planeCrossing(from.x, to.x, xWall) || Math.abs(dx) < 1e-6) continue;
    const t = (xWall - from.x) / dx;
    const zAtWall = from.z + dz * t;
    if (Math.abs(zAtWall) > 1.85) return true;
    const doorIndex = xWall === -10 ? 2 : 3;
    if (doorOpen[doorIndex] !== true) return true;
  }
  return false;
}

const MAP_SOLID_RECTS = Object.freeze({
  TF_COURTYARD: [
    [-36.5,-28.5,-35.5,28.5], [35.5,-28.5,36.5,28.5],
    [-35.5,-29,35.5,-28], [-35.5,28,35.5,29],
    [-13,-18,-9,-3], [-13,3,-9,18], [9,-18,13,-3], [9,3,13,18],
    [-4,-5,4,-2], [-4,2,4,5], [-24,-3,-19,3], [19,-3,24,3],
    [-3.5,-23,3.5,-21], [-3.5,21,3.5,23], [-26,-3,-24,3], [24,-3,26,3]
  ],
  TF_DEPOT: [
    [-36.5,-28.5,-35.5,28.5], [35.5,-28.5,36.5,28.5],
    [-35.5,-29,35.5,-28], [-35.5,28,35.5,29],
    [-20,-18,-16,-5], [-20,5,-16,18], [16,-18,20,-5], [16,5,20,18],
    [-5,-17,5,-13], [-5,13,5,17], [-3,-4,3,4],
    [-3.5,-23,3.5,-21], [-3.5,21,3.5,23], [-26,-3,-24,3], [24,-3,26,3]
  ],
  BOMB_RAVINE: [
    [-75,-52,-73.5,52], [73.5,-52,75,52],
    [-73.5,-53,73.5,-51.5], [-73.5,51.5,73.5,53],
    [-26,-11,-19,11], [19,-11,26,11],
    [-61,-24,-51,-21], [-61,-24,-58,-8], [-61,8,-51,11], [-54,8,-51,21],
    [51,-24,61,-21], [58,-24,61,-8], [51,8,61,11], [51,8,54,21],
    [-7,-28,-3,-8], [3,8,7,28], [-7,8,-3,28], [3,-28,7,-8],
    [-51.5,-27.5,-38.5,-22.5], [-51,17.5,-39,22.5], [38.5,-27.5,51.5,-22.5], [39,17.5,51,22.5],
    [-17,-3,-9,3], [9,-3,17,3], [-6,-20,6,-16], [-6,16,6,20]
  ]
});
function segmentIntersectsRect(from, to, rect, padding = 0.42) {
  const [minX, minZ, maxX, maxZ] = rect;
  const left = minX - padding, right = maxX + padding;
  const top = minZ - padding, bottom = maxZ + padding;
  const dx = to.x - from.x, dz = to.z - from.z;
  let t0 = 0, t1 = 1;
  const p = [-dx, dx, -dz, dz];
  const q = [from.x - left, right - from.x, from.z - top, bottom - from.z];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-9) { if (q[i] < 0) return false; continue; }
    const t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) return false; t0 = Math.max(t0, t); }
    else { if (t < t0) return false; t1 = Math.min(t1, t); }
  }
  return t0 <= t1;
}
function isMapLineBlocked(mapId, from, to, doorOpen = []) {
  const bounds = mapMovementBounds(mapId);
  if (Math.abs(to.x) > bounds.x || Math.abs(to.z) > bounds.z) return true;
  if (mapId === "HILL_TOWN") return hillTownCrossingBlocked(from, to, doorOpen);
  const rects = MAP_SOLID_RECTS[mapId];
  return Boolean(rects && rects.some(rect => segmentIntersectsRect(from, to, rect)));
}

function handleTeamShot(io, match, shooter, data) {
  if (!["team_fight", "allies"].includes(match.mode) || match.phase !== "game") return;

  const weaponId = normalizeWeaponId(data?.weapon);
  const weapon = WEAPON_BALANCE[weaponId];
  const dx = Number(data?.dx);
  const dy = Number(data?.dy);
  const dz = Number(data?.dz);
  if (![dx, dy, dz].every(Number.isFinite)) return;

  const aim = new THREE_LIKE_VECTOR(dx, dy, dz);
  if (aim.length() < 0.01) return;
  aim.normalize();
  if (Math.hypot(aim.x, aim.z) < 0.01) return;

  const now = Date.now();
  if (now - (shooter.lastShotAt || 0) < weapon.fireDelay) return;
  shooter.lastShotAt = now;
  io.to(match.id).emit("player_shot", {
    shooterId: shooter.userId,
    x: shooter.pos.x,
    y: shooter.pos.y + 1.42,
    z: shooter.pos.z,
    dx: aim.x, dy: aim.y, dz: aim.z,
    weapon: weaponId
  });

  let best = null;
  let bestDistance = Infinity;

  for (const target of match.players) {
    if (target.userId === shooter.userId || target.team === shooter.team || target.hp <= 0) continue;

    const vx = target.pos.x - shooter.pos.x;
    const vz = target.pos.z - shooter.pos.z;
    const dist = Math.hypot(vx, vz);
    if (weapon.type === "melee" ? (dist > weapon.range || dist < 0.25) : (dist > weapon.range || dist < 0.5)) continue;

    const dot = (aim.x * vx + aim.z * vz) / (Math.max(0.01, Math.hypot(aim.x, aim.z)) * dist);
    if (dot < (weapon.type === "melee" ? 0.72 : 0.985)) continue;

    if (dist < bestDistance) {
      best = target;
      bestDistance = dist;
    }
  }

  if (!best || isMapLineBlocked(match.map, shooter.pos, best.pos, match.doorOpen)) return;

  const hitZone = detectWeaponHitZone(shooter.pos, best.pos, aim, bestDistance);
  const damage = calculateWeaponDamage(weaponId, hitZone, bestDistance);
  best.hp = Math.max(0, best.hp - damage);
  const killed = best.hp <= 0;
  if (killed) {
    best.deaths += 1;
    shooter.kills += 1;
    shooter.score += 1;
  }

  io.to(match.id).emit("player_hit", {
    shooterId: shooter.userId,
    targetId: best.userId,
    weapon: weaponId,
    hitZone,
    damage,
    killed,
    hp: best.hp,
    score: shooter.score
  });

  if (!killed) return;
  setTimeout(() => {
    if (!activeMatches.has(match.id) || match.finished) return;
    respawnPlayer(match, best);
    io.to(match.id).emit("player_respawn", {
      userId: best.userId,
      x: best.pos.x,
      y: best.pos.y,
      z: best.pos.z,
      hp: best.hp
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

function mapMovementBounds(mapId) {
  return ({
    HILL_TOWN: { x: 25.2, z: 25.2 },
    TF_COURTYARD: { x: 35.1, z: 28.1 },
    TF_DEPOT: { x: 35.1, z: 28.1 },
    BOMB_RAVINE: { x: 73, z: 51.2 },
    NEON_YARD: { x: 196, z: 196 },
    FIELD_ARENA: { x: 320, z: 320 },
    M3_Maze: { x: 228, z: 228 }
  })[mapId] || { x: 228, z: 228 };
}
function validateMove(player, data, mapId = "M3_Maze", match = null) {
  const now = Date.now();
  if (now - player.lastMoveAt < 33) return false;
  player.lastMoveAt = now;

  const x = Number(data.x), y = Number(data.y), z = Number(data.z), rotY = Number(data.rotY);
  if (![x, y, z, rotY].every(Number.isFinite)) return false;
  const bound = mapMovementBounds(mapId);
  if (Math.abs(x) > bound.x || Math.abs(z) > bound.z) return false;

  const prev = player.pos;
  const elapsed = Math.min(0.25, Math.max(0.033, (now - (player.prevMoveTime || now)) / 1000));
  player.prevMoveTime = now;

  const maxStep = Math.max(0.35, 18 * elapsed);
  const dx = x - prev.x;
  const dz = z - prev.z;
  const planarDistance = Math.hypot(dx, dz);
  const limitedScale = planarDistance > Math.max(0.35, 18 * elapsed) ? Math.max(0.35, 18 * elapsed) / planarDistance : 1;
  const requested = { x: prev.x + dx * limitedScale, z: prev.z + dz * limitedScale };
  if (isMapLineBlocked(mapId, prev, requested, match?.doorOpen)) return false;

  if (planarDistance > maxStep) {
    const scale = maxStep / planarDistance;
    player.pos.x += dx * scale;
    player.pos.z += dz * scale;
  } else {
    player.pos.x = x;
    player.pos.z = z;
  }
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
    if (!canUseTesterModes(user)) {
      return socket.emit("training_error", { message: "Цей режим доступний лише тестерам." });
    }
    if (!cfg) return socket.emit("training_error", { message: "Невідомий тестовий режим." });

    const previous = trainingSessions.get(user.id);
    const sessionMap = ["field_test", "training"].includes(mode) ? normalizeMapId(data?.map) : cfg.map;
    const TRAINING_SPAWNS = {
      HILL_TOWN: {x:0,y:0,z:0},
      NEON_YARD: {x:0,y:0,z:115},
      FIELD_ARENA: {x:0,y:0,z:0},
      M3_Maze: {x:5,y:0,z:5}
    };
    const spawnPosition = { ...(TRAINING_SPAWNS[sessionMap] || {x:0,y:0,z:0}) };
    const session = {
      id: "practice_" + crypto.randomBytes(10).toString("hex"),
      userId: user.id,
      nickname: user.nickname,
      mode: cfg.id,
      modeName: cfg.name,
      map: sessionMap,
      socketId: socket.id,
      playerPos: spawnPosition,
      playerRotY: 0,
      bot: ["field_test", "training"].includes(mode) ? { id: "training_bot", nickname: "ТРЕНУВАЛЬНА МІШЕНЬ", role: "runner", team: "B", hp: 100, maxHp: 100, hits: 0, x: spawnPosition.x, y: 0, z: spawnPosition.z - 8, rotY: Math.PI, action: "idle", updatedAt: Date.now() } : null,
      spawnPosition: { ...spawnPosition },
      lastMoveAt: 0,
      lastActionAt: 0,
      lastShotAt: 0,
      doorOpen: [false, false, false, false],
      woodDestroyed: [],
      createdAt: Date.now()
    };
    if (previous?.bot?.despawnTimer) clearTimeout(previous.bot.despawnTimer);
    trainingSessions.set(user.id, session);
    socket.emit("training_started", {
      trainingId: session.id,
      userId: user.id,
      mode: cfg.id,
      modeName: cfg.name,
      map: session.map,
    });
  });

  socket.on("join_training", data => {
    const user = socket.user;
    if (!canUseTesterModes(user)) return socket.emit("kick_to_menu", { reason: "Режим доступний лише тестерам." });
    const session = trainingSessions.get(user.id);
    if (!session || session.id !== cleanText(data?.trainingId, 100)) {
      return socket.emit("kick_to_menu", { reason: "Тренувальну сесію не знайдено." });
    }
    session.socketId = socket.id;
    socket.join(session.id);
    socket.emit("training_init", {
      trainingId: session.id,
      mode: session.mode,
      modeName: session.modeName,
      map: session.map,
      spawn: { ...session.playerPos },
      bot: session.bot,
      doorOpen: [...(session.doorOpen || [false, false, false, false])],
      woodDestroyed: [...(session.woodDestroyed || [])]
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

    const bound = mapMovementLimit(session.map);
    if (Math.abs(x) > bound || Math.abs(z) > bound) return;
    const previous = session.playerPos;
    const maxStep = 0.9;
    const dx = x - previous.x, dz = z - previous.z;
    const distance = Math.hypot(dx, dz);
    const candidate = distance > maxStep && distance > 0
      ? { x: previous.x + dx / distance * maxStep, z: previous.z + dz / distance * maxStep }
      : { x, z };
    if (isMapLineBlocked(session.map, previous, candidate, session.doorOpen)) return;
    if (distance > maxStep) {
      previous.x += dx / distance * maxStep;
      previous.z += dz / distance * maxStep;
    } else {
      previous.x = x;
      previous.z = z;
    }
    previous.y = Math.max(0, Math.min(2.25, y));
    session.playerRotY = Number.isFinite(viewY) ? viewY : rotY;
  });

  socket.on("training_spawn_bot", data => {
    const session = trainingSessions.get(socket.user?.id);
    if (!session || session.socketId !== socket.id || session.id !== cleanText(data?.trainingId, 100)) return;
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

  socket.on("training_bot_action", data => {
    const session = trainingSessions.get(socket.user?.id);
    if (!session || session.socketId !== socket.id || session.id !== cleanText(data?.trainingId, 100) || !session.bot) return;
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
    trainingSessions.delete(socket.user.id);
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

    const mode = ["allies", "team_fight", "bomb"].includes(data?.mode) ? data.mode : "allies";
    const map = normalizeMapForMode(mode, data?.map);
    removeFromQueue(user.uuid || user.id);

    // Bot matches are privileged test tooling only; public users cannot spoof prototype=true.
    if ((data?.prototype === true || data?.testerBots === true) &&
        canUseTesterModes(user) && ["allies", "team_fight"].includes(mode)) {
      const realPlayer = { socketId: socket.id, userId: user.id, nickname: user.nickname, uuid: user.uuid, mode, map, isBot: false };
      const bots = Array.from({ length: Math.max(0, getRequiredPlayers(mode) - 1) }, (_, index) => ({
        socketId: null,
        userId: "BOT_" + crypto.randomBytes(4).toString("hex"),
        nickname: "БОТ " + String(index + 1).padStart(2, "0"),
        uuid: "", mode, map, isBot: true
      }));
      socket.emit("search_started", { mode, modeName: MODE_CONFIGS[mode].name, map, mapName: PLAYABLE_MAPS[map].name, prototype: true });
      createMatch(io, mode, map, [realPlayer, ...bots]);
      return;
    }

    matchmakingQueue.push({
      socketId: socket.id,
      userId: user.id,
      nickname: user.nickname,
      uuid: user.uuid,
      mode,
      map
    });

    socket.emit("search_started", { mode, modeName: MODE_CONFIGS[mode].name, map, mapName: PLAYABLE_MAPS[map].name });
    emitQueueCount(io);
    scheduleMatchmaking(io, mode, map);
  });

  socket.on("cancel_search", () => {
    if (removeFromQueue(socket.user.uuid || socket.user.id, socket.id)) emitQueueCount(io);
  });

  socket.on("leave_match", data => {
    const matchId = cleanText(data?.matchId, 100);
    const match = activeMatches.get(matchId);
    if (!match) return;

    const index = match.players.findIndex(p => (p.uuid ? p.uuid === socket.user.uuid : p.userId === socket.user.id) && (p.socketId === socket.id || p.socketId === null));
    if (index < 0) return;

    const player = match.players[index];
    if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
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
      doorOpen: [...(match.doorOpen || [false, false, false, false])],
      woodDestroyed: [...(match.woodDestroyed || [])],
      bomb: bombStatePayload(match),
      me: {
        userId: player.userId,
        nickname: player.nickname,
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
    if (match.phase === "game") {
      socket.emit("match_phase", {
        phase: "game",
        time: match.remaining,
        mode: match.mode,
        modeName: match.modeName
      });
      socket.emit("match_start_now", { mode: match.mode, modeName: match.modeName, reconnect: true });
      socket.emit("timer_update", { phase: "game", time: match.remaining });
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

  socket.on("team_shoot", data => {
    const match = activeMatches.get(cleanText(data?.matchId, 100));
    if (!match) return;
    const player = match.players.find(p => (p.uuid ? p.uuid === socket.user.uuid : p.userId === socket.user.id) && p.socketId === socket.id);
    if (!player || player.hp <= 0) return;
    handleTeamShot(io, match, player, data);
  });

  socket.on("bomb_interact", data => {
    const match = activeMatches.get(cleanText(data?.matchId, 100));
    if (!match || match.mode !== "bomb") return;
    const player = match.players.find(p => (p.uuid ? p.uuid === socket.user.uuid : p.userId === socket.user.id) && p.socketId === socket.id);
    if (!player) return;
    handleBombInteraction(io, match, player, cleanText(data?.action, 16));
  });

  socket.on("map_door_state", data => {
    const doorIndex = Number(data?.doorIndex);
    const open = data?.open === true;
    if (!Number.isInteger(doorIndex) || doorIndex < 0 || doorIndex > 3) return;
    const match = activeMatches.get(cleanText(data?.matchId, 100));
    if (match) {
      const player = match.players.find(p => (p.uuid ? p.uuid === socket.user.uuid : p.userId === socket.user.id) && p.socketId === socket.id);
      if (!player || player.hp <= 0 || match.map !== "HILL_TOWN") return;
      const doors = [[0,-10],[0,10],[-10,0],[10,0]];
      const [x,z] = doors[doorIndex];
      if (Math.hypot(player.pos.x-x, player.pos.z-z) > 4.5) return;
      match.doorOpen[doorIndex] = open;
      socket.to(match.id).emit("map_door_state", { doorIndex, open });
      return;
    }
    const session = trainingSessions.get(socket.user?.id);
    if (!session || session.socketId !== socket.id || session.id !== cleanText(data?.trainingId, 100) || session.map !== "HILL_TOWN") return;
    const doors = [[0,-10],[0,10],[-10,0],[10,0]];
    const [x,z] = doors[doorIndex];
    if (Math.hypot(session.playerPos.x-x, session.playerPos.z-z) > 4.5) return;
    session.doorOpen[doorIndex] = open;
    socket.to(session.id).emit("map_door_state", { doorIndex, open });
  });

  socket.on("map_wood_destroyed", data => {
    const woodIndex = Number(data?.woodIndex);
    if (!Number.isInteger(woodIndex) || woodIndex < 0 || woodIndex > 19) return;
    const match = activeMatches.get(cleanText(data?.matchId, 100));
    if (match) {
      const player = match.players.find(p => (p.uuid ? p.uuid === socket.user.uuid : p.userId === socket.user.id) && p.socketId === socket.id);
      if (!player || player.hp <= 0 || match.map !== "HILL_TOWN") return;
      if (!match.woodDestroyed.includes(woodIndex)) match.woodDestroyed.push(woodIndex);
      socket.to(match.id).emit("map_wood_destroyed", { woodIndex });
      return;
    }
    const session = trainingSessions.get(socket.user?.id);
    if (!session || session.socketId !== socket.id || session.id !== cleanText(data?.trainingId, 100) || session.map !== "HILL_TOWN") return;
    if (!session.woodDestroyed.includes(woodIndex)) session.woodDestroyed.push(woodIndex);
    socket.to(session.id).emit("map_wood_destroyed", { woodIndex });
  });

    socket.on("player_moved", data => {
    const match = activeMatches.get(cleanText(data?.matchId, 100));
    if (!match) return;
    const player = match.players.find(p => p.userId === socket.user.id);
    if (!player || player.socketId !== socket.id || player.hp <= 0) return;
    if (!validateMove(player, data, match.map, match)) return;

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
      io.to(matchId).emit("player_connection_state", { userId: player.userId, connected: false, reconnectSeconds: 90 });

      if (match.phase === "waiting") {
        // A navigation or dropped connection can take a moment; pause the initial
        // join timeout and give the new socket the same reconnect grace period.
        if (match.joinTimer) clearTimeout(match.joinTimer);
        match.joinTimer = null;
      }

      if (match.phase !== "game") {
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
        // During live gameplay, never end/delete a match just because one player
        // vanished. Keep the identity slot so a late reconnect can rejoin it.
        if (current.phase === "game") {
          io.to(matchId).emit("player_connection_state", { userId: player.userId, connected: false, reconnectExpired: true });
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
      }, 90000);
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
