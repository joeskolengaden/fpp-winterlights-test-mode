'use strict';
/*
 * Browser test of the whole page against a stand-in FPP (tests/mock-fpp/router.php).
 * The test plays the person at the lights: it replays every test-mode request into a model of fppd's channel
 * tester and of the pixel wiring, "looks" at the LEDs, and clicks what it sees.
 *   node --test tests/e2e.test.js        (needs php and playwright)
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const C = require('../js/wltm-core.js');
const { Sim, leds, colourName } = require('./fppd-sim.js');

const SHOTS = process.env.WLTM_SHOTS || '';
const PLUGIN = 'fpp-winterlights-test-mode';
function vs(o) { return Object.assign(C.defaultVs(), o); }
function fixture() {
    return {
        channelOutputs: [{
            type: 'BBB48String', subType: 'F8-B', pinoutVersion: '1.x', enabled: 1, startChannel: 1, channelCount: -1, outputCount: 5, pixelTiming: 0,
            outputs: [
                { portNumber: 0, protocol: 'ws2811', virtualStrings: [vs({ description: 'Roof left', startChannel: 0, pixelCount: 50 })] },
                { portNumber: 1, protocol: 'ws2811', virtualStrings: [vs({ description: 'Roof right', startChannel: 150, pixelCount: 50 })] },
                { portNumber: 2, protocol: 'ws2811', differentialType: 2,
                    virtualStrings: [vs({ description: 'Window 1', startChannel: 300, pixelCount: 20 })],
                    virtualStringsB: [vs({ description: 'Window 2', startChannel: 360, pixelCount: 20 })] },
                { portNumber: 3, protocol: 'ws2811', virtualStrings: [vs({ description: 'Mega tree', startChannel: 420, pixelCount: 30, colorOrder: 'RGBW' })] },
                { portNumber: 4, protocol: 'ws2811', virtualStrings: [vs({})] }
            ]
        }, { type: 'BBBSerial', subType: 'off', enabled: 0, startChannel: 0, channelCount: 0, outputs: [] }]
    };
}
// how the props are really built: wire order and number of LEDs, by physical position on the controller
const TRUTH = { '0:0:0': [['RGB', 50]], '0:1:0': [['GRB', 47]], '0:2:0': [['GRB', 20]], '0:2:1': [['BRG', 20]], '0:3:0': [['GRBW', 30]] };

let server, port, dir, browser, page, errors = [];
const cfgFile = () => path.join(dir, 'config', 'co-bbbStrings.json');
const dataDir = () => path.join(dir, 'config', 'winterlights-test-mode');
const url = (q) => 'http://127.0.0.1:' + port + '/plugin.php?plugin=' + PLUGIN + (q || '&page=plugin.php');

function requests() {
    const f = path.join(dir, 'requests.log');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
}
function sim() {
    const s = new Sim();
    requests().forEach(l => {
        if (l === 'restart') { s.data.fill(0); s.set = []; s.setStr = null; s.on = false; }
        else if (l.startsWith('testmode ')) s.post(JSON.parse(l.slice(9)));
    });
    assert.equal(s.cmdTooLong, false);
    return s;
}
/* What a person sees on a port/subport: one colour letter per real LED, in wiring order. */
function look(key) {
    const live = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')).channelOutputs;
    const [co, p, sub] = key.split(':').map(Number);
    const list = live[co].outputs[p][C.SUB_KEYS[sub]].filter(v => v.pixelCount > 0);
    const s = sim();
    // the data stream runs through the configured strings one after another; the real LEDs just take it in order
    let stream = [];
    list.forEach(v => { stream = stream.concat(leds(s, v, 'RGBW'.slice(0, C.orderInfo(v.colorOrder).cpp)).map((px, i) => ({ v, i }))); });
    const out = [];
    let pos = 0;
    TRUTH[key].forEach(([order, n]) => {
        for (let i = 0; i < n; i++, pos++) {
            const e = stream[pos];
            if (!e) { out.push('k'); continue; }
            // re-read this pixel with its real wire order
            const one = Object.assign({}, e.v, { reverse: 0 });
            const all = leds(s, one, order);
            const idx = e.v.reverse ? e.v.pixelCount - 1 - e.i : e.i;
            out.push(colourName(all[idx]));
        }
    });
    return out;
}
const allKeys = Object.keys(TRUTH);
function litKeys() { return allKeys.filter(k => look(k).some(c => c !== 'k')); }
async function settle() {
    await page.waitForFunction(() => window.WLTMUI && !window.WLTMUI._drv.busy && !window.WLTMUI._drv.pending && !window.WLTMUI._state.busy, null, { timeout: 120000 });
    await page.waitForTimeout(450);     // record save debounce
}
async function act(a, extra) { await page.click('#wltm [data-act="' + a + '"]' + (extra || '')); await settle(); }
async function tab(t) { await page.click('#wltm .wltm-tab[data-tab="' + t + '"]'); await settle(); }
async function selectRow(label) {
    await page.locator('#wltm tr.pick', { has: page.locator('td', { hasText: label }) }).first().locator('td').nth(3).click();
    await settle();
}
async function shot(name) { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); }
const text = (sel) => page.locator(sel).innerText();

