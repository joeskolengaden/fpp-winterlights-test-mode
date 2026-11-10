'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../js/wltm-core.js');
const { Sim, leds, colourName } = require('./fppd-sim.js');

function vs(o) { return Object.assign(C.defaultVs(), o); }
function cfg() {
    return [{
        type: 'BBB48String', subType: 'F8-B', enabled: 1, outputs: [
            { portNumber: 0, virtualStrings: [vs({ description: 'Roof', startChannel: 0, pixelCount: 50, colorOrder: 'RGB' })] },
            { portNumber: 1, virtualStrings: [vs({ description: 'Tree', startChannel: 150, pixelCount: 30, colorOrder: 'RGBW' })] },
            { portNumber: 2, differentialType: 2,
                virtualStrings: [vs({ description: 'Win A', startChannel: 270, pixelCount: 20, colorOrder: 'RGB', reverse: 1 })],
                virtualStringsB: [vs({ description: 'Win B', startChannel: 330, pixelCount: 10, colorOrder: 'WRGB' })] },
            { portNumber: 3, virtualStrings: [vs({})] },
            { portNumber: 4, differentialType: 3, virtualStrings: [], virtualStringsB: [vs({ description: 'Fence', startChannel: 400, pixelCount: 12, colorOrder: 'BRG', groupCount: 3 })] },
            { portNumber: 5, virtualStrings: [vs({ description: 'Single', startChannel: 420, pixelCount: 8, colorOrder: 'W' })] }
        ]
    }, { type: 'BBBSerial', subType: 'off' }];
}
/* Send a frame the way the page does (clear the previous one first) and return the simulator. */
function play(sim, frame, value, prev) {
    if (prev && prev.ranges.length) sim.post(C.frameRequest(prev, 0));
    if (frame.ranges.length) sim.post(C.frameRequest(frame, value));
    else sim.post({ enabled: 0 });
    return sim;
}
function rowsByLabel(outputs) {
    const m = {};
    C.listRows(outputs).forEach(r => { m[C.rowLabel(r)] = r; });
    return m;
}

test('orderInfo covers stock and plugin orders', () => {
    assert.equal(C.orderInfo('RGB').cpp, 3);
    assert.equal(C.orderInfo('GRBW').cpp, 4);
    assert.equal(C.orderInfo('WRGB').wFirst, true);
    assert.equal(C.orderInfo('W').cpp, 1);
    assert.equal(C.orderInfo('RGBWC').cpp, 5);
    assert.equal(C.orderInfo('RGBCWX').cpp, 6);
    assert.equal(C.orderInfo('RGB16').cpp, 3);
    assert.equal(C.orderInfo('RGBW16').cpp, 4);
    assert.equal(C.orderInfo('RGBWC16').cpp, 5);
    assert.deepEqual(C.testColours('RGBW'), ['R', 'G', 'B', 'W']);
    assert.deepEqual(C.testColours('RGBW16'), ['R', 'G', 'B']);
    assert.deepEqual(C.testColours('W'), []);
    assert.equal(C.inputOffset('WRGB', 'R'), 1);
    assert.equal(C.inputOffset('WRGB', 'W'), 0);
    assert.equal(C.inputOffset('RGBW', 'W'), 3);
    assert.equal(C.inputOffset('RGB', 'W'), -1);
});

test('listRows: ports, subports, empty slots', () => {
    const rows = C.listRows(cfg());
    assert.deepEqual(rows.map(r => C.rowLabel(r) + (r.empty ? ':empty' : '')),
        ['Port 1', 'Port 2', 'Port 3A', 'Port 3B', 'Port 4:empty', 'Port 5A:empty', 'Port 5B', 'Port 5C:empty', 'Port 6']);
});

test('detectOrder: every true order is found from every configured order (3 channel)', () => {
    C.RGB_PERMS.forEach(conf => C.RGB_PERMS.forEach(truth => {
        const sim = new Sim();
        const v = vs({ startChannel: 30, pixelCount: 5, colorOrder: conf });
        const seen = {};
        let prev = null;
        ['R', 'G', 'B'].forEach(X => {
            const f = C.colourFrame([{ live: v, from: 0, count: 5 }], X);
            play(sim, f, 200, prev); prev = f;
            const shown = leds(sim, v, truth).map(colourName);
            assert.ok(shown.every(s => s === shown[0]) && shown[0].length === 1, conf + '/' + truth + ' sending ' + X + ' shows ' + shown[0]);
            seen[X] = shown[0];
        });
        const res = C.detectOrder(conf, seen);
        assert.equal(res.status, 'ok');
        assert.equal(res.order, truth, 'configured ' + conf + ' true ' + truth);
    }));
});

