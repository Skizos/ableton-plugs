# Gross Warp — design notes

- **History:** built 2026-10-20 from a screenshot of the Gross Warp device ("plan and create this for me using Max for
  Live on Ableton"); the same day pitch lock, MIDI-triggered patterns, 2- and 4-bar patterns, any time signature and the
  download zip were added. First developed in Skizos/QuantativeC (pull request 5), then moved here. 2026-10-22: it
  runs in Live (owner's report); the panel was redesigned after the original picture, with features from Gross Beat
  and the original's manual (Hold, sound swing, one-shot MIDI, Dice/Mutate/Evolve, Flip, a categorized preset library
  with combos, Live theme colors) — plan and sources in [ui-redesign.md](ui-redesign.md).
- **How it is checked:** the DSP, the editor and the devices' Max-object logic are tested headless (node, no network,
  no Max): the gen~ code runs in a small GenExpr simulator, the jsui script against stubs of Max's `mgraphics`/`Buffer`,
  and the built patchers' cords in a message-level simulator. The devices have not been loaded in Max or Live by these
  tests; the first load in Live is the real check (see "Not verified here").

## Why

Gross Beat's idea: two envelopes drawn over a bar and locked to the song. The **time** envelope says how far behind
"now" the audio plays (top = live, lower = later), so its slope is a playback speed: flat = normal, a 45° fall = a
stop, steeper = reverse, a staircase = repeats/rolls. The **volume** envelope gates. Eight patterns, switchable in time.

## What

