"""Build the cross-reference files (tsk/index.json and one file per book) from the
Treasury of Scripture Knowledge, CrossWire Bible Society edition, version 1.4.

Source: https://www.crosswire.org/ftpmirror/pub/sword/packages/rawzip/TSK.zip
(DistributionLicense=Public Domain; the module's configuration file is kept in
sources/crosswire-tsk.conf). Nothing is typed by hand: every heading and reference
comes from the module, read with the Python standard library.

What is kept: for each verse, the TSK's groups, each a heading in the words of the King
James Version followed by its references. What is left out: the chapter summaries and
book introductions at verse 1, the TSK's explanatory notes (such as "Heb. ..."), and
text the module stores in book or chapter heading slots rather than in a verse.

References are in King James numbering. They match the WEB everywhere except Romans,
where the WEB prints 16:25-27 as 14:24-26. One explicit rule, taken from the WEB's own
note at Romans 14:26, maps KJV Romans 16:25-27 to WEB Romans 14:24-26 (decided at content
review, 2026-11-22); the build stops if that note is ever missing. Nothing else is remapped:
a reference that does not land on a verse with text in the WEB is kept as the TSK wrote
it and shown as plain text. Run with --unmatched to list them.

Usage:
    python tools/build_tsk.py --zip path/TSK.zip [--check] [--unmatched]
"""
import argparse
import gzip
import hashlib
import io
import json
import pathlib
import re
import struct
import sys
import urllib.request
import zipfile
import zlib

SOURCE_URL = "https://www.crosswire.org/ftpmirror/pub/sword/packages/rawzip/TSK.zip"
ROOT = pathlib.Path(__file__).resolve().parent.parent
BIBLE = ROOT / "bible"
OUT = ROOT / "tsk"
P = "modules/comments/zcom/tsk/"
# The module declares no encoding, so it is SWORD's default, Latin-1.
ENCODING = "latin-1"
# Where KJV numbering and the WEB's differ (WEB note at Romans 14:26). Source entries for
# these KJV verses are not attached to any WEB verse.
KJV_CHAPTER_VERSES = {("ROM", 14): 23, ("ROM", 16): 27}
# The one remapping: KJV Romans 16:25-27 is WEB Romans 14:24-26, as the WEB's note there says.
ROMANS_NOTE = "TR places verses 24-26 after Romans 16:24 as verses 25-27."


def check_romans_note():
    rom = json.loads((BIBLE / "ROM.json").read_text(encoding="utf-8"))
    notes = [t["f"] for b in rom["chapters"][13]["b"] for t in b[1:] if isinstance(t, dict) and "f" in t]
    if ROMANS_NOTE not in notes:
        raise SystemExit("the WEB's note at Romans 14:26 has changed: the Romans rule cannot be applied")


def romans_rule(book, ch, v1, v2):
    """'ROM 16:25-26=ROM 14:24-25' for KJV Romans 16:25-27, else None. Shown as the TSK's
    reference, previewing the WEB's verses, with a line saying where the WEB has them."""
    if book == "ROM" and ch == 16 and 25 <= v1 <= v2 <= 27:
        kjv = f"ROM 16:{v1}" + (f"-{v2}" if v2 > v1 else "")
        web = f"ROM 14:{v1 - 1}" + (f"-{v2 - 1}" if v2 > v1 else "")
        return kjv + "=" + web
    return None


def read_module(data):
    z = zipfile.ZipFile(io.BytesIO(data))
    conf = z.read("mods.d/tsk.conf").decode("latin-1")
    if "DistributionLicense=Public Domain" not in conf or "Version=1.4" not in conf:
        raise SystemExit("unexpected module licence or version")
    out = {}
    for t in ("ot", "nt"):
        bzs, bzv, bzz = (z.read(P + t + ext) for ext in (".bzs", ".bzv", ".bzz"))
        blocks = [struct.unpack("<III", bzs[i:i + 12]) for i in range(0, len(bzs), 12)]
        cache, ents = {}, []
        for i in range(0, len(bzv), 10):
            b, off, size = struct.unpack("<IIH", bzv[i:i + 10])
            if size == 0:
                ents.append("")
                continue
            if b not in cache:
                o, s, _ = blocks[b]
                cache[b] = zlib.decompress(bzz[o:o + s])
            ents.append(cache[b][off:off + size].decode(ENCODING))
        out[t] = ents
    return conf, out


