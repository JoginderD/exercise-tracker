---
version: alpha
name: Tape & Cream
description: Visual system for Exercise Tracker, where people in rehab record exercise sessions and questions at home and their coach reviews and replies later.

colors:
  # Action: kinesiology-tape coral. Reserved for the one thing you can do now.
  primary: "#ff8b66"
  primary-hover: "#ffa184"
  primary-edge: "#e46d48"
  on-primary: "#2d2016"
  highlight: "#ffd9c7"

  # Grounds and ink (light)
  neutral: "#fff8ef"
  surface: "#fffcf7"
  surface-sunk: "#f6ebdc"
  border: "#eee2d2"
  border-strong: "#dccbb5"
  on-surface: "#2d2620"
  on-surface-muted: "#77685a"
  link: "#a8431f"
  link-hover: "#7d2e12"

  # Done: the loop is closed (answered, reviewed, within range)
  go: "#86dfb3"
  go-hover: "#6dd3a1"
  go-edge: "#45b07c"
  go-soft: "#edfaf3"
  go-text: "#157a55"

  # Stop: end a recording, safety danger, errors
  stop: "#ff9aa3"
  stop-hover: "#ff7f8b"
  stop-edge: "#e35a68"
  stop-soft: "#ffdadd"
  error: "#a3243a"

  # Waiting: the other person's move
  waiting: "#ffeea6"
  waiting-soft: "#fff7d6"
  waiting-edge: "#f2b705"
  waiting-text: "#8f5f00"

  # Attention: your move, and someone is waiting on you
  attention-soft: "#ffeadf"
  attention-edge: "#ffa77d"
  attention-text: "#a3401b"

  # Orientation: where you are, notices about your account
  orient: "#e4dcff"
  orient-edge: "#c7b8fb"

  # Over the camera picture (same in both modes)
  hud: "#261f1a"
  on-hud: "#fff8ef"
  on-hud-muted: "#dccdbd"
  lane-left: "#0fb5d4"
  lane-right: "#ec5c9e"

  # Dark mode grounds and ink. Action, go, stop and HUD fills do not change.
  dark-neutral: "#1b1612"
  dark-surface: "#251f1a"
  dark-surface-raised: "#2e2620"
  dark-surface-sunk: "#14100d"
  dark-border: "#3d332b"
  dark-border-strong: "#54473c"
  dark-on-surface: "#f5ebde"
  dark-on-surface-muted: "#bfae9c"
  dark-link: "#ffa184"
  dark-link-hover: "#ffc3ae"
  dark-highlight: "#5c3322"
  dark-go-soft: "#1e3b2e"
  dark-go-text: "#a9ecc9"
  dark-stop-soft: "#47202a"
  dark-error: "#ffb3bb"
  dark-waiting-soft: "#3a3115"
  dark-waiting-text: "#ffe08a"
  dark-attention-soft: "#42261a"
  dark-attention-text: "#ffb497"
  dark-orient: "#2f2a45"
  dark-on-orient: "#d9cfff"

typography:
  display:
    fontFamily: Bricolage Grotesque
    fontSize: 44px
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: -0.025em
    fontVariation: "'opsz' 96"
  headline-lg:
    fontFamily: Bricolage Grotesque
    fontSize: 28px
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: -0.015em
  headline-md:
    fontFamily: Bricolage Grotesque
    fontSize: 20px
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: -0.01em
  button-hero:
    fontFamily: Bricolage Grotesque
    fontSize: 22px
    fontWeight: 800
    lineHeight: 1
    letterSpacing: 0.01em
  hud-count:
    fontFamily: Bricolage Grotesque
    fontSize: 48px
    fontWeight: 800
    lineHeight: 1
    letterSpacing: -0.02em
    fontFeature: "'tnum' 1"
  body-lg:
    fontFamily: Figtree
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.6
  body-md:
    fontFamily: Figtree
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.55
  body-sm:
    fontFamily: Figtree
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.45
  label-md:
    fontFamily: Figtree
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.2
  label-sm:
    fontFamily: Figtree
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.3
  label-caps:
    fontFamily: Figtree
    fontSize: 12px
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: 0.08em
  data:
    fontFamily: Figtree
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.4
    fontFeature: "'tnum' 1"
  code:
    fontFamily: ui-monospace
    fontSize: 26px
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: 0.08em