| Area | Behaviour |
|---|---|
| Time envelope | Offset = u × Depth × pattern length, u ∈ [0, 1] (0 = top). Flat = delay, slope 1 = stopped, steeper = reverse, steps = repeats. Up to 128 points, per-segment curve. |
| Volume envelope | Gain = 1 − u × Depth. |
| Patterns | 8, each with a time and a volume envelope. `Pattern` (pads 1–8; a hidden live.tab, automatable) selects; Alt-click a pad copies the shown pattern into it. `Switch` quantizes the change: Now / 1/16 / Beat / Bar / Pattern end, with a 40 ms catch-up window after each grid line. |
| Hold | Loops the device's own output: *Last* replays the last 1/16 … 1 bar (copied from an output ring while it plays), *Next* records the next one and loops it. Raised-cosine fade at the loop seam; the hold fades in/out over Smooth. Released when the transport stops. |
| Swing | 0–75 %: the song position is warped before the envelopes read it, so every second grid step of both envelopes starts later (the editor sends its grid step as `swunit`, in quarter notes). Switching stays on the straight grid. |
| Length | 1 beat, 2 beats, 1, 2 or 4 bars, in the song's time signature (beats = quarter notes, as Live's song time). |
| Sync | `[phasor~ 4n @lock 1]` gives the beat phase (its slope gives the tempo); gen~ counts beats and re-syncs the count from the Live API's `current_song_time` (nearest whole beat to position − phase, so a late value is harmless); `signature_numerator/denominator` give the bar. Transport stopped ⇒ pass-through. |
| Smooth | Jumps in the time envelope cross-fade (raised cosine, gains sum to 1) between the old and the new read head over Smooth ms; the volume envelope is slewed by the same time. No clicks at steps. |
| Pitch Lock, Grain | Two grains (sin² windows, half a grain apart) play at normal speed from the time envelope's position — backwards where it reverses; on jumps both restart in step with the new position. |
| MIDI | Companion MIDI effect *Gross Warp MIDI* (native Max objects only — `js` would defer to the low-priority thread): notes Base…Base+7 → patterns 1–8, Hold, Latch or One-shot (plays one pattern length, then Pattern rules again — Gross Beat's one-shot slots), sent on link A–D; the effect's *MIDI* menu picks the link (`[switch 4]`). Events are `trigon`/`trigoff` = pattern + 8 × parity + 16 × mode; gen~ applies the mode. |
| Depth, Dry/Wet | Scale both envelopes; dry/wet mix. At "Normal" the wet signal equals the dry one, sample for sample. |
| Panel (jsui, 380 × 157) | Laid out as the original picture: the display (waveform of the input and output, playhead, the edited envelope with points and curve handles, the other one ghosted with its preset name top right, beat and bar lines, Gross Beat's stop/reverse guide lines in the time view), then `[Time][Volume] [◂ preset ▾ ▸] [point][draw][dice][flip][copy][paste]` and `[1…8] [Switch] [◂ Hold ▸] [Swing] [undo][grid][settings]`. Popovers drawn in the jsui: preset browser (categories + combos), Switch menu, grid (snap 1/4…1/32 + triplets, Length), settings (Hold mode, Grain, MIDI link, Evolve). Dice rolls a pattern from musical building blocks on the grid (seeded generator), Shift = mutate one envelope; Evolve mutates the playing pattern every beat … 4 bars. |
| Right column | Native, theme-following: Pitch Lock (`live.text` toggle), Smooth, Depth, Dry/Wet (`live.dial`). |
| Panel parameters | Pattern, Switch, Length, Hold, Hold Length, Hold Mode, Swing, Grain and MIDI Link are hidden `live.*` objects: the panel sends `<name> <value>` → `[route]` → the parameter (automation, undo, Push banks) → `[prepend <name>]` → gen~ and back to the panel, which only shows what the parameter answers. |
| Theme | `[live.colors]` dumps every theme color (`everything`, at load and on its theme-changed bang) into the jsui as `<id> r g b a`; `max.getcolor("live_<id>")` is tried where the js engine has it; else a built-in dark palette. Names used are the ones seen in Ableton's devices where possible (lcd_bg, control_bg, control_selection, display_handle_two, display_scale_text, lcd_control_fg_zombie). `live.thisdevice`'s middle outlet dims the panel when the device is off. Font: Ableton Sans Medium. |
| State | The editor's data is a jsui blob parameter (Stored Only), saved with the Live set; Live is notified on discrete edits only (mouse-up), never during drags or playback (so Evolve's changes are saved at the next edit). Blob version 2 holds edit/tool/grid/evolve + 8 × 2 envelopes with their preset numbers; version 1 blobs (first release: swing in the header, older preset numbering) load, their preset numbers mapped by name. |
| Info View | Every control has an info text. |
| Download | `dist/GrossWarp.zip` (stored, fixed date, byte-reproducible) with the folder `Gross Warp/`: both devices, `gw_ui.js`, `INSTALL.txt`. |

## Design

```
plugin~ L,R ──► gen~ (gross_warp.genexpr) ──► plugout~
phasor~ 4n @lock 1 ──► gen~ in3            ├─ out3 pattern phase ─► snapshot~ ─► jsui (playhead, redraw)
live.thisdevice ─► live.path live_set ─► live.observer ×3 ─► gen~ (songbeats, signum, sigden), jsui (meter)
jsui ─► route ─► hidden live.* params ─┐  └─ out4 active pattern ─► snapshot~ ─► jsui
live.text/dials (right column) ─────────┴─► prepend ─► gen~ (and the panel's params back to the jsui)
live.colors ─► jsui ◄─ prepend enabled ◄─ live.thisdevice (middle outlet)
r grosswarp_A..D ─► switch 4 (MIDI menu) ─► gen~ (trigon, trigoff)
jsui ──writes──► buffer~ ---gwenv  ◄──reads── gen~      gen~ ──writes──► buffer~ ---gwpeaks ◄──reads── jsui
```

- `---` names make the two buffers private to each device instance; the substituted names reach gen~ and the jsui by
  `[t ---x] → [prepend …]` at load (object-box substitution, the documented case; Max has no `[symbol]`). The MIDI links use global
  names on purpose, to connect devices.
- **Envelope buffer** (1 channel, 16 blocks × 385 frames): block = pattern × 2 + env; frame 0 = point count, then
  (x, u, curve) triples. The jsui writes points first and the count last. gen~ evaluates the breakpoints exactly per
  sample (cached segment index, bounded advance loop), so steps stay steps and ramps stay smooth.
- **Curve:** `f(t) = t^(1+3c)` for c ≥ 0, `1 − (1−t)^(1+3|c|)` for c < 0 — c = 1/3 is exactly a linear speed ramp
  (tape stop), c = −1/3 its mirror (tape start). The same formula in gen~ and in the jsui (a test checks they agree).
- **Ring buffer** 2²¹ frames × 2 (≈ 44 s at 48 kHz); offsets are clamped to half of it, so a grain's distance behind
  the write head is never ambiguous. Reads use 4-point Hermite, linear within 1 sample of "now".
- **gen~ rules followed** (from Cycling '74 forum findings, docs host not reachable here): `peek` always assigned on its
  own line; no `break`/`+=`; loop exit in the `for` condition; every variable initialised at top level before any block;
  History read at the top and written at the end; no names that are gen operators. A lint test enforces these.
- **Live API wiring** follows Ableton's CPU Reporter device: `path live_set` → `live.path` → `[t b l]` → id into the
  observer's right inlet, then `property …` into its left; the observer outputs the bare value (CPU Reporter feeds it
  straight into `[t b f]`), so `[prepend songbeats]` makes the Param message.

## Files

| Path | Role |
|---|---|
| `src/gross_warp.genexpr` | gen~ DSP (embedded into the device's gen~ codebox at build) |
| `src/gw_ui.js` | jsui editor/display (ES5; ships next to the device) |
| `src/INSTALL.txt` | install notes, packed into the zip |
| `tools/build.js` | builds both patchers, the `.amxd` containers and the zip into `dist/` |
| `tools/gensim.js` | GenExpr-subset simulator used by the tests |
| `tools/maxsim.js` | Max-message simulator (trigger, unpack, gate, switch, split, counter, route, arithmetic, prepend, send/receive, message boxes) |
| `tools/preview.js` | renders `docs/preview.svg`: the real editor painting, the simulated DSP's waveform, mocked Live controls |
| `test/*.test.js` | DSP, editor, patcher/MIDI-chain and lint tests (`node --test`; 101 tests, ~3 min) |
| `README.md` | download, install, use, troubleshooting |
| `../.github/workflows/ci.yml` | runs the Node tests for every device (no Max, no network) |
| `../.gitattributes` | `*.amxd`, `*.zip` binary |

`.amxd` format: chunks `ampf`(4)=`aaaa`/`mmmm`, `meta`(4)=0, `ptch`(n)=patcher JSON + NUL — as parsed by Ableton's own
`maxdevtools/maxdiff/amxd_textconv.py` (commit 5b39dec9a203d2747ff1d08e10c849742a4e654a), which reads both built files
("Audio Effect Device", "MIDI Effect Device").

## Tests

- DSP (simulated gen~ fed by the real jsui writing the envelope buffer): Normal = bit-exact pass-through; constant
  offset = exact delay; Half Time halves the speed; Reverse ½ plays backwards; 1/16 Roll repeats the slice; Tape Stop's
  speed falls linearly; gates; stopped transport = pass-through; Depth 0; every Switch grid incl. 2- and 4-bar
  patterns and the catch-up window; 3/4, 6/8, 7/8 bars; a late song position puts the pattern in the right bar;
  pitch lock keeps a 480 Hz tone at 480 Hz under Half Time, Reverse and Tape Stop (and grains run backwards when
  reversing), passes Normal through, and toggling it or rolling under it does not click; MIDI hold/latch semantics and
  grid timing; one-shot; swing timing; Hold Last/Next loop what they should, without clicks, and let go when the
  transport stops; steps do not click; peaks; gen~ and editor evaluate envelopes identically.
- Editor: presets (valid, in categories, combos, names mean what they say), blob round-trip and version 1 blobs,
  buffer layout, channel-base detection, mouse editing, draw tool, flip, undo/redo, copy/paste across devices, the
  panel's layout (picture order, inside the jsui, no overlaps, rows span the width), pads (play via the parameter,
  Alt-copy), every popover and control's message, popover closing, swing step per grid, dice validity on every grid
  and length (repeatable from a seed) and mutate, Evolve (playing pattern only, no undo/notify), theme colors
  (live.colors, max.getcolor, fallback), dimming, 4-bar and 7/8 grids, paint with real mgraphics calls only.
- Devices: containers, every cord on both devices and in gen~, message names vs gen~ Params and jsui functions,
  buffer sizes and load order, the Live API chain, the MIDI device's note logic (parity, base note, range, links,
  thru), the effect's link switch, a note → pattern end-to-end through both patchers into the simulated gen~,
  parameters and banks, info texts, layout, the zip (contents, CRCs) and `dist/` being current; panel → route →
  hidden parameter → gen~ and back for every panel parameter; the right column; theme and on/off wiring; one-shot
  mode from the MIDI device to gen~.
