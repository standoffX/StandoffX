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
- режими ALLIES та TEAM FIGHT для всіх гравців;
- карта HILL TOWN, що збирається з модульних 3D-ресурсів;
- перемикач **ПРОТОТИП / РЕАЛЬНА ГРА** тільки для тестерів;
- прототип дозволяє вибрати будь-яку карту, оглянути зброю та стріляти по нерухомій мішені;
- тестерська реальна гра запускає звичайний режим ALLIES або TEAM FIGHT з трьома нерухомими ботами;
- доступ до тестерських можливостей перевіряє сервер; звичайні гравці не можуть запросити ботів;
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

### Render Environment

Додай змінні в **Render → Service → Environment**:

| Змінна | Значення | Примітка |
|---|---|---|
| `ADMIN_ID` | `Dev_01` | Master ID; не змінюй, якщо користуєшся наявним master-акаунтом. |
| `ADMIN_PASSWORD` | власний довгий пароль | **Обовʼязкова Secret-змінна.** У коді немає пароля за замовчуванням; без неї master-вхід вимкнений. |
| `MONGODB_URI` | MongoDB Atlas connection string | Рекомендовано для постійного збереження акаунтів, кланів, повідомлень та інвентарю. |
| `MONGODB_DB` | `standoffx` | Необовʼязково; назва БД за замовчуванням. |
| `NODE_ENV` | `production` | Render зазвичай уже запускає production-середовище. |

`MONGO_URI` також підтримується як сумісний alias для `MONGODB_URI`. Не додавай TLS key/cert для звичайного Render Web Service: TLS завершує Render. Залиш Start Command як `node server.js`.

Для MongoDB Node.js driver 7 потрібен **Node.js 20.19.0 або новіший**. Якщо Atlas ping повертає TLS alert, перевір runtime Node, скопіюй свіжий URI з Atlas → Connect → Drivers, URL-кодуй спецсимволи в паролі БД, перевір IP Access List для IP застосунку та вихідний TCP-доступ до порту 27017. Не вимикай TLS і не використовуй `tlsAllowInvalidCertificates`. `/api/admin/atlas/check` виконує справжній DB ping; звичайна мережева команда `ping` для цього не підходить.

**Важливо про сховище:** без MongoDB активується JSON fallback. На Render локальні файли не є надійним постійним сховищем після redeploy/restart, тому для реальних акаунтів налаштуй Atlas та перевір статус у `/api/health` або в адмінці. Усі матчі залишаються в памʼяті процесу й не зберігаються в БД.

## HTTPS

За потреби:

```text
STANDOFFX_HTTPS=1
TLS_KEY_PATH=/path/to/key.pem
TLS_CERT_PATH=/path/to/cert.pem
```

## 3D-ресурси

- **HILL TOWN** — модульне середовище для тактичного FPS з 3DAssets.dev, ліцензія CC0 1.0. Клієнт отримує маніфест моделей і завантажує окремі GLB без додаткових декодерів: [сторінка набору](https://3dassets.dev/packs/tactical-shooter-hill-town), [маніфест](https://3dassets.dev/api/v1/packs/tactical-shooter-hill-town).
- **Зброя від першої особи** — клієнт спершу пробує завантажити модель Attacker Assault Rifle з того самого CC0-набору. Якщо ресурс або маніфест недоступний, показується вбудована процедурна AK-подібна модель, щоб зброя не зникала повністю.
- **Запасний варіант карти** — за недоступності окремих моделей клієнт пробує завантажити [повну стартову сцену набору](https://cdn.3dassets.dev/assets/27595/v1/model.glb), а якщо мережеве завантаження не вдається — використовує локальну тестову арену.
- **Окрема CC0-модель AK-47** також є в [каталозі Quaternius на Poly Pizza](https://poly.pizza/m/em1Hi9GuCv); вона наведена як альтернатива, а не як файл, що вбудований у репозиторій.

Ресурси завантажуються з CDN, тому для першого завантаження карти та зброї потрібне підключення до Інтернету.

## Перевірка

```bash
npm test
```

Команда перевіряє синтаксис сервера, auth/menu/admin/game scripts і основні правила про матчі, test modes та Atlas endpoint.