rounded:
  sm: 10px
  md: 14px
  lg: 20px
  full: 9999px

spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 20px
  2xl: 32px
  3xl: 48px
  page-max: 1120px
  gutter: 16px
  measure: 68ch

components:
  # ---------- Light ----------
  page:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.lg}"
    padding: "{spacing.xl}"
  card-heading:
    backgroundColor: "{colors.highlight}"
    textColor: "{colors.on-surface}"
    typography: "{typography.headline-md}"
  sunk:
    backgroundColor: "{colors.surface-sunk}"
    textColor: "{colors.on-surface}"
    typography: "{typography.label-caps}"
  divider:
    backgroundColor: "{colors.border}"
    height: 1px
  divider-strong:
    backgroundColor: "{colors.border-strong}"
    height: 1px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
    padding: "{spacing.md}"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
  button-primary-border:
    backgroundColor: "{colors.primary-edge}"
    height: 1px
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm}"
  button-secondary-hover:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.on-surface}"
  toggle-selected:
    backgroundColor: "{colors.on-surface}"
    textColor: "{colors.neutral}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
  button-start:
    backgroundColor: "{colors.go}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button-hero}"
    rounded: "{rounded.full}"
    height: 60px
  button-start-hover:
    backgroundColor: "{colors.go-hover}"
    textColor: "{colors.on-primary}"
  button-start-border:
    backgroundColor: "{colors.go-edge}"
    height: 1px
  button-stop:
    backgroundColor: "{colors.stop}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button-hero}"
    rounded: "{rounded.full}"
    height: 60px
  button-stop-hover:
    backgroundColor: "{colors.stop-hover}"
    textColor: "{colors.on-primary}"
  button-stop-border:
    backgroundColor: "{colors.stop-edge}"
    height: 1px
  link:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.link}"
    typography: "{typography.label-md}"
  link-hover:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.link-hover}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm}"
  input-placeholder:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface-muted}"
  input-error:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.error}"
    typography: "{typography.body-sm}"
  error-banner:
    backgroundColor: "{colors.stop-soft}"
    textColor: "{colors.error}"
    rounded: "{rounded.sm}"
    padding: "{spacing.md}"
  coach-reply:
    backgroundColor: "{colors.go-soft}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-lg}"
    rounded: "{rounded.sm}"
    padding: "{spacing.md}"
  status-done:
    backgroundColor: "{colors.go-soft}"
    textColor: "{colors.go-text}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
  status-waiting:
    backgroundColor: "{colors.waiting-soft}"
    textColor: "{colors.waiting-text}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
  waiting-rule:
    backgroundColor: "{colors.waiting-edge}"
    width: 3px
  status-attention:
    backgroundColor: "{colors.attention-soft}"
    textColor: "{colors.attention-text}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
  attention-rule:
    backgroundColor: "{colors.attention-edge}"
    width: 3px
  eyebrow:
    backgroundColor: "{colors.waiting}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-caps}"
    rounded: "{rounded.full}"
  coach-code:
    backgroundColor: "{colors.waiting-soft}"
    textColor: "{colors.on-surface}"
    typography: "{typography.code}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  safety-caution:
    backgroundColor: "{colors.waiting}"
    textColor: "{colors.on-primary}"
    typography: "{typography.headline-md}"
    rounded: "{rounded.lg}"
  safety-danger:
    backgroundColor: "{colors.stop-soft}"
    textColor: "{colors.on-primary}"
    typography: "{typography.headline-md}"
    rounded: "{rounded.lg}"
  nav-current:
    backgroundColor: "{colors.orient}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
  notice:
    backgroundColor: "{colors.orient}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
  notice-edge:
    backgroundColor: "{colors.orient-edge}"
    height: 1px
  hud-panel:
    backgroundColor: "{colors.hud}"
    textColor: "{colors.on-hud}"
    typography: "{typography.hud-count}"
    rounded: "{rounded.md}"
  hud-detail:
    backgroundColor: "{colors.hud}"
    textColor: "{colors.on-hud-muted}"
    typography: "{typography.body-sm}"
  lane-left-chip:
    backgroundColor: "{colors.lane-left}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
  lane-right-chip:
    backgroundColor: "{colors.lane-right}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
  data-table:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.data}"
  headline:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.on-surface}"
    typography: "{typography.display}"
  section-title:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.headline-lg}"

  # ---------- Dark ----------
  page-dark:
    backgroundColor: "{colors.dark-neutral}"
    textColor: "{colors.dark-on-surface}"
    typography: "{typography.body-md}"
  page-dark-muted:
    backgroundColor: "{colors.dark-neutral}"
    textColor: "{colors.dark-on-surface-muted}"
  card-dark:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-on-surface}"
    rounded: "{rounded.lg}"
    padding: "{spacing.xl}"
  card-heading-dark:
    backgroundColor: "{colors.dark-highlight}"
    textColor: "{colors.dark-on-surface}"
    typography: "{typography.headline-md}"
  sunk-dark:
    backgroundColor: "{colors.dark-surface-sunk}"
    textColor: "{colors.dark-on-surface}"
    typography: "{typography.label-caps}"
  divider-dark:
    backgroundColor: "{colors.dark-border}"
    height: 1px
  divider-strong-dark:
    backgroundColor: "{colors.dark-border-strong}"
    height: 1px
  button-secondary-dark:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-on-surface}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
  button-secondary-hover-dark:
    backgroundColor: "{colors.dark-surface-raised}"
    textColor: "{colors.dark-on-surface}"
  link-dark:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-link}"
  link-hover-dark:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-link-hover}"
  input-dark:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-on-surface}"
    typography: "{typography.body-md}"
    rounded: "{rounded.sm}"
  input-placeholder-dark:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-on-surface-muted}"
  input-error-dark:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-error}"
  error-banner-dark:
    backgroundColor: "{colors.dark-stop-soft}"
    textColor: "{colors.dark-error}"
    rounded: "{rounded.sm}"
  coach-reply-dark:
    backgroundColor: "{colors.dark-go-soft}"
    textColor: "{colors.dark-on-surface}"
    typography: "{typography.body-lg}"
    rounded: "{rounded.sm}"
  status-done-dark:
    backgroundColor: "{colors.dark-go-soft}"
    textColor: "{colors.dark-go-text}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
  status-waiting-dark:
    backgroundColor: "{colors.dark-waiting-soft}"
    textColor: "{colors.dark-waiting-text}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
  status-attention-dark:
    backgroundColor: "{colors.dark-attention-soft}"
    textColor: "{colors.dark-attention-text}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
  nav-current-dark:
    backgroundColor: "{colors.dark-orient}"
    textColor: "{colors.dark-on-orient}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
