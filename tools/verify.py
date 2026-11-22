"""Checks to run before every release. Usage: python tools/verify.py [--zip path]

1. Bundled Scripture equals a fresh extraction from the source.
2. Every verse reference in every language file exists in its Scripture file.
3. The service worker lists exactly the files that are shipped, except the books of
   the Bible, which the app keeps on the device when they are opened.
4. The core app (everything except the books of the Bible) stays small: less than 200 KB.
   This is a check on ourselves, not a promise made in the app.
5. No core file contains the doxology, and no code file contains cookie code or an
   outside address. The page allows requests to its own site only (Content-Security-Policy),
   and every fetch in the code is to a file of the app. The books of the Bible are
   shown as published, so Matthew 6:13 there is whole, with the WEB's note.
6. Every excerpt the app shows has balanced quotation marks once trimmed by the
   same rule as trimQuotes in js/app.js. The one exception is a speech that
   begins partway into an excerpt and runs on past it, plus the excerpts listed in
   AS_IN_SOURCE. Use --quotes to print every excerpt the rule changes, before and after.
7. The language file never uses a fixed prayer or declares anyone saved (NEVER_SAY).
9. The route for leading someone has one name everywhere (share.name).
8. No question in a prayer step invites a bare yes or no.
10. The Bible study files equal a fresh extraction from the source (tools/build_bible.py,
    which also checks every chapter word for word and every translators' note), and the
    service worker's Bible cache is named after the same version.
11. The cross-reference files equal a fresh extraction from the CrossWire TSK module
    (tools/build_tsk.py, given with --tsk-zip), the module's configuration file is kept in
    sources/, and the service worker's TSK cache is named after the same version.
"""
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHIPPED_DIRS = ["css", "js", "lang", "scripture", "icons", "bible", "tsk"]
SHIPPED_FILES = ["index.html", "manifest.webmanifest", "sw.js"]
BUDGET = 200 * 1024  # raised from 100 KB (Phase 1, Bible study) and 160 KB (Phase 2, My study)
problems = []
SHOW_QUOTES = "--quotes" in sys.argv
ARGS = [a for a in sys.argv[1:] if a != "--quotes"]
# --tsk-zip path: the downloaded CrossWire TSK.zip, passed to build_tsk.py as --zip
TSK_ARGS = []
if "--tsk-zip" in ARGS:
    k = ARGS.index("--tsk-zip")
    TSK_ARGS = ["--zip", ARGS[k + 1]]
    del ARGS[k:k + 2]


def strays(t):
    """Unmatched double and single quotation marks, by position."""
    letter = lambda c: c.isalpha()
    stray_d, stray_s, open_d, open_s = set(), set(), [], []
    for i, c in enumerate(t):
        if c == "“":
            open_d.append(i)
        elif c == "”":
            open_d.pop() if open_d else stray_d.add(i)
        elif c == "‘":
            open_s.append(i)
        elif c == "’" and not (i > 0 and letter(t[i - 1]) and i + 1 < len(t) and letter(t[i + 1])):
            open_s.pop() if open_s else stray_s.add(i)
    stray_d.update(open_d)
    stray_s.update(open_s)
    return stray_d, stray_s


def trim_quotes(t):
    """Same rule as trimQuotes in js/app.js: drop an unmatched mark (double or single) at the
    very start or end of the excerpt, and a single mark touching a dropped double mark."""
    stray_d, stray_s = strays(t)
    drop = {i for i in stray_d | stray_s if i in (0, len(t) - 1)}
    for i in list(drop):
        if t[i] == "“" and i + 1 in stray_s:
            drop.add(i + 1)
        if t[i] == "”" and i - 1 in stray_s:
            drop.add(i - 1)
    return "".join(c for i, c in enumerate(t) if i not in drop)


def balanced(t):
    """After trimming, the only unmatched mark allowed is an opening one after the start of
    the excerpt (a speech that begins here and runs on), with a single mark directly after it."""
    stray_d, stray_s = strays(t)
    allowed_d = {i for i in stray_d if t[i] == "“" and i > 0}
    allowed_s = {i + 1 for i in allowed_d if t[i + 1:i + 2] == "‘"}
    # An apostrophe after a word that ends in s (the apostles’ teaching) is not a quotation mark.
    allowed_s |= {i for i in stray_s if t[i] == "’" and 0 < i < len(t) - 1 and t[i - 1] == "s" and t[i + 1] == " "}
    return stray_d <= allowed_d and stray_s <= allowed_s


