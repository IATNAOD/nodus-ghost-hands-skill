# Протокол Ghost Hands v1

Навык NODUS `ghost_hands` держит WebSocket-сервер для ПК домашней сети, клиент на ПК подключается к нему. Константы и проверки — `skill/lib/protocol.js` (общий модуль навыка и клиента).

## Транспорт

- `ws://<host>:<port>/gh`. Хост по умолчанию — `project-nod.local` (mDNS), порт — 47300 (настройка навыка `port`). Без TLS: защита — ключ пользователя и то, что сервер может назвать клиенту только известные ему приложения (ниже).
- Upgrade с заголовком `Origin` (браузер) — 403, другой путь — 404, обычный HTTP — 426.
- Кадры — текстовый JSON `{ "t": "<тип>", ... }`, неизвестные поля игнорируются. Сжатия нет. Предел кадра: от клиента 1 МиБ, от сервера 256 КиБ.
- Первое сообщение клиента — `hello`, не позже 10 с после соединения. 5 неверных ключей за 10 минут с одного адреса — дальше соединения закрываются кодом 4008. Не больше 64 сокетов.
- Сервер шлёт ping каждые 30 с и закрывает молчащие сокеты. Клиент переподключается, если 75 с не было ping. Переподключение клиента: 1, 2, 5, 10, 20, 30 с (±20%), сброс после минуты стабильной связи.

## Рукопожатие

Клиент → `hello`:

```json
{ "t": "hello", "proto": 1, "key": "GH-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX", "deviceId": null,
  "device": { "name": "Игровой", "aliases": [], "machineHash": "<sha256 hex>", "os": "Windows 10", "host": "DESKTOP-1", "client": "1.2.0",
              "caps": ["window.close", "media.control", "parental"] } }
```

- `key` — личный ключ пользователя из «Моих настроек» навыка (Crockford base32: регистр, пробелы и дефисы не важны, I/L → 1, O → 0).
- `deviceId` — `null` при первой привязке, дальше — id из `welcome`.
- `machineHash` — sha256 от MachineGuid Windows: повторная привязка того же ПК (переустановка клиента) сохраняет его запись и id.
- `caps` — что клиент умеет сверх версии 1.0 (ниже, «Возможности»). Нет поля — старый клиент.

Сервер → `welcome`:

```json
{ "t": "welcome", "deviceId": "rzvp9IBAg3_W", "name": "Игровой", "owner": { "name": "Маша", "id": "64b0…" },
  "server": { "version": "1.2.0", "protoMin": 1, "protoMax": 1, "caps": ["window.close", "media.control", "parental"] },
  "settings": { "match": { "accept": 0.86 } }, "created": true }
```

- `server.version` — версия навыка. Навык и клиент выпускаются вместе с одной версией: клиент показывает, если версии разошлись.
- `settings` — настройки навыка, нужные клиенту (тот же объект приходит сообщением `settings`). `match.accept` — совпадение названия (0–1), с которого NODUS запускает и закрывает приложение без уточнения (настройка навыка `app_confidence`); по нему клиент проверяет фразы.

- `owner.id` — id владельца в NODUS. Клиент под родительским контролем запоминает его.

После `welcome` клиент сразу шлёт `config` и `state`, а сервер клиенту с возможностью `parental` — `parental`.

### Возможности

Новые действия и сообщения не меняют `proto`: каждая сторона объявляет, что умеет, и шлёт другой только известное ей.

| `caps` | Клиент | Сервер без неё |
|---|---|---|
| `window.close` | выполняет `window.close` | закрывает активное окно через `app.close { target: "foreground" }` |
| `media.control` | выполняет `media.control` | шлёт `media.key` |
| `parental` | принимает `parental`, шлёт `alert` и `state.data.parental` | не шлёт `parental`, на странице навыка — «обновите клиент» |

Неизвестные типы сообщений обе стороны пропускают, соединение не рвётся.

## Сообщения

| Направление | `t` | Поля |
|---|---|---|
| К → С | `config` | `rev` (число, растёт), `data` — полный снимок настроек ПК (ниже). Debounce 500 мс; без `config-ack` — повтор при следующем подключении |
| С → К | `config-ack` | `rev`, `error` (`null`, `name-taken`, `name-invalid`, `invalid-rev`), `warnings: [{ appId, alias, code }]`, `code` — `alias-duplicate`, `alias-reserved`, `alias-too-short` |
| К → С | `state` | `data: { running: [{ key, name, appId, game, fg }], volume, muted, shutdownAt, parental? }` — при изменении, не чаще раза в секунду. `parental` — учёт времени под родительским контролем (ниже) |
| С → К | `cmd` | `id`, `action`, `args`, `timeoutMs` |
| К → С | `result` | `id`, `ok`, `code`, `data` |
| С → К | `learn` | `appId`, `alias` — голосовое название, подтверждённое человеком после подбора ИИ: клиент добавляет его к приложению и шлёт новый `config` |
| С → К | `settings` | `match: { accept }` — после смены настроек навыка, всем подключённым ПК |
| С → К | `parental` | правила родительского контроля (ниже): после `welcome` и при каждом изменении. Только клиенту с `parental` |
| К → С | `alert` | `kind`, `until?` — событие родительского контроля для владельца (ниже) |
| К → С | `bye` | `reason`: `quit`, `sleep`, `unpair` (сервер удаляет ПК), `shutdown` (Windows завершает сеанс) |

