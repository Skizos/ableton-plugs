// The jsui editor panel (src/gw_ui.js) under stubs of Max's globals: envelope math, presets, persistence, the buffer
// it writes for gen~, mouse editing, the panel's controls and popovers, dice/evolve, theme colors, and that painting
// only uses real mgraphics calls.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { plain, loadUi, makeMaxBuffers, ENV_FRAMES } = require("./helpers");

// Layout at the panel's 380 x 157: display 380 x 114, envelope area x 5..375, y 14..109; rows at y 118 and 139.
const toX = (x) => 5 + x * 370;
const toY = (u) => 14 + u * 95;

function checkEnv(ctx, pts, label) {
    assert.ok(pts.length >= 2 && pts.length <= ctx.MAX_PTS, `${label}: ${pts.length} points`);
    assert.equal(pts[0].x, 0, `${label}: starts at 0`);
    assert.equal(pts[pts.length - 1].x, 1, `${label}: ends at 1`);
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        assert.ok(p.u >= 0 && p.u <= 1 && p.c >= -1 && p.c <= 1, `${label}: point ${i} in range`);
        if (i > 0) {
            assert.ok(p.x >= pts[i - 1].x, `${label}: sorted at ${i}`);
        }
        if (i > 1) {
            assert.ok(!(p.x === pts[i - 1].x && p.x === pts[i - 2].x), `${label}: three points at x=${p.x}`);
        }
    }
}

function fresh(options) {
    const ui = loadUi(options);
    const buffers = ui.buffers;
    buffers.create("9gwenv", ENV_FRAMES, 1);
    buffers.create("9gwpeaks", 512, 1);
    ui.ctx.envbuf("9gwenv");
    ui.ctx.peakbuf("9gwpeaks");
    ui.outs.length = 0;
    return ui;
}

function block(ui, p, e, name) {
    const data = ui.buffers.get(name || "9gwenv").data[0];
    const base = (p * 2 + e) * 385;
    const n = data[base];
    const pts = [];
    for (let i = 0; i < n; i++) {
        pts.push({ x: data[base + 1 + 3 * i], u: data[base + 2 + 3 * i], c: data[base + 3 + 3 * i] });
    }
    return pts;
}

function button(ctx, id) {
    const b = ctx.curLayout().buttons.find((x) => x.id === id);
    assert.ok(b, `button ${id}`);
    return [b.x + b.w / 2, b.y + b.h / 2];
}

function popItem(ctx, kind, id) {
    const it = ctx.popItems(ctx.curLayout()).find((x) => x.kind === kind && x.id === id);
    assert.ok(it, `${ctx.view.pop}: no ${kind} ${id}`);
    return [it.x + it.w / 2, it.y + it.h / 2];
}

function click(ctx, x, y, mods) {
    const m = Object.assign({ shift: 0, option: 0 }, mods);
    ctx.onclick(x, y, 1, 0, m.shift, 0, m.option, 0);
}

function dragTo(ctx, x, y, mods) {
    const m = Object.assign({ shift: 0, option: 0 }, mods);
    ctx.ondrag(x, y, 1, 0, m.shift, 0, m.option, 0);
}

function release(ctx, x, y) {
    ctx.ondrag(x, y, 0, 0, 0, 0, 0, 0);
}

const last = (outs) => plain(outs[outs.length - 1]);

// ---------------------------------------------------------------------------------------------------------------
// Envelopes and presets

test("every preset is a valid envelope, in a category, and the combos and slots name real presets", () => {
    const { ctx } = loadUi();
    assert.ok(ctx.PRESETS[0].length >= 40, "time presets");
    assert.ok(ctx.PRESETS[1].length >= 30, "volume presets");
    for (let e = 0; e < 2; e++) {
        const list = ctx.PRESETS[e];
        const names = new Set();
        for (let i = 0; i < list.length; i++) {
            names.add(list[i].name);
            checkEnv(ctx, ctx.makePreset(e, i), list[i].name);
            assert.ok(/^[\x20-\x7e]+$/.test(list[i].name), "ASCII names (Max text rendering)");
            assert.ok(list[i].cat && list[i].cat !== "Combos", `${list[i].name} has a category`);
        }
        assert.equal(names.size, list.length, "unique names");
        assert.equal(ctx.categories(e)[0], "Combos");
        assert.equal(list[0].name, "Normal", "Normal first: the empty slot, as in Gross Beat");
    }
    for (const c of plain(ctx.COMBOS)) {
        assert.ok(ctx.presetIndex(0, c.time) >= 0 && ctx.presetIndex(1, c.vol) >= 0, c.name);
    }
    for (const [t, v] of plain(ctx.DEFAULT_SLOTS)) {
        assert.ok(ctx.presetIndex(0, t) >= 0 && ctx.presetIndex(1, v) >= 0, `${t} / ${v}`);
    }
    for (let e = 0; e < 2; e++) {
        for (const name of plain(ctx.V1_NAMES[e])) {
            assert.ok(ctx.presetIndex(e, name) >= 0, `version 1 preset ${name} still exists`);
        }
    }
});

