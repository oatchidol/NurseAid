---
name: NurseAid
description: Ward-console UI for real-time patient alert monitoring and device pairing
colors:
  ward-blue: "#3b82f6"
  ward-blue-strong: "#2563eb"
  ward-blue-dark: "#58a6ff"
  ward-blue-light: "#60a5fa"
  status-ok: "#22c55e"
  status-caution: "#eab308"
  status-warning: "#f59e0b"
  status-critical: "#ef4444"
  status-critical-text: "#c81e1e"
  status-success-text: "#137a39"
  status-warning-text: "#946005"
  status-temp-text: "#c2410c"
  priority-high: "#a855f7"
  priority-high-text: "#9333ea"
  priority-medium-text: "#475569"
  priority-low-text: "#5b6777"
  surface-page: "#f0f4f8"
  surface-card: "#ffffff"
  surface-input: "#f1f5f9"
  surface-badge: "#e2e8f0"
  ink-heading: "#0f172a"
  ink-primary: "#1e293b"
  ink-secondary: "#475569"
  ink-tertiary: "#5b6777"
  line-default: "#e2e8f0"
  line-focus: "#3b82f6"
typography:
  label:
    fontFamily: "'Prompt', sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 700
  small:
    fontFamily: "'Prompt', sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
  body:
    fontFamily: "'Prompt', sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.6
  bodyLarge:
    fontFamily: "'Prompt', sans-serif"
    fontSize: "1rem"
    fontWeight: 400
  title:
    fontFamily: "'Prompt', sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.3
  display:
    fontFamily: "'Prompt', sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.25
  vital:
    fontFamily: "'Prompt', sans-serif"
    fontSize: "1.875rem"
    fontWeight: 900
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
rounded:
  xs: "2px"
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1rem"
  xl: "1.25rem"
  pill: "9999px"
spacing:
  1: "0.25rem"
  2: "0.5rem"
  3: "0.75rem"
  4: "1rem"
  5: "1.25rem"
  6: "1.5rem"
  8: "2rem"
  10: "2.5rem"
components:
  button-primary:
    backgroundColor: "{colors.ward-blue}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "0.7rem 1.1rem"
  button-primary-hover:
    backgroundColor: "{colors.ward-blue}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "0.7rem 1.1rem"
  button-secondary:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.md}"
    padding: "0.7rem 1.1rem"
  card:
    backgroundColor: "{colors.surface-card}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
---

# Design System: NurseAid

## Overview

**Creative North Star: "The Ward Console"**

NurseAid reads like an instrument panel built for a ward, not a marketing surface: calm, high-trust, and legible at a glance under time pressure. A single restrained blue carries navigation and action; a fixed, non-negotiable set of status colors (green / amber / red, plus a purple priority marker) carries clinical meaning and nothing else is allowed to compete with it. Cards sit on a soft slate-blue page background and lift with a light, consistent shadow scale — enough depth to separate content groups, never enough to feel decorative. Both a light and a high-contrast dark theme are first-class, token-driven, and already implemented.

Anti-reference: consumer-app playfulness, marketing-site boldness, illustrative flourish, or any redesign impulse that treats visual excitement as the goal. This is Operate-mode software — a nurse scanning this screen mid-shift should find the one thing that needs attention immediately, not admire the interface.

**Key Characteristics:**
- One accent color (ward blue) for navigation/action; a fixed, separate status-color set for clinical signal.
- Soft-shadow, rounded cards on a flat slate page background — layered but restrained.
- Thai-language UI throughout (`Prompt` typeface, chosen for Thai + Latin coverage).
- Full light/dark theme parity via CSS custom properties, not an afterthought.

## Colors

A single blue carries brand/action; a separate, fixed status palette carries clinical meaning and must never be repurposed decoratively.

### Primary
- **Ward Blue** (`#3b82f6` light / `#58a6ff` dark): links, primary buttons, focus rings, active nav state, chart accents. The only color used for "this is interactive / this is us."

### Secondary — Status & Priority (functional, not decorative)
- **Status OK** (`#22c55e` / `#3fb950` dark): device online, alert resolved, success confirmations.
- **Status Caution** (`#eab308` / `#d29922` dark): pending/attention states that are not yet critical.
- **Status Warning** (`#f59e0b` / `#d29922` dark): elevated attention, e.g. threshold approaching.
- **Status Critical** (`#ef4444` / `#f85149` dark): active alert, device offline, destructive actions.
- **Priority High** (`#a855f7` / `#c084fc` dark): highest-priority alert marker, reserved for priority ranking only — never mixed with the OK/Caution/Warning/Critical status set.

