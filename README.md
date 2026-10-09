# StandoffX

StandoffX — browser FPS prototype на Three.js + Socket.IO.

## Що зараз є

- cookie-based server sessions;
- scrypt password hashing;
- реєстрація / логін / logout;
- профіль;
- друзі та заявки;
- кланова система із заявками;
- інвентар;
- marketplace із перевіркою ownership;
- одноразові promo codes;
- Socket.IO matchmaking;
- режими HIDE & SEEK та TEAM FIGHT для всіх гравців;
- тестерські режими TRAINING та FIELD TEST;
- TRAINING: створення тест-бота, push/kick/boost/reset і стрільба по боту;
- FIELD TEST: окреме відкрите тестове поле, стрільба і тренувальні цілі;
- окрема ознака isTester в адмінці; доступ до тестових режимів додатково перевіряє сервер;
- лобі очікування всіх гравців + client-ready;
- 10 с розминки + 15 с стартового відліку;
- матчі зберігаються тільки в памʼяті Socket.IO, не в MongoDB;
- server-side match state;
- rate-limited movement validation;
- reconnect-aware player identity;
- Three.js gameplay client;
- fallback map, якщо 3D map не завантажилась;
- /api/health з безпечним статусом MongoDB Atlas;
- адміністративний Atlas ping через /api/admin/atlas/check;
- CI перевіряє JavaScript всіх ключових сторінок і важливі інваріанти.

## Запуск

```bash
npm install
npm start
```

За замовчуванням сервер працює на `http://localhost:3000`.

Для Render:

```
node server.js
```

Render автоматично передає `PORT`.

## HTTPS

За потреби:

```text
STANDOFFX_HTTPS=1
TLS_KEY_PATH=/path/to/key.pem
TLS_CERT_PATH=/path/to/cert.pem
```

## Моделі

Клієнт може підхоплювати моделі зброї з кореня:

- `Pistol.glb`
- `Revolver.glb`
- `P90.glb`
- `ak-47.glb`
- `Shotgun.glb`
- `SniperRifle.glb`

Якщо конкретної моделі немає, клієнт має залишатися працездатним без неї.

## Перевірка

```bash
npm test
```

Команда перевіряє синтаксис сервера, auth/menu/admin/game scripts і основні правила про матчі, test modes та Atlas endpoint.