---

# Tape & Cream

## Overview

Exercise Tracker is used by two people who are rarely online at the same moment. A **patient** does their rehab at home, often on a phone propped against a wall, sometimes in pain or tired, and records sessions and questions. Hours later, their **coach** opens a roster on a laptop, reviews what came in and replies. Every screen has to work for whichever of them is looking, and say clearly **whose move it is**.

The direction is a warm, encouraging home-exercise notebook: a cream page, ink that is brown rather than black, and soft pastel fills, each with **one job**. It is friendly on purpose. Rehab is slow, repetitive and discouraging, and the interface's job is to make the next session feel easy to start. The system is **flat**: no shadows anywhere. Pastel buttons are outlined in a darker shade of their own colour instead.

**What it gives up:** clinical gravitas and density. This does not look like hospital software, and coach screens are roomier than a power user would choose. In exchange, a patient who is 70, hurting and holding a dumbbell can still read the screen from two metres away and hit the right button.

## Colors

The palette is organised around one idea: **colour says whose move it is.** In an async product, the most important thing on any screen is whether the patient is waiting for the coach, the coach owes the patient a reply, or the loop is closed. Each pastel role answers exactly one of those questions, in both modes.

- **Kinesiology-tape coral (`primary`):** the salmon-orange of physio tape, the most recognisable object in a rehab clinic. It is the **only** colour for "you can do this now": the main button on a screen and the highlighter behind card headings (`highlight`, a lighter tint of the same tape). Never use it for status. A chosen option (exercise toggle, theme switch) is ink, not coral, so coral stays rare.
- **Brown ink on cream (`on-surface` on `neutral`):** the page is warm cream like an exercise sheet a physio prints out. Cards (`surface`) are a sheet of paper laid on it, a touch lighter. `surface-sunk` is the recessed tone for table headers and tab tracks. Links are a deep coral-brown (`link`).
- **Mint (`go`):** the loop is closed. A coach reply, a reviewed session, a rep within range, a saved plan. It is also the **Start** button.
- **Butter (`waiting`):** waiting on the other person. A patient's unanswered question, as the patient sees it ("Sent"). The live "hold still, measuring" state. A caution-level safety alert. Butter is calm: nothing is wrong, something is pending.
- **Apricot (`attention`):** someone is waiting on **you**. The same unanswered question in the coach's inbox gets a 3px apricot rule and a "High priority" badge. Roster reasons ("needs a look") and out-of-range warnings also use it.
- **Rose (`stop`):** stop and danger. The Stop button, a danger-level safety alert, and error messages (`error` is the deep rose for text).
- **Lavender (`orient`):** where you are. The current nav item and account notices. It never carries meaning about progress.
- **HUD and lanes:** anything drawn over the camera picture uses the dark translucent `hud`, so it reads on any video. The left and right limb lines are `lane-left` cyan and `lane-right` magenta, the two hues furthest from every pastel role.