test("presets mean what their names say", () => {
    const { ctx } = loadUi();
    const env = (e, name) => ctx.makePreset(e, ctx.presetIndex(e, name));
    const roll = env(0, "1/16 Roll");
    assert.equal(ctx.evalEnv(roll, 0.3), 0);
    assert.equal(ctx.evalEnv(roll, 0.55), 0);
    assert.equal(ctx.evalEnv(roll, 0.6), 1 / 16);
    assert.equal(ctx.evalEnv(roll, 0.99), 7 / 16);
    const half = env(0, "Half Time");
    assert.ok(Math.abs(ctx.evalEnv(half, 0.5) - 0.25) < 1e-12);
    // speed = 1 - d(offset)/dx in patterns per pattern
    const speed = (pts, x) => 1 - (ctx.evalEnv(pts, x + 1e-6) - ctx.evalEnv(pts, x)) / 1e-6;
    const stop = env(0, "Tape Stop");
    assert.ok(Math.abs(speed(stop, 0.75) - 0.5) < 1e-4);
    assert.ok(Math.abs(speed(stop, 0.999)) < 1e-2, "stops at the end");
    const lastStop = env(0, "Stop Last Beat");
    assert.equal(ctx.evalEnv(lastStop, 0.7), 0, "live until the last beat");
    assert.ok(Math.abs(speed(lastStop, 0.76) - 1) < 0.1 && Math.abs(speed(lastStop, 0.999)) < 0.02);
    const rev = env(0, "Reverse Last Beat");
    assert.ok(Math.abs(speed(rev, 0.8) + 1) < 1e-6, "backwards at normal speed");
    const oct = env(0, "Octave Up 1/8");
    assert.ok(Math.abs(speed(oct, 0.9) - 2) < 1e-6, "double speed");
    assert.ok(Math.abs(ctx.evalEnv(oct, 0.875) - 1 / 8) < 1e-12, "starts an eighth late and catches up");
    const stut = env(0, "Stutter Beat 2");
    for (let k = 0; k < 4; k++) {
        assert.ok(Math.abs(ctx.evalEnv(stut, (4 + k + 0.5) / 16) - k / 16) < 1e-12, "beat 2 repeats its first 1/16");
    }
    const gate = env(1, "Gate 1/16");
    assert.equal(ctx.evalEnv(gate, 0.01), 0);
    assert.equal(ctx.evalEnv(gate, 0.04), 1);
    const trance = env(1, "Trance Gate");
    for (let i = 0; i < 16; i++) {
        assert.equal(ctx.evalEnv(trance, (i + 0.5) / 16), 1 - ctx.TRANCE[i]);
    }
    const euclid = env(1, "Euclid 5/16");
    let on = 0;
    for (let i = 0; i < 16; i++) {
        on += ctx.evalEnv(euclid, (i + 0.5) / 16) === 0 ? 1 : 0;
    }
    assert.equal(on, 5, "five hits in sixteen");
    const trip = env(1, "Triplet Gate");
    assert.equal(ctx.evalEnv(trip, 0.5 / 12), 0);
    assert.equal(ctx.evalEnv(trip, 1.5 / 12), 1);
});

test("curves: c = 1/3 is t squared and handles invert the shape", () => {
    const { ctx } = loadUi();
    assert.ok(Math.abs(ctx.shape(0.3, 1 / 3) - 0.09) < 1e-12);
    assert.ok(Math.abs(ctx.shape(0.3, -1 / 3) - (1 - 0.49)) < 1e-12);
    for (const c of [-1, -0.6, -1 / 3, 0, 0.2, 1 / 3, 0.8, 1]) {
        const mid = ctx.shape(0.5, c);
        assert.ok(Math.abs(ctx.curveForMid(0, 1, mid) - c) < 1e-9, `c=${c}`);
        assert.ok(Math.abs(ctx.curveForMid(1, 0, 1 - mid) - c) < 1e-9, `c=${c} falling`);
    }
    assert.equal(ctx.curveForMid(0.4, 0.4, 0.9), 0);
});

test("cleanEnv sorts, closes the ends and drops points that change nothing", () => {
    const { ctx } = loadUi();
    const pts = plain(
        ctx.cleanEnv([
            { x: 0.5, u: 0.2, c: 0 },
            { x: 0.25, u: 0.2, c: 0 },
            { x: 0.75, u: 0.2, c: 0 },
            { x: 0.6, u: 0.7, c: 0 },
            { x: 0.6, u: 0.1, c: 0 },
            { x: 0.6, u: 0.9, c: 0 },
            { x: 2, u: -1, c: 5 },
        ]),
    );
    assert.deepEqual(pts, [
        { x: 0, u: 0.2, c: 0 },
        { x: 0.5, u: 0.2, c: 0 },
        { x: 0.6, u: 0.7, c: 0 },
        { x: 0.6, u: 0.9, c: 0 },
        { x: 0.75, u: 0.2, c: 0 },
        { x: 1, u: 0, c: 0 },
    ]);
    const many = [];
    for (let i = 0; i < 400; i++) {
        many.push({ x: i / 400, u: (i % 7) / 7, c: 0 });
    }
    checkEnv(ctx, ctx.cleanEnv(many), "capped");
    assert.deepEqual(plain(ctx.cleanEnv([])), [
        { x: 0, u: 0, c: 0 },
        { x: 1, u: 0, c: 0 },
    ]);
});

test("setRange paints one level and keeps the rest", () => {
    const { ctx } = loadUi();
    const ramp = ctx.cleanEnv([
        { x: 0, u: 0, c: 0 },
        { x: 1, u: 0.5, c: 0 },
    ]);
    const out = ctx.setRange(ramp, 0.25, 0.5, 0.9);
    checkEnv(ctx, out, "painted");
    assert.equal(ctx.evalEnv(out, 0.3), 0.9);
    assert.ok(Math.abs(ctx.evalEnv(out, 0.1) - 0.05) < 1e-12);
    assert.ok(Math.abs(ctx.evalEnv(out, 0.75) - 0.375) < 1e-12);
    assert.ok(Math.abs(ctx.evalLeft(out, 0.25) - 0.125) < 1e-12, "the step starts from the old level");
    const whole = ctx.setRange(ramp, 0, 1, 0.3);
    assert.deepEqual(plain(whole), [
        { x: 0, u: 0.3, c: 0 },
        { x: 1, u: 0.3, c: 0 },
    ]);
});

