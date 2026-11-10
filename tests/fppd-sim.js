/*
 * A small model of fppd 5.4's channel tester (src/channeltester/TestPatternBase.cpp + RGBFill.cpp) and of
 * PixelString::SetupMap, so tests can ask "which LED colours would really be on?" for a sequence of requests.
 */
'use strict';
function Sim() { this.data = new Uint8Array(200000); this.set = []; this.setStr = null; this.on = false; this.cmdTooLong = false; }
Sim.prototype.post = function (body) {
    var json = JSON.stringify(body);
    if (('SetTestMode,' + json).length > 4095) { this.cmdTooLong = true; return; }   // command socket buffer
    if (!body.enabled) {
        // DisableTest: clear the channels of the current set
        for (var s = 0; s < this.set.length; s++) for (var c = this.set[s][0]; c <= this.set[s][1]; c++) this.data[c] = 0;
        this.on = false; this.set = []; this.setStr = null;
        return;
    }
    if (body.mode !== 'RGBFill') throw new Error('sim only models RGBFill');
    if (this.setStr !== body.channelSet) {
        this.setStr = body.channelSet; this.set = [];
        body.channelSet.split(';').forEach(function (r) {
            var p = r.split('-'); var a = parseInt(p[0], 10); if (a > 0) a--;
            var b = p.length > 1 ? parseInt(p[1], 10) : a + 1; if (p.length > 1 ? b > 0 : true) b--;
            if (p.length === 1) b = a;
            this.set.push([a, b]);
        }, this);
    }
    var total = 0; this.set.forEach(function (r) { total += r[1] - r[0] + 1; });
    var test = new Uint8Array(total + 3);
    for (var i = 0; i < total; i += 3) { test[i] = body.color1; test[i + 1] = body.color2; test[i + 2] = body.color3; }
    this.on = true;
    // OverlayTestData: ranges are copied in order from one continuous test buffer; old channels are left alone
    var copied = 0;
    this.set.forEach(function (r) { for (var c = r[0]; c <= r[1]; c++) this.data[c] = test[copied++]; }, this);
};
/* channels (1-based) that are non-zero */
Sim.prototype.lit = function () { var o = []; for (var c = 0; c < this.data.length; c++) if (this.data[c]) o.push(c + 1); return o; };

/*
 * What a string's LEDs show: array (physical order) of { R,G,B,W } booleans, given the config FPP runs (vs)
 * and the pixel's real wire order (trueOrder, e.g. 'GRB' or 'GRBW').
 */
function leds(sim, vs, trueOrder) {
    var order = vs.colorOrder, four = order.length === 4, wFirst = four && order[0] === 'W';
    var rgb = four ? (wFirst ? order.slice(1) : order.slice(0, 3)) : order.slice(0, 3);
    var cpp = order.length === 1 ? 1 : (order.slice(-2) === '16' ? order.length - 2 : order.length);
    var n = vs.pixelCount, g = vs.groupCount > 1 ? vs.groupCount : 1, out = [];
    for (var p = 0; p < n; p++) {
        var ch = vs.startChannel + Math.floor(p / g) * cpp;      // 0-based
        // wire byte i takes input channel map[i]  (PixelString::SetupMap)
        var map = [];
        if (order.length === 1) { out.push({ R: false, G: false, B: false, W: !!sim.data[ch] }); continue; }
        if (wFirst) map.push(ch);
        var base = wFirst ? ch + 1 : ch;
        for (var i = 0; i < 3; i++) map.push(base + 'RGB'.indexOf(rgb[i]));
        if (four && !wFirst) map.push(ch + 3);
        var px = { R: false, G: false, B: false, W: false };
        for (var w = 0; w < map.length && w < trueOrder.length; w++) if (sim.data[map[w]]) px[trueOrder[w]] = true;
        out.push(px);
    }
    if (vs.reverse) out.reverse();
    return out;
}
function colourName(px) {
    var on = Object.keys(px).filter(function (k) { return px[k]; });
    if (!on.length) return 'k';
    if (on.length === 1) return on[0].toLowerCase();
    return on.join('');
}
module.exports = { Sim: Sim, leds: leds, colourName: colourName };
