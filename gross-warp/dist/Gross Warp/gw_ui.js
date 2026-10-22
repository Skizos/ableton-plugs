// Gross Warp: envelope editor, display and panel (jsui, mgraphics).
//
// ES5 only: Max's js/jsui engine predates ES6 (no let/const, arrows, template strings). The tests also run this file
// under node with stubs for Max's globals, so Max objects (mgraphics, Buffer, Global, box, max) are touched only inside
// functions, never while the file loads (except the guarded mgraphics.init at the end).
//
// Data: 8 patterns x 2 envelopes (0 = time, 1 = volume). An envelope is a list of points {x, u, c}:
//   x 0..1 across the pattern; the first point is at 0, the last at 1; sorted; two points may share an x (a step);
//   u 0..1 from the top of the editor (time: read offset in patterns; volume: 1 - gain);
//   c -1..1, the bend of the segment that starts at the point.
// Every change is mirrored into buffer~ ---gwenv, which gen~ reads (layout in gross_warp.genexpr). The envelopes and
// the editor's settings are this jsui's blob parameter, so Live saves them with the set (getvalueof / setvalueof).
//
// The panel (from the original Gross Warp picture): the display, then
//   [Time][Volume] [< preset v >] [point][draw][dice][flip][copy][paste]
//   [1..8 pads] [Switch] [< Hold 1/4 >] [Swing] [undo][grid][settings]
// Controls that are Live parameters (Pattern, Switch, Length, Hold, Hold length, Hold mode, Swing, Grain, MIDI link)
// are hidden live.* objects in the patcher: the panel sends "<name> <value>" out of its outlet, the object takes the
// value (so Live records automation and undo) and sends it back here and to gen~.

autowatch = 1;
inlets = 1;
outlets = 1;

var MAX_PTS = 128;
var NUM_PAT = 8;
var BLOCK = 1 + 3 * MAX_PTS;
var ENV_FRAMES = NUM_PAT * 2 * BLOCK;
var PEAK_BINS = 256;
var BLOB_MAGIC = 4757;
var BLOB_VERSION = 2;
var UNDO_DEPTH = 64;
var EPS = 1e-9;

var GRIDS = [
    { name: "Off", div: 0 },
    { name: "1/4", div: 4 },
    { name: "1/8", div: 8 },
    { name: "1/16", div: 16 },
    { name: "1/32", div: 32 },
    { name: "1/8T", div: 12 },
    { name: "1/16T", div: 24 },
];
var LENGTH_NAMES = ["1 Beat", "2 Beats", "1 Bar", "2 Bars", "4 Bars"];
var SWITCH_NAMES = ["Now", "1/16", "Beat", "Bar", "Pattern"];
var SWITCH_SHORT = ["Now", "1/16", "Beat", "Bar", "Pat"];
var HOLD_NAMES = ["1/16", "1/8", "1/4", "1/2", "1 Bar"];
var HOLD_MODES = ["Last", "Next"];
var LINK_NAMES = ["Off", "A", "B", "C", "D"];
var EVOLVE_NAMES = ["Off", "Beat", "Bar", "2 Bars", "4 Bars"];
var ENV_NAMES = ["Time", "Volume"];

// ---------------------------------------------------------------------------------------------------------------
// Envelope math (shared with gen~: shape, segment choice and evaluation must match gross_warp.genexpr exactly)

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

function near(a, b) {
    return Math.abs(a - b) < EPS;
}

function pt(x, u, c) {
    return { x: x, u: u, c: c || 0 };
}

function copyPts(pts) {
    var out = [];
    for (var i = 0; i < pts.length; i++) {
        out.push(pt(pts[i].x, pts[i].u, pts[i].c));
    }
    return out;
}

// Bend of a segment: c = 1/3 is t^2, a linear speed ramp in the time envelope (tape stop); c = -1/3 its mirror.
function shape(t, c) {
    var e = 1 + 3 * Math.abs(c);
    if (c < 0) {
        return 1 - Math.pow(1 - t, e);
    }
    return Math.pow(t, e);
}

// The segment gen~ uses at x: the last s <= n - 2 with pts[s].x <= x (right-continuous at steps).
function segmentAt(pts, x) {
    var s = 0;
    while (s < pts.length - 2 && x >= pts[s + 1].x) {
        s++;
    }
    return s;
}

function evalSeg(pts, s, x) {
    var a = pts[s];
    var b = pts[s + 1];
    var w = b.x - a.x;
    var t = w > 0.0000001 ? clamp((x - a.x) / w, 0, 1) : 1;
    return clamp(a.u + (b.u - a.u) * shape(t, a.c), 0, 1);
}

function evalEnv(pts, x) {
    return evalSeg(pts, segmentAt(pts, x), x);
}

// The level just left of x: where a step at x starts from.
function evalLeft(pts, x) {
    if (x <= 0) {
        return pts[0].u;
    }
    var i = 0;
    while (i < pts.length - 2 && pts[i + 1].x < x) {
        i++;
    }
    return evalSeg(pts, i, x);
}

// Sorted, clamped, endpoints at 0 and 1, at most two points per x, no points that change nothing, <= MAX_PTS.
function cleanEnv(src) {
    var pts = [];
    var i;
    for (i = 0; i < src.length; i++) {
        var p = src[i];
        if (!p || !isFinite(p.x) || !isFinite(p.u)) {
            continue;
        }
        pts.push({ x: clamp(p.x, 0, 1), u: clamp(p.u, 0, 1), c: clamp(isFinite(p.c) ? p.c : 0, -1, 1), k: i });
    }
    if (pts.length === 0) {
        return [pt(0, 0, 0), pt(1, 0, 0)];
    }
    pts.sort(function (a, b) {
        return a.x - b.x || a.k - b.k;
    });
    if (pts[0].x > 0) {
        pts.unshift({ x: 0, u: pts[0].u, c: 0 });
    }
    if (pts[pts.length - 1].x < 1) {
        pts.push({ x: 1, u: pts[pts.length - 1].u, c: 0 });
    }
    // Groups sharing an x: at 0 only the last point counts, at 1 only the first, inside the first and the last.
    var grouped = [];
    i = 0;
    while (i < pts.length) {
        var j = i;
        while (j + 1 < pts.length && pts[j + 1].x === pts[i].x) {
            j++;
        }
        if (pts[i].x === 0) {
            grouped.push(pt(0, pts[j].u, pts[j].c));
        } else if (pts[i].x === 1) {
            grouped.push(pt(1, pts[i].u, 0));
        } else {
            grouped.push(pt(pts[i].x, pts[i].u, pts[i].c));
            if (j > i) {
                grouped.push(pt(pts[j].x, pts[j].u, pts[j].c));
            }
        }
        i = j + 1;
    }
    // Drop a point equal to the one before it, and the middle of three on one level.
    var out = [grouped[0]];
    for (i = 1; i < grouped.length; i++) {
        var q = grouped[i];
        var prev = out[out.length - 1];
        var last = i === grouped.length - 1;
        if (!last && near(q.x, prev.x) && near(q.u, prev.u)) {
            prev.c = q.c;
            continue;
        }
        if (!last && near(q.u, prev.u) && near(grouped[i + 1].u, q.u)) {
            continue;
        }
        out.push(q);
    }
    while (out.length > MAX_PTS) {
        out.splice(out.length - 2, 1);
    }
    out[out.length - 1].c = 0;
    return out;
}

// Set the envelope to level u on [a, b), keeping the rest (the draw tool).
function setRange(pts, a, b, u) {
    a = clamp(a, 0, 1);
    b = clamp(b, 0, 1);
    if (b <= a) {
        return pts;
    }
    var left = evalLeft(pts, a);
    var right = evalEnv(pts, b);
    var rightCurve = pts[segmentAt(pts, b)].c;
    var out = [];
    var i;
    for (i = 0; i < pts.length; i++) {
        if (pts[i].x < a) {
            out.push(pt(pts[i].x, pts[i].u, pts[i].c));
        }
    }
    if (a > 0) {
        out.push(pt(a, left, 0));
    }
    out.push(pt(a, u, 0));
    out.push(pt(b, u, 0));
    if (b < 1) {
        out.push(pt(b, right, rightCurve));
    }
    for (i = 0; i < pts.length; i++) {
        if (pts[i].x > b) {
            out.push(pt(pts[i].x, pts[i].u, pts[i].c));
        }
    }
    return cleanEnv(out);
}

// The curve that puts the segment's midpoint at level m (dragging a curve handle).
function curveForMid(u0, u1, m) {
    var d = u1 - u0;
    if (Math.abs(d) < 1e-6) {
        return 0;
    }
    var r = clamp((m - u0) / d, 0.001, 0.999);
    var e;
    if (r <= 0.5) {
        e = Math.log(r) / Math.log(0.5);
        return clamp((e - 1) / 3, 0, 1);
    }
    e = Math.log(1 - r) / Math.log(0.5);
    return -clamp((e - 1) / 3, 0, 1);
}

// Upside down: time offsets become their complement, gates invert. The bends keep their sense.
function flipEnv(pts) {
    var out = [];
    for (var i = 0; i < pts.length; i++) {
        out.push(pt(pts[i].x, 1 - pts[i].u, pts[i].c));
    }
    return cleanEnv(out);
}

// An envelope from equal cells, one level per cell.
function fromCells(levels) {
    var n = levels.length;
    var pts = [pt(0, levels[0], 0)];
    for (var i = 1; i < n; i++) {
        if (levels[i] !== levels[i - 1]) {
            pts.push(pt(i / n, levels[i - 1], 0));
            pts.push(pt(i / n, levels[i], 0));
        }
    }
    pts.push(pt(1, levels[n - 1], 0));
    return cleanEnv(pts);
}

function cells(n, fn) {
    var out = [];
    for (var i = 0; i < n; i++) {
        out.push(fn(i));
    }
    return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Building blocks for time envelopes, in grid cells of a pattern of n cells. u = offset in patterns, so an offset of
// k cells is k / n. Between events the sound plays live (offset 0); at an event's end it jumps back (cross-faded).

function timeLine(n, events) {
    var pts = [pt(0, 0)];
    events.sort(function (a, b) {
        return a.at - b.at;
    });
    for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        var a = ev.at / n;
        var b = (ev.at + ev.len) / n;
        pts.push(pt(a, 0));
        var seg = ev.points(n);
        for (var j = 0; j < seg.length; j++) {
            pts.push(pt(a + seg[j][0] * (b - a), seg[j][1] / n, seg[j][2] || 0));
        }
        pts.push(pt(b, 0));
    }
    pts.push(pt(1, 0));
    return cleanEnv(pts);
}

// Repeat the slice of `size` cells that starts the event, for `len` cells.
function evStutter(at, len, size) {
    return {
        at: at,
        len: len,
        points: function () {
            var out = [];
            for (var j = 0; j < len; j++) {
                var off = j - (j % size);
                out.push([j / len, off]);
                out.push([(j + 1) / len, off]);
            }
            return out;
        },
    };
}

// Half speed (or another slower speed) over the event: the offset grows by (1 - speed) per cell.
function evSlow(at, len, speed, curve) {
    return {
        at: at,
        len: len,
        points: function () {
            return [
                [0, 0, curve || 0],
                [1, len * (1 - speed)],
            ];
        },
    };
}

// Tape stop: speed falls linearly from 1 to 0 (offset len / 2, curve t^2).
function evStop(at, len) {
    return evSlow(at, len, 0.5, 1 / 3);
}

