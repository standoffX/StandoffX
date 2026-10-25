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
      js = js.replace(/^\s*import\s+\*\s+as\s+SkeletonUtils\s+from\s+["']three\/addons\/utils\/SkeletonUtils\.js["'];?\s*$/gm, "");
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
assert.match(server, /const expiresAt = now \+ SESSION_TTL_MS/, "sessions must expire");
assert.match(server, /function sessionTokenHash\(token\)/, "durable sessions must store only a SHA-256 token hash");
assert.match(server, /user\.authSessions = \[[\s\S]*?tokenHash, createdAt: now, expiresAt/, "session hashes must be persisted with account data");
assert.match(server, /candidate\.authSessions\.some\(session => session\?\.tokenHash === tokenHash/, "session cookies must be restored after process restarts");
assert.match(server, /req\.user\.authSessions = \(Array\.isArray\(req\.user\.authSessions\)/, "logout must revoke the durable session");
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
assert.match(server, /id: "hide_seek"[\s\S]*?requiredPlayers: 3/, "hide and seek requires three players");
assert.match(server, /id: "allies"[\s\S]*?requiredPlayers: 4/, "Allies must be a four-player 2v2 mode");
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
assert.match(server, /async function loadMongoState\(name, legacySnapshot\)/, "MongoDB state uses an explicit one-time legacy import");
assert.match(server, /if \(existing\) \{\s*if \(!Object\.prototype\.hasOwnProperty\.call\(existing, "data"\)\)/, "an existing Atlas state document remains canonical");
assert.doesNotMatch(server, /for \(const localUser of localUsersSnapshot\)/, "legacy account data is not merged over an existing Atlas database");
assert.match(server, /const JSON_FALLBACK_ENABLED = process\.env\.STANDOFFX_ALLOW_JSON_FALLBACK === "1"/, "JSON persistence is disabled unless explicitly enabled for local development");
assert.match(server, /MongoDB Atlas is required but unavailable/, "production startup fails visibly when Atlas is unavailable");
assert.match(server, /socket\.on\("leave_match"/, "gameplay client must be able to leave the match");
assert.match(server, /disconnectTimer: null/, "live matches must support reconnect grace periods");
assert.match(server, /ready < current\.players\.length/, "lobbies must time out if map loading never becomes ready");
assert.match(server, /const activeMatches = new Map\(\);[^\n]*in-memory only/);
assert.match(server, /const MAX_CONCURRENT_MATCHES = Math\.max\(1, Math\.min\(100, Number\.parseInt\(process\.env\.MAX_CONCURRENT_MATCHES \|\| "100", 10\) \|\| 100\)\)/, "the server has a configurable but hard-capped limit of 100 live matches");
assert.match(server, /function createMatch\(io, mode, mapId = "M3_Maze", forcedCandidates = null\) \{\s*if \(activeMatches\.size >= MAX_CONCURRENT_MATCHES\) return null;/, "match creation stops cleanly at capacity without consuming queued players");
assert.match(server, /function processMatchmakingQueue\(io\)[\s\S]{0,1500}createMatch\(io, group\.mode, group\.map, candidates\)/, "the queued matchmaking groups are drained when match slots open");
assert.match(game, /if\(!force&&now-lastMoveSend<80\)return/, "movement updates are throttled to reduce traffic with up to 100 matches");
assert.match(server, /socket\.to\(match\.id\)\.volatile\.emit\("enemy_moved"/, "transient movement packets can be dropped under network backpressure");
assert.match(server, /maxConcurrentMatches: MAX_CONCURRENT_MATCHES/, "the health endpoint exposes the configured match limit");
assert.match(server, /available: Math\.max\(0, MAX_CONCURRENT_MATCHES - activeMatches\.size\)/, "admin status reports available match slots");
assert.match(server, /const trainingSessions = new Map\(\);[^\n]*never written to MongoDB/);
assert.match(server, /app\.post\("\/api\/admin\/atlas\/check"/);
assert.match(server, /tls: true/, "Atlas TLS must stay enabled without disabling certificate verification");
assert.match(server, /function publicUser\(user, options = \{\}\)/, "UUID is opt-in on user payloads");
assert.match(server, /options\.includeUuid === true/, "UUID is only included for the account owner");
assert.doesNotMatch(server, /data\?\.testerBots === true && canUseTesterModes\(user\)/, "human Game matches must not be filled with fake bot slots");
assert.match(server, /isBot: Boolean\(p\.isBot\)/, "match roster includes bot status");
assert.match(server, /isTester/);
assert.match(menu, /data-test-gameplay="prototype"/, "testers can launch the prototype");
assert.match(menu, /data-test-gameplay="real"[^>]*>ГРА/, "the tester's full-match option must be labelled Game, not Test");
assert.match(menu, /ГРА · РЕАЛЬНІ ГРАВЦІ/, "the Game option must promise a match against real players");
assert.match(menu, /COMING SOON/, "not-yet-built ranks and news must be labelled Coming Soon");
assert.match(menu, /class="promo-col panel"/, "the main menu must include the news/updates panel");
assert.match(menu, /sx_abandoned_match/, "the lobby must finish a queued leave request after reconnecting");
assert.match(menu, /data-test-gameplay="real"/, "all players can choose a real-player Game");
assert.doesNotMatch(menu, /data-test-gameplay="training"/, "the public type selector has only Prototype and Game");
assert.match(menu, /start_prototype_match/, "Prototype launches a regular game mode filled with static bots");
assert.match(menu, /return selectedMode==="allies"\?\["SANDSTONE"\]:\["SMALL_YARD","NEON_YARD"\]/, "map cards must be filtered to the selected mode in prototype and live play");
assert.match(menu, /class="tester-mode-switch"/, "tester mode must use a compact switch instead of large cards");
assert.match(menu, /class="tester-mode-segment"/, "prototype/test options must share one compact segmented control");
assert.match(menu, /createRealtimeSocket\(\)[\s\S]{0,260}transports:\["websocket"\]/, "menu sockets must avoid polling session IDs on Render");
assert.match(menu, /reconnectionAttempts:Infinity/, "menu socket connections must retry rather than disconnect on transient errors");
assert.match(game, /transports:\["websocket"\]/, "gameplay socket must avoid polling-to-websocket sid upgrade errors");
assert.match(game, /reconnectionAttempts:Infinity/, "gameplay must automatically reconnect after Render restarts");
assert.match(ui, /grid-template-columns:minmax\(260px,1fr\) minmax\(250px,\.95fr\) minmax\(300px,1\.12fr\)/, "desktop lobby columns must stay roomy");
assert.match(ui, /@media\(max-width:980px\)/, "lobby must preserve its full three-column layout on common desktop widths");
assert.match(game, /class="prototype-bot-panel"/, "prototype HUD must show a compact static-bot status panel");
assert.doesNotMatch(game, /id="(?:createBotBtn|deleteBotBtn)"|data-training-action="(?:spawnBot|removeBot)"/, "prototype must not expose create/delete bot buttons");
assert.doesNotMatch(game, /data-training-action=/, "prototype HUD must not expose bot action buttons");
assert.doesNotMatch(menu, /data-bind-action="(?:spawnBot|removeBot|push|kick|boost|resetBot)"/, "settings must not expose bot manipulation hotkeys");
assert.match(menu, /data-bind-action="resetSession"/, "prototype reset shortcut belongs in settings rather than the HUD");
assert.doesNotMatch(menu, /data-mode="(?:training|field_test)"/, "prototype and real gameplay are not separate public modes");
assert.match(menu, /localStorage.getItem\("sx_test_gameplay"\)/, "the tester choice persists locally");
assert.doesNotMatch(menu, /testerBots:/, "the Game search must not request bot slots");
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
assert.match(server, /SANDSTONE: \{ x: 60, z: 60 \}/, "server movement limits must match the expanded Sandstone perimeter");
assert.match(server, /attack: \[\{ x: -50, y: 0, z: -8\.75 \}/, "Sandstone attackers must spawn on the left/T side");
assert.match(server, /defense: \[\{ x: 50, y: 0, z: -8\.75 \}/, "Sandstone defenders must spawn on the right/CT side");
assert.match(server, /side === "attack" \? -Math\.PI \/ 2 : Math\.PI \/ 2/, "Sandstone players face across the map toward the opposing side");
assert.match(server, /minX: blocker\.minX \* 1\.25/, "server blockers must use the same Sandstone scale as client collisions");
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
assert.match(menu, /id="homeAgentCanvas"/, "the main screen has a dedicated transparent canvas for its central 3D agent");
assert.match(menu, /soldier_tac\.glb/, "the lobby preview loads the optimized tactical agent model");
assert.match(menu, /SkeletonUtils\.clone\(tacticalTemplate\)/, "the lobby clones the animated rig safely for every squad member");
assert.match(menu, /mesh\.rotation\.y=0;/, "the lobby agent faces the camera rather than showing its back");
assert.ok(menu.includes("homeYaw=(index-(n-1)/2)*-.035"), "squad members retain a forward-facing idle orientation");
assert.match(menu, /id="crossStyle"/, "settings allow selecting a crosshair shape");
assert.match(menu, /id="crossColor"/, "settings allow selecting a crosshair color");
assert.match(menu, /applyCrosshairPreview\(current\)/, "the crosshair preview updates and saves user selections");
assert.match(menu, /function createAgent\(index\)/, "the lobby has a model-based squad agent renderer");
assert.match(menu, /function animateIdle\(actor,now,dt\)/, "the home agent uses a dedicated idle breathing animation");
assert.match(menu, /SkeletonUtils\.clone\(tacticalTemplate\)/, "the home menu uses the new tactical character model only");
assert.doesNotMatch(menu, /function makeVisual\(color\)|function animateSoldier\(/, "the old menu mannequin is fully removed");
assert.doesNotMatch(menu, /mouseOffset/, "the agent must not track or rotate toward the pointer");
assert.match(menu, /raycaster\.intersectObjects\(roots,true\)/, "hovering the real agent triggers a deliberate sidestep");
assert.match(menu, /height:clamp\(390px,58dvh,450px\)/, "the home agent and squad panel adapt to phone-height viewports");
assert.match(menu, /home-friends-title/, "friends and squad are visible in the main menu");
assert.match(menu, /pendingHomeInvite=String\(userId\|\|""\)/, "quick invites create a lobby automatically when needed");
assert.match(menu, /const disabled=!friend\.status\|\|\(Boolean\(currentLobby\)\&\&currentLobby\.members\.length>=currentLobby\.maxPlayers\)/, "online friends can be invited from the main menu before a lobby exists");
assert.match(menu, /BATTLE PASS|SEASON PASS/i, "pass/event content remains on the right side of the home menu");
assert.match(menu, /home-hero \.playarea\{position:absolute!important;right:16px!important;left:auto!important;top:auto!important;bottom:16px!important/, "Play must be anchored to the lower-right corner of the central hero");
assert.match(game, /controls\.pointerSpeed=mouseSensitivity/, "mouse look must use the saved sensitivity");
assert.match(game, /function buildNeonYard\(\)/, "the selected neon map must be implemented");
assert.match(game, /const sandstoneScale=1\.25/, "Sandstone must use the expanded 1.25x world scale");
assert.match(game, /sandstoneRoot\.scale\.setScalar\(sandstoneScale\)/, "Sandstone geometry must be scaled as a single collision-safe root");
assert.doesNotMatch(game, /zoneMarker\("(?:MID|MARKET|TITANIC|ZIGA|KITCHEN|A SITE|B SITE)"/, "Sandstone must not draw floating text callouts over playable routes");
assert.doesNotMatch(game, /new THREE\.TorusGeometry\(\.44,\.035,6,20/, "the planted C4 must not have an attention-grabbing glow ring");
assert.match(game, /function createHeldBombVisual\(\)/, "the bomb carrier can equip a visible first-person C4 model");
assert.match(game, /if\(mode==="allies"&&!isTrainingMode\)toggleBombTool\(\)/, "keys 4 and 5 keep C4 controls in Allies while selecting guns in other modes");
assert.match(game, /\$\("bombBtn"\)\.addEventListener\("click",e=>\{e\.preventDefault\(\);e\.stopPropagation\(\);toggleBombTool\(\)\}\)/, "mobile users can equip C4 with a dedicated button");
assert.match(game, /data-buy-tab="rifles"/, "the Allies buy menu groups equipment into categories");
assert.match(game, /document\.querySelectorAll\("\[data-buy-tab\]"\)\.forEach\(tab=>tab\.addEventListener\("click"/, "buy categories must filter the weapon cards");
assert.match(game, /function cancelBombPlantForCombat\(\)[\s\S]{0,400}socket\.emit\("bomb_action",\{matchId,action:"cancel"/, "shooting or weapon changes can interrupt bomb planting");
assert.match(game, /function shoot\(\)\{[\s\S]{0,220}cancelBombPlantForCombat\(\);/, "firing cancels your own C4 planting action instead of locking the gun");
assert.doesNotMatch(game, /function shoot\(\)\{\s*if\(bombToolActive\|\|/, "holding C4 no longer blocks firing");
assert.match(game, /A:\{x:37\.5,z:-33\.75\},B:\{x:22\.5,z:37\.5\}/, "client bomb interactions must use scaled site positions");
assert.match(game, /addGround\(18,30,13,13,road/, "B site must sit in the lower-right portion of Sandstone");
assert.match(game, /addGround\(-2,-35,76,10,road/, "A Long must run along the upper route into A site");
assert.match(game, /addGround\(-5,31,75,11,road/, "B Long must run along the lower route into B site");
assert.match(game, /addGround\(-1,0,18,17,road/, "Mid must remain a central open fight area");
assert.match(game, /wall\(15,-23,2,1,3\.2,trim\)/, "A Short must keep an actual walkable gap between its side walls");
assert.match(game, /wall\(13,21,2,1,3\.2,trim\)/, "B Short must connect to B site through a walkable opening");
assert.match(server, /attack: \[\{ x: -50, y: 0, z: -8\.75 \}/, "Allies attack spawn must align with the T side of Sandstone");
assert.match(server, /defense: \[\{ x: 50, y: 0, z: -8\.75 \}/, "Allies defense spawn must align with the CT side of Sandstone");
assert.match(game, /<svg viewBox="0 0 220 48"/, "buy cards use built-in weapon silhouettes instead of text-only placeholders");
assert.match(game, /БОМБА ВИДАЄТЬСЯ АВТОМАТИЧНО/, "the purchase panel explains that C4 is assigned automatically, not purchased");
assert.match(game, /selectedMap==="NEON_YARD"/, "game must load the selected map");



assert.match(admin, /id="fTester"/);
assert.doesNotMatch(game, /training_spawn_bot|training_remove_bot|training_bot_action/, "prototype client must not send bot manipulation requests");
assert.match(server, /socket\.on\("training_remove_bot"/, "legacy bot-removal endpoint must remain registered");
assert.match(server, /start_prototype_match/, "prototype starts through the normal match system");
assert.match(server, /const prototypeBotMatch = players/, "prototype bot matches are marked on normal match state");
assert.match(server, /prototypeBotMatch/, "prototype KB keeps the normal match warmup and countdown");
assert.match(server, /botPlantAt/, "stationary-bot Allies rounds still exercise the normal bomb plant and defuse objective");
assert.match(server, /prototypeAuto: true/, "automatic prototype planting emits the regular bomb-planted event");
assert.match(server, /isBot/, "Allies round payload identifies static bots");
assert.match(server, /prototypeBotMatch/, "normal match events retain prototype state");
assert.match(menu, /DEFAULT_KEYBINDS/, "settings must define default training key bindings");
assert.doesNotMatch(menu, /data-bind-action="spawnBot"|data-bind-action="removeBot"|removeBot:"KeyB"/, "bot creation and deletion must not be available from settings");
assert.match(menu, /data-bind-action="resetSession"/, "settings must let players remap training reset");
assert.match(menu, /data-bind-action="menu"/, "settings must let players remap the in-game menu");
assert.match(menu, /current\.keybinds=binds/, "custom key bindings must be saved in localStorage");
assert.match(menu, /refreshProfileIdentity\(\)/, "opening the profile must refresh the UUID from the account API");
assert.match(menu, /api\("\/api\/user-data\?id="/, "profile UUID refresh must have a user-data fallback");
assert.match(game, /function runTrainingAction\(action\)/, "training actions must be keyboard-driven");
assert.doesNotMatch(game, /id="pauseMenu"|function togglePauseMenu\(force\)/, "the blocking pause menu must not cover gameplay controls");
assert.match(game, /menu:"KeyM"/, "M must open the in-game menu by default");
assert.doesNotMatch(game, /function renderTrainingKeyHints\(\)|id="trainingKeyHints"/, "keyboard hints must not overlay the game; they belong in settings");
assert.match(game, /socket\.on\("init_match",data=>\{\s*matchJoined=true;\s*\$\("trainingControls"\)\.style\.display="none"/, "public match initialization must hide prototype bot controls");
assert.match(game, /#trainingControls\.prototype-bot-panel/, "prototype static-bot status must have dedicated responsive styling");
assert.match(game, /textContent=mode/, "prototype uses the normal mode title and HUD");
assert.match(game, /const isPrototypeMode=sessionStorage.getItem\("prototypeMode"\)==="true"/, "prototype UI must distinguish the bot sandbox from a real lobby match");
assert.match(menu, /TACTICAL COMBAT/, "the main menu uses the clean tactical label rather than fake season branding");
assert.match(menu, /standoffx-interface-overhaul/, "the menu uses the unified tactical interface system");
assert.doesNotMatch(menu, /data-agent-weapon=/, "the home menu no longer shows a redundant weapon chooser");
assert.doesNotMatch(menu, /function setPreviewWeapon\(kind\)/, "the home menu does not build unnecessary weapon preview meshes");
assert.doesNotMatch(menu, /const previewGuns=\{\}/, "the menu skips construction of additional preview guns");
assert.match(menu, /id="playBtn"/, "the home menu retains the primary Play action");
assert.match(menu, /\$\("modeModal"\)\.classList\.add\("show"\)/, "Play opens the mode-selection modal");
assert.match(menu, /#home \.home-layout\{\s*display:grid!important/, "the home lobby restores its three-column tactical layout");
assert.match(menu, /grid-template-areas:"friends hero promo" "friends hero pass"/, "friends, squad, events and pass have dedicated areas");
assert.match(menu, /id="homeSquadRoster"/, "the main lobby shows its squad roster");
assert.match(menu, /function renderHomeSquadRoster\(lobby=currentLobby\)/, "the lobby roster follows current party members");
assert.match(menu, /soldier_tac\.glb/, "the menu loads the tactical agent with a procedural fallback");
assert.match(menu, /#modeModal \.modecards \.modebtn\{\s*min-height:110px/, "the mode modal uses compact selection cards");
assert.match(menu, /saved.prototype/, "resume preserves whether the match uses prototype bots");
assert.match(menu, /class="home-hero panel"/, "main menu must use the redesigned integrated game hero");
assert.match(ui, /\.home-hero h1/, "main menu hero must have dedicated responsive styling");
assert.doesNotMatch(game, /id="spawnBot"/, "training bot controls must no longer require on-screen buttons");
assert.doesNotMatch(game, /id="resetTraining"/, "training reset must be keyboard-driven");

assert.equal((menu.split("<script src=")[0].match(/\sonclick\s*=/gi) || []).length, 0, "menu must not contain inline onclick handlers");

const routes = [...server.matchAll(/app\.(get|post|put|patch|delete)\(["']([^"']+)["']/gi)]
  .map(match => match[1].toUpperCase() + " " + match[2]);
const duplicates = routes.filter((route, index) => routes.indexOf(route) !== index);
assert.deepEqual([...new Set(duplicates)], [], "HTTP routes must not be duplicated");

assert.match(server, /HILL_TOWN: \{ id: "HILL_TOWN"/, "server must allow the Hill Town map");
assert.match(server, /id: "allies"[\s\S]*?map: "SANDSTONE"[\s\S]*?requiredPlayers: 4/, "Allies must use Sandstone and queue four players for 2v2");
assert.match(server, /!\["team_fight", "allies"\]\.includes\(match\.mode\)/, "team combat handler must accept Allies");
assert.match(server, /const WEAPON_BALANCE = Object\.freeze\(/, "server must maintain the authoritative weapon balance table");
assert.match(server, /const damage = calculateWeaponDamage\(weaponId, hitZone, bestDistance\)/, "server calculates damage instead of trusting the client");
assert.match(server, /best\.hp = Math\.max\(0, best\.hp - damage\)/, "a hit reduces HP by the equipped weapon's damage");
assert.match(server, /if \(!killed\) return;/, "the victim only respawns when their HP reaches zero");
assert.match(server, /session\.lastShotAt \|\| 0\) < weapon\.fireDelay/, "training shots are rate-limited per weapon");
assert.doesNotMatch(server, /bot\.hp = Math\.max\(0, bot\.hp - \(Number\(data\.damage\) \|\| 34\)\)/, "training clients cannot choose arbitrary damage values");
assert.match(menu, /data-mode="allies"/, "menu must offer Allies");
assert.match(menu, /data-mode="team_fight"/, "menu must offer Team Fight");
assert.match(menu, /data-map="SANDSTONE"/, "public Allies map pool must include Sandstone");
assert.match(menu, /data-map="SMALL_YARD"/, "public KB map pool must include the small arena");
assert.match(server, /id: "team_fight"[\s\S]*?map: "SMALL_YARD"[\s\S]*?requiredPlayers: 3/, "KB must be free-for-all with three players on the small yard");
assert.match(server, /function startAlliesRound\(io, match, initial = false\)/, "Allies must start discrete bomb rounds after every client is ready");
assert.match(server, /function handleBombAction\(io, match, player, data = \{\}\)/, "the server must validate bomb plant and defuse inputs");
assert.match(server, /bomb\.explodeAt = bomb\.plantedAt \+ 40000/, "a planted bomb must have a server-controlled 40-second explosion timer");
assert.match(server, /Date\.now\(\) - action\.startedAt >= 3000/, "planting must take three uninterrupted seconds");
assert.match(server, /Date\.now\(\) - action\.startedAt >= 5000/, "defusing must take five uninterrupted seconds");
assert.match(server, /match\.roundWins\.A >= 8 \|\| match\.roundWins\.B >= 8/, "Allies matches must be won by reaching eight rounds");
assert.match(server, /match\.roundNumber >= 15/, "Allies must have a maximum of fifteen rounds");
assert.match(server, /match\.roundNumber % 7 === 0/, "Allies teams must switch sides after seven rounds");
assert.match(server, /match\.roundRemaining = 110/, "Allies rounds must last 110 seconds");
assert.match(server, /match\.phaseRemaining = 10/, "Allies must begin with a ten-second warmup before the twenty-second purchase phase");
assert.match(server, /socket\.on\("allies_buy"/, "Allies purchases must be server-authoritative");
assert.match(server, /shooter\.equippedWeapon !== weaponId/, "the server must validate a player equipped weapon");
assert.match(server, /player\.team !== match\.attackingTeam \|\| player\.userId !== bomb\.carrierUserId/, "only the bomb carrier on attack may initiate a plant");
assert.match(game, /function buildSandstoneMap\(\)/, "the client must build a closed Sandstone-style bomb map locally");
assert.match(game, /let matchJoined=false,clientMapReady=false,clientReadySent=false/, "game readiness waits for both map completion and successful room join");
assert.match(game, /function emitClientReadyWhenJoined\(\)[\s\S]{0,220}socket\.emit\("client_ready",\{matchId\}\)/, "the client only confirms readiness after init_match is received");
assert.match(game, /socket\.on\("init_match",data=>\{\s*matchJoined=true/, "server room join is acknowledged before client readiness");
assert.match(game, /socket\.on\("disconnect",\(\)=>\{\s*matchJoined=false;\s*clientReadySent=false;/, "reconnects may confirm readiness again");
assert.match(server, /function armMatchJoinTimeout\(io, match\)/, "waiting matches retain a timeout after a socket transition");
assert.match(server, /if \(!match\.joinTimer\) armMatchJoinTimeout\(io, match\)/, "the readiness wait is re-timed if the previous lobby socket disconnected");
assert.match(game, /function buildSmallYard\(\)/, "the client must build a compact map for 1v1v1 KB locally");
assert.match(game, /socket\.emit\("bomb_action",\{matchId,action:"plant",site:site\.site\}\)/, "the client must request bomb planting on a nearby site");
assert.match(game, /socket\.emit\("bomb_action",\{matchId,action:"defuse",site:site\.site\}\)/, "the client must request defusing on the planted site");
assert.match(game, /socket\.on\("allies_round_start"/, "clients must reset spawns and weapons at each bomb round");
assert.match(game, /socket\.on\("allies_round_end"/, "clients must show the winner and reason at round end");
assert.match(game, /id="bombHud"/, "Allies must have a bomb objective HUD");
assert.match(game, /id="alliesBuyPanel"/, "Allies must show a buy panel during preparation");
assert.match(game, /socket\.emit\("allies_buy"/, "the buy panel must submit purchases to the server");
assert.match(game, /socket\.on\("allies_loadout"/, "the client must apply server-authoritative Allies loadouts");
assert.match(game, /function buildHillTownMap\(\)[\s\S]*?wallAlongZ\(-55\.5,-48,48,wallShadowMat,1,6\)[\s\S]*?addGameplayInteractables\(\);[\s\S]*?mapLoadFinished=true/, "Hill Town must build a deterministic local competitive map with solid walls");
assert.match(game, /HILL_TOWN_MANIFEST_URL/, "the optional first-person AKR model may still use the CC0 weapon manifest");
assert.match(game, /async function loadHeldWeapon\(\)/, "game must load a first-person weapon model");
assert.match(game, /function makeFallbackP350\(\)/, "the client must render the P350 pistol when equipped");
assert.match(game, /function makeFallbackKnife\(\)/, "the client must render a knife when equipped");
assert.match(game, /if\(Math\.abs\(dy\)>Math\.abs\(dx\)&&dy>0\)\{selectWeapon\("akr"\)/, "mobile downward swipe equips AKR");
assert.match(game, /dx<0\)\{selectWeapon\("p350"\)/, "mobile left swipe equips P350");
assert.match(game, /dx>0\)\{selectWeapon\("knife"\)/, "mobile right swipe equips knife");
assert.match(game, /function addGameplayDoor\(/, "Hill Town has hinged door entities");
assert.match(game, /function interactWithNearestDoor\(/, "doors can be opened and closed with E or the mobile interaction button");
assert.match(game, /function addBreakableWood\(/, "Hill Town has breakable wooden cover");
assert.match(game, /function damageBreakableWood\(direction\)/, "shooting resolves map, door and breakable-cover impacts");
assert.match(game, /function addBulletHole\(/, "shots leave temporary bullet marks on surfaces");
assert.match(game, /function spawnTracer\(/, "the local player sees a bullet tracer for ranged shots");
assert.match(game, /function spawnRemoteTracer\(/, "remote player shots also render a tracer");
assert.match(game, /socket\.on\("player_shot",data=>\{[\s\S]{0,250}spawnRemoteTracer\(data\)/, "clients receive server-synchronized shot effects and shooting animation");
assert.match(game, /socket\.emit\("map_door_shot"/, "shooting a door requests it to open");
assert.match(game, /const addGround=\([\s\S]{0,230}mapObjects\.push\(mesh\)/, "local Hill Town floor surfaces receive impact marks");
assert.match(game, /id="interactBtn"/, "mobile HUD has a door interaction button");
assert.match(game, /socket\.emit\("map_door_state"/, "door state is sent to the server");
assert.match(game, /socket\.emit\("map_wood_destroyed"/, "destroyed wooden cover is synchronized");
assert.match(game, /socket\.on\("map_door_state"/, "clients apply other players' door changes");
assert.match(game, /socket\.on\("map_wood_destroyed"/, "clients apply other players' wooden-cover destruction");
assert.match(server, /socket\.on\("map_door_state"/, "server validates and broadcasts door changes");
assert.match(server, /socket\.on\("map_door_shot"/, "server validates shots aimed at doors before opening them");
assert.match(server, /function hillTownPathBlocked\(from,to,mapState=\{\}\)/, "server has a path collision test for solid walls and cover");
assert.match(server, /if\(mapId&&mapPathBlocked\(mapId,prev,\{x:targetX,z:targetZ\},mapState\)\)return false/, "real-match movement is blocked by server map geometry");
assert.match(server, /if\(mapPathBlocked\(session\.map,previous,target,session\.mapState\|\|\{\}\)\)\{/, "prototype movement is blocked by server map geometry");
assert.match(server, /socket\.emit\("player_position_correction"/, "server sends authoritative coordinates after rejecting an invalid move");
assert.match(game, /socket\.on\("player_position_correction"/, "clients reconcile position after server-side collision rejection");
assert.match(server, /const SERVER_MAP_LIMITS = Object\.freeze/, "every playable map has server-side movement boundaries");
assert.match(server, /FIELD_ARENA: \[[\s\S]{0,500}minX: -38, maxX: -26/, "Field Arena obstacles are represented in server collision data");
assert.match(server, /NEON_YARD: \[[\s\S]{0,500}minX: -57, maxX: -39/, "Neon Yard obstacles are represented in server collision data");
assert.match(server, /return !nonHillMapShotBlocked\(mapId,from,to\)/, "non-Hill-Town shots are checked against server map blockers");
assert.match(server, /const targetBlocked = Boolean\(best\) && !validateMapLineOfSight\(/, "server blocks target hits when wall geometry interrupts the actual shot ray");
assert.match(server, /bestHitPoint \|\| best\.pos, match\.mapState \|\| \{\}/, "line-of-sight validation ends at the computed impact point");
assert.match(server, /io\.to\(match\.id\)\.emit\("player_shot"/, "the server broadcasts shot directions and impacts for remote tracers");
assert.match(server, /if \(!canUseTesterModes\(user\) && \(mode !== "field_test" \|\| data\?\.prototype === true\)\)/, "prototype use is tester-only even for field_test sessions");
assert.match(server, /socket\.on\("map_wood_destroyed"/, "server validates and broadcasts destroyed wood");
assert.match(server, /Math\.hypot\(player\.pos\.x-x, player\.pos\.z-z\) > 7\.5/, "door changes require the player to be near the correct doorway");
assert.match(game, /if\(e\.code==="Digit1"\)[\s\S]{0,100}selectWeapon\("akr"\)/, "1 must equip the AKR");
assert.match(game, /if\(e\.code==="Digit2"\)[\s\S]{0,100}selectWeapon\("p350"\)/, "2 must equip the P350");
assert.match(game, /if\(e\.code==="Digit3"\)[\s\S]{0,100}selectWeapon\("knife"\)/, "3 must equip the knife");
assert.match(game, /e\.button===2\)\{e\.preventDefault\(\);toggleAimingDownSights\(\)/, "right mouse must toggle AKR aiming on/off");
assert.match(game, /camera\.fov=aimingDownSights\?\(selectedWeapon==="sniper"\?34:48\):74/, "rifle and sniper aiming must change camera FOV and restore normal view on a second click");
assert.match(game, /id="weaponBtn"/, "mobile HUD must include weapon switching");
assert.match(game, /weapon:"weaponBtn"/, "mobile weapon switch must use saved HUD position and size");
assert.match(menu, /data-layout-control="weapon"/, "mobile HUD editor must preview the weapon switch");
assert.match(menu, /data-size-control="weapon"/, "mobile HUD editor must allow an independent weapon button size");
assert.match(game, /socket\.emit\("team_shoot",\{matchId,weapon:selectedWeapon/, "the client must identify which weapon is fired");
assert.match(game, /socket\.emit\("training_shoot",\{trainingId,weapon:selectedWeapon/, "training shots must identify the equipped weapon");
assert.match(game, /if\(e\.code==="Escape"\)\{[\s\S]{0,200}pauseToMenu\(\);return\s*\}/, "Escape closes the shop first, otherwise returns to the lobby without ending the active match");
assert.match(game, /if\(selectedMap==="FIELD_ARENA"\)\{/, "prototype must honor the selected map rather than forcing the field arena");
assert.doesNotMatch(game, / · UUID "\+uuid/, "the match lobby must not display UUIDs");

assert.match(game, /function makeVisual\(color\)[\s\S]*?new THREE\.CylinderGeometry[\s\S]*?function setSoldierTint/, "soldiers must have a multi-part procedural 3D model");
assert.match(game, /function animateSoldier\(model,dt,now,moving=false,inAir=false,crouching=false,sprinting=false\)/, "player models must animate walking, sprinting and crouching without external model downloads");
assert.match(game, /animateSoldier\(e\.mesh,dt,now,e\.anim==="Running"\|\|e\.anim==="Walking",e\.anim==="Jump",e\.anim==="Crouch"\)/, "remote player movement must also animate crouching");
assert.match(game, /if\(e\.code===binds\.menu\)\{e\.preventDefault\(\);pauseToMenu\(\);return\}/, "M returns to the lobby while preserving the active match");
assert.match(game, /stick\.addEventListener\("touchcancel",releaseStick\)/, "cancelled mobile joystick touches must release movement");
assert.match(game, /\$\("fireBtn"\)\.addEventListener\("touchcancel",\(\)=>fireHeld=false\)/, "cancelled mobile fire touches must stop shooting");
assert.match(game, /socket\.on\("player_left"/, "departed players must be removed from the scene");
assert.match(game, /e\.pos\.set\(data\.x,data\.y,data\.z\);e\.mesh\.position\.copy\(e\.pos\);e\.anim="Idle"/, "a respawn must update both the displayed and authoritative remote position");
assert.match(game, /let connectedToGameplay=socket\.connected/, "the client must rejoin the match after a Socket.IO reconnection");
assert.match(game, /const HILL_TOWN_SCALE=2\.55/, "Hill Town must be dramatically larger than its original footprint");
assert.match(game, /NEON_YARD_SCALE=2/, "Neon Yard must have an enlarged play area");
assert.match(game, /FIELD_ARENA_SCALE=2/, "Field Arena must have an enlarged play area");
assert.match(game, /function buildM3Maze\(\)/, "M3 Maze must build locally instead of relying on a remote GLB");
assert.match(game, /addBox\(0,3\.5,-228,456,7,4,shadowMat,true\)/, "M3 Maze must include a solid perimeter wall");
assert.doesNotMatch(game.slice(game.indexOf("function loadMap()"), game.indexOf("function makeVisual(")), /loader\.load\("m3\.glb"/, "M3 map loading must not depend on a remote model");
assert.match(game, /function rebuildCollisionIndex\(\)/, "map geometry must be registered for solid collision");
assert.match(game, /if\(size\.y<\.24\|\|bounds\.max\.y<\.16\|\|size\.y>18\|\|\(size\.x>28&&size\.z>28\)\)continue/, "collision filtering must keep long thin walls instead of deleting arena borders");
assert.match(game, /return \(\{SANDSTONE:60,SMALL_YARD:32,HILL_TOWN:54\.2,NEON_YARD:167,FIELD_ARENA:291,M3_Maze:225\}\)/, "all client movement bounds must stay inside the matching physical map walls");
assert.match(game, /function applyMapInteractionState\(state\)/, "door and destructible-cover state must be applied to reconnecting clients");
assert.match(game, /const hits=raycaster\.intersectObjects\(mapObjects\.filter\(o=>o\?\.visible\),false\)/, "shots raycast against the actual map geometry");
assert.match(game, /const hit=hits\.find\(h=>h\.distance<CLIENT_WEAPON_INFO\[selectedWeapon\]\.range\)/, "the nearest scenery impact is chosen before wood damage is applied");
assert.match(game, /if\(obj\.userData\?\.breakableWood\)/, "only a hit object explicitly marked as breakable wood takes damage");
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
assert.match(menu, /id="resumeMatchBtn"/, "the lobby must offer a bottom exit button for a resumed match");
assert.match(menu, /label\)label\.textContent=hasMatch\?"↻  ПОВЕРНУТИСЯ В МАТЧ":"▶  ГРАТИ"/, "the primary lobby button must switch to return-to-match while a match is active");
assert.match(menu, /function exitSavedMatch\(\)/, "the lobby exit control must cancel the saved old match");
assert.match(menu, /button\.textContent="ЗАВЕРШИТИ МАТЧ"/, "the lobby reconnect state must show an explicit finish-match action");
assert.match(menu, /data-size-control="fire"/, "the mobile layout editor must let players size the fire button separately");
assert.match(menu, /data-size-control="crouch"/, "the mobile layout editor must let players size crouch separately");
assert.match(menu, /data-size-control="sprint"/, "the mobile layout editor must let players size sprint separately");
assert.match(menu, /document\.documentElement\.dataset\.sxDevice/, "lobby must detect device type and show matching settings");
assert.match(ui, /html\[data-sx-device="mobile"\] body\.lobby-screen #desktopControlsSettings/, "mobile must not display keyboard/mouse-only settings");
assert.match(ui, /html\[data-sx-device="desktop"\] body\.lobby-screen #mobileLayoutEditor/, "desktop must not show touch-only settings");
assert.match(server, /}, 5 \* 60 \* 1000\);/, "reconnect grace must last five minutes");
assert.match(server, /The reconnect window is five minutes[\s\S]{0,400}if \(current\.phase === "game"\)[\s\S]{0,500}current\.players\.splice\(liveIndex, 1\)/, "disconnect expiry must remove only the disconnected player after five minutes");
assert.match(server, /const MATCH_SPAWNS =/, "scaled maps must use safe per-map spawn points");
assert.match(server, /HILL_TOWN: \[\{x:-42,y:0,z:-28\},\{x:42,y:0,z:-28\},\{x:-42,y:0,z:28\},\{x:42,y:0,z:28\}\]/, "Hill Town team spawns must stay in mirrored safe start zones");
assert.match(server, /mapState: safeMapId === "HILL_TOWN" \? createMapInteractionState\(\) : null/, "map interaction states must be retained with a match");
assert.match(server, /io\.to\(matchId\)\.emit\("player_connection_state", \{ userId: player\.userId, connected: false/, "disconnect should not broadcast a permanent player-left event");
assert.match(server, /const index = match\.players\.findIndex\(p => \(p\.uuid \? p\.uuid === socket\.user\.uuid : p\.userId === socket\.user\.id\)\)/, "an authenticated lobby exit can remove the player slot by account identity");
assert.match(server, /if \(player\.socketId && player\.socketId !== socket\.id\)/, "leaving from the lobby must also close the old gameplay socket");
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
assert.match(server, /if \(!player \|\| player\.socketId !== socket\.id \|\| player\.hp <= 0\) return;\s*if \(match\.mode === "allies" && match\.phase !== "game"\) return;\s*if \(!validateMove/, "dead players and players outside a live round must not move on the server");
assert.match(game, /id="deathNotice"/, "players must receive clear feedback when eliminated");
assert.match(game, /function shoot\(\)[\s\S]{0,240}matchPhase!=="game"\|\|hp<=0\|\|!mapLoadFinished/, "shooting is blocked outside live gameplay and until the map loads");
assert.match(game, /function startReload\(\)[\s\S]{0,280}hp<=0\|\|!mapLoadFinished/, "reloading is blocked for dead players and before the map loads");
assert.match(game, /if\(reloading\|\|heldWeaponAction\?\.type==="equip"\)return/, "players cannot shoot while changing weapons or reloading");
assert.match(game, /matchPhase==="game"&&player&&hp>0/, "local movement must freeze until respawn");

assert.match(game, /mapLoadFinished\?"none":"flex"/, "the prototype must keep its loading screen until the map is ready");
assert.match(game, /matchPhase==="game"&&player&&hp>0&&mapLoadFinished/, "movement must wait until the selected map has finished loading");
assert.match(game, /function startReload\(\)[\s\S]{0,280}!mapLoadFinished/, "reload cannot begin before the map loads");
assert.match(game, /function shoot\(\)[\s\S]{0,240}!mapLoadFinished/, "shoot cannot begin before the map loads");

assert.match(game, /function setSoldierDown\(model,down\)/, "eliminated soldiers must visibly drop until respawn");
assert.match(game, /victim\.hp=Math\.max\(0,Number\(data\.hp\)\|\|0\);[\s\S]{0,100}setSoldierDown\(victim\.mesh,true\)/, "the victim HP is updated and lethal hits visibly eliminate the model");
assert.match(game, /hitConfirmTimer=setTimeout\(\(\)=>crosshair\.classList\.remove\("hit"\),150\)/, "the shooter must receive visual hit confirmation");
assert.match(game, /setSoldierDown\(e\.mesh,false\);setSoldierTint\(e\.mesh,colorFor\(e\.role,e\.team\)\)/, "respawning enemies must return to their normal pose and team colors");

assert.match(game, /if\(p\.hp<=0\)\{p\.anim="Dead";setSoldierDown\(p\.mesh,true\)\}/, "rejoining clients must render eliminated players as down until respawn");

assert.match(game, /const camera=new THREE\.PerspectiveCamera\([^;]+\);\s*\/\/ Camera-attached weapon and view models must belong to the rendered scene graph\.\s*scene\.add\(camera\);/, "camera-mounted weapon models must be in the scene graph to render");

assert.match(game, /function buildHillTownMap\(\)[\s\S]{0,1300}const groundMat=mat/, "Hill Town starts from local world-space geometry");
const hillBuilderStart=game.indexOf("function buildHillTownMap()");
const hillBuilderEnd=game.indexOf("// Small, deterministic gameplay interactions",hillBuilderStart);
assert.ok(hillBuilderStart>=0&&hillBuilderEnd>hillBuilderStart, "local Hill Town builder must be easy to isolate");
assert.doesNotMatch(game.slice(hillBuilderStart,hillBuilderEnd), /loadHillTownManifest|loadHillTownStarterFallback|loader\.load/, "the competitive map must not depend on a remote GLB scene or its extra props");
assert.match(game, /wallAlongZ\(0,cursor,gapStart,wallMat,\.9,5\.1\)/, "the central divider must be built as solid wall sections with door gaps");
assert.match(game, /addGameplayDoor\(0,-28,Math\.PI\/2\)[\s\S]*addGameplayDoor\(0,0,Math\.PI\/2\)[\s\S]*addGameplayDoor\(0,28,Math\.PI\/2\)/, "all three combat lanes have synchronized doors");
assert.match(server, /match\.mapState\.doors\[doorIndex\]=open/, "server stores door state for returning players");
assert.match(server, /match\.mapState\.destroyedWood\.includes\(woodIndex\)/, "server stores destroyed cover indices for returning players");

assert.match(server, /players\.some\(candidate => candidate\.isBot\) \? \(p\.isBot \? "B" : "A"\)/, "all tester bots must be on the opposing team and be shootable targets");

assert.match(server, /player\.pos\.y = Math\.max\(0, Math\.min\(2\.25, y\)\)/, "match movement must reject impossible fly heights");
assert.match(server, /previous\.y = Math\.max\(0, Math\.min\(2\.25, y\)\)/, "training movement must reject impossible fly heights");
assert.match(server, /const sessionMap = \["field_test", "training"\]\.includes\(mode\) \? normalizeMapId\(data\?\.map\) : cfg\.map;/, "training must use whichever map the tester selected");
assert.match(server, /bot: \["field_test", "training"\]\.includes\(mode\)/, "full training must begin with a target");
assert.match(server, /const maxStep = 0\.9;/, "training movement must support the faster sprint speed");
assert.match(server, /player\.anim = \["Idle", "Running", "Jump", "Walking", "Crouch"\]/, "the server must retain the crouch animation state");

const validateMoveFunction = server.match(/function validateMove\(player, data, mapId = null, mapState = \{\}\) \{[\s\S]*?\n\}/);
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
assert.match(server, /if \(mongoConnecting\) return false/, "simultaneous Atlas connection attempts must be coalesced");
assert.match(server, /mongoStatus\.lastCheckAt = new Date\(\)\.toISOString\(\)/, "Atlas health must record each connection attempt");
assert.match(server, /setInterval\(\(\) => \{\s*if \(!mongoStatus\.configured \|\| mongoDb \|\| mongoConnecting\) return;[\s\S]{0,120}void initMongo\(\);\s*\}, 30000\)/, "Atlas connection must recover automatically after a transient outage");

const weaponStart = server.indexOf("const WEAPON_BALANCE = Object.freeze(");
const weaponEnd = server.indexOf("function handleTeamShot", weaponStart);
assert.ok(weaponStart >= 0 && weaponEnd > weaponStart, "the authoritative weapon helper block must exist");
const weaponHelpers = vm.runInNewContext(
  "(()=>{" + server.slice(weaponStart, weaponEnd) + ";return {WEAPON_BALANCE,normalizeWeaponId,calculateWeaponDamage,detectWeaponHitZone,tracePlayerHit}})()",
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
const centeredShot = weaponHelpers.tracePlayerHit({x:0,y:1.42,z:0},{x:0,y:0,z:-1},{x:0,y:0,z:-10},60);
assert.ok(centeredShot && Math.abs(centeredShot.distance-10)<0.001, "a ray through a standing target must register a hit");
assert.equal(weaponHelpers.tracePlayerHit({x:0,y:1.42,z:0},{x:0,y:0,z:-1},{x:2,y:0,z:-10},60), null, "a ray far outside the target hitbox must miss");
assert.equal(weaponHelpers.tracePlayerHit({x:0,y:1.42,z:0},{x:0,y:0.3,z:-0.954},{x:0,y:0,z:-10},60), null, "a ray above the target must not count as a hit");

// Behavioral checks: the server collision proxies match the newly generated maps.
const mapGeometryStart = server.indexOf("function segmentIntersectsRect2d");
const mapGeometryEnd = server.indexOf("function isHillTownShotBlocked", mapGeometryStart);
assert.ok(mapGeometryStart >= 0 && mapGeometryEnd > mapGeometryStart, "server map collision helpers must be extractable for tests");
const mapGeometryCode = server.slice(mapGeometryStart, mapGeometryEnd);
const mapGeometry = vm.runInNewContext(
  "(()=>{" + mapGeometryCode + ";return {SERVER_MAP_LIMITS,SERVER_MAP_BLOCKERS,mapPathBlocked,nonHillMapShotBlocked}})()"
);
assert.equal(mapGeometry.mapPathBlocked("M3_Maze", {x:-195,z:-195}, {x:-194,z:-195}), false, "M3 spawn zone must not be blocked");
assert.equal(mapGeometry.mapPathBlocked("M3_Maze", {x:-80,z:-140}, {x:-70,z:-140}), true, "M3 vertical maze wall must block movement");
assert.equal(mapGeometry.nonHillMapShotBlocked("M3_Maze", {x:-80,z:-140}, {x:-70,z:-140}), true, "M3 wall must block line of sight");

const sandstoneRoutes = [
  { name: "T spawn to Mid", points: [{x:-50,z:-8.75},{x:-50,z:0},{x:-38.75,z:0},{x:-30,z:0},{x:0,z:0}] },
  { name: "T spawn to A Long", points: [{x:-50,z:-8.75},{x:-50,z:0},{x:-38.75,z:0},{x:-30,z:0},{x:-28.125,z:0},{x:-28.125,z:-43.75},{x:0,z:-43.75},{x:30,z:-43.75},{x:30,z:-35},{x:37.5,z:-33.75}] },
  { name: "A Short to A site", points: [{x:0,z:0},{x:0,z:-10},{x:15,z:-10},{x:25,z:-10},{x:25,z:-18},{x:25,z:-30.5},{x:30,z:-30.5},{x:37.5,z:-33.75}] },
  { name: "B Short to B site", points: [{x:0,z:0},{x:-3,z:0},{x:-3,z:10},{x:22.5,z:6.25},{x:22.5,z:22.5},{x:22.5,z:28.75},{x:15,z:28.75},{x:15,z:37.5},{x:22.5,z:37.5}] },
  { name: "T spawn to B Long", points: [{x:-50,z:-8.75},{x:-50,z:0},{x:-38.75,z:0},{x:-50,z:0},{x:-50,z:38.75},{x:22.5,z:38.75},{x:22.5,z:37.5}] },
  { name: "CT spawn to Mid", points: [{x:50,z:0},{x:50,z:8},{x:42,z:8},{x:42,z:0},{x:30,z:0},{x:18,z:0},{x:0,z:0}] }
];
for (const route of sandstoneRoutes) {
  for (let i = 1; i < route.points.length; i++) {
    assert.equal(
      mapGeometry.mapPathBlocked("SANDSTONE", route.points[i - 1], route.points[i]),
      false,
      "Sandstone route remains connected: " + route.name + " segment " + i
    );
  }
}
assert.equal(mapGeometry.mapPathBlocked("NEON_YARD", {x:12,z:0}, {x:0,z:0}), true, "Neon Yard central divider must block movement");
assert.equal(mapGeometry.mapPathBlocked("FIELD_ARENA", {x:-45,z:14}, {x:-31,z:14}), true, "Field Arena cover must block movement");
assert.equal(mapGeometry.mapPathBlocked("FIELD_ARENA", {x:-210,z:0}, {x:-209,z:0}), false, "Field Arena spawn approach must remain clear");
assert.ok(mapGeometry.SERVER_MAP_BLOCKERS.M3_Maze.length >= 25, "M3 must have server-side proxies for interior walls and cover");
assert.ok(mapGeometry.SERVER_MAP_BLOCKERS.FIELD_ARENA.length >= 12, "Field Arena must protect its added cover pieces");

assert.match(game, /renderer\.toneMapping=THREE\.ACESFilmicToneMapping/, "the renderer must use improved color tonemapping");
assert.match(game, /renderer\.shadowMap\.enabled=!isMobileDevice&&!isLowEndDevice/, "shadows are disabled on mobile and low-end PCs to reduce rendering load");
assert.match(game, /renderer\.setPixelRatio\(Math\.min\(devicePixelRatio\|\|1,isMobileDevice\?1\.0:isLowEndDevice\?1\.0:1\.35\)\)/, "low-end devices render at a reduced pixel ratio");
assert.match(game, /function applyCrosshairSettings\(\)/, "gameplay applies saved crosshair settings");
assert.match(game, /class="crosshair-display style-classic"/, "game HUD has a configurable crosshair component");
assert.match(server, /function tracePlayerHit\(origin, aim, targetPos, range, options = \{\}\)/, "server uses 3D ray-to-player hit testing");
assert.match(server, /tracePlayerHit\(shotOrigin, aim, target\.pos, weapon\.range/, "match bullets use the 3D target hitbox");
assert.match(server, /tracePlayerHit\(shotOrigin, aim, botPosition, weapon\.range/, "training bullets use the same aim hitbox");
assert.match(game, /makeSurfaceTexture=\(base,seed,marks=3600\)/, "Hill Town must use generated surface textures");
assert.match(game, /function buildFieldArena\(\)[\s\S]{0,7000}const obstacles=/, "Field Arena must be built from a defined tactical cover layout");
assert.match(game, /function buildNeonYard\(\)[\s\S]{0,7000}const structures=/, "Neon Yard must have a defined cover layout");
assert.match(server, /M3_Maze: \[\s*\{ minX: -78, maxX: -74, minZ: -180, maxZ: -130 \}/, "M3 collision proxy geometry must exist on the server");

assert.equal((game.match(/function positionHeldWeapon\(\)/g)||[]).length, 1, "the module must declare positionHeldWeapon only once so gameplay can parse");
assert.match(game, /m4a1:\{label:"M4A1"/, "M4A1 is a selectable client weapon");
assert.match(game, /p90:\{label:"P90"/, "P90 is a selectable client weapon");
assert.match(game, /shotgun:\{label:"SHOTGUN"/, "shotgun is a selectable client weapon");
assert.match(game, /sniper:\{label:"SNIPER"/, "sniper is a selectable client weapon");
assert.match(server, /id: "m4a1", label: "M4A1"/, "server damage calculations include M4A1");
assert.match(server, /id: "p90", label: "P90"/, "server damage calculations include P90");
assert.match(server, /id: "shotgun", label: "SHOTGUN"/, "server damage calculations include shotgun");
assert.match(server, /id: "sniper", label: "SNIPER"/, "server damage calculations include sniper");
assert.match(server, /socket\.on\("lobby_set_team"/, "the party leader can assign players to teams");
assert.match(server, /socket\.on\("lobby_update_settings"/, "the party leader can change mode/map without dropping the party");
assert.match(menu, /show\("home"\);\s*createLobby\(selectedMode,selectedMap\)/, "inviting a friend builds a lobby and stays on the home screen");
assert.match(menu, /import \* as SkeletonUtils from "three\/addons\/utils\/SkeletonUtils\.js"/, "the tactical character uses the supported Three.js SkeletonUtils module");
assert.match(server, /function startMatchBotAI\(io, match\)/, "lobby agents run movement and shooting AI");
assert.match(menu, /data-lobby-team/, "the lobby UI allows changing team assignments");
assert.match(menu, /data-home-lobby-team/, "the home squad lets the party leader assign teams without leaving the main menu");
assert.match(menu, /testerSwitch\.style\.display=canTest\(\)\?"flex":"none"/, "only testers see prototype versus real-match controls");
assert.match(menu, /sx-reference-menu-remake/, "the main menu uses the reference-inspired layout");
assert.match(menu, /#profilePageUuid\),body\.lobby-screen #copyUuid/, "UUID is hidden from the regular profile UI");
console.log("OK project invariants, syntax, duplicate declaration regression, local maps, authoritative weapon damage, AI matches, lobby teams, UI, and routes");


assert.match(server, /async function loadMongoState\(name, legacySnapshot\)/, "Atlas performs a one-time import only for missing state documents");
assert.doesNotMatch(server, /const localUsersSnapshot = users\.map/, "existing Atlas account data is not merged with stale JSON snapshots");
assert.match(server, /app\.post\("\/api\/settings\/keybinds"/, "key bindings must be persisted through the account store and MongoDB");
assert.match(server, /app\.post\("\/api\/clans\/avatar"/, "authorized clan leaders can upload clan avatars");
assert.match(server, /app\.get\("\/api\/clans\/:tag"/, "clan search supports a detailed roster profile");
assert.match(server, /avatar: cleanText\(raw\.avatar \|\| "\/avatars\/default\.jpg"/, "clan avatars survive normalizing and MongoDB persistence");
assert.match(server, /if \(targetDistance < 0\.82 && targetDistance < previousDistance - 0\.015\) return false/, "idle players still have authoritative movement collision");
assert.match(server, /player\.disconnectTimer = setTimeout\(\(\) => \{[\s\S]{0,1500}current\.players\.splice\(liveIndex, 1\)/, "disconnected player slots expire after the reconnect grace");
assert.match(game, /function pauseToMenu\(\)/, "the escape-to-lobby action must preserve the active match");
assert.match(game, /id="squadStrip"/, "the live HUD must show a compact player-avatar strip");
assert.match(game, /className="squad-avatar"/, "the compact HUD roster has individual player portrait tiles");
assert.match(menu, /id="avatarFileInput" type="file"/, "the user's avatar picker must accept an image from the device");
assert.match(menu, /async function openClanProfile\(tag\)/, "clan search can open member profiles");
assert.match(ui, /\.clan-search-card/, "clan search should render a visual list of all matching clans");
assert.match(ui, /\.active-squad-player/, "lobby teammate portraits display nicknames, IDs and death status");
assert.match(game, /function dropCurrentItem\(\)/, "G drops the currently equipped weapon or C4");
assert.match(game, /if\(selectedWeapon==="knife"\)return/, "trying to drop a knife is ignored without an unnecessary popup");
assert.doesNotMatch(game, /НІЖ НЕ МОЖНА ВИКИНУТИ|НЕ МОЖНА ВИКОРИСТАТИ БОМБУ ЗАРАЗ/, "the game does not show noisy impossible-action warnings");
assert.match(game, /let selectedWeapon="knife"/, "the knife is equipped by default");
assert.match(game, /const weaponReserve=\{akr:90,p350:52,knife:0\}/, "firearms track finite reserve ammunition");
assert.match(game, /if\(ammo>=info\.magazine\)\{startWeaponInspect\(\);return\}/, "R inspects a weapon when its magazine is already full");
assert.match(game, /function createReloadMagazineVisual\(weaponId\)/, "reload uses a visible magazine model");
assert.match(game, /action\.type==="inspect"/, "weapon inspection has a dedicated animation state");
assert.match(game, /action\.type==="equip"/, "switching weapons plays a draw/equip animation");
assert.match(game, /if\(e\.code==="KeyB"&&mode==="allies"&&!isTrainingMode\)\{e\.preventDefault\(\);toggleBuyMenu\(\);return\}/, "B opens the Allies buy menu without stealing training shortcuts");
assert.match(game, /if\(e\.code==="KeyG"\)\{e\.preventDefault\(\);dropCurrentItem\(\);return\}/, "G is reserved for dropping an item");
assert.match(game, /if\(mode==="allies"&&!isTrainingMode\)toggleBombTool\(\)/, "the bomb has a dedicated inventory slot in Allies without stealing weapon hotkeys in other modes");
assert.match(game, /id="alliesBuyBackdrop"/, "the shop is a standalone overlay over live gameplay");
assert.match(game, /function renderRoundResult\(data\)/, "the Allies round-end screen shows a scoreboard");
assert.match(game, /T · АТАКА/, "the results screen identifies the T/attacking side");
assert.match(game, /CT · ЗАХИСТ/, "the results screen identifies the CT/defending side");
assert.match(game, /function startRoundCinematic\(data\)/, "a camera fly-through runs after an Allies round");
assert.match(game, /socket\.on\("dropped_items_state"/, "dropped weapons are synchronized to every client");
assert.match(server, /function handleDropItem\(io, match, player, data = \{\}\)/, "the server handles dropping weapons and C4 authoritatively");
assert.match(server, /function handlePickupItem\(io, match, player, data = \{\}\)/, "the server handles item pickup authoritatively");
assert.match(server, /weaponId === "knife"/, "the server rejects dropping the knife");
assert.match(server, /socket\.on\("lobby_create"/, "players can create transient party lobbies");
assert.match(server, /socket\.on\("lobby_invite"/, "party leaders can invite friends");
assert.match(server, /socket\.on\("lobby_invite_response"/, "friends can accept or decline lobby invitations");
assert.match(server, /socket\.on\("lobby_start_match"/, "party leaders can start a match from the lobby");
assert.match(server, /fillBots = data\.fillWithBots !== false/, "party matches can fill empty slots with bots");
assert.match(server, /\(current\.prototypeBotMatch \|\| current\.lobbyMatch\) && current\.mode === "allies"/, "bot-filled party matches keep bomb objectives working when sides switch");
assert.match(server, /\(\(prototypeBotMatch \|\| lobbyMatch\) \? \["A", "B", "C"\]\[i % 3\]/, "KB lobby fillers occupy unique free-for-all teams");
assert.match(server, /x: Number\(player\.pos\?\.x\) \|\| 0,[\s\S]{0,100}z: Number\(player\.pos\?\.z\) \|\| 0/, "the round result contains winner positions for the camera fly-through");
assert.match(menu, /id="lobbyInviteModal"/, "lobby invitations have an accept/decline interface");
assert.match(menu, /id="lobbyStartBtn"/, "party leader has a dedicated start-match button");

/* Regression checks for the shared agent, weapon presentation, and timed Allies store. */
assert.match(game, /id="alliesBuyButton"/, "the Allies shop must have a dedicated timed HUD button");
assert.match(game, /function updateAlliesBuyButton\(\)/, "the shop button must have a single visibility/countdown controller");
assert.match(game, /const canBuy=mode==="allies"&&!isTrainingMode&&matchPhase==="round_start"/, "the shop button may only appear during Allies preparation");
assert.match(game, /buyTimeRemaining=t;updateAlliesBuyButton\(\)/, "the purchase countdown must follow the authoritative round timer");
assert.match(game, /duration:5000,weaponId:selectedWeapon/, "weapon inspection animation lasts five seconds");
assert.match(game, /const pose=profiles\[weapon\]\|\|profiles\.akr/, "reload animation must use the selected weapon's profile");
assert.match(game, /function createMuzzleFlash\(\)/, "weapon fire must use a visible muzzle flash");
assert.match(game, /Flat%20Guns%20West\/GLB\//, "external weapon URLs must use the real asset-kit folder path");
assert.match(game, /function attachTacticalAgent\(model,color\)/, "the match must support the same skinned tactical model as the menu");
assert.match(game, /attachTacticalAgent\(g,color\)/, "newly spawned match characters must attach the shared agent model");
assert.match(game, /side\*\.238,1\.655,\.035/, "headset ear cups must be attached at head height");
assert.match(game, /import \* as SkeletonUtils from "three\/addons\/utils\/SkeletonUtils\.js"/, "skinned agent clones must have independent skeletons");

/* Softer collection, secure prototype permission, camera warmup and timed buy-phase regressions. */
assert.match(server, /if \(!canUseTesterModes\(user\)\) \{\s*socket\.emit\("search_error", \{ message: "Прототип доступний лише тестерам\." \}\);/, "the public prototype match event must reject non-testers on the server");
assert.match(server, /current\.phase = "round_start";\s*current\.phaseRemaining = 20;/, "Allies preparation must include a twenty-second purchase phase after warmup");
assert.match(server, /phase: "warmup", time: 10/, "Allies must announce a separate ten-second warmup before buying");
assert.match(server, /app\.get\("\/banned"/, "banned accounts have a dedicated denial page");
assert.match(server, /client\.emit\("account_banned"/, "ban updates actively notify connected banned users");
assert.match(server, /app\.post\("\/api\/collection\/softer\/open-box"/, "the Softer box drop is resolved server-side");
assert.match(server, /const SOFTER_RARITY_WEIGHTS=\[/, "Softer box drop rates are defined on the server");
assert.match(server, /app\.post\("\/api\/inventory\/equip"/, "weapon cosmetics are equipped via a server-authoritative inventory route");
assert.match(menu, /id="store" class="screen"/, "the main menu includes the Softer collection store");
assert.match(menu, /async function loadSofterStore\(\)/, "the Softer store renders server-side collection contents");
assert.match(menu, /socialSocket\.on\("account_banned"/, "the lobby redirects banned accounts to the denial page");
assert.match(game, /\["game","warmup","countdown","round_start"\]\.includes\(matchPhase\)/, "mouse look can be enabled during preparation without enabling movement");
assert.match(game, /if\(matchPhase==="game"&&player&&hp>0&&mapLoadFinished\)/, "movement remains disabled until live gameplay");
assert.match(game, /fetch\("\/api\/skins"/, "the match loads the player's equipped Softer cosmetics");
assert.match(game, /function applyEquippedSkinToHeldWeapon\(\)/, "selected weapon cosmetics are applied to the first-person model");
assert.match(game, /socket\.on\("account_banned"/, "a banned player in a match is moved to the denial page");

assert.match(server, /else if \(!isMaster && req\.body\.isTester !== undefined && !u\.isTester\)/, "revoking tester permission removes active test sessions");
assert.match(server, /if \(match\.prototypeBotMatch && !canUseTesterModes\(socket\.user\)\)/, "non-testers cannot rejoin a prototype match");
assert.match(auth, /toLowerCase\(\)\.includes\("заблок"\)\)\{location\.href="\/banned";return\}/, "banned login is redirected to the denial page");
