# Aisora Learning Mode — isolation contract (planned)

Priority: stabilize ordinary `/sync` and SRO/SRSP extraction before enabling training.

## Runtime isolation
- Learning mode is **OFF by default** and opt-in only.
- It has a separate queue/storage namespace and no direct access to the production `UniversityAdapter`, `AcademicRepository` write path, or submission action.
- Ordinary `/sync`, `/tasks`, `/debts`, and `/srocheck` remain deterministic and must work without Ollama or training tools.
- Never train synchronously during a browser session or block a live read-only sync.
- Training data may contain only explicit, consented, sanitized **observation → allowed action → expected result → verified outcome** examples; no credentials, cookies, personal messages, student identifiers, or full uncontrolled DOM dumps.
- No screenshot/trace recording by default; recordings require user opt-in and redaction.
- An unsuccessful or unverified click is not a positive training example.
- A candidate model is evaluated on a held-out suite before manual promotion, never hot-swapped mid-sync.
- The navigation safety policy remains independent of the model and rejects unsafe proposals.
- Uploads/submissions have a separate approval boundary and are disabled by default. Learning Mode never performs them.

## Stage order
1. Baseline read-only SRO sync successfully reads the week 10 brief and matches the same course/week SRO submission card.
2. Add diagnostics and regression fixtures for changed Ajax layouts.
3. Implement opt-in **passive** examples recorder, disabled without a feature flag, storing only redacted data.
4. Add offline replay + quality metrics for navigation (success, false matches, no-op, unexpected destination).
5. Only then add supervised fine-tuning / LoRA trials in a separate training process.

## Acceptance criteria before stage 3
- `/sync` still reports the same debts as the baseline for fixed fixtures.
- `/srocheck` can show a verified matched brief for Blockchain, week 10.
- No prompts, data collection, Ollama calls or model weights are needed for standard syncing.
- Missing/ambiguous details produce a safe warning, not a guessed document or an upload.
