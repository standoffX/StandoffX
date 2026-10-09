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
- FIELD TEST: вільне дослідження обраної карти без таймера й автоматичних ворогів;
- окрема ознака isTester в адмінці; доступ до тестових режимів додатково перевіряє сервер;
- лобі очікування всіх гравців + client-ready;
- 10 с розминки + 15 с стартового відліку;
- матчі зберігаються тільки в памʼяті Socket.IO, не в MongoDB;
- server-side match state;
- rate-limited movement validation;
- reconnect-aware player identity;
- Three.js gameplay client із вбудованою low-poly first-person rifle, видимою без зовнішніх GLB моделей;
- анімація зброї: легке хитання під час руху та віддача під час пострілу;
- клавіша Escape повертає в меню й завершує поточну матчеву/тестову сесію без окремої кнопки виходу;
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

**Важливо про сховище:** без MongoDB активується JSON fallback. На Render локальні файли не є надійним постійним сховищем після redeploy/restart, тому для реальних акаунтів налаштуй Atlas та перевір статус у `/api/health` або в адмінці. Усі матчі залишаються в памʼяті процесу й не зберігаються в БД.

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

## Тестерський workflow

1. Увійди в акаунт адміністратора й відкрий адмін-панель.
2. У редакторі потрібного акаунта ввімкни прапорець **TESTER** та збережи зміни.
3. Увійди під акаунтом тестера, натисни **ГРАТИ** й обери **TRAINING** для перевірки стрільби по боту або **FIELD TEST** для вільного дослідження.
4. Вибери **M3 MAZE**, **FIELD ARENA** або **NEON YARD**. Вибір карти передається серверу та перевіряється за allowlist.
5. У FIELD TEST можна пересуватися без пошуку матчу й таймера; панель MAP LAB показує координати та дозволяє повернутися на старт. У цьому режимі не показуються керування тестовим ботом.

Доступ до тестових режимів перевіряє сервер через tester-флаг акаунта; приховування кнопок у браузері не є механізмом авторизації. Сесії тестування зберігаються в оперативній памʼяті процесу.

## Перевірка

```bash
npm test
```

Команда перевіряє синтаксис сервера, auth/menu/admin/game scripts і основні правила про матчі, test modes та Atlas endpoint.