# Excerpts shown exactly as the source has them although a mark stays unmatched.
# Decided at content review (2026-11-18): show Matthew 28:20 accurately.
AS_IN_SOURCE = {
    ("MAT 28:20b",): "the WEB closes Jesus' words, then adds \"Amen.\"",
}

# Words the app must never say: no fixed prayer, nothing that declares anyone's standing.
NEVER_SAY = ["sinner's prayer", "sinner’s prayer", "you are saved", "you are now saved",
             "you're saved", "welcome to the family", "now you are a christian"]

# Names the route for leading someone was given before it was named "Share Jesus".
OTHER_NAMES = ["save a soul", "with someone", "lead someone", "pray with someone"]


def excerpts(L):
    """Every group of verses the app shows as one excerpt."""
    yield from ([r] for r in L["welcome"]["verses"])
    yield from (s["verses"] for s in L["why"]["sections"])
    yield L["guide"]["introVerses"]
    for st in L["steps"] + L["share"]["steps"]:
        yield from st["verses"]
        yield from st.get("related", [])
        yield from (q["example"] for q in st["guided"] if q.get("example"))
    share = L["share"]
    yield from share["start"]["verses"]
    yield from share["cost"]["verses"]
    yield from share["cost"]["extraVerses"]
    yield from ([r] for r in share["borrow"]["prayers"])
    for sec in share["after"]["sections"]:
        yield from sec["verses"]
    for item in share["after"]["next"]:
        yield from item["verses"]

# 1
r = subprocess.run([sys.executable, str(ROOT / "tools" / "build_scripture.py"), "--check", *ARGS],
                   capture_output=True, text=True)
print("scripture:", (r.stdout or r.stderr).strip())
if r.returncode:
    problems.append("scripture does not match source")

# 2
for lang_file in sorted((ROOT / "lang").glob("*.json")):
    text = lang_file.read_text(encoding="utf-8")
    L = json.loads(text)
    V = json.loads((ROOT / L["meta"]["scriptureFile"]).read_text(encoding="utf-8"))["verses"]
    refs = set(re.findall(r'"([A-Z0-9]{3} \d+:\d+[ab]?)"', text))
    missing = sorted(refs - set(V))
    unknown_books = sorted({ref.split()[0] for ref in refs} - set(L["books"]))
    print(f"{lang_file.name}: {len(refs)} references, {len(missing)} missing")
    if missing or unknown_books:
        problems.append(f"{lang_file.name}: missing {missing}, books without a name {unknown_books}")
        continue

    # 6
    changed = 0
    for group in excerpts(L):
        before = " ".join(V[r] for r in group)
        after = trim_quotes(before)
        label = f"{group[0]}" + (f"-{group[-1].split(':')[1]}" if len(group) > 1 else "")
        if after != before:
            changed += 1
            if SHOW_QUOTES:
                sys.stdout.reconfigure(encoding="utf-8")
                print(f"\n{label}\n  before: {before}\n  after:  {after}")
        if not balanced(after) and tuple(group) not in AS_IN_SOURCE:
            problems.append(f"{lang_file.name}: unbalanced quotation marks in {label}: {after}")
    print(f"{lang_file.name}: quotation marks trimmed in {changed} excerpts")

    # 7
    lower = text.lower()
    said = [w for w in NEVER_SAY if w in lower]
    if said:
        problems.append(f"{lang_file.name}: must never say {said}")
    # 9: the route for leading someone has one name, kept in share.name and used everywhere
    name = L["share"]["name"]
    about = " ".join(" ".join(v) if isinstance(v, list) else str(v) for v in L["about"].values())
    others = [w for w in OTHER_NAMES if w in lower]
    if others or "withSomeone" in L["welcome"] or f'"{name}"' not in about:
        problems.append(f"{lang_file.name}: the route must be called only \"{name}\" (found {others})")
    # 8: a question whose answer becomes part of a prayer must not invite a bare yes or no
    yes_no = re.compile(r"^(is|are|do|does|did|have|has|can|will|would|could|should)\b", re.I)
    for st in L["steps"] + L["share"]["steps"]:
        for q in st["guided"]:
            if yes_no.match(q["q"]):
                problems.append(f"{lang_file.name}: yes/no question in a prayer step: {q['q']}")