// Tape start: speed rises from 0 to 1.
function evStart(at, len) {
    return evSlow(at, len, 0.5, -1 / 3);
}

// Backwards at normal speed: the offset grows by 2 per cell.
function evReverse(at, len) {
    return {
        at: at,
        len: len,
        points: function () {
            return [
                [0, 0],
                [1, 2 * len],
            ];
        },
    };
}

// Faster than live (pitch up): starts `len * (speed - 1)` cells late and catches up.
function evFast(at, len, speed) {
    return {
        at: at,
        len: len,
        points: function () {
            return [
                [0, len * (speed - 1)],
                [1, 0],
            ];
        },
    };
}

// Back and forth: `times` scratches over the event, each `depth` cells deep.
function evScratch(at, len, times, depth) {
    return {
        at: at,
        len: len,
        points: function () {
            var out = [];
            for (var k = 0; k < times; k++) {
                out.push([k / times, 0, -1 / 3]);
                out.push([(k + 0.5) / times, depth, 1 / 3]);
            }
            out.push([1, 0]);
            return out;
        },
    };
}

// A constant delay of `cellsLate` cells.
function evDelay(at, len, cellsLate) {
    return {
        at: at,
        len: len,
        points: function () {
            return [
                [0, cellsLate],
                [1, cellsLate],
            ];
        },
    };
}

// Replays earlier slices in another order: order[j] = which cell (counted back from the event start) to play.
function evChop(at, order) {
    return {
        at: at,
        len: order.length,
        points: function () {
            var out = [];
            for (var j = 0; j < order.length; j++) {
                var off = j + order[j];
                out.push([j / order.length, off]);
                out.push([(j + 1) / order.length, off]);
            }
            return out;
        },
    };
}

// Volume: levels per cell, 1 = on.
function gate(levels) {
    return fromCells(
        levels.map(function (v) {
            return 1 - v;
        }),
    );
}

function euclid(k, n, rotate) {
    var out = [];
    for (var i = 0; i < n; i++) {
        out.push(((i + (rotate || 0)) * k) % n < k ? 1 : 0);
    }
    return out;
}

// A duck at the start of every `per` of the pattern that recovers over `release` of it.
function pump(per, depth, release) {
    var p = [];
    for (var b = 0; b < per; b++) {
        p.push(pt(b / per, 0, 0));
        p.push(pt(b / per, depth, -1 / 3));
        p.push(pt(b / per + release / per, 0, 0));
    }
    p.push(pt(1, 0));
    return cleanEnv(p);
}

function ramps(per, rising, curve) {
    var p = [];
    for (var b = 0; b < per; b++) {
        p.push(pt(b / per, rising ? 1 : 0, curve));
        p.push(pt((b + 1) / per, rising ? 0 : 1, 0));
        p.push(pt((b + 1) / per, rising ? 1 : 0, curve));
    }
    return cleanEnv(p);
}

// ---------------------------------------------------------------------------------------------------------------
// Presets, in categories. Time: u = how far behind "now" the audio plays, in patterns. Volume: u = 1 - gain.
// Made for a 1-bar pattern in 4/4: n = 16 cells are sixteenths, 32 are thirty-seconds; they scale with Length.

var TRANCE = [1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 1];

function T(name, cat, make) {
    return { name: name, cat: cat, make: make };
}

var TIME_PRESETS = [
    T("Normal", "Normal", function () {
        return [pt(0, 0), pt(1, 0)];
    }),
    T("Stutter 1/4", "Stutter", function () {
        return fromCells(
            cells(16, function (i) {
                return i <= 12 ? 0 : (i - 12) / 16;
            }),
        );
    }),
    T("Stutter 1/8 End", "Stutter", function () {
        return timeLine(16, [evStutter(12, 4, 2)]);
    }),
    T("Stutter Beat 2", "Stutter", function () {
        return timeLine(16, [evStutter(4, 4, 1)]);
    }),
    T("Stutter Beats", "Stutter", function () {
        return timeLine(16, [evStutter(0, 4, 2), evStutter(8, 4, 2)]);
    }),
    T("Stutter 1/32 End", "Stutter", function () {
        return timeLine(32, [evStutter(24, 8, 1)]);
    }),
    T("Half Time", "Half", function () {
        return [pt(0, 0), pt(1, 0.5)];
    }),
    T("Half Time 1/2", "Half", function () {
        return [pt(0, 0), pt(0.5, 0.25), pt(0.5, 0), pt(1, 0.25)];
    }),
    T("Half Beats", "Half", function () {
        return timeLine(16, [evSlow(0, 4, 0.5), evSlow(4, 4, 0.5), evSlow(8, 4, 0.5), evSlow(12, 4, 0.5)]);
    }),
    T("Half Last Beat", "Half", function () {
        return timeLine(16, [evSlow(12, 4, 0.5)]);
    }),
    T("Quarter Speed", "Half", function () {
        return [pt(0, 0), pt(1, 0.75)];
    }),
    T("Tape Stop", "Stop", function () {
        return [pt(0, 0), pt(0.5, 0, 1 / 3), pt(1, 0.25)];
    }),
    T("Tape Stop Bar", "Stop", function () {
        return [pt(0, 0, 1 / 3), pt(1, 0.5)];
    }),
    T("Stop Last Beat", "Stop", function () {
        return timeLine(16, [evStop(12, 4)]);
    }),
    T("Stop Beats", "Stop", function () {
        return timeLine(16, [evStop(2, 2), evStop(6, 2), evStop(10, 2), evStop(14, 2)]);
    }),
    T("Brake", "Stop", function () {
        return timeLine(16, [evStop(8, 8)]);
    }),
    T("Reverse 1/2", "Reverse", function () {
        return [pt(0, 0), pt(0.5, 0), pt(1, 1)];
    }),
    T("Reverse Beats", "Reverse", function () {
        return [pt(0, 0), pt(0.25, 0.5), pt(0.25, 0), pt(0.5, 0.5), pt(0.5, 0), pt(0.75, 0.5), pt(0.75, 0), pt(1, 0.5)];
    }),
    T("Reverse Last Beat", "Reverse", function () {
        return timeLine(16, [evReverse(12, 4)]);
    }),
    T("Reverse 1/8s", "Reverse", function () {
        return timeLine(16, [evReverse(2, 2), evReverse(6, 2), evReverse(10, 2), evReverse(14, 2)]);
    }),
    T("Scratch", "Scratch", function () {
        var p = [];
        for (var b = 0; b < 4; b++) {
            p.push(pt(b / 4, 0, -1 / 3));
            p.push(pt(b / 4 + 0.125, 0.2, 1 / 3));
        }
        p.push(pt(1, 0));
        return p;
    }),
    T("Scratch Fast", "Scratch", function () {
        return timeLine(16, [evScratch(0, 16, 8, 1.5)]);
    }),
    T("Scratch Last Beat", "Scratch", function () {
        return timeLine(16, [evScratch(12, 4, 2, 1)]);
    }),
    T("Baby Scratch", "Scratch", function () {
        return timeLine(16, [evScratch(8, 8, 4, 0.75)]);
    }),
    T("Chop Back", "Chop", function () {
        return timeLine(16, [evChop(8, [4, 4, 6, 6, 2, 2, 8, 8])]);
    }),
    T("Chop Swap", "Chop", function () {
        return timeLine(16, [evChop(4, [4, 4, 4, 4]), evChop(12, [4, 4, 4, 4])]);
    }),
    T("Chop Repeat", "Chop", function () {
        return timeLine(16, [evChop(8, [8, 8, 8, 8, 8, 8, 8, 8])]);
    }),
    T("Glitch", "Glitch", function () {
        return timeLine(32, [evStutter(14, 2, 1), evStutter(22, 4, 1), evStutter(28, 4, 1)]);
    }),
    T("Glitch Reverse", "Glitch", function () {
        return timeLine(32, [evReverse(12, 2), evStutter(24, 4, 1), evReverse(30, 2)]);
    }),
    T("Glitch Stops", "Glitch", function () {
        return timeLine(32, [evStop(6, 2), evStop(14, 2), evStop(22, 2), evStutter(28, 4, 1)]);
    }),
    T("1/16 Roll", "Build", function () {
        return fromCells(
            cells(16, function (i) {
                return i <= 8 ? 0 : (i - 8) / 16;
            }),
        );
    }),
    T("Roll Build", "Build", function () {
        return fromCells(
            cells(32, function (i) {
                if (i < 16) {
                    return 0;
                }
                if (i < 24) {
                    return Math.floor((i - 16) / 2) / 16;
                }
                return 0.25 + (i - 24) / 32;
            }),
        );
    }),
    T("Build 1/8 > 1/32", "Build", function () {
        return timeLine(32, [evStutter(0, 16, 4), evStutter(16, 8, 2), evStutter(24, 8, 1)]);
    }),
    T("Tape Start", "Tape", function () {
        return [pt(0, 0, -1 / 3), pt(1, 0.5)];
    }),
    T("Slow > Fast", "Tape", function () {
        return [pt(0, 0), pt(0.5, 0.25), pt(1, 0)];
    }),
    T("Wobble", "Tape", function () {
        return timeLine(16, [evSlow(0, 4, 0.75), evFast(4, 4, 1.25), evSlow(8, 4, 0.75), evFast(12, 4, 1.25)]);
    }),
    T("Start Each Beat", "Tape", function () {
        return timeLine(16, [evStart(0, 4), evStart(4, 4), evStart(8, 4), evStart(12, 4)]);
    }),
    T("Octave Up 1/8", "Pitch", function () {
        return timeLine(16, [evFast(14, 2, 2)]);
    }),
    T("Octave Up Beats", "Pitch", function () {
        return timeLine(16, [evFast(2, 2, 2), evFast(6, 2, 2), evFast(10, 2, 2), evFast(14, 2, 2)]);
    }),
    T("Octave Down Beat", "Pitch", function () {
        return timeLine(16, [evSlow(12, 4, 0.5)]);
    }),
    T("Pitch Arp", "Pitch", function () {
        return timeLine(16, [evSlow(4, 4, 0.5), evFast(10, 2, 2), evSlow(12, 4, 0.75)]);
    }),
    T("Delay 1/8", "Delay", function () {
        return [pt(0, 0.125), pt(1, 0.125)];
    }),
    T("Delay 1/16", "Delay", function () {
        return [pt(0, 0.0625), pt(1, 0.0625)];
    }),
    T("Delay Beat", "Delay", function () {
        return [pt(0, 0.25), pt(1, 0.25)];
    }),
    T("Echo Last Beat", "Delay", function () {
        return timeLine(16, [evDelay(12, 4, 3)]);
    }),
];