def web_books():
    idx = json.loads((BIBLE / "index.json").read_text(encoding="utf-8"))
    books = {}
    for b in idx["books"]:
        doc = json.loads((BIBLE / (b["code"] + ".json")).read_text(encoding="utf-8"))
        chapters = []
        for c in doc["chapters"]:
            have, cur = {}, None
            for blk in c["b"]:
                for t in blk[1:]:
                    if isinstance(t, int) or (isinstance(t, dict) and "v" in t):
                        v = t if isinstance(t, int) else t["v"]
                        cur = int(str(v).split("-")[0])
                        last = int(str(v).split("-")[-1])
                        for x in range(cur, last + 1):
                            have.setdefault(x, False)
                    elif isinstance(t, str) and cur is not None and t.strip():
                        have[cur] = True
            chapters.append(have)  # verse number -> has text
        books[b["code"]] = {"shelf": b["shelf"], "chapters": chapters}
    return idx, books


def layout(idx, books):
    """(testament, index) -> (code, chapter, verse) under KJV numbering."""
    where = {}
    for t, shelf in (("ot", "ot"), ("nt", "nt")):
        i = 1
        for b in [x for x in idx["books"] if x["shelf"] == shelf]:
            code = b["code"]
            i += 1
            for ch, have in enumerate(books[code]["chapters"], 1):
                i += 1
                n = KJV_CHAPTER_VERSES.get((code, ch), max(have))
                for v in range(1, n + 1):
                    where[(t, i + v)] = (code, ch, v)
                i += n
        where[(t, "end")] = i
    return where


SEG = re.compile(r"<scripRef(?: passage=\"([^\"]*)\")?>(.*?)</scripRef>|<br />", re.S)


def parse_entry(text):
    """[(heading or None, refs text)], plus the summary anchors and counts of what is left out."""
    groups, anchors, dropped = [], [], 0
    pieces, pos = [], 0
    for m in SEG.finditer(text):
        if text[pos:m.start()].strip():
            pieces.append(("text", text[pos:m.start()]))
        if m.group(0) != "<br />":
            pieces.append(("passage", m.group(1)) if m.group(1) is not None else ("refs", m.group(2)))
        pos = m.end()
    if text[pos:].strip():
        pieces.append(("text", text[pos:]))
    heading = None
    for k, (kind, val) in enumerate(pieces):
        if kind == "passage":
            anchors.append(val)
        elif kind == "text":
            nxt = pieces[k + 1][0] if k + 1 < len(pieces) else None
            prev = pieces[k - 1][0] if k > 0 else None
            # A line right after a chapter-summary anchor ("<scripRef passage=...>14</scripRef> ...")
            # is part of the chapter summary, never a heading.
            if prev == "passage":
                dropped += 1
                heading = None
                continue
            if nxt != "refs":
                dropped += 1  # a note, summary or introduction with no references of its own
                heading = None
                continue
            # "brought up.  Heb. born.  Joseph's." -> the heading for the references is the last part
            last = re.sub(r"\s+", " ", re.split(r"\s{2,}", val.strip())[-1]).strip()
            # A note sometimes runs straight on after the heading: "shall wear out.By wars, ..."
            last = re.split(r"(?<=\.)(?=[^\s.,;])", last)[0].strip()
            # A heading is a few of the verse's words: letters and ordinary punctuation only.
            plain_words = re.fullmatch(r"[A-Za-zÀ-ÿ'’ ,;:!?()\-]+\.?", last) is not None
            # The TSK's own notes have fixed openings ("Heb. born.", "or, sons.", "That is, ...").
            note_like = (re.match(r"(Heb\.|Gr\.|Chal\.|Syr\.|or,|i\.e\.|That is,|See )", last)
                         or last.endswith(":") or re.search(r"\b[A-Z]\.$", last))
            if plain_words and len(last.split()) <= 6 and not note_like:
                heading = last
            else:
                heading = None
                dropped += 1
        elif kind == "refs":
            groups.append((heading, re.sub(r"\s+", " ", val).strip()))
            heading = None
    return groups, anchors, dropped


