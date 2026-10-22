# UI redesign and Gross Beat features — plan (2026-10-22)

The owner: "It works, now design the UI from the original picture. Also search up Gross Beat for FL Studio and use the
information you get to keep shaping the plugin. Search up designs and reference for the UI too."

## Research (sources; the vendors' sites were blocked here, so these come from search summaries)

**The original in the picture** is *Gross Warp* by ELXR, a commercial Max for Live device
([manual](https://elxr.net/manuals/gross-warp/), [maxforlive.com](https://maxforlive.com/library/device/16785/gross-warp)).
What its manual says about the controls in the picture:
- Eight patterns, each with its own Time and Volume; Option/Alt-click a pad copies the current pattern into it.
- Switch: Now, Beat or Bar.
- **Hold**: "Hold Last" loops what just played, "Hold Next" records what comes next and loops it, 1/16 to a bar.
- **Dice / Evolve**: roll a new musical pattern, mutate the playing one, or let Evolve change it every beat to 4 bars.
- Grid (# icon): snap 1/4–1/32 + triplets, and the pattern Length (1/4 bar to 4 bars).
- **Swing pushes the off-beats of both envelopes later** (a sound control, not just the editor grid).
- Presets: combos, then Time and Volume folders that load independently.
- Keep Pitch (granular) vs the classic tape pitch drop; Smooth, Depth, Dry/Wet.

**Gross Beat** (Image-Line; [manual](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/plugins/Gross%20Beat.htm),
[envelopes](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/plugins/GrossBeat_EnvelopePanel.htm),
[time settings](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/plugins/GrossBeat_TimeSettings.htm)):
- A 2-bar rolling buffer; the Time envelope is a sample offset ("realtime audio + offset define the playback position,
  direction and speed"); the editor shows **reverse guide lines** ("slopes steeper than this line will play fast
  reverse, shallower will be slow reverse").
- 36 time + 36 volume slots; slot 1 is empty ("off").
- MIDI: slots can be **key-held**, **one-shot** ("plays once and then Gross Beat will jump back to Slot 1") or held.
- Volume envelope smoothing (attack 0–100 ms); dip the volume around a time jump to avoid clicks.

**Device design** — Ableton's own [Max for Live production guidelines](https://github.com/Ableton/maxdevtools/blob/5b39dec9a203d2747ff1d08e10c849742a4e654a/m4l-production-guidelines/m4l-production-guidelines.md):
- Follow Live's color themes: `live.*` objects do by default; custom drawing gets theme colors from `[live.colors]`
  (`everything` → one message per color: id + RGBA 0–1; e.g. `lcd_bg`, `control_selection`). JavaScript can also read
  them with `max.getcolor("live_lcd_bg")` (documented for v8; tried here with a fallback).
- Use **Ableton Sans** (included with Max). Keep the device narrow, equal left/right margins. Show the disabled state
  (`live.thisdevice` outlet 1 = device on/off).
- `live.text` toggle: `mode` 1 (0 = button).

## Design (from the picture)

```
┌───────────────────────────── display (waveform · envelope · playhead) ──────────────┐ ┌ Pitch 🔒 ┐
│                                                                        Normal       │ │ Smooth   │
│                                                                                     │ │  (dial)  │
└─────────────────────────────────────────────────────────────────────────────────────┘ │ Depth    │
[Time][Volume] [⊞] [◂ 1/16 Roll ▾ ▸] [↗ point][▮▮ draw][⚄ dice][⇕ flip][⧉ copy][⎘ paste] │  (dial)  │
[1][2][3][4][5][6][7][8]  Switch Beat  [◂ Hold 1/4 ▸]  Swing 0   [↶][#][⚙]              │ Dry/Wet  │
                                                                                         └──────────┘
```
- Device ≈ 400 × 169 (was 540): the jsui draws the left panel (display + two rows); the right column is native
  `live.text` (Pitch, toggle with a lock icon) and three `live.dial`s, theme-following.
- Every control the jsui draws that is a Live parameter (Pattern, Switch, Length, Hold, Hold length, Hold mode, Swing,
  Grain, MIDI link) stays a hidden `live.*` parameter object: the jsui sends it the new value (so Live records
  automation and undo), the object passes it to gen~ and back to the jsui. Automation and saving work as before.
- Popovers drawn by the jsui: preset browser (categories), Switch menu, Grid (snap + Length), Settings (Hold mode,
  Grain, MIDI link, Evolve).
- Pattern pads: click = play/edit, Alt-click = copy the current pattern there. Selected pad in the accent color.
- Display: the other envelope's preset name top right (the picture's "Normal"); Gross Beat's stop and reverse guide
  lines in the time view; the playing pattern if it differs.
- Theme colors from `max.getcolor` / `[live.colors]` with the current palette as fallback; dimmed when the device is
  off; Ableton Sans Medium.

## DSP additions

- **Swing** (0–75 %): warps the pattern phase so every second grid step starts later, on the editor's grid (the jsui
  sends gen~ the step as `swunit`, in quarter notes). Switching stays on the straight grid.
- **Hold** (toggle, 1/16 … 1 bar, Last/Next): loops the device's own wet output. Last plays the last N from an output
  ring while copying it to a loop buffer; Next records the next N, then loops. Short fades at the loop seam, and the
  hold fades in/out over Smooth.
- **One-shot** MIDI mode (Gross Beat): the triggered pattern plays one pattern length, then the Pattern parameter
  takes over again. Gross Warp MIDI's Mode: Hold / Latch / One-shot.

## Editor additions

- Presets in categories, generated from building blocks (stutter, half, stop, reverse, scratch, chop, glitch, build,
  tape, pitch; gate, pump, trance, stutter, rhythm, triplet, fade, cut, shape), plus combos.
- Dice (new pattern), Mutate (Shift-click Dice), Evolve (every beat / bar / 2 / 4 bars, from the settings).
- Flip (invert the edited envelope vertically).
- Blob version 2 (adds evolve; swing moves to a parameter). Version 1 blobs still load.

## Tests to add
DSP: swing timing, Hold Last/Next loops (time code), seam without clicks, one-shot. Editor: the new layout's hit
regions, pads (click, Alt-copy), popovers, dice validity and determinism with a seeded generator, flip, v1 blob loads,
theme colors applied and missing colors harmless, disabled state. Device: hidden parameters wired jsui → param → gen~
and → jsui, no presentation overlaps, every object real.

## Naming

ELXR sells a device called *Gross Warp*. This device has the same name; worth renaming before sharing it widely (the
owner decides).