Первый `config` соединения принимается при любом `rev` (переустановленный клиент начинает счёт заново), следующие — только с большим `rev`.

### `config.data`

```json
{
  "name": "Игровой",
  "aliases": ["игровой компьютер"],
  "shared": false,
  "apps": [{ "id": "steam:570", "name": "Dota 2", "aliases": ["дота"], "spoken": "", "kind": "game", "source": "steam" }],
  "features": { "launch": true, "close": true, "volume": true, "media": true, "power": true, "lock": true, "display": true, "search": true, "wake": true, "toast": true },
  "prefs": { "confirmPower": true, "searchEngine": "google", "volumeStep": 10, "forceCloseSec": 0, "shareRunning": true, "paused": false },
  "wol": { "mac": "aa:bb:cc:dd:ee:ff", "broadcast": "192.168.0.255", "adapter": "ethernet" },
  "client": { "version": "1.0.0", "os": "Windows 10" }
}
```

- `apps` — только включённые: не больше 600, 16 алиасов по 64 символа. `id` — `steam:<appid>`, `epic:<AppName>`, `gog:<gameId>`, `start:<hash>`, `custom:<uuid>`, `url:<uuid>`, `virtual:<имя>`. `kind` — `game`, `app`, `site`. `spoken` — как называть вслух (иначе — название).
- `shared` — общий ПК: им управляют все пользователи NODUS, его события запускают сценарии всех.
- `running[].key` — непрозрачный ключ процесса или окна для `app.close`; `appId` — если это настроенное приложение. Заголовков окон нет.

## Команды

| `action` | `args` | `data` при успехе | Возможность |
|---|---|---|---|
| `app.launch` | `{ appId }` | `{ already }` | `launch` |
| `app.close` | `{ appId }` или `{ key }` или `{ target: "game" \| "foreground" }`, `force?` | `{ name, closed: [pid], pending: [pid] }`: `closed` — процессы, которые завершились или закрыли окна (игра может ещё сохраняться), `pending` — окна остались открыты: программа не закрылась или спрашивает о сохранении | `close` |
| `volume.get` | — | `{ level, muted }` | `volume` |
| `volume.set` | `{ level }` 0–100 | `{ level, muted }` | `volume` |
| `volume.change` | `{ delta }` | `{ level, muted }` | `volume` |
| `volume.mute` | `{ muted }` | `{ level, muted }` | `volume` |
| `window.close` | `force?`, `pid?` | `{ name, pid, closed: [pid], pending: [pid] }` — закрыто окно в фокусе (WM_CLOSE только ему). Рабочий стол, панель задач, Проводник и сам Ghost Hands — `protected`, пустой фокус — `not-running`. `force` с `pid` из прошлого ответа завершает только этот процесс | `close` |
| `media.key` | `{ key: "play_pause" \| "next" \| "prev" }` | — | `media` |
| `media.control` | `{ op: "play" \| "pause" \| "toggle" \| "next" \| "prev" }` | `{ already? }` — `play` при уже играющем; `{ fallback: true }` — Windows без SMTC, нажата медиаклавиша | `media` |
| `power.shutdown`, `power.restart` | `{ delaySec }` | `{ at }` | `power` |
| `power.sleep` | `{ delaySec }` | `{ at }` | `power` |
| `power.cancel` | — | `{ cancelled }` | `power` |
| `power.lock` | `{ delaySec }` | — | `lock` |
| `display.off` | `{ delaySec }` | — | `display` |
| `web.search` | `{ query, engine }`, `engine` — `google`, `yandex`, `bing`, `duckduckgo`, `youtube` | — | `search` |
| `toast.show` | `{ title, text }` | — | `toast` |

Клиент сам проверяет каждую команду: возможность включена, управление не на паузе, `appId` есть среди его включённых приложений, `key` — среди процессов из последнего `state`. Пути, аргументы и адреса по протоколу не передаются, поиск строится по шаблону поисковика клиента. Подменённый сервер может только то же, что голос.

Выключение и перезагрузка: клиент отвечает сразу, показывает на экране отсчёт (15 с) с кнопкой «Отмена» и вызывает `shutdown /s|/r /t 0` без `/f`. Отложенные — свой таймер клиента и `shutdownAt` в `state`.

### Коды `result.code`