var VOL_PRESETS = [
    T("Normal", "Normal", function () {
        return [pt(0, 0), pt(1, 0)];
    }),
    T("Gate 1/8", "Gate", function () {
        return fromCells(
            cells(16, function (i) {
                return i % 2;
            }),
        );
    }),
    T("Gate 1/16", "Gate", function () {
        return fromCells(
            cells(32, function (i) {
                return i % 2;
            }),
        );
    }),
    T("Gate 3/16", "Gate", function () {
        return gate(
            cells(16, function (i) {
                return i % 3 === 0 ? 1 : 0;
            }),
        );
    }),
    T("Gate 1/32 End", "Gate", function () {
        return gate(
            cells(32, function (i) {
                return i < 24 ? 1 : 1 - (i % 2);
            }),
        );
    }),
    T("Pump 1/4", "Pump", function () {
        var p = [];
        for (var b = 0; b < 4; b++) {
            p.push(pt(b / 4, 0, 0));
            p.push(pt(b / 4, 0.9, -1 / 3));
            p.push(pt(b / 4 + 0.2, 0, 0));
        }
        p.push(pt(1, 0));
        return cleanEnv(p);
    }),
    T("Pump 1/8", "Pump", function () {
        return pump(8, 0.85, 0.7);
    }),
    T("Pump Soft", "Pump", function () {
        return pump(4, 0.5, 0.9);
    }),
    T("Pump Half", "Pump", function () {
        return pump(2, 0.9, 0.5);
    }),
    T("Trance Gate", "Trance", function () {
        return fromCells(
            cells(16, function (i) {
                return 1 - TRANCE[i];
            }),
        );
    }),
    T("Trance 2", "Trance", function () {
        return gate([1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1]);
    }),
    T("Trance 3", "Trance", function () {
        return gate([1, 0, 0, 1, 1, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 1]);
    }),
    T("Stutter 1/16", "Stutter", function () {
        return gate(
            cells(16, function (i) {
                return i < 12 ? 1 : i % 2 ? 0 : 1;
            }),
        );
    }),
    T("Stutter End", "Stutter", function () {
        return gate(
            cells(32, function (i) {
                return i < 28 ? 1 : i % 2 ? 0 : 1;
            }),
        );
    }),
    T("Off-Beat", "Rhythm", function () {
        return fromCells(
            cells(8, function (i) {
                return i % 2 === 0 ? 1 : 0;
            }),
        );
    }),
    T("Euclid 5/16", "Rhythm", function () {
        return gate(euclid(5, 16, 0));
    }),
    T("Euclid 7/16", "Rhythm", function () {
        return gate(euclid(7, 16, 0));
    }),
    T("Clave", "Rhythm", function () {
        return gate([1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0]);
    }),
    T("Triplet Gate", "Triplet", function () {
        return gate(
            cells(12, function (i) {
                return i % 2 === 0 ? 1 : 0;
            }),
        );
    }),
    T("Triplet Shuffle", "Triplet", function () {
        return gate(
            cells(12, function (i) {
                return i % 3 === 1 ? 0 : 1;
            }),
        );
    }),
    T("Triplet 1/16", "Triplet", function () {
        return gate(
            cells(24, function (i) {
                return i % 3 === 2 ? 0 : 1;
            }),
        );
    }),
    T("Fade In", "Fade", function () {
        return [pt(0, 1), pt(1, 0)];
    }),
    T("Fade Out", "Fade", function () {
        return [pt(0, 0), pt(1, 1)];
    }),
    T("Swell 1/2", "Fade", function () {
        return [pt(0, 1, 1 / 3), pt(0.5, 0), pt(0.5, 1, 1 / 3), pt(1, 0)];
    }),
    T("Fade Last Beat", "Fade", function () {
        return [pt(0, 0), pt(0.75, 0, 1 / 3), pt(1, 1)];
    }),
    T("Chop Last Beat", "Cut", function () {
        return fromCells(
            cells(32, function (i) {
                return i < 24 ? 0 : i % 2;
            }),
        );
    }),
    T("Cut Beat 4", "Cut", function () {
        return gate(
            cells(16, function (i) {
                return i < 12 ? 1 : 0;
            }),
        );
    }),
    T("Cut 2 & 4", "Cut", function () {
        return gate(
            cells(16, function (i) {
                return (i >= 4 && i < 6) || (i >= 12 && i < 14) ? 0 : 1;
            }),
        );
    }),
    T("Saw 1/4", "Shape", function () {
        return ramps(4, false, 0);
    }),
    T("Ramp Up 1/4", "Shape", function () {
        return ramps(4, true, -1 / 3);
    }),
    T("Triangle 1/2", "Shape", function () {
        return cleanEnv([pt(0, 1), pt(0.25, 0), pt(0.5, 1), pt(0.75, 0), pt(1, 1)]);
    }),
];

var PRESETS = [TIME_PRESETS, VOL_PRESETS];

// Combos set both envelopes.
var COMBOS = [
    { name: "Roll + Gate", time: "1/16 Roll", vol: "Gate 1/32 End" },
    { name: "Stop + Fade", time: "Tape Stop", vol: "Fade Last Beat" },
    { name: "Half + Pump", time: "Half Time", vol: "Pump 1/4" },
    { name: "Stutter Trance", time: "Stutter 1/4", vol: "Trance Gate" },
    { name: "Scratch Pump", time: "Scratch", vol: "Pump 1/4" },
    { name: "Reverse Swell", time: "Reverse 1/2", vol: "Swell 1/2" },
    { name: "Glitch Chop", time: "Glitch", vol: "Chop Last Beat" },
    { name: "Build Up", time: "Build 1/8 > 1/32", vol: "Fade In" },
    { name: "Wobble Triplets", time: "Wobble", vol: "Triplet Shuffle" },
];

// Pattern slots 1-8 start as useful pairs (time preset, volume preset).
var DEFAULT_SLOTS = [
    ["Normal", "Normal"],
    ["Half Time", "Normal"],
    ["1/16 Roll", "Normal"],
    ["Tape Stop", "Normal"],
    ["Reverse 1/2", "Normal"],
    ["Normal", "Gate 1/16"],
    ["Stutter 1/4", "Trance Gate"],
    ["Scratch", "Pump 1/4"],
];

// Names of version 1's preset lists, by index, so its saved preset numbers keep their names.
var V1_NAMES = [
    [
        "Normal",
        "Half Time",
        "Half Time 1/2",
        "Tape Stop",
        "Tape Stop Bar",
        "Tape Start",
        "Reverse 1/2",
        "Reverse Beats",
        "1/16 Roll",
        "Stutter 1/4",
        "Roll Build",
        "Scratch",
        "Slow > Fast",
        "Delay 1/8",
    ],
    [
        "Normal",
        "Gate 1/8",
        "Gate 1/16",
        "Trance Gate",
        "Pump 1/4",
        "Fade In",
        "Fade Out",
        "Off-Beat",
        "Chop Last Beat",
        "Swell 1/2",
    ],
];

function presetIndex(env, name) {
    var list = PRESETS[env];
    for (var i = 0; i < list.length; i++) {
        if (list[i].name === name) {
            return i;
        }
    }
    return -1;
}

function makePreset(env, i) {
    return cleanEnv(PRESETS[env][i].make());
}