**Dark mode** is for the evening session in a dim living room. The grounds become a warm near-black (`dark-neutral`) and text becomes cream (`dark-on-surface`). **The coral action, mint Start, rose Stop, HUD and safety alerts stay exactly the same in both modes**: pastel buttons with dark ink read even better on a dark ground. Status tints become deep, low-chroma versions of their hue, with a light text tone of the same hue.

## Typography

There are three families, each with a fixed job:

- **Bricolage Grotesque** (open source, Google Fonts) is the voice: page titles, card headings, the big Start/Stop labels and the rep counter on the HUD. It is used **only at 800**.
- **Figtree** (open source, Google Fonts) is the apparatus: body text, buttons, labels and tables, used **only at 400 and 700**.
- **`ui-monospace`** is used for the coach code alone: the one string people copy by eye into another device.

Scale: 16px body with a ~1.25 ratio (14, 16, 18, 20, 28), plus a hand-set display size (44px, clamped to 30px on phones). Anything a patient must read during or right after an exercise is at least 16px. 12px uppercase (+0.08em) is only for eyebrows and table headers. Coach replies and questions use `body-lg` (18px, 1.6). Changing numbers (reps, angles, table cells) use tabular figures.

## Layout

The page is a single centred column, at most 1120px wide, with a 16px gutter. Cards have 20px of padding, or 16px at 560px wide and below.

- **Patient screens** are one column with big targets, and Start/Stop is full width on phones. One primary action per screen.
- **Coach screens** may use tables and a two-column detail layout. Tables scroll sideways inside their card.
- Long text is capped at 68ch (`measure`).
- Spacing is on a 4px base. With no shadows, **space does the grouping**: 8px within a group and 16–20px between groups.

## Elevation & Depth

**There are no shadows anywhere**: no `box-shadow` on cards, buttons, inputs, dialogs or the safety alert. Depth comes from:

1. **Tone:** cream page → lighter card → sunk header. In dark mode: `dark-neutral` → `dark-surface` → `dark-surface-raised`.
2. **Hairlines:** a 1px `border` on cards and `border-strong` on inputs and secondary buttons.
3. **Own-colour edges:** coral, mint and rose buttons have a 1px border in their darker shade (`primary-edge`, `go-edge`, `stop-edge`), so a pastel fill never dissolves into the cream.

