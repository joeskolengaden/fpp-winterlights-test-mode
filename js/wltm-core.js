/*
 * Winterlights Test Mode - logic module (no DOM, no network).
 *
 * Everything that can be unit-tested lives here: reading FPP's pixel-string config, working out which channels
 * to light, turning "I sent red and saw green" answers into a colour order, grouping, and the staged ("draft")
 * copy of the config that "Apply to FPP" writes back.
 *
 * Loaded by FPP in the page <head> (order of js/ files is not guaranteed), and by the node tests via require().
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WLTMCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var SUB_KEYS = ['virtualStrings', 'virtualStringsB', 'virtualStringsC', 'virtualStringsD', 'virtualStringsE', 'virtualStringsF'];
    var SUB_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
    var DRIVER_TYPES = ['BBB48String'];
    var MAX_STRINGS_PER_OUTPUT = 30;      // FPP's maxVirtualStringsPerOutput
    var MAX_PIXELS_PER_STRING = 1600;     // FPP's pixel-count input maximum
    var MAX_CHANNELSET_CHARS = 3600;      // fppd's command socket takes 4095 bytes for the whole SetTestMode command
    var RGB_PERMS = ['RGB', 'RBG', 'GBR', 'GRB', 'BGR', 'BRG'];
    // Orders added by the Pixel IC Support plugin (5/6-channel and 16-bit chips).
    var EXTRA_ORDERS = ['RGBWC', 'GRBWC', 'RGBCW', 'GRBCW', 'RGBCWX', 'GRBCWX', 'RGBWCX',
        'RGB16', 'GRB16', 'RGBW16', 'GRBW16', 'BRGW16', 'RGBWC16', 'GRBWC16'];
    var COLOUR_NAMES = { R: 'Red', G: 'Green', B: 'Blue', W: 'White' };

    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    function toInt(v, d) { var n = parseInt(v, 10); return isNaN(n) ? (d || 0) : n; }

    var uidCounter = 0;
    function newUid() {
        uidCounter++;
        return 's' + Date.now().toString(36) + uidCounter.toString(36) + Math.floor(Math.random() * 1679616).toString(36);
    }

    // ------------------------------------------------------------------ colour orders

    /* Describe a colour-order string the way FPP's PixelString parser treats it. */
    function orderInfo(order) {
        order = String(order || 'RGB');
        var is16 = order.length >= 5 && order.slice(-2) === '16';
        var letters = is16 ? order.slice(0, -2) : order;
        var info = { order: order, is16: is16, letters: letters, single: false, cpp: letters.length, family: '', rgb: '', hasW: false, wFirst: false };
        if (letters.length === 1) {                     // single-colour ("W") string: one channel per pixel
            info.single = true; info.cpp = 1; info.family = 'single';
            return info;
        }
        if (letters.length === 3) {
            info.family = is16 ? 'x' : '3'; info.rgb = letters;
        } else if (letters.length === 4 && !is16) {
            info.family = '4'; info.hasW = true;
            info.wFirst = letters.charAt(0) === 'W';
            info.rgb = info.wFirst ? letters.slice(1) : letters.slice(0, 3);
        } else {
            info.family = 'x'; info.rgb = letters.slice(0, 3);   // 5/6-channel and 16-bit: RGB first, extras after
        }
        if (info.family === 'x' && is16 && letters.length === 3) info.family = 'x';
        return info;
    }

    /* Channel offset inside one pixel's channel data that carries logical colour X ('R','G','B','W'); -1 if none. */
    function inputOffset(order, X) {
        var i = orderInfo(order);
        if (i.single) return X === 'W' ? 0 : -1;
        var base = i.wFirst ? 1 : 0;
        if (X === 'R') return base;
        if (X === 'G') return base + 1;
        if (X === 'B') return base + 2;
        if (X === 'W' && i.family === '4') return i.wFirst ? 0 : 3;
        return -1;
    }

    /* The colours the colour-order test sends to a string with this configured order. */
    function testColours(order) {
        var i = orderInfo(order);
        if (i.single) return [];
        return i.family === '4' ? ['R', 'G', 'B', 'W'] : ['R', 'G', 'B'];
    }

    function allowedOrders(order) {
        var i = orderInfo(order);
        if (i.single) return ['W'];
        if (i.family === '3') return RGB_PERMS.slice();
        if (i.family === '4') {
            return RGB_PERMS.map(function (p) { return p + 'W'; }).concat(RGB_PERMS.map(function (p) { return 'W' + p; }));
        }
        var n = i.letters.length;
        return EXTRA_ORDERS.filter(function (o) { var x = orderInfo(o); return x.is16 === i.is16 && x.letters.length === n; });
    }

    /*
     * Work out the real colour order from what was seen.
     *   order: the order FPP was configured with while the colours were sent
     *   seen:  { R: 'g', G: 'r', B: 'b', W: 'w' }  values: r g b w, or k for "nothing lit"
     * FPP's order string lists the colours in wire order, so wire slot i carries logical colour order[i].
     * Sending logical X therefore drives the LED on slot index(X); the colour seen is the pixel's real colour there.
     * Returns { status: 'incomplete'|'ok'|'problem', order, missing:[], problem }.
     */
    function detectOrder(order, seen) {
        var info = orderInfo(order);
        seen = seen || {};
        var cols = testColours(order);
        if (!cols.length) return { status: 'problem', order: null, missing: [], problem: 'Single-colour string: there is no colour order to test.' };
        var missing = cols.filter(function (c) { return !seen[c]; });
        if (missing.length) return { status: 'incomplete', order: null, missing: missing, problem: '' };

        var vals = cols.map(function (c) { return String(seen[c]).toLowerCase(); });
        if (vals.indexOf('k') >= 0) {
            var dark = cols.filter(function (c, n) { return vals[n] === 'k'; }).map(function (c) { return COLOUR_NAMES[c]; });
            return { status: 'problem', order: null, missing: [], problem: 'Nothing lit when sending ' + dark.join(', ') + '. Check wiring, power and pixel type.' };
        }
        if (info.family !== '4' && vals.indexOf('w') >= 0) {
            return { status: 'problem', order: null, missing: [], problem: 'White seen on a string configured without a white channel. These may be RGBW pixels set up as RGB.' };
        }
        var uniq = {};
        vals.forEach(function (v) { uniq[v] = 1; });
        if (Object.keys(uniq).length !== vals.length) {
            return { status: 'problem', order: null, missing: [], problem: 'The same colour was seen for two different sent colours. Re-check the answers, or the pixel type.' };
        }
        // wire slots of the configured order, as a letter array to fill in
        var wire = info.family === '4' ? info.letters.split('') : info.rgb.split('');
        var out = wire.slice();
        cols.forEach(function (c, n) { out[wire.indexOf(c)] = vals[n].toUpperCase(); });
        var result;
        if (info.family === '4') {
            result = out.join('');
            var wPos = result.indexOf('W');
            if (wPos !== 0 && wPos !== 3) {
                return { status: 'problem', order: null, missing: [], problem: 'White is in the middle of the pixel (' + result + '). FPP only supports white first or last.' };
            }
        } else {
            result = out.join('') + info.letters.slice(3) + (info.is16 ? '16' : '');
        }
        if (allowedOrders(order).indexOf(result) < 0) {
            return { status: 'problem', order: null, missing: [], problem: 'The detected order ' + result + ' is not one FPP offers for this pixel type.' };
        }
        return { status: 'ok', order: result, missing: [], problem: '' };
    }

    // ------------------------------------------------------------------ reading the config

    function subportCount(port) {
        var dt = toInt(port && port.differentialType, 0);
        if (dt >= 1 && dt <= 3) return dt;
        if (dt >= 4 && dt <= 6) return dt - 3;
        return 1;
    }

    function defaultVs() {
        return { description: '', startChannel: 0, pixelCount: 0, groupCount: 1, reverse: 0, colorOrder: 'RGB',
            nullNodes: 0, endNulls: 0, zigZag: 0, brightness: 100, gamma: '1.0' };
    }

    function dataPixels(vs) {
        var g = toInt(vs.groupCount, 0); if (g < 1) g = 1;
        return Math.ceil(toInt(vs.pixelCount, 0) / g);
    }

    /*
     * Flatten a channelOutputs array into rows the UI can show: one row per string, plus one "empty" row for
     * every port/subport that has no pixels yet.
     * Row: { co, port, sub, idx, key, portNumber, subLetter, hasSubs, empty, vs (reference into the config) }
     */
    function listRows(channelOutputs) {
        var rows = [];
        (channelOutputs || []).forEach(function (co, ci) {
            if (!co || DRIVER_TYPES.indexOf(co.type) < 0 || !Array.isArray(co.outputs)) return;
            co.outputs.forEach(function (port, pi) {
                if (!port) return;
                var subs = subportCount(port);
                var portNumber = toInt(port.portNumber, pi) + 1;
                for (var s = 0; s < subs; s++) {
                    var list = Array.isArray(port[SUB_KEYS[s]]) ? port[SUB_KEYS[s]] : [];
                    var any = false;
                    for (var v = 0; v < list.length; v++) {
                        if (!list[v] || toInt(list[v].pixelCount, 0) <= 0) continue;
                        any = true;
                        rows.push({ co: ci, port: pi, sub: s, idx: v, key: ci + ':' + pi + ':' + s + ':' + v, portNumber: portNumber,
                            subLetter: subs > 1 ? SUB_LETTERS[s] : '', hasSubs: subs > 1, empty: false, vs: list[v], enabled: co.enabled !== 0 });
                    }
                    if (!any) {
                        rows.push({ co: ci, port: pi, sub: s, idx: 0, key: ci + ':' + pi + ':' + s + ':0', portNumber: portNumber,
                            subLetter: subs > 1 ? SUB_LETTERS[s] : '', hasSubs: subs > 1, empty: true, vs: list[0] || null, enabled: co.enabled !== 0 });
                    }
                }
            });
        });
        return rows;
    }

    function rowLabel(row) {
        return 'Port ' + row.portNumber + (row.subLetter ? row.subLetter : '');
    }

    function getList(channelOutputs, co, port, sub) {
        var p = channelOutputs && channelOutputs[co] && channelOutputs[co].outputs && channelOutputs[co].outputs[port];
        if (!p) return null;
        if (!Array.isArray(p[SUB_KEYS[sub]])) p[SUB_KEYS[sub]] = [];
        return p[SUB_KEYS[sub]];
    }

    // ------------------------------------------------------------------ draft (staged copy)

    /* Fresh draft from the live config: every string points at itself. `carry` (old draft) keeps uids by position. */
    function makeDraft(liveOutputs, carry) {
        var draft = clone(liveOutputs || []);
        var old = {};
        if (carry) {
            listRows(carry).forEach(function (r) {
                if (r.vs && r.vs._uid && r.vs._live && r.vs._live.off === 0) old[r.vs._live.key] = r.vs._uid;
            });
        }
        listRows(draft).forEach(function (r) {
            if (r.empty) { if (r.vs) { delete r.vs._uid; delete r.vs._live; } return; }
            r.vs._uid = old[r.key] || newUid();
            r.vs._live = { key: r.key, off: 0 };
        });
        return draft;
    }

    /* After the draft has been written to FPP, every string in it IS the live string at the same position. */
    function rebaseDraft(draft) {
        listRows(draft).forEach(function (r) {
            if (r.empty) return;
            if (!r.vs._uid) r.vs._uid = newUid();
            r.vs._live = { key: r.key, off: 0 };
        });
        return draft;
    }

    /* The config to write to FPP: the draft without our private fields. */
    function stripDraft(draft) {
        var out = clone(draft || []);
        out.forEach(function (co) {
            if (!co || !Array.isArray(co.outputs)) return;
            co.outputs.forEach(function (port) {
                if (!port) return;
                SUB_KEYS.forEach(function (k) {
                    if (!Array.isArray(port[k])) return;
                    port[k].forEach(function (vs) { if (vs) { delete vs._uid; delete vs._live; } });
                });
            });
        });
        return out;
    }

    function liveIndex(liveOutputs) {
        var idx = {};
        listRows(liveOutputs).forEach(function (r) { if (!r.empty) idx[r.key] = r; });
        return idx;
    }

    /*
     * What a draft string maps to on the lights right now.
     * Returns null when the string does not exist in FPP's running config yet (added, not applied).
     * Otherwise { vs: live string, off: physical pixel offset inside it, count: physical pixels testable }.
     */
    function liveOf(draftVs, lidx) {
        if (!draftVs || !draftVs._live) return null;
        var lr = lidx[draftVs._live.key];
        if (!lr) return null;
        var off = toInt(draftVs._live.off, 0);
        var avail = toInt(lr.vs.pixelCount, 0) - off;
        if (avail <= 0) return null;
        return { vs: lr.vs, off: off, count: Math.min(avail, toInt(draftVs.pixelCount, 0)), row: lr };
    }

    /*
     * How many physical pixels of a string can be stepped through when counting: everything FPP drives from its
     * first pixel up to the next string cut from the same live string (after a split) or the live string's end.
     * This lets a count that was saved too low be corrected upward again before applying.
     */
    function countLimit(draft, draftVs, lidx) {
        var l = liveOf(draftVs, lidx);
        if (!l) return 0;
        var total = toInt(l.vs.pixelCount, 0), off = l.off, limit = total - off;
        listRows(draft).forEach(function (r) {
            if (r.empty || r.vs === draftVs || !r.vs._live || r.vs._live.key !== draftVs._live.key) return;
            var o = toInt(r.vs._live.off, 0);
            if (o > off && o - off < limit) limit = o - off;
        });
        return limit;
    }

    /* Human-readable list of differences between the draft and FPP's config. */
    function diffDraft(draft, liveOutputs) {
        var lidx = liveIndex(liveOutputs);
        var out = [];
        var seenLive = {};
        listRows(draft).forEach(function (r) {
            if (r.empty) {
                var lv = liveEmptyDesc(liveOutputs, r);
                var dv = r.vs ? String(r.vs.description || '') : '';
                if (dv !== lv) out.push({ key: r.key, label: rowLabel(r), text: 'name "' + lv + '" \u2192 "' + dv + '"' });
                return;
            }
            var vs = r.vs, parts = [];
            var l = vs._live ? lidx[vs._live.key] : null;
            if (!l) {
                out.push({ key: r.key, uid: vs._uid, label: rowLabel(r), text: 'new string, ' + vs.pixelCount + ' px ' + vs.colorOrder });
                return;
            }
            var off = toInt(vs._live.off, 0);
            if (off > 0 || seenLive[vs._live.key]) parts.push('split from ' + rowLabel(l) + ' at pixel ' + off);
            else {
                if (toInt(vs.pixelCount, 0) !== toInt(l.vs.pixelCount, 0)) parts.push(l.vs.pixelCount + ' \u2192 ' + vs.pixelCount + ' px');
            }
            seenLive[vs._live.key] = true;
            if (String(vs.colorOrder) !== String(l.vs.colorOrder)) parts.push(l.vs.colorOrder + ' \u2192 ' + vs.colorOrder);
            if (off === 0 && String(vs.description || '') !== String(l.vs.description || '')) parts.push('renamed to "' + (vs.description || '') + '"');
            if (off === 0 && parts.length === 0 && toInt(vs.startChannel, 0) !== toInt(l.vs.startChannel, 0)) parts.push('start channel ' + (toInt(l.vs.startChannel, 0) + 1) + ' \u2192 ' + (toInt(vs.startChannel, 0) + 1));
            if (parts.length) out.push({ key: r.key, uid: vs._uid, label: rowLabel(r), text: parts.join(', ') });
        });
        return out;
    }

    function liveEmptyDesc(liveOutputs, r) {
        var p = liveOutputs && liveOutputs[r.co] && liveOutputs[r.co].outputs && liveOutputs[r.co].outputs[r.port];
        var list = p && Array.isArray(p[SUB_KEYS[r.sub]]) ? p[SUB_KEYS[r.sub]] : [];
        return list[0] ? String(list[0].description || '') : '';
    }

    function cleanDescription(s) {
        // FPP's own page builds HTML and JSON by string concatenation, so quotes, backslashes and angle brackets break it.
        return String(s == null ? '' : s).replace(/["'\\<>&\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    }

    /* Rename a string or an empty port/subport. */
    function renameRow(draft, row, name) {
        name = cleanDescription(name);
        var list = getList(draft, row.co, row.port, row.sub);
        if (!list) return false;
        if (!list[row.idx]) {
            if (row.idx !== 0) return false;
            list[0] = defaultVs();
        }
        list[row.idx].description = name;
        return true;
    }

    /* First channel (0-based) after everything the draft uses. */
    function nextFreeChannel(draft) {
        var end = 0;
        listRows(draft).forEach(function (r) {
            if (r.empty) return;
            var e = toInt(r.vs.startChannel, 0) + dataPixels(r.vs) * orderInfo(r.vs.colorOrder).cpp;
            if (e > end) end = e;
        });
        return end;
    }

    /* Add a string to a port/subport. opts: { description, pixelCount, colorOrder, startChannel (1-based, optional) } */
    function addString(draft, co, port, sub, opts) {
        var list = getList(draft, co, port, sub);
        if (!list) return { ok: false, error: 'That port does not exist.' };
        var p = draft[co].outputs[port];
        if (sub >= subportCount(p)) return { ok: false, error: 'That subport is not enabled on this port. Set the receiver type on the Pixel Strings page first.' };
        var count = toInt(opts.pixelCount, 0);
        if (count < 1 || count > MAX_PIXELS_PER_STRING) return { ok: false, error: 'Pixel count must be between 1 and ' + MAX_PIXELS_PER_STRING + '.' };
        var order = String(opts.colorOrder || 'RGB');
        if (RGB_PERMS.indexOf(order) < 0 && allowedOrders(order).indexOf(order) < 0) return { ok: false, error: 'Unknown colour order ' + order + '.' };
        var start = opts.startChannel ? toInt(opts.startChannel, 0) - 1 : nextFreeChannel(draft);
        if (start < 0) return { ok: false, error: 'Start channel must be 1 or more.' };
        var vs = defaultVs();
        var sibling = null;
        list.forEach(function (x) { if (x && toInt(x.pixelCount, 0) > 0) sibling = x; });
        if (sibling) { vs.brightness = sibling.brightness; vs.gamma = sibling.gamma; }
        vs.description = cleanDescription(opts.description);
        vs.pixelCount = count; vs.colorOrder = order; vs.startChannel = start;
        vs._uid = newUid(); vs._live = null;
        // reuse an empty placeholder slot if the list only holds one
        var slot = -1;
        for (var i = 0; i < list.length; i++) { if (!list[i] || toInt(list[i].pixelCount, 0) <= 0) { slot = i; break; } }
        if (slot >= 0 && slot === list.length - 1) {
            if (!vs.description && list[slot] && list[slot].description) vs.description = cleanDescription(list[slot].description);
            list[slot] = vs;
        } else {
            if (list.length >= MAX_STRINGS_PER_OUTPUT) return { ok: false, error: 'FPP allows at most ' + MAX_STRINGS_PER_OUTPUT + ' strings on one output.' };
            list.push(vs);
        }
        return { ok: true, uid: vs._uid };
    }

    function findByUid(draft, uid) {
        var hit = null;
        listRows(draft).forEach(function (r) { if (!r.empty && r.vs._uid === uid) hit = r; });
        return hit;
    }

    /* Remove a string that only exists in the draft (never one FPP is running). */
    function removeNewString(draft, uid) {
        var r = findByUid(draft, uid);
        if (!r) return false;
        if (r.vs._live) return false;
        getList(draft, r.co, r.port, r.sub).splice(r.idx, 1);
        return true;
    }

    /*
     * Split a string after physical pixel `at` (1-based count of pixels that stay in the first part).
     * The lights keep showing the same thing: channels are divided, not renumbered.
     */
    function splitString(draft, uid, at) {
        var r = findByUid(draft, uid);
        if (!r) return { ok: false, error: 'String not found.' };
        var vs = r.vs, n = toInt(vs.pixelCount, 0);
        at = toInt(at, 0);
        if (at < 1 || at >= n) return { ok: false, error: 'Choose a split point between pixel 1 and pixel ' + (n - 1) + '.' };
        if (toInt(vs.groupCount, 0) > 1) return { ok: false, error: 'This string uses grouping. Split it on the Pixel Strings page.' };
        if (toInt(vs.zigZag, 0) > 1) return { ok: false, error: 'This string uses zig-zag. Split it on the Pixel Strings page.' };
        var list = getList(draft, r.co, r.port, r.sub);
        if (list.length >= MAX_STRINGS_PER_OUTPUT) return { ok: false, error: 'FPP allows at most ' + MAX_STRINGS_PER_OUTPUT + ' strings on one output.' };
        var cpp = orderInfo(vs.colorOrder).cpp;
        var second = clone(vs);
        second._uid = newUid();
        second.pixelCount = n - at;
        second.nullNodes = 0;
        second.description = cleanDescription((vs.description || rowLabel(r)) + ' part 2');
        vs.pixelCount = at;
        vs.endNulls = 0;
        if (toInt(vs.reverse, 0) === 1) {
            // reversed: the pixels nearest the controller show the LAST channels
            second.startChannel = toInt(vs.startChannel, 0);
            vs.startChannel = toInt(vs.startChannel, 0) + (n - at) * cpp;
        } else {
            second.startChannel = toInt(vs.startChannel, 0) + at * cpp;
        }
        second._live = vs._live ? { key: vs._live.key, off: toInt(vs._live.off, 0) + at } : null;
        list.splice(r.idx + 1, 0, second);
        return { ok: true, uid: second._uid };
    }

    /* Change the pixel count after counting. A reversed string keeps its look by moving the start channel. */
    function setPixelCount(draft, uid, count) {
        var r = findByUid(draft, uid);
        if (!r) return { ok: false, error: 'String not found.' };
        count = toInt(count, 0);
        if (count < 1 || count > MAX_PIXELS_PER_STRING) return { ok: false, error: 'Pixel count must be between 1 and ' + MAX_PIXELS_PER_STRING + '.' };
        var vs = r.vs, old = toInt(vs.pixelCount, 0);
        if (count === old) return { ok: true };
        var g = toInt(vs.groupCount, 0); if (g < 1) g = 1;
        if (toInt(vs.reverse, 0) === 1 && g === 1) {
            var ns = toInt(vs.startChannel, 0) + (old - count) * orderInfo(vs.colorOrder).cpp;
            if (ns < 0) ns = 0;
            vs.startChannel = ns;
        }
        vs.pixelCount = count;
        if (toInt(vs.zigZag, 0) > count) vs.zigZag = 0;
        if (g > count) vs.groupCount = 1;
        return { ok: true };
    }

    function setColourOrder(draft, uid, order) {
        var r = findByUid(draft, uid);
        if (!r) return { ok: false, error: 'String not found.' };
        if (allowedOrders(r.vs.colorOrder).indexOf(order) < 0) return { ok: false, error: order + ' is not available for this pixel type.' };
        r.vs.colorOrder = order;
        return { ok: true };
    }

    // ------------------------------------------------------------------ channels

    /* 1-based first channel of the data for physical pixel `phys` (0-based) of a live string. */
    function pixelChannel(liveVs, phys) {
        var n = toInt(liveVs.pixelCount, 0);
        var g = toInt(liveVs.groupCount, 0); if (g < 1) g = 1;
        var p = toInt(liveVs.reverse, 0) === 1 ? (n - 1 - phys) : phys;
        return toInt(liveVs.startChannel, 0) + 1 + Math.floor(p / g) * orderInfo(liveVs.colorOrder).cpp;
    }

    /* Sort and merge [first,last] channel ranges. */
    function mergeRanges(ranges) {
        var r = ranges.filter(function (x) { return x && x[1] >= x[0]; }).map(function (x) { return [x[0], x[1]]; });
        r.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
        var out = [];
        r.forEach(function (x) {
            var last = out[out.length - 1];
            if (last && x[0] <= last[1] + 1) { if (x[1] > last[1]) last[1] = x[1]; }
            else out.push(x);
        });
        return out;
    }

    function setString(ranges) {
        return ranges.map(function (x) { return x[0] === x[1] ? String(x[0]) : x[0] + '-' + x[1]; }).join(';');
    }

    /* Channel ranges covering physical pixels [from, from+count) of a live string, every channel of each pixel. */
    function pixelRanges(liveVs, from, count) {
        var cpp = orderInfo(liveVs.colorOrder).cpp, out = [];
        var n = toInt(liveVs.pixelCount, 0);
        for (var p = from; p < from + count && p < n; p++) {
            if (p < 0) continue;
            var c = pixelChannel(liveVs, p);
            out.push([c, c + cpp - 1]);
        }
        return mergeRanges(out);
    }

    /*
     * Frames. A frame says which channels are on; the page turns it into FPP test-mode requests.
     *   solid: every listed channel at `value`      (RGBFill, all three colours = value)
     *   hot:   only the first channel of each 3-channel step in a range is on (RGBFill value,0,0).
     *          Each range starts exactly on a channel to light and its length is a multiple of 3, so one request
     *          can light "channel k of every pixel" on many strings, whatever their channels-per-pixel.
     */
    function emptyFrame() { return { mode: 'solid', ranges: [], note: '' }; }

    function solidFrame(parts) {
        // parts: [{ live: liveVs, from, count }]
        var ranges = [];
        parts.forEach(function (p) { ranges = ranges.concat(pixelRanges(p.live, p.from, p.count)); });
        var f = { mode: 'solid', ranges: mergeRanges(ranges), note: '' };
        return fitFrame(f);
    }

    /* Light logical colour X ('R','G','B','W') on the given strings. parts: [{ live, from, count }] */
    function colourFrame(parts, X) {
        var plain = [], odd = [];
        parts.forEach(function (p) {
            var off = inputOffset(p.live.colorOrder, X);
            if (off < 0) return;
            var info = orderInfo(p.live.colorOrder);
            var g = toInt(p.live.groupCount, 0); if (g < 1) g = 1;
            (info.cpp === 3 ? plain : odd).push({ p: p, off: off, cpp: info.cpp, g: g });
        });
        var ranges = [], note = '';
        var chars = 0;
        plain.forEach(function (e) {
            // channels of the lit pixels form one or more runs with stride 3
            var chans = litChannels(e);
            runs(chans, 3).forEach(function (run) { ranges.push([run[0], run[0] + run[1] * 3 - 1]); chars += 14; });
        });
        if (odd.length) {
            // every lit pixel costs one "a-b;" range (about 12 characters); share what is left of the budget
            var budget = Math.max(0, MAX_CHANNELSET_CHARS - chars);
            var per = Math.max(1, Math.floor(budget / 13 / odd.length));
            var limited = false;
            odd.forEach(function (e) {
                var chans = litChannels(e);
                if (chans.length > per) { chans = chans.slice(0, per); limited = true; }
                chans.forEach(function (c) { ranges.push([c, c + 2]); });
            });
            if (limited) note = 'Strings with 4 or more channels per pixel light only their first ' + per + ' pixels in this test.';
        }
        ranges.sort(function (a, b) { return a[0] - b[0]; });
        // identical ranges (two strings on the same channels) would shift nothing, but drop them to save space
        var dedup = [];
        ranges.forEach(function (r) { var l = dedup[dedup.length - 1]; if (!l || l[0] !== r[0] || l[1] !== r[1]) dedup.push(r); });
        return fitFrame({ mode: 'hot', ranges: dedup, note: note });
    }

    function litChannels(e) {
        var seen = {}, chans = [];
        var n = toInt(e.p.live.pixelCount, 0);
        for (var ph = e.p.from; ph < e.p.from + e.p.count && ph < n; ph++) {
            if (ph < 0) continue;
            var c = pixelChannel(e.p.live, ph) + e.off;
            if (!seen[c]) { seen[c] = 1; chans.push(c); }
        }
        chans.sort(function (a, b) { return a - b; });
        return chans;
    }

    /* Group sorted numbers into [start, length] runs with the given stride. */
    function runs(sorted, stride) {
        var out = [];
        sorted.forEach(function (c) {
            var l = out[out.length - 1];
            if (l && c === l[0] + l[1] * stride) l[1]++;
            else out.push([c, 1]);
        });
        return out;
    }

    /* Keep the channel-set text inside what fppd's command socket accepts. */
    function fitFrame(f) {
        var ranges = f.ranges, s = setString(ranges);
        if (s.length > MAX_CHANNELSET_CHARS) {
            var keep = [], len = 0;
            for (var i = 0; i < ranges.length; i++) {
                var piece = (ranges[i][0] === ranges[i][1] ? String(ranges[i][0]) : ranges[i][0] + '-' + ranges[i][1]);
                if (len + piece.length + 1 > MAX_CHANNELSET_CHARS) break;
                keep.push(ranges[i]); len += piece.length + 1;
            }
            f.ranges = keep;
            f.note = (f.note ? f.note + ' ' : '') + 'Too many separate channel ranges for one test request; only part of the selection is lit.';
        }
        return f;
    }

    /* The body of the /api/testmode request for a frame. value 0 turns the same channels off. */
    function frameRequest(frame, value) {
        value = Math.max(0, Math.min(255, toInt(value, 0)));
        var hot = frame.mode === 'hot';
        return {
            enabled: 1, mode: 'RGBFill', cycleMS: 1000,
            color1: value, color2: hot ? 0 : value, color3: hot ? 0 : value,
            channelSet: setString(frame.ranges), channelSetType: 'channelRange'
        };
    }

    /*
     * "Identify all ports": on every port, light as many pixels as the port number. Ports with subports then leave
     * two pixels dark and light 1 pixel for subport A, 2 for B, and so on.
     */
    function identifyAllFrame(liveOutputs) {
        var parts = [], firstSeen = {};
        listRows(liveOutputs).forEach(function (r) {
            if (r.empty) return;
            var k = r.co + ':' + r.port + ':' + r.sub;
            if (firstSeen[k]) return;          // pattern goes on the first string of each port/subport
            firstSeen[k] = true;
            var n = toInt(r.vs.pixelCount, 0);
            parts.push({ live: r.vs, from: 0, count: Math.min(n, r.portNumber) });
            if (r.hasSubs) parts.push({ live: r.vs, from: r.portNumber + 2, count: Math.max(0, Math.min(n - r.portNumber - 2, r.sub + 1)) });
        });
        return solidFrame(parts.filter(function (p) { return p.count > 0; }));
    }

    // ------------------------------------------------------------------ record / status

    function statusOf(draftVs, live, meta, hasDiff) {
        meta = meta || {};
        if (!live) return { code: 'new', text: 'New \u00b7 apply to test', cls: 'blue' };
        if (hasDiff) return { code: 'apply', text: 'To apply', cls: 'blue' };
        var liveOrder = String(live.vs.colorOrder);
        if (meta.verified === true && meta.verifiedOrder === liveOrder) return { code: 'verified', text: 'Verified', cls: 'ok' };
        if (meta.verified === false && meta.verifiedOrder === liveOrder) return { code: 'failed', text: 'Verify failed', cls: 'warn' };
        if (meta.detected && meta.detected === liveOrder) return { code: 'toverify', text: 'Needs verify', cls: 'on' };
        if (meta.counted || meta.detected || (meta.seen && Object.keys(meta.seen).length)) return { code: 'progress', text: 'In progress', cls: 'on' };
        return { code: 'none', text: 'Not tested', cls: 'grey' };
    }

    /*
     * Group strings by detected colour order.
     * items: [{ uid, label, liveOrder, draftOrder, meta }]
     * Returns { groups: [{ order, items, state: 'match'|'staged'|'wrong' }], waiting: [...], problems: [{item, problem}] }
     */
    function groupByOrder(items) {
        var map = {}, waiting = [], problems = [];
        items.forEach(function (it) {
            var m = it.meta || {};
            if (m.detected) { (map[m.detected] = map[m.detected] || []).push(it); return; }
            if (m.problem) { problems.push({ item: it, problem: m.problem }); return; }
            waiting.push(it);
        });
        var groups = Object.keys(map).map(function (order) {
            var its = map[order];
            var allLive = its.every(function (i) { return i.liveOrder === order; });
            var allDraft = its.every(function (i) { return i.draftOrder === order; });
            return { order: order, items: its, state: allLive ? 'match' : (allDraft ? 'staged' : 'wrong') };
        });
        // The order (and so the letters) must not depend on state: a group keeps its letter while it is being fixed.
        groups.sort(function (a, b) { return b.items.length - a.items.length || (a.order < b.order ? -1 : 1); });
        groups.forEach(function (g, i) { g.name = String.fromCharCode(65 + (i % 26)); });
        return { groups: groups, waiting: waiting, problems: problems };
    }

    function csvCell(v) {
        v = v == null ? '' : String(v);
        if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;       // stop spreadsheets treating a name as a formula
        return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }

    function toCsv(rowsOut) {
        return rowsOut.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
    }

    return {
        SUB_KEYS: SUB_KEYS, SUB_LETTERS: SUB_LETTERS, RGB_PERMS: RGB_PERMS, COLOUR_NAMES: COLOUR_NAMES,
        MAX_CHANNELSET_CHARS: MAX_CHANNELSET_CHARS, MAX_PIXELS_PER_STRING: MAX_PIXELS_PER_STRING,
        clone: clone, toInt: toInt, newUid: newUid,
        orderInfo: orderInfo, inputOffset: inputOffset, testColours: testColours, allowedOrders: allowedOrders, detectOrder: detectOrder,
        subportCount: subportCount, defaultVs: defaultVs, dataPixels: dataPixels, listRows: listRows, rowLabel: rowLabel,
        makeDraft: makeDraft, rebaseDraft: rebaseDraft, stripDraft: stripDraft, liveIndex: liveIndex, liveOf: liveOf, countLimit: countLimit, diffDraft: diffDraft,
        cleanDescription: cleanDescription, renameRow: renameRow, nextFreeChannel: nextFreeChannel, addString: addString,
        findByUid: findByUid, removeNewString: removeNewString, splitString: splitString, setPixelCount: setPixelCount, setColourOrder: setColourOrder,
        pixelChannel: pixelChannel, mergeRanges: mergeRanges, setString: setString, pixelRanges: pixelRanges,
        emptyFrame: emptyFrame, solidFrame: solidFrame, colourFrame: colourFrame, frameRequest: frameRequest, identifyAllFrame: identifyAllFrame,
        statusOf: statusOf, groupByOrder: groupByOrder, toCsv: toCsv
    };
});
