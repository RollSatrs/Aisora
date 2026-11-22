# SRO history and local HTML diagnostics

## SRO status
When an ungraded SRO week is opened, the read-only adapter checks the file history in the "Работа с файлами" dialog:
- A document link inside `#myfiles` with an upload-like file extension => `CONFIRMED` (submitted, pending grading).
- The file picker is present and the file-history links are stable but empty => `ABSENT` (no upload evidence).
- The dialog is missing, loading, changes during observation or times out => `UNKNOWN` (requires clarification, not an automatic debt).
- A visible grade continues to result in `GRADED`.

The agent **never** invokes the file input, uploads, or submits anything.

## Collecting HTML evidence for parser debugging
Enable this in your local `.env` (not in Git):
```env
AIS_SAVE_DIAGNOSTIC_HTML=true
AIS_HTML_DIAGNOSTICS_DIR=artifacts/ais-html
```
Run `/sync`. Aisora will save limited HTML fragments from the verified weekly content when no SRO/SRC link is detected, and the SRO file-history container when opening a submission card. Logs include the local path. Output is saved under `artifacts/ais-html/<account-hash>/<course-hash>-week-10-weekly-content.html` or `...-sro-files.html`.

Security: capture is **disabled by default**. Files stay local and `artifacts/` is gitignored. The capture removes scripts, forms, inputs, URLs, arbitrary attributes and event handlers, keeps structural tags and short HTML text. **Text may still include identifiable names, grades, assignment content, filenames or other private data. Inspect and redact before sharing or uploading.** Never commit these files, publish them, or send your AIS cookies, passwords, or browser profile.

For simple local inspection, open the file in a text editor. Send only the minimum redacted fragment needed for troubleshooting. HTML snapshots do not include working CSS/JS or perform any actions.

```bash
git pull origin main
pnpm test
pnpm typecheck
pnpm build
pnpm start:dev
```
Then use `/sync` and `/srocheck`. Compare SRO history log entries with the portal manually. The UI structure is still being validated on real ABU pages; incorrect "ABSENT" results should be reported before relying on debt notifications.