def book_abbreviations(entries, where):
    """Each book's TSK abbreviation, read from its own chapter summaries (passage="Joh 3:1")."""
    abbr = {}
    for (t, i), (code, ch, v) in [(k, x) for k, x in where.items() if k[1] != "end"]:
        for a in parse_entry(entries[t][i])[1]:
            m = re.match(r"(.+?) (\d+):\d+$", a)
            if m:
                abbr.setdefault(m.group(1), set()).add(code)
    clash = {a: c for a, c in abbr.items() if len(c) != 1}
    if clash:
        raise SystemExit(f"abbreviations naming more than one book: {clash}")
    return {a: c.pop() for a, c in abbr.items()}


REF_ITEM = re.compile(r"^(?:(\d?\s?[A-Z][a-z]*)\s+)?(?:(\d+):)?([\d,\s\-]+)$")
SPAN = re.compile(r"^(?:(\d?\s?[A-Z][a-z]*)\s+)?(\d+):(\d+)-(\d+):(\d+)$")  # "Isa 13:1-14:32"


def resolve_refs(text, own_code, own_ch, abbr, books):
    """'Ps 33:6,9; 148:5; Mt 8:3' -> list of 'PSA 33:6', 'PSA 33:9' ... or '?<as written>' if unmatched."""
    out = []
    book, ch = own_code, own_ch
    has_text = lambda b, c, v: 1 <= c <= len(books[b]["chapters"]) and books[b]["chapters"][c - 1].get(v)
    for item in [x.strip() for x in text.split(";") if x.strip()]:
        if item.startswith("*"):
            # "*marg:", "*Gr:", "*title": the TSK pointing to its margin or a title, not a reference
            out.append("*")
            continue
        s = SPAN.match(item)
        if s:
            if s.group(1):
                name = s.group(1).replace(" ", "")
                book = abbr.get(name)
            c1, v1, c2, v2 = (int(x) for x in s.groups()[1:])
            if book and c2 > c1 and has_text(book, c1, v1) and has_text(book, c2, v2):
                out.append(f"{book} {c1}:{v1}-{c2}:{v2}")
                ch = c2
            else:
                out.append("?" + item)
            continue
        m = REF_ITEM.match(item)
        written = item
        if m and m.group(1):
            name = m.group(1).replace(" ", "")
            if name not in abbr:
                out.append("?" + written)
                book = None
                continue
            book = abbr[name]
            ch = None
        if not m or book is None:
            out.append("?" + written)
            continue
        if m.group(2):
            ch = int(m.group(2))
        if ch is None:
            # a book with one chapter may be cited by verse alone ("Jude 3")
            if len(books[book]["chapters"]) == 1:
                ch = 1
            else:
                out.append("?" + written)
                continue
        prefix = (m.group(1) + " " if m.group(1) else "") + (m.group(2) + ":" if m.group(2) else "")
        for part in [p.strip() for p in m.group(3).split(",") if p.strip()]:
            r = re.match(r"^(\d+)(?:-(\d+))?$", part)
            chap = books[book]["chapters"][ch - 1] if 1 <= ch <= len(books[book]["chapters"]) else None
            if not r or chap is None:
                out.append("?" + (prefix if part == m.group(3).split(",")[0].strip() else "") + part)
                continue
            v1, v2 = int(r.group(1)), int(r.group(2) or r.group(1))
            mapped = romans_rule(book, ch, v1, v2)
            if mapped:
                out.append(mapped)
                prefix = ""
                continue
            # A range matches when both ends are verses with text in the WEB (a verse the WEB
            # does not print, inside the range, does not stop it).
            if v2 < v1 or not chap.get(v1) or not chap.get(v2):
                out.append("?" + (prefix if part == m.group(3).split(",")[0].strip() else "") + part)
                continue
            out.append(f"{book} {ch}:{v1}" + (f"-{v2}" if v2 > v1 else ""))
            prefix = ""
    return out