`app-not-found`, `launcher-missing`, `launch-failed`, `needs-elevation`, `cancelled`, `not-running`, `ambiguous` (`data.options: [{ key, name }]`), `close-timeout`, `feature-disabled`, `paused`, `helper-unavailable`, `no-audio-device`, `invalid-args`, `unknown-action`, `busy`, `protected` (системное окно), `no-session` (`media.control`: ничего не играет), `parental-limit` (`app.launch` игры, когда время игр или ПК вышло), `internal`. Сервер сам выставляет `timeout`, `disconnected`, `offline`.

## Родительский контроль

Включает и настраивает владелец ПК на странице навыка («Мои настройки»). Правила живут в навыке (модель `Parental`) и в зашифрованной копии на ПК: без связи с NODUS они действуют по последней копии.

С → К `parental`:

```json
{ "t": "parental", "enabled": true, "rev": 7,
  "rules": {
    "limits": { "weekday": { "pcMin": 180, "gamesMin": 60 }, "weekend": { "pcMin": 300, "gamesMin": null } },
    "extend": { "pc": { "minutes": 15, "times": 2 }, "games": { "minutes": 15, "times": 2 } },
    "unlockMinutes": 120,
    "games": { "add": ["start:1a2b"], "remove": ["steam:570"] } },
  "pin": { "hash": "<hex>", "salt": "<hex>", "N": 16384, "r": 8, "p": 1 },
  "grantUntil": 1760000000000, "resetAt": null,
  "usage": { "day": "2026-10-08", "pcSec": 3600, "gameSec": 1200, "extended": { "pc": 1, "games": 0 }, "locked": null } }
```

- Выключенный контроль — `{ "enabled": false, "rev" }`: клиент стирает правила, PIN и учёт.
- `limits` — минуты в день, `null` — без лимита. Выходные — суббота и воскресенье по часам ПК. `extend` — продление кнопкой на ПК: на сколько минут и сколько раз в день (5–120 мин, 0–10 раз). `unlockMinutes` — на сколько PIN снимает ограничения (15–720).
- `games` — что считать игрой сверх игр Steam/Epic/GOG (`add`) и что не считать (`remove`).
- `pin` — хеш scrypt, сам PIN не передаётся. Клиент проверяет его сам, после 5 ошибок за 10 минут — пауза от 30 с, вдвое дольше после каждой следующей ошибки, до 30 минут.
- `grantUntil` — ограничения сняты до этого времени (кнопка в панели или голос владельца). `resetAt` — время за сегодня сброшено: клиент обнуляет свой учёт, если `resetAt` новее последнего сброса, иначе берёт по каждому счётчику максимум из своего и `usage` сервера (переустановка клиента не обнуляет время).

К → С `state.data.parental` — раз в минуту и при изменении: `{ day, pcSec, gameSec, extended: { pc, games }, locked: "pc" | "games" | null }`. Время ПК идёт, когда сеанс разблокирован и пользователь не простаивает больше 5 минут (полноэкранное окно и игра в фокусе простоем не считаются). Время игр — пока запущена игра.

К → С `alert { kind, until? }`:

| `kind` | Когда | Владельцу |
|---|---|---|
| `killed` | клиент закрыли принудительно, сторож запустил его снова | уведомление |
| `unclean-exit` | прошлый запуск закончился без штатного выхода (убиты и клиент, и сторож; пропало питание) | уведомление |
| `pin-unlock` | ограничения сняты PIN на ПК; `until` — до какого времени | уведомление |
| `pin-failed` | 5 неверных PIN подряд | уведомление |
| `extended` | нажато «+N минут» | событие сценариев `parental_extended` |

Остальные `kind` идут владельцу уведомлением и событием сценариев `parental_alert`. Событие `parental_limit` навык запускает, когда в `state.data.parental.locked` появляется `pc` или `games`. Если ПК под контролем пропал из сети без `bye` и не вернулся за 3 минуты, навык тоже уведомляет владельца.

Под контролем клиент не даёт менять свои настройки и отвязать ПК, не выходит из трея и запускает сторожа — `GhostHelper.exe guard` вне своего дерева процессов. Сторож запускает клиент снова, если тот завершился без отметки о штатном выходе в `run.json`. Новая привязка ПК под контролем требует PIN.

## Коды закрытия

| Код | Значение | Клиент |
|---|---|---|
| 1001 | сервер останавливается (обновление навыка, перезапуск NODUS) | переподключается |
| 4000 | неверный запрос | переподключается |
| 4001 | этот ПК подключился заново в другом соединении | переподключается через 5 с |
| 4003 | неверный или перевыпущенный ключ | экран привязки |
| 4004 | ПК отвязан на странице навыка | стирает `deviceId`, экран привязки |
| 4006 | имя уже занято другим ПК этого человека | просит другое имя |
| 4008 | слишком много неверных ключей | ждёт и переподключается |
| 4010 | версия протокола не поддерживается | «обновите клиент или навык» |
| 4011 | ошибка сервера | переподключается |

## Версии

`proto` — целое число. Сервер принимает `[protoMin, protoMax]`. Совместимые дополнения (новое поле, новое действие) версию не меняют: неизвестные поля игнорируются, неизвестное действие клиент отвечает `unknown-action`.