test.before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wltm-'));
    fs.mkdirSync(path.join(dir, 'config'));
    fs.writeFileSync(cfgFile(), JSON.stringify(fixture(), null, 2));
    port = 20000 + Math.floor(Math.random() * 20000);
    server = spawn('php', ['-S', '127.0.0.1:' + port, path.join(__dirname, 'mock-fpp', 'router.php')], { env: Object.assign({}, process.env, { WLTM_MOCK_DIR: dir }), stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
        try { await fetch('http://127.0.0.1:' + port + '/api/fppd/status'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); }
    }
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('dialog', d => d.accept());
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/409 \(Conflict\)/.test(m.text())) errors.push('console: ' + m.text()); });   // the 409 is the refusal test 10 provokes
});
test.after(async () => {
    if (browser) await browser.close();
    if (server) server.kill();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('page loads and lists every port and subport', async () => {
    await page.goto(url());
    await page.waitForSelector('#wltm .wltm-table');
    await settle();
    const rows = await page.locator('#wltm .wltm-table tr').allInnerTexts();
    assert.equal(rows.length, 7);
    assert.match(rows[1], /^1\s+–\s+Roof left/);
    assert.match(rows[3], /^3\s+A\s+Window 1/);
    assert.match(rows[4], /^3\s+B\s+Window 2/);
    assert.match(rows[6], /^5\s+–\s+\(empty\).*Unused/s);
    assert.match(await text('#wltm-status'), /Test mode off.*fppd running.*5 ports · 5 strings/s);
    assert.deepEqual(requests(), [], 'nothing is sent to the lights just by opening the page');
    await shot('01-ports');
});

test('identify: light one string, first pixel, colour, identify all, stop', async () => {
    await selectRow('Window 2');
    await act('light');
    assert.deepEqual(litKeys(), ['0:2:1']);
    assert.ok(look('0:2:1').every(c => c === 'RGB'), 'whole string white');
    assert.match(await text('#wltm-status'), /TEST MODE ON.*Lighting: Port 3B/s);
    await act('first');
    assert.equal(look('0:2:1').filter(c => c !== 'k').length, 1);
    assert.notEqual(look('0:2:1')[0], 'k');
    await selectRow('Mega tree');
    assert.deepEqual(litKeys(), [], 'changing the selection turns the old string off');
    await act('light');
    assert.deepEqual(litKeys(), ['0:3:0']);
    assert.ok(look('0:3:0').every(c => c === 'RGBW'));
    await act('identify-all');
    const on = k => look(k).map(c => c === 'k' ? 0 : 1).join('');
    assert.equal(on('0:0:0'), '1' + '0'.repeat(49));
    assert.equal(on('0:1:0'), '11' + '0'.repeat(45));
    assert.equal(on('0:2:0'), '111001' + '0'.repeat(14));
    assert.equal(on('0:2:1'), '1110011' + '0'.repeat(13));
    assert.equal(on('0:3:0'), '1111' + '0'.repeat(26));
    await act('all-off');
    assert.deepEqual(litKeys(), []);
    assert.equal(sim().on, false, 'test mode is switched off, not just dark');
});

test('rename a port and an empty port', async () => {
    await page.click('#wltm tr:has-text("Roof left") [data-act="rename"]');
    await page.fill('#wltm-rename', 'Roof "left" side');
    await page.keyboard.press('Enter');
    await settle();
    await page.click('#wltm tr:has-text("(empty)") [data-act="rename"]');
    await page.fill('#wltm-rename', 'Spare port');
    await act('rename-ok');
    const t = await text('#wltm .wltm-table');
    assert.match(t, /Roof left side/); assert.match(t, /Spare port/);
    assert.match(await text('#wltm .wltm-foot'), /2 changes waiting/);
    assert.equal(JSON.parse(fs.readFileSync(cfgFile(), 'utf8')).channelOutputs[0].outputs[0].virtualStrings[0].description, 'Roof left', 'FPP is untouched until Apply');
});

test('count: step the lit pixel to the last real LED and save', async () => {
    await tab('count');
    await selectRow('Roof right');
    await act('count-end');
    assert.equal(await text('#wltm-count-pos'), '50');
    assert.ok(look('0:1:0').every(c => c === 'k'), 'pixel 50 does not exist on this prop: nothing lit');
    assert.match(await text('#wltm-main'), /last configured pixel/);
    await act('count-step', '[data-d="-1"]');
    await act('count-step', '[data-d="-1"]');
    assert.ok(look('0:1:0').every(c => c === 'k'));
    await page.keyboard.press('ArrowLeft');
    await settle();
    assert.equal(await text('#wltm-count-pos'), '47');
    const seen = look('0:1:0');
    assert.equal(seen.filter(c => c !== 'k').length, 1);
    assert.notEqual(seen[46], 'k', 'the last real LED is the one that is lit');
    assert.deepEqual(litKeys(), ['0:1:0']);
    await shot('02-count');
    await page.fill('#wltm-count-save', '45');
    await act('count-save');
    assert.match(await text('#wltm .wltm-table'), /Roof right\s+✎?\s*151\s+50→45\s+45/);
    // a count saved too low can still be corrected upward before applying
    await act('count-end');
    assert.equal(await text('#wltm-count-pos'), '50');
    for (let i = 0; i < 3; i++) await act('count-step', '[data-d="-1"]');
    assert.notEqual(look('0:1:0')[46], 'k');
    await act('count-save');
    const t = await text('#wltm .wltm-table');
    assert.match(t, /Roof right\s+✎?\s*151\s+50→47\s+47/);
    assert.match(await text('#wltm .wltm-foot'), /Port 2: 50 → 47 px/);
});

test('colour order on all ports: answer what is seen, groups form, set per group', async () => {
    await tab('colour');
    assert.deepEqual(litKeys(), []);
    for (const X of ['R', 'G', 'B', 'W']) {
        await act('send', '[data-c="' + X + '"]');
        const rows = page.locator('#wltm .wltm-table tr:has(.wltm-pk)');
        const n = await rows.count();
        assert.equal(n, X === 'W' ? 1 : 5, 'strings that can be asked about ' + X);
        // quick fill with the colour that was sent, then correct the ones that differ
        await act('fill', '[data-v="' + X.toLowerCase() + '"]');
        for (const key of allKeys) {
            const shown = look(key);
            const first = shown[0];
            if (X === 'W' && key !== '0:3:0') { assert.ok(shown.every(c => c === 'k'), key + ' stays dark for white'); continue; }
            assert.ok(shown.every(c => c === first) && first.length === 1 && first !== 'k', key + ' shows one clean colour for ' + X + ': ' + first);
            if (first !== X.toLowerCase()) {
                const label = { '0:0:0': 'Roof left side', '0:1:0': 'Roof right', '0:2:0': 'Window 1', '0:2:1': 'Window 2', '0:3:0': 'Mega tree' }[key];
                await page.click('#wltm tr:has-text("' + label + '") .wltm-pk button.' + first);
                await settle();
            }
        }
        if (X === 'B') await shot('03-colour');
    }
    await act('send', '[data-c=""]');
    assert.deepEqual(litKeys(), []);
    const g = await page.locator('#wltm .wltm-grp').allInnerTexts();
    assert.equal(g.length, 4);
    assert.match(g[0], /Group A\s+GRB\s+2 strings · configured RGB\s+Wrong order\s+Port 2\s*Port 3A/);
    assert.match(g[1], /Group B\s+(BRG|GRBW)/);
    assert.match(g[3], /Group D\s+RGB\s+1 string · configured RGB\s+Matches config\s+Port 1/);
    // light a group: exactly its strings come on
    await act('group-light', '[data-g="A"]');
    assert.deepEqual(litKeys(), ['0:1:0', '0:2:0']);
    await act('all-off');
    for (const name of ['A', 'B', 'C']) await act('group-stage', '[data-g="' + name + '"]');
    const foot = await text('#wltm .wltm-foot');
    assert.match(foot, /6 changes waiting/);
    assert.match(foot, /Port 2: 50 → 47 px, RGB → GRB/);
    await shot('04-groups');
    // verifying before apply is refused
    await act('group-verify', '[data-g="A"]');
    assert.equal(await page.locator('#wltm .wltm-verify').count(), 0);
});

test('apply: backup, write, restart; FPP file is valid and only the intended fields changed', async () => {
    const before = fs.readFileSync(cfgFile(), 'utf8');
    await act('apply');
    await page.waitForFunction(() => !window.WLTMUI._state.busy, null, { timeout: 120000 });
    await settle();
    const after = JSON.parse(fs.readFileSync(cfgFile(), 'utf8'));
    const want = fixture();
    const o = want.channelOutputs[0].outputs;
    o[0].virtualStrings[0].description = 'Roof left side';
    Object.assign(o[1].virtualStrings[0], { pixelCount: 47, colorOrder: 'GRB' });
    o[2].virtualStrings[0].colorOrder = 'GRB';
    o[2].virtualStringsB[0].colorOrder = 'BRG';
    o[3].virtualStrings[0].colorOrder = 'GRBW';
    o[4].virtualStrings[0].description = 'Spare port';
    assert.deepEqual(after, want);
    const backups = fs.readdirSync(path.join(dataDir(), 'backups'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dataDir(), 'backups', backups[0]), 'utf8'), before, 'the backup is the exact previous file');
    assert.equal(requests().filter(l => l === 'restart').length, 1);
    assert.match(await text('#wltm .wltm-foot'), /Nothing waiting/);
    assert.match(await text('#wltm .wltm-table'), /waiting|GRB/);
});

test('verify per group after apply, then statuses read Verified', async () => {
    for (const name of ['A', 'B', 'C', 'D']) {
        const head = await page.locator('#wltm .wltm-grp').nth('ABCD'.indexOf(name)).innerText();
        assert.match(head, /Matches config/, 'group ' + name + ' now matches');
        await act('group-verify', '[data-g="' + name + '"]');
        for (;;) {
            const v = page.locator('#wltm .wltm-verify');
            if (!(await v.count())) break;
            const q = await v.locator('b').innerText();
            const want = q.match(/strings (\w+)\?/)[1][0];
            const lit = litKeys();
            assert.ok(lit.length >= 1);
            lit.forEach(k => assert.ok(look(k).every(c => c === want), 'verify ' + name + ': ' + k + ' really shows ' + want + ' -> ' + look(k)[0]));
            if (name === 'A' && want === 'r') await shot('05-verify');
            await act('verify-yes');
        }
    }
    await tab('record');
    const rec = await text('#wltm .wltm-table');
    assert.equal((rec.match(/Verified/g) || []).length, 5, 'five Verified pills');
    assert.match(rec, /Roof right\s+47\s+47/);
    await shot('06-record');
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir(), 'record.json'), 'utf8'));
    assert.equal(Object.values(saved.meta).filter(m => m.verified === true).length, 5);
    assert.equal(saved.dirty, false);
});