- Lint: the gen~ rules above; the jsui uses ES5 only (also parsed with acorn `--ecma5` once).

## First load in Live (2026-10-22)

The first build loaded in Live and Max's console showed two errors, both fixed:
- `symbol: No such object` (twice): the buffer names were handed on with `[symbol ---x]`, a Pure Data object that Max
  doesn't have, so gen~ and the editor never got their buffers. Now `[t ---x]`; a test checks every box against
  Ableton's list of Max objects, and another that the names reach gen~ and the editor at load.
- "a project without a name is like a day without sunshine. fatal.": the patcher had no `project` section; it now
  carries the same one as Ableton's devices (a test checks it and its `amxdtype`).

The redesigned panel's first load (same day) showed a blank white editor: formatting the script had added trailing
commas in function calls (ES2017), so Max's JavaScript engine rejected the whole file. Removed (the script parses as
ES5 and ES3 with acorn), and a lint rule now fails on any trailing comma; it fails on that build.

## Not verified here

Confirmed by the owner's first load (2026-10-22: "it works"): the devices load, gen~ compiles the codebox and
retargets `Buffer gwenv`, the editor reaches gen~. Still open:

1. jsui `parameter_enable` blob persistence through `getvalueof`/`setvalueof` (save, close, reopen a set).
2. `midiparse` reports note-offs as velocity 0 (the MIDI device's on/off split relies on it).
3. The redesign: the new gen~ code compiles (Hold's `Data` buffers, swing); `[live.colors]`'s `everything` output
   arrives as `<id> r g b a` with the ids the panel asks for; the font name `Ableton Sans Medium`; a `live.text`
   without `mode` is a toggle (as in CPU Reporter); a second parameter bank shows on Push; values the panel sends
   to the hidden parameters are recorded as automation like a turned knob.

If one fails, Max's console names the object; the README has a troubleshooting section.

## Limits (kept)

- A time-signature change mid-song: bars are counted from the song's start in the current meter.
- Pitch lock is a two-grain stretcher (the classic character), not a phase vocoder.
- The download is the unfrozen device plus its script (freezing makes one file; writing Max's frozen format by hand
  would risk an unloadable device).