def build(data):
    conf, entries = read_module(data)
    idx, books = web_books()
    where = layout(idx, books)
    for t in ("ot", "nt"):
        if where[(t, "end")] != len(entries[t]) - 1:
            raise SystemExit(f"{t}: the module has {len(entries[t])} entries, the layout expects {where[(t, 'end')] + 1}")
    # Every chapter summary must name the chapter it is filed under.
    for (t, i), (code, ch, v) in [(k, x) for k, x in where.items() if k[1] != "end"]:
        for a in parse_entry(entries[t][i])[1][:1]:
            m = re.match(r".+? (\d+):\d+$", a)
            if m and int(m.group(1)) != ch:
                raise SystemExit(f"{code} {ch}: summary names chapter {m.group(1)}")
    abbr = book_abbreviations(entries, where)
    check_romans_note()
    files, unmatched = {}, []
    stats = {"groups": 0, "headings": 0, "refs": 0, "unmatched": 0, "left_out_text": 0, "heading_slots_left_out": 0, "kjv_only_verses": 0}
    per_book = {}
    placed = set(where)
    for t in ("ot", "nt"):
        for i, e in enumerate(entries[t]):
            if (t, i) not in placed:
                if e.strip():
                    stats["heading_slots_left_out"] += 1
                continue
            code, ch, v = where[(t, i)]
            groups, _, dropped = parse_entry(e)
            stats["left_out_text"] += dropped
            if not groups:
                continue
            key = f"{ch}:{v}"
            if romans_rule(code, ch, v, v):
                key = romans_rule(code, ch, v, v).split("=")[1].split(" ")[1]  # the TSK's entry for KJV 16:25 sits on WEB 14:24
            elif not books[code]["chapters"][ch - 1].get(v):
                stats["kjv_only_verses"] += 1  # a verse the WEB does not print as text
                continue
            out = []
            for heading, refs in groups:
                resolved = resolve_refs(refs, code, ch, abbr, books)
                stats["margin_markers_left_out"] = stats.get("margin_markers_left_out", 0) + resolved.count("*")
                resolved = [r for r in resolved if r != "*"]
                if not resolved:
                    continue
                for r in resolved:
                    if r.startswith("?"):
                        unmatched.append((f"{code} {ch}:{v}", heading or "", r[1:]))
                stats["groups"] += 1
                stats["headings"] += heading is not None
                stats["refs"] += len(resolved)
                stats["unmatched"] += sum(r.startswith("?") for r in resolved)
                out.append([heading, resolved])
            per_book.setdefault(code, {})[key] = out
    index = []
    for b in [x for x in idx["books"] if x["code"] in per_book]:
        data_b = (json.dumps({"code": b["code"], "verses": per_book[b["code"]]}, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        files[b["code"] + ".json"] = data_b
        index.append({"code": b["code"], "size": len(data_b), "download": len(gzip.compress(data_b, 9))})
    version = hashlib.sha256(b"".join(files[k] for k in sorted(files))).hexdigest()[:10]
    files["index.json"] = (json.dumps({"source": SOURCE_URL, "edition": "CrossWire Bible Society, version 1.4", "license": "Public Domain",
                                       "version": version, "books": index}, ensure_ascii=False, indent=1) + "\n").encode("utf-8")
    return files, conf, unmatched, stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", help="path to an already downloaded TSK.zip")
    ap.add_argument("--check", action="store_true", help="compare with the files in tsk/ instead of writing")
    ap.add_argument("--unmatched", help="write the list of unmatched references to this file")
    args = ap.parse_args()
    if args.zip:
        data = pathlib.Path(args.zip).read_bytes()
    else:
        req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "teach-us-to-pray build script"})
        data = urllib.request.urlopen(req, timeout=120).read()
    files, conf, unmatched, stats = build(data)
    sys.stdout.reconfigure(encoding="utf-8")
    if args.unmatched:
        with open(args.unmatched, "w", encoding="utf-8", newline="\n") as f:
            f.write("verse\theading\treference as the TSK wrote it\n")
            for row in unmatched:
                f.write("\t".join(row) + "\n")
    if args.check:
        present = {p.name for p in OUT.glob("*.json")}
        bad = sorted(n for n in set(files) | present if not (OUT / n).exists() or (OUT / n).read_bytes() != files.get(n))
        kept = (ROOT / "sources" / "crosswire-tsk.conf")
        if not kept.exists() or kept.read_text(encoding="utf-8") != conf:
            bad.append("sources/crosswire-tsk.conf")
        if bad:
            raise SystemExit(f"MISMATCH with source in: {bad}")
        print(f"OK: {len(files) - 1} books of cross-references match the source exactly")
        return
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.json"):
        if old.name not in files:
            old.unlink()
    for n, b in files.items():
        (OUT / n).write_bytes(b)
    (ROOT / "sources").mkdir(exist_ok=True)
    (ROOT / "sources" / "crosswire-tsk.conf").write_text(conf, encoding="utf-8", newline="")
    print(json.dumps(stats))
    print(f"wrote {len(files)} files, {sum(len(b) for b in files.values()) / 1e6:.2f} MB, "
          f"download about {sum(gzip.compress(b, 9).__len__() for b in files.values()) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
