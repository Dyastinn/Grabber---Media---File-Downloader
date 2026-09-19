# Grabber popup — design plan

Subject: a tool that intercepts media off a web page. Audience: someone who
already knows what HLS is, wants one specific file, and is in the popup for
under ten seconds. Primary job: scan a list, identify the right item, pick a
quality, watch it assemble.

Vernacular to mine: broadcast/video engineering — SMPTE colour bars, the
bitrate ladder, segments, manifests.

## Color — "Signal"

Category identity comes from muted SMPTE colour-bar hues, carried as a 3px
left edge on each row. Functional (tells you what a row is without a label),
and specific to video in a way no other product's palette would be.

  --bar-stream    #3FA9C4   cyan
  --bar-video     #C9A227   yellow
  --bar-audio     #4F9E5F   green
  --bar-image     #B45BC4   magenta
  --bar-document  #5878C4   blue
  --bar-archive   #C0553F   red
  --bar-other     #7C868F   grey

Ground / ink (dark is primary — a video tool's natural mode — light fully
supported via prefers-color-scheme):

  dark   ground #101418  raised #1A2027  ink #E6EAEE  muted #8A949E
  light  ground #FAFAF8  raised #FFFFFF  ink #14202A  muted #61707C

Action colour is the bars' magenta, #A855C9 (dark) / #8B3FAE (light).
Deliberately not the blue/green/terracotta defaults, and it belongs to the
same SMPTE family as the category edges rather than arriving from nowhere.

## Type

  Display  Bahnschrift / Avenir Next Condensed / Oswald / ui-sans-serif
           Wordmark, counts, quality rungs. A condensed technical grotesque,
           not system-ui.
  UI       Inter / Segoe UI / -apple-system  — labels, buttons, notices.
  Mono     ui-monospace / Cascadia Code / SF Mono — filenames ONLY.
           A filename is a path, not prose: character disambiguation is the
           reason, not decoration. No mono on labels.

Scale (12 -> 20, ~1.2): 11 / 12 / 13 / 15 / 20. Tabular numerals on every
size and bitrate so the right column aligns.

## Layout

Left-aligned throughout; sizes and bitrates right-aligned in a numeric column.

  +---------------------------------------+
  | |||||||  GRABBER          7 found     |  bar strip + condensed wordmark
  +---------------------------------------+
  |: clip-1080.m3u8                       |  3px category edge, mono filename
  |: Video stream            Choose quality|
  |                                       |
  |: 1080p  ======================  6.2M  |  THE LADDER: bar length = bitrate
  |: 720p   =============  3.1M           |
  |: 480p   ========  1.4M                |
  |                                       |
  |: poster.jpg          240 KB  Download |
  +---------------------------------------+

## Principles

1. Spend the boldness on the quality ladder. It is the one thing this popup
   has that nothing else does: rungs ordered by height, each rung's bar length
   encoding relative bitrate. Everywhere else stays quiet.
2. Rows are not cards. Kill the uniform rounded grey-bordered box on every
   item — that is the SaaS-card default the current CSS already is. Rows are
   separated by space and a category edge; only the *open* row raises.
3. No ALL-CAPS tracked eyebrow headings. Category headings become sentence
   case with a colour chip, or vanish into the row edge.
4. One motion moment: the ladder opening. No section fade-ins, no hover lifts.
   prefers-reduced-motion honoured.
5. Copy is active and consistent: "Download" -> "Downloading" -> "Saved".
   The empty state invites action rather than reporting absence.

## Self-review against the generic defaults

- Cream + serif + terracotta: not used.
- Near-black + one acid accent: the dark ground is real, but the accent is
  magenta and it is not alone — seven category hues share the page. Rejected
  the #2563eb blue already in the code as the action colour for being the
  reflex choice.
- Broadsheet hairlines: rejected. Separation is space, not rules.
- SaaS-card kit: this is what exists today; principle 2 removes it.
- Template chrome: no eyebrows, no middle-dot meta strings, no arrow suffix on
  buttons, no em-dash labels. Mono is scoped to filenames only, where it is
  semantic.