test('detectOrder: RGBW strings, white first or last, any configured order', () => {
    const all = C.allowedOrders('RGBW');
    assert.equal(all.length, 12);
    all.forEach(conf => all.forEach(truth => {
        const sim = new Sim();
        const v = vs({ startChannel: 8, pixelCount: 4, colorOrder: conf });
        const seen = {};
        let prev = null;
        ['R', 'G', 'B', 'W'].forEach(X => {
            const f = C.colourFrame([{ live: v, from: 0, count: 4 }], X);
            play(sim, f, 255, prev); prev = f;
            const shown = leds(sim, v, truth).map(colourName);
            assert.ok(shown.every(s => s === shown[0]) && shown[0].length === 1, conf + '/' + truth + ' sending ' + X + ' shows ' + JSON.stringify(shown));
            seen[X] = shown[0];
        });
        const res = C.detectOrder(conf, seen);
        assert.equal(res.order, truth, 'configured ' + conf + ' true ' + truth + ' ' + JSON.stringify(res));
    }));
});

test('detectOrder: problems are reported, not guessed', () => {
    assert.equal(C.detectOrder('RGB', { R: 'r' }).status, 'incomplete');
    assert.equal(C.detectOrder('RGB', { R: 'r', G: 'k', B: 'b' }).status, 'problem');
    assert.equal(C.detectOrder('RGB', { R: 'r', G: 'r', B: 'b' }).status, 'problem');
    assert.match(C.detectOrder('RGB', { R: 'r', G: 'g', B: 'w' }).problem, /RGBW/);
    assert.match(C.detectOrder('RGBW', { R: 'r', G: 'w', B: 'b', W: 'g' }).problem, /middle/);
    assert.equal(C.detectOrder('RGBWC', { R: 'g', G: 'r', B: 'b' }).order, 'GRBWC');
    assert.equal(C.detectOrder('RGBWC', { R: 'b', G: 'r', B: 'g' }).status, 'problem');   // BRGWC is not offered
    assert.equal(C.detectOrder('RGBW16', { R: 'b', G: 'r', B: 'g' }).order, 'BRGW16');
    assert.equal(C.detectOrder('W', {}).status, 'problem');
});

test('colour test on all ports at once lights only the wanted colour, and nothing is left on afterwards', () => {
    const outputs = cfg();
    const lidx = C.liveIndex(outputs);
    const rows = C.listRows(outputs).filter(r => !r.empty && C.testColours(r.vs.colorOrder).length);
    const parts = rows.map(r => ({ live: r.vs, from: 0, count: r.vs.pixelCount }));
    const sim = new Sim();
    let prev = null;
    ['R', 'G', 'B', 'W'].forEach(X => {
        const f = C.colourFrame(parts, X);
        play(sim, f, 77, prev); prev = f;
        assert.equal(sim.cmdTooLong, false);
        rows.forEach(r => {
            // pixels wired exactly as configured must show exactly X (or stay dark when the string has no such colour)
            const shown = leds(sim, r.vs, r.vs.colorOrder).map(colourName);
            const want = C.inputOffset(r.vs.colorOrder, X) < 0 ? 'k' : X.toLowerCase();
            assert.ok(shown.every(s => s === want), C.rowLabel(r) + ' sending ' + X + ': ' + JSON.stringify(shown));
        });
        // the single-colour string is never touched
        assert.ok(leds(sim, lidx['0:5:0:0'].vs, 'W').every(p => !p.W));
    });
    play(sim, C.emptyFrame(), 0, prev);
    assert.deepEqual(sim.lit(), []);
});

test('counting: one physical pixel at a time, including reversed and grouped strings', () => {
    const outputs = cfg(), R = rowsByLabel(outputs);
    [['Port 1', 'RGB'], ['Port 2', 'RGBW'], ['Port 3A', 'RGB'], ['Port 3B', 'WRGB']].forEach(([label, truth]) => {
        const v = R[label].vs, sim = new Sim();
        let prev = null;
        for (let pos = 1; pos <= v.pixelCount; pos++) {
            const f = C.solidFrame([{ live: v, from: pos - 1, count: 1 }]);
            play(sim, f, 255, prev); prev = f;
            const shown = leds(sim, v, truth).map(colourName);
            shown.forEach((s, i) => assert.equal(s !== 'k', i === pos - 1, label + ' pos ' + pos + ' pixel ' + (i + 1) + ' = ' + s));
        }
    });
    // grouped (3): physical pixels 4..6 share data pixel 2
    const g = R['Port 5B'].vs, sim = new Sim();
    play(sim, C.solidFrame([{ live: g, from: 4, count: 1 }]), 255, null);
    assert.deepEqual(leds(sim, g, 'BRG').map(p => colourName(p) !== 'k'), [false, false, false, true, true, true, false, false, false, false, false, false]);
});