// The categories of an envelope's presets, in order, with "Combos" first.
function categories(env) {
    var out = ["Combos"];
    var list = PRESETS[env];
    for (var i = 0; i < list.length; i++) {
        if (out.indexOf(list[i].cat) < 0) {
            out.push(list[i].cat);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------------------------------------------
// State

function defaultState() {
    var st = { pats: [], preset: [], edit: 0, tool: 0, grid: 3, evolve: 0 };
    for (var p = 0; p < NUM_PAT; p++) {
        var ti = presetIndex(0, DEFAULT_SLOTS[p][0]);
        var vi = presetIndex(1, DEFAULT_SLOTS[p][1]);
        st.pats.push([makePreset(0, ti), makePreset(1, vi)]);
        st.preset.push([ti, vi]);
    }
    return st;
}

var S = defaultState();
// The panel's view of the Live parameters (they come back from the hidden live.* objects) and of the playback.
var view = {
    pattern: 0,
    active: 0,
    phase: -1,
    patlen: 2,
    signum: 4,
    sigden: 4,
    quant: 4,
    hold: 0,
    holdlen: 2,
    holdmode: 0,
    swing: 0,
    grain: 60,
    midilink: 0,
    enabled: 1,
    pop: "",
    browseCat: "",
    hover: "",
};
var drag = null;
var undoStack = [];
var redoStack = [];
var localClip = null;
var themeColors = {};
var rng = 1;
var evolveMark = -1;
var lastPhase = -1;
var wraps = 0;

var envBuf = null;
var peakBuf = null;
var chanBase = 1;

// Blob: [magic, version, edit, tool, grid, evolve, then per pattern and envelope: preset, n, n x (x, u, c)].
// Version 1 had swing where evolve is (swing is a Live parameter now) and older preset numbers.
function serialize() {
    var out = [BLOB_MAGIC, BLOB_VERSION, S.edit, S.tool, S.grid, S.evolve];
    for (var p = 0; p < NUM_PAT; p++) {
        for (var e = 0; e < 2; e++) {
            var pts = S.pats[p][e];
            out.push(S.preset[p][e], pts.length);
            for (var i = 0; i < pts.length; i++) {
                out.push(pts[i].x, pts[i].u, pts[i].c);
            }
        }
    }
    return out;
}

// Returns the state, or null when the blob is not one of ours (then the caller keeps what it has).
function deserialize(a) {
    if (!a || a.length < 6 || a[0] !== BLOB_MAGIC || (a[1] !== 1 && a[1] !== BLOB_VERSION)) {
        return null;
    }
    var v1 = a[1] === 1;
    var st = {
        pats: [],
        preset: [],
        edit: clamp(Math.floor(a[2]), 0, 1),
        tool: clamp(Math.floor(a[3]), 0, 1),
        grid: clamp(Math.floor(a[4]), 0, GRIDS.length - 1),
        evolve: v1 ? 0 : clamp(Math.floor(a[5]), 0, EVOLVE_NAMES.length - 1),
    };
    var k = 6;
    for (var p = 0; p < NUM_PAT; p++) {
        var pair = [];
        var pre = [];
        for (var e = 0; e < 2; e++) {
            if (k + 2 > a.length) {
                return null;
            }
            var preset = Math.floor(a[k]);
            var n = Math.floor(a[k + 1]);
            k += 2;
            if (n < 2 || n > MAX_PTS || k + 3 * n > a.length) {
                return null;
            }
            var pts = [];
            for (var i = 0; i < n; i++) {
                pts.push(pt(Number(a[k]), Number(a[k + 1]), Number(a[k + 2])));
                k += 3;
            }
            pair.push(cleanEnv(pts));
            if (v1) {
                preset = preset >= 0 && preset < V1_NAMES[e].length ? presetIndex(e, V1_NAMES[e][preset]) : -1;
            }
            pre.push(preset >= -1 && preset < PRESETS[e].length ? preset : -1);
        }
        st.pats.push(pair);
        st.preset.push(pre);
    }
    return st;
}

// ---------------------------------------------------------------------------------------------------------------
// Buffers: the envelopes go out to gen~, the waveform peaks come back from it.

function bufPoke(buf, frame, values) {
    try {
        buf.poke(chanBase, frame, values);
    } catch (err) {
        for (var i = 0; i < values.length; i++) {
            buf.poke(chanBase, frame + i, values[i]);
        }
    }
}

function firstValue(v) {
    return v && typeof v === "object" ? v[0] : v;
}

// Max's JS Buffer numbers channels from 1; try that, and fall back to 0 if a test write does not read back.
function detectChannelBase(buf) {
    var probe = 4757.25;
    var bases = [1, 0];
    for (var i = 0; i < bases.length; i++) {
        try {
            buf.poke(bases[i], 0, probe);
            if (firstValue(buf.peek(bases[i], 0, 1)) === probe) {
                return bases[i];
            }
        } catch (err) {
            // try the next numbering
        }
    }
    return 1;
}

function writeEnv(p, e) {
    if (!envBuf) {
        return;
    }
    var pts = S.pats[p][e];
    var base = (p * 2 + e) * BLOCK;
    var flat = [];
    for (var i = 0; i < pts.length; i++) {
        flat.push(pts[i].x, pts[i].u, pts[i].c);
    }
    bufPoke(envBuf, base + 1, flat);
    bufPoke(envBuf, base, [pts.length]);
}

function writeAll() {
    for (var p = 0; p < NUM_PAT; p++) {
        writeEnv(p, 0);
        writeEnv(p, 1);
    }
}

function envbuf(name) {
    envBuf = new Buffer(String(name));
    try {
        if (envBuf.framecount() < ENV_FRAMES) {
            envBuf.send("sizeinsamps", ENV_FRAMES);
        }
    } catch (err) {
        post("gross warp: could not size " + name + "\n");
    }
    chanBase = detectChannelBase(envBuf);
    writeAll();
    sendSwingUnit();
}

function peakbuf(name) {
    peakBuf = new Buffer(String(name));
}

function readPeaks() {
    if (!peakBuf) {
        return null;
    }
    try {
        var v = peakBuf.peek(chanBase, 0, 2 * PEAK_BINS);
        return v && v.length === 2 * PEAK_BINS ? v : null;
    } catch (err) {
        return null;
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Out to the patcher: a Live parameter's new value ("<name> <value>", routed to its live.* object), or swunit for
// gen~. The parameter comes back through its message below, which is when the panel shows it.

function sendOut(name, value) {
    try {
        outlet(0, name, value);
    } catch (err) {
        // not in Max (tests)
    }
}

function sendParam(name, value) {
    sendOut(name, value);
}

// gen~'s swing works on the editor's grid step, in quarter notes (a sixteenth when the grid is off).
function swingUnit() {
    var g = GRIDS[S.grid];
    return g.div > 0 ? 4 / g.div : 0.25;
}

function sendSwingUnit() {
    sendOut("swunit", swingUnit());
}

// ---------------------------------------------------------------------------------------------------------------
// Messages from the patcher

function pattern(i) {
    view.pattern = clamp(Math.floor(i), 0, NUM_PAT - 1);
    redraw();
}

function active(i) {
    view.active = clamp(Math.floor(i), 0, NUM_PAT - 1);
    redraw();
}

// The playhead; it also drives Evolve.
function phase(v) {
    if (v >= 0 && lastPhase >= 0 && v < lastPhase - 0.5) {
        wraps++;
    }
    lastPhase = v;
    view.phase = v;
    evolveTick();
    redraw();
}

function patlen(i) {
    view.patlen = clamp(Math.floor(i), 0, LENGTH_NAMES.length - 1);
    redraw();
}

// Live's time signature (from the Live API); beats are quarter notes, as in Live's song time.
function signum(n) {
    view.signum = clamp(Math.floor(n), 1, 32);
    redraw();
}

function sigden(d) {
    view.sigden = clamp(Math.floor(d), 1, 32);
    redraw();
}

function quant(i) {
    view.quant = clamp(Math.floor(i), 0, SWITCH_NAMES.length - 1);
    redraw();
}

function hold(v) {
    view.hold = v > 0 ? 1 : 0;
    redraw();
}

function holdlen(i) {
    view.holdlen = clamp(Math.floor(i), 0, HOLD_NAMES.length - 1);
    redraw();
}

function holdmode(i) {
    view.holdmode = clamp(Math.floor(i), 0, 1);
    redraw();
}

function swing(v) {
    view.swing = clamp(Math.round(v), 0, 75);
    redraw();
}

function grainms(v) {
    view.grain = clamp(Math.round(v), 10, 250);
    redraw();
}

function midilink(i) {
    view.midilink = clamp(Math.floor(i), 0, LINK_NAMES.length - 1);
    redraw();
}

// live.thisdevice: the device is switched on (1) or off (0).
function enabled(v) {
    view.enabled = v ? 1 : 0;
    redraw();
}

function bang() {
    redraw();
}

function loadbang() {
    sendSwingUnit();
    redraw();
}

// [live.colors]: "<color id> r g b a" for each color of Live's theme (its "everything" dump, and again on a change).
function anything() {
    var a = arrayfromargs(arguments);
    var id = typeof messagename === "undefined" ? "" : String(messagename).replace(/^live_/, "");
    if (id !== "" && a.length === 4 && typeof a[0] === "number") {
        themeColors[id] = [a[0], a[1], a[2], a[3]];
        redraw();
    }
}

// Live stores the blob with the set; Max asks for it with getvalueof and restores it with setvalueof.
function getvalueof() {
    return serialize();
}

function setvalueof() {
    var st = deserialize(arrayfromargs(arguments));
    if (st) {
        S = st;
        undoStack = [];
        redoStack = [];
        writeAll();
        sendSwingUnit();
        redraw();
    }
}

// Tell Live the blob changed: only for envelope edits that are finished (mouse-up, a preset, paste...), never during
// a drag, for view settings or from Evolve, so Live's undo history gets one step per edit.
function changed() {
    try {
        notifyclients();
    } catch (err) {
        // not under pattr/Live (tests)
    }
}

function redraw() {
    if (typeof mgraphics !== "undefined") {
        mgraphics.redraw();
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Editing commands (also reachable as messages). Undo steps hold one or more envelopes.

function curPts() {
    return S.pats[view.pattern][S.edit];
}

function snapshot(p, e) {
    return { p: p, e: e, pts: copyPts(S.pats[p][e]), preset: S.preset[p][e] };
}

function pushUndoItems(items) {
    undoStack.push(items);
    if (undoStack.length > UNDO_DEPTH) {
        undoStack.shift();
    }
    redoStack = [];
}

function pushUndo(p, e) {
    pushUndoItems([snapshot(p, e)]);
}

function pushUndoPattern(p) {
    pushUndoItems([snapshot(p, 0), snapshot(p, 1)]);
}

function restore(items) {
    for (var i = 0; i < items.length; i++) {
        var s = items[i];
        S.pats[s.p][s.e] = copyPts(s.pts);
        S.preset[s.p][s.e] = s.preset;
        writeEnv(s.p, s.e);
    }
    if (items.length === 1) {
        S.edit = items[0].e;
    }
    changed();
    redraw();
}

function current(items) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
        out.push(snapshot(items[i].p, items[i].e));
    }
    return out;
}

function doundo() {
    if (undoStack.length === 0) {
        return;
    }
    var items = undoStack.pop();
    redoStack.push(current(items));
    restore(items);
}

function doredo() {
    if (redoStack.length === 0) {
        return;
    }
    var items = redoStack.pop();
    undoStack.push(current(items));
    restore(items);
}

function setEnvOf(p, e, pts, preset) {
    S.pats[p][e] = cleanEnv(pts);
    S.preset[p][e] = preset;
    writeEnv(p, e);
}

// Replace the edited envelope as one undoable step.
function replaceCur(pts, preset) {
    pushUndo(view.pattern, S.edit);
    setEnvOf(view.pattern, S.edit, pts, preset);
    changed();
    redraw();
}

function dopreset(i) {
    var e = S.edit;
    i = Math.floor(i);
    if (i < 0 || i >= PRESETS[e].length) {
        return;
    }
    replaceCur(makePreset(e, i), i);
}

// A combo sets both envelopes of the shown pattern.
function docombo(i) {
    var c = COMBOS[Math.floor(i)];
    if (!c) {
        return;
    }
    var p = view.pattern;
    var ti = presetIndex(0, c.time);
    var vi = presetIndex(1, c.vol);
    pushUndoPattern(p);
    setEnvOf(p, 0, makePreset(0, ti), ti);
    setEnvOf(p, 1, makePreset(1, vi), vi);
    changed();
    redraw();
}

function stepPreset(dir) {
    var n = PRESETS[S.edit].length;
    var cur = S.preset[view.pattern][S.edit];
    var next = cur < 0 ? (dir > 0 ? 0 : n - 1) : (cur + dir + n) % n;
    dopreset(next);
}

function nextpreset() {
    stepPreset(1);
}

function prevpreset() {
    stepPreset(-1);
}

function doclear() {
    replaceCur([pt(0, 0), pt(1, 0)], 0);
}

function doflip() {
    replaceCur(flipEnv(curPts()), -1);
}

function clipboard() {
    try {
        return new Global("grosswarp_clipboard");
    } catch (err) {
        if (!localClip) {
            localClip = {};
        }
        return localClip;
    }
}

// The clipboard is shared by every Gross Warp in Live (a Max Global), as plain numbers.
function docopy() {
    var pts = curPts();
    var flat = [];
    for (var i = 0; i < pts.length; i++) {
        flat.push(pts[i].x, pts[i].u, pts[i].c);
    }
    clipboard().points = flat;
    redraw();
}

function hasClip() {
    var c = clipboard().points;
    return !!(c && c.length >= 6);
}

function dopaste() {
    if (!hasClip()) {
        return;
    }
    var flat = clipboard().points;
    var pts = [];
    for (var i = 0; i + 2 < flat.length; i += 3) {
        pts.push(pt(flat[i], flat[i + 1], flat[i + 2]));
    }
    replaceCur(pts, -1);
}

// Copy the shown pattern (both envelopes) into pattern `to` (Alt-click on a pad).
function copypattern(to) {
    to = clamp(Math.floor(to), 0, NUM_PAT - 1);
    var from = view.pattern;
    if (to === from) {
        return;
    }
    pushUndoPattern(to);
    for (var e = 0; e < 2; e++) {
        setEnvOf(to, e, copyPts(S.pats[from][e]), S.preset[from][e]);
    }
    changed();
    redraw();
}

function setedit(e) {
    S.edit = clamp(Math.floor(e), 0, 1);
    view.pop = "";
    redraw();
}

function settool(t) {
    S.tool = clamp(Math.floor(t), 0, 1);
    redraw();
}

function setgrid(g) {
    S.grid = clamp(Math.floor(g), 0, GRIDS.length - 1);
    sendSwingUnit();
    redraw();
}

function setevolve(i) {
    S.evolve = clamp(Math.floor(i), 0, EVOLVE_NAMES.length - 1);
    evolveMark = -1;
    redraw();
}

// ---------------------------------------------------------------------------------------------------------------
// Dice, Mutate and Evolve: new musical patterns from the building blocks above, on the grid.

function setseed(n) {
    rng = (Math.floor(n) % 2147483646) + 1;
}

function rand() {
    rng = (rng * 16807) % 2147483647;
    return (rng - 1) / 2147483646;
}

function pick(list) {
    return list[Math.floor(rand() * list.length) % list.length];
}

// A time envelope with one to three events in the second half of the pattern or on beat ends.
function diceTime(n) {
    var events = [];
    var count = 1 + Math.floor(rand() * 3);
    var spots = [n / 2, (3 * n) / 4, n / 4, (3 * n) / 8, (7 * n) / 8, (5 * n) / 8];
    var used = [];
    for (var i = 0; i < count; i++) {
        // whole cells, so every event starts and ends on the grid (triplet grids round eighths to a cell)
        var at = Math.round(pick(spots));
        var len = Math.min(Math.max(1, Math.round(pick([n / 8, n / 4, n / 4, n / 2]))), n - at);
        var clash = false;
        for (var j = 0; j < used.length; j++) {
            if (at < used[j][1] && used[j][0] < at + len) {
                clash = true;
            }
        }
        if (clash || len < 1) {
            continue;
        }
        used.push([at, at + len]);
        var kind = pick(["stutter", "stutter", "half", "stop", "reverse", "scratch", "fast", "chop"]);
        if (kind === "stutter") {
            events.push(evStutter(at, len, pick([1, 1, 2, Math.max(1, Math.floor(len / 2))])));
        } else if (kind === "half") {
            events.push(evSlow(at, len, 0.5));
        } else if (kind === "stop") {
            events.push(evStop(at, len));
        } else if (kind === "reverse") {
            events.push(evReverse(at, len));
        } else if (kind === "scratch") {
            events.push(evScratch(at, len, pick([1, 2, 4]), Math.max(0.5, len / 4)));
        } else if (kind === "fast") {
            events.push(evFast(at, len, 2));
        } else {
            events.push(
                evChop(
                    at,
                    cells(len, function () {
                        return Math.min(at, pick([len, len, 2 * len]));
                    }),
                ),
            );
        }
    }
    return timeLine(n, events);
}

function diceVolume(n) {
    var kind = pick(["normal", "normal", "euclid", "trance", "pump", "gate", "cut"]);
    if (kind === "normal") {
        return [pt(0, 0), pt(1, 0)];
    }
    if (kind === "euclid") {
        return gate(euclid(pick([5, 7, 9, 11, 13]), n, Math.floor(rand() * 4)));
    }
    if (kind === "trance") {
        return gate(
            cells(n, function (i) {
                return i % 4 === 0 || rand() > 0.35 ? 1 : 0;
            }),
        );
    }
    if (kind === "pump") {
        return pump(pick([2, 4, 8]), 0.5 + rand() * 0.4, 0.5 + rand() * 0.4);
    }
    if (kind === "gate") {
        return gate(
            cells(n, function (i) {
                return i < n - pick([4, 8]) ? 1 : 1 - (i % 2);
            }),
        );
    }
    return gate(
        cells(n, function (i) {
            return i >= (3 * n) / 4 && i < (3 * n) / 4 + n / 8 ? 0 : 1;
        }),
    );
}

function diceCells() {
    var g = gridCells();
    return g >= 4 && g <= 32 && g === Math.round(g) ? g : 16;
}

// A new pattern for pattern p (both envelopes); `undoable` false for Evolve.
function dicePattern(p, undoable) {
    var n = diceCells();
    if (undoable) {
        pushUndoPattern(p);
    }
    setEnvOf(p, 0, diceTime(n), -1);
    setEnvOf(p, 1, diceVolume(n), -1);
}

// A smaller change: one envelope of pattern p is rolled again.
function mutatePattern(p, undoable) {
    var n = diceCells();
    var e = rand() < 0.6 ? 0 : 1;
    if (undoable) {
        pushUndo(p, e);
    }
    setEnvOf(p, e, e === 0 ? diceTime(n) : diceVolume(n), -1);
}

function dodice() {
    dicePattern(view.pattern, true);
    changed();
    redraw();
}

function domutate() {
    mutatePattern(view.pattern, true);
    changed();
    redraw();
}

// Evolve mutates the playing pattern every beat, bar, 2 or 4 bars (counted from the playhead). It runs from playback,
// so it adds no undo step and does not notify Live (that would flood Live's undo history); the evolved patterns are
// saved with the set at the next edit.
function evolveTick() {
    if (S.evolve === 0 || view.phase < 0) {
        return;
    }
    var unit = [0, 1, quartersPerBar(), 2 * quartersPerBar(), 4 * quartersPerBar()][S.evolve];
    var mark = Math.floor(((wraps + view.phase) * patQuarters()) / unit + 1e-9);
    if (evolveMark >= 0 && mark !== evolveMark) {
        mutatePattern(view.active, false);
    }
    evolveMark = mark;
}

// ---------------------------------------------------------------------------------------------------------------
// Grid and snapping

// Quarter notes per bar and per pattern (the same arithmetic as gen~).
function quartersPerBar() {
    return (view.signum * 4) / view.sigden;
}

function patQuarters() {
    var qpb = quartersPerBar();
    return [1, 2, qpb, 2 * qpb, 4 * qpb][view.patlen];
}

// Grid cells across the pattern; may be fractional (quarter notes in 7/8: the last cell is shorter).
function gridCells() {
    var g = GRIDS[S.grid];
    return g.div > 0 ? (patQuarters() * g.div) / 4 : 0;
}

// Position of grid line k (0..ceil(n)); never past the end. (Swing is a sound control now: gen~ does it.)
function gridLine(k, n) {
    return Math.min(k / n, 1);
}

function lineCount(n) {
    return Math.ceil(n - 1e-9);
}

function snapX(x, free) {
    var n = gridCells();
    if (free || n <= 0) {
        return clamp(x, 0, 1);
    }
    var best = 0;
    var bestD = 2;
    var k0 = Math.max(0, Math.floor(x * n) - 1);
    var k1 = Math.min(lineCount(n), Math.floor(x * n) + 2);
    for (var k = k0; k <= k1; k++) {
        var gx = k >= lineCount(n) ? 1 : gridLine(k, n);
        if (Math.abs(gx - x) < bestD) {
            bestD = Math.abs(gx - x);
            best = gx;
        }
    }
    return best;
}

// Time offsets snap to the grid too (whole-step offsets repeat in time); every level sticks to the top and bottom.
function snapU(u, free) {
    u = clamp(u, 0, 1);
    if (!free && S.edit === 0) {
        var n = gridCells();
        if (n > 0) {
            return clamp(Math.round(u * n) / n, 0, 1);
        }
    }
    if (u < 0.02) {
        return 0;
    }
    if (u > 0.98) {
        return 1;
    }
    return u;
}

// The draw tool's cell under x: [start, end) between grid lines (1/32 notes when the grid is off).
function cellAt(x) {
    var n = gridCells();
    if (n <= 0) {
        n = patQuarters() * 8;
    }
    var count = lineCount(n);
    for (var k = 0; k < count; k++) {
        var b = k + 1 >= count ? 1 : gridLine(k + 1, n);
        if (x < b || k === count - 1) {
            return { k: k, a: gridLine(k, n), b: b };
        }
    }
    return { k: 0, a: 0, b: 1 };
}

// ---------------------------------------------------------------------------------------------------------------
// Layout (jsui 380 x 157): the display, then two rows of controls.

var DISP_H = 114;
var ROW_H = 17;
var ROW1_Y = 118;
var ROW2_Y = 139;
var PAD_TOP = 14; // a strip for the labels above the top line
var PAD_BOTTOM = 5;
var PAD_X = 5; // keeps the end points whole and grabbable

function viewSize() {
    if (typeof mgraphics !== "undefined" && mgraphics.size) {
        return [mgraphics.size[0], mgraphics.size[1]];
    }
    var r = box.rect;
    return [r[2] - r[0], r[3] - r[1]];
}

function presetName(env) {
    var i = S.preset[view.pattern][env];
    return i >= 0 ? PRESETS[env][i].name : "Custom";
}

function presetLabel() {
    return presetName(S.edit);
}

// Both rows span the whole width: the preset field (row 1) and the Swing field (row 2) take what is left.
function layout(w, h) {
    var L = { w: w, h: h, disp: { x: 0, y: 0, w: w, h: DISP_H }, buttons: [] };
    var x = 0;
    var row = ROW1_Y;
    function add(id, kind, bw, extra) {
        var b = { id: id, kind: kind, x: x, y: row, w: bw, h: ROW_H, on: false, enabled: true, label: "", icon: "" };
        for (var k in extra) {
            if (extra.hasOwnProperty(k)) {
                b[k] = extra[k];
            }
        }
        L.buttons.push(b);
        x += bw + 2;
        return b;
    }
    add("time", "button", 30, { label: "Time", on: S.edit === 0 });
    add("vol", "button", 42, { label: "Volume", on: S.edit === 1 });
    x += 4;
    add("pprev", "icon", 13, { icon: "left" });
    add("pname", "field", w - 234, { label: presetLabel(), on: view.pop === "browser", icon: "down" });
    add("pnext", "icon", 13, { icon: "right" });
    x += 4;
    add("point", "icon", 18, { icon: "point", on: S.tool === 0 });
    add("draw", "icon", 18, { icon: "draw", on: S.tool === 1 });
    add("dice", "icon", 18, { icon: "dice" });
    add("flip", "icon", 18, { icon: "flip" });
    add("copy", "icon", 18, { icon: "copy" });
    add("paste", "icon", 18, { icon: "paste", enabled: hasClip() });
    x = 0;
    row = ROW2_Y;
    for (var p = 0; p < NUM_PAT; p++) {
        add("pad" + p, "pad", 13, { label: String(p + 1), on: p === view.pattern, playing: p === view.active });
        x -= 1;
    }
    x += 3;
    add("switch", "field", 64, { label: "Switch", value: SWITCH_SHORT[view.quant], on: view.pop === "quant" });
    x += 2;
    add("hprev", "icon", 10, { icon: "left" });
    x -= 1;
    add("hold", "toggle", 52, { label: "Hold", value: HOLD_NAMES[view.holdlen], on: view.hold > 0 });
    x -= 1;
    add("hnext", "icon", 10, { icon: "right" });
    x += 2;
    add("swing", "field", w - x - 62, { label: "Swing", value: String(view.swing) });
    x += 2;
    add("undo", "icon", 18, { icon: "undo", enabled: undoStack.length > 0 || redoStack.length > 0 });
    add("grid", "icon", 18, { icon: "grid", on: view.pop === "grid" });
    add("gear", "icon", 18, { icon: "gear", on: view.pop === "settings" });
    return L;
}

function curLayout() {
    var s = viewSize();
    return layout(s[0], s[1]);
}

function toX(L, x) {
    return L.disp.x + PAD_X + x * (L.disp.w - 2 * PAD_X);
}

function toY(L, u) {
    return L.disp.y + PAD_TOP + u * (L.disp.h - PAD_TOP - PAD_BOTTOM);
}

function fromX(L, px) {
    return clamp((px - L.disp.x - PAD_X) / (L.disp.w - 2 * PAD_X), 0, 1);
}

function fromY(L, py) {
    return clamp((py - L.disp.y - PAD_TOP) / (L.disp.h - PAD_TOP - PAD_BOTTOM), 0, 1);
}

function inRect(r, x, y) {
    return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

function hitButton(L, x, y) {
    for (var i = 0; i < L.buttons.length; i++) {
        if (inRect(L.buttons[i], x, y)) {
            return L.buttons[i];
        }
    }
    return null;
}

function hitPoint(L, pts, x, y) {
    var best = -1;
    var bestD = 36;
    for (var i = 0; i < pts.length; i++) {
        var dx = toX(L, pts[i].x) - x;
        var dy = toY(L, pts[i].u) - y;
        var d = dx * dx + dy * dy;
        if (d <= bestD) {
            bestD = d;
            best = i;
        }
    }
    return best;
}

// Curve handles sit at the middle of segments wide enough to grab and not flat.
function handlePos(L, pts, s) {
    var a = pts[s];
    var b = pts[s + 1];
    if (toX(L, b.x) - toX(L, a.x) < 14 || Math.abs(b.u - a.u) < 0.01) {
        return null;
    }
    var xm = (a.x + b.x) / 2;
    return { x: toX(L, xm), y: toY(L, evalSeg(pts, s, xm)) };
}

function hitHandle(L, pts, x, y) {
    for (var s = 0; s < pts.length - 1; s++) {
        var h = handlePos(L, pts, s);
        if (h && (h.x - x) * (h.x - x) + (h.y - y) * (h.y - y) <= 25) {
            return s;
        }
    }
    return -1;
}

// ---------------------------------------------------------------------------------------------------------------
// Popovers, drawn over the display: the preset browser, the Switch menu, Grid (snap, length) and Settings.

// The preset browser covers the display: categories in two columns on the left, the category's presets on the right.
function browserItems(L) {
    var items = [];
    var cats = categories(S.edit);
    var cur = S.preset[view.pattern][S.edit];
    var cat = cats.indexOf(view.browseCat) >= 0 ? view.browseCat : cur >= 0 ? PRESETS[S.edit][cur].cat : cats[1];
    var rowH = 12;
    var catRows = Math.ceil(cats.length / 2);
    var catW = 52;
    var i;
    for (i = 0; i < cats.length; i++) {
        items.push({
            kind: "cat",
            id: cats[i],
            label: cats[i],
            on: cats[i] === cat,
            x: 4 + Math.floor(i / catRows) * (catW + 2),
            y: 5 + (i % catRows) * rowH,
            w: catW,
            h: rowH - 1,
        });
    }
    var list = [];
    if (cat === "Combos") {
        for (i = 0; i < COMBOS.length; i++) {
            list.push({ kind: "combo", id: i, label: COMBOS[i].name, on: false });
        }
    } else {
        for (i = 0; i < PRESETS[S.edit].length; i++) {
            if (PRESETS[S.edit][i].cat === cat) {
                list.push({ kind: "preset", id: i, label: PRESETS[S.edit][i].name, on: i === cur });
            }
        }
    }
    var left = 4 + 2 * (catW + 2) + 6;
    var cw = Math.floor((L.disp.w - left - 4) / 2);
    var rows = Math.max(1, Math.floor((L.disp.h - 8) / rowH));
    for (i = 0; i < list.length && i < 2 * rows; i++) {
        var it = list[i];
        it.x = left + Math.floor(i / rows) * cw;
        it.y = 5 + (i % rows) * rowH;
        it.w = cw - 2;
        it.h = rowH - 1;
        items.push(it);
    }
    return items;
}

// The Switch menu opens upwards from its field.
function switchItems(L) {
    var b = buttonById(L, "switch");
    var items = [];
    for (var i = 0; i < SWITCH_NAMES.length; i++) {
        items.push({
            kind: "quant",
            id: i,
            label: SWITCH_NAMES[i],
            on: i === view.quant,
            x: b.x,
            y: ROW2_Y - 4 - (SWITCH_NAMES.length - i) * 12,
            w: b.w,
            h: 11,
        });
    }
    return items;
}

// Rows of "label  choice choice ...", placed at the bottom of the display and right-aligned under `anchor` (a button).
function rowsPop(L, anchor, rows) {
    var items = [];
    var rowW = 0;
    var r;
    var i;
    for (r = 0; r < rows.length; r++) {
        var x = 46;
        for (i = 0; i < rows[r].names.length; i++) {
            x += 8 + rows[r].names[i].length * 5 + 2;
        }
        rowW = Math.max(rowW, x - 2);
    }
    var b = buttonById(L, anchor);
    var x0 = clamp(b.x + b.w - rowW - 4, 8, L.w - rowW - 8);
    var y0 = DISP_H - 6 - rows.length * 15;
    for (r = 0; r < rows.length; r++) {
        var row = rows[r];
        var y = y0 + r * 15;
        items.push({ kind: "label", id: row.kind, label: row.label, x: x0, y: y, w: 42, h: 12 });
        var cx = x0 + 46;
        for (i = 0; i < row.names.length; i++) {
            var w = 8 + row.names[i].length * 5;
            items.push({ kind: row.kind, id: i, label: row.names[i], on: i === row.current, x: cx, y: y, w: w, h: 12 });
            cx += w + 2;
        }
    }
    return items;
}

function gridItems(L) {
    var names = [];
    for (var i = 0; i < GRIDS.length; i++) {
        names.push(GRIDS[i].name);
    }
    return rowsPop(L, "grid", [
        { kind: "snap", label: "Snap", names: names, current: S.grid },
        { kind: "length", label: "Length", names: LENGTH_NAMES, current: view.patlen },
    ]);
}

function settingsItems(L) {
    return rowsPop(L, "gear", [
        { kind: "holdmode", label: "Hold", names: HOLD_MODES, current: view.holdmode },
        { kind: "grain", label: "Grain", names: ["-", view.grain + " ms", "+"], current: -1 },
        { kind: "midilink", label: "MIDI", names: LINK_NAMES, current: view.midilink },
        { kind: "evolve", label: "Evolve", names: EVOLVE_NAMES, current: S.evolve },
    ]);
}

function popItems(L) {
    if (view.pop === "browser") {
        return browserItems(L);
    }
    if (view.pop === "quant") {
        return switchItems(L);
    }
    if (view.pop === "grid") {
        return gridItems(L);
    }
    if (view.pop === "settings") {
        return settingsItems(L);
    }
    return [];
}

// The area a popover covers (clicks outside it close it).
function popRect(L) {
    var items = popItems(L);
    if (view.pop === "browser") {
        return { x: 0, y: 0, w: L.disp.w, h: L.disp.h };
    }
    var r = null;
    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!r) {
            r = { x: it.x, y: it.y, w: it.w, h: it.h };
        } else {
            var x2 = Math.max(r.x + r.w, it.x + it.w);
            var y2 = Math.max(r.y + r.h, it.y + it.h);
            r.x = Math.min(r.x, it.x);
            r.y = Math.min(r.y, it.y);
            r.w = x2 - r.x;
            r.h = y2 - r.y;
        }
    }
    return r ? { x: r.x - 4, y: r.y - 4, w: r.w + 8, h: r.h + 8 } : null;
}

function hitPop(L, x, y) {
    var items = popItems(L);
    for (var i = 0; i < items.length; i++) {
        if (items[i].kind !== "label" && inRect(items[i], x, y)) {
            return items[i];
        }
    }
    return null;
}

function pressPopItem(it) {
    if (it.kind === "cat") {
        view.browseCat = it.id;
        redraw();
        return;
    }
    if (it.kind === "preset") {
        view.pop = "";
        dopreset(it.id);
    } else if (it.kind === "combo") {
        view.pop = "";
        docombo(it.id);
    } else if (it.kind === "quant") {
        view.pop = "";
        sendParam("quant", it.id);
    } else if (it.kind === "snap") {
        setgrid(it.id);
    } else if (it.kind === "length") {
        sendParam("patlen", it.id);
    } else if (it.kind === "holdmode") {
        sendParam("holdmode", it.id);
    } else if (it.kind === "grain") {
        if (it.id !== 1) {
            sendParam("grainms", clamp(view.grain + (it.id === 0 ? -10 : 10), 10, 250));
        }
    } else if (it.kind === "midilink") {
        sendParam("midilink", it.id);
    } else if (it.kind === "evolve") {
        setevolve(it.id);
    }
    redraw();
}

function buttonById(L, id) {
    for (var i = 0; i < L.buttons.length; i++) {
        if (L.buttons[i].id === id) {
            return L.buttons[i];
        }
    }
    return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Mouse

// The button that opens each popover.
var POP_OPENER = { browser: "pname", quant: "switch", grid: "grid", settings: "gear" };

function togglePop(name) {
    view.pop = view.pop === name ? "" : name;
    redraw();
}

function pressButton(b, shift, option) {
    var id = b.id;
    if (id.indexOf("pad") === 0) {
        var p = Number(id.slice(3));
        if (option) {
            copypattern(p);
        } else {
            sendParam("pattern", p);
        }
    } else if (id === "time") {
        setedit(0);
    } else if (id === "vol") {
        setedit(1);
    } else if (id === "pprev") {
        prevpreset();
    } else if (id === "pnext") {
        nextpreset();
    } else if (id === "pname") {
        view.browseCat = "";
        togglePop("browser");
    } else if (id === "point") {
        settool(0);
    } else if (id === "draw") {
        settool(1);
    } else if (id === "dice") {
        if (shift) {
            domutate();
        } else {
            dodice();
        }
    } else if (id === "flip") {
        doflip();
    } else if (id === "copy") {
        docopy();
    } else if (id === "paste") {
        dopaste();
    } else if (id === "switch") {
        togglePop("quant");
    } else if (id === "hold") {
        sendParam("hold", view.hold > 0 ? 0 : 1);
    } else if (id === "hprev") {
        sendParam("holdlen", clamp(view.holdlen - 1, 0, HOLD_NAMES.length - 1));
    } else if (id === "hnext") {
        sendParam("holdlen", clamp(view.holdlen + 1, 0, HOLD_NAMES.length - 1));
    } else if (id === "undo") {
        if (shift) {
            doredo();
        } else {
            doundo();
        }
    } else if (id === "grid") {
        togglePop("grid");
    } else if (id === "gear") {
        togglePop("settings");
    }
}

function paintAt(L, px, py, free, erase) {
    var c = cellAt(fromX(L, px));
    var u = erase ? 0 : snapU(fromY(L, py), free);
    if (drag.lastCell === c.k && drag.lastU === u) {
        return;
    }
    drag.lastCell = c.k;
    drag.lastU = u;
    S.pats[drag.p][drag.e] = setRange(S.pats[drag.p][drag.e], c.a, c.b, u);
    S.preset[drag.p][drag.e] = -1;
    drag.moved = true;
    writeEnv(drag.p, drag.e);
}

// Shift: no snapping. Alt: delete a point, reset a curve, erase with the draw tool, copy into a pad.
// Double-click a point: delete. Swing: drag up/down, double-click resets.
function onclick(x, y, but, cmd, shift, capslock, option, ctrl) {
    var L = curLayout();
    if (view.pop !== "") {
        var item = hitPop(L, x, y);
        if (item) {
            pressPopItem(item);
            return;
        }
        // A click elsewhere closes the popover; on another button it also presses that button (not on the opener).
        var r = popRect(L);
        var b0 = hitButton(L, x, y);
        var opener = POP_OPENER[view.pop];
        view.pop = "";
        redraw();
        if (!r || inRect(r, x, y) || !b0 || b0.id === opener) {
            return;
        }
    }
    var b = hitButton(L, x, y);
    if (b) {
        if (b.id === "swing") {
            drag = { kind: "swing", y0: y, v0: view.swing, moved: false };
            return;
        }
        if (b.enabled) {
            pressButton(b, shift, option);
        }
        return;
    }
    if (!inRect(L.disp, x, y)) {
        return;
    }
    var p = view.pattern;
    var e = S.edit;
    var pts = S.pats[p][e];
    drag = null;
    if (S.tool === 1) {
        pushUndo(p, e);
        drag = { kind: "draw", p: p, e: e, moved: false, lastCell: -1, lastU: -1, erase: !!option };
        paintAt(L, x, y, shift, option);
        redraw();
        return;
    }
    var hi = hitPoint(L, pts, x, y);
    if (hi >= 0) {
        if (option) {
            deletePoint(hi);
            return;
        }
        pushUndo(p, e);
        drag = { kind: "point", idx: hi, p: p, e: e, moved: false };
        redraw();
        return;
    }
    var hs = hitHandle(L, pts, x, y);
    if (hs >= 0) {
        pushUndo(p, e);
        if (option) {
            pts[hs].c = 0;
            S.preset[p][e] = -1;
            writeEnv(p, e);
            changed();
            redraw();
            return;
        }
        drag = { kind: "curve", idx: hs, p: p, e: e, moved: false };
        return;
    }
    var nx = snapX(fromX(L, x), shift);
    var nu = snapU(fromY(L, y), shift);
    pushUndo(p, e);
    var idx;
    if (nx <= 0) {
        idx = 0;
    } else if (nx >= 1) {
        idx = pts.length - 1;
    } else {
        if (pts.length >= MAX_PTS) {
            undoStack.pop();
            return;
        }
        idx = 0;
        while (idx < pts.length && pts[idx].x <= nx) {
            idx++;
        }
        pts.splice(idx, 0, pt(nx, nu, 0));
    }
    pts[idx].u = nu;
    S.preset[p][e] = -1;
    drag = { kind: "point", idx: idx, p: p, e: e, moved: true };
    writeEnv(p, e);
    redraw();
}

function ondrag(x, y, but, cmd, shift, capslock, option, ctrl) {
    if (!drag) {
        return;
    }
    if (!but) {
        finishDrag();
        return;
    }
    if (drag.kind === "swing") {
        var v = clamp(Math.round(drag.v0 + (drag.y0 - y) * 0.75), 0, 75);
        if (v !== view.swing) {
            sendParam("swing", v);
            view.swing = v;
            drag.moved = true;
            redraw();
        }
        return;
    }
    var L = curLayout();
    var pts = S.pats[drag.p][drag.e];
    var was = drag.moved;
    drag.moved = false;
    if (drag.kind === "point") {
        var i = drag.idx;
        var n = pts.length;
        var nx = snapX(fromX(L, x), shift);
        var nu = snapU(fromY(L, y), shift);
        if (i === 0) {
            nx = 0;
        } else if (i === n - 1) {
            nx = 1;
        } else {
            nx = clamp(nx, pts[i - 1].x, pts[i + 1].x);
        }
        if (nx !== pts[i].x || nu !== pts[i].u) {
            pts[i].x = nx;
            pts[i].u = nu;
            drag.moved = true;
        }
    } else if (drag.kind === "curve") {
        var a = pts[drag.idx];
        var c = curveForMid(a.u, pts[drag.idx + 1].u, fromY(L, y));
        if (c !== a.c) {
            a.c = c;
            drag.moved = true;
        }
    } else {
        paintAt(L, x, y, shift, drag.erase);
    }
    if (drag.moved) {
        S.preset[drag.p][drag.e] = -1;
        writeEnv(drag.p, drag.e);
        redraw();
    }
    drag.moved = drag.moved || was;
}

function finishDrag() {
    var d = drag;
    drag = null;
    if (d.kind === "swing") {
        redraw();
        return;
    }
    if (d.moved) {
        S.pats[d.p][d.e] = cleanEnv(S.pats[d.p][d.e]);
        writeEnv(d.p, d.e);
        changed();
    } else {
        undoStack.pop();
    }
    redraw();
}

function deletePoint(i) {
    var p = view.pattern;
    var e = S.edit;
    var pts = S.pats[p][e];
    if (i <= 0 || i >= pts.length - 1) {
        return;
    }
    pushUndo(p, e);
    pts.splice(i, 1);
    S.pats[p][e] = cleanEnv(pts);
    S.preset[p][e] = -1;
    writeEnv(p, e);
    changed();
    redraw();
}

function ondblclick(x, y, but, cmd, shift, capslock, option, ctrl) {
    var L = curLayout();
    var b = hitButton(L, x, y);
    if (b && b.id === "swing") {
        sendParam("swing", 0);
        return;
    }
    if (view.pop !== "" || !inRect(L.disp, x, y) || S.tool !== 0) {
        return;
    }
    var hi = hitPoint(L, curPts(), x, y);
    if (hi >= 0) {
        deletePoint(hi);
    }
}

function hoverTarget(x, y) {
    var L = curLayout();
    if (view.pop !== "") {
        var item = hitPop(L, x, y);
        return item ? "item:" + item.kind + ":" + item.id : "";
    }
    var b = hitButton(L, x, y);
    if (b) {
        return "btn:" + b.id;
    }
    if (!inRect(L.disp, x, y) || S.tool !== 0) {
        return "";
    }
    var hi = hitPoint(L, curPts(), x, y);
    if (hi >= 0) {
        return "pt:" + hi;
    }
    var hs = hitHandle(L, curPts(), x, y);
    return hs >= 0 ? "hd:" + hs : "";
}

function onidle(x, y, but, cmd, shift, capslock, option, ctrl) {
    var h = hoverTarget(x, y);
    if (h !== view.hover) {
        view.hover = h;
        redraw();
    }
}

function onidleout() {
    if (view.hover !== "") {
        view.hover = "";
        redraw();
    }
}

function onresize(w, h) {
    redraw();
}

// ---------------------------------------------------------------------------------------------------------------
// Colors: Live's theme when it can be read ([live.colors] messages, or max.getcolor where the engine has it), else a
// dark palette close to Live's default. Everything is dimmed while the device is off.
// Names seen in Ableton's own devices (maxdevtools): lcd_bg, control_bg, control_selection, display_handle_two,
// display_scale_text, lcd_control_fg_zombie. The others are guesses that fall back here when Live has no such color.

var FALLBACK = {
    surface_bg: [0.19, 0.19, 0.19, 1],
    lcd_bg: [0.09, 0.09, 0.09, 1],
    lcd_frame: [0.3, 0.3, 0.3, 1],
    display_scale_text: [0.72, 0.72, 0.72, 1],
    control_bg: [0.27, 0.27, 0.27, 1],
    control_fg: [0.85, 0.85, 0.85, 1],
    lcd_control_fg_zombie: [0.48, 0.48, 0.48, 1],
    control_selection: [0.45, 0.78, 1.0, 1],
    display_handle_two: [1.0, 0.65, 0.22, 1],
};

function themeColor(id) {
    if (themeColors[id]) {
        return themeColors[id];
    }
    try {
        if (typeof max !== "undefined" && max.getcolor) {
            var c = max.getcolor("live_" + id);
            if (c && c.length >= 3) {
                return [c[0], c[1], c[2], c.length > 3 ? c[3] : 1];
            }
        }
    } catch (err) {
        // older js engine: no max.getcolor
    }
    return FALLBACK[id];
}

function palette() {
    var pal = {
        panel: themeColor("surface_bg"),
        disp: themeColor("lcd_bg"),
        frame: themeColor("lcd_frame"),
        text: themeColor("display_scale_text"),
        btn: themeColor("control_bg"),
        btnText: themeColor("control_fg"),
        dim: themeColor("lcd_control_fg_zombie"),
        accent: themeColor("control_selection"),
        pad: themeColor("control_selection"),
        env: [themeColor("control_selection"), themeColor("display_handle_two")],
    };
    pal.ink = [0.07, 0.07, 0.07, 1];
    return pal;
}

var COL = null;

function rgba(g, c, alpha) {
    var a = alpha === undefined ? (c.length > 3 ? c[3] : 1) : alpha;
    if (!view.enabled) {
        g.set_source_rgba(0.35 + c[0] * 0.3, 0.35 + c[1] * 0.3, 0.35 + c[2] * 0.3, a * 0.8);
        return;
    }
    g.set_source_rgba(c[0], c[1], c[2], a);
}

function textAt(g, s, x, y, c) {
    rgba(g, c);
    g.move_to(x, y);
    g.show_text(s);
}

function textWidth(g, s) {
    var m = g.text_measure(s);
    return m[0];
}

function font(g, size) {
    g.select_font_face("Ableton Sans Medium");
    g.set_font_size(size);
}

// ---------------------------------------------------------------------------------------------------------------
// Icons, in a 12 x 12 box centred on (cx, cy)

function icon(g, name, cx, cy, c) {
    var x = cx - 6;
    var y = cy - 6;
    rgba(g, c);
    g.set_line_width(1.2);
    if (name === "left" || name === "right" || name === "down") {
        if (name === "left") {
            g.move_to(x + 8, y + 3);
            g.line_to(x + 4, y + 6);
            g.line_to(x + 8, y + 9);
        } else if (name === "right") {
            g.move_to(x + 4, y + 3);
            g.line_to(x + 8, y + 6);
            g.line_to(x + 4, y + 9);
        } else {
            g.move_to(x + 3, y + 5);
            g.line_to(x + 6, y + 8);
            g.line_to(x + 9, y + 5);
        }
        g.close_path();
        g.fill();
    } else if (name === "point") {
        g.move_to(x + 2, y + 10);
        g.line_to(x + 10, y + 2);
        g.stroke();
        g.rectangle(x + 1, y + 8.5, 3, 3);
        g.rectangle(x + 8.5, y + 1, 3, 3);
        g.fill();
    } else if (name === "draw") {
        g.rectangle(x + 1, y + 6, 2.5, 6);
        g.rectangle(x + 4.75, y + 2, 2.5, 10);
        g.rectangle(x + 8.5, y + 8, 2.5, 4);
        g.fill();
    } else if (name === "dice") {
        g.rectangle_rounded(x + 1, y + 1, 10, 10, 3, 3);
        g.stroke();
        g.ellipse(x + 3, y + 3, 2, 2);
        g.ellipse(x + 5, y + 5, 2, 2);
        g.ellipse(x + 7, y + 7, 2, 2);
        g.fill();
    } else if (name === "flip") {
        g.move_to(x + 6, y + 1);
        g.line_to(x + 6, y + 11);
        g.stroke();
        g.move_to(x + 3, y + 4);
        g.line_to(x + 6, y + 1);
        g.line_to(x + 9, y + 4);
        g.move_to(x + 3, y + 8);
        g.line_to(x + 6, y + 11);
        g.line_to(x + 9, y + 8);
        g.stroke();
    } else if (name === "copy") {
        g.rectangle(x + 1.5, y + 1.5, 6.5, 7);
        g.rectangle(x + 4.5, y + 4, 6.5, 7);
        g.stroke();
    } else if (name === "paste") {
        g.rectangle(x + 2, y + 2.5, 8, 9);
        g.stroke();
        g.rectangle(x + 4, y + 1, 4, 3);
        g.fill();
    } else if (name === "undo") {
        g.arc(cx, cy + 1, 4, Math.PI, 2.6 * Math.PI);
        g.stroke();
        g.move_to(x + 0.5, y + 5);
        g.line_to(x + 2, y + 9);
        g.line_to(x + 5, y + 6);
        g.close_path();
        g.fill();
    } else if (name === "grid") {
        g.move_to(x + 4, y + 1);
        g.line_to(x + 4, y + 11);
        g.move_to(x + 8, y + 1);
        g.line_to(x + 8, y + 11);
        g.move_to(x + 1, y + 4);
        g.line_to(x + 11, y + 4);
        g.move_to(x + 1, y + 8);
        g.line_to(x + 11, y + 8);
        g.stroke();
    } else if (name === "gear") {
        g.ellipse(x + 3, y + 3, 6, 6);
        g.stroke();
        for (var k = 0; k < 8; k++) {
            var a = (k * Math.PI) / 4;
            g.move_to(cx + Math.cos(a) * 3.5, cy + Math.sin(a) * 3.5);
            g.line_to(cx + Math.cos(a) * 5.5, cy + Math.sin(a) * 5.5);
        }
        g.stroke();
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Drawing

function vline(g, L, x) {
    var gx = Math.round(toX(L, x)) + 0.5;
    g.move_to(gx, L.disp.y);
    g.line_to(gx, L.disp.y + L.disp.h);
}

function drawGrid(g, L) {
    var d = L.disp;
    var n = gridCells();
    var patQ = patQuarters();
    var qpb = quartersPerBar();
    var k;
    g.set_line_width(1);
    if (n > 0 && n <= 96) {
        rgba(g, COL.text, 0.05);
        for (k = 1; k < lineCount(n); k++) {
            vline(g, L, gridLine(k, n));
        }
        g.stroke();
    }
    rgba(g, COL.text, 0.13);
    for (k = 1; k < patQ; k++) {
        vline(g, L, k / patQ);
    }
    g.stroke();
    if (patQ > qpb) {
        rgba(g, COL.text, 0.3);
        for (k = 1; k * qpb < patQ; k++) {
            vline(g, L, (k * qpb) / patQ);
        }
        g.stroke();
    }
    // Level guides: the grid's offsets for the time envelope, quarters for volume.
    var step = S.edit === 0 && n > 0 && n <= 32 ? 1 / n : 0.25;
    rgba(g, COL.text, 0.05);
    for (k = 1; k * step < 1 - 1e-9; k++) {
        var gy = Math.round(toY(L, k * step)) + 0.5;
        g.move_to(d.x, gy);
        g.line_to(d.x + d.w, gy);
    }
    g.stroke();
}

// Gross Beat's guides: falling at 45 degrees from the top-left stops the sound, steeper plays it backwards.
function drawGuides(g, L) {
    g.set_line_width(1);
    rgba(g, COL.env[0], 0.18);
    g.move_to(toX(L, 0), toY(L, 0));
    g.line_to(toX(L, 1), toY(L, 1));
    g.move_to(toX(L, 0), toY(L, 0));
    g.line_to(toX(L, 0.5), toY(L, 1));
    g.stroke();
    font(g, 7.5);
    textAt(g, "stop", toX(L, 0.9) - 22, toY(L, 0.9), COL.dim);
    textAt(g, "reverse", toX(L, 0.45) + 4, toY(L, 0.9), COL.dim);
}

function drawWave(g, L, peaks, offset, c, alpha) {
    var d = L.disp;
    var mid = d.y + PAD_TOP + (d.h - PAD_TOP - PAD_BOTTOM) / 2;
    var half = (d.h - PAD_TOP - PAD_BOTTOM) / 2;
    var i;
    rgba(g, c, alpha);
    g.move_to(toX(L, 0), mid);
    for (i = 0; i < PEAK_BINS; i++) {
        var a = Math.min(1, Math.abs(peaks[offset + i])) * half;
        g.line_to(toX(L, i / PEAK_BINS), mid - a);
        g.line_to(toX(L, (i + 1) / PEAK_BINS), mid - a);
    }
    for (i = PEAK_BINS - 1; i >= 0; i--) {
        var b = Math.min(1, Math.abs(peaks[offset + i])) * half;
        g.line_to(toX(L, (i + 1) / PEAK_BINS), mid + b);
        g.line_to(toX(L, i / PEAK_BINS), mid + b);
    }
    g.close_path();
    g.fill();
}

function tracePath(g, L, pts) {
    g.move_to(toX(L, pts[0].x), toY(L, pts[0].u));
    for (var i = 0; i < pts.length - 1; i++) {
        var a = pts[i];
        var b = pts[i + 1];
        if (a.c === 0 || near(a.u, b.u) || b.x - a.x <= 0) {
            g.line_to(toX(L, b.x), toY(L, b.u));
        } else {
            for (var s = 1; s <= 24; s++) {
                var t = s / 24;
                g.line_to(toX(L, a.x + (b.x - a.x) * t), toY(L, a.u + (b.u - a.u) * shape(t, a.c)));
            }
        }
    }
}

function drawEnvelope(g, L, e, editing) {
    var pts = S.pats[view.pattern][e];
    var c = COL.env[e];
    var d = L.disp;
    if (editing) {
        // A light fill on the side that is "not normal": below the line for time, above it for volume.
        tracePath(g, L, pts);
        var edgeY = e === 0 ? d.y + d.h : d.y;
        g.line_to(toX(L, 1), edgeY);
        g.line_to(toX(L, 0), edgeY);
        g.close_path();
        rgba(g, c, 0.07);
        g.fill();
    }
    tracePath(g, L, pts);
    rgba(g, c, editing ? 1 : 0.3);
    g.set_line_width(editing ? 1.5 : 1);
    g.stroke();
    if (!editing || S.tool !== 0) {
        return;
    }
    for (var s = 0; s < pts.length - 1; s++) {
        var h = handlePos(L, pts, s);
        if (h) {
            var hot = view.hover === "hd:" + s || (drag && drag.kind === "curve" && drag.idx === s);
            rgba(g, c, hot ? 1 : 0.45);
            g.set_line_width(1);
            g.ellipse(h.x - 3, h.y - 3, 6, 6);
            g.stroke();
        }
    }
    for (var i = 0; i < pts.length; i++) {
        var on = view.hover === "pt:" + i || (drag && drag.kind === "point" && drag.idx === i);
        var r = on ? 3.5 : 2.5;
        rgba(g, on ? COL.accent : [0.96, 0.96, 0.96, 1]);
        g.rectangle(toX(L, pts[i].x) - r, toY(L, pts[i].u) - r, 2 * r, 2 * r);
        g.fill();
    }
}

function drawDisplay(g, L) {
    var d = L.disp;
    rgba(g, COL.disp);
    g.rectangle(d.x, d.y, d.w, d.h);
    g.fill();
    drawGrid(g, L);
    var peaks = readPeaks();
    if (peaks) {
        drawWave(g, L, peaks, 0, COL.text, 0.28);
        drawWave(g, L, peaks, PEAK_BINS, COL.env[0], 0.22);
    }
    if (S.edit === 0) {
        drawGuides(g, L);
    }
    drawEnvelope(g, L, 1 - S.edit, false);
    drawEnvelope(g, L, S.edit, true);
    if (view.phase >= 0) {
        var px = Math.round(toX(L, view.phase)) + 0.5;
        rgba(g, [1, 1, 1, 1], view.active === view.pattern ? 0.85 : 0.3);
        g.set_line_width(1);
        g.move_to(px, d.y);
        g.line_to(px, d.y + d.h);
        g.stroke();
    }
    font(g, 9);
    if (view.phase >= 0 && view.active !== view.pattern) {
        textAt(g, "playing " + (view.active + 1), d.x + 5, d.y + 11, COL.dim);
    }
    if (view.hold > 0) {
        textAt(g, "HOLD", d.x + d.w / 2 - 12, d.y + 11, COL.env[1]);
    }
    // The other envelope's preset, as in the original's "Normal".
    var other = presetName(1 - S.edit);
    rgba(g, COL.env[1 - S.edit], 0.9);
    g.move_to(d.x + d.w - textWidth(g, other) - 5, d.y + 11);
    g.show_text(other);
    rgba(g, COL.frame);
    g.set_line_width(1);
    g.rectangle(d.x + 0.5, d.y + 0.5, d.w - 1, d.h - 1);
    g.stroke();
}

function fitLabel(g, b) {
    var full = b.value !== undefined ? b.label + " " + b.value : b.label;
    if (textWidth(g, full) <= b.w - 6 || b.value === undefined) {
        return full;
    }
    return b.value;
}

function drawButton(g, b) {
    var hot = view.hover === "btn:" + b.id;
    var fill = COL.btn;
    var ink = b.enabled ? COL.btnText : COL.dim;
    if (b.kind === "pad") {
        fill = b.on ? COL.pad : COL.btn;
        ink = b.on ? COL.ink : COL.btnText;
    } else if (b.on) {
        fill = COL.accent;
        ink = COL.ink;
    }
    rgba(g, fill);
    g.rectangle_rounded(b.x, b.y, b.w, b.h, 3, 3);
    g.fill();
    if (hot && b.enabled && !b.on) {
        rgba(g, [1, 1, 1, 1], 0.08);
        g.rectangle_rounded(b.x, b.y, b.w, b.h, 3, 3);
        g.fill();
    }
    if (b.kind === "pad" && b.playing && view.phase >= 0) {
        rgba(g, b.on ? COL.ink : COL.pad);
        g.rectangle(b.x + 3, b.y + b.h - 3, b.w - 6, 1.5);
        g.fill();
    }
    if (b.icon && b.kind !== "field") {
        icon(g, b.icon, b.x + b.w / 2, b.y + b.h / 2, ink);
        return;
    }
    font(g, 9);
    var s = fitLabel(g, b);
    if (b.kind === "field" && b.icon) {
        textAt(g, s, b.x + 5, b.y + b.h - 5, ink);
        icon(g, b.icon, b.x + b.w - 7, b.y + b.h / 2, ink);
        return;
    }
    if (b.value !== undefined && s !== b.value) {
        // a dim label, then the value
        var lw = textWidth(g, b.label + " ");
        var x0 = b.x + Math.max(3, (b.w - textWidth(g, s)) / 2);
        textAt(g, b.label, x0, b.y + b.h - 5, b.on ? COL.ink : COL.dim);
        textAt(g, b.value, x0 + lw, b.y + b.h - 5, ink);
        return;
    }
    textAt(g, s, b.x + Math.max(3, (b.w - textWidth(g, s)) / 2), b.y + b.h - 5, ink);
}

function drawPop(g, L) {
    var items = popItems(L);
    var r = popRect(L);
    if (!r) {
        return;
    }
    rgba(g, [0.06, 0.06, 0.06, 1], 0.96);
    g.rectangle_rounded(r.x, r.y, r.w, r.h, 5, 5);
    g.fill();
    rgba(g, COL.frame);
    g.set_line_width(1);
    g.rectangle_rounded(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 5, 5);
    g.stroke();
    font(g, 8.5);
    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.kind === "label") {
            textAt(g, it.label, it.x, it.y + it.h - 2, COL.dim);
            continue;
        }
        var hot = view.hover === "item:" + it.kind + ":" + it.id;
        if (it.on || hot) {
            rgba(g, it.on ? (it.kind === "cat" ? COL.btn : COL.accent) : COL.btn);
            g.rectangle_rounded(it.x, it.y, it.w, it.h, 2, 2);
            g.fill();
        }
        var ink = it.on && it.kind !== "cat" ? COL.ink : COL.text;
        textAt(g, it.label, it.x + 3, it.y + it.h - 2, ink);
    }
}

function paint() {
    var g = mgraphics;
    COL = palette();
    var L = curLayout();
    rgba(g, COL.panel);
    g.rectangle(0, 0, L.w, L.h);
    g.fill();
    drawDisplay(g, L);
    for (var i = 0; i < L.buttons.length; i++) {
        drawButton(g, L.buttons[i]);
    }
    if (view.pop !== "") {
        drawPop(g, L);
    }
}

if (typeof mgraphics !== "undefined") {
    mgraphics.init();
    mgraphics.relative_coords = 0;
    mgraphics.autofill = 0;
}
setseed(new Date().getTime() % 100000);
