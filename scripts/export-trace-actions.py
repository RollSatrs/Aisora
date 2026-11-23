#!/usr/bin/env python3
"""Export sanitized Playwright trace actions for reviewing Aisora sync.

Reads the latest local artifacts/sync-diagnostics/run-*/trace.zip by default.
Does not export HTML, screenshots, URLs, page text, credentials, raw selectors,
network bodies, or raw Playwright error messages.
"""
import json
import re
import sys
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "artifacts" / "sync-diagnostics"
ALLOWED_VERBS = {
    "click", "dblclick", "fill", "press", "check", "uncheck", "selectOption",
    "count", "evaluate", "evaluateAll", "innerText", "textContent",
    "allTextContents", "allInnerTexts", "getAttribute", "isVisible",
    "isEnabled", "isHidden", "waitFor", "waitForSelector", "waitForFunction",
    "waitForLoadState", "waitForURL", "goto", "reload", "goBack", "goForward",
    "dispatchEvent", "scrollIntoViewIfNeeded", "hover", "focus",
    "inputValue", "locator", "frameLocator", "getByRole", "getByText",
    "getByLabel", "screenshot", "download", "get", "post", "fetch",
    "waitForTimeout", "title", "url", "content", "setInputFiles",
    "first", "last", "nth", "filter", "querySelector", "querySelectorAll",
    "waitForEvent", "waitForResponse", "waitForRequest", "getByTestId",
}

def safe_action(api):
    # Never include arguments, dynamic user-provided text, or raw API fields.
    if not isinstance(api, str):
        return "other"
    candidates = re.findall(r"[A-Za-z][A-Za-z0-9]*", api)
    verb = candidates[-1] if candidates else ""
    if verb not in ALLOWED_VERBS:
        return "other"
    prefix = "locator" if "locator" in api.lower() else (
        "page" if "page" in api.lower() or "frame" in api.lower() else "playwright"
    )
    return f"{prefix}.{verb}"

def safe_target(params):
    if not isinstance(params, dict):
        return "unspecified", None
    selector = params.get("selector", "")
    if not isinstance(selector, str):
        return "unspecified", None
    # Only hardcoded structural markers are retained. Course names, student
    # identifiers, message identifiers and arbitrary DOM text are discarded.
    m = re.search(r"#li-(\\d{1,2})(?:\\b|\\s)", selector)
    if m and 1 <= int(m.group(1)) <= 20:
        return "week-button", int(m.group(1))
    if "#journaltabletab" in selector:
        return "journal-content", None
    if "#contentdetdiv" in selector:
        return "assignment-detail", None
    if "#tab_2-2" in selector:
        return "sro-tab", None
    if "#tab_3-2" in selector:
        return "sent-messages-tab", None
    if "#myfiles" in selector:
        return "submission-files", None
    if "#inboxmail" in selector:
        return "message-detail", None
    if "#weeknumber" in selector:
        return "week-controls", None
    if "#main" in selector:
        return "main-panel", None
    if "#mail-" in selector:
        return "message-row", None
    if "button" in selector:
        return "button", None
    if "link" in selector or "<a" in selector:
        return "link", None
    return "other-locator", None

def as_number(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None

def locate_trace():
    if len(sys.argv) > 2:
        raise SystemExit("Usage: python3 scripts/export-trace-actions.py [path/to/trace.zip]")
    if len(sys.argv) == 2:
        path = Path(sys.argv[1]).expanduser().resolve()
    else:
        paths = sorted(RUNS.glob("run-*/trace.zip"))
        if not paths:
            raise SystemExit("Trace file not found. First complete a /sync with diagnostics enabled.")
        path = paths[-1]
    if not path.is_file() or path.name != "trace.zip":
        raise SystemExit("Please specify a local trace.zip file.")
    return path

def main():
    source = locate_trace()
    records = []
    pending = {}
    found_traces = 0
    with zipfile.ZipFile(source) as archive:
        # Ignore *.network, *.stacks, resources and DOM snapshot files.
        names = [n for n in archive.namelist() if n.endswith(".trace")]
        for part_idx, name in enumerate(sorted(names), start=1):
            found_traces += 1
            with archive.open(name) as stream:
                for raw in stream:
                    try:
                        event = json.loads(raw)
                    except (ValueError, UnicodeError):
                        continue
                    if not isinstance(event, dict):
                        continue
                    typ = event.get("type")
                    call_id = event.get("callId")
                    if call_id is None:
                        continue
                    key = (part_idx, str(call_id))
                    if typ == "before":
                        action = safe_action(event.get("apiName", event.get("method")))
                        target, week = safe_target(event.get("params", {}))
                        pending[key] = {
                            "action": action,
                            "target": target,
                            "week": week,
                            "start": as_number(event.get("startTime")),
                        }
                    elif typ == "after":
                        before = pending.pop(key, None)
                        if before is None:
                            continue
                        end = as_number(event.get("endTime"))
                        start = before["start"]
                        duration = round(max(0, end - start), 1) if end is not None and start is not None else None
                        error = event.get("error")
                        outcome = "success" if not error else "error"
                        timeout = None
                        if error:
                            # Only the numeric timeout is extracted; never export
                            # complete error messages (they can contain page text).
                            msg = str(error.get("message", "")) if isinstance(error, dict) else str(error)
                            match = re.search(r"Timeout\\s+(\\d+)ms\\s+exceeded", msg, re.I)
                            if match:
                                outcome = "timeout"
                                timeout = int(match.group(1))
                        record = {
                            "action": before["action"],
                            "target": before["target"],
                            "week": before["week"],
                            "duration_ms": duration,
                            "outcome": outcome,
                            "timeout_ms": timeout,
                            "_start": start,
                            "_part": part_idx,
                        }
                        records.append(record)

    records.sort(key=lambda r: (r["_part"], r["_start"] if r["_start"] is not None else float("inf")))
    baseline = min((r["_start"] for r in records if r["_start"] is not None), default=None)
    for index, item in enumerate(records, start=1):
        item["number"] = index
        item["at_ms"] = round(item["_start"] - baseline, 1) if item["_start"] is not None and baseline is not None else None
        del item["_start"]
        del item["_part"]

    counts = Counter(r["action"] for r in records)
    outcomes = Counter(r["outcome"] for r in records)
    duration_by_action = defaultdict(float)
    for record in records:
        duration_by_action[record["action"]] += record["duration_ms"] or 0
    result = {
        "format": "aisora-playwright-actions-sanitized-v1",
        "privacy": "Structural labels and timings only. No HTML, DOM text, passwords, URLs, student data, selector values, or raw errors.",
        "trace_parts": found_traces,
        "actions_count": len(records),
        "outcomes": dict(outcomes),
        "action_counts": dict(counts.most_common()),
        "slowest_action_types_ms": dict(sorted(duration_by_action.items(), key=lambda kv: -kv[1])[:25]),
        "actions": records,
    }
    output = source.parent / "trace-actions-sanitized.json"
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    output.chmod(0o600)
    print(f"Processed {found_traces} Playwright trace parts.")
    print(f"Exported {len(records)} completed actions; outcomes: {dict(outcomes)}")
    print(f"Safe-to-share actions: {output}")
    print("The original trace.zip remains local; do not upload it.")
    if found_traces == 0 or len(records) == 0:
        print("WARNING: No supported Playwright before/after action pairs found. Contact developer.")

if __name__ == "__main__":
    main()