test('identify all: port N shows N pixels, subports add a second block', () => {
    const outputs = cfg(), R = rowsByLabel(outputs), sim = new Sim();
    play(sim, C.identifyAllFrame(outputs), 255, null);
    const on = l => leds(sim, R[l].vs, R[l].vs.colorOrder).map(p => colourName(p) !== 'k' ? 1 : 0).join('');
    assert.equal(on('Port 1'), '1' + '0'.repeat(49));
    assert.equal(on('Port 2'), '11' + '0'.repeat(28));
    assert.equal(on('Port 3A'), '111' + '00' + '1' + '0'.repeat(14));
    assert.equal(on('Port 3B'), '111' + '00' + '11' + '000');
    assert.equal(on('Port 6'), '111111' + '00');
});

test('changing frames never leaves an old pixel lit (the page clears the previous frame first)', () => {
    const outputs = cfg(), R = rowsByLabel(outputs), sim = new Sim();
    const a = C.solidFrame([{ live: R['Port 1'].vs, from: 0, count: 50 }]);
    const b = C.solidFrame([{ live: R['Port 2'].vs, from: 3, count: 1 }]);
    play(sim, a, 255, null);
    play(sim, b, 255, a);
    assert.deepEqual(sim.lit(), [163, 164, 165, 166]);
    // and this is why the clear is needed: without it fppd keeps the old channels
    const sim2 = new Sim();
    sim2.post(C.frameRequest(a, 255)); sim2.post(C.frameRequest(b, 255));
    assert.ok(sim2.lit().length > 4);
});

test('big installs stay inside the command size limit', () => {
    const outs = [];
    for (let p = 0; p < 48; p++) {
        outs.push({ portNumber: p, virtualStrings: [vs({ startChannel: p * 3200, pixelCount: 800, colorOrder: p % 2 ? 'RGBW' : 'GRB' })] });
    }
    const outputs = [{ type: 'BBB48String', outputs: outs }];
    const parts = C.listRows(outputs).map(r => ({ live: r.vs, from: 0, count: r.vs.pixelCount }));
    ['R', 'G', 'B', 'W'].forEach(X => {
        const f = C.colourFrame(parts, X);
        const body = 'SetTestMode,' + JSON.stringify(C.frameRequest(f, 255));
        assert.ok(body.length < 4095, X + ' request is ' + body.length + ' bytes');
        assert.ok(f.ranges.length > 24);
        if (X !== 'W') assert.match(f.note, /first \d+ pixels/);
        const sim = new Sim(); play(sim, f, 255, null);
        assert.equal(sim.cmdTooLong, false);
        // every RGBW string has at least its first pixel lit in the right colour
        C.listRows(outputs).filter(r => r.vs.colorOrder === 'RGBW').forEach(r => {
            assert.equal(colourName(leds(sim, r.vs, 'RGBW')[0]), X.toLowerCase());
        });
    });
    assert.ok(('SetTestMode,' + JSON.stringify(C.frameRequest(C.identifyAllFrame(outputs), 255))).length < 4095);
});

