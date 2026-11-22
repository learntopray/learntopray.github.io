"""Write review/content-review.md: every step with its verses written out in full.

The verse text is read from the bundled scripture file, so the review shows
exactly what the app will show. Usage: python tools/make_review.py [lang]
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
lang = sys.argv[1] if len(sys.argv) > 1 else "en"
L = json.loads((ROOT / "lang" / f"{lang}.json").read_text(encoding="utf-8"))
S = json.loads((ROOT / L["meta"]["scriptureFile"]).read_text(encoding="utf-8"))
V = S["verses"]


def label(group):
    """['MAT 18:21', 'MAT 18:22'] -> 'Matthew 18:21-22'"""
    book, first = group[0].split(" ")
    name = L["books"][book]
    if len(group) == 1:
        return f"{name} {first}"
    return f"{name} {first}-{group[-1].split(':')[1]}"


def quote(group):
    return f"- **{label(group)}** — {' '.join(V[r] for r in group)}"


out = [f"# Content review: {L['app']['name']} ({L['meta']['languageName']})", "",
       f"Scripture: {S['translation']} ({S['license']}), from {S['source']}", ""]
if L.get("guide"):
    out += ["## Guide me: start screen", "", quote(L["guide"]["introVerses"]), "",
            *[f"- {line}" for line in L["guide"]["intro"]], ""]
for i, step in enumerate(L["steps"], 1):
    out += [f"## Step {i}: {step['name']}", "", "The words of Jesus for this step (always shown):", "",
            *[quote(g) for g in step["verses"]], "", f"Question: *{step['prompt']}*", ""]
    if step.get("guided"):
        out += ["Guided questions:", ""]
        for item in step["guided"]:
            cues = f" (Think about: {', '.join(item['cues'])})" if item.get("cues") else ""
            out += [f"- *{item['q']}*{cues}"]
            if item.get("example"):
                out += [f"  - A prayer from Scripture shown with it: {quote(item['example'])[2:]}"]
        out += [""]
    if step.get("note"):
        out += [f"Our note: {step['note']}", ""]
    out += [f"Rotating pool ({len(step['related'])} entries, {L['step']['perDay']} shown per day):", ""]
    out += [quote(g) for g in step["related"]] + [""]

missing = [r for r in re.findall(r'"((?:[A-Z0-9]{3}) \d+:\d+[ab]?)"', json.dumps(L)) if r not in V]
if missing:
    raise SystemExit(f"references not in scripture file: {missing}")
dest = ROOT / "review" / "content-review.md"
dest.parent.mkdir(exist_ok=True)
dest.write_text("\n".join(out), encoding="utf-8")
print(f"wrote {dest}")