# 3 and 4
shipped = [ROOT / f for f in SHIPPED_FILES] + [p for d in SHIPPED_DIRS for p in (ROOT / d).rglob("*") if p.is_file()]
is_book = lambda p: p.parent.name in ("bible", "tsk") and p.name != "index.json"
core = [p for p in shipped if not is_book(p)]
books = [p for p in shipped if is_book(p)]
names = {p.relative_to(ROOT).as_posix() for p in core}
sw = (ROOT / "sw.js").read_text(encoding="utf-8")
listed = set(re.findall(r"^  '([^']+\.[a-z]+)',$", sw, re.M))
if names - {"sw.js"} != listed:
    problems.append(f"sw.js file list differs: {sorted((names - {'sw.js'}) ^ listed)}")
total = sum(p.stat().st_size for p in core)
print(f"core app: {total / 1024:.1f} KB of {BUDGET // 1024} KB in {len(core)} files")
print(f"books and cross-references: {sum(p.stat().st_size for p in books) / 1e6:.1f} MB in {len(books)} files")
if total > BUDGET:
    problems.append("core app over the size budget")

# 5
for p in shipped:
    if p.suffix == ".png":
        continue
    text = p.read_text(encoding="utf-8")
    if not is_book(p) and "For yours is the Kingdom" in text:
        problems.append(f"doxology found in {p.name}")
    if p.suffix in (".js", ".html", ".css"):
        if "document.cookie" in text:
            problems.append(f"cookie code in {p.name}")
        if re.search(r"https?://|//[a-z0-9-]+\.[a-z]", text, re.I):
            problems.append(f"outside address in {p.name}")
        for target in re.findall(r"fetch\(([^)]*)\)", text):
            # Allowed: a quoted app path, the Bible book path built in getBook and keepWholeBible
            # (`url`, always 'bible/' + a book code), the Scripture file named in the language file,
            # and, in the service worker, the page's own request (the page only makes same-site requests).
            if not re.match(r"\s*('[a-z]+/|url$|L\.meta\.scriptureFile$|event\.request$)", target):
                problems.append(f"{p.name}: fetch of something that is not an app file: {target}")
if "default-src 'self'" not in (ROOT / "index.html").read_text(encoding="utf-8"):
    problems.append("index.html must keep its Content-Security-Policy (requests to its own site only)")

# 10
r = subprocess.run([sys.executable, str(ROOT / "tools" / "build_bible.py"), "--check", *ARGS],
                   capture_output=True, text=True)
print("bible:", (r.stdout or r.stderr).strip())
if r.returncode:
    problems.append("Bible study files do not match source")
version = json.loads((ROOT / "bible" / "index.json").read_text(encoding="utf-8"))["version"]
if f"const BIBLE = 'teach-us-to-pray-bible-{version}';" not in sw:
    problems.append(f"sw.js BIBLE cache must be named after the Bible version {version}")
if f"'teach-us-to-pray-bible-' + IDX.version" not in (ROOT / "js" / "app.js").read_text(encoding="utf-8"):
    problems.append("app.js must name the Bible cache after the Bible version")

# 11
r = subprocess.run([sys.executable, str(ROOT / "tools" / "build_tsk.py"), "--check", *TSK_ARGS],
                   capture_output=True, text=True)
print("cross-references:", (r.stdout or r.stderr).strip()[-300:])
if r.returncode:
    problems.append("cross-reference files do not match the TSK module")
tsk_version = json.loads((ROOT / "tsk" / "index.json").read_text(encoding="utf-8"))["version"]
if f"const TSK = 'teach-us-to-pray-tsk-{tsk_version}';" not in sw:
    problems.append(f"sw.js TSK cache must be named after the cross-reference version {tsk_version}")
if "DistributionLicense=Public Domain" not in (ROOT / "sources" / "crosswire-tsk.conf").read_text(encoding="utf-8"):
    problems.append("sources/crosswire-tsk.conf must record the module's Public Domain licence")

print("FAILED:\n- " + "\n- ".join(problems) if problems else "ALL CHECKS PASSED")
sys.exit(1 if problems else 0)