test("flip turns an envelope upside down", () => {
    const ui = fresh();
    const { ctx } = ui;
    ctx.setedit(1);
    ctx.dopreset(ctx.presetIndex(1, "Fade In")); // u 1 -> 0
    click(ctx, ...button(ctx, "flip"));
    assert.deepEqual(plain(ctx.S.pats[0][1]), [
        { x: 0, u: 0, c: 0 },
        { x: 1, u: 1, c: 0 },
    ]);
    assert.equal(ctx.S.preset[0][1], -1);
    assert.deepEqual(block(ui, 0, 1), plain(ctx.S.pats[0][1]));
    ctx.doundo();
    assert.equal(ctx.S.preset[0][1], ctx.presetIndex(1, "Fade In"));
});

// ---------------------------------------------------------------------------------------------------------------
// Saving and the buffer for gen~

test("the blob round-trips and foreign blobs are ignored", () => {
    const ui = fresh();
    const { ctx } = ui;
    ctx.setgrid(5);
    ctx.setevolve(3);
    ctx.settool(1);
    ctx.S.pats[4][1] = ctx.makePreset(1, 3);
    ctx.S.preset[4][1] = 3;
    const blob = plain(ctx.getvalueof());
    assert.deepEqual(blob.slice(0, 6), [4757, 2, 0, 1, 5, 3]);
    const other = fresh();
    other.ctx.setvalueof(...blob);
    assert.deepEqual(plain(other.ctx.S), plain(ctx.S));
    assert.deepEqual(block(other, 4, 1), plain(ctx.S.pats[4][1]), "restored state reaches gen~");
    assert.deepEqual(last(other.outs), ["swunit", 1 / 3], "and gen~ gets the restored grid for swing");
    const before = plain(other.ctx.S);
    other.ctx.setvalueof(1, 2, 3);
    other.ctx.setvalueof(...blob.slice(0, blob.length - 4));
    other.ctx.setvalueof(4757, 3, ...blob.slice(2));
    assert.deepEqual(plain(other.ctx.S), before);
});

test("a version 1 blob (the first release) still loads, with its preset names", () => {
    const { ctx } = fresh();
    const flat = (pts) => pts.flatMap((p) => [p.x, p.u, p.c]);
    // header: magic, version, edit, tool, grid, swing (now a Live parameter, so it is dropped)
    const blob = [4757, 1, 1, 1, 5, 30];
    for (let p = 0; p < 8; p++) {
        for (let e = 0; e < 2; e++) {
            if (p === 0 && e === 0) {
                const pts = plain(ctx.makePreset(0, ctx.presetIndex(0, "1/16 Roll")));
                blob.push(8, pts.length, ...flat(pts)); // version 1's preset 8 was 1/16 Roll
            } else if (p === 0 && e === 1) {
                const pts = plain(ctx.makePreset(1, ctx.presetIndex(1, "Trance Gate")));
                blob.push(3, pts.length, ...flat(pts)); // and its volume preset 3 Trance Gate
            } else {
                blob.push(0, 2, 0, 0, 0, 1, 0, 0);
            }
        }
    }
    ctx.setvalueof(...blob);
    assert.equal(ctx.S.edit, 1);
    assert.equal(ctx.S.tool, 1);
    assert.equal(ctx.S.grid, 5);
    assert.equal(ctx.S.evolve, 0);
    assert.equal(ctx.S.preset[0][0], ctx.presetIndex(0, "1/16 Roll"));
    assert.equal(ctx.S.preset[0][1], ctx.presetIndex(1, "Trance Gate"));
    assert.equal(ctx.presetLabel(), "Trance Gate");
});

test("every envelope is mirrored into the buffer in gen~'s layout", () => {
    for (const chanBase of [1, 0]) {
        const ui = fresh({ chanBase });
        const { ctx } = ui;
        assert.equal(ctx.chanBase, chanBase, "channel numbering detected");
        for (let p = 0; p < 8; p++) {
            for (let e = 0; e < 2; e++) {
                assert.deepEqual(block(ui, p, e), plain(ctx.S.pats[p][e]), `pattern ${p} env ${e}`);
            }
        }
    }
});

test("an undersized buffer~ is resized before writing", () => {
    const buffers = makeMaxBuffers(1);
    buffers.create("tiny", 10, 1);
    const ui = loadUi({ buffers });
    ui.ctx.envbuf("tiny");
    assert.equal(buffers.get("tiny").frames, ENV_FRAMES);
    assert.deepEqual(block(ui, 7, 1, "tiny"), plain(ui.ctx.S.pats[7][1]));
});

// ---------------------------------------------------------------------------------------------------------------
// Editing in the display

test("click adds a snapped point, drag moves it, mouse-up tells Live once", () => {
    const ui = fresh();
    const { ctx } = ui;
    click(ctx, toX(0.3), toY(0.4));
    let pts = ctx.S.pats[0][0];
    assert.deepEqual(plain(pts[1]), { x: 5 / 16, u: 6 / 16, c: 0 }, "x and time offset snap to 1/16");
    assert.equal(block(ui, 0, 0).length, 3, "gen~ sees the point while dragging");
    dragTo(ctx, toX(0.52), toY(0.49));
    pts = ctx.S.pats[0][0];
    assert.deepEqual(plain(pts[1]), { x: 0.5, u: 0.5, c: 0 });
    assert.equal(ui.notified.count, 0, "no Live notification during the drag");
    release(ctx, toX(0.52), toY(0.49));
    assert.equal(ui.notified.count, 1);
    assert.equal(ctx.S.preset[0][0], -1, "now a custom shape");
    assert.equal(ctx.presetLabel(), "Custom");
    // Shift: free placement
    click(ctx, toX(0.7), toY(0.3), { shift: 1 });
    dragTo(ctx, toX(0.71), toY(0.33), { shift: 1 });
    release(ctx, toX(0.71), toY(0.33));
    const free = ctx.S.pats[0][0].find((p) => p.x > 0.6 && p.x < 0.8);
    assert.ok(Math.abs(free.x - 0.71) < 1e-9 && Math.abs(free.u - 0.33) < 1e-9);
});

