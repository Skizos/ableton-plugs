# Ableton Plugins — Max for Live devices

## Layout
- One folder per device (`gross-warp/`, …): `src/` (gen~ code, js/jsui scripts, texts), `tools/build.js` (writes the
  patchers, `.amxd` files and the download zip into `dist/`), `test/`, `docs/` (design notes, preview), `README.md`.
- `dist/` is committed: the README download links point at it. Rebuild it with `npm run build` after any change in
  `src/` or `tools/build.js`; a test runs `node tools/build.js --check` and fails when it is stale.

## Commands
- `cd <device> && npm test` — Node ≥ 20, no dependencies, no network, no Max.
- `npm run build` — rebuild `dist/`. `node tools/preview.js` — re-render `docs/preview.svg` (where a device has one).

## Max isn't available here
- Max/Live never run in CI or cloud sessions. Check devices through the simulators (`tools/gensim.js` runs gen~
  codebox text, `tools/maxsim.js` runs the built patchers' cords for message objects, the jsui runs under stubs).
  Never claim a device was loaded in Live unless the user says it was; list what only a real load can confirm.
- docs.cycling74.com and cycling74.com are blocked in cloud sessions. Verified references: Ableton's
  `github.com/Ableton/maxdevtools` (the `.amxd` format in `maxdiff/amxd_textconv.py`; real devices for box JSON,
  `live.path`/`live.observer` wiring in `cpu-reporter/`). Note the commit you read.

## Rules learned the hard way
- **.amxd** = chunks `[tag][u32 LE size][data]`: `ampf`=`aaaa` (audio) / `mmmm` (MIDI) / `iiii` (instrument),
  `meta`=0, `ptch`=patcher JSON + NUL. The patcher needs a `project` section (as in Ableton's devices, `amxdtype` =
  the type letters as a big-endian number), or Max stops with "a project without a name is like a day without
  sunshine. fatal." (seen in Live 2026-10-22). Don't hand-write frozen (`mx@c`) devices; ship the unfrozen device with
  its scripts and tell the user how to freeze.
- **Only real Max objects:** every box is checked against `test/max-objects.json` (Ableton's list). Max has no
  `[symbol]` (that's Pure Data — it gave "symbol: No such object" in Live); a constant word comes from `[t word]`.
- **gen~ codebox:** `peek()` only as the whole right-hand side of an assignment on its own line (inline peek fails
  silently); no `break`/`continue`/`+=`/`++`/`else if`; loops stop through their condition; set every variable at top
  level before any block assigns it; read each History once at the top and write it once at the end; no variable named
  like a gen operator or constant (`wave`, `rate`, `delta`, `e`, `pi`, `mix`, `pass`, …). Passing Buffer/Data into
  functions is unverified, so buffer reads are inlined. A Buffer is retargeted by sending gen~
  `<Buffer name> <buffer~ name>` (works: Gross Warp runs in Live, owner's report 2026-10-22).
- **js / jsui:** ES5 only (Max's engine predates ES6). No trailing commas, above all in calls: a formatter's default
  (Prettier's `--trailing-comma all`) adds them, Max rejects the whole file and the jsui stays blank white (seen in Live
  2026-10-22); format with `--trailing-comma none` and parse with acorn at `ecmaVersion: 5` before shipping. Touch Max
  globals only inside functions so tests can load the file. `Function.immediate` is gone since Max 6: js always runs at low priority, so keep timing-critical paths (MIDI
  triggers, clocks) in native objects.
- **Names:** `---name` makes buffers/sends private to a device instance — substituted in object boxes, so feed the
  names on with `[t ---x] → [prepend …]`. Use plain global names only to link devices on purpose.
- **Parameters:** every `live.*` control gets a long name, a short name and Info View text (`annotation`). Data
  that isn't automatable goes in a jsui blob parameter (`parameter_type` 3, Stored Only) via `getvalueof`/`setvalueof`;
  call `notifyclients()` only on finished edits (mouse-up), never during drags or from playback, or Live's undo
  history floods.
- **Custom panels (jsui):** controls the panel draws that should be Live parameters are hidden `live.*` objects (no
  presentation): jsui `outlet(0, name, value)` → `[route name …]` → the parameter → `[prepend name]` → DSP and back to
  the jsui, which shows only what comes back. Theme: `[live.colors]` (`everything` at load and on its right-outlet
  bang) → jsui `anything()` as `<id> r g b a`; color ids seen in Ableton's devices: `lcd_bg`, `control_bg`,
  `control_selection`, `display_handle_two`, `display_scale_text`, `lcd_control_fg_zombie` — keep a fallback for any
  other. `live.thisdevice` middle outlet = device on/off (dim the panel). `live.text` without `mode` is a toggle.
- **Timing:** `[phasor~ 4n @lock 1]` gives a beat phase locked to Live's transport (it stops with the transport);
  bars and song position come from the Live API (`current_song_time`, `signature_numerator/denominator`) via
  `live.thisdevice → [path live_set( → live.path → [t b l] → live.observer` (id into the right inlet first).
- **Cross-fades** between read heads: raised cosine (gains sum to 1); equal-power bumps +3 dB on correlated signals.

## Workflow
- Plan in the device's `docs/` before changes that touch more than two files. Verify with tests you ran and show the
  output; rebuild `dist/` and commit it with the change.
