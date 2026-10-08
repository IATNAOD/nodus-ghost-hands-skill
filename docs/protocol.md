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
  "device": { "name": "Игровой", "aliases": [], "machineHash": "<sha256 hex>", "os": "Windows 10", "host": "DESKTOP-1", "client": "1.0.0" } }
```

- `key` — личный ключ пользователя из «Моих настроек» навыка (Crockford base32: регистр, пробелы и дефисы не важны, I/L → 1, O → 0).
- `deviceId` — `null` при первой привязке, дальше — id из `welcome`.
- `machineHash` — sha256 от MachineGuid Windows: повторная привязка того же ПК (переустановка клиента) сохраняет его запись и id.

Сервер → `welcome`:

```json
{ "t": "welcome", "deviceId": "rzvp9IBAg3_W", "name": "Игровой", "owner": { "name": "Маша" },
  "server": { "version": "1.0.0", "protoMin": 1, "protoMax": 1 },
  "settings": { "match": { "accept": 0.86 } }, "created": true }
```

- `server.version` — версия навыка. Навык и клиент выпускаются вместе с одной версией: клиент показывает, если версии разошлись.
- `settings` — настройки навыка, нужные клиенту (тот же объект приходит сообщением `settings`). `match.accept` — совпадение названия (0–1), с которого NODUS запускает и закрывает приложение без уточнения (настройка навыка `app_confidence`); по нему клиент проверяет фразы.

После `welcome` клиент сразу шлёт `config` и `state`.

## Сообщения

| Направление | `t` | Поля |
|---|---|---|
| К → С | `config` | `rev` (число, растёт), `data` — полный снимок настроек ПК (ниже). Debounce 500 мс; без `config-ack` — повтор при следующем подключении |
| С → К | `config-ack` | `rev`, `error` (`null`, `name-taken`, `name-invalid`, `invalid-rev`), `warnings: [{ appId, alias, code }]`, `code` — `alias-duplicate`, `alias-reserved`, `alias-too-short` |
| К → С | `state` | `data: { running: [{ key, name, appId, game, fg }], volume, muted, shutdownAt }` — при изменении, не чаще раза в секунду |
| С → К | `cmd` | `id`, `action`, `args`, `timeoutMs` |
| К → С | `result` | `id`, `ok`, `code`, `data` |
| С → К | `learn` | `appId`, `alias` — голосовое название, подтверждённое человеком после подбора ИИ: клиент добавляет его к приложению и шлёт новый `config` |
| С → К | `settings` | `match: { accept }` — после смены настроек навыка, всем подключённым ПК |
| К → С | `bye` | `reason`: `quit`, `sleep`, `unpair` (при `unpair` сервер удаляет ПК) |

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
| `media.key` | `{ key: "play_pause" \| "next" \| "prev" }` | — | `media` |
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

`app-not-found`, `launcher-missing`, `launch-failed`, `needs-elevation`, `cancelled`, `not-running`, `ambiguous` (`data.options: [{ key, name }]`), `close-timeout`, `feature-disabled`, `paused`, `helper-unavailable`, `no-audio-device`, `invalid-args`, `unknown-action`, `busy`, `internal`. Сервер сам выставляет `timeout`, `disconnected`, `offline`.

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
