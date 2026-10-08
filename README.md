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
- два режими: HIDE & SEEK та TEAM FIGHT;
- лобі очікування всіх гравців + client-ready;
- 10 с розминки + 15 с стартового відліку;
- матчі зберігаються тільки в памʼяті Socket.IO, не в MongoDB;
- server-side match state;
- rate-limited movement validation;
- reconnect-aware player identity;
- Three.js gameplay client;
- fallback map, якщо 3D map не завантажилась.

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

Команда перевіряє синтаксис серверного JavaScript без запуску сервера.
