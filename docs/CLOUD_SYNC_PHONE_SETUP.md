# Aisora Cloud: /connect + /sync с телефона

## Подготовлено в main

- Vercel Telegram webhook теперь поддерживает **/connect**, **/cancel**, **/sync**.
- /connect использует **Neon** для 10-минутного зашифрованного этапа ввода логина, а затем AES-256-GCM для хранения учётных данных в `credential_vault`. Статус между webhook-вызовами не хранится в RAM.
- /sync инициирует **GitHub Actions workflow_dispatch**, не выполняя Playwright внутри Vercel. Бот не утверждает, что синхронизация завершилась, пока worker не запишет данные.
- `.github/workflows/cloud-ais-sync.yml` поднимает отдельный Ubuntu runner, устанавливает Playwright Chromium, запускает только читающий `SyncService` и пишет результаты в Neon.
- Отправка файлов и заданий в AIS остаётся **отключённой**.

## 1. Один общий ключ шифрования (выполнить только один раз)

1. После Vercel Deployment Ready открой `https://aisora-teal.vercel.app/security/keygen`.
2. Нажми «Создать новый ключ» и «Копировать ключ». Ключ генерируется локально в твоём браузере через Web Crypto и не отправляется на сервер.
3. В Vercel → aisora → Settings → Environment Variables → **Secret**, создай **CREDENTIALS_MASTER_KEY** со значением ключа. Environment: Production. Save.
4. В GitHub → RollSatrs/Aisora → Settings → Secrets and variables → Actions → **New repository secret** создай **CREDENTIALS_MASTER_KEY** с **точно тем же значением**.
5. Никогда не выкладывай ключ в GitHub-файлы, скриншоты, сообщения и публичные URL. Потребуется новый Vercel Redeploy для применения переменной.

**Важно:** ключ должен быть base64 из 32 байт; нельзя подставлять webhook secret. Храни резервную копию ключа в своём менеджере паролей: потеря ключа делает зашифрованные логины/пароли АИС нечитаемыми.

## 2. GitHub Actions запуск из Telegram

1. На GitHub создай **fine-grained personal access token** с минимальным доступом: repository **RollSatrs/Aisora**, разрешение **Actions: Read and write**, остальные — минимум. Не используй старый classic token с широким доступом.
2. В Vercel Secret для Production добавь **GITHUB_ACTIONS_TOKEN** со значением этого fine-grained PAT.
3. Добавь Vercel Config для Production: **GITHUB_SYNC_REPO** со значением **RollSatrs/Aisora**.
4. В GitHub Actions должен уже существовать **NEON_DATABASE_URL** — прямая строка подключения из Neon (проверить имя, ничего сюда не отправлять).
5. В GitHub → RollSatrs/Aisora → Settings → Secrets and variables → Actions → **Variables** создай **AIS_AUTOMATION_APPROVED** = `true` **только если у тебя есть разрешение на автоматизированный read-only доступ к ABU AIS**. Без этого workflow намеренно останавливается.
6. Сделай **Redeploy** на Vercel после добавления новых переменных.

Не вводи личные университетские данные до проверки нового деплоя и доступности конфигурации.

## 3. Проверка в Telegram

1. Открой тестового бота в **личном чате** и отправь `/ping`, затем `/connect`.
2. После подтверждения от бота введи логин и пароль. Бот пытается удалить эти сообщения. **Telegram-боты не используют end-to-end шифрование**, поэтому такие сообщения проходят через Telegram; удаление не гарантирует стирания на серверах Telegram. Если это неприемлемо, не используй /connect; нужен отдельный HTTPS-ввод.
3. После «Данные АИС зашифрованы» отправь `/sync`. Бот должен ответить, что облачный запуск **запрошен**, а не «завершён».
4. Открой GitHub → Actions → **Cloud Aisora read-only AIS sync** и проверь статус. Рабочий прогон может занять десятки минут; доступность ABU AIS из GitHub Actions не подтверждена.
5. Если workflow зелёный, используй `/status`, `/tasks`, `/srocheck`. Если красный — поделись только технической ошибкой, скрыв учётные данные.
6. Начальная Neon — чистая, локальные данные старой PostgreSQL автоматически не перенесены.

## Ограничения

- GitHub Actions ≠ непрерывный сервер. Запуск очереди выполняется по запросу, не сразу, ограничен квотой и таймаутами.
- В GitHub workflow вводится account_ref, производный от Telegram ID пользователя; для высоких требований конфиденциальности позже заменить его непрозрачным ID задания.
- Не менять `CREDENTIALS_MASTER_KEY` после ввода паролей без процедуры перешифрования.
- Если университет блокирует автоматизированные браузеры или облачные IP, синхронизация не получится без разрешённого способа доступа.
- Не запускать две /sync для одного пользователя подряд: текущий workflow использует concurrency группу и очередность не гарантирует полноценную дедупликацию запросов.