test('everything survives a reload; leaving the page switches test mode off', async () => {
    await tab('ports');
    await selectRow('Window 1');
    await act('light');
    assert.deepEqual(litKeys(), ['0:2:0']);
    await page.reload();
    await page.waitForSelector('#wltm .wltm-table');
    await settle();
    await page.waitForTimeout(300);
    assert.deepEqual(litKeys(), [], 'reload sent the off request');
    assert.equal(sim().on, false);
    assert.equal((await text('#wltm .wltm-table')).match(/Verified/g).length, 5);
});

test('add a string, split a string, discard, then apply a split and test the new part', async () => {
    await page.click('#wltm tr:has-text("Spare port") [data-act="add-open"]');
    await page.fill('#wltm-add-desc', 'New arch');
    await page.fill('#wltm-add-count', '25');
    await page.selectOption('#wltm-add-order', 'GRB');
    assert.equal(await page.inputValue('#wltm-add-start'), '541');
    await act('add-ok');
    assert.match(await text('#wltm .wltm-table'), /5\s+–\s+New arch\s+✎?\s*541\s+25\s+–\s+GRB\s+New · apply to test/);
    assert.equal(await page.locator('#wltm [data-act="light"]').count(), 0, 'a string FPP does not know yet offers no Light button');
    assert.match(await text('#wltm-main'), /not in FPP's running configuration yet/);
    await act('discard');
    assert.match(await text('#wltm .wltm-foot'), /Nothing waiting/);

    await tab('count');
    await selectRow('Roof left side');
    await act('count-first');
    for (let i = 0; i < 2; i++) await act('count-step', '[data-d="10"]');
    assert.equal(await text('#wltm-count-pos'), '21');
    await act('count-split');
    const t = await text('#wltm .wltm-table');
    assert.match(t, /Roof left side\s+✎?\s*1\s+50→21\s+21/);
    assert.match(t, /Roof left side part 2\s+✎?\s*64\s+29/);
    // the new part can be lit straight away, on the right physical pixels
    await selectRow('Roof left side part 2');
    await act('count-first');
    assert.equal(look('0:0:0').findIndex(c => c !== 'k'), 21);
    await act('count-end');
    assert.equal(look('0:0:0').findIndex(c => c !== 'k'), 49);
    await act('all-off');
    await act('apply');
    await page.waitForFunction(() => !window.WLTMUI._state.busy, null, { timeout: 120000 });
    await settle();
    const vsl = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')).channelOutputs[0].outputs[0].virtualStrings;
    assert.deepEqual(vsl.map(v => [v.description, v.startChannel, v.pixelCount]), [['Roof left side', 0, 21], ['Roof left side part 2', 63, 29]]);
    await selectRow('Roof left side part 2');
    await act('count-first');
    assert.equal(look('0:0:0').findIndex(c => c !== 'k'), 21, 'after apply the second string starts at physical pixel 22');
    await act('all-off');
    // the first part kept its verified result, the split part starts fresh
    assert.match(await text('#wltm .wltm-table'), /Roof left side\s+✎?\s*1\s+21\s+21\s+RGB\s+Verified/);
});

test('a change made outside the page is never overwritten', async () => {
    await tab('ports');
    await page.click('#wltm tr:has-text("Window 1") [data-act="rename"]');
    await page.fill('#wltm-rename', 'Window one');
    await act('rename-ok');
    const outside = JSON.parse(fs.readFileSync(cfgFile(), 'utf8'));
    outside.channelOutputs[0].outputs[3].virtualStrings[0].pixelCount = 33;
    fs.writeFileSync(cfgFile(), JSON.stringify(outside, null, 2));
    const nBackups = fs.readdirSync(path.join(dataDir(), 'backups')).length;
    await act('apply');
    await settle();
    assert.match(await text('#wltm-toasts'), /changed since this page loaded/);
    assert.deepEqual(JSON.parse(fs.readFileSync(cfgFile(), 'utf8')), outside, 'the outside edit is intact');
    assert.equal(fs.readdirSync(path.join(dataDir(), 'backups')).length, nBackups);
    assert.match(await text('#wltm .wltm-table'), /Mega tree\s+✎?\s*421\s+33/, 'the page picked up the outside change');
    assert.match(await text('#wltm-status'), /changed outside this page/);
});

test('restore the first backup', async () => {
    await tab('record');
    const names = await page.locator('#wltm [data-act="restore"]').evaluateAll(els => els.map(e => e.getAttribute('data-name')));
    assert.ok(names.length >= 2);
    const oldest = names[names.length - 1];
    await page.click('#wltm [data-act="restore"][data-name="' + oldest + '"]');
    await page.waitForFunction(() => !window.WLTMUI._state.busy, null, { timeout: 120000 });
    await settle();
    assert.deepEqual(JSON.parse(fs.readFileSync(cfgFile(), 'utf8')), fixture(), 'back to the very first configuration');
    await tab('ports');
    assert.match(await text('#wltm .wltm-table'), /Roof right\s+✎?\s*151\s+50/);
});

test('warnings: playlist running, fppd down; loader works when FPP does not add the scripts', async () => {
    fs.writeFileSync(path.join(dir, 'status.json'), '{"fppd":"running","status_name":"playing","mode_name":"player"}');
    await page.reload(); await page.waitForSelector('#wltm .wltm-table'); await settle();
    await page.waitForFunction(() => /FPP is playing/.test(document.querySelector('#wltm-status').innerText));
    await page.click('#wltm [data-act="stop-playlist"]');
    await page.waitForFunction(() => !/FPP is playing/.test(document.querySelector('#wltm-status').innerText), null, { timeout: 10000 });
    assert.ok(requests().includes('stop-playlist'));
    fs.writeFileSync(path.join(dir, 'status.json'), '{"fppd":"Not Running"}');
    await page.waitForFunction(() => /fppd is not running/.test(document.querySelector('#wltm-status').innerText), null, { timeout: 10000 });
    fs.unlinkSync(path.join(dir, 'status.json'));
    await page.goto(url('&page=plugin.php&_noautoload=1'));
    await page.waitForSelector('#wltm .wltm-table');
    await settle();
    assert.equal(await page.locator('#wltm .wltm-table tr').count(), 7, 'the page loaded its own scripts and styles');
    assert.equal(await page.locator('#wltm .wltm-tab.on').evaluate(e => getComputedStyle(e).fontWeight), '600');
});

test('backend refuses bad requests and leaves FPP\'s file alone', async () => {
    const api = (a) => 'http://127.0.0.1:' + port + '/plugin.php?plugin=' + PLUGIN + '&page=api.php&nopage=1&action=' + a;
    const before = fs.readFileSync(cfgFile(), 'utf8');
    const hash = require('crypto').createHash('md5').update(before).digest('hex');
    const post = async (a, body) => { const r = await fetch(api(a), { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }); return [r.status, JSON.parse((await r.text()).trim())]; };
    let r = await fetch(api('apply')); assert.equal(r.status, 405);
    assert.equal((await post('apply', 'not json'))[0], 400);
    assert.equal((await post('apply', { expectHash: hash, configText: '{"channelOutputs":"x"}' }))[0], 400);
    assert.equal((await post('apply', { expectHash: hash, configText: '[]' }))[0], 400);
    const withUid = fixture(); withUid.channelOutputs[0].outputs[0].virtualStrings[0]._uid = 'x';
    assert.equal((await post('apply', { expectHash: hash, configText: JSON.stringify(withUid) }))[0], 400, 'private fields can never reach FPP');
    const tooMany = fixture(); tooMany.channelOutputs[0].outputs[0].virtualStrings[0].pixelCount = 99999;
    assert.equal((await post('apply', { expectHash: hash, configText: JSON.stringify(tooMany) }))[0], 400);
    assert.equal((await post('apply', { expectHash: 'stale', configText: JSON.stringify(fixture()) }))[0], 409);
    assert.equal((await post('restore', { name: '../../../etc/passwd' }))[0], 400);
    assert.equal((await post('restore', { name: 'co-bbbStrings-20200101-000000.json' }))[0], 400);
    assert.equal((await post('saveRecord', '{"nope":1}'))[0], 400);
    assert.equal((await fetch(api('nothing'))).status, 404);
    assert.equal(fs.readFileSync(cfgFile(), 'utf8'), before);
});

test('no JavaScript errors during the whole run', () => {
    assert.deepEqual(errors, []);
});
