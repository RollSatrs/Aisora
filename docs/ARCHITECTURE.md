# Архитектура Aisora MVP

## Решение

Рекомендуется модульный монолит на NestJS с отдельными worker-процессами. Это сохраняет простоту MVP и чёткие границы, позволяя позже выделить коннекторы и AI-обработку в сервисы.

```text
Telegram (grammY)
      │
      ▼
NestJS API / Application Core
├── Review & Approval
├── Academic Calendar
├── Schedule Engine
├── Assignment Discovery
├── Assignment Status Tracker
├── Notification Service
├── AI Processing
├── Document Generation
└── University Adapter Port
        └── ABU AIS Connector (Playwright, read-only initially)

PostgreSQL + Drizzle  ←→  Redis + BullMQ  ←→  Worker processes
Object storage (generated artifacts; encrypted, retention-controlled)
```

## Модули

| Модуль | Ответственность |
|---|---|
| Telegram Bot | Команды, уведомления, диалоги уточнения; без бизнес-логики |
| AIS Connector | Авторизованное чтение AIS, нормализация, capability discovery |
| Adaptive AIS Navigator | Наблюдение видимых целей, семантический маршрут, локальный AI fallback, проверка результата |
| Navigation Safety Policy | Повторная проверка read-only действия перед каждым кликом |
| Academic Calendar | Семестр, недели, праздники, исключения |
| Schedule Engine | Занятия, часовые пояса, post-class и catch-up проверки |
| Assignment Discovery | Поиск кандидатов в СРО, контенте и сообщениях |
| Assignment Status Tracker | Сопоставление заданий, отправок и оценок |
| AI Processing | Анализ требований и подготовка черновиков в песочнице |
| Document Generation | DOCX/PDF/PPTX/код/отчёты с воспроизводимыми артефактами |
| Review & Approval | Версионирование, явное одобрение конкретного результата |
| Submission Connector | Отдельный write-path; выключен в MVP до разрешения |
| Notification Service | Дедупликация и доставка уведомлений |

## Адаптеры университетов

```ts
interface UniversityAdapter {
  capabilities(): Promise<AdapterCapabilities>;
  validateSession(): Promise<SessionState>;
  listCourses(context: SyncContext): Promise<CourseSnapshot[]>;
  listWeeks(course: ExternalRef): Promise<WeekSnapshot[]>;
  listMaterials(course: ExternalRef, week?: number): Promise<MaterialSnapshot[]>;
  listAssignments(course: ExternalRef, week?: number): Promise<AssignmentSnapshot[]>;
  listMessages(course: ExternalRef): Promise<MessageSnapshot[]>;
  listGrades(course: ExternalRef): Promise<GradeSnapshot[]>;
}
```

Интерфейс описывает доменные результаты, а не URL или селекторы. Возможности конкретного адаптера объявляются явно. Записывающие операции должны находиться в отдельном интерфейсе `UniversitySubmissionAdapter` и отдельном deployment/permission boundary.

## Потоки

### Read-only синхронизация

BullMQ job → ABU adapter → snapshots → raw observations → normalization → matching → status → notifications.

### Гибридная навигация AIS

```text
Цель адаптера
  → наблюдение видимых ссылок/кнопок
  → семантический planner без модели
  → при неопределённости локальный Ollama/Qwen fallback
  → read-only safety policy
  → один Playwright-клик
  → проверка ожидаемого состояния
  → повторное наблюдение
```

Модель не получает `Page` и не управляет Playwright напрямую. Она может вернуть только `targetId` из сформированного наблюдением списка. Пароли и поля ввода не включаются в наблюдение. Опасные названия, изменяющие URL, внешние домены и неподтверждённые JavaScript-ссылки отбрасываются до и после решения модели. При отсутствии однозначного безопасного действия навигация останавливается.

### Подготовка работы

Выбор студента → анализ требований → уточнение → генерация версии → проверки → `READY_FOR_REVIEW` → явное одобрение.

### Будущая отправка

`APPROVED` version → повторное подтверждение назначения и файла → idempotency key → Submission Connector → проверка видимого результата → audit event. Этот поток не входит в первый MVP.

## Безопасность

- least privilege и read-only по умолчанию;
- шифрование session state и артефактов;
- секреты вне Git и БД;
- PII redaction в логах;
- allowlist доменов;
- изоляция AI от браузерных полномочий;
- недоверенный контент AIS не может инициировать инструменты или менять policy;
- approval привязан к хэшу версии, дисциплине и каналу назначения;
- полная аудит-трасса без хранения секретов.

## Наблюдаемость

Метрики: длительность синхронизации, успешность по разделам, возраст watermark, количество новых/изменённых наблюдений, доля `UNKNOWN`, ошибки авторизации и circuit breaker. Логи структурированные, с correlation ID и без содержимого личных сообщений.

## Почему не микросервисы на старте

Один аккаунт и неизвестный контракт AIS не оправдывают операционную сложность микросервисов. Границы модулей и очереди достаточно подготовят систему к дальнейшему выделению компонентов.
