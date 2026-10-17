# Ghost Hands

Голосовое управление Windows-ПК через ассистента NODUS. Две части:

- `skill/` — навык NODUS `ghost_hands` (Node 22, CommonJS, без сборки): интенты, свой WebSocket-сервер для ПК, личная страница с ключом, блоки и события сценариев.
- `client/` — клиент Electron для Windows: подключается к навыку, выполняет команды, сканирует игры Steam/Epic/GOG и меню «Пуск», выполняет сценарии. Нативные операции — `client/helper/` (C#, `GhostHelper.exe`).

Протокол между ними — `docs/protocol.md`, константы — `skill/lib/protocol.js`.

## Перед правкой навыка

Прочитай памятку `docs/nodus-skills-guide.md` (строки 22–68) и разделы, которых касается правка (оглавление — строка 164). Используй только API из руководства.

Обязательно в коде `skill/` (он работает в общем процессе всех навыков):

- никаких `*Sync`, `execSync`, долгих циклов; `try/catch` в колбэках таймеров и событий, `.catch()` у промисов без `await`, слушатель `'error'` у каждого EventEmitter;
- не использовать `process.env`, `.exec(` (у регулярок — `String.match`), `eval`, вычисляемый `require`, `Buffer.from(…base64)`: это пометки модератору портала (тест `static.test.js` их ловит);
- каждая слышимая и видимая строка — через `ctx.t` из `locales/ru.json` и `locales/en.json` (одинаковые ключи, у русских фраз NODUS о себе — пара `_female`);
- секреты (ключи) не попадают в логи, `params` и ответы роутов, кроме `POST /key/reveal|rotate` владельцу;
- постоянные данные — только в моделях `models/*.js`; новые поля — в Mixed-поле `config` (схема модели обновляется только после перезапуска NODUS).

Сценарии ПК навык знает только по названию (`config.data.scenarios`): `launch_app` находит их как приложения (`matchApps({ scenarios: "include" })`), `pc_scenario` — «сценарий … на компьютере» и остановку. Блок `pc_run_scenario` ждёт запуск через `ScenarioWaiters` (`lib/scenarios.js`): `runId` создаёт навык и начинает ждать до отправки команды.

`skill/lib/{protocol,text,names,name-index,parse,nodus-routing,nodus-builtin}.js` общие с клиентом: после правки гоняй тесты навыка и клиента. Изменение протокола — одновременно `docs/protocol.md`, `skill/lib/protocol.js`, обе стороны и `PROTO`/`PROTO_MIN`, если несовместимо. Новое действие или сообщение — с возможностью в `CAPS` (`hello.device.caps`, `welcome.server.caps`) и откатом для старой стороны, `PROTO` не меняется.

## Команды

Зависимости: корень — `yarn` (`yarn.lock`), клиент — `npm --prefix client install` (`client/package-lock.json`). Скрипты запускаются через `npm run` в обоих местах.

```sh
npm test                          # тесты навыка (node:test)
npm run routing:assert            # маршрутизация фраз против встроенных интентов NODUS
npm run check                     # проверка манифеста (из гайда)
npm run pack                      # dist/ghost_hands-<версия>.zip
npm run dev-host [-- --key-file dev-key.txt] # навык без устройства: WS-сервер, мини-панель :8080, консоль фраз и `:set <настройка> <значение>`; ключ из файла переживает перезапуск
npm run fake-client -- --key GH-… # эмулятор ПК (caps, родительский контроль, сценарии; `--say`, `--scenario-sec N`)
npm run release -- patch|minor|major|X.Y.Z [--dry-run] # общая версия, коммит, тег vX.Y.Z, push
NODUS_URL=http://<ip> NODUS_USER=admin NODUS_PASSWORD=… node tools/dev-install.js dist/ghost_hands-1.0.0.zip
npm --prefix client run dev|test|typecheck|build|dist
npm --prefix client run helper    # GhostHelper.exe → client/resources/helper (нужен .NET SDK)
npm --prefix client run icons     # client/build/icon.ico и client/resources/icons/* из scripts/make-icons.mjs
```

## Клиент

- Чистые функции (разбор VDF, сканеры Steam/Epic/GOG, `belongsTo`, `dictionaryAliases`, `broadcastOf`) не импортируют `electron` и `../log`: так их проверяет vitest без моков. Фикстуры в `client/test/fixtures` — настоящие файлы без идентификаторов владельца.
- Окно получает только методы `GhostApi` (`src/shared/types.ts`); новый метод — в тип, `preload/index.ts`, `METHODS` в `main/index.ts` и `Core.api`.
- Preload три: `index.ts` (главное окно), `parental.ts` (окна контроля, канал `gh:parental`) и `picker.ts` (окна выбора на экране, канал `gh:picker`), у двух последних — проверка отправителя. Они в песочнице и не подгружают чанки: значения из `src/shared` импортирует только `index.ts`, иначе rollup вынесет их в общий чанк и `window.gh` пропадёт (тест в `parental.test.ts`).
- Родительский контроль — `src/main/parental/`: учёт времени (чистый `accounting.ts`), PIN, зашифрованная копия правил, окна `notice` и `lock`, сторож `GhostHelper.exe guard` (`helper/Guard.cs`), который перезапускает клиент по `run.json`/`guard.json` в профиле. Под контролем изменяющие методы из `LOCKED_METHODS` в `core.ts` отказывают (`setApp` — только `aliases` и `spoken`, `testLaunch` — с учётом лимитов), `before-quit` отменяется. Окна блокировки получают границы монитора и kiosk после показа: созданное сразу полноэкранным окно Windows вписывает в рабочую область. Экран блокировки вживую не проверяй на рабочем ПК: он ставит медиа на паузу и закрывает новые окна.
- Если Electron стартует как Node (`electron.app` undefined), в окружении стоит `ELECTRON_RUN_AS_NODE=1`: сними её для дочернего процесса.
- Запуск из исходников (`npm run dev`, e2e) использует профиль `%APPDATA%\Ghost Hands (dev)`: установленный клиент может работать одновременно, второй экземпляр с тем же профилем отдал бы ему ссылку привязки и закрылся.
- Автообновление читает релиз с пометкой Latest; prerelease-каналов нет.
- Сценарии: документ — граф (`src/shared/scenarios/`: модель, определения узлов `defs/`, тексты `texts/{ru,en}.ts` с `en: typeof ru`, проверка, `structure.ts` шаги ↔ схема). Исполнитель `src/main/scenarios/engine.ts` чистый, действия — `impl/`, ввод — `input.ts` через `GhostHelper.exe input.*`, экран — `screen.ts`, OpenCV — отдельный `utilityProcess` (`vision/process.ts` → `out/main/vision.js`). Модуль opencv.js — thenable: не передавай его в `resolve()` и `await`, иначе вечный цикл. Новый узел — определение в `defs/`, тексты в обоих `texts/*.ts`, реализация в `impl/index.ts`.
- Настоящий ввод, клики и окна выбора (накрывают все мониторы) вживую не проверяй на рабочем ПК — только `dryRun` помощника, CDP-ввод в окне клиента или Windows Sandbox. Захват экрана и OCR только читают.
- e2e (`playwright-core` `_electron`): временный профиль через `GH_PROFILE_DIR` (только при запуске из исходников), в профиль — `settings.json` с `ui.startHidden: true`, затем окну `setFocusable(false)` и `showInactive()`: окно с фокусом ловит настоящие нажатия пользователя. Упакованный клиент на рабочем ПК не запускай: он перепишет обработчик `ghosthands://` и автозапуск на свой путь.
- Навык сообщает клиенту в `welcome` и сообщением `settings` порог совпадения названий (`app_confidence`): «Проверить фразу» в клиенте решает так же, как навык.

## Версии

Навык и клиент выпускаются вместе с одной версией: `npm run release` пишет её в `package.json` (корень и клиент, с lock-файлами) и `skill/skill.json`, коммитит `Release vX.Y.Z` и пушит тег `vX.Y.Z`. Тег запускает `.github/workflows/release.yml`: проверка, что версии совпадают с тегом, сборка ZIP навыка и установщика клиента, один релиз с пометкой Latest (из него обновляются клиенты). Клиент показывает, если версия навыка в NODUS отличается от его собственной. Обновление включённого навыка выключает сценарии людей с его блоками: об этом стоит писать в описании релиза, когда в навыке есть изменения.