### Neutral
- **Surface Page** (`#f0f4f8` / `#010409` dark): app background.
- **Surface Card** (`#ffffff` / `#161b22` dark): cards, panels, modals, sidebar.
- **Surface Input** (`#f1f5f9` / `#1c2128` dark): form fields, chips, table alt-rows.
- **Ink Heading** (`#0f172a` / `#f0f6fc` dark): headings.
- **Ink Primary** (`#1e293b` / `#f0f6fc` dark): body text.
- **Ink Secondary** (`#475569` / `#c9d1d9` dark): supporting/secondary text.
- **Ink Tertiary** (`#94a3b8` / `#8b949e` dark): placeholders, disabled, least-emphasis text.
- **Line Default** (`#e2e8f0` / `#30363d` dark): borders, dividers, table rules.

### Named Rules
**The Fixed Signal Rule.** Status colors (OK/Caution/Warning/Critical) and the priority marker map to one meaning each, system-wide. Never assign them to a new UI concept (e.g. "featured," "new," "premium") even when the hue would otherwise fit — a nurse's trust that red always means the same thing is the product's actual safety property.

**The One Accent Rule.** Ward Blue is the only color that means "click me" or "this is active." Introducing a second brand accent for variety dilutes the one visual signal staff can act on without reading.

## Typography

**Display/Body Font:** Prompt (weights 300/400/600), with `sans-serif` fallback.
**Mono Font:** `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`, for device IDs, timestamps, and other tabular/scannable data.

**Character:** A rounded, humanist grotesque built for Thai-script legibility at small sizes, kept to three weights so hierarchy stays calm rather than typographically loud.

### Hierarchy
- **Display** (600, 1.5rem, 1.25 line-height): page/section titles.
- **Title** (600, 1.125rem, 1.3 line-height): card headers, modal titles.
- **Body** (400, 0.875rem, 1.6 line-height): default UI text, table cells, form labels.
- **Label** (700, 0.68rem, uppercase-optional): nav labels, small badges, dense metadata.
- **Mono** (400, 0.72rem): IDs, timestamps, technical/tabular values — switches out of Prompt so numerals and codes stay unambiguous.

### Named Rules
**The Numerals-in-Mono Rule.** Any value staff cross-check against a physical device or wristband
(device ID, MAC, bed number, HN, timestamp) renders in `--font-mono`, not Prompt — ambiguous digit
shapes are a real-world matching error, not a style nitpick.

**The Tabular-Figures Rule.** Any figure compared against another figure — a vital, a threshold, a
bed or device number, a timestamp — sets `font-variant-numeric: tabular-nums`. Proportional digits
render two readings of the same length at different widths, which is exactly the comparison being
made.

**The 11px Floor.** No UI text renders below `--fs-label` (11px). Thai tone marks (ไม้เอก, ไม้โท)
stack above the baseline and merge into the glyph below roughly that size, so the 10px web
minimum is not low enough for this product's script. Verified by rendering, not by inspection.

**The Fixed-Scale Rule.** Type is a fixed rem ramp, never `clamp()`/viewport-fluid. Two ward
screens of different widths must render the same reading at the same size.


## Layout

Sidebar-driven app shell: a persistent left nav (collapsible to icon-only via `.sidebar-hide`) with content in a card-grid main area. Density is comfortable-compact — enough padding to scan quickly, not so much that a ward-sized alert list requires excess scrolling. Responsive behavior collapses the sidebar and stacks cards at narrow widths (mobile web, not a distinct native layout). Spacing follows a quarter/half-rem rhythm (`0.5rem`/`0.75rem`/`1rem`/`1.25rem`/`1.75rem`) rather than a strict 8pt grid.

## Elevation & Depth

Layered, not flat: the page background sits at zero elevation, cards lift off it with a soft, low-contrast shadow scale (`shadow-sm` → `shadow-xl`), and modals sit above a dimmed backdrop (`--bg-modal`). Shadows are ambient (soft, diffuse) rather than structural/directional — they separate content groups, they don't simulate physical light sources or invite skeuomorphic treatment. Dark theme keeps the same scale but with higher-opacity black shadows to stay legible against near-black surfaces.

### Shadow Vocabulary
- **sm** (`0 1px 2px rgba(0,0,0,0.05)`): subtle separation, e.g. table headers, inline chips.
- **md** (`0 4px 6px -1px rgba(0,0,0,0.07), 0 2px 4px -1px rgba(0,0,0,0.03)`): default card elevation.
- **lg** (`0 10px 15px -3px rgba(0,0,0,0.08), 0 4px 6px -2px rgba(0,0,0,0.03)`): dropdowns, popovers.
- **xl** (`0 20px 25px -5px rgba(0,0,0,0.08), 0 10px 10px -5px rgba(0,0,0,0.02)`): modals.

