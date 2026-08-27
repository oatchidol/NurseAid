# NurseAid UI/UX Redesign — Implementation Contract

Scope **B**: system-layer redesign + information design of the core Operate surfaces.
Authority: `PRODUCT.md`, `DESIGN.md`. Where this spec and DESIGN.md disagree, this spec wins
and DESIGN.md is updated at the end of the program.

**Non-negotiable constraints** (from PRODUCT.md — violating any of these fails the task):

1. Thai UI copy is **never** reworded, retranslated, or replaced. Visual work only.
   The word for patient is **ผู้ป่วย**, never คนไข้.
2. Alert-state semantics are frozen: green = ok/resolved, amber/yellow = caution/warning,
   red = active alert/offline/destructive, purple = priority-high. Never reassign a status
   colour to a non-clinical concept.
3. Capability/role gating must not change. A design edit may not alter who sees or does what.
4. WCAG 2.2 AA is binding, in **both** themes: text ≥ 4.5:1, visible `:focus-visible` ring on
   every control, real controls (never `<div onclick>`), colour never the only signal,
   `prefers-reduced-motion` respected, **no UI text below 10px**.
5. `public/assets/tailwind.css` is a build artifact. After changing any utility class run
   `npm run build:css` and commit the result. Tailwind is pinned to **3.4.17** — do not upgrade.
6. No outbound network at runtime. Everything ships from `public/assets/`.
   `npm run check:assets` must pass.
7. `npm test` is **not** a gate (it references three files that do not exist). The real gate is
   `node --check server.js`, `npm run check:assets`, and rendered screenshots in both themes.

---

## Diagnosis (measured, not estimated)

| Axis | DESIGN.md says | `server.js` actually has |
|---|---|---|
| Type sizes | 5 steps | **35 distinct values** across 88 declarations |
| — below the 10px floor | 0 allowed | **8 declarations**, smallest `0.48rem` = **7.68px** |
| Border radius | 5 steps | **20 distinct values** across 75 declarations |
| Colour | ~25 tokens | **279 hardcoded Tailwind colour utilities** (64 classes) |
| Dark theme | "token-driven, first-class" | **59 `[data-theme="dark"] .X` override rules** |
| `!important` | — | **200** |
| Icons | "drawn, consistent stroke" | **124 emoji/Unicode glyphs** vs 21 real SVGs |

**Root cause.** The stylesheet does not have a drift problem; it has an *architecture* problem.
Colour lives in the markup as fixed Tailwind utilities, so the dark theme can only be produced by
a second stylesheet that overrides the first with `!important`, and every breakpoint tweak has to
out-specify both. The 35 type sizes and 20 radii are downstream symptoms of that fight.

