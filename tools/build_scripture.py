"""Build scripture/en-web.json from the World English Bible USFM files.

Source: https://eBible.org/Scriptures/eng-web_usfm.zip (public domain).
No verse text is typed by hand: every word in the output comes from the
downloaded source. Uses the Python standard library only.

Usage:
    python tools/build_scripture.py            # download, extract, write JSON
    python tools/build_scripture.py --check    # extract and compare with the bundled JSON
    python tools/build_scripture.py --zip path # use an already downloaded zip
"""
import argparse
import datetime
import io
import json
import pathlib
import re
import sys
import urllib.request
import zipfile

SOURCE_URL = "https://eBible.org/Scriptures/eng-web_usfm.zip"
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "scripture" / "en-web.json"

# (book code, chapter, first verse, last verse)
PASSAGES = [
    ("MAT", 6, 5, 15),
    ("LUK", 11, 1, 4),
    # Rotating pool of related Scripture, by step
    # 1 Come to the Father
    ("MRK", 1, 35, 35), ("JHN", 4, 23, 24), ("LUK", 11, 9, 13),
    ("LUK", 18, 1, 8), ("PSA", 145, 18, 18), ("PSA", 62, 8, 8), ("PSA", 103, 13, 13),
    # 2 Honor his name
    ("LUK", 10, 21, 21), ("JHN", 12, 27, 28), ("JHN", 11, 41, 42), ("MAT", 22, 37, 38),
    ("JHN", 17, 1, 3), ("PSA", 8, 1, 1), ("PSA", 103, 1, 5), ("PSA", 100, 4, 4),
    # 3 His kingdom and will
    ("MAT", 6, 33, 33), ("MAT", 26, 39, 39), ("MAT", 9, 37, 38), ("MAT", 7, 21, 21),
    ("JHN", 6, 38, 38), ("PSA", 143, 10, 10), ("PSA", 40, 7, 8),
    # 4 Daily bread
    ("MAT", 6, 25, 26), ("MAT", 6, 31, 32), ("MAT", 7, 7, 11),
    ("JHN", 6, 35, 35), ("PSA", 145, 15, 16), ("PSA", 23, 1, 1),
    # 5 Forgive us
    ("MRK", 11, 25, 25), ("MAT", 18, 21, 22), ("MAT", 5, 44, 45), ("LUK", 18, 9, 14),
    ("LUK", 6, 37, 37), ("LUK", 23, 34, 34), ("MAT", 5, 23, 24), ("PSA", 51, 1, 2),
    ("PSA", 32, 5, 5), ("PSA", 103, 12, 12),
    # 6 Keep us and deliver us
    ("MAT", 26, 40, 41), ("JHN", 17, 15, 15), ("LUK", 22, 31, 32),
    ("JHN", 16, 33, 33), ("PSA", 121, 7, 8), ("PSA", 46, 1, 1),
    # 7 Close
    ("JHN", 15, 7, 7), ("JHN", 15, 16, 16), ("MAT", 18, 19, 20), ("MAT", 21, 22, 22),
    ("PSA", 19, 14, 14),
    # Closing step: Jesus' words
    ("JHN", 14, 13, 14),
    ("JHN", 16, 23, 24),
    # Share Jesus: before you begin, count the cost
    ("JHN", 6, 44, 44), ("ACT", 8, 30, 31), ("1CO", 3, 6, 7),
    ("LUK", 14, 28, 28), ("LUK", 9, 23, 23), ("LUK", 8, 13, 13),
    # Share Jesus: who Jesus is, being honest, following, asking, words to borrow
    ("ROM", 10, 9, 10), ("1CO", 15, 3, 4), ("JHN", 3, 16, 16),
    ("MRK", 1, 15, 15), ("1JN", 1, 9, 9), ("MRK", 1, 17, 17),
    ("LUK", 23, 42, 42), ("MRK", 9, 24, 24),
    # Share Jesus: after the prayer, next steps
    ("EPH", 2, 8, 9), ("JHN", 10, 27, 29), ("PHP", 1, 6, 6), ("MAT", 28, 19, 20),
    ("ROM", 8, 38, 39), ("HEB", 13, 5, 5), ("MAT", 7, 24, 27), ("1PE", 4, 12, 12),
    ("JAS", 1, 2, 4), ("1CO", 10, 13, 13), ("2CO", 5, 7, 7),
    ("ACT", 2, 38, 38), ("HEB", 10, 24, 25), ("ACT", 2, 42, 42),
]

