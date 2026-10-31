const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, name), "utf8");
const htmlFiles = ["auth.html", "mainMenu.html", "admin.html", "play2.html"];

function executableScripts(html, file) {
  const scripts = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    const attrs = match[1] || "";
    if (/\bsrc\s*=/i.test(attrs) || /type\s*=\s*["']importmap["']/i.test(attrs)) continue;
    let js = match[2] || "";
    if (/type\s*=\s*["']module["']/i.test(attrs)) {
      // The CI runner only needs to parse module bodies; external Three.js
      // imports are resolved by the browser at runtime.
      js = js.replace(/^\s*import\s+.*?;\s*$/gm, "");
    }
    scripts.push({ file, index: scripts.length + 1, js });
  }
  return scripts;
}

const server = read("server.js");
const menu = read("mainMenu.html");
const game = read("play2.html");
const mobileCss = read("mobile-game.css");
const mobileJs = read("mobile-game.js");
const manifest = JSON.parse(read("manifest.webmanifest"));
const admin = read("admin.html");
const auth = read("auth.html");

// Parse every executable script, including module bodies after import stripping.
new vm.Script(server, { filename: "server.js" });
console.log("OK server.js syntax");
for (const file of htmlFiles) {
  const scripts = executableScripts(read(file), file);
  for (const script of scripts) {
    new vm.Script(script.js, { filename: file + "#script-" + script.index });
  }
  console.log("OK " + file + " scripts: " + scripts.length);
}
new vm.Script(mobileJs, { filename: "mobile-game.js" });
console.log("OK mobile-game.js syntax");

// Account, session and database safety invariants.
assert.match(server, /function requireAuth\(req, res, next\)/);
assert.match(server, /function sessionTokenHash\(token\)/);
assert.match(server, /const SESSION_TTL_MS = 30 \* 24 \* 60 \* 60 \* 1000/);
assert.match(server, /SameSite=Lax/);
assert.match(server, /const ADMIN_PASSWORD = String\(process\.env\.ADMIN_PASSWORD \|\| ""\)/);
assert.doesNotMatch(server, /process\.env\.ADMIN_PASSWORD\s*\|\|\s*["']sonia["']/);
assert.match(server, /const JSON_FALLBACK_ENABLED = process\.env\.STANDOFFX_ALLOW_JSON_FALLBACK === "1"/);
assert.match(server, /MongoDB Atlas is required but unavailable/);
assert.match(server, /const activeMatches = new Map\(\);[^\n]*in-memory only/);
assert.match(server, /const trainingSessions = new Map\(\);[^\n]*never written to MongoDB/);
assert.match(server, /crypto\.randomUUID\(\)/);
assert.match(server, /function newPlayerId\(\)/);
assert.doesNotMatch(server, /Такий нік вже зайнятий/);

// Zone 9 is the only valid map and every supported mode uses it.
const mapBlock = server.match(/const PLAYABLE_MAPS = Object\.freeze\(\{([\s\S]*?)\}\);/);
assert.ok(mapBlock, "server must define its playable map allowlist");
assert.match(mapBlock[1], /ZONE_9/);
assert.doesNotMatch(mapBlock[1], /SANDSTONE|SMALL_YARD|HILL_TOWN|M3_Maze|FIELD_ARENA|NEON_YARD/);
assert.match(server, /function normalizeMapId\(value\) \{\s*return "ZONE_9";/);
assert.match(server, /id: "allies"[\s\S]*?map: "ZONE_9"[\s\S]*?requiredPlayers: 4/);
assert.match(server, /id: "team_fight"[\s\S]*?map: "ZONE_9"[\s\S]*?requiredPlayers: 3/);
assert.match(server, /id: "team_fight_3v3"[\s\S]*?map: "ZONE_9"[\s\S]*?requiredPlayers: 6/);
assert.doesNotMatch(server, /id: "hide_seek"|field_test: \{ id: "field_test"/);
assert.match(server, /function createMatch\(io, mode,[\s\S]{0,300}const safeMapId = "ZONE_9"/);
assert.match(server, /ZONE_9: \[\{x:-92,y:0,z:92\}[\s\S]*?\{x:92,y:0,z:-86\}\]/);
assert.match(server, /team_fight_3v3[\s\S]{0,500}requiredPlayers: 6/);
assert.match(server, /match\.mode === "team_fight_3v3"/, "3v3 results are grouped by team score");
assert.match(server, /teamScore/);
assert.match(server, /socket\.on\("start_training"/);
assert.match(server, /training: \{ id: "training", name: "TRAINING", map: "ZONE_9"/);
assert.match(server, /bot: null,/);
assert.doesNotMatch(server, /bot: mode === "field_test"/);
assert.match(server, /if \(!canUseTesterModes\(user\)\)[\s\S]{0,180}training_error/);

// Main menu: three battle modes, solo tester training, one map, no old map picker.
for (const mode of ["allies", "team_fight", "team_fight_3v3", "training"]) {
  assert.ok(menu.includes('data-mode="' + mode + '"'), "main menu must expose " + mode);
}
assert.match(menu, /СОЮЗНИКИ · 2 НА 2/);
assert.match(menu, /КБ · 1 НА 1 НА 1/);
assert.match(menu, /КОМАНДНИЙ БІЙ · 3 НА 3/);
assert.match(menu, /ТРЕНУВАННЯ/);
assert.match(menu, /data-map="ZONE_9"/);
assert.doesNotMatch(menu, /data-map="(?:SANDSTONE|SMALL_YARD|HILL_TOWN|M3_Maze|FIELD_ARENA|NEON_YARD)"/);
assert.match(menu, /const MAPS=\{ZONE_9:"ZONE 9"\}/);
assert.match(menu, /requiredPlayers=selectedMode==="allies"\?4:selectedMode==="team_fight_3v3"\?6:3/);
assert.match(menu, /const searchMap="ZONE_9"/);
assert.match(menu, /members\.slice\(0,6\)/);
assert.match(menu, /lobbyModeSelect[\s\S]{0,260}team_fight_3v3/);
assert.match(menu, /id="homeAgentCanvas"/);
assert.match(menu, /Excited_CT\.fbx/);
assert.match(menu, /Excited\.fbx/);
assert.match(menu, /OTCChA_D\.tga/);
assert.match(menu, /FSB_A_D\.tga/);
assert.match(menu, /function createActor\(person,index,side\)/);
assert.doesNotMatch(menu, /soldier_tac\.glb/);
assert.doesNotMatch(menu, /DEV BUILD/i);

// FPS: actual Zone 9 GLB and model-repository FBX weapon and T/CT character assets.
assert.match(game, /zone9prototype\/main\/zone9\.glb/);
assert.match(game, /const TACTICAL_AGENT_URL=TACTICAL_AGENT_BASE\+"Excited\.fbx"/);
assert.match(game, /const TACTICAL_AGENT_CT_URL=TACTICAL_AGENT_BASE\+"Excited_CT\.fbx"/);
assert.match(game, /new TGALoader/);
assert.match(game, /function setTacticalAgentSide\(model,side\)/);
assert.match(game, /function loadTacticalAgentModel\(\)/);
assert.match(game, /MODEL_REPO_BASE/);
for (const asset of [
  "Rifles/Akr.fbx", "Pistols/P350.fbx", "Pistols/Deagle.fbx",
  "Rifles/M4a1.fbx", "Submachine%20Guns/P90.fbx",
  "Heavy%20weapons/Sm1014.fbx", "Sniper%20Rifles/Awm.fbx", "Knifes/Karambit.fbx"
]) {
  assert.ok(game.includes(asset), "weapon list must include " + asset);
}
assert.doesNotMatch(game, /Gloves\/Gloves\.fbx|addWeaponHands\(\);/);
assert.match(game, /KNIFE_SKIN_MODEL_URLS=\{\}/);
assert.match(game, /async function loadPlayerSkinLoadout\(\)[\s\S]{0,180}equippedSkinLoadout=\{\}/);
assert.doesNotMatch(game, /fetch\("\/api\/skins"/);
assert.match(game, /function makeFallbackWeaponById/);
assert.match(game, /function finishClientReady\(\)/);
assert.match(game, /function requestMouseLook\(\)/);
assert.match(game, /new PointerLockControls\(camera,renderer\.domElement\)/);

// Mobile: landscape PWA hint, responsive HUD and browser capability fallback.
assert.equal(manifest.orientation, "landscape");
assert.equal(manifest.display, "standalone");
assert.match(menu, /href="\/mobile-game\.css"/);
assert.match(menu, /src="\/mobile-game\.js"/);
assert.match(game, /href="\/mobile-game\.css"/);
assert.match(game, /src="\/mobile-game\.js"/);
assert.match(mobileJs, /requestFullscreen/);
assert.match(mobileJs, /orientation\.lock\("landscape"\)/);
assert.match(mobileJs, /ПОВЕРНИ ТЕЛЕФОН/);
assert.match(mobileCss, /orientation:landscape/);
assert.match(mobileCss, /#mobile \.stick/);
assert.match(mobileCss, /#mobile \.fire/);

// Retired collection/market screens stay out of the visible menu until the new skins arrive.
assert.match(mobileCss, /data-view="store"[\s\S]{0,240}display:none/);
assert.match(mobileCss, /data-view="inventory"[\s\S]{0,240}display:none/);
assert.match(mobileCss, /data-view="market"[\s\S]{0,240}display:none/);
assert.match(mobileCss, /#authNote/);
assert.match(mobileCss, /home-hero-copy/);
assert.match(mobileCss, /coming-soon-tag/);

console.log("OK StandoffX Zone 9, 2v2/FFA/3v3, FBX agents/weapons and mobile landscape invariants");
