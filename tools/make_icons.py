"""Draw the app icon (a plain cross on a blue field) as SVG and PNG.

Standard library only; no outside artwork. Usage: python tools/make_icons.py
"""
import pathlib
import struct
import zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
BG = (0x1D, 0x3F, 0x72)
FG = (0xFA, 0xF8, 0xF3)
# Bars as fractions of the icon size: (left, top, right, bottom).
# Kept inside the middle 60% so the icon survives a round "maskable" crop.
BARS = [(0.46, 0.26, 0.54, 0.74), (0.34, 0.40, 0.66, 0.48)]


def png(size):
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            fx, fy = (x + 0.5) / size, (y + 0.5) / size
            inside = any(l <= fx < r and t <= fy < b for l, t, r, b in BARS)
            rows += bytes(FG if inside else BG)

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
            + chunk(b"IEND", b""))


def svg():
    rects = "".join(
        f'<rect x="{l * 100:g}" y="{t * 100:g}" width="{(r - l) * 100:g}" height="{(b - t) * 100:g}" fill="#faf8f3"/>'
        for l, t, r, b in BARS)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#1d3f72"/>{rects}</svg>\n'


out = ROOT / "icons"
out.mkdir(exist_ok=True)
(out / "icon.svg").write_text(svg(), encoding="utf-8")
for size in (192, 512):
    (out / f"icon-{size}.png").write_bytes(png(size))
print("icons written")