test("points stay between their neighbours; ends keep their x", () => {
    const ui = fresh();
    const { ctx } = ui;
    ctx.dopreset(ctx.presetIndex(0, "Slow > Fast")); // (0,0) (0.5,0.25) (1,0)
    click(ctx, toX(0.5), toY(0.25));
    dragTo(ctx, toX(1), toY(0.25));
    assert.equal(ctx.S.pats[0][0][1].x, 1);
    release(ctx, toX(1), toY(0.25));
    click(ctx, toX(0), toY(0));
    dragTo(ctx, toX(0.4), toY(0.5));
    release(ctx, toX(0.4), toY(0.5));
    assert.equal(ctx.S.pats[0][0][0].x, 0);
    assert.equal(ctx.S.pats[0][0][0].u, 0.5);
});

test("a click that moves nothing leaves no undo step and no notification", () => {
    const ui = fresh();
    const { ctx } = ui;
    click(ctx, toX(0), toY(0));
    release(ctx, toX(0), toY(0));
    assert.equal(ctx.undoStack.length, 0);
    assert.equal(ui.notified.count, 0);
    assert.equal(ctx.S.preset[0][0], 0, "still the preset");
});

test("Alt-click and double-click delete points, never the ends", () => {
    const ui = fresh();
    const { ctx } = ui;
    ctx.dopreset(ctx.presetIndex(0, "Reverse 1/2")); // (0,0) (0.5,0) (1,1)
    click(ctx, toX(1), toY(1), { option: 1 });
    assert.equal(ctx.S.pats[0][0].length, 3);
    click(ctx, toX(0.5), toY(0), { option: 1 });
    assert.equal(ctx.S.pats[0][0].length, 2);
    ctx.doundo();
    assert.equal(ctx.S.pats[0][0].length, 3);
    ctx.ondblclick(toX(0.5), toY(0), 1, 0, 0, 0, 0, 0);
    assert.equal(ctx.S.pats[0][0].length, 2);
});

test("curve handles bend a segment; Alt-click straightens it", () => {
    const ui = fresh();
    const { ctx } = ui;
    ctx.dopreset(ctx.presetIndex(0, "Half Time")); // (0,0) -> (1,0.5)
    click(ctx, toX(0.5), toY(0.25));
    dragTo(ctx, toX(0.5), toY(0.125));
    release(ctx, toX(0.5), toY(0.125));
    const c = ctx.S.pats[0][0][0].c;
    assert.ok(Math.abs(c - 1 / 3) < 1e-9, `curve ${c}`);
    assert.ok(Math.abs(ctx.evalEnv(ctx.S.pats[0][0], 0.5) - 0.125) < 1e-9);
    assert.equal(block(ui, 0, 0)[0].c, c);
    click(ctx, toX(0.5), toY(0.125), { option: 1 });
    assert.equal(ctx.S.pats[0][0][0].c, 0);
});

test("the draw tool paints grid cells and Alt erases", () => {
    const ui = fresh();
    const { ctx } = ui;
    click(ctx, ...button(ctx, "draw"));
    assert.equal(ctx.S.tool, 1);
    click(ctx, toX(0.51), toY(0.25));
    dragTo(ctx, toX(0.58), toY(0.25));
    release(ctx, toX(0.58), toY(0.25));
    const pts = ctx.S.pats[0][0];
    checkEnv(ctx, pts, "painted");
    assert.equal(ctx.evalEnv(pts, 0.49), 0);
    assert.equal(ctx.evalEnv(pts, 0.53), 0.25);
    assert.equal(ctx.evalEnv(pts, 0.6), 0.25);
    assert.equal(ctx.evalEnv(pts, 0.63), 0);
    assert.equal(ui.notified.count, 1);
    click(ctx, toX(0.53), toY(0.8), { option: 1 });
    release(ctx, toX(0.53), toY(0.8));
    assert.equal(ctx.evalEnv(ctx.S.pats[0][0], 0.53), 0);
    assert.equal(ctx.evalEnv(ctx.S.pats[0][0], 0.6), 0.25);
});

test("undo and redo walk the history (the undo button; Shift-click redoes)", () => {
    const ui = fresh();
    const { ctx } = ui;
    const original = plain(ctx.S.pats[0][0]);
    ctx.nextpreset();
    const next = plain(ctx.S.pats[0][0]);
    assert.notDeepEqual(next, original);
    click(ctx, ...button(ctx, "undo"));
    assert.deepEqual(plain(ctx.S.pats[0][0]), original);
    assert.deepEqual(block(ui, 0, 0), original);
    click(ctx, ...button(ctx, "undo"), { shift: 1 });
    assert.deepEqual(plain(ctx.S.pats[0][0]), next);
    assert.equal(ctx.S.preset[0][0], 1);
});

