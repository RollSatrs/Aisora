# Предварительная схема базы данных

PostgreSQL — источник истины; Drizzle ORM — типизированный доступ и миграции. Имена ниже предварительные.

## Основные сущности

| Таблица | Ключевые поля |
|---|---|
| `users` | `id`, `telegram_user_id`, `timezone`, `created_at` |
| `university_accounts` | `id`, `user_id`, `adapter_key`, `external_account_ref`, `status`, `last_sync_at` |
| `auth_sessions` | `id`, `account_id`, `encrypted_storage_ref`, `expires_at`, `revoked_at` |
| `academic_terms` | `id`, `account_id`, `name`, `starts_on`, `ends_on`, `week_rule`, `source` |
| `academic_weeks` | `id`, `term_id`, `number`, `starts_on`, `ends_on`, `external_ref` |
| `courses` | `id`, `account_id`, `term_id`, `external_ref`, `name`, `teacher_name_masked`, `active` |
| `schedule_events` | `id`, `course_id`, `starts_at`, `ends_at`, `kind`, `source_fingerprint` |
| `materials` | `id`, `course_id`, `week_id`, `external_ref`, `kind`, `title`, `content_hash`, `last_seen_at` |
| `assignments` | `id`, `course_id`, `week_id`, `external_ref`, `type`, `number`, `title`, `due_at`, `required_state`, `status` |
| `assignment_versions` | `id`, `assignment_id`, `content_hash`, `normalized_payload`, `observed_at` |
| `messages` | `id`, `course_id`, `external_ref`, `direction`, `subject`, `sent_at`, `content_hash` |
| `attachments` | `id`, `owner_type`, `owner_id`, `external_ref`, `filename`, `mime_type`, `size`, `sha256` |
| `grades` | `id`, `course_id`, `week_id`, `assignment_id`, `external_ref`, `value`, `graded_at` |
| `submissions` | `id`, `assignment_id`, `external_ref`, `channel`, `submitted_at`, `verification_state` |
| `assignment_evidence` | `id`, `assignment_id`, `evidence_type`, `source_table`, `source_id`, `weight`, `observed_at` |
| `work_artifacts` | `id`, `assignment_id`, `version`, `storage_ref`, `sha256`, `state`, `created_at` |
| `approvals` | `id`, `artifact_id`, `user_id`, `decision`, `artifact_sha256`, `decided_at` |
| `sync_runs` | `id`, `account_id`, `scope`, `started_at`, `finished_at`, `status`, `watermark` |
| `source_observations` | `id`, `sync_run_id`, `source_type`, `external_ref`, `fingerprint`, `payload_redacted`, `observed_at` |
| `change_events` | `id`, `entity_type`, `entity_id`, `change_type`, `before_hash`, `after_hash`, `created_at` |
| `job_executions` | `id`, `idempotency_key`, `job_type`, `state`, `attempt`, `scheduled_at`, `finished_at` |
| `audit_events` | `id`, `actor_type`, `actor_id`, `action`, `target_type`, `target_id`, `metadata_redacted`, `created_at` |

## Связи

```text
user 1─* university_account 1─* course 1─* assignment 1─* assignment_version
                              │          ├─* assignment_evidence
                              │          ├─* work_artifact 1─* approval
                              │          └─* submission
                              ├─* message ─* attachment
                              ├─* grade
                              └─* sync_run 1─* source_observation
```

## Ограничения и индексы

- `unique(account_id, adapter_key, external_ref)` для внешних сущностей.
- `unique(idempotency_key)` для jobs и будущих отправок.
- `unique(assignment_id, content_hash)` для версий.
- Индексы по `account_id`, `course_id`, `week_id`, `status`, `due_at`, `last_seen_at`.
- Частичный индекс для активных задолженностей.
- `external_ref` может быть nullable, пока AIS не подтвердит стабильный ID; тогда используется fingerprint.

## Приватность

- Не хранить пароль, cookies в открытом виде или полный HTML страниц.
- `teacher_name_masked` следует заменить на отдельную зашифрованную PII-модель, если ФИО действительно нужно продукту.
- Текст сообщений по умолчанию не сохранять; хранить нормализованную тему/хэш и минимум, необходимый для сопоставления.
- Файлы держать в зашифрованном object storage с retention policy, а не в PostgreSQL.
- Для `payload_redacted` применять allowlist полей, а не постфактум удалять секреты.

## Статусы и история

Текущий статус задания хранится для быстрых запросов, но каждое изменение сопровождается evidence и audit event. Решение пользователя имеет приоритет над слабым автоматическим выводом; изменение статуса должно быть объяснимым.
