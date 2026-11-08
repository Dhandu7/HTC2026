# VocalEyes — Logo guidelines (compact)

## 1. The logo

**Idea:** an eye that is also a speech bubble. Seeing becomes saying. The coral pupil is the one thing the user chooses with their gaze.

**Versions** (all in `kit/`):

| Version | Use it for |
|---|---|
| Horizontal (`vocaleyes-horizontal.svg`) | Primary. Headers, slides, documents, the demo video. |
| Stacked (`vocaleyes-stacked.svg`) | Tall or square spaces, posters, title cards. |
| Symbol (`vocaleyes-symbol.svg`) | Avatars, in-app mark, anywhere the name is already shown. |
| Wordmark (`vocaleyes-wordmark.svg`) | Only when the symbol sits right next to it. |
| App icon / tile (`vocaleyes-app-icon.svg`) | Favicon, home screen, anything 16–32 px. |

Every version also exists as `-reversed` (for teal or dark backgrounds) and in `export/` as black, white and one-colour teal.

## 2. Clear space

Keep a clear zone of **1 × the iris** (the white ring around the pupil) on every side. The zone scales with the logo, never a fixed distance.

## 3. Minimum size

| Version | Screen | Print |
|---|---|---|
| Horizontal | 140 px wide | 30 mm wide |
| Symbol, full colour | 32 px tall | 8 mm |
| App icon tile | 16 px | 5 mm |

Below 32 px, switch from the full-colour symbol to the tile: the white iris ring blurs together at 16 px.

## 4. Colour

| Name | HEX | RGB | CMYK (approx.) |
|---|---|---|---|
| Gaze Teal (primary) | `#0B4F5C` | 11, 79, 92 | 88 / 14 / 0 / 64 |
| Voice Coral (pupil) | `#E4572E` | 228, 87, 46 | 0 / 62 / 80 / 11 |
| Coral Light (pupil on teal) | `#FF8F6B` | 255, 143, 107 | 0 / 44 / 58 / 0 |
| Paper | `#FAF7F2` | 250, 247, 242 | 0 / 1 / 3 / 2 |
| Ink | `#10242A` | 16, 36, 42 | 62 / 14 / 0 / 84 |

CMYK values are a plain conversion from RGB and no Pantone has been assigned. Proof a printed swatch before any print run.

**Contrast (calculated, WCAG):** teal on white 9.2:1; teal on Paper 8.6:1; Ink on Paper 15.0:1; Coral Light on teal 4.1:1. Coral on white is 3.7:1, which is fine for the pupil as a graphic but not for body text. Do not set text in coral.

**Approved pairs:** full colour on white or Paper · reversed (white bubble, Coral Light pupil) on Gaze Teal or Ink · one-colour black or white where colour is not available.
Never put the full-colour symbol on teal or black: the teal bubble disappears. Use the reversed file.

## 5. Typography

The wordmark is custom-drawn from geometric strokes (outlined paths, no font needed). It is not a typeface, so do not retype "VocalEyes" to imitate it; always use the file.
Suggested UI pairing: a rounded geometric sans such as Nunito or Quicksand (both open-licence on Google Fonts). Confirm the licence before embedding in a product.

## 6. Don'ts

Don't stretch or squash · don't recolour outside the palette · don't rotate or mirror · don't add shadows, outlines or gradients · don't move the pupil or change the tail · don't use the full-colour symbol on teal, black or busy photos (use the reversed file in a container tile) · don't retype the wordmark.

## 7. Files and status

- `kit/` holds the colour masters; `kit/export/` holds black, white and teal one-colour SVGs plus PNGs; `kit/web/` holds the favicon and web-app icon set; `kit/slides/` and `kit/presentation.html` are the presentation board.
- All SVGs are paths only: no live text, no strokes, no filters.
- Not done: trademark and registry search, a Pantone match, hand-kerning review by a type designer, and a one-colour embroidery/vinyl outline check.