### Named Rules
**The Confident-Not-Playful Rule.** Elevation communicates hierarchy (this floats above that), never delight. No bounce, no exaggerated lift-on-hover beyond a small, functional shift.

## Shapes

Consistently rounded, never sharp: most containers use `rounded-xl` (`0.75rem`)–`rounded-2xl` (`1rem`), the dominant radius in the codebase; pills (`rounded-full`) mark badges, status chips, and some primary CTAs; large modals/sheets step up to `1.25rem`. Borders are thin (`1px`) and low-contrast (`--border-color`), used to separate same-elevation siblings (table rows, list items) rather than to frame every card — shadow does that job instead.

## Components

### Buttons
- **Shape:** `rounded-md`–`rounded-lg` (`0.75rem`–`0.85rem`), pill (`9999px`) for a few compact primary CTAs (e.g. Quick Setup entry point).
- **Primary:** Ward Blue background, white text, bold weight (700–800), `0.7rem 1.1rem` padding.
- **Secondary:** Surface Card background, `Ink Primary` text, `1px` border in `Line Default`.
- **Hover / Focus:** opacity/background shift plus a small transform, `0.2s ease`; focus ring uses `Line Focus` (`--border-focus`).

### Chips / Badges
- **Style:** `Surface Badge` background, `Ink Secondary`/status-color text, `rounded-md`–`pill`, small bold label type.
- **State:** status chips (online/offline, alert level, priority) always draw from the fixed status-color set, never the neutral palette, so severity stays scannable even in a dense list.

### Cards / Containers
- **Corner Style:** `rounded-xl`/`rounded-2xl`.
- **Background:** `Surface Card`, with a distinct `Surface Card Hover` on interactive cards.
- **Shadow Strategy:** `shadow-md` at rest; see Elevation & Depth.
- **Border:** thin `Line Default` border on data cards (table-like containers); borderless on shadow-only content cards.
- **Internal Padding:** `spacing.md`–`spacing.lg`.

### Inputs / Fields
- **Style:** `Surface Input` background, `1px` `Line Default` border, `rounded-md`.
- **Focus:** background shifts to `Surface Card`/`Surface Input Focus`, border shifts to `Line Focus`.

### Navigation
- **Style:** icon + label nav links in the sidebar, `Ink Secondary` at rest, Ward Blue + bold weight when active; `sidebar-hide` collapses to icon-only at narrow widths or on user toggle. Nav items are capability-gated — a link only renders for a role that actually has the permission, so navigation itself never implies access that doesn't exist.

## Do's and Don'ts

### Do:
- **Do** keep status colors (green/amber/red + priority purple) reserved exclusively for their existing clinical meaning.
- **Do** pair color with an icon or text label on every alert/status indicator — never ship color as the only signal.
- **Do** use the mono type stack for device IDs, MACs, bed numbers, and timestamps.
- **Do** implement every new surface in both the light and `[data-theme="dark"]` token sets — this codebase treats dark mode as first-class, not optional.
- **Do** keep Ward Blue as the single accent; route all "interactive/active" signaling through it.

### Don't:
- **Don't** introduce a second brand accent color, gradient hero treatment, or decorative illustration — this is Operate-mode software, not a marketing surface.
- **Don't** repurpose a status color for a non-clinical UI concept (e.g. "new," "featured") even if the hue would otherwise fit.
- **Don't** add motion beyond small, functional transitions (`0.15s`–`0.3s` ease); no bounce, parallax, or attention-seeking animation on a screen someone monitors for real alerts.
- **Don't** reword or translate existing Thai UI copy while doing visual work — copy changes are a separate, explicit decision.


## Icons

One drawn set, not a font. 24×24 grid, 2px stroke, round caps and joins, masked so every icon
inherits `currentColor` and therefore themes automatically. Inlined as data URIs so they render
on a ward network with no outbound access.

Sizes come from a scale that is deliberately **separate from the type ramp** — an icon is not
text, and sizing one with `font-size` is what let glyph sizes and type sizes drift into a single
undifferentiated pile:

- `--icon-sm` 14px — inline with label/body text
- `--icon-md` 18px — nav, buttons, chips
- `--icon-lg` 24px — panel headers, dialogs
- `--icon-xl` 40px — empty states

### Named Rules
**The No-Emoji Rule.** An emoji is not an icon. Its glyph, weight, and colour are whatever font
the viewer's OS ships, and a colour emoji fights the status palette beside it. PRODUCT.md requires
every status to pair colour **with** an icon; that icon half cannot be outsourced to a font.

## Text Colour vs. Fill Colour

The single most common accessibility failure in this codebase was using a saturated status hue as
small text. A hue readable as a **fill** is routinely unreadable as **text** on the same surface.

Every status therefore has two tokens, and they are not interchangeable:

