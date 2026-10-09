const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const htmlFiles = ["auth.html", "mainMenu.html", "admin.html", "play2.html"];
const read = name => fs.readFileSync(path.join(root, name), "utf8");

function getExecutableScripts(html, file) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    const attrs = match[1] || "";
    if (/\bsrc\s*=/i.test(attrs) || /type\s*=\s*["']importmap["']/i.test(attrs)) continue;
    let js = match[2] || "";
    if (/type\s*=\s*["']module["']/i.test(attrs)) {
      js = js.replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/gm, "");
      js = js.replace(/^\s*import\s+\{\s*GLTFLoader\s*\}\s+from\s+["']three\/addons\/loaders\/GLTFLoader\.js["'];?\s*$/gm, "");
      js = js.replace(/^\s*import\s+\{\s*PointerLockControls\s*\}\s+from\s+["']three\/addons\/controls\/PointerLockControls\.js["'];?\s*$/gm, "");
    }
    out.push({ file, index: out.length + 1, js });
  }
  return out;
}

new vm.Script(read("server.js"), { filename: "server.js" });
console.log("OK server.js syntax");

for (const file of htmlFiles) {
  const html = read(file);
  const scripts = getExecutableScripts(html, file);
  for (const script of scripts) {
    new vm.Script(script.js, { filename: file + "#script-" + script.index });
  }
  console.log("OK " + file + " scripts: " + scripts.length);
}

const server = read("server.js");
const menu = read("mainMenu.html");
const admin = read("admin.html");
const game = read("play2.html");
assert.match(server, /function requireAuth\(req, res, next\)[\s\S]*?req\.user = user;\s*next\(\);/);
assert.match(server, /function finishMatch\(io, matchId\)/, "game timer must have a finish handler");
assert.match(server, /const ADMIN_PASSWORD = String\(process\.env\.ADMIN_PASSWORD \|\| ""\)/, "admin password must only come from the environment");
assert.doesNotMatch(server, /process\.env\.ADMIN_PASSWORD\s*\|\|\s*["']sonia["']/, "source must not contain a fallback admin password");
assert.match(server, /ADMIN_PASSWORD is not set; master account login is disabled/, "missing admin secret must fail closed");
assert.match(server, /const SESSION_TTL_MS = 30 \* 24 \* 60 \* 60 \* 1000/);
assert.match(server, /expiresAt: now \+ SESSION_TTL_MS/, "sessions must expire");
assert.match(server, /SameSite=Lax/);
assert.match(server, /BLOCKED_STATIC_DIRS/, "private directories must not be served statically");
assert.match(server, /const privateRootFile = segments\.length === 1/, "root data/code files must be private");
const rootPrivatePatternMatch = server.match(/const privateRootFile = segments\.length === 1 && (\/.*?\/i)\.test\(rootName\)/);
assert.ok(rootPrivatePatternMatch, "static guard must contain an extension denylist");
const rootPrivatePatternBody = rootPrivatePatternMatch[1].slice(1, rootPrivatePatternMatch[1].lastIndexOf("/"));
const blocksPrivateRootFile = new RegExp(rootPrivatePatternBody, "i");
assert.ok(blocksPrivateRootFile.test("account.json"), "static guard must block account.json");
assert.ok(blocksPrivateRootFile.test("server.js"), "static guard must block server.js");
assert.match(server, /for \(let i = 0; i < 4; i \+= 1\)/, "static path guard must decode nested escapes");
assert.match(server, /IMAGE_EXTENSIONS = Object\.freeze/, "uploaded image extension must be based on validated MIME type");
assert.match(server, /if \(!socket\.user \|\| \(socket\.user\.isBanned/, "banned users must be rejected by Socket.IO");
assert.match(server, /if \(user\.isBanned && user\.id !== ADMIN_ID\) return res\.status\(403\)/, "banned admins must not use protected APIs");
assert.ok(server.indexOf("const nextPassword =") < server.indexOf("const oldId = u.id"), "admin password validation must happen before mutating the user");

assert.match(server, /app\.use\(express\.static\(ROOT, \{ index: false, dotfiles: "deny" \}\)\)/);
assert.match(server, /RateLimit-Limit/, "critical endpoints must have rate limiting");
assert.match(server, /requiredPlayers: 3/, "hide and seek requires three players");
assert.match(server, /requiredPlayers: 4/, "team fight must be 2v2");
assert.match(server, /count: modePlayers\.length/, "queue count must be the total number waiting");
assert.match(server, /players: modePlayers\.map/, "queue must send a waiting player roster");
assert.match(server, /function normalizeClanState\(rawClans\)/, "legacy and Atlas clan records must be normalized");
assert.match(server, /app\.post\("\/api\/clans\/update"/, "clan owner must be able to edit clan details");
assert.match(server, /app\.post\("\/api\/clans\/transfer"/, "clan owner must be able to transfer ownership");
assert.match(server, /clan_request_notification/, "new clan requests must notify owners and officers");
assert.match(server, /socket\.on\("join_clan_chat"/, "clan members need a real-time chat");
assert.match(server, /socket\.on\("send_clan_msg"/, "clan chat messages must be processed server-side");
assert.match(server, /socket\.on\("leave_clan_chat"/, "clients must be able to leave clan chat rooms");
assert.match(server, /app\.post\("\/api\/admin\/clans\/update"/, "admins must be able to edit clans");
assert.match(server, /app\.post\("\/api\/admin\/clans\/delete"/, "admins must be able to remove clans");
assert.match(server, /const affectedIds = new Set\(users\.filter\(user => user\.clan === tag\)\.map\(user => user\.id\)\)/, "admin clan deletion must revoke live member chat access");
assert.match(server, /client\.user\?\.id === target\.id[\s\S]{0,180}client\.leave\("clan:" \+ clan\.tag\)/, "kicked members must leave the clan chat room");
assert.match(server, /client\.user\?\.id === id\) client\.disconnect\(true\)/, "deleted accounts must be disconnected immediately");


assert.match(server, /user\.isAdmin = user\.id === ADMIN_ID \? true : Boolean\(user\.isAdmin\)/, "master account must remain admin");
assert.match(server, /const changingId = !isMaster && nextIdRaw !== u\.id/, "legacy IDs must be editable without changing ID");
assert.match(server, /const atlasUsers = await load\("state_users", users\)/, "invalid Atlas documents must not overwrite runtime state");
assert.match(server, /socket\.on\("leave_match"/, "gameplay client must be able to leave the match");
assert.match(server, /disconnectTimer: null/, "live matches must support reconnect grace periods");
assert.match(server, /ready < current\.players\.length/, "lobbies must time out if map loading never becomes ready");
assert.match(server, /const activeMatches = new Map\(\);[^\n]*in-memory only/);
assert.match(server, /const trainingSessions = new Map\(\);[^\n]*never written to MongoDB/);
assert.match(server, /app\.post\("\/api\/admin\/atlas\/check"/);
assert.match(server, /tls: true/, "Atlas TLS must stay enabled without disabling certificate verification");
assert.match(server, /function publicUser\(user, options = \{\}\)/, "UUID is opt-in on user payloads");
assert.match(server, /options\.includeUuid === true/, "UUID is only included for the account owner");
assert.match(server, /data\?\.testerBots === true && canUseTesterModes\(user\)/, "the server authorizes tester bot matches");
assert.match(server, /isBot: Boolean\(p\.isBot\)/, "match roster includes bot status");
assert.match(server, /isTester/);
assert.match(menu, /data-test-gameplay="prototype"/, "testers can launch the prototype");
assert.match(menu, /data-test-gameplay="real"/, "testers can play a full team match with bots");
assert.doesNotMatch(menu, /data-mode="(?:training|field_test)"/, "prototype and real gameplay are not separate public modes");
assert.match(menu, /localStorage.getItem\("sx_test_gameplay"\)/, "the tester choice persists locally");
assert.match(menu, /testerBots:canTest\(\)&&testGameplayMode==="real"/, "only testers request bot matches");
assert.match(menu, /id="modeModal"/, "Play must show a mode selection modal");
assert.match(menu, /id="confirmModeBtn"/, "mode selection must have an explicit confirmation button");
assert.match(menu, /renderWaitPlayers\(d\.players\|\|\[\]\)/, "queue UI must render the waiting roster");
assert.match(menu, /playerId=esc\(cleanId\(p\.userId\|\|p\.id\|\|["']—["']\)\)/, "queue UI must display player IDs");
assert.match(game, /class='player-id'>/, "waiting lobby must show player identifiers");
assert.match(game, /p\.isBot\?"БОТ":"ID "\+playerId/, "idle match bots are clearly labelled");
assert.match(menu, /join_clan_chat/, "menu must connect to the clan chat");
assert.match(menu, /send_clan_msg/, "menu must send clan chat messages");
assert.match(menu, /data-clan-action='transfer'/, "clan owner UI must expose transfer ownership");
assert.match(menu, /data-clan-action='promote'/, "clan owner UI must expose officer promotion");
assert.match(menu, /data-clan-action='demote'/, "clan owner UI must expose officer demotion");
assert.match(menu, /data-clan-action='edit'/, "clan owner UI must expose clan editing");
assert.match(menu, /clan_request_notification/, "menu must show clan application notifications");
assert.match(admin, /data-clan-admin='edit'/, "admin UI must expose clan editing");
assert.match(admin, /data-clan-admin='delete'/, "admin UI must expose clan deletion");
assert.match(server, /crypto\.randomUUID\(\)/, "every account must have a UUID");
assert.match(server, /user\.uuid = crypto\.randomUUID\(\)/, "legacy accounts must receive a UUID");
assert.match(server, /users\.find\(candidate => candidate\.uuid === id\)/, "login must accept the unique UUID");
assert.match(server, /createSession\(user\.uuid \|\| user\.id\)/, "sessions must use UUID where available");
assert.doesNotMatch(server, /Такий нік вже зайнятий/, "nicknames must be allowed to repeat");
assert.match(server, /function newPlayerId\(\)/, "new public IDs must be generated uniquely");
assert.match(server, /function migratePlayerIds\(\)/, "legacy duplicate player IDs must be repaired");
assert.match(server, /playerIdExists\(nextIdRaw\)/, "admin edits must not create duplicate player IDs");
assert.match(server, /const PLAYABLE_MAPS = Object\.freeze/, "matchmaking must validate map selections");
assert.match(server, /p\.mode === entry\.mode && p\.map === entry\.map/, "players on different maps must not be mixed into one queue");
assert.match(server, /createMatch\(io, mode, map\)/, "the selected map must reach the match");
assert.match(read("auth.html"), /id="createdUuid"/, "registration must display the UUID");
assert.match(menu, /data-theme-choice="cyan"/, "menu must offer the cyan theme");
assert.match(menu, /data-theme-choice="violet"/, "menu must offer the violet theme");
assert.match(menu, /data-theme-choice="red"/, "menu must offer the red theme");
assert.match(menu, /data-map="M3_Maze"/, "menu must offer the main map");
assert.match(menu, /data-map="FIELD_ARENA"/, "menu must offer the field arena");
assert.match(menu, /data-map="NEON_YARD"/, "menu must offer the neon yard map");
assert.doesNotMatch(menu, /DEV BUILD/i, "the main menu must not show development-build labels");
assert.match(menu, /id="profilePageUuid"/, "the player profile must display UUID");
assert.match(game, /function requestMouseLook\(\)/, "mouse look must be activatable from the game view");
assert.match(game, /new PointerLockControls\(camera,renderer\.domElement\)/, "mouse look must lock to the game canvas");
assert.match(game, /document\.pointerLockElement===renderer\.domElement/, "camera input must track canvas pointer lock");
assert.doesNotMatch(read("auth.html"), /DEV BUILD/i, "sign-in must not show development labels");
assert.match(menu, /StandoffX menu remake/, "the menu must use the refreshed neon styling");
assert.match(menu, /position:fixed!important;right:28px!important;bottom:28px!important/, "Play must be anchored to the lower-right corner");
assert.match(game, /controls\.pointerSpeed=mouseSensitivity/, "mouse look must use the saved sensitivity");
assert.match(game, /function buildNeonYard\(\)/, "the selected neon map must be implemented");
assert.match(game, /selectedMap==="NEON_YARD"/, "game must load the selected map");



assert.match(admin, /id="fTester"/);
assert.match(game, /training_spawn_bot/);
assert.match(game, /training_bot_action/);
assert.match(menu, /DEFAULT_KEYBINDS/, "settings must define default training key bindings");
assert.match(menu, /data-bind-action="spawnBot"/, "settings must let players remap bot spawning");
assert.match(menu, /data-bind-action="resetSession"/, "settings must let players remap training reset");
assert.match(menu, /data-bind-action="menu"/, "settings must let players remap the in-game menu");
assert.match(menu, /current\.keybinds=binds/, "custom key bindings must be saved in localStorage");
assert.match(menu, /refreshProfileIdentity\(\)/, "opening the profile must refresh the UUID from the account API");
assert.match(menu, /api\("\/api\/user-data\?id="/, "profile UUID refresh must have a user-data fallback");
assert.match(game, /function runTrainingAction\(action\)/, "training actions must be keyboard-driven");
assert.match(game, /function togglePauseMenu\(force\)/, "the game must have a keyboard-toggleable menu");
assert.match(game, /menu:"KeyM"/, "M must open the in-game menu by default");
assert.match(game, /function renderTrainingKeyHints\(\)/, "training HUD must show the configured action keys");
assert.doesNotMatch(game, /id="spawnBot"/, "training bot controls must no longer require on-screen buttons");
assert.doesNotMatch(game, /id="resetTraining"/, "training reset must be keyboard-driven");

assert.equal((menu.split("<script src=")[0].match(/\sonclick\s*=/gi) || []).length, 0, "menu must not contain inline onclick handlers");

const routes = [...server.matchAll(/app\.(get|post|put|patch|delete)\(["']([^"']+)["']/gi)]
  .map(match => match[1].toUpperCase() + " " + match[2]);
const duplicates = routes.filter((route, index) => routes.indexOf(route) !== index);
assert.deepEqual([...new Set(duplicates)], [], "HTTP routes must not be duplicated");

assert.match(server, /HILL_TOWN: \{ id: "HILL_TOWN"/, "server must allow the Hill Town map");
assert.match(server, /id: "allies"[\s\S]*?requiredPlayers: 4/, "Allies must have a four-player server queue");
assert.match(server, /!\["team_fight", "allies"\]\.includes\(match\.mode\)/, "team combat handler must accept Allies");
assert.match(menu, /data-mode="allies"/, "menu must offer Allies");
assert.match(menu, /data-mode="team_fight"/, "menu must offer Team Fight");
assert.match(menu, /data-map="HILL_TOWN"/, "menu must offer Hill Town");
assert.match(game, /async function buildHillTownMap\(\)/, "game must assemble the new map from modular assets");
assert.match(game, /HILL_TOWN_MANIFEST_URL/, "game must load the public CC0 map asset manifest");
assert.match(game, /async function loadHeldWeapon\(\)/, "game must load a first-person weapon model");
assert.match(game, /e\.code==="Escape"\)\{e\.preventDefault\(\);leaveGame\(\);return\}/, "Escape must return to the lobby from any match phase");
assert.match(game, /if\(selectedMap==="FIELD_ARENA"\)\{/, "prototype must honor the selected map rather than forcing the field arena");
assert.doesNotMatch(game, / · UUID "\+uuid/, "the match lobby must not display UUIDs");

assert.match(game, /function makeVisual\(color\)[\s\S]*?new THREE\.CylinderGeometry[\s\S]*?function setSoldierTint/, "soldiers must have a multi-part procedural 3D model");
assert.match(game, /function animateSoldier\(model,dt,now,moving=false,inAir=false\)/, "player models must animate without relying on external model downloads");
assert.match(game, /animateSoldier\(e\.mesh,dt,now,e\.anim==="Running"\|\|e\.anim==="Walking",e\.anim==="Jump"\)/, "remote player movement must drive the walk/jump animation");
assert.match(game, /if\(e\.code===binds\.menu\)\{e\.preventDefault\(\);if\(matchPhase==="game"\)togglePauseMenu\(\);return\}/, "M opens the in-game pause menu instead of accidentally leaving the match");
assert.match(game, /stick\.addEventListener\("touchcancel",releaseStick\)/, "cancelled mobile joystick touches must release movement");
assert.match(game, /\$\("fireBtn"\)\.addEventListener\("touchcancel",\(\)=>fireHeld=false\)/, "cancelled mobile fire touches must stop shooting");
assert.match(game, /socket\.on\("player_left"/, "departed players must be removed from the scene");
assert.match(game, /e\.pos\.set\(data\.x,data\.y,data\.z\);e\.mesh\.position\.copy\(e\.pos\);e\.anim="Idle"/, "a respawn must update both the displayed and authoritative remote position");
assert.match(game, /let connectedToGameplay=socket\.connected/, "the client must rejoin the match after a Socket.IO reconnection");
assert.match(game, /matchPhase="finished"/, "the player must stop moving and shooting after match results");

assert.match(server, /const mode = \["allies", "team_fight"\]\.includes\(data\?\.mode\) \? data\.mode : "allies"/, "public matchmaking must reject obsolete/private modes");
assert.match(server, /current\.players\.filter\(p => !p\.isBot\)\.length === 0 \|\| current\.players\.length < 2/, "bot matches must be cleaned after the last human disconnects");
assert.match(menu, /if\(!\["allies","team_fight"\]\.includes\(selectedMode\)\)\{selectedMode="allies";localStorage\.setItem\("sx_mode",selectedMode\)\}/, "obsolete local storage mode values must not break the lobby");
assert.match(game, /let lookTouchId=null/, "mobile look must use independent touch IDs");
assert.match(game, /document\.addEventListener\("touchcancel",releaseLookTouch\)/, "cancelled look touches must clear their state");
assert.match(game, /window\.addEventListener\("blur",clearHeldInputs\)/, "focus loss must release all held controls");
assert.match(game, /document\.addEventListener\("visibilitychange",\(\)=>\{if\(document\.hidden\)clearHeldInputs\(\)\}\)/, "backgrounding the tab must release held controls");

assert.match(game, /setTimeout\(\(\)=>controller\.abort\(\),8000\)/, "a stalled map manifest fetch must abort instead of hanging the lobby");
assert.match(game, /setTimeout\(\(\)=>\{[\s\S]{0,160}3D asset loading timed out/, "a stalled GLB request must resolve into the map fallback path");

assert.match(server, /function removeFromQueue\(identity, socketId = null\)/, "queue removal must support ownership by the exact socket");
assert.match(server, /if \(removeFromQueue\(socket\.user\.uuid \|\| socket\.user\.id, socket\.id\)\) emitQueueCount\(io\)/, "stale tabs must not cancel a newer socket's queue");
assert.match(server, /const existingQueueIndex = matchmakingQueue\.findIndex\(p => p\.userId === user\.id\)/, "duplicate queue requests must be handled rather than hanging silently");
assert.match(server, /Пошук перенесено в інше вікно/, "an older tab must be notified when search moves to a new connection");

console.log("OK project invariants, tester-only tools, Atlas endpoint, and unique HTTP routes");