The stated justification for the `!important` block (`server.js:1890`: "the Tailwind Play CDN
injects its stylesheet at runtime") is **stale** — no CDN reference remains in the file.

---

## Target system

### Type ramp — 7 tokens (was 35 values)

| Token | rem | px | Role |
|---|---|---|---|
| `--fs-label` | `0.6875rem` | 11 | chips, badges, nav + field labels, column heads, dense metadata. **Floor.** |
| `--fs-mono` | `0.75rem` | 12 | device IDs, MAC, bed numbers, timestamps (mono stack) |
| `--fs-body` | `0.875rem` | 14 | default UI text, table cells, inputs, secondary text |
| `--fs-body-lg` | `1rem` | 16 | emphasised body, modal body, prose |
| `--fs-title` | `1.125rem` | 18 | card headers, modal titles, mobile page title |
| `--fs-display` | `1.5rem` | 24 | page titles |
| `--fs-vital` | `2.5rem` | 40 | vital-sign readouts |

Body stays at 14px and title at 18px **deliberately**: that keeps every table row and card height
identical, so this migration is a pure consolidation with near-zero layout reflow. Raising body to
16px is a separate, one-line, reversible decision — not part of this slice.

`--fs-label` at 11px is above both the 10px product floor and every current offender. Thai
diacritics (ไม้เอก / ไม้โท) stack above the baseline and merge below ~11px.

### Icon sizing — NOT font-size

`font-size` is currently used to size glyph "icons" (`.nav-icon`, `.dialog-icon`, `.empty-icon`,
`.panel-close-btn`). Those are not typography and must not consume type tokens.

| Token | px | Role |
|---|---|---|
| `--icon-sm` | 14 | inline with label/body text |
| `--icon-md` | 18 | nav, buttons, chips |
| `--icon-lg` | 24 | panel headers, dialogs |
| `--icon-xl` | 40 | empty states |

### Radius — 5 tokens + 1 exception (was 20 values)

| Token | rem | px | Role |
|---|---|---|---|
| `--r-xs` | `2px` | 2 | **exception**: progress-track hairlines only (`.qs-track`, `.qs-fill`) |
| `--r-sm` | `0.5rem` | 8 | chips, badges, small controls |
| `--r-md` | `0.75rem` | 12 | buttons, inputs, small cards |
| `--r-lg` | `1rem` | 16 | cards, panels |
| `--r-xl` | `1.25rem` | 20 | modals, sheets, side panel |
| `--r-pill` | `9999px` | — | pills, status chips, avatars |

Both `999px` and `9999px` are currently in use; collapse to `--r-pill`.

### Spacing — 4px base, 8 steps

`--sp-1` 4 · `--sp-2` 8 · `--sp-3` 12 · `--sp-4` 16 · `--sp-5` 20 · `--sp-6` 24 · `--sp-8` 32 · `--sp-10` 40

---

## Program — verified slices

Each slice ships independently and is verified before the next begins. **No slice is "done" on
static analysis alone** (PRODUCT.md principle 5: a CSS migration once passed static review while
silently flipping the cascade and changing real padding).

### Slice 0 — token definitions (additive, zero risk) — OWNER: main
Add the scales above to `:root` and `[data-theme="dark"]`. Nothing consumes them yet.
Cannot change a single rendered pixel.

### Slice 1 — type + radius migration — OWNER: chidol-agent
Replace all 88 `font-size` and 75 `border-radius` literals with tokens per the generated
mapping, honouring the manual exceptions. Glyph-sizing sites move to the icon scale instead.
**Acceptance:** `node --check server.js` passes; `npm run build:css` clean; zero `font-size:` or
`border-radius:` literals remain outside the `:root` blocks and the documented exceptions;
screenshots of all surfaces in both themes show no layout shift beyond the tabulated Δpx.

### Slice 2 — colour architecture — OWNER: chidol-agent, in reviewed batches
Replace the 279 hardcoded Tailwind colour utilities with semantic token-driven classes
(`bg-slate-50` → `surface-sunken`, `text-slate-500` → `text-secondary`, …). Then delete the
59-rule dark override block and the `!important`s it required.
**Highest-risk slice.** Batch by class, screenshot after each batch, both themes.
**Acceptance:** dark override block gone; `!important` count down from 200 to < 20; every surface
renders identically in light and correctly in dark; contrast recomputed against real surfaces.

### Slice 3 — icon system — OWNER: main + chidol-agent
Replace the 124 emoji/Unicode glyphs with a real SVG icon set at one consistent stroke weight and
optical size. **Priority order: the safety-critical status icons first** — 🚨 alert, 🔴 offline,
⚠ warning, ✅/✓ resolved, 🩺 🌡 💧 vitals, 🔊 sound, 📡 signal.
Rationale is clinical, not cosmetic: PRODUCT.md mandates colour + icon as a dual-channel signal,
and the icon half is currently rendered by whatever emoji font the OS happens to ship — different
glyph, different weight, and sometimes a *colour that conflicts with the status palette* on every
platform. Inline SVG also renders identically offline.

### Slice 4 — core surface information design — OWNER: main
Requires authenticated access. Monitor dashboard, alert-history, quick-setup, login.
Login additionally **ignores `data-theme` entirely** — it renders identical navy in both themes,
breaking the "dark mode is first-class" rule.

### Slice 5 — craft-floor violations — OWNER: chidol-agent
- Remove kickers/eyebrows: `.panel-kicker` (live at `server.js:3755`,
  `<p class="panel-kicker">VITAL SIGNS · TREND ANALYSIS</p>`), `.ai-chat-message-kicker`,
  `.ai-answer-kicker`. Hard ban per craft-floor.
- Remove the 7 side-tab accent borders (`border-left: 3px/4px solid …`).
- Replace 3 × `transition: width` with transform/`grid-template-rows`.
- Fix 4 gray-on-colour contrast pairs.
- Theme the browser surfaces nothing currently owns: text selection, caret, scrollbar,
  underline offset, and `font-variant-numeric: tabular-nums` on all vital/tabular data.
- `.critical-banner` / `.warning-banner` (`server.js:2190-2191`) hardcode `#eab308` / `#713f12`
  and will not theme — move to tokens. These are safety-critical banners.


---

# CORRECTED FINDINGS — measured in a browser, 2026-08-27

Everything below was measured against the running app in the design sandbox
(`localhost:3399`, DB `nurseaid_design`, synthetic data), not inferred from source.

**Correction to the diagnosis above:** an earlier pass reported the dark theme as broken on
the monitor dashboard. That was a testing artifact — `data-theme` was flipped with JS, but
`#monitor-grid` is rendered by client JS from a passed-in `theme`, so those cards were stale.
Switching the theme the way a user does (persist + reload) renders dark correctly.

**The failures are concentrated in the LIGHT theme — the default one.**

| Surface | Light | Dark |
|---|---|---|
| `/` monitor dashboard | 17 | 2 |
| `/alert-settings` | **24** | 0 |
| `/matching` | 13 | 2 |
| `/devices-mgmt` | 11 | 0 |
| `/alert-history` | 9 | 0 |
| **Total failing text styles** | **74** | **4** |

## A. Tailwind class names used as CSS values — a real code defect

`server.js:6225-6232` assigns Tailwind **class names** to variables that
`server.js:6290-6295` interpolates into `style="…"` attributes:

```js
const bedBg     = isInactive ? 'bg-gray-500' : (isDark ? 'bg-gray-700' : 'bg-gray-800');
const nameColor = isInactive ? 'text-gray-500' : (isDark ? 'text-gray-100' : 'text-slate-800');
const hnColor   = isInactive ? 'text-gray-500' : (isDark ? 'text-gray-500'  : 'text-slate-500');
```
```html
<span … style="background: ${bedBg}; color: white;">${safe.bed}</span>   <!-- :6290 -->
<button … style="color: ${nameColor};">${safe.name}</button>            <!-- :6293 -->
<span   … style="color: ${hnColor};">HN: ${safe.hn}</span>              <!-- :6295 -->
```

`background: bg-gray-800` is not valid CSS. The browser drops the declaration, so the bed-number
badge renders with **no background** and keeps `color: white` → measured **1.24:1** on the light
card. The bed number is the primary physical locator for finding a patient; it is currently
invisible in the default theme. `nameColor`, `hnColor`, `settingsColor` and `vitalTextColor`
have the same defect and silently fall back to inherited colour.

Fix: these must be either real CSS values (`var(--…)`) applied via `style`, or class names
applied via `class`. Not crossed over.

## B. Status colours used as small text

`#eab308` warning text measures **1.74:1**; `#22c55e` **2.06:1**; `#f97316` **2.68:1**.
DESIGN.md already anticipated this and created `--status-*-text` for it — but the call sites
don't use those tokens, **and the tokens themselves fail** because they were tuned only against
`--bg-card` (#ffffff), while being used on the page background (#f0f4f8).

Retune to clear 4.5:1 on the **worst** light surface, not the best:

| Token | Current | worst | → New | worst |
|---|---|---|---|---|
| `--status-critical-text` | `#dc2626` | 4.37 ❌ | **`#c81e1e`** | 5.19 ✅ |
| `--status-warning-text` | `#a16207` | 4.45 ❌ | **`#946005`** | 4.83 ✅ |
| `--status-success-text` | `#15803d` | 4.54 ⚠ | **`#137a39`** | 4.91 ✅ |
| priority-high as text | `#a855f7` | 3.58 ❌ | **`#9333ea`** | 4.87 ✅ |

## C. The accent blue fails as a button fill

White on `--accent-primary` `#3b82f6` = **3.68:1**. This is the primary CTA across the product.

Do **not** change `--accent-primary` — it is correct for borders, focus rings, icons and chart
lines, where 3:1 applies. Add a text-safe companion, preserving the One Accent Rule:

```css
:root                { --accent-primary-strong: #2563eb; }  /* white on it = 5.17 */
[data-theme="dark"]  { --accent-primary-strong: #58a6ff; }
```

## D. Dark theme: `color: white` on a light fill

Dark accents are *light* (`#58a6ff`, `#bc8cff`), so white text on them measures **2.32-2.53:1**.
`--text-inverse` already exists and already holds the right value in both themes
(`#ffffff` light, `#0d1117` dark). The call sites simply hardcode `color: white`.

Replacing hardcoded `white`/`#fff` on accent fills with `var(--text-inverse)` fixes both themes
at once: light 5.17:1, dark **7.49:1**.

## E. Individually severe

- `/devices-mgmt` "Scan QR" — **1:1**, white on white. Invisible.
- `/alert-settings` "WARNING" rendered at **9.3px** — below the 10px product floor.
- `"NurseAid AI Assistant"` launcher label — **1.11:1** in light.

## Revised slice order

Priority changed once measured. Contrast and the class-name defect ship broken **today**;
the dark-override block, though ugly, works.

1. **Slice A — defect + contrast fixes** (A, B, C, D, E above). Urgent, bounded, safety-relevant.
2. **Slice B** — type ramp + radius consolidation (was Slice 1).
3. **Slice C** — monitor-card information design (bed/name/HN truncation, triple-encoded
   priority, native `<select>` in every card, purple ring out-shouting the red alert dot).
4. **Slice D** — icon system, 124 emoji → drawn SVG.
5. **Slice E** — colour architecture / removing the `!important` override block. Lowest urgency.
