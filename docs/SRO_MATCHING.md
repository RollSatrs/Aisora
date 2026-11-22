# SRO matching 1.0 — read-only test phase

## Observed ABU route
1. Select the course in "Электронный журнал".
2. Open the academic week (e.g. 10).
3. Read the link "СРО №3. Анализ блокчейн-платформ (задание)" including its full details.
4. Open the separate "СРО" tab and locate "Самостоятельная работа 10 неделя".
5. Correlate by **same course + same week + SRO type**, not by the brief number №3.
6. Before any future upload, verify that the target is unique and that no submission has already been confirmed.

## Shipped
- The weekly content reader now also opens SRO briefs.
- Briefs are matched to the SRO_TAB records by the deterministic `matchSroBrief` function.
- Multiple briefs per week or missing/unread content do **not** produce a match.
- On a match, the full condition is appended to the SRO record's content (retaining the SRO tab identity, grade and submission evidence). The existing synchronization persists it with the task.
- `extractSroRequirements` reads hints about page count, typography and sources from the full text; this is not document generation.
- Telegram `/srocheck` prints the pending SROs and whether the brief was matched, with a short extract of the condition. Nothing is submitted.

## Local verification
```bash
git pull origin main
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm start:dev
```
In Telegram, run `/sync`, then `/srocheck`. In the blockchain course at week 10, the report should show the text for "СРО №3. Анализ блокчейн-платформ" under "СРО, неделя 10". Inspect the source page if the report does not match. Do not enter passwords or tokens in logs.

## Explicitly not shipped yet
- Creating a finished DOCX or evaluating academic content
- Navigating to the upload modal on demand
- Selecting files / clicking submission controls / sending work
- Post-submission verification

The repository's existing read-only AIS authorization flag is still mandatory. A future submission adapter should require explicit enabled permissions, a confirmed destination, and a unique target, and must not select a file unless the intent to upload is confirmed.
