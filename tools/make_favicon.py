#!/usr/bin/env python3
"""
Generate the site icons from one original design.

The mark is a deliberately generic document/page glyph. A.A.'s circle-and-
triangle is a registered mark of A.A. World Services and is not used here --
this is an unofficial index and must not look like an official one.

Outputs favicon.svg, favicon.ico, apple-touch-icon.png, icon-192.png,
icon-512.png and site.webmanifest in the repository root.
"""
from __future__ import annotations

import json
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TEAL = (31, 111, 139, 255)      # --sa-accent
PAPER = (255, 255, 255, 255)
LINE = (31, 111, 139, 255)

SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img"
     aria-label="SimplifyAA">
  <rect width="64" height="64" rx="13" fill="#1f6f8b"/>
  <!-- a page with a folded corner -->
  <path d="M19 13h19l11 11v27a3 3 0 0 1-3 3H19a3 3 0 0 1-3-3V16a3 3 0 0 1 3-3z"
        fill="#ffffff"/>
  <path d="M38 13v8a3 3 0 0 0 3 3h8z" fill="#cfe3ea"/>
  <!-- lines of text -->
  <g stroke="#1f6f8b" stroke-width="3.2" stroke-linecap="round">
    <path d="M23 33h19"/>
    <path d="M23 40h19"/>
    <path d="M23 47h12"/>
  </g>
</svg>
"""


def rounded(size: int) -> Image.Image:
    """Draw the mark at the given pixel size."""
    scale = 8  # supersample, then downscale for clean edges
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    u = s / 64.0  # one SVG unit in pixels
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(13 * u), fill=TEAL)

    # Page body, with the top-right corner cut away for the fold.
    left, top, right, bottom = 16 * u, 13 * u, 49 * u, 54 * u
    fold = 11 * u
    d.rounded_rectangle([left, top, right, bottom], radius=int(3 * u), fill=PAPER)
    d.polygon([(right - fold, top), (right, top), (right, top + fold)], fill=TEAL)
    d.polygon([(right - fold, top), (right, top + fold), (right - fold, top + fold)],
              fill=(207, 227, 234, 255))

    # Lines of text.
    w = max(1, int(3.2 * u))
    for y, x_end in ((33, 42), (40, 42), (47, 35)):
        d.line([(23 * u, y * u), (x_end * u, y * u)], fill=LINE, width=w)

    return img.resize((size, size), Image.LANCZOS)


def main() -> int:
    with open(os.path.join(ROOT, "favicon.svg"), "w", encoding="utf-8") as fh:
        fh.write(SVG)

    # Multi-size .ico for browsers and bookmark bars that still ask for it.
    ico_sizes = [16, 32, 48, 64, 128, 256]
    frames = [rounded(n) for n in ico_sizes]
    frames[0].save(os.path.join(ROOT, "favicon.ico"), format="ICO",
                   sizes=[(n, n) for n in ico_sizes])

    rounded(180).save(os.path.join(ROOT, "apple-touch-icon.png"))
    rounded(192).save(os.path.join(ROOT, "icon-192.png"))
    rounded(512).save(os.path.join(ROOT, "icon-512.png"))

    manifest = {
        "name": "SimplifyAA - A.A. Document Finder",
        "short_name": "SimplifyAA",
        "description": "An unofficial, searchable index of every PDF published on aa.org.",
        "start_url": "./",
        "scope": "./",
        "display": "standalone",
        "background_color": "#f4f6f8",
        "theme_color": "#1f6f8b",
        "icons": [
            {"src": "icon-192.png", "sizes": "192x192", "type": "image/png",
             "purpose": "any maskable"},
            {"src": "icon-512.png", "sizes": "512x512", "type": "image/png",
             "purpose": "any maskable"},
            {"src": "favicon.svg", "sizes": "any", "type": "image/svg+xml"},
        ],
    }
    with open(os.path.join(ROOT, "site.webmanifest"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)

    for name in ("favicon.svg", "favicon.ico", "apple-touch-icon.png",
                 "icon-192.png", "icon-512.png", "site.webmanifest"):
        path = os.path.join(ROOT, name)
        print("  %-22s %6d bytes" % (name, os.path.getsize(path)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