# Part-verses. Each verse is cut immediately before the given marker string.
# The build stops if a marker is missing, so a change in the source text can
# never pass silently.
SPLITS = {
    "MAT 6:9": "may your name be kept holy",
    "MAT 6:13": "For yours is the Kingdom",
    # Share Jesus: the warning and the promise in one verse
    "JHN 16:33": "but cheer up",
    # Share Jesus: the prayer itself, without the narrative around it
    "LUK 18:13": "God, be merciful",
    "LUK 23:42": "Lord, remember",
    "MRK 9:24": "I believe",
    "MAT 28:20": "Behold, I am with you",
}

# Text that must never appear in the output (see README: the doxology is not shown).
FORBIDDEN = ["For yours is the Kingdom"]


def clean(usfm):
    """Turn one verse of USFM into plain text."""
    t = re.sub(r"\\f\s.*?\\f\*", "", usfm, flags=re.S)          # footnotes
    t = re.sub(r"\\x\s.*?\\x\*", "", t, flags=re.S)             # cross-references
    t = re.sub(r"\|[^\\]*?(?=\\\+?w\*)", "", t)                 # word attributes (Strong's numbers)
    t = re.sub(r"\\\+?[a-z]+[0-9]*\*", "", t)                   # closing markers
    t = re.sub(r"\\\+?[a-z]+[0-9]*(\s|$)", "", t)               # opening markers and their one space
    return re.sub(r"\s+", " ", t).strip()


def verses_from_book(usfm, chapter):
    """Return {verse number: plain text} for one chapter."""
    chapters = re.split(r"\\c\s+(\d+)", usfm)
    body = None
    for i in range(1, len(chapters), 2):
        if int(chapters[i]) == chapter:
            body = chapters[i + 1]
            break
    if body is None:
        raise SystemExit(f"chapter {chapter} not found")
    parts = re.split(r"\\v\s+(\d+)\s", body)
    return {int(parts[i]): clean(parts[i + 1]) for i in range(1, len(parts), 2)}


def extract(zip_bytes):
    zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    verses = {}
    for book, chapter, first, last in PASSAGES:
        names = [n for n in zf.namelist() if re.search(rf"-{book}eng-web\.usfm$", n)]
        if len(names) != 1:
            raise SystemExit(f"expected one file for {book}, found {names}")
        chapter_verses = verses_from_book(zf.read(names[0]).decode("utf-8-sig"), chapter)
        for v in range(first, last + 1):
            verses[f"{book} {chapter}:{v}"] = chapter_verses[v]

    for ref, marker in SPLITS.items():
        text = verses[ref]
        at = text.find(marker)
        if at <= 0:
            raise SystemExit(f"split marker {marker!r} not found in {ref}: {text!r}")
        verses[ref + "a"] = text[:at].strip()
        verses[ref + "b"] = text[at:].strip()

    # The doxology is not shipped: drop the whole verse and its second part.
    del verses["MAT 6:13"], verses["MAT 6:13b"]

    for ref, text in verses.items():
        for bad in FORBIDDEN:
            if bad in text:
                raise SystemExit(f"forbidden text {bad!r} in {ref}")
        if "\\" in text or "|" in text or not text:
            raise SystemExit(f"unclean text in {ref}: {text!r}")
    return verses


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", help="path to an already downloaded eng-web_usfm.zip")
    ap.add_argument("--check", action="store_true", help="compare with the bundled JSON instead of writing")
    args = ap.parse_args()

    if args.zip:
        data = pathlib.Path(args.zip).read_bytes()
    else:
        req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "teach-us-to-pray build script"})
        data = urllib.request.urlopen(req, timeout=120).read()
    verses = extract(data)

    if args.check:
        bundled = json.loads(OUT.read_text(encoding="utf-8"))["verses"]
        if bundled != verses:
            diff = sorted(k for k in set(bundled) | set(verses) if bundled.get(k) != verses.get(k))
            raise SystemExit(f"MISMATCH with source in: {diff}")
        print(f"OK: {len(verses)} entries match the source exactly")
        return

    doc = {
        "translation": "World English Bible",
        "abbreviation": "WEB",
        "license": "Public Domain",
        "source": SOURCE_URL,
        "retrieved": datetime.date.today().isoformat(),
        "verses": verses,
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    for ref, text in verses.items():
        print(f"{ref}\t{text}")


if __name__ == "__main__":
    main()