test('draft: rename, count, colour order, add, split, diff, strip', () => {
    const live = cfg();
    const draft = C.makeDraft(live);
    assert.deepEqual(C.diffDraft(draft, live), []);
    assert.deepEqual(C.stripDraft(draft), live, 'an untouched draft writes back exactly what FPP had');
    const R = rowsByLabel(draft);

    C.renameRow(draft, R['Port 1'], '  Roof "left" <b> ');
    assert.equal(R['Port 1'].vs.description, 'Roof left b');
    C.renameRow(draft, R['Port 4'], 'Spare');
    assert.ok(C.setPixelCount(draft, R['Port 1'].vs._uid, 48).ok);
    assert.ok(C.setColourOrder(draft, R['Port 1'].vs._uid, 'GRB').ok);
    assert.equal(C.setColourOrder(draft, R['Port 1'].vs._uid, 'GRBW').ok, false, 'cannot change channel count through the colour test');
    assert.equal(C.setPixelCount(draft, R['Port 1'].vs._uid, 0).ok, false);

    // reversed string: shrinking keeps the remaining pixels on the same channels
    const before = new Sim(), a = R['Port 3A'].vs, liveA = rowsByLabel(live)['Port 3A'].vs;
    C.setPixelCount(draft, a._uid, 15);
    assert.equal(a.startChannel, 270 + 5 * 3);
    for (let p = 0; p < 15; p++) assert.equal(C.pixelChannel(a, p), C.pixelChannel(liveA, p));

    const add = C.addString(draft, 0, 3, 0, { description: 'New prop', pixelCount: 25, colorOrder: 'GRB' });
    assert.ok(add.ok);
    assert.equal(C.findByUid(draft, add.uid).vs.startChannel, 428, 'starts after the last used channel');
    assert.equal(C.findByUid(draft, add.uid).vs.description, 'New prop');
    assert.equal(C.addString(draft, 0, 0, 1, { pixelCount: 5 }).ok, false, 'subport B is not enabled on port 1');
    assert.equal(C.addString(draft, 0, 0, 0, { pixelCount: 5000 }).ok, false);
    assert.equal(C.liveOf(C.findByUid(draft, add.uid).vs, C.liveIndex(live)), null, 'a new string cannot be tested before apply');

    const d = C.diffDraft(draft, live).map(x => x.label + ': ' + x.text);
    assert.deepEqual(d, ['Port 1: 50 → 48 px, RGB → GRB, renamed to "Roof left b"', 'Port 3A: 20 → 15 px', 'Port 4: new string, 25 px GRB']);

    const out = C.stripDraft(draft);
    assert.ok(!JSON.stringify(out).includes('_uid') && !JSON.stringify(out).includes('_live'));
    assert.equal(out[1].type, 'BBBSerial', 'other outputs are passed through untouched');
    assert.ok(C.removeNewString(draft, add.uid));
    assert.equal(C.removeNewString(draft, R['Port 1'].vs._uid), false, 'a live string can never be removed here');
});

test('split keeps every pixel on the channel it had, forward and reversed', () => {
    ['Port 1', 'Port 3A', 'Port 2'].forEach(label => {
        const live = cfg(), draft = C.makeDraft(live), lidx = C.liveIndex(live);
        const r = rowsByLabel(draft)[label], lv = rowsByLabel(live)[label].vs, n = lv.pixelCount;
        const res = C.splitString(draft, r.vs._uid, 7);
        assert.ok(res.ok, res.error);
        const first = r.vs, second = C.findByUid(draft, res.uid).vs;
        assert.equal(first.pixelCount, 7); assert.equal(second.pixelCount, n - 7);
        for (let p = 0; p < n; p++) {
            const part = p < 7 ? first : second, pp = p < 7 ? p : p - 7;
            assert.equal(C.pixelChannel(part, pp), C.pixelChannel(lv, p), label + ' pixel ' + p);
        }
        // both halves are testable straight away, on the right physical pixels
        const l2 = C.liveOf(second, lidx);
        assert.equal(l2.off, 7); assert.equal(l2.count, n - 7);
        const sim = new Sim();
        play(sim, C.solidFrame([{ live: l2.vs, from: l2.off, count: 1 }]), 255, null);
        assert.equal(leds(sim, lv, lv.colorOrder).findIndex(p => colourName(p) !== 'k'), 7);
        // splitting the second part again keeps offsets right
        const res2 = C.splitString(draft, res.uid, 3);
        assert.equal(C.liveOf(C.findByUid(draft, res2.uid).vs, lidx).off, 10);
        // after apply the draft is the live config
        const applied = C.stripDraft(draft);
        C.rebaseDraft(draft);
        assert.deepEqual(C.diffDraft(draft, applied), []);
        assert.equal(C.liveOf(C.findByUid(draft, res2.uid).vs, C.liveIndex(applied)).off, 0);
    });
    const live = cfg(), draft = C.makeDraft(live);
    assert.equal(C.splitString(draft, rowsByLabel(draft)['Port 5B'].vs._uid, 3).ok, false, 'grouped strings are not split here');
    assert.equal(C.splitString(draft, rowsByLabel(draft)['Port 1'].vs._uid, 50).ok, false);
});