test("copy in one device, paste in another", () => {
    const globals = new Map();
    const a = fresh({ globals });
    const b = fresh({ globals });
    a.ctx.pattern(2);
    click(a.ctx, ...button(a.ctx, "copy"));
    assert.equal(b.ctx.curLayout().buttons.find((x) => x.id === "paste").enabled, true);
    click(b.ctx, ...button(b.ctx, "paste"));
    assert.deepEqual(plain(b.ctx.S.pats[0][0]), plain(a.ctx.S.pats[2][0]));
    assert.equal(b.ctx.S.preset[0][0], -1);
    assert.deepEqual(block(b, 0, 0), plain(a.ctx.S.pats[2][0]));
});

// ---------------------------------------------------------------------------------------------------------------
// The panel's controls

test("the panel is laid out as in the picture, inside the jsui, without overlaps", () => {
    const { ctx } = loadUi();
    const L = ctx.curLayout();
    assert.deepEqual([L.w, L.h], [380, 157]);
    const row = (y) =>
        plain(
            L.buttons
                .filter((b) => b.y === y)
                .sort((a, b) => a.x - b.x)
                .map((b) => b.id),
        );
    assert.deepEqual(row(ctx.ROW1_Y), [
        "time",
        "vol",
        "pprev",
        "pname",
        "pnext",
        "point",
        "draw",
        "dice",
        "flip",
        "copy",
        "paste",
    ]);
    assert.deepEqual(row(ctx.ROW2_Y), [
        "pad0",
        "pad1",
        "pad2",
        "pad3",
        "pad4",
        "pad5",
        "pad6",
        "pad7",
        "switch",
        "hprev",
        "hold",
        "hnext",
        "swing",
        "undo",
        "grid",
        "gear",
    ]);
    for (const b of L.buttons) {
        assert.ok(b.x >= 0 && b.x + b.w <= L.w && b.y >= L.disp.h && b.y + b.h <= L.h, b.id);
    }
    for (const y of [ctx.ROW1_Y, ctx.ROW2_Y]) {
        const ids = row(y);
        const right = Math.max(...L.buttons.filter((b) => b.y === y).map((b) => b.x + b.w));
        assert.equal(right, L.w, "each row spans the width");
        for (let i = 1; i < ids.length; i++) {
            const a = L.buttons.find((b) => b.id === ids[i - 1]);
            const b = L.buttons.find((x) => x.id === ids[i]);
            assert.ok(a.x + a.w <= b.x, `${a.id} / ${b.id}`);
        }
    }
});

test("pads: click plays a pattern (through its Live parameter), Alt-click copies the shown one there", () => {
    const ui = fresh();
    const { ctx, outs } = ui;
    click(ctx, ...button(ctx, "pad3"));
    assert.deepEqual(last(outs), ["pattern", 3]);
    assert.equal(ctx.view.pattern, 0, "the panel waits for the parameter to answer");
    ctx.pattern(3);
    assert.equal(ctx.view.pattern, 3);
    assert.equal(ctx.curLayout().buttons.find((b) => b.id === "pad3").on, true);
    const n = outs.length;
    const gate = plain(ctx.S.pats[5][1]);
    click(ctx, ...button(ctx, "pad5"), { option: 1 });
    assert.equal(outs.length, n, "a copy does not switch patterns");
    assert.deepEqual(plain(ctx.S.pats[5]), plain(ctx.S.pats[3]));
    assert.deepEqual(plain(ctx.S.preset[5]), plain(ctx.S.preset[3]));
    assert.deepEqual(block(ui, 5, 0), plain(ctx.S.pats[3][0]));
    assert.equal(ui.notified.count, 1);
    ctx.doundo();
    assert.deepEqual(plain(ctx.S.pats[5][1]), gate, "one undo step for both envelopes");
});

test("the preset row: envelope buttons, stepping with wrap-around, the browser with categories and combos", () => {
    const ui = fresh();
    const { ctx } = ui;
    click(ctx, ...button(ctx, "paste"));
    assert.equal(ctx.undoStack.length, 0, "paste is disabled with an empty clipboard");
    click(ctx, ...button(ctx, "vol"));
    assert.equal(ctx.S.edit, 1);
    click(ctx, ...button(ctx, "pnext"));
    assert.equal(ctx.S.preset[0][1], 1);
    click(ctx, ...button(ctx, "pprev"));
    click(ctx, ...button(ctx, "pprev"));
    assert.equal(ctx.S.preset[0][1], ctx.PRESETS[1].length - 1, "wraps around");
    click(ctx, ...button(ctx, "pname"));
    assert.equal(ctx.view.pop, "browser");
    const shown = ctx.popItems(ctx.curLayout()).filter((x) => x.kind === "preset");
    const curCat = ctx.PRESETS[1][ctx.S.preset[0][1]].cat;
    assert.ok(shown.length > 0 && shown.every((x) => ctx.PRESETS[1][x.id].cat === curCat), "opens on its category");
    click(ctx, ...popItem(ctx, "cat", "Gate"));
    assert.equal(ctx.view.pop, "browser", "a category keeps the browser open");
    click(ctx, ...popItem(ctx, "preset", ctx.presetIndex(1, "Gate 1/16")));
    assert.equal(ctx.view.pop, "");
    assert.equal(ctx.presetLabel(), "Gate 1/16");
    click(ctx, ...button(ctx, "pname"));
    click(ctx, ...popItem(ctx, "cat", "Combos"));
    click(ctx, ...popItem(ctx, "combo", 0)); // Roll + Gate
    assert.equal(ctx.S.preset[0][0], ctx.presetIndex(0, "1/16 Roll"));
    assert.equal(ctx.S.preset[0][1], ctx.presetIndex(1, "Gate 1/32 End"));
    assert.deepEqual(block(ui, 0, 0), plain(ctx.S.pats[0][0]));
    ctx.doundo();
    assert.equal(ctx.S.preset[0][0], 0, "a combo is one undo step");
    assert.equal(ctx.presetLabel(), "Gate 1/16");
});