Things over the camera picture separate by being **opaque and framed**. The safety alert has a 4px frame (`waiting-edge` for caution, `stop-edge` for danger). **Pressing** a button moves it down 1px. **Focus** is a 3px solid ink outline, offset 2px. Input focus thickens the border. There's no glow.

## Shapes

Radius gets larger as the object gets larger and more "held":

- `sm` (10px): buttons, inputs, inline notes, coach replies.
- `md` (14px): fieldsets, the coach code, HUD panels.
- `lg` (20px): cards, panels and safety alerts.
- `full`: single thumb-sized decisions and labels, like Start/Stop, status badges, eyebrows, nav links, the theme switch and lane chips.

Status gets 3px left rules: butter for waiting on them, apricot for waiting on you, mint for done. The coach code has a 2px dashed `border-strong` frame, meaning "copy this".

## Components

- **Primary button:** coral, ink text, `primary-edge` border. At most one per view. Disabled buttons drop to 45% opacity.
- **Secondary button:** card-coloured with a `border-strong` frame. Use it for everything else.
- **Selected toggle:** ink fill with cream text, for the chosen exercise and the chosen theme.
- **Start / Stop:** pill-shaped, 60px tall, Bricolage 22px, full width on phones. Start is mint and Stop is rose, each with its darker edge.
- **Status badge:** a pill in one of three async states: `status-done`, `status-waiting` ("Sent") or `status-attention` ("High priority"). **Always include a text label**, never colour alone.
- **Coach reply:** mint-soft block with a 3px mint rule and body-lg text.
- **Card heading:** Bricolage 20px over a coral-tint highlighter stroke, covering the lower 55–92% of the line.
- **Inputs:** card-coloured with a `border-strong` frame. Errors show in `error` text below the field. Placeholders use `on-surface-muted`.
- **Safety alert:** centred over the video, opaque, with a 4px frame. It looks the same in both modes.
- **HUD:** dark translucent pills over video. The "turn to face the camera" banner is a butter pill.
- **Canvas drawing:** limb lines use `lane-left`/`lane-right`, both on the camera picture and on the angle graph. The reference line is dashed `on-hud-muted`, and an out-of-range segment is `attention-edge`. Joints are `waiting-edge` dots with an ink ring. The graph legend shows swatches, not colour names.
- **Theme switch:** an Auto / Light / Dark segmented pill, always in the top bar on every page, signed in or not. The selected segment is ink. Auto follows the device setting live. The choice is saved per device, applies before first paint, and syncs across open tabs.
- **Recording dot:** `stop-hover`, pulsing at 1.2s. It is the only looping animation.
- **Sign in with Google:** follows Google's own button guidelines (white with a `#dadce0` border in light mode, `#131314` in dark mode). It is the one deliberate exception to the palette.

**Motion:** background and border changes take 150ms, and the press takes 50ms. Nothing fades in on load or scroll. `prefers-reduced-motion` removes all transitions.

## Do's and Don'ts

- Do pick a status colour by asking "whose move is it?" Waiting on them → butter. Waiting on you → apricot. Done → mint. If none of these applies, it isn't a status: use ink.
- Do show the same async object in different colours to the two roles: a question is butter for the patient and apricot for the coach.
- Don't use coral for anything but the one action you can take now. If two things on a screen are coral, one of them is wrong.
- Don't add a `box-shadow`, `drop-shadow` or glow anywhere. Separate with tone, a hairline or an own-colour edge.
- Don't convey a state with colour alone. Every badge, alert and rule has a word next to it.
- Don't add a sixth pastel. If something new needs emphasis, use weight, size or a 3px rule in an existing role.
- Don't use Figtree at 500 or 600, or Bricolage below 800.
- Don't put text below 16px on anything the patient reads mid-exercise.
- Don't change the coral action, Start/Stop, HUD or safety alert colours between light and dark mode.
- Don't hardcode hex values in CSS or canvas code. Every colour comes from a token. The Google button is the only exception.