## Code changes required

- popup/popup.css   rewritten
- popup/popup.html  header markup for the bar strip + count
- src/popup/render.ts  QualityOption gains optional `weight` (0-1 relative
  bitrate) rendered as a --weight custom property; category edge via a
  data-category attribute on the row. Tests updated.
- src/popup/index.ts   pass bandwidth-derived weights; set the header count.

## Revisions after review

1. **Ladder degradation.** Bitrate exists on only 2 of 5 quality paths
   (HLS master, DASH). `weight` falls back to normalised height, then to
   nothing — a ladder with no weights renders as plain rungs, no bars. Bars
   get a 12% floor so a clustered ladder doesn't collapse into three equal
   lengths. A single option is not a ladder: it stays a plain button.
2. **Action colour freed.** `--bar-image` moved off magenta to SMPTE red
   #C0553F, `--bar-archive` to #8A7B5C. Magenta-violet is now reserved for
   action alone, so a button never matches its row's edge.
3. **Category named once.** The `h2` group heading stays (e2e asserts on it);
   no per-row category sub-label. The 3px edge carries it inside the group.
4. **e2e contract.** A file row must contain exactly one button —
   `getByRole("button")` is strict. `.quality-label` must hold the label text
   alone. `#root` and the `h2` headings stay.
5. **Palette on bare `:root`.** Full light palette unqualified, dark as a
   token override in `@media (prefers-color-scheme: dark)`, explicit
   `background` on `body` — a popup paints before the stylesheet settles.

Correction to the Type section: only the *display* face escapes system-ui.
The UI stack resolves to Segoe UI / -apple-system on Windows and macOS, which
is the right call at 340px rather than bundling a woff2. The wordmark must
stay legible un-condensed, since Linux has no condensed face to fall to.

## Minimalist revision (brief: "very UX friendly and minimalist")

The brief now names a direction, so it wins over the free choices above.
Applying "remove one accessory" to the Signal plan — several times.

Cut:

- The masthead colour-bar strip. Pure identity, zero function.
- The seven category hues. The `h2` group heading already names the
  category; a second colour-coded channel for the same fact is noise at
  340px. `data-category` stays on the row (cheap, and wiring may want it),
  but nothing paints from it.
- The condensed display face. One family now — the system UI stack — with
  weight and size carrying hierarchy. Mono stays for filenames only, where
  it is semantic.
- Row hover. A row is not interactive; the button is. Hover lives on the
  button.
- The em-dash-joined "Downloading segments — 40%" string. The percentage
  becomes its own right-aligned span, so the label reads as a sentence and
  the number sits over the bar it describes.

Kept:

- The bitrate ladder. Still the one bold element, still functional, and it
  survives minimalism because the bar *is* the information.
- The `h2` headings, the "N found" tally, the empty-state copy (tests and
  e2e pin these).

Added, for UX:

- `aria-live="polite"` on the per-row extra slot: progress phases, errors
  and the picker are now announced, not just the header count.
- `title` on truncated filenames so a long name is recoverable.
- 30px minimum button height; 28px minimum rung height. The biggest
  single "friendly" win — nothing is a 5px-padding target any more.
- Visible focus rings on every control, `prefers-reduced-motion` honoured.

Palette (second revision, brief: "greyscale / monochrome, light and dark"):
no accent at all. Ink on ground; buttons are ink-filled, the ladder bars and
hover are translucent ink, focus is an ink ring. Saved / failed are said in
the label and weighted, never coloured.

  light  ground #FAFAFA  ink #171717  muted #6F6F6F  line/hover/wash = black at 10 / 5 / 7%
  dark   ground #141414  ink #ECECEC  muted #9A9A9A  line/hover/wash = white at 12 / 6 / 9%

Layout is unchanged in structure (header, grouped rows, right-aligned
action) — the change is subtraction, not rearrangement.
