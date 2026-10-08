# Ghost Hands

Голосовое управление Windows-ПК через ассистента NODUS. Две части:

- `skill/` — навык NODUS `ghost_hands` (Node 22, CommonJS, без сборки): интенты, свой WebSocket-сервер для ПК, личная страница с ключом, блоки и события сценариев.
- `client/` — клиент Electron для Windows: подключается к навыку, выполняет команды, сканирует игры Steam/Epic/GOG и меню «Пуск». Нативные операции — `client/helper/` (C#, `GhostHelper.exe`).

Протокол между ними — `docs/protocol.md`, константы — `skill/lib/protocol.js`.

## Перед правкой навыка

Прочитай памятку `docs/nodus-skills-guide.md` (строки 22–68) и разделы, которых касается правка (оглавление — строка 164). Используй только API из руководства.

Обязательно в коде `skill/` (он работает в общем процессе всех навыков):

- никаких `*Sync`, `execSync`, долгих циклов; `try/catch` в колбэках таймеров и событий, `.catch()` у промисов без `await`, слушатель `'error'` у каждого EventEmitter;
- не использовать `process.env`, `.exec(` (у регулярок — `String.match`), `eval`, вычисляемый `require`, `Buffer.from(…base64)`: это пометки модератору портала (тест `static.test.js` их ловит);
- каждая слышимая и видимая строка — через `ctx.t` из `locales/ru.json` и `locales/en.json` (одинаковые ключи, у русских фраз NODUS о себе — пара `_female`);
- секреты (ключи) не попадают в логи, `params` и ответы роутов, кроме `POST /key/reveal|rotate` владельцу;
- постоянные данные — только в моделях `models/*.js`; новые поля — в Mixed-поле `config` (схема модели обновляется только после перезапуска NODUS).

`skill/lib/{protocol,text,names,name-index,parse,nodus-routing,nodus-builtin}.js` общие с клиентом: после правки гоняй тесты навыка и клиента. Изменение протокола — одновременно `docs/protocol.md`, `skill/lib/protocol.js`, обе стороны и `PROTO`/`PROTO_MIN`, если несовместимо.

## Команды

```sh
npm test                          # тесты навыка (node:test)
npm run routing:assert            # маршрутизация фраз против встроенных интентов NODUS
npm run check                     # проверка манифеста (из гайда)
npm run pack                      # dist/ghost_hands-<версия>.zip
npm run dev-host                  # навык без устройства: WS-сервер, мини-панель :8080, консоль фраз
npm run fake-client -- --key GH-… # эмулятор ПК
NODUS_URL=http://<ip> NODUS_USER=admin NODUS_PASSWORD=… node tools/dev-install.js dist/ghost_hands-1.0.0.zip
npm --prefix client run dev|test|typecheck|build|dist
npm --prefix client run helper    # GhostHelper.exe → client/resources/helper (нужен .NET SDK)
npm --prefix client run icons     # client/build/icon.ico и client/resources/icons/* из scripts/make-icons.mjs
```

## Клиент

- Чистые функции (разбор VDF, сканеры Steam/Epic/GOG, `belongsTo`, `dictionaryAliases`, `broadcastOf`) не импортируют `electron` и `../log`: так их проверяет vitest без моков. Фикстуры в `client/test/fixtures` — настоящие файлы без идентификаторов владельца.
- Окно получает только методы `GhostApi` (`src/shared/types.ts`); новый метод — в тип, `preload/index.ts`, `METHODS` в `main/index.ts` и `Core.api`.
- Если Electron стартует как Node (`electron.app` undefined), в окружении стоит `ELECTRON_RUN_AS_NODE=1`: сними её для дочернего процесса.
- Автообновление читает только релиз с пометкой Latest: релизы навыка (`skill-v…`) лежат в том же репозитории, поэтому prerelease-каналов нет.

## Версии

Клиент и навык версионируются независимо: тег `vX.Y.Z` — релиз клиента (Latest, автообновление; версия = `client/package.json`), `skill-vX.Y.Z` — ZIP навыка (`--latest=false`; версия = `skill/skill.json`). Workflow проверяет совпадение тега и версии. Обновление включённого навыка выключает сценарии людей с его блоками — выпускай навык только при изменениях в нём.