test('makeDraft carries uids over an outside change; meta is keyed by uid', () => {
    const live = cfg(), d1 = C.makeDraft(live);
    const uid = rowsByLabel(d1)['Port 2'].vs._uid;
    const live2 = cfg(); live2[0].outputs[1].virtualStrings[0].pixelCount = 99;
    const d2 = C.makeDraft(live2, d1);
    assert.equal(rowsByLabel(d2)['Port 2'].vs._uid, uid);
    assert.equal(rowsByLabel(d2)['Port 2'].vs.pixelCount, 99);
});

test('status and grouping', () => {
    const live = cfg(), draft = C.makeDraft(live), lidx = C.liveIndex(live), R = rowsByLabel(draft);
    const v = R['Port 1'].vs, l = C.liveOf(v, lidx);
    assert.equal(C.statusOf(v, l, {}, false).code, 'none');
    assert.equal(C.statusOf(v, l, { counted: 50 }, false).code, 'progress');
    assert.equal(C.statusOf(v, l, { detected: 'RGB' }, false).code, 'toverify');
    assert.equal(C.statusOf(v, l, { detected: 'GRB' }, true).code, 'apply');
    assert.equal(C.statusOf(v, l, { verified: true, verifiedOrder: 'RGB' }, false).code, 'verified');
    assert.equal(C.statusOf(v, l, { verified: true, verifiedOrder: 'GRB' }, false).code, 'none', 'a verify result for another order no longer counts');
    assert.equal(C.statusOf(v, l, { verified: false, verifiedOrder: 'RGB' }, false).code, 'failed');
    assert.equal(C.statusOf(v, null, {}, false).code, 'new');

    const g = C.groupByOrder([
        { uid: 'a', label: 'Port 1', liveOrder: 'RGB', draftOrder: 'RGB', meta: { detected: 'RGB' } },
        { uid: 'b', label: 'Port 2', liveOrder: 'RGB', draftOrder: 'RGB', meta: { detected: 'GRB' } },
        { uid: 'c', label: 'Port 3', liveOrder: 'RGB', draftOrder: 'RGB', meta: { detected: 'GRB' } },
        { uid: 'd', label: 'Port 4', liveOrder: 'RGB', draftOrder: 'BRG', meta: { detected: 'BRG' } },
        { uid: 'e', label: 'Port 5', liveOrder: 'RGB', draftOrder: 'RGB', meta: { seen: { R: 'r' } } },
        { uid: 'f', label: 'Port 6', liveOrder: 'RGB', draftOrder: 'RGB', meta: { problem: 'Nothing lit' } }
    ]);
    assert.deepEqual(g.groups.map(x => x.name + ':' + x.order + ':' + x.state + ':' + x.items.length), ['A:GRB:wrong:2', 'B:BRG:staged:1', 'C:RGB:match:1']);
    assert.equal(g.waiting.length, 1); assert.equal(g.problems.length, 1);
});

test('csv escaping', () => {
    assert.equal(C.toCsv([['a', 'b,c', 'd"e', '=1+1']]), 'a,"b,c","d""e",\'=1+1\r\n');
});

test('countLimit: whole live string, or up to the next split part', () => {
    const live = cfg(), draft = C.makeDraft(live), lidx = C.liveIndex(live), r = rowsByLabel(draft)['Port 1'];
    assert.equal(C.countLimit(draft, r.vs, lidx), 50);
    C.setPixelCount(draft, r.vs._uid, 40);
    assert.equal(C.countLimit(draft, r.vs, lidx), 50, 'a saved count can be corrected upward');
    const s = C.splitString(draft, r.vs._uid, 30);
    assert.equal(C.countLimit(draft, r.vs, lidx), 30);
    assert.equal(C.countLimit(draft, C.findByUid(draft, s.uid).vs, lidx), 20);
    assert.equal(C.countLimit(draft, { pixelCount: 5, _live: null }, lidx), 0);
});

