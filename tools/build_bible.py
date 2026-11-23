"""Build the Bible study files (bible/index.json and one file per book) from the
World English Bible USFM files.

Source: https://eBible.org/Scriptures/eng-web_usfm.zip (public domain).
Nothing is typed by hand: every word of Scripture, every book name and every
translators' note comes from the downloaded source. Uses the Python standard library only.

Left out on purpose:
- the WEB preface and glossary, and the introductions eBible.org places before
  chapter 1 of some books (they are not Scripture), except the Prologue of Sirach,
  which is part of that book as it has come down to us;
- the WEB's cross-references;
- the translators' notes listed in LEFT_OUT_NOTES (they state church positions;
  decided at content review, 2026-11-22: the app states no position).

Every chapter is checked as it is built: the words shown, in order, must equal the
source chapter with only its markup, notes and cross-references taken out.

Usage:
    python tools/build_bible.py              # extract from the pinned copy, write files
    python tools/build_bible.py --check      # extract and compare with the files in bible/
    python tools/build_bible.py --zip path   # use another copy of the zip
    python tools/build_bible.py --download   # use today's file from eBible.org
The pinned copy is sources/eng-web_usfm.zip (see tools/build_scripture.py).
"""
import argparse
import gzip
import hashlib
import io
import json
import pathlib
import re
import sys
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from build_scripture import SOURCE_URL, add_source_args, clean, source_bytes  # noqa: E402  the same cleaning as the prayer screens

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "bible"

# The shelves, in the order shown. Book order within a shelf follows the source.
OT = "GEN EXO LEV NUM DEU JOS JDG RUT 1SA 2SA 1KI 2KI 1CH 2CH EZR NEH EST JOB PSA PRO ECC SNG ISA JER LAM EZK DAN HOS JOL AMO OBA JON MIC NAM HAB ZEP HAG ZEC MAL".split()
NT = "MAT MRK LUK JHN ACT ROM 1CO 2CO GAL EPH PHP COL 1TH 2TH 1TI 2TI TIT PHM HEB JAS 1PE 2PE 1JN 2JN 3JN JUD REV".split()
AP = "TOB JDT ESG WIS SIR BAR 1MA 2MA 1ES MAN PS2 3MA 2ES 4MA DAG".split()
SHELVES = [("ot", OT), ("nt", NT), ("ap", AP)]

# Books whose text before chapter 1 is kept: (book, the heading it starts at).
KEEP_BEFORE_CHAPTER_1 = {"SIR": "The Prologue of the Wisdom of Jesus the Son of Sirach."}

# Translators' notes not shown: (book, chapter, the words the note starts with).
LEFT_OUT_NOTES = [
    ("DAG", 3, "The Song of the Three Holy Children is an addition to"),
    ("DAG", 13, "The History of Susanna is translated from"),
    ("DAG", 14, "Bel and the Dragon is translated from"),
]

BS = re.escape("\\")
NOTE = re.compile(BS + r"f\s(.*?)" + BS + r"f\*", re.S)
XREF = re.compile(BS + r"x\s.*?" + BS + r"x\*", re.S)
VERSE = re.compile(BS + r"v\s+(\d+(?:-\d+)?)\s")
# Markers that start a new block: paragraphs, poetry lines, headings, blank lines.
BLOCK = re.compile(BS + r"(p|m|nb|mi|pc|pi\d?|li\d?|q\d?|qr|qc|b|d|s\d?|ms\d?|mr|sp|is\d?|ip|cp)(?=\s|$)")
HEADINGS = {"d", "s", "s1", "s2", "ms", "ms1", "ms2", "mr", "sp", "is", "is1"}


def markup_out(t):
    """clean() from build_scripture without its final strip, so spaces next to notes stay."""
    t = re.sub(r"\|[^\\]*?(?=\\\+?w\*)", "", t)
    t = re.sub(r"\\\+?[a-z]+[0-9]*\*", "", t)
    t = re.sub(r"\\\+?[a-z]+[0-9]*(\s|$)", "", t)
    return re.sub(r"\s+", " ", t)


def note_text(raw):
    raw = re.sub(r"^\+\s*", "", raw.strip())
    raw = re.sub(BS + r"fr\s+\S+\s*", "", raw)
    return clean(raw)


def blocks_of(body, code, ch, kept_notes, dropped):
    """Turn one chapter of USFM into blocks: [kind, token, token, ...].
    A token is text, a verse number (int, or {"v": "15-16"} for a range) or a note {"f": text}."""
    notes = []

    def keep_note(m):
        text = note_text(m.group(1))
        if any(c == code and n == ch and text.startswith(w) for c, n, w in LEFT_OUT_NOTES):
            dropped.append((code, ch, text))
            return " "
        notes.append(text)
        kept_notes.append(text)
        return f"\x01{len(notes) - 1}\x02"

    body = XREF.sub("", body)
    body = NOTE.sub(keep_note, body)
    body = VERSE.sub(lambda m: f"\x03{m.group(1)}\x04", body)
    out = []
    parts = BLOCK.split(body)
    pieces = [("p", parts[0])] + [(parts[i], parts[i + 1]) for i in range(1, len(parts), 2)]
    for kind, content in pieces:
        if kind == "cp":  # a printed chapter number (Psalm 151): not text
            continue
        text = markup_out(content).strip()
        if kind == "b":
            out.append(["b"])
            continue
        if not text:
            continue
        block = [kind]
        for tok in re.split(r"(\x01\d+\x02|\x03[\d-]+\x04)", text):
            if not tok:
                continue
            if tok[0] == "\x01":
                block.append({"f": notes[int(tok[1:-1])]})
            elif tok[0] == "\x03":
                v = tok[1:-1]
                block.append(int(v) if v.isdigit() else {"v": v})
            else:
                block.append(tok)
        out.append(block)
    return out


