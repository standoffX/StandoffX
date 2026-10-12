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
const ui = read("ui.css");
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
assert.match(server, /requiredPlayers: 4/, "four-player 2v2 remains the target team size");
assert.match(server, /const MATCHMAKING_MIN_PLAYERS = 2/, "a real multiplayer match can start when two people are queued");
assert.match(server, /function getMinimumPlayers\(mode\)/, "public team modes use a minimum roster size");
assert.match(server, /function scheduleMatchmaking\(io, mode, mapId\)/, "matchmaking waits briefly for more players, then starts a smaller live match");
assert.match(server, /MATCHMAKING_FILL_WINDOW_MS = 3500/, "the matchmaking fill window is finite");
assert.match(server, /function mapMovementLimit\(mapId\)/, "server rejects movement outside supported map boundaries");
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
assert.match(menu, /data-test-gameplay="real"[^>]*>ГРА/, "the tester's full-match option must be labelled Game, not Test");
assert.match(menu, /real:"ГРА"/, "the selected tester mode must use the Game label");
assert.match(menu, /COMING SOON/, "not-yet-built ranks and news must be labelled Coming Soon");
assert.match(menu, /class="promo-col panel"/, "the main menu must include the news/updates panel");
assert.match(menu, /sx_abandoned_match/, "the lobby must finish a queued leave request after reconnecting");
assert.match(menu, /data-test-gameplay="real"/, "testers can play a full team match with bots");
assert.match(menu, /data-test-gameplay="training"/, "testers can launch a dedicated training session");
assert.match(menu, /mode:testGameplayMode==="training"\?"training":"field_test"/, "training selector must start the actual training session");
assert.match(menu, /class="tester-mode-switch"/, "tester mode must use a compact switch instead of large cards");
assert.match(menu, /class="tester-mode-segment"/, "prototype/test options must share one compact segmented control");
assert.match(menu, /createRealtimeSocket\(\)[\s\S]{0,260}transports:\["websocket"\]/, "menu sockets must avoid polling session IDs on Render");
assert.match(menu, /reconnectionAttempts:Infinity/, "menu socket connections must retry rather than disconnect on transient errors");
assert.match(game, /transports:\["websocket"\]/, "gameplay socket must avoid polling-to-websocket sid upgrade errors");
assert.match(game, /reconnectionAttempts:Infinity/, "gameplay must automatically reconnect after Render restarts");
assert.match(ui, /grid-template-columns:minmax\(260px,1fr\) minmax\(250px,\.95fr\) minmax\(300px,1\.12fr\)/, "desktop lobby columns must stay roomy");
assert.match(ui, /@media\(max-width:980px\)/, "lobby must preserve its full three-column layout on common desktop widths");
assert.match(game, /class="training-action-grid"/, "training must keep its full visible action panel");
assert.match(game, /data-training-action="spawnBot"/, "training must expose a clickable spawn bot action");
assert.match(game, /data-training-action="resetBot"/, "training must expose a clickable reset bot action");
assert.match(game, /data-training-action="push"/, "training must expose a clickable push action");
assert.match(game, /data-training-action="kick"/, "training must expose a clickable kick action");
assert.match(game, /data-training-action="boost"/, "training must expose a clickable boost action");
assert.match(game, /data-training-action="resetSession"/, "training must expose a clickable session reset action");
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
assert.match(server, /const WEAPON_BALANCE = Object\.freeze\(/, "server must maintain the authoritative weapon balance table");
assert.match(server, /const damage = calculateWeaponDamage\(weaponId, hitZone, bestDistance\)/, "server calculates damage instead of trusting the client");
assert.match(server, /best\.hp = Math\.max\(0, best\.hp - damage\)/, "a hit reduces HP by the equipped weapon's damage");
assert.match(server, /if \(!killed\) return;/, "the victim only respawns when their HP reaches zero");
assert.match(server, /session\.lastShotAt \|\| 0\) < weapon\.fireDelay/, "training shots are rate-limited per weapon");
assert.doesNotMatch(server, /bot\.hp = Math\.max\(0, bot\.hp - \(Number\(data\.damage\) \|\| 34\)\)/, "training clients cannot choose arbitrary damage values");
assert.match(menu, /data-mode="allies"/, "menu must offer Allies");
assert.match(menu, /data-mode="team_fight"/, "menu must offer Team Fight");
assert.match(menu, /data-map="HILL_TOWN"/, "menu must offer Hill Town");
assert.match(game, /async function buildHillTownMap\(\)/, "game must assemble the new map from modular assets");
assert.match(game, /HILL_TOWN_MANIFEST_URL/, "game must load the public CC0 map asset manifest");
assert.match(game, /async function loadHeldWeapon\(\)/, "game must load a first-person weapon model");
assert.match(game, /function makeFallbackP350\(\)/, "the client must render the P350 pistol when equipped");
assert.match(game, /function makeFallbackKnife\(\)/, "the client must render a knife when equipped");
assert.match(game, /function selectWeaponBySwipe\(dx,dy\)/, "phone has a dedicated gesture switch so camera-look swipes stay available");
assert.match(game, /Math\.abs\(dy\)>Math\.abs\(dx\)&&dy>0\)selectWeapon\("akr"\)/, "swiping down on the weapon control equips AKR");
assert.match(game, /Math\.abs\(dx\)>Math\.abs\(dy\)&&dx<0\)selectWeapon\("p350"\)/, "swiping left on the weapon control equips P350");
assert.match(game, /Math\.abs\(dx\)>Math\.abs\(dy\)&&dx>0\)selectWeapon\("knife"\)/, "swiping right on the weapon control equips knife");
assert.match(game, /body\.reconnecting #overlay #loadingDetails/, "reconnect screen hides loading diagnostics and keeps the two exit choices focused");
assert.match(game, /function addGameplayDoor\(/, "Hill Town has hinged door entities");
assert.match(game, /function interactWithNearestDoor\(/, "doors can be opened and closed with E or the mobile interaction button");
assert.match(game, /function addBreakableWood\(/, "Hill Town has breakable wooden cover");
assert.match(game, /function damageBreakableWood\(/, "shooting can damage and destroy wooden cover");
assert.match(game, /id="interactBtn"/, "mobile HUD has a door interaction button");
assert.match(game, /socket\.emit\("map_door_state"/, "door state is sent to the server");
assert.match(game, /socket\.emit\("map_wood_destroyed"/, "destroyed wooden cover is synchronized");
assert.match(game, /socket\.on\("map_door_state"/, "clients apply other players' door changes");
assert.match(game, /socket\.on\("map_wood_destroyed"/, "clients apply other players' wooden-cover destruction");
assert.match(server, /socket\.on\("map_door_state"/, "server validates and broadcasts door changes");
assert.match(server, /socket\.on\("map_wood_destroyed"/, "server validates and broadcasts destroyed wood");
assert.match(server, /Math\.hypot\(player\.pos\.x-x, player\.pos\.z-z\) > 18/, "door changes require the player to be nearby");
assert.match(game, /if\(e\.code==="Digit1"\)[\s\S]{0,100}selectWeapon\("akr"\)/, "1 must equip the AKR");
assert.match(game, /if\(e\.code==="Digit2"\)[\s\S]{0,100}selectWeapon\("p350"\)/, "2 must equip the P350");
assert.match(game, /if\(e\.code==="Digit3"\)[\s\S]{0,100}selectWeapon\("knife"\)/, "3 must equip the knife");
assert.match(game, /e\.button===2\)\{e\.preventDefault\(\);toggleAimingDownSights\(\)/, "right mouse must toggle AKR aiming on/off");
assert.match(game, /camera\.fov=aimingDownSights\?48:74/, "AKR aiming must change camera FOV and restore normal view on a second click");
assert.match(game, /id="weaponBtn"/, "mobile HUD must include weapon switching");
assert.match(game, /weapon:"weaponBtn"/, "mobile weapon switch must use saved HUD position and size");
assert.match(menu, /data-layout-control="weapon"/, "mobile HUD editor must preview the weapon switch");
assert.match(menu, /data-size-control="weapon"/, "mobile HUD editor must allow an independent weapon button size");
assert.match(menu, /data-layout-control="interact"/, "mobile HUD editor must preview the interact button");
assert.match(menu, /data-size-control="interact"/, "mobile HUD editor must allow a separately sized interact button");
assert.match(game, /socket\.emit\("team_shoot",\{matchId,weapon:selectedWeapon/, "the client must identify which weapon is fired");
assert.match(game, /socket\.emit\("training_shoot",\{trainingId,weapon:selectedWeapon/, "training shots must identify the equipped weapon");
assert.match(game, /e\.code==="Escape"\)\{e\.preventDefault\(\);leaveGame\(\);return\}/, "Escape must return to the lobby from any match phase");
assert.match(game, /if\(selectedMap==="FIELD_ARENA"\)\{/, "prototype must honor the selected map rather than forcing the field arena");
assert.doesNotMatch(game, / · UUID "\+uuid/, "the match lobby must not display UUIDs");

assert.match(game, /function makeVisual\(color\)[\s\S]*?new THREE\.CylinderGeometry[\s\S]*?function setSoldierTint/, "soldiers must have a multi-part procedural 3D model");
assert.match(game, /function animateSoldier\(model,dt,now,moving=false,inAir=false,crouching=false\)/, "player models must animate and crouch without relying on external model downloads");
assert.match(game, /animateSoldier\(e\.mesh,dt,now,e\.anim==="Running"\|\|e\.anim==="Walking",e\.anim==="Jump",e\.anim==="Crouch"\)/, "remote player movement must also animate crouching");
assert.match(game, /if\(e\.code===binds\.menu\)\{e\.preventDefault\(\);if\(matchPhase==="game"\)togglePauseMenu\(\);return\}/, "M opens the in-game pause menu instead of accidentally leaving the match");
assert.match(game, /stick\.addEventListener\("touchcancel",releaseStick\)/, "cancelled mobile joystick touches must release movement");
assert.match(game, /\$\("fireBtn"\)\.addEventListener\("touchcancel",\(\)=>fireHeld=false\)/, "cancelled mobile fire touches must stop shooting");
assert.match(game, /socket\.on\("player_left"/, "departed players must be removed from the scene");
assert.match(game, /e\.pos\.set\(data\.x,data\.y,data\.z\);e\.mesh\.position\.copy\(e\.pos\);e\.anim="Idle"/, "a respawn must update both the displayed and authoritative remote position");
assert.match(game, /let connectedToGameplay=socket\.connected/, "the client must rejoin the match after a Socket.IO reconnection");
assert.match(game, /const HILL_TOWN_SCALE=2\.55/, "Hill Town must be dramatically larger than its original footprint");
assert.match(game, /clone\.scale\.multiplyScalar\(HILL_TOWN_SCALE\)/, "map GLB assets must be uniformly scaled rather than stretched horizontally");
assert.match(game, /new THREE\.BoxGeometry\(w\*HILL_TOWN_SCALE,h\*HILL_TOWN_SCALE,d\*HILL_TOWN_SCALE\)/, "procedural fallback geometry must use the same scale on all axes");
assert.match(game, /return \(\{HILL_TOWN:65,NEON_YARD:196,FIELD_ARENA:320,M3_Maze:228\}\)/, "client movement must stay inside the map perimeter");
assert.match(game, /NEON_YARD_SCALE=2/, "Neon Yard must have an enlarged play area");
assert.match(game, /FIELD_ARENA_SCALE=2/, "Field Arena must have an enlarged play area");
assert.match(game, /map\.scale\.setScalar\(82\.5\)/, "the M3 map must be enlarged too");
assert.match(game, /function rebuildCollisionIndex\(\)/, "map geometry must be registered for solid collision");
assert.match(game, /function blockedAt\(x,z\)/, "the player must be blocked by solid map objects");
assert.match(game, /function moveWithCollision\(direction,distance\)/, "movement must use small collision-tested steps instead of crossing walls at sprint speed");
assert.match(game, /if\(penaltyX===0\|\|penaltyX<current-\.001\)player\.position\.x=nx/, "collision must permit sliding along the X axis");
assert.match(game, /if\(penaltyZ===0\|\|penaltyZ<currentAfterX-\.001\)player\.position\.z=nz/, "collision must permit sliding along the Z axis");
assert.match(game, /e\.code==="ControlLeft"\|\|e\.code==="ControlRight"/, "desktop Ctrl must control crouching");
assert.match(game, /keys\.shift\?14\.5:8\.5/, "sprint must be faster than walking");
assert.match(game, /id="crouchBtn"/, "mobile HUD must include crouching");
assert.match(game, /id="sprintBtn"/, "mobile HUD must include sprinting");
assert.match(game, /sprintBtn\.addEventListener\("touchstart"/, "mobile sprint must be hold-to-run");
assert.match(game, /crouchBtn\.addEventListener\("touchstart"/, "mobile crouch must be supported");
assert.match(game, /const isMobileDevice=.*navigator\.userAgent/, "gameplay must detect mobile devices before deciding which controls to show");
assert.match(game, /body\.device-desktop #mobile\{display:none!important\}/, "desktop must never show the mobile button cluster");
assert.match(game, /body\.device-mobile #mobile\{display:block!important\}/, "mobile must show touch controls even in desktop browser mode");
assert.match(game, /function applyMobileHudLayout\(\)/, "gameplay must apply saved mobile HUD sizes and positions to real controls");
assert.match(game, /sizes\[key\]\?\?config\.size/, "each touch control must keep its own saved scale percentage");
assert.match(game, /id="radarCanvas"/, "match HUD must include a minimap radar");
assert.match(game, /id="fullMapCanvas"/, "tactical map must render the entire selected map");
assert.match(game, /e\.code==="KeyF"/, "holding F must open the tactical map");
assert.match(game, /e\.team!==myTeam/, "radar must show own team only instead of revealing all enemies");
assert.match(game, /id="reconnectBtn"/, "the in-match overlay must offer a manual reconnect button");
assert.match(game, /id="reconnectExitBtn"/, "the reconnect overlay must offer an exit action beneath Connect");
assert.match(game, /id="loadingDetails"/, "the loading overlay must identify the resources being loaded");
assert.match(game, /id="mapLoadStatus"/, "the loading overlay must show map status");
assert.match(game, /id="weaponLoadStatus"/, "the loading overlay must show weapon status");
assert.match(game, /id="connectionLoadStatus"/, "the loading overlay must show server connection status");
assert.ok(game.includes('localStorage.setItem("sx_abandoned_match"'), "leaving during a network outage must queue match cleanup");
assert.match(game, /socket\.on\("player_connection_state"/, "players should stay on the map when teammates temporarily disconnect");
assert.match(menu, /id="resumeMatchBtn"/, "the lobby must offer reconnect to a previously interrupted match");
assert.match(menu, /data-size-control="fire"/, "the mobile layout editor must let players size the fire button separately");
assert.match(menu, /data-size-control="crouch"/, "the mobile layout editor must let players size crouch separately");
assert.match(menu, /data-size-control="sprint"/, "the mobile layout editor must let players size sprint separately");
assert.match(menu, /document\.documentElement\.dataset\.sxDevice/, "lobby must detect device type and show matching settings");
assert.match(ui, /html\[data-sx-device="mobile"\] body\.lobby-screen #desktopControlsSettings/, "mobile must not display keyboard/mouse-only settings");
assert.match(ui, /html\[data-sx-device="desktop"\] body\.lobby-screen #mobileLayoutEditor/, "desktop must not show touch-only settings");
assert.match(server, /}, 90000\);/, "reconnect grace must last long enough to get back into the match");
assert.match(server, /never end\/delete a match[\s\S]{0,220}if \(current\.phase === "game"\)/, "gameplay disconnect timeout must keep the match alive");
assert.match(server, /const MATCH_SPAWNS =/, "scaled maps must use safe per-map spawn points");
assert.match(server, /HILL_TOWN: \[\{x:-52,y:0,z:-52\},\{x:52,y:0,z:-52\},\{x:-52,y:0,z:52\},\{x:52,y:0,z:52\}\]/, "Hill Town match spawns must be clear of building footprints and inside the outer walls");
assert.match(server, /match\.doorOpen\[doorIndex\] = open/, "server retains the authoritative state of each match door");
assert.match(server, /io\.to\(matchId\)\.emit\("player_connection_state", \{ userId: player\.userId, connected: false/, "disconnect should not broadcast a permanent player-left event");
assert.match(server, /p\.socketId === socket\.id \|\| p\.socketId === null/, "an authenticated player can explicitly leave their disconnected match slot");
assert.match(server, /if \(session\.socketId !== null && session\.socketId !== socket\.id\) return/, "an authenticated tester can close a disconnected training session");
assert.match(game, /function addTownFallbackArch\(/, "fallback town doors must preserve walkable archways");
assert.match(ui, /grid-template-columns:minmax\(260px,1fr\) minmax\(250px,\.95fr\) minmax\(300px,1\.12fr\)/, "lobby layout must stay roomy on desktop");
assert.match(game, /matchPhase="finished"/, "the player must stop moving and shooting after match results");

assert.match(server, /const mode = \["allies", "team_fight"\]\.includes\(data\?\.mode\) \? data\.mode : "allies"/, "public matchmaking must reject obsolete/private modes");
assert.match(server, /match\.players\.filter\(p => !p\.isBot\)\.length === 0 \|\| match\.players\.length < 2/, "voluntary leaving must still clean an empty bot match");
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

assert.match(server, /if \(!player \|\| player\.hp <= 0\) return;\s*handleTeamShot/, "dead players must not be able to shoot on the server");
assert.match(server, /if \(!player \|\| player\.socketId !== socket\.id \|\| player\.hp <= 0\) return;\s*if \(!validateMove/, "dead players must not be able to move on the server");
assert.match(game, /id="deathNotice"/, "players must receive clear feedback when eliminated");
assert.match(game, /matchPhase!=="game"\|\|reloading\|\|hp<=0/, "dead clients cannot fire or reload");
assert.match(game, /matchPhase==="game"&&player&&hp>0/, "local movement must freeze until respawn");

assert.match(game, /mapLoadFinished\?"none":"flex"/, "the prototype must keep its loading screen until the map is ready");
assert.match(game, /matchPhase==="game"&&player&&hp>0&&mapLoadFinished/, "movement must wait until the selected map has finished loading");
assert.match(game, /matchPhase!=="game"\|\|reloading\|\|hp<=0\|\|!mapLoadFinished/, "shooting and reloading must be blocked until the map loads");

assert.match(game, /function setSoldierDown\(model,down\)/, "eliminated soldiers must visibly drop until respawn");
assert.match(game, /victim\.hp=Math\.max\(0,Number\(data\.hp\)\|\|0\);[\s\S]{0,100}setSoldierDown\(victim\.mesh,true\)/, "the victim HP is updated and lethal hits visibly eliminate the model");
assert.match(game, /hitConfirmTimer=setTimeout\(\(\)=>crosshair\.classList\.remove\("hit"\),150\)/, "the shooter must receive visual hit confirmation");
assert.match(game, /setSoldierDown\(e\.mesh,false\);setSoldierTint\(e\.mesh,colorFor\(e\.role,e\.team\)\)/, "respawning enemies must return to their normal pose and team colors");

assert.match(game, /if\(p\.hp<=0\)\{p\.anim="Dead";setSoldierDown\(p\.mesh,true\)\}/, "rejoining clients must render eliminated players as down until respawn");

assert.match(game, /const camera=new THREE\.PerspectiveCamera\([^;]+\);\s*\/\/ Camera-attached weapon and view models must belong to the rendered scene graph\.\s*scene\.add\(camera\);/, "camera-mounted weapon models must be in the scene graph to render");

assert.match(game, /function buildLocalHillTownFallback\(\)/, "Hill Town must have a playable fallback made from local geometry");
assert.match(game, /buildLocalHillTownFallback\(\);finishClientReady\(\)/, "a failed remote Hill Town asset load must still start the match using town geometry");
assert.doesNotMatch(game, /Remote models unavailable; using local fallback\.\",error\);\s*buildFieldArena\(\)/, "Hill Town must not silently turn into a field arena when the CDN fails");

assert.match(server, /players\.some\(candidate => candidate\.isBot\) \? \(p\.isBot \? "B" : "A"\)/, "all tester bots must be on the opposing team and be shootable targets");

assert.match(server, /player\.pos\.y = Math\.max\(0, Math\.min\(2\.25, y\)\)/, "match movement must reject impossible fly heights");
assert.match(server, /previous\.y = Math\.max\(0, Math\.min\(2\.25, y\)\)/, "training movement must reject impossible fly heights");
assert.match(server, /const sessionMap = \["field_test", "training"\]\.includes\(mode\) \? normalizeMapId\(data\?\.map\) : cfg\.map;/, "training must use whichever map the tester selected");
assert.match(server, /bot: \["field_test", "training"\]\.includes\(mode\)/, "full training must begin with a target");
assert.match(server, /const maxStep = 0\.9;/, "training movement must support the faster sprint speed");
assert.match(server, /player\.anim = \["Idle", "Running", "Jump", "Walking", "Crouch"\]/, "the server must retain the crouch animation state");

const validateMoveFunction = server.match(/function validateMove\(player, data\) \{[\s\S]*?\n\}/);
assert.ok(validateMoveFunction, "the server movement validator must be available for behavioral tests");
const validateMove = vm.runInNewContext("(" + validateMoveFunction[0] + ")");
const movingPlayer = {
  lastMoveAt: Date.now() - 120,
  prevMoveTime: Date.now() - 120,
  pos: { x: 0, y: 0, z: 0 },
  rotY: 0,
  anim: "Idle"
};
assert.equal(validateMove(movingPlayer, { x: 100, y: 100, z: 0, rotY: 0, anim: "Running" }), true);
assert.ok(movingPlayer.pos.x > 0 && movingPlayer.pos.x <= 4.5, "large planar movement must be rate-limited to the validator maximum");
assert.equal(movingPlayer.pos.y, 2.25, "vertical position must remain within the supported jump height");
assert.equal(movingPlayer.anim, "Running");
const beforeInvalidMove = { ...movingPlayer.pos };
const invalidPlayer = {
  lastMoveAt: Date.now() - 120,
  prevMoveTime: Date.now() - 120,
  pos: { ...movingPlayer.pos },
  rotY: 0,
  anim: "Idle"
};
assert.equal(validateMove(invalidPlayer, { x: "not-a-number", y: 0, z: 0, rotY: 0, anim: "Teleport" }), false);
assert.deepEqual(invalidPlayer.pos, beforeInvalidMove, "invalid movement must not change authoritative coordinates");
const unknownAnimationPlayer = {
  lastMoveAt: Date.now() - 120,
  prevMoveTime: Date.now() - 120,
  pos: { x: 0, y: 0, z: 0 },
  rotY: 0,
  anim: "Idle"
};
assert.equal(validateMove(unknownAnimationPlayer, { x: 0.1, y: 0, z: 0, rotY: 0, anim: "Teleport" }), true);
assert.equal(unknownAnimationPlayer.anim, "Idle", "unknown animation states must be rejected");

assert.match(server, /if \(mongoClient !== client\) return/, "a stale MongoDB close event must not clear a newer client");
assert.match(server, /const failedClient = mongoClient;\s*mongoClient = null;\s*mongoDb = null;\s*mongoStatus\.connected = false;\s*mongoStatus\.state = "error";\s*mongoStatus\.lastError = cleanText\(err\.message, 240\);\s*try \{ await failedClient\?\.close\(\); \} catch \{\}/, "Atlas ping failures must reset the broken client so a later health check can reconnect");

const weaponStart = server.indexOf("const WEAPON_BALANCE = Object.freeze(");
const weaponEnd = server.indexOf("function handleTeamShot", weaponStart);
assert.ok(weaponStart >= 0 && weaponEnd > weaponStart, "the authoritative weapon helper block must exist");
const weaponHelpers = vm.runInNewContext(
  "(()=>{" + server.slice(weaponStart, weaponEnd) + ";return {WEAPON_BALANCE,normalizeWeaponId,calculateWeaponDamage,detectWeaponHitZone}})()",
  { cleanText: (value, max = 200) => String(value ?? "").slice(0, max) }
);
assert.equal(weaponHelpers.normalizeWeaponId("unknown"), "akr", "invalid weapon IDs must fall back to AKR");
assert.equal(weaponHelpers.calculateWeaponDamage("akr", "head", 5), 164, "AKR head damage at five metres must use the balance table");
assert.equal(weaponHelpers.calculateWeaponDamage("akr", "body", 10), 34, "AKR body damage must fall off with distance");
assert.equal(weaponHelpers.calculateWeaponDamage("p350", "stomach", 5), 49, "P350 stomach damage at five metres must use the balance table");
assert.equal(weaponHelpers.calculateWeaponDamage("p350", "head", 25), 51, "P350 head damage must fall off at long range");
assert.equal(weaponHelpers.calculateWeaponDamage("knife", "body", 1), 110, "knife melee damage must be close-range damage, not rifle damage");
assert.equal(weaponHelpers.detectWeaponHitZone({x:0,y:0,z:0},{x:0,y:0,z:-10},{x:0,y:0,z:-1},10), "head", "camera-height aim should classify as a headshot");
assert.equal(weaponHelpers.detectWeaponHitZone({x:0,y:0,z:0},{x:0,y:0,z:-10},{x:0,y:-0.08,z:-1},10), "stomach", "downward aim should classify stomach hits");
assert.equal(weaponHelpers.detectWeaponHitZone({x:0,y:0,z:0},{x:0,y:0,z:-10},{x:0,y:-0.15,z:-1},10), "legs", "steeper downward aim should classify leg hits");

console.log("OK project invariants, weapon damage balance, ADS, tester-only tools, Atlas endpoint, and unique HTTP routes");