| Meaning | Fill (marks, borders, ≥3:1) | Text / white-bearing fill (≥4.5:1) |
|---|---|---|
| Critical | `--accent-red` | `--status-critical-text` |
| Success | `--accent-green` | `--status-success-text` |
| Caution | `--accent-yellow` | `--status-warning-text` |
| Temperature | `--accent-amber` | `--status-temp-text` |
| Action / brand | `--accent-primary` | `--accent-primary-strong` |
| Priority high | `--priority-high` | `--priority-high-text` |

### Named Rules
**Tune against the worst surface, not the best.** The original text tokens were tuned against
`--bg-card` (#ffffff) and then used on `--bg-primary` (#f0f4f8), where they measured 4.37–4.54 and
missed AA. Every value is now verified against the darkest light surface it can land on.

**Never `color: white` on an accent fill.** Accents are dark in the light theme and *light* in the
dark theme, so literal white measures ~2.5:1 there. Use `--text-inverse`, which is `#ffffff` in
light and `#0d1117` in dark and is correct in both.

**Tint a badge from its own text colour.** A badge fill written as
`color-mix(in srgb, <its text token> 15%, transparent)` keeps its contrast ratio in both themes
automatically. A fixed hex for either half breaks the other theme.

## Where Colour Is Decided

Tailwind's colour utilities are not absolute values in this codebase. `tailwind.config.js` maps
every shade the dark theme needs onto a `--tw-<property>-<family>-<shade>` custom property, and
the two values live side by side in the token blocks in `server.js`:

```
:root                { --tw-bg-slate-50: #f8fafc; }        /* Tailwind's own value */
[data-theme="dark"]  { --tw-bg-slate-50: var(--bg-card); }
```

The mapping is **per property, not per shade**, because a hue that works as a fill is not the
value that works as text: `.bg-red-600` resolves to the red *fill* token, `.text-red-600` to the
red *text* token. See "Text Colour vs. Fill Colour" above.

This replaced 59 `[data-theme="dark"] .X { … !important }` rules in a second stylesheet. That
block was not merely ugly. Because `!important` in a stylesheet outranks an inline `style`
attribute, `[data-theme="dark"] .bg-red-600 { … !important }` also overrode the background the
alert code sets from JavaScript — so in the dark theme a **warning-only** site banner painted
itself in the **critical** red. Colour semantics are safety-critical here; they cannot live
somewhere a specificity fight can reach them.

### Named Rules

**Only remapped shades are var-backed.** Everything else keeps its literal Tailwind value, so
this mapping can never move a colour the dark theme was not already moving. Each family is
listed in full in the config, because `extend` replaces a family wholesale rather than merging.

**Utilities cannot flip a foreground.** A background token says nothing about the text on it.
The dark accents are light, so the handful of fills that carry text keep an explicit
`color: var(--text-inverse)` rule. Same for hover states that differ from their rest state —
Tailwind emits a variant as its own selector reading the same token.

## Both Documents Inline the Tokens

`server.js` renders two complete HTML documents: the app shell (`ui()`) and `/login`. Tokens are
defined once, in `DESIGN_TOKENS`, and the drawn icons in `ICON_SET`; both documents inline both.

This is load-bearing, not tidiness. `/login` previously carried no token block, so every
var-backed utility on it resolved to an invalid declaration — `text-3xl` fell back to 16px and
`rounded-2xl` to 0. Nothing errored and nothing looked obviously broken; the page just rendered
at the wrong size. A page that inlines neither constant fails the same silent way.

`/login` owns one token of its own, `--bg-login`, because the page background is the one surface
a Tailwind neutral cannot carry: `.bg-slate-900` means "dark button" everywhere else in the
product and maps to the accent in dark.

## Documented Deviations

Two patterns here would be flagged as decorative side-borders by a generic rule, and are kept
deliberately because they are the opposite of decorative:

- `#monitor-grid > .card` carries a 4px leading-edge border in the compact layout. That border
  **is** the clinical-state signal (green normal / amber warning / red critical), moved from the
  top edge because a vertical stripe survives a narrow card better than a horizontal one.
- `.drop-left` / `.drop-right` / `.drop-before` / `.drop-after` are drag-insertion feedback.

Shadow and overlay values use raw `rgba(0,0,0,…)` by design — they are opacity over an unknown
surface, not palette colours, and are enumerated in the Elevation & Depth vocabulary above.

`#sidebar` animates `width` and `min-width`, which a generic rule flags as a layout transition.
It is kept: collapsing the sidebar *is* a layout change, and the main content has to reflow into
the space. A `transform` would slide the sidebar over the content or leave a gap instead of
handing the width back. The progress fills that had no such excuse — `.qs-fill` and the update
progress bar — animate `transform: scaleX()` instead.