def words_shown(blocks):
    """All the words a chapter shows, in order, as one string (notes and numbers left out)."""
    return re.sub(r"\s+", " ", " ".join(t for b in blocks for t in b[1:] if isinstance(t, str))).strip()


def source_words(body, code, ch):
    """The same, straight from the source: markup, notes, cross-references and verse numbers out."""
    body = XREF.sub("", NOTE.sub(" ", body))
    body = re.sub(BS + r"cp\s+\S+", " ", body)
    body = VERSE.sub(" ", body)
    return clean(body)


def build_book(usfm):
    code = re.search(r"^\\id\s+(\S+)", usfm, re.M).group(1)
    name = re.search(r"^\\h\s+(.+?)\s*$", usfm, re.M).group(1)
    split = re.split(r"\\c\s+(\d+)\s", usfm)
    before = split[0]
    chapters, kept_notes, dropped = [], [], []
    for i in range(1, len(split), 2):
        n, body = int(split[i]), split[i + 1]
        if n == 1 and code in KEEP_BEFORE_CHAPTER_1:
            start = before.index(KEEP_BEFORE_CHAPTER_1[code]) - len("\\is1 ")
            assert before[start:start + 5] == "\\is1 ", code
            body = before[start:] + "\n" + body
        blocks = blocks_of(body, code, n, kept_notes, dropped)
        if words_shown(blocks) != source_words(body, code, n):
            raise SystemExit(f"{code} {n}: the words shown differ from the source")
        chapters.append({"n": n, "b": blocks})
    # The notes kept and left out, together, must be every note in the source, word for word.
    # Worked out again here, separately from note_text, so that a fault there is caught.
    source = "".join(split[1:]) + (before if code in KEEP_BEFORE_CHAPTER_1 else "")
    expected = [clean(re.sub(BS + r"fr\s+\S+\s*", "", raw.strip().lstrip("+").strip())) for raw in NOTE.findall(source)]
    if sorted(kept_notes + [d[2] for d in dropped]) != sorted(expected):
        raise SystemExit(f"{code}: translators' notes differ from the source")
    # A book's own word for one chapter, where the source gives one (Psalms: "Psalm").
    label = re.search(r"^\\cl\s+(.+?)\s*$", before, re.M)
    return code, name, chapters, dropped, label.group(1) if label else None


def extract(zip_bytes):
    zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    books = {}
    dropped = []
    for name in zf.namelist():
        m = re.search(r"-([A-Z0-9]{3})eng-web\.usfm$", name)
        if not m or m.group(1) in ("FRT", "GLO") or "-GL" in name[:6]:
            continue
        code, title, chapters, d, label = build_book(zf.read(name).decode("utf-8-sig"))
        books[code] = (title, chapters, label)
        dropped += d
    wanted = OT + NT + AP
    if sorted(books) != sorted(wanted):
        raise SystemExit(f"book list differs: {sorted(set(books) ^ set(wanted))}")
    if len(dropped) != len(LEFT_OUT_NOTES):
        raise SystemExit(f"expected to leave out {len(LEFT_OUT_NOTES)} notes, left out {len(dropped)}")
    files = {}
    index = []
    for shelf, codes in SHELVES:
        for code in codes:
            title, chapters, label = books[code]
            data = (json.dumps({"code": code, "name": title, "chapters": chapters}, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
            files[f"{code}.json"] = data
            entry = {"code": code, "name": title, "shelf": shelf, "chapters": len(chapters),
                     "size": len(data), "download": len(gzip.compress(data, 9))}
            if label:
                entry["chapterName"] = label
            index.append(entry)
    version = hashlib.sha256(b"".join(files[k] for k in sorted(files))).hexdigest()[:10]
    doc = {"translation": "World English Bible", "abbreviation": "WEB", "license": "Public Domain",
           "source": SOURCE_URL, "version": version, "books": index}
    files["index.json"] = (json.dumps(doc, ensure_ascii=False, indent=1) + "\n").encode("utf-8")
    return files


def main():
    ap = argparse.ArgumentParser()
    add_source_args(ap)
    ap.add_argument("--check", action="store_true", help="compare with the files in bible/ instead of writing")
    args = ap.parse_args()
    files = extract(source_bytes(args))
    if args.check:
        present = {p.name for p in OUT.glob("*.json")}
        bad = sorted(n for n in set(files) | present if not (OUT / n).exists() or (OUT / n).read_bytes() != files.get(n))
        if bad:
            raise SystemExit(f"MISMATCH with source in: {bad}")
        print(f"OK: {len(files) - 1} books match the source exactly")
        return
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.json"):
        if old.name not in files:
            old.unlink()
    for n, b in files.items():
        (OUT / n).write_bytes(b)
    total = sum(len(b) for b in files.values())
    print(f"wrote {len(files)} files, {total / 1024 / 1024:.1f} MB")


if __name__ == "__main__":
    main()