test("the browser fits every category of both envelopes in the display", () => {
    const { ctx } = loadUi();
    const L = ctx.curLayout();
    for (let e = 0; e < 2; e++) {
        ctx.setedit(e);
        for (const cat of plain(ctx.categories(e))) {
            ctx.view.pop = "browser";
            ctx.view.browseCat = cat;
            const items = ctx.popItems(L);
            const want = cat === "Combos" ? ctx.COMBOS.length : ctx.PRESETS[e].filter((p) => p.cat === cat).length;
            assert.equal(items.filter((x) => x.kind !== "cat").length, want, `${cat}: all shown`);
            for (const it of items) {
                assert.ok(
                    it.x >= 0 && it.y >= 0 && it.x + it.w <= L.w && it.y + it.h <= L.disp.h,
                    `${cat}: ${it.label}`,
                );
            }
        }
    }
});

test("Switch, Hold and Swing send their Live parameters", () => {
    const ui = fresh();
    const { ctx, outs } = ui;
    click(ctx, ...button(ctx, "switch"));
    assert.equal(ctx.view.pop, "quant");
    click(ctx, ...popItem(ctx, "quant", 3));
    assert.deepEqual(last(outs), ["quant", 3]);
    assert.equal(ctx.view.pop, "");
    click(ctx, ...button(ctx, "hold"));
    assert.deepEqual(last(outs), ["hold", 1]);
    ctx.hold(1);
    assert.equal(ctx.curLayout().buttons.find((b) => b.id === "hold").on, true);
    click(ctx, ...button(ctx, "hold"));
    assert.deepEqual(last(outs), ["hold", 0]);
    click(ctx, ...button(ctx, "hprev"));
    assert.deepEqual(last(outs), ["holdlen", 1]);
    click(ctx, ...button(ctx, "hnext"));
    assert.deepEqual(last(outs), ["holdlen", 3]);
    ctx.holdlen(4);
    click(ctx, ...button(ctx, "hnext"));
    assert.deepEqual(last(outs), ["holdlen", 4], "stops at a bar");
    // Swing: drag up, double-click resets
    const [sx, sy] = button(ctx, "swing");
    click(ctx, sx, sy);
    dragTo(ctx, sx, sy - 20);
    assert.deepEqual(last(outs), ["swing", 15]);
    dragTo(ctx, sx, sy - 200);
    assert.deepEqual(last(outs), ["swing", 75]);
    release(ctx, sx, sy - 200);
    assert.equal(ui.notified.count, 0, "parameters are not blob edits");
    ctx.ondblclick(sx, sy, 1, 0, 0, 0, 0, 0);
    assert.deepEqual(last(outs), ["swing", 0]);
});

test("the grid popover sets snap (gen~'s swing step) and Length; settings: Hold mode, Grain, MIDI, Evolve", () => {
    const ui = fresh();
    const { ctx, outs } = ui;
    click(ctx, ...button(ctx, "grid"));
    assert.equal(ctx.view.pop, "grid");
    click(ctx, ...popItem(ctx, "snap", 4)); // 1/32
    assert.equal(ctx.S.grid, 4);
    assert.deepEqual(last(outs), ["swunit", 0.125]);
    click(ctx, ...popItem(ctx, "length", 3));
    assert.deepEqual(last(outs), ["patlen", 3]);
    assert.equal(ctx.view.pop, "grid", "stays open for more choices");
    click(ctx, ...button(ctx, "gear"));
    assert.equal(ctx.view.pop, "settings");
    click(ctx, ...popItem(ctx, "holdmode", 1));
    assert.deepEqual(last(outs), ["holdmode", 1]);
    click(ctx, ...popItem(ctx, "grain", 2));
    assert.deepEqual(last(outs), ["grainms", 70]);
    ctx.grainms(70);
    click(ctx, ...popItem(ctx, "grain", 0));
    assert.deepEqual(last(outs), ["grainms", 60]);
    click(ctx, ...popItem(ctx, "midilink", 2));
    assert.deepEqual(last(outs), ["midilink", 2]);
    click(ctx, ...popItem(ctx, "evolve", 2));
    assert.equal(ctx.S.evolve, 2);
});

test("clicks outside a popover close it without editing; another button still works; its own button closes it", () => {
    const ui = fresh();
    const { ctx } = ui;
    click(ctx, ...button(ctx, "grid"));
    click(ctx, toX(0.1), toY(0.5));
    assert.equal(ctx.view.pop, "");
    assert.equal(ctx.S.pats[0][0].length, 2, "no point added");
    assert.equal(ctx.undoStack.length, 0);
    click(ctx, ...button(ctx, "gear"));
    click(ctx, ...button(ctx, "vol"));
    assert.equal(ctx.view.pop, "");
    assert.equal(ctx.S.edit, 1);
    click(ctx, ...button(ctx, "pname"));
    click(ctx, ...button(ctx, "pname"));
    assert.equal(ctx.view.pop, "", "the opener toggles");
});

test("swing works on the editor's grid step, in quarter notes", () => {
    const ui = fresh();
    const { ctx, outs } = ui;
    const steps = { 0: 0.25, 1: 1, 2: 0.5, 3: 0.25, 4: 0.125, 5: 1 / 3, 6: 1 / 6 };
    for (const [g, q] of Object.entries(steps)) {
        ctx.setgrid(Number(g));
        assert.deepEqual(last(outs), ["swunit", q], `grid ${ctx.GRIDS[g].name}`);
    }
    outs.length = 0;
    ctx.loadbang();
    assert.deepEqual(last(outs), ["swunit", 1 / 6], "sent again at load");
});

// ---------------------------------------------------------------------------------------------------------------
// Dice, Mutate and Evolve