test('removeSubport: any subport, later ones move up, receiver count goes down, diff reports it', () => {
    const live = cfg();
    live[0].outputs[2].virtualStringsC = [vs({ description: 'Win C', startChannel: 500, pixelCount: 9 }), vs({ description: 'Win C2', startChannel: 600, pixelCount: 4 })];
    live[0].outputs[2].differentialType = 6;                          // smart v2, three receivers
    const base = C.makeDraft(live);
    assert.equal(C.subportCount(base[0].outputs[2]), 3);
    const uidC = rowsByLabel(base)['Port 3C'].vs._uid;

    // delete the middle one: C moves up to B
    let draft = C.clone(base);
    const r = C.removeSubport(draft, 0, 2, 1);
    assert.ok(r.ok); assert.equal(r.removed, 1); assert.equal(r.moved, 1);
    assert.equal(draft[0].outputs[2].differentialType, 5);
    assert.ok(!('virtualStringsC' in draft[0].outputs[2]));
    const R = rowsByLabel(draft);
    assert.deepEqual(C.listRows(draft).filter(x => x.portNumber === 3).map(x => C.rowLabel(x) + ':' + (x.vs.description || '')), ['Port 3A:Win A', 'Port 3B:Win C', 'Port 3B:Win C2']);
    assert.equal(R['Port 3B'].vs._uid, uidC, 'a moved string keeps its identity, so its test results stay with it');
    assert.deepEqual(C.diffDraft(draft, live).map(x => x.label + ': ' + x.text), [
        'Port 3B: moved up from Port 3C', 'Port 3B: moved up from Port 3C', 'Port 3B: deleted (10 px, Win B)', 'Port 3: subports 3 \u2192 2']);
    // everything that was on the lights is still testable at its old place until Apply
    const lidx = C.liveIndex(live);
    assert.equal(C.liveOf(R['Port 3B'].vs, lidx).vs.description, 'Win C2', 'the moved string still maps to its own live string');
    assert.equal(C.liveOf(C.listRows(draft).filter(x => x.vs && x.vs.description === 'Win C')[0].vs, lidx).vs.description, 'Win C');
    assert.equal(C.stripDraft(draft)[0].outputs[2].virtualStringsB[0].description, 'Win C');

    // delete the first one: B becomes A and C becomes B
    draft = C.clone(base);
    assert.ok(C.removeSubport(draft, 0, 2, 0).ok);
    assert.equal(draft[0].outputs[2].virtualStrings[0].description, 'Win B');
    assert.equal(draft[0].outputs[2].virtualStringsB[0].description, 'Win C');
    assert.equal(draft[0].outputs[2].differentialType, 5);

    // delete the last one
    draft = C.clone(base);
    assert.ok(C.removeSubport(draft, 0, 2, 2).ok);
    assert.equal(draft[0].outputs[2].differentialType, 5);
    assert.deepEqual(C.diffDraft(draft, live).map(x => x.text), ['deleted (9 px, Win C)', 'deleted (4 px, Win C2)', 'subports 3 \u2192 2']);

    // smart v1 stores the count itself; a port's only subport can never be deleted
    const l1 = cfg(); l1[0].outputs[2].differentialType = 2;
    const d1 = C.makeDraft(l1);
    assert.ok(C.removeSubport(d1, 0, 2, 1).ok);
    assert.equal(d1[0].outputs[2].differentialType, 1);
    assert.equal(C.removeSubport(d1, 0, 2, 0).ok, false);
    assert.equal(C.removeSubport(d1, 0, 0, 0).ok, false, 'a port without subports');
    assert.equal(C.removeSubport(draft, 0, 2, 9).ok, false);
});

// FPP's www/api/index.php require_once()s <plugin>/api.php on EVERY /api/ request and then calls
// getEndpoints<name>(). Our backend runs its handler and exit()s at load time, so it must never be called api.php
// (that once broke the whole FPP API: /api/plugin, /api/configfile, fppd restart all answered "Unknown action").
test('no plugin file is named api.php (FPP would load it into every API request)', () => {
    const fs = require('fs'), path = require('path');
    const root = path.join(__dirname, '..');
    assert.equal(fs.existsSync(path.join(root, 'api.php')), false);
    assert.ok(fs.existsSync(path.join(root, 'wltm-api.php')));
    for (const f of ['js/wltm-ui.js', 'tests/e2e.test.js', 'tests/hw/check_fpp.py']) {
        assert.ok(!/page=api\.php/.test(fs.readFileSync(path.join(root, f), 'utf8')), f + ' still points at api.php');
    }
});