test("dice rolls a valid pattern on the grid, repeatably from a seed; Shift-click mutates one envelope", () => {
    const ui = fresh();
    const { ctx } = ui;
    ctx.setseed(42);
    click(ctx, ...button(ctx, "dice"));
    const rolled = plain(ctx.S.pats[0]);
    assert.deepEqual(plain(ctx.S.preset[0]), [-1, -1]);
    assert.deepEqual(block(ui, 0, 0), rolled[0]);
    assert.equal(ui.notified.count, 1);
    const again = fresh();
    again.ctx.setseed(42);
    again.ctx.dodice();
    assert.deepEqual(plain(again.ctx.S.pats[0]), rolled, "same seed, same pattern");
    ctx.doundo();
    assert.deepEqual(plain(ctx.S.preset[0]), [0, 0], "one undo step");
    ctx.setseed(7);
    click(ctx, ...button(ctx, "dice"), { shift: 1 });
    assert.equal(ctx.S.preset[0].filter((p) => p === -1).length, 1, "mutate: one envelope");
});

test("dice is valid on every grid and length, and the time envelope starts live", () => {
    const { ctx } = loadUi();
    for (const [grid, len] of [
        [3, 2],
        [2, 2],
        [5, 2],
        [6, 3],
        [3, 0],
        [4, 4],
    ]) {
        ctx.setgrid(grid);
        ctx.patlen(len);
        for (let seed = 1; seed <= 150; seed++) {
            ctx.setseed(seed);
            ctx.dicePattern(1, false);
            const label = `grid ${grid} length ${len} seed ${seed}`;
            checkEnv(ctx, ctx.S.pats[1][0], `${label} time`);
            checkEnv(ctx, ctx.S.pats[1][1], `${label} volume`);
            assert.equal(ctx.evalEnv(ctx.S.pats[1][0], 0), 0, `${label}: plays live at the start`);
        }
    }
});

test("Evolve mutates the playing pattern every beat, without filling Live's undo history", () => {
    const ui = fresh();
    const { ctx } = ui;
    ctx.setseed(3);
    click(ctx, ...button(ctx, "gear"));
    click(ctx, ...popItem(ctx, "evolve", 1)); // every beat
    ctx.active(2);
    const before = plain(ctx.S.pats);
    ctx.phase(0.1);
    ctx.phase(0.2);
    assert.deepEqual(plain(ctx.S.pats), before, "nothing within the first beat");
    for (const ph of [0.3, 0.6, 0.9, 0.05, 0.3]) {
        ctx.phase(ph); // beats 2, 3, 4, then over the bar line to 1 and 2
    }
    assert.ok(
        ctx.S.preset[2].some((p) => p === -1),
        "pattern 3 evolved",
    );
    for (let p = 0; p < 8; p++) {
        if (p !== 2) {
            assert.deepEqual(plain(ctx.S.pats[p]), before[p], `pattern ${p + 1} untouched`);
        }
    }
    assert.deepEqual(block(ui, 2, 0), plain(ctx.S.pats[2][0]), "gen~ hears it");
    assert.equal(ui.notified.count, 0);
    assert.equal(ctx.undoStack.length, 0);
    ctx.setevolve(0);
    const frozen = plain(ctx.S.pats);
    ctx.phase(0.6);
    ctx.phase(0.95);
    assert.deepEqual(plain(ctx.S.pats), frozen, "Off stops it");
});

// ---------------------------------------------------------------------------------------------------------------
// Grid, messages, hover

test("grid follows the pattern length", () => {
    const { ctx } = loadUi();
    assert.equal(ctx.gridCells(), 16);
    ctx.patlen(0);
    assert.equal(ctx.gridCells(), 4, "1/16 over one beat");
    ctx.patlen(2);
    assert.equal(ctx.gridLine(3, 16), 3 / 16);
    assert.equal(ctx.snapX(3.3 / 16, false), 3 / 16);
    ctx.setgrid(5);
    assert.equal(ctx.gridCells(), 12, "1/8 triplets in a bar of 4/4");
    ctx.setgrid(0);
    assert.equal(ctx.snapX(0.333, false), 0.333);
    assert.equal(ctx.snapU(0.01, false), 0, "levels stick to the edges");
});

test("lengths up to 4 bars and any meter: grid cells, a shorter last cell, snapping to the end", () => {
    const { ctx } = loadUi();
    ctx.patlen(4);
    assert.equal(ctx.patQuarters(), 16);
    assert.equal(ctx.gridCells(), 64, "1/16 over 4 bars of 4/4");
    ctx.signum(7);
    ctx.sigden(8);
    ctx.patlen(2);
    assert.equal(ctx.quartersPerBar(), 3.5);
    ctx.setgrid(1); // 1/4
    assert.equal(ctx.gridCells(), 3.5);
    assert.deepEqual(plain(ctx.cellAt(0.95)), { k: 3, a: 3 / 3.5, b: 1 }, "the last cell is half a beat");
    assert.equal(ctx.snapX(0.97, false), 1);
    assert.equal(ctx.snapX(0.3, false), 1 / 3.5);
    ctx.signum(6);
    ctx.sigden(8);
    ctx.patlen(3);
    assert.equal(ctx.patQuarters(), 6, "two bars of 6/8");
    ctx.patlen(99);
    assert.equal(ctx.view.patlen, 4);
});

test("messages from the patcher update the view, clamped", () => {
    const { ctx } = loadUi();
    ctx.pattern(5.0);
    ctx.active(2);
    ctx.phase(0.25);
    assert.equal(ctx.view.pattern, 5);
    assert.equal(ctx.view.active, 2);
    assert.equal(ctx.view.phase, 0.25);
    ctx.pattern(99);
    assert.equal(ctx.view.pattern, 7);
    ctx.quant(3);
    ctx.hold(1);
    ctx.holdlen(9);
    ctx.holdmode(1);
    ctx.swing(80);
    ctx.grainms(5);
    ctx.midilink(2);
    ctx.enabled(0);
    const v = plain(ctx.view);
    assert.deepEqual(
        [v.quant, v.hold, v.holdlen, v.holdmode, v.swing, v.grain, v.midilink, v.enabled],
        [3, 1, 4, 1, 75, 10, 2, 0],
    );
    const L = ctx.curLayout();
    assert.equal(L.buttons.find((b) => b.id === "switch").value, "Bar");
    assert.equal(L.buttons.find((b) => b.id === "hold").value, "1 Bar");
    assert.equal(L.buttons.find((b) => b.id === "swing").value, "75");
});

test("hover marks points, handles and buttons", () => {
    const ui = fresh();
    const { ctx } = ui;
    ctx.onidle(toX(1) - 1, toY(0), 0, 0, 0, 0, 0, 0);
    assert.equal(ctx.view.hover, "pt:1");
    ctx.onidle(...button(ctx, "copy"), 0, 0, 0, 0, 0, 0);
    assert.equal(ctx.view.hover, "btn:copy");
    ctx.onidleout();
    assert.equal(ctx.view.hover, "");
});

// ---------------------------------------------------------------------------------------------------------------
// Colors and painting

test("theme colors come from [live.colors], else max.getcolor, else the built-in palette", () => {
    const { ctx } = loadUi();
    assert.deepEqual(plain(ctx.palette().disp), plain(ctx.FALLBACK.lcd_bg));
    ctx.messagename = "lcd_bg";
    ctx.anything(0.2, 0.3, 0.4, 1);
    ctx.messagename = "live_control_selection";
    ctx.anything(0.9, 0.1, 0.1, 1);
    ctx.messagename = "lcd_frame";
    ctx.anything(0.5, 0.5); // not a color: ignored
    const pal = plain(ctx.palette());
    assert.deepEqual(pal.disp, [0.2, 0.3, 0.4, 1]);
    assert.deepEqual(pal.accent, [0.9, 0.1, 0.1, 1], "a live_ prefix is dropped");
    assert.deepEqual(pal.frame, plain(ctx.FALLBACK.lcd_frame));
    const v8 = loadUi({ getcolor: (name) => (name === "live_lcd_bg" ? [0.5, 0.4, 0.3] : null) });
    assert.deepEqual(plain(v8.ctx.palette().disp), [0.5, 0.4, 0.3, 1]);
    assert.deepEqual(plain(v8.ctx.palette().btn), plain(ctx.FALLBACK.control_bg));
    const broken = loadUi({
        getcolor: () => {
            throw new Error("no such color");
        },
    });
    assert.deepEqual(plain(broken.ctx.palette().disp), plain(ctx.FALLBACK.lcd_bg));
});

test("the panel dims while the device is off", () => {
    const { ctx, mg } = loadUi();
    const colors = () => {
        mg.calls.length = 0;
        ctx.paint();
        return mg.calls.filter((c) => c[0] === "set_source_rgba").map((c) => c.slice(1).join(","));
    };
    const on = colors();
    ctx.enabled(0);
    const off = colors();
    assert.equal(on.length, off.length);
    assert.notDeepEqual(on, off);
    ctx.enabled(1);
    assert.deepEqual(colors(), on);
});

const MGRAPHICS_API = new Set([
    "init",
    "redraw",
    "set_source_rgba",
    "rectangle",
    "rectangle_rounded",
    "fill",
    "stroke",
    "move_to",
    "line_to",
    "close_path",
    "set_line_width",
    "ellipse",
    "arc",
    "select_font_face",
    "set_font_size",
    "text_measure",
    "show_text",
]);

test("paint draws every state with real mgraphics calls only", () => {
    const ui = fresh();
    const { ctx, mg } = ui;
    const peaks = ui.buffers.get("9gwpeaks").data[0];
    for (let i = 0; i < 512; i++) {
        peaks[i] = Math.abs(Math.sin(i / 9));
    }
    const states = [
        () => {},
        () => ctx.phase(0.4),
        () => ctx.active(3),
        () => ctx.setedit(1),
        () => ctx.settool(1),
        () => {
            ctx.settool(0);
            ctx.view.pop = "browser";
        },
        () => {
            ctx.view.browseCat = "Combos";
        },
        () => {
            ctx.view.pop = "quant";
        },
        () => {
            ctx.view.pop = "grid";
        },
        () => {
            ctx.view.pop = "settings";
            ctx.hold(1);
        },
        () => {
            ctx.view.pop = "";
            ctx.setgrid(4);
            ctx.patlen(0);
            ctx.view.hover = "pt:1";
        },
        () => {
            ctx.patlen(4);
            ctx.signum(7);
            ctx.sigden(8);
            ctx.setgrid(1);
            ctx.view.hover = "btn:dice";
        },
        () => ctx.enabled(0),
    ];
    for (const set of states) {
        set();
        mg.calls.length = 0;
        ctx.paint();
        const used = new Set(mg.calls.map((c) => c[0]));
        for (const name of used) {
            assert.ok(MGRAPHICS_API.has(name), `mgraphics.${name}`);
        }
        assert.ok(used.has("fill") && used.has("stroke") && used.has("show_text"));
        for (const c of mg.calls) {
            for (const v of c.slice(1)) {
                assert.ok(typeof v !== "number" || Number.isFinite(v), `${c[0]} got ${v}`);
            }
        }
    }
});