// Stronger version of the check above: replay FPP 5.4's addPluginEndpoints() (www/api/index.php) over a plugins
// folder holding this plugin, exactly as it runs on every /api/ request. If any file FPP would load prints, exits or
// lacks the getEndpoints function, the real FPP API would break, so the replay must reach its last line.
test('FPP\'s plugin endpoint loader runs through this plugin untouched', () => {
    const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
    const root = path.join(__dirname, '..');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wltm-plugins-'));
    try {
        const dir = path.join(base, 'fpp-winterlights-test-mode');
        fs.mkdirSync(dir);
        for (const f of fs.readdirSync(root)) {
            if (f === '.git' || f === 'node_modules' || f === 'tests') continue;
            fs.cpSync(path.join(root, f), path.join(dir, f), { recursive: true });
        }
        const loader = '<?php\n' +
            '$baseDir = ' + JSON.stringify(base + '/') + ';\n' +
            '$loaded = 0;\n' +
            'foreach (scandir($baseDir) as $file) {\n' +
            '  if (!in_array($file, array(".", "..")) && is_dir($baseDir . $file) && is_file($baseDir . $file . "/api.php")) {\n' +
            '    require_once $baseDir . $file . "/api.php";\n' +
            '    $fn = "getEndpoints" . preg_replace("/-/", "", $file);\n' +
            '    if (!function_exists($fn)) { echo "MISSING " . $fn; exit(1); }\n' +
            '    $loaded++;\n' +
            '  }\n' +
            '}\n' +
            'echo "LOADER-OK";\n';
        fs.writeFileSync(path.join(base, 'loader.php'), loader);
        let out = '';
        try { out = cp.execFileSync('php', [path.join(base, 'loader.php')], { encoding: 'utf8' }); }
        catch (e) { out = (e.stdout || '') + (e.stderr || '') || String(e); }
        assert.equal(out, 'LOADER-OK');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('description notes: the generated name is kept, the note rides on its tail, 60 characters in all', () => {
    assert.equal(C.descBase('port 9 A'), 'port 9 A');
    assert.equal(C.descNote('port 9 A'), '');
    assert.equal(C.descBase('port 9 A | Front roofline, left to right'), 'port 9 A');
    assert.equal(C.descNote('port 9 A | Front roofline, left to right'), 'Front roofline, left to right');
    assert.equal(C.withNote('port 9 A', 'Front roofline, left to right').text, 'port 9 A | Front roofline, left to right');
    // replacing and removing a note never touches the generated name
    assert.equal(C.withNote('port 9 A | old', 'new').text, 'port 9 A | new');
    assert.equal(C.withNote('port 9 A | old', '   ').text, 'port 9 A');
    // quotes/brackets are stripped as for every description, a typed pipe cannot start a second note
    assert.equal(C.withNote('p1', 'a "b" <c> | d').text, 'p1 | a b c d');
    // too long: cut to the room left, and it says so
    const long = 'x'.repeat(80), r = C.withNote('port 12', long);
    assert.equal(r.text.length, 60);
    assert.equal(r.cut, true);
    assert.equal(C.noteRoom('port 12'), 60 - 'port 12'.length - 3);
    // a name that already fills the line leaves no room
    assert.equal(C.noteRoom('y'.repeat(58)), 0);
    assert.equal(C.withNote('y'.repeat(58), 'note').text, 'y'.repeat(58));
    // a split letters the parts after the generated name only; the note stays with the first part
    const l = cfg(); l[0].outputs[0].virtualStrings[0].description = 'Roof | left to right';
    const d = C.makeDraft(l), u = d[0].outputs[0].virtualStrings[0]._uid;
    assert.ok(C.splitString(d, 0 === 0 ? u : u, 20).ok);
    const names = d[0].outputs[0].virtualStrings.map(v => v.description);
    assert.deepEqual(names, ['Roof A | left to right', 'Roof B']);
});

test('description tags: the standard list, tidy-up, no repeats, no pipes', () => {
    assert.deepEqual(C.DEFAULT_TAGS, ['Lip', 'driver side eye', 'cleaner side eye', 'top grill', 'main grill', 'bottom grill', 'top light',
        'u bar centre', 'u bar driver side beam', 'u bar cleaner side beam', 'eye', 'eyebrow']);
    assert.deepEqual(C.cleanTags(C.DEFAULT_TAGS), C.DEFAULT_TAGS, 'the standard list is already clean');
    assert.deepEqual(C.cleanTags(['  Top  grill ', 'top GRILL', 'a | b', '', '   ', 'x"y<z>', 5, null]), ['Top grill', 'a b', 'xyz']);
    assert.equal(C.cleanTags(['y'.repeat(100)])[0].length, C.TAG_MAX_LEN);
    assert.equal(C.cleanTags(Array.from({ length: 300 }, (_, i) => 'tag' + i)).length, 100);
    assert.deepEqual(C.cleanTags('nope'), []);
    // a tag used as a note fits the same 60-character description rule
    assert.equal(C.withNote('port 3', 'u bar driver side beam').text, 'port 3 | u bar driver side beam');
});

test('split parts are lettered A, B, C - never "part 2 part 2"', () => {
    const l = cfg(); l[0].outputs[0].virtualStrings[0] = vs({ description: 'port 9', startChannel: 0, pixelCount: 100, colorOrder: 'RGB' });
    const d = C.makeDraft(l);
    const list = () => d[0].outputs[0].virtualStrings;
    const names = () => list().map(v => v.description);
    const px = () => list().map(v => v.pixelCount);
    assert.ok(C.splitString(d, list()[0]._uid, 22).ok);
    assert.deepEqual(names(), ['port 9 A', 'port 9 B']);
    // split the second part: A stays, the new tail becomes C
    assert.ok(C.splitString(d, list()[1]._uid, 13).ok);
    assert.deepEqual(names(), ['port 9 A', 'port 9 B', 'port 9 C']);
    assert.deepEqual(px(), [22, 13, 65]);
    // split the FIRST part: the later parts move down a letter, none is lost or repeated
    assert.ok(C.splitString(d, list()[0]._uid, 10).ok);
    assert.deepEqual(names(), ['port 9 A', 'port 9 B', 'port 9 C', 'port 9 D']);
    assert.deepEqual(px(), [10, 12, 13, 65]);
    // notes stay with their own part
    list()[1].description = 'port 9 B | top grill';
    assert.ok(C.splitString(d, list()[0]._uid, 5).ok);
    assert.deepEqual(names(), ['port 9 A', 'port 9 B', 'port 9 C | top grill', 'port 9 D', 'port 9 E']);
    // other strings on the same output, with other names, are left alone
    const l2 = cfg(); l2[0].outputs[0].virtualStrings = [vs({ description: 'Roof', startChannel: 0, pixelCount: 40 }), vs({ description: 'Eave', startChannel: 120, pixelCount: 40 })];
    const d2 = C.makeDraft(l2), v2 = d2[0].outputs[0].virtualStrings;
    assert.ok(C.splitString(d2, v2[0]._uid, 10).ok);
    assert.deepEqual(v2.map(v => v.description), ['Roof A', 'Roof B', 'Eave']);
    // older "part 2" names are re-lettered on the next split
    const l3 = cfg(); l3[0].outputs[0].virtualStrings = [vs({ description: 'port 9', startChannel: 0, pixelCount: 22 }), vs({ description: 'port 9 part 2', startChannel: 66, pixelCount: 13 }), vs({ description: 'port 9 part 2 part 2', startChannel: 105, pixelCount: 985 })];
    const d3 = C.makeDraft(l3), v3 = d3[0].outputs[0].virtualStrings;
    assert.ok(C.splitString(d3, v3[2]._uid, 10).ok);
    assert.deepEqual(v3.map(v => v.description), ['port 9 A', 'port 9 B', 'port 9 C', 'port 9 D']);
    // a string without a name uses its port label; a name that fills the line still keeps its letter
    const l4 = cfg(); l4[0].outputs[0].virtualStrings = [vs({ description: '', startChannel: 0, pixelCount: 40 })];
    const d4 = C.makeDraft(l4), v4 = d4[0].outputs[0].virtualStrings;
    assert.ok(C.splitString(d4, v4[0]._uid, 10).ok);
    assert.ok(/ A$/.test(v4[0].description) && / B$/.test(v4[1].description), v4.map(v => v.description).join('|'));
    const l5 = cfg(); l5[0].outputs[0].virtualStrings = [vs({ description: 'q'.repeat(60), startChannel: 0, pixelCount: 40 })];
    const d5 = C.makeDraft(l5), v5 = d5[0].outputs[0].virtualStrings;
    assert.ok(C.splitString(d5, v5[0]._uid, 10).ok);
    assert.ok(v5.every(v => v.description.length <= 60));
    assert.ok(/ A$/.test(v5[0].description) && / B$/.test(v5[1].description));
    assert.equal(C.partLetter(0), 'A'); assert.equal(C.partLetter(25), 'Z'); assert.equal(C.partLetter(26), 'AA');
    assert.equal(C.descStem('port 9 part 2 part 2 | n'), 'port 9');
    assert.equal(C.descStem('port 9 C'), 'port 9');
    assert.equal(C.descStem('Roof left side'), 'Roof left side');
});
