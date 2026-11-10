/*
 * Winterlights Test Mode - page code (DOM + network). All decisions live in wltm-core.js.
 * Started by plugin.php with WLTMUI.start(element).
 */
(function () {
    'use strict';
    if (typeof window === 'undefined') return;

    var C = null;                       // WLTMCore, bound in start()
    var root = null;
    var S = {
        plugin: '', version: '',
        ready: false, fatal: '',
        liveRoot: null, liveOutputs: [], liveHash: '', lidx: {},
        record: { version: 1, baseHash: '', dirty: false, draft: [], meta: {} },
        backups: [],
        tab: 'ports', sel: '',
        brightness: 30,
        fppd: { known: false, running: false, status: '', mode: '' },
        lit: { label: '', note: '' },
        ident: { colour: 'W' },
        count: { pos: {}, started: false, save: '' },
        colour: { scope: 'all', current: '', choice: {} },
        verify: null,
        edit: null,                     // { key } row being renamed
        add: null,                      // { co, port, sub } add-string form
        busy: '',                       // overlay text while applying / restarting
        notice: ''
    };

    // ------------------------------------------------------------------ helpers

    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function nowIso() { return new Date().toISOString(); }
    function shortDate(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        function p(n) { return (n < 10 ? '0' : '') + n; }
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    function apiUrl(action) {
        return 'plugin.php?plugin=' + encodeURIComponent(S.plugin) + '&page=api.php&nopage=1&action=' + encodeURIComponent(action);
    }
    function parseLoose(text) {
        // FPP may put stray whitespace around a plugin page's output
        var a = text.indexOf('{'), b = text.lastIndexOf('}');
        if (a < 0 || b < a) throw new Error('The server sent an unexpected answer.');
        return JSON.parse(text.slice(a, b + 1));
    }
    function call(action, body) {
        var opt = body === undefined ? { method: 'GET', cache: 'no-store' } : { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), cache: 'no-store' };
        return fetch(apiUrl(action), opt).then(function (r) { return r.text(); }).then(function (t) {
            var d = parseLoose(t);
            if (!d.ok) throw new Error(d.error || 'Request failed.');
            return d;
        });
    }
    function toast(msg, bad) {
        var box = root.querySelector('#wltm-toasts');
        if (!box) return;
        var d = document.createElement('div');
        d.className = 'wltm-toast' + (bad ? ' bad' : '');
        d.textContent = msg;
        box.appendChild(d);
        setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, bad ? 9000 : 4000);
    }
    function meta(uid) {
        if (!S.record.meta[uid]) S.record.meta[uid] = {};
        return S.record.meta[uid];
    }

    // ------------------------------------------------------------------ model

    function draftRows() { return C.listRows(S.record.draft); }
    function diffs() { return C.diffDraft(S.record.draft, S.liveOutputs); }
    function rowByUid(uid) { return C.findByUid(S.record.draft, uid); }
    function liveFor(row) { return row && !row.empty ? C.liveOf(row.vs, S.lidx) : null; }

    function testable() {
        // draft strings that exist on the lights right now
        return draftRows().filter(function (r) { return !r.empty && liveFor(r); });
    }
    function selRow() {
        var r = S.sel ? rowByUid(S.sel) : null;
        if (r) return r;
        var all = draftRows().filter(function (x) { return !x.empty; });
        if (all.length) { S.sel = all[0].vs._uid; return all[0]; }
        S.sel = '';
        return null;
    }
    function partOf(row) {
        var l = liveFor(row);
        return l ? { live: l.vs, from: l.off, count: l.count } : null;
    }

    var saveTimer = null, saving = Promise.resolve();
    function saveRecord() {
        S.record.dirty = diffs().length > 0;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(flushRecord, 300);
    }
    function flushRecord() {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        // drop notes for strings that no longer exist
        var alive = {};
        draftRows().forEach(function (r) { if (!r.empty) alive[r.vs._uid] = 1; });
        Object.keys(S.record.meta).forEach(function (u) { if (!alive[u]) delete S.record.meta[u]; });
        var text = JSON.stringify(S.record);
        saving = saving.then(function () { return call('saveRecord', text); }).catch(function (e) { toast('Could not save the test record: ' + e.message, true); });
        return saving;
    }

    function adoptState(d) {
        S.backups = d.backups || [];
        S.liveHash = d.liveHash || '';
        S.liveRoot = null; S.liveOutputs = [];
        if (d.liveExists && d.liveText) {
            try { S.liveRoot = JSON.parse(d.liveText); } catch (e) { S.fatal = 'FPP\'s pixel-string configuration file is not valid JSON (' + esc(d.configFile) + ').'; return; }
            if (S.liveRoot && Array.isArray(S.liveRoot.channelOutputs)) S.liveOutputs = S.liveRoot.channelOutputs;
        }
        S.lidx = C.liveIndex(S.liveOutputs);
        var rec = null;
        if (d.recordText) { try { rec = JSON.parse(d.recordText); } catch (e) { rec = null; } }
        if (rec && rec.version === 1 && Array.isArray(rec.draft) && rec.baseHash === S.liveHash) {
            S.record = rec;
            if (!S.record.meta || typeof S.record.meta !== 'object' || Array.isArray(S.record.meta)) S.record.meta = {};
        } else {
            var old = rec && Array.isArray(rec.draft) ? rec.draft : null;
            if (rec && rec.dirty) S.notice = 'FPP\'s pixel-string configuration was changed outside this page, so the changes that were waiting here were dropped. Test results were kept.';
            S.record = { version: 1, baseHash: S.liveHash, dirty: false, draft: C.makeDraft(S.liveOutputs, old), meta: (rec && rec.meta && typeof rec.meta === 'object' && !Array.isArray(rec.meta)) ? rec.meta : {} };
            if (S.liveRoot) saveRecord();
        }
        if (!C.listRows(S.liveOutputs).length) {
            S.fatal = 'No BeagleBone pixel-string output is configured yet. Set one up under Input/Output Setup → Channel Outputs → Pixel Strings, save it, then come back.';
        } else S.fatal = '';
    }

    function loadState() {
        return call('state').then(function (d) { adoptState(d); S.ready = true; });
    }

    // ------------------------------------------------------------------ test-mode driver

    var drv = { busy: false, pending: null, last: null, on: false, error: '' };

    function postTest(body) {
        return fetch('api/testmode', { method: 'POST', body: JSON.stringify(body), cache: 'no-store' }).then(function (r) {
            // FPP 5.4 answers this request with an empty/odd body even on success, so only the transport matters
            return r.text().then(function () { return true; });
        });
    }
    function offRequest() {
        return { enabled: 0, mode: 'RGBFill', cycleMS: 1000, color1: 0, color2: 0, color3: 0, channelSet: '1-1', channelSetType: 'channelRange' };
    }
    function level() { return Math.max(1, Math.round(255 * S.brightness / 100)); }

    /* Show a frame (empty frame = everything off). level 0 keeps test mode on but dark (used for blinking). */
    function show(frame, label, lvl) {
        drv.pending = { frame: frame, label: label || '', level: lvl === 0 ? 0 : 1 };
        S.lit = { label: frame.ranges.length ? (label || '') : '', note: frame.note || '' };
        renderStatus();
        return pump();
    }
    function pump() {
        if (drv.busy) return drv.done;
        drv.busy = true;
        drv.done = (async function () {
            while (drv.pending) {
                var job = drv.pending; drv.pending = null;
                try {
                    var same = drv.last && job.frame.ranges.length && drv.last.mode === job.frame.mode &&
                        C.setString(drv.last.ranges) === C.setString(job.frame.ranges);
                    if (drv.last && drv.last.ranges.length && !same) {
                        // fppd leaves the old channels as they were when the channel set changes: switch them off first
                        await postTest(C.frameRequest(drv.last, 0));
                        await sleep(130);
                    }
                    if (job.frame.ranges.length) {
                        await postTest(C.frameRequest(job.frame, job.level ? level() : 0));
                        drv.last = job.frame; drv.on = true;
                    } else {
                        if (drv.on) await postTest(offRequest());
                        drv.last = null; drv.on = false;
                    }
                    drv.error = '';
                } catch (e) {
                    drv.error = 'Could not reach FPP to change the test output.';
                }
            }
            drv.busy = false;
            renderStatus();
        })();
        return drv.done;
    }
    var blinkTimer = null;
    function stopBlink() { if (blinkTimer) { clearInterval(blinkTimer); blinkTimer = null; } }
    function allOff() {
        stopBlink();
        S.colour.current = ''; S.verify = null; S.count.started = false;
        return show(C.emptyFrame(), '');
    }
    function reshow() {
        // brightness changed: send the current frame again
        if (drv.last && drv.last.ranges.length && !blinkTimer) show(drv.last, S.lit.label);
    }

    function pollStatus() {
        fetch('api/fppd/status', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
            S.fppd = { known: true, running: d && d.fppd === 'running', status: d && d.status_name ? String(d.status_name) : '', mode: d && d.mode_name ? String(d.mode_name) : '' };
        }).catch(function () {
            S.fppd = { known: true, running: false, status: '', mode: '' };
        }).then(renderStatus);
    }

    // ------------------------------------------------------------------ actions

    function lightSelected(mode) {
        var r = selRow(), p = partOf(r);
        if (!p) { toast('This string is not in FPP\'s running configuration yet. Use "Apply to FPP" first.', true); return; }
        stopBlink();
        S.colour.current = ''; S.verify = null; S.count.started = false;
        var part = mode === 'first' ? { live: p.live, from: p.from, count: 1 } : p;
        var frame = S.ident.colour === 'W' ? C.solidFrame([part]) : C.colourFrame([part], S.ident.colour);
        if (!frame.ranges.length) { toast('This string has no channel for that colour.', true); return; }
        var label = C.rowLabel(r) + (mode === 'first' ? ' · first pixel' : '');
        if (mode === 'blink') {
            var on = true;
            show(frame, label + ' · blinking');
            blinkTimer = setInterval(function () { on = !on; show(frame, label + ' · blinking', on ? 1 : 0); }, 600);
        } else show(frame, label);
    }

    function identifyAll() {
        stopBlink();
        S.colour.current = ''; S.verify = null; S.count.started = false;
        var f = C.identifyAllFrame(S.liveOutputs);
        if (!f.ranges.length) { toast('There are no pixels configured to light.', true); return; }
        show(f, 'Identify all ports');
    }

    function countMax(row) { return row && !row.empty ? C.countLimit(S.record.draft, row.vs, S.lidx) : 0; }
    function countPos(row) {
        var max = countMax(row);
        if (!max) return 0;
        var p = S.count.pos[row.vs._uid];
        if (!p || p < 1) p = max;
        if (p > max) p = max;
        return p;
    }
    function countGo(pos) {
        var r = selRow(), l = liveFor(r);
        if (!l) { toast('This string is not in FPP\'s running configuration yet. Use "Apply to FPP" first.', true); return; }
        pos = Math.max(1, Math.min(countMax(r), pos));
        S.count.pos[r.vs._uid] = pos;
        S.count.started = true; S.count.save = '';
        stopBlink(); S.colour.current = ''; S.verify = null;
        show(C.solidFrame([{ live: l.vs, from: l.off + pos - 1, count: 1 }]), C.rowLabel(r) + ' · pixel ' + pos);
        render();
    }
    function countSave() {
        var r = selRow(); if (!r) return;
        var inp = root.querySelector('#wltm-count-save');
        var n = C.toInt(inp ? inp.value : countPos(r), 0);
        var res = C.setPixelCount(S.record.draft, r.vs._uid, n);
        if (!res.ok) { toast(res.error, true); return; }
        var m = meta(r.vs._uid);
        m.counted = n; m.countedAt = nowIso();
        delete S.count.pos[r.vs._uid];
        saveRecord();
        toast(C.rowLabel(r) + ': count ' + n + ' saved.');
        render();
    }
    function countSplit() {
        var r = selRow(); if (!r) return;
        var pos = countPos(r);
        if (!window.confirm('Split ' + C.rowLabel(r) + ' after pixel ' + pos + '?\n\nPixels 1–' + pos + ' stay as this string and the rest becomes a new string on the same port. The lights keep the same channels.')) return;
        var res = C.splitString(S.record.draft, r.vs._uid, pos);
        if (!res.ok) { toast(res.error, true); return; }
        var m = meta(r.vs._uid);
        m.counted = pos; m.countedAt = nowIso();
        delete S.count.pos[r.vs._uid];
        saveRecord();
        toast('Split done. The new string is selected below it in the list.');
        render();
    }

    function colourItems() {
        var rows = testable().filter(function (r) { return C.testColours(liveFor(r).vs.colorOrder).length > 0; });
        if (S.colour.scope === 'sel') {
            var s = selRow();
            rows = rows.filter(function (r) { return s && r.vs._uid === s.vs._uid; });
        }
        return rows;
    }
    function seenOf(row) {
        // answers only count for the colour order they were given under
        var m = meta(row.vs._uid), lo = String(liveFor(row).vs.colorOrder);
        if (m.seenFor !== lo) return {};
        return m.seen || {};
    }
    function colourSend(X) {
        stopBlink(); S.verify = null; S.count.started = false;
        if (!X) { S.colour.current = ''; show(C.emptyFrame(), ''); render(); return; }
        var items = colourItems();
        var parts = items.map(partOf);
        var f = C.colourFrame(parts, X);
        if (!f.ranges.length) { toast('None of these strings has a ' + C.COLOUR_NAMES[X].toLowerCase() + ' channel.', true); return; }
        S.colour.current = X;
        show(f, C.COLOUR_NAMES[X] + ' on ' + (S.colour.scope === 'sel' && items.length === 1 ? C.rowLabel(items[0]) : items.length + ' strings'));
        render();
    }
    function colourAnswer(uid, X, v) {
        var r = rowByUid(uid), l = liveFor(r);
        if (!l) return;
        var m = meta(uid), lo = String(l.vs.colorOrder);
        if (m.seenFor !== lo) { m.seen = {}; m.seenFor = lo; }
        if (!m.seen) m.seen = {};
        m.seen[X] = v;
        var res = C.detectOrder(lo, m.seen);
        if (res.status === 'ok') { m.detected = res.order; m.detectedAt = nowIso(); delete m.problem; }
        else if (res.status === 'problem') { delete m.detected; m.problem = res.problem; }
        else { delete m.problem; }
        if (m.verifiedOrder && m.detected && m.detected !== m.verifiedOrder) { delete m.verified; delete m.verifiedOrder; delete m.verifiedAt; }
    }
    function colourFill(v, onlyBlank) {
        var X = S.colour.current; if (!X) return;
        colourItems().forEach(function (r) {
            if (C.inputOffset(liveFor(r).vs.colorOrder, X) < 0) return;
            if (onlyBlank && seenOf(r)[X]) return;
            colourAnswer(r.vs._uid, X, v);
        });
        saveRecord(); render();
    }
    function colourRestart() {
        colourItems().forEach(function (r) {
            var m = meta(r.vs._uid);
            delete m.seen; delete m.seenFor; delete m.detected; delete m.detectedAt; delete m.problem;
        });
        S.colour.current = '';
        show(C.emptyFrame(), '');
        saveRecord(); render();
    }
    function groupData() {
        var items = colourItems().map(function (r) {
            var l = liveFor(r);
            return { uid: r.vs._uid, label: C.rowLabel(r), liveOrder: String(l.vs.colorOrder), draftOrder: String(r.vs.colorOrder), meta: S.record.meta[r.vs._uid] || {} };
        });
        return C.groupByOrder(items);
    }
    function groupByName(name) {
        var g = null;
        groupData().groups.forEach(function (x) { if (x.name === name) g = x; });
        return g;
    }
    function groupLight(name) {
        var g = groupByName(name); if (!g) return;
        stopBlink(); S.colour.current = ''; S.verify = null; S.count.started = false;
        var parts = g.items.map(function (i) { return partOf(rowByUid(i.uid)); }).filter(Boolean);
        show(C.solidFrame(parts), 'Group ' + g.name + ' (' + g.order + ')');
        render();
    }
    function groupStage(name) {
        var g = groupByName(name); if (!g) return;
        var order = S.colour.choice[g.order] || g.order, n = 0, err = '';
        g.items.forEach(function (i) {
            var res = C.setColourOrder(S.record.draft, i.uid, order);
            if (res.ok) n++; else err = res.error;
        });
        if (err) toast(err, true);
        saveRecord();
        toast('Colour order ' + order + ' set for ' + n + ' string' + (n === 1 ? '' : 's') + '. It reaches the lights after "Apply to FPP".');
        render();
    }
    function verifyStart(uids, label) {
        var rows = uids.map(rowByUid).filter(function (r) { return r && liveFor(r); });
        if (!rows.length) return;
        var pending = rows.filter(function (r) { return String(r.vs.colorOrder) !== String(liveFor(r).vs.colorOrder); });
        if (pending.length) { toast('A colour-order change is still waiting for these strings. Use "Apply to FPP" first, then verify.', true); return; }
        var cols = [];
        rows.forEach(function (r) { C.testColours(liveFor(r).vs.colorOrder).forEach(function (c) { if (cols.indexOf(c) < 0) cols.push(c); }); });
        cols.sort(function (a, b) { return 'RGBW'.indexOf(a) - 'RGBW'.indexOf(b); });
        stopBlink(); S.colour.current = ''; S.count.started = false;
        S.verify = { uids: rows.map(function (r) { return r.vs._uid; }), label: label, cols: cols, step: 0, answers: {} };
        verifyShow();
    }
    function verifyShow() {
        var v = S.verify; if (!v) return;
        var X = v.cols[v.step];
        var parts = v.uids.map(function (u) { return partOf(rowByUid(u)); }).filter(Boolean);
        show(C.colourFrame(parts, X), 'Verify ' + v.label + ' · ' + C.COLOUR_NAMES[X]);
        render();
    }
    function verifyAnswer(yes) {
        var v = S.verify; if (!v) return;
        v.answers[v.cols[v.step]] = !!yes;
        if (v.step + 1 < v.cols.length) { v.step++; verifyShow(); return; }
        var pass = v.cols.every(function (c) { return v.answers[c] === true; });
        v.uids.forEach(function (u) {
            var r = rowByUid(u), l = liveFor(r); if (!l) return;
            // a group answer can only speak for the colours that string was actually sent
            var mine = C.testColours(l.vs.colorOrder);
            var ok = mine.every(function (c) { return v.answers[c] === true; });
            var m = meta(u);
            m.verified = ok; m.verifiedOrder = String(l.vs.colorOrder); m.verifiedAt = nowIso();
        });
        S.verify = null;
        show(C.emptyFrame(), '');
        saveRecord();
        toast(pass ? 'Verified: ' + v.label + '.' : 'Verify failed for ' + v.label + '. Run the colour test again for these strings.', !pass);
        render();
    }

    function renameCommit() {
        var e = S.edit; if (!e) return;
        var inp = root.querySelector('#wltm-rename');
        var row = null;
        draftRows().forEach(function (r) { if (r.key === e.key) row = r; });
        S.edit = null;
        if (row && inp) {
            C.renameRow(S.record.draft, row, inp.value);
            saveRecord();
        }
        render();
    }
    function addCommit() {
        var a = S.add; if (!a) return;
        function val(id) { var x = root.querySelector(id); return x ? x.value : ''; }
        var res = C.addString(S.record.draft, a.co, a.port, a.sub, {
            description: val('#wltm-add-desc'), pixelCount: val('#wltm-add-count'), colorOrder: val('#wltm-add-order'), startChannel: val('#wltm-add-start')
        });
        if (!res.ok) { toast(res.error, true); return; }
        S.add = null; S.sel = res.uid;
        saveRecord();
        toast('String added. It can be tested after "Apply to FPP".');
        render();
    }

    function discardStaged() {
        if (!window.confirm('Discard every change that is waiting to be applied? Test results are kept.')) return;
        allOff();
        S.record.draft = C.makeDraft(S.liveOutputs, S.record.draft);
        S.record.baseHash = S.liveHash;
        saveRecord(); render();
    }

    async function waitForFppd() {
        var end = Date.now() + 90000;
        await sleep(3000);
        while (Date.now() < end) {
            try {
                var d = await fetch('api/fppd/status', { cache: 'no-store' }).then(function (r) { return r.json(); });
                if (d && d.fppd === 'running') return true;
            } catch (e) { /* still restarting */ }
            await sleep(2000);
        }
        return false;
    }
    async function restartFppd() {
        S.busy = 'Restarting fppd…'; render();
        try { await fetch('api/system/fppd/restart', { cache: 'no-store' }).then(function (r) { return r.text(); }); } catch (e) { /* the request can be cut off by the restart itself */ }
        var ok = await waitForFppd();
        S.busy = '';
        drv.last = null; drv.on = false;      // a restart ends test mode
        S.lit = { label: '', note: '' };
        pollStatus();
        if (!ok) toast('fppd did not report "running" within 90 seconds. Check the FPP status page.', true);
        return ok;
    }

    async function applyToFpp() {
        var d = diffs();
        if (!d.length) return;
        if (!window.confirm('Write ' + d.length + ' change' + (d.length === 1 ? '' : 's') + ' to FPP\'s Pixel Strings configuration and restart fppd?\n\nA backup is saved first. The lights go dark for a few seconds during the restart.')) return;
        try {
            await allOff();
            S.busy = 'Saving to FPP…'; render();
            if (saveTimer) await flushRecord();
            var cfg = C.clone(S.liveRoot);
            cfg.channelOutputs = C.stripDraft(S.record.draft);
            var text = JSON.stringify(cfg, null, 2);
            var res = await call('apply', { expectHash: S.liveHash, configText: text });
            S.liveRoot = cfg; S.liveOutputs = cfg.channelOutputs; S.liveHash = res.liveHash;
            S.backups = res.backups || S.backups;
            S.lidx = C.liveIndex(S.liveOutputs);
            C.rebaseDraft(S.record.draft);
            S.record.baseHash = S.liveHash;
            S.count.pos = {};
            saveRecord();
            await flushRecord();
            var ok = await restartFppd();
            if (ok) toast('Applied. Backup saved as ' + (res.backup || '(none needed)') + '.');
        } catch (e) {
            S.busy = '';
            toast(e.message, true);
            try { await loadState(); } catch (e2) { /* keep what we have */ }
        }
        render();
    }

    async function restoreBackup(name) {
        if (!window.confirm('Restore ' + name + ' as FPP\'s Pixel Strings configuration and restart fppd?\n\nThe current configuration is backed up first. Changes waiting on this page are dropped.')) return;
        try {
            await allOff();
            S.busy = 'Restoring backup…'; render();
            if (saveTimer) await flushRecord();
            await call('restore', { name: name });
            S.record.dirty = false;
            await flushRecord();
            await loadState();
            var ok = await restartFppd();
            if (ok) toast('Backup restored.');
        } catch (e) {
            S.busy = '';
            toast(e.message, true);
        }
        render();
    }

    function exportCsv() {
        var out = [['Port', 'Subport', 'Description', 'Start channel', 'Pixels (FPP)', 'Pixels (waiting)', 'Counted', 'Counted on', 'Colour order (FPP)', 'Colour order (waiting)', 'Detected order', 'Detected on', 'Verified', 'Verified on', 'Status']];
        var dk = diffKeys();
        draftRows().forEach(function (r) {
            if (r.empty) { out.push([r.portNumber, r.subLetter, r.vs ? r.vs.description || '' : '', '', 0, '', '', '', '', '', '', '', '', '', 'Unused']); return; }
            var l = liveFor(r), m = S.record.meta[r.vs._uid] || {};
            var st = C.statusOf(r.vs, l, m, !!dk[r.key]);
            var whole = l && l.off === 0;
            out.push([r.portNumber, r.subLetter, r.vs.description || '', C.toInt(r.vs.startChannel, 0) + 1,
                whole ? l.vs.pixelCount : '', r.vs.pixelCount, m.counted || '', shortDate(m.countedAt),
                l ? l.vs.colorOrder : '', r.vs.colorOrder, m.detected || '', shortDate(m.detectedAt),
                m.verified === true ? 'yes' : (m.verified === false ? 'failed' : ''), shortDate(m.verifiedAt), st.text]);
        });
        var blob = new Blob(['﻿' + C.toCsv(out)], { type: 'text/csv;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'winterlights-test-record-' + shortDate(nowIso()).replace(/[: ]/g, '-') + '.csv';
        document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); if (a.parentNode) a.parentNode.removeChild(a); }, 500);
    }

    function diffKeys() {
        var k = {};
        diffs().forEach(function (d) { k[d.key] = d; });
        return k;
    }

    // ------------------------------------------------------------------ rendering

    var DOT = { r: 'Red', g: 'Green', b: 'Blue', w: 'White', k: 'Nothing lit' };

    function pill(cls, text) { return '<span class="wltm-pill ' + cls + '">' + esc(text) + '</span>'; }
    function btn(act, text, cls, attrs) { return '<button type="button" class="wltm-btn ' + (cls || '') + '" data-act="' + act + '"' + (attrs || '') + '>' + text + '</button>'; }

    function renderStatus() {
        var el = root.querySelector('#wltm-status');
        if (!el || !S.ready) return;
        var act = document.activeElement;
        if (act && act.id === 'wltm-bright' && el.contains(act) && el.querySelector('.wltm-strip')) return;   // do not rebuild the slider mid-drag
        var h = '';
        h += S.lit.label ? pill('on', 'TEST MODE ON') : pill('grey', 'Test mode off');
        if (S.fppd.known) h += S.fppd.running ? pill('ok', 'fppd running') : pill('warn', 'fppd not running');
        var rows = C.listRows(S.liveOutputs), ports = {}, n = 0;
        rows.forEach(function (r) { ports[r.co + ':' + r.port] = 1; if (!r.empty) n++; });
        h += pill('grey', 'BBB48String · ' + Object.keys(ports).length + ' ports · ' + n + ' string' + (n === 1 ? '' : 's'));
        if (S.lit.label) h += '<span class="wltm-cap">Lighting: ' + esc(S.lit.label) + '</span>';
        h += '<span class="wltm-grow"></span>';
        h += '<label class="wltm-cap wltm-bright">Brightness <input type="range" id="wltm-bright" min="5" max="100" step="5" value="' + S.brightness + '"> <span id="wltm-bright-val">' + S.brightness + '%</span></label>';
        h += btn('identify-all', 'Identify all ports') + btn('all-off', 'Stop test · all off', 'red');
        var warn = '';
        if (drv.error) warn += '<div class="wltm-note bad">' + esc(drv.error) + '</div>';
        if (S.fppd.known && !S.fppd.running) warn += '<div class="wltm-note bad">fppd is not running, so nothing can be lit. Start it from the FPP status page.</div>';
        else if (S.fppd.known && S.fppd.status && ['idle', 'testing'].indexOf(S.fppd.status) < 0) {
            warn += '<div class="wltm-note bad">FPP is ' + esc(S.fppd.status) + '. A running playlist shows through the test and makes it unreliable. ' + btn('stop-playlist', 'Stop playlist', 'sm') + '</div>';
        }
        var off = S.liveOutputs.filter(function (co) { return co && co.type === 'BBB48String' && co.enabled === 0; }).length;
        if (off) warn += '<div class="wltm-note bad">The BeagleBone pixel-string output is disabled in FPP, so the lights will not respond. Enable it on the Pixel Strings page.</div>';
        if (S.lit.note) warn += '<div class="wltm-note">' + esc(S.lit.note) + '</div>';
        if (S.notice) warn += '<div class="wltm-note">' + esc(S.notice) + ' ' + btn('dismiss-notice', 'OK', 'sm') + '</div>';
        el.innerHTML = '<div class="wltm-strip">' + h + '</div>' + warn;
    }

    function orderCell(r, l) {
        if (!l) return '<span class="wltm-mono">' + esc(r.vs.colorOrder) + '</span>';
        var lo = String(l.vs.colorOrder), d = String(r.vs.colorOrder);
        return '<span class="wltm-mono">' + esc(lo) + (lo !== d ? '<span class="wltm-arrow">→</span>' + esc(d) : '') + '</span>';
    }

    function renderPortsTable() {
        var dk = diffKeys(), sel = selRow();
        var h = '<div class="wltm-card"><h2>Ports and subports <span class="wltm-tag">read from Pixel Strings config</span></h2><div class="wltm-scroll"><table class="wltm-table"><tr><th>Port</th><th>Sub</th><th>Description</th><th>Start ch</th><th>Pixels</th><th>Counted</th><th>Colour order</th><th>Status</th><th></th></tr>';
        draftRows().forEach(function (r) {
            var uid = r.empty ? '' : r.vs._uid;
            var isSel = sel && uid && uid === sel.vs._uid;
            var l = liveFor(r), m = uid ? (S.record.meta[uid] || {}) : {};
            h += '<tr class="' + (isSel ? 'sel ' : '') + (r.empty ? 'empty' : 'pick') + '"' + (uid ? ' data-act="select" data-uid="' + esc(uid) + '"' : '') + '>';
            h += '<td class="wltm-port">' + r.portNumber + '</td><td>' + (r.subLetter ? '<span class="wltm-sub">' + r.subLetter + '</span>' : '<span class="wltm-muted">–</span>') + '</td>';
            var desc = r.vs ? String(r.vs.description || '') : '';
            if (S.edit && S.edit.key === r.key) {
                h += '<td class="wltm-nowrap"><input type="text" id="wltm-rename" maxlength="60" value="' + esc(desc) + '"> ' + btn('rename-ok', '✓', 'sm green', ' title="Save name"') + ' ' + btn('rename-cancel', '✕', 'sm', ' title="Cancel"') + '</td>';
            } else {
                h += '<td>' + (desc ? esc(desc) : '<span class="wltm-muted">' + (r.empty ? '(empty)' : '(no name)') + '</span>') + ' <button type="button" class="wltm-pen" data-act="rename" data-key="' + esc(r.key) + '" title="Rename">✎</button></td>';
            }
            if (r.empty) {
                h += '<td class="wltm-muted">–</td><td class="wltm-muted">0</td><td class="wltm-muted">–</td><td class="wltm-muted">–</td><td>' + pill('grey', 'Unused') + '</td>';
            } else {
                var st = C.statusOf(r.vs, l, m, !!dk[r.key]);
                var livePx = l && l.off === 0 && !/^split/.test(dk[r.key] ? dk[r.key].text : '') ? C.toInt(l.vs.pixelCount, 0) : null;
                var px = (livePx !== null && livePx !== C.toInt(r.vs.pixelCount, 0)) ? livePx + '<span class="wltm-arrow">→</span>' + esc(r.vs.pixelCount) : esc(r.vs.pixelCount);
                h += '<td class="wltm-mono">' + (C.toInt(r.vs.startChannel, 0) + 1) + '</td><td>' + px + '</td><td>' + (m.counted ? esc(m.counted) : '<span class="wltm-muted">–</span>') + '</td><td>' + orderCell(r, l) + '</td><td>' + pill(st.cls, st.text) + '</td>';
            }
            h += '<td class="wltm-nowrap">' + btn('add-open', '+', 'sm', ' data-co="' + r.co + '" data-port="' + r.port + '" data-sub="' + r.sub + '" title="Add a string to ' + esc(C.rowLabel(r)) + '"');
            if (uid && !r.vs._live) h += ' ' + btn('remove-new', '✕', 'sm', ' data-uid="' + esc(uid) + '" title="Remove this new string"');
            h += '</td></tr>';
            if (S.add && S.add.co === r.co && S.add.port === r.port && S.add.sub === r.sub && isLastOfList(r)) h += addForm(r);
        });
        h += '</table></div><div class="wltm-body wltm-cap">Click a row to select it. ✎ renames a port or subport. + adds a string to that port or subport. Changes wait at the bottom of the page until you press "Apply to FPP".<br>"Identify all ports" lights as many pixels as the port number (port 3 → 3 pixels). On ports with subports, two dark pixels follow, then 1 pixel for subport A, 2 for B, and so on.</div></div>';
        return h;
    }
    function isLastOfList(r) {
        var rows = draftRows().filter(function (x) { return x.co === r.co && x.port === r.port && x.sub === r.sub; });
        return rows.length && rows[rows.length - 1].key === r.key;
    }
    function addForm(r) {
        var orders = C.RGB_PERMS.concat(C.allowedOrders('RGBW'));
        var h = '<tr class="wltm-addrow"><td colspan="9"><div class="wltm-row"><b>Add a string to ' + esc(C.rowLabel(r)) + '</b>';
        h += '<label>Name <input type="text" id="wltm-add-desc" maxlength="60" size="16"></label>';
        h += '<label>Pixels <input type="number" id="wltm-add-count" min="1" max="' + C.MAX_PIXELS_PER_STRING + '" value="50" style="width:80px"></label>';
        h += '<label>Colour order <select id="wltm-add-order">' + orders.map(function (o) { return '<option>' + o + '</option>'; }).join('') + '</select></label>';
        h += '<label>Start channel <input type="number" id="wltm-add-start" min="1" value="' + (C.nextFreeChannel(S.record.draft) + 1) + '" style="width:100px"></label>';
        h += btn('add-ok', 'Add', 'sm green') + btn('add-cancel', 'Cancel', 'sm') + '</div></td></tr>';
        return h;
    }

    function selHead(r) {
        if (!r) return '<div class="wltm-selhead"><span class="t">No string selected</span></div>';
        var l = liveFor(r), cpp = C.orderInfo(r.vs.colorOrder).cpp;
        var s = C.toInt(r.vs.startChannel, 0) + 1, e = s + C.dataPixels(r.vs) * cpp - 1;
        var d = (r.vs.description ? esc(r.vs.description) + ' · ' : '') + 'channels ' + s + '–' + e + ' · ' + esc(r.vs.pixelCount) + ' px · ' + esc(r.vs.colorOrder);
        if (!l) d += ' · not on the lights yet';
        return '<div class="wltm-selhead"><span class="t">' + esc(C.rowLabel(r)) + '</span><span class="d">' + d + '</span><span class="wltm-grow"></span>' + btn('prev', '◀ Previous', 'sm') + btn('next', 'Next ▶', 'sm') + '</div>';
    }
    function notLive() {
        return '<div class="wltm-note">This string is not in FPP\'s running configuration yet. Press "Apply to FPP" at the bottom of the page, then it can be lit and tested.</div>';
    }

    function renderPorts() {
        var r = selRow();
        var h = '<div class="wltm-cols"><div>' + renderPortsTable() + '</div><div class="wltm-stack">' + selHead(r);
        h += '<div class="wltm-card"><h2><span class="wltm-num">1</span>Identify</h2><div class="wltm-body">';
        if (r && !liveFor(r)) h += notLive();
        else if (r) {
            h += '<div class="wltm-row">' + btn('light', 'Light this string', 'pri') + btn('blink', 'Blink') + btn('first', 'First pixel only') + '</div>';
            h += '<div class="wltm-cap" style="margin-top:10px">Only this string is lit, so the one that lights up is ' + esc(C.rowLabel(r)) + '.</div>';
            h += '<div class="wltm-row" style="margin-top:12px"><span class="wltm-cap">Colour:</span>';
            [['W', 'w', 'White'], ['R', 'r', 'R'], ['G', 'g', 'G'], ['B', 'b', 'B']].forEach(function (c) {
                h += '<button type="button" class="wltm-sw' + (S.ident.colour === c[0] ? ' pick' : '') + '" data-act="ident-colour" data-c="' + c[0] + '"><i class="' + c[1] + '"></i>' + c[2] + '</button>';
            });
            h += '</div><div class="wltm-cap" style="margin-top:8px">R, G and B here follow the colour order FPP is configured with, so they can look wrong until the order has been tested.</div>';
        } else h += '<div class="wltm-cap">Select a string in the list.</div>';
        h += '</div></div>';
        h += '<div class="wltm-card"><h2>Next steps</h2><div class="wltm-body wltm-row">' + btn('tab', 'Count LEDs ▶', '', ' data-tab="count"') + btn('tab', 'Colour order ▶', '', ' data-tab="colour"') + btn('tab', 'Record ▶', '', ' data-tab="record"') + '</div></div>';
        h += '</div></div>';
        return h;
    }

    function renderCount() {
        var r = selRow(), l = liveFor(r);
        var h = '<div class="wltm-cols"><div>' + renderPortsTable() + '</div><div class="wltm-stack">' + selHead(r);
        h += '<div class="wltm-card"><h2><span class="wltm-num">2</span>Count LEDs <span class="wltm-tag">move the single lit pixel onto the last LED</span></h2><div class="wltm-body">';
        if (!r) h += '<div class="wltm-cap">Select a string in the list.</div>';
        else if (!l) h += notLive();
        else {
            var pos = countPos(r), started = S.count.started, max = countMax(r);
            var g = C.toInt(l.vs.groupCount, 0), zz = C.toInt(l.vs.zigZag, 0);
            h += '<div class="wltm-row" style="gap:18px;align-items:flex-start"><div><div class="wltm-cap">Lit pixel</div><div class="wltm-big" id="wltm-count-pos">' + (started ? pos : '–') + '</div><div class="wltm-cap">of ' + max + ' configured</div></div><div>';
            h += '<div class="wltm-row">' + [-50, -10, -1, 1, 10, 50].map(function (d) { return btn('count-step', (d > 0 ? '+' : '−') + Math.abs(d), d === 1 ? 'pri' : '', ' data-d="' + d + '"'); }).join('') + '</div>';
            h += '<div class="wltm-row" style="margin-top:8px">' + btn('count-first', '⏮ First', 'sm') + btn('count-half', 'Half', 'sm') + btn('count-end', 'End ⏭', 'sm') + '<span class="wltm-cap">Keyboard: ← → step 1 · ↑ ↓ step 10</span></div></div></div>';
            if (!started) h += '<div class="wltm-cap" style="margin-top:10px">Press <b>End</b> to light the last configured pixel, then step back until the lit pixel sits on the last real LED.</div>';
            // strip
            var from = Math.max(1, Math.min(pos - 24, max - 29)), to = Math.min(max, from + 29);
            h += '<div class="wltm-pixels">';
            for (var p = from; p <= to; p++) h += '<span class="px' + (started && p === pos ? ' lit' : (started && p > pos ? ' end' : '')) + '"></span>';
            h += '</div><div class="wltm-cap">Pixels ' + from + '–' + to + ' · ring = lit now, dashed = configured but after the lit pixel</div>';
            if (started) {
                h += '<div class="wltm-row" style="margin-top:14px"><label>Pixel count to save <input type="number" id="wltm-count-save" min="1" max="' + C.MAX_PIXELS_PER_STRING + '" value="' + esc(S.count.save || pos) + '" style="width:90px"></label>' + btn('count-save', 'Last LED is lit · save count', 'green') + btn('count-split', 'Split here · pixels after ' + pos + ' become a new string', '', pos >= max ? ' disabled' : '') + '</div>';
                h += '<div class="wltm-cap" style="margin-top:6px">Nothing lit? Step back until a pixel lights.</div>';
                if (pos >= max) h += '<div class="wltm-note">This is the last configured pixel (' + max + '). If it is lit and the string goes on, raise the pixel count on the Pixel Strings page, then count again.</div>';
            }
            if (g > 1) h += '<div class="wltm-note">This string uses grouping (' + g + '), so ' + g + ' pixels light together. Type the exact count into the box before saving.</div>';
            if (zz > 1) h += '<div class="wltm-note">This string uses zig-zag, so the lit pixel follows the channel order rather than the wiring order.</div>';
        }
        h += '</div></div></div></div>';
        return h;
    }

    function dot(v) { return v ? '<i class="wltm-dot ' + v + '" title="' + DOT[v] + '"></i>' : '<span class="wltm-muted">–</span>'; }

    function renderColour() {
        var items = colourItems(), cur = S.colour.current;
        var anyW = items.some(function (r) { return C.testColours(liveFor(r).vs.colorOrder).indexOf('W') >= 0; });
        var cols = anyW ? ['R', 'G', 'B', 'W'] : ['R', 'G', 'B'];
        var sel = selRow();
        var h = '<div class="wltm-strip wltm-top">';
        h += '<div><div class="wltm-cap">Test on</div><div class="wltm-seg"><button type="button" data-act="scope" data-s="all" class="' + (S.colour.scope === 'all' ? 'on' : '') + '">All ports</button><button type="button" data-act="scope" data-s="sel" class="' + (S.colour.scope === 'sel' ? 'on' : '') + '">Selected port only</button></div></div>';
        if (S.colour.scope === 'sel') {
            h += '<div><div class="wltm-cap">String</div><select id="wltm-colour-sel">' + testable().map(function (r) { return '<option value="' + esc(r.vs._uid) + '"' + (sel && sel.vs._uid === r.vs._uid ? ' selected' : '') + '>' + esc(C.rowLabel(r) + (r.vs.description ? ' · ' + r.vs.description : '')) + '</option>'; }).join('') + '</select></div>';
        }
        h += '<div><div class="wltm-cap">Send one colour at a time</div><div class="wltm-row">';
        cols.forEach(function (X) {
            var done = items.length && items.every(function (r) { return C.inputOffset(liveFor(r).vs.colorOrder, X) < 0 || seenOf(r)[X]; });
            h += '<button type="button" class="wltm-send ' + X.toLowerCase() + (cur === X ? ' on' : '') + '" data-act="send" data-c="' + X + '"><i class="' + X.toLowerCase() + '"></i>' + C.COLOUR_NAMES[X] + (cur === X ? ' · sending now' : (done ? ' ✓' : '')) + '</button>';
        });
        h += '<button type="button" class="wltm-send" data-act="send" data-c=""><i class="k"></i>Off</button></div></div>';
        h += '<span class="wltm-grow"></span><div>' + btn('colour-restart', 'Restart test', 'sm') + '</div></div>';

        h += '<div class="wltm-cols wide"><div class="wltm-card"><h2>What colour comes out? <span class="wltm-tag">click the colour each string is showing right now</span></h2>';
        if (!items.length) h += '<div class="wltm-body wltm-cap">No string to test here. ' + (S.colour.scope === 'sel' ? 'Select a string that is on the lights.' : '') + '</div>';
        else {
            if (cur) {
                h += '<div class="wltm-body wltm-row wltm-quick"><span class="wltm-cap">Quick fill while sending ' + C.COLOUR_NAMES[cur] + ':</span>';
                ['r', 'g', 'b', 'w'].forEach(function (v) { h += '<button type="button" class="wltm-sw" data-act="fill" data-v="' + v + '"><i class="' + v + '"></i>All show ' + DOT[v] + '</button>'; });
                h += '<span class="wltm-cap">then correct the odd ones out</span></div>';
            } else h += '<div class="wltm-body wltm-cap wltm-quick">Press Red, Green or Blue above to send that colour, then say what each string shows.</div>';
            h += '<div class="wltm-scroll"><table class="wltm-table"><tr><th>Port</th><th>Sub</th><th>Description</th><th>Config</th>';
            cols.forEach(function (X) { h += '<th class="' + (cur === X ? 'cur' : '') + '">Sent ' + C.COLOUR_NAMES[X].toLowerCase() + (cur === X ? '<br>I see: R G B W none' : '<br>saw') + '</th>'; });
            h += '<th>Detected</th></tr>';
            items.forEach(function (r) {
                var l = liveFor(r), seen = seenOf(r), m = S.record.meta[r.vs._uid] || {};
                h += '<tr><td class="wltm-port">' + r.portNumber + '</td><td>' + (r.subLetter ? '<span class="wltm-sub">' + r.subLetter + '</span>' : '<span class="wltm-muted">–</span>') + '</td><td>' + esc(r.vs.description || '') + '</td><td class="wltm-mono">' + esc(l.vs.colorOrder) + '</td>';
                cols.forEach(function (X) {
                    var has = C.inputOffset(l.vs.colorOrder, X) >= 0;
                    if (!has) { h += '<td class="wltm-muted' + (cur === X ? ' cur' : '') + '">n/a</td>'; return; }
                    if (cur === X) {
                        h += '<td class="cur"><span class="wltm-pk">';
                        ['r', 'g', 'b', 'w', 'k'].forEach(function (v) { h += '<button type="button" class="' + v + (seen[X] === v ? ' on' : '') + '" data-act="answer" data-uid="' + esc(r.vs._uid) + '" data-v="' + v + '" title="' + DOT[v] + '" aria-label="' + DOT[v] + '"></button>'; });
                        h += '</span></td>';
                    } else h += '<td>' + dot(seen[X]) + '</td>';
                });
                var det = m.detected ? '<b class="wltm-mono">' + esc(m.detected) + '</b>' : (m.problem ? pill('warn', 'Check') : pill('grey', 'waiting'));
                h += '<td>' + det + '</td></tr>';
            });
            h += '</table></div>';
            var ex = testable().length - testable().filter(function (r) { return C.testColours(liveFor(r).vs.colorOrder).length > 0; }).length;
            h += '<div class="wltm-body wltm-cap">Each answer is saved straight away.' + (ex ? ' ' + ex + ' single-colour string' + (ex === 1 ? ' is' : 's are') + ' left out: there is no colour order to test.' : '') + ' For chips with more than four channels only red, green and blue are tested.</div>';
        }
        h += '</div><div class="wltm-stack">';
        if (S.verify) h += renderVerify();
        h += renderGroups();
        h += '</div></div>';
        return h;
    }

    function renderVerify() {
        var v = S.verify, X = v.cols[v.step];
        var h = '<div class="wltm-card wltm-verify"><h2><span class="wltm-num">4</span>Verify ' + esc(v.label) + ' <span class="wltm-tag">step ' + (v.step + 1) + ' of ' + v.cols.length + '</span></h2><div class="wltm-body">';
        v.cols.forEach(function (c, i) {
            h += '<div class="wltm-row wltm-vrow"><span class="wltm-sw"><i class="' + c.toLowerCase() + '"></i>' + C.COLOUR_NAMES[c] + (i === v.step ? ' showing now' : (i < v.step ? ' shown' : '')) + '</span>';
            if (i < v.step) h += pill(v.answers[c] ? 'ok' : 'warn', v.answers[c] ? 'Yes' : 'No');
            else if (i === v.step) h += '<b>Are these strings ' + C.COLOUR_NAMES[X].toLowerCase() + '?</b>' + btn('verify-yes', '✓ Yes', 'sm green') + btn('verify-no', 'No', 'sm');
            h += '</div>';
        });
        h += '<div class="wltm-row" style="margin-top:8px">' + btn('verify-cancel', 'Cancel', 'sm') + '<span class="wltm-cap">All "Yes" marks the string' + (v.uids.length === 1 ? '' : 's') + ' verified and saves it with the date.</span></div></div></div>';
        return h;
    }

    function renderGroups() {
        var gd = groupData();
        var h = '<div class="wltm-card"><h2>Groups by colour order <span class="wltm-tag">built from your answers</span></h2><div class="wltm-body">';
        if (!gd.groups.length && !gd.problems.length) h += '<div class="wltm-cap">Groups appear here once a string has an answer for every colour.</div>';
        gd.groups.forEach(function (g) {
            var liveOrders = {}, draftOrders = {};
            g.items.forEach(function (i) { liveOrders[i.liveOrder] = 1; draftOrders[i.draftOrder] = 1; });
            var dk = Object.keys(draftOrders), lk = Object.keys(liveOrders);
            var st;
            if (g.state === 'match') st = pill('ok', 'Matches config');
            else if (dk.length === 1 && g.items.every(function (i) { return i.draftOrder !== i.liveOrder; })) st = pill('blue', 'Set to ' + dk[0] + ' · apply to FPP');
            else st = pill('warn', 'Wrong order');
            var choice = S.colour.choice[g.order] || g.order;
            var n = g.items.length;
            h += '<div class="wltm-grp"><div class="gh"><span class="gname">Group ' + g.name + '</span><span class="wltm-ord">' + esc(g.order) + '</span><span class="wltm-cap">' + n + ' string' + (n === 1 ? '' : 's') + ' · configured ' + esc(lk.join(', ')) + '</span><span class="wltm-grow"></span>' + st + '</div><div class="gb">';
            g.items.forEach(function (i) { h += '<span class="wltm-chip">' + esc(i.label) + '</span>'; });
            h += '<div class="wltm-row" style="margin-top:6px">' + btn('group-light', 'Light this group', 'sm', ' data-g="' + g.name + '"');
            h += '<label class="wltm-cap">Colour order for group <select data-change="group-choice" data-order="' + esc(g.order) + '">' + C.allowedOrders(g.order).map(function (o) { return '<option' + (o === choice ? ' selected' : '') + '>' + o + '</option>'; }).join('') + '</select></label>';
            var already = g.items.every(function (i) { return i.draftOrder === choice; });
            h += btn('group-stage', already ? 'Set for ' + n + ' string' + (n === 1 ? '' : 's') + ' ✓' : 'Set for ' + n + ' string' + (n === 1 ? '' : 's'), 'sm green', ' data-g="' + g.name + '"' + (already ? ' disabled' : ''));
            h += btn('group-verify', 'Verify group', 'sm', ' data-g="' + g.name + '"') + '</div></div></div>';
        });
        gd.problems.forEach(function (p) {
            h += '<div class="wltm-note bad"><b>' + esc(p.item.label) + ':</b> ' + esc(p.problem) + '</div>';
        });
        if (gd.waiting.length) h += '<div class="wltm-note">Not in a group yet (answers missing): ' + gd.waiting.map(function (i) { return esc(i.label); }).join(', ') + '.</div>';
        h += '</div></div>';
        return h;
    }

    function renderRecord() {
        var dk = diffKeys();
        var h = '<div class="wltm-card"><h2>Test record <span class="wltm-tag">saved on the controller</span></h2><div class="wltm-body wltm-row">' + btn('export', 'Export record (CSV)') + btn('clear-record', 'Clear test results') + '</div><div class="wltm-scroll"><table class="wltm-table"><tr><th>Port</th><th>Sub</th><th>Description</th><th>Pixels</th><th>Counted</th><th>Counted on</th><th>Colour order</th><th>Detected</th><th>Verified</th><th>Verified on</th><th>Status</th></tr>';
        draftRows().forEach(function (r) {
            if (r.empty) return;
            var l = liveFor(r), m = S.record.meta[r.vs._uid] || {}, st = C.statusOf(r.vs, l, m, !!dk[r.key]);
            h += '<tr><td class="wltm-port">' + r.portNumber + '</td><td>' + (r.subLetter ? '<span class="wltm-sub">' + r.subLetter + '</span>' : '<span class="wltm-muted">–</span>') + '</td><td>' + esc(r.vs.description || '') + '</td><td>' + esc(r.vs.pixelCount) + '</td><td>' + esc(m.counted || '') + '</td><td>' + esc(shortDate(m.countedAt)) + '</td><td>' + orderCell(r, l) + '</td><td class="wltm-mono">' + esc(m.detected || '') + '</td><td>' + (m.verified === true ? 'Yes' : (m.verified === false ? 'Failed' : '')) + '</td><td>' + esc(shortDate(m.verifiedAt)) + '</td><td>' + pill(st.cls, st.text) + '</td></tr>';
        });
        h += '</table></div></div>';
        h += '<div class="wltm-card" style="margin-top:14px"><h2>Configuration backups <span class="wltm-tag">one is saved before every change to FPP</span></h2><div class="wltm-body">';
        if (!S.backups.length) h += '<div class="wltm-cap">No backups yet.</div>';
        S.backups.forEach(function (b, i) {
            h += '<div class="wltm-row wltm-vrow"><span class="wltm-mono">' + esc(b) + '</span>' + (i === 0 ? pill('grey', 'newest') : '') + btn('restore', 'Restore', 'sm', ' data-name="' + esc(b) + '"') + '</div>';
        });
        h += '</div></div>';
        return h;
    }

    function renderFoot() {
        var d = diffs();
        var h = '<div class="wltm-foot">';
        if (!d.length) h += pill('grey', 'Nothing waiting') + '<span class="wltm-cap">FPP\'s configuration matches what is shown here.</span><span class="wltm-grow"></span>';
        else {
            h += pill('blue', d.length + ' change' + (d.length === 1 ? '' : 's') + ' waiting') + '<span class="wltm-cap wltm-difflist">' + d.slice(0, 6).map(function (x) { return '<b>' + esc(x.label) + ':</b> ' + esc(x.text); }).join(' &nbsp;·&nbsp; ') + (d.length > 6 ? ' &nbsp;·&nbsp; and ' + (d.length - 6) + ' more' : '') + '</span><span class="wltm-grow"></span>' + btn('discard', 'Discard changes');
        }
        h += btn('apply', 'Apply to FPP · backup + restart fppd', 'pri', d.length ? '' : ' disabled') + '</div>';
        return h;
    }

    function render() {
        if (!root) return;
        if (!S.ready) return;
        // keep what the user is typing when a re-render is caused by something else
        var keep = {};
        ['#wltm-add-desc', '#wltm-add-count', '#wltm-add-order', '#wltm-add-start'].forEach(function (id) { var x = root.querySelector(id); if (x) keep[id] = x.value; });
        var h = '<div id="wltm-toasts"></div>';
        h += '<div class="wltm-sub1">Identify each port, count its LEDs, find and verify the colour order, and save the result.' + (S.version ? ' <span class="wltm-muted">v' + esc(S.version) + '</span>' : '') + '</div>';
        if (S.fatal) {
            root.innerHTML = h + '<div class="wltm-note bad">' + S.fatal + '</div>';
            return;
        }
        h += '<div class="wltm-tabs">';
        [['ports', 'Ports & identify'], ['count', 'Count LEDs'], ['colour', 'Colour order'], ['record', 'Record']].forEach(function (t) {
            h += '<button type="button" class="wltm-tab' + (S.tab === t[0] ? ' on' : '') + '" data-act="tab" data-tab="' + t[0] + '">' + esc(t[1]) + '</button>';
        });
        h += '</div><div id="wltm-status"></div><div id="wltm-main">';
        h += S.tab === 'count' ? renderCount() : S.tab === 'colour' ? renderColour() : S.tab === 'record' ? renderRecord() : renderPorts();
        h += '</div>' + renderFoot();
        if (S.busy) h += '<div class="wltm-busy"><div>' + esc(S.busy) + '</div></div>';
        var oldToasts = root.querySelector('#wltm-toasts');
        var saved = oldToasts ? Array.prototype.slice.call(oldToasts.childNodes) : [];
        root.innerHTML = h;
        var nt = root.querySelector('#wltm-toasts');
        saved.forEach(function (n) { nt.appendChild(n); });
        Object.keys(keep).forEach(function (id) { var x = root.querySelector(id); if (x) x.value = keep[id]; });
        renderStatus();
        var rn = root.querySelector('#wltm-rename');
        if (rn) { rn.focus(); rn.select(); }
    }

    // ------------------------------------------------------------------ events

    function stepSel(d) {
        var rows = draftRows().filter(function (r) { return !r.empty; });
        if (!rows.length) return;
        var cur = selRow(), i = 0;
        rows.forEach(function (r, n) { if (cur && r.vs._uid === cur.vs._uid) i = n; });
        S.sel = rows[(i + d + rows.length) % rows.length].vs._uid;
        S.count.started = false;
    }

    function onClick(ev) {
        var t = ev.target;
        while (t && t !== root && !(t.getAttribute && t.getAttribute('data-act'))) t = t.parentNode;
        if (!t || t === root || t.disabled) return;
        var act = t.getAttribute('data-act');
        if (S.busy) return;
        // clicks on controls inside a selectable row must not also select the row
        if (act === 'select') {
            var inner = ev.target;
            while (inner && inner !== t) {
                if (inner.tagName === 'BUTTON' || inner.tagName === 'INPUT' || inner.tagName === 'SELECT') return;
                inner = inner.parentNode;
            }
        }
        switch (act) {
            case 'tab':
                if (S.tab !== t.getAttribute('data-tab')) { allOff(); S.tab = t.getAttribute('data-tab'); S.edit = null; S.add = null; }
                render(); break;
            case 'select':
                if (S.sel !== t.getAttribute('data-uid')) {
                    S.sel = t.getAttribute('data-uid'); S.count.started = false;
                    if (drv.on) allOff();
                    render();
                }
                break;
            case 'prev': stepSel(-1); if (drv.on) allOff(); render(); break;
            case 'next': stepSel(1); if (drv.on) allOff(); render(); break;
            case 'identify-all': identifyAll(); render(); break;
            case 'all-off': allOff().then(render); render(); break;
            case 'stop-playlist': fetch('api/playlists/stop', { cache: 'no-store' }).then(function () { setTimeout(pollStatus, 800); }).catch(function () { toast('Could not stop the playlist.', true); }); break;
            case 'dismiss-notice': S.notice = ''; renderStatus(); break;
            case 'light': lightSelected('all'); break;
            case 'blink': lightSelected('blink'); break;
            case 'first': lightSelected('first'); break;
            case 'ident-colour': S.ident.colour = t.getAttribute('data-c'); render(); break;
            case 'rename': S.edit = { key: t.getAttribute('data-key') }; S.add = null; render(); break;
            case 'rename-ok': renameCommit(); break;
            case 'rename-cancel': S.edit = null; render(); break;
            case 'add-open': S.add = { co: +t.getAttribute('data-co'), port: +t.getAttribute('data-port'), sub: +t.getAttribute('data-sub') }; S.edit = null; render(); break;
            case 'add-ok': addCommit(); break;
            case 'add-cancel': S.add = null; render(); break;
            case 'remove-new':
                if (C.removeNewString(S.record.draft, t.getAttribute('data-uid'))) { saveRecord(); render(); }
                break;
            case 'count-step': countGo(countPos(selRow()) + parseInt(t.getAttribute('data-d'), 10)); break;
            case 'count-first': countGo(1); break;
            case 'count-half': if (countMax(selRow())) countGo(Math.ceil(countMax(selRow()) / 2)); break;
            case 'count-end': if (countMax(selRow())) countGo(countMax(selRow())); break;
            case 'count-save': countSave(); break;
            case 'count-split': countSplit(); break;
            case 'scope': if (S.colour.scope !== t.getAttribute('data-s')) { allOff(); S.colour.scope = t.getAttribute('data-s'); } render(); break;
            case 'send': colourSend(t.getAttribute('data-c')); break;
            case 'answer': colourAnswer(t.getAttribute('data-uid'), S.colour.current, t.getAttribute('data-v')); saveRecord(); render(); break;
            case 'fill': colourFill(t.getAttribute('data-v'), false); break;
            case 'colour-restart': if (window.confirm('Clear the colour answers for the strings shown here and start again?')) colourRestart(); break;
            case 'group-light': groupLight(t.getAttribute('data-g')); break;
            case 'group-stage': groupStage(t.getAttribute('data-g')); break;
            case 'group-verify': var g = groupByName(t.getAttribute('data-g')); if (g) verifyStart(g.items.map(function (i) { return i.uid; }), 'group ' + g.name + ' (' + g.order + ')'); break;
            case 'verify-yes': verifyAnswer(true); break;
            case 'verify-no': verifyAnswer(false); break;
            case 'verify-cancel': S.verify = null; show(C.emptyFrame(), ''); render(); break;
            case 'export': exportCsv(); break;
            case 'clear-record': if (window.confirm('Clear every count, detected order and verify result? The FPP configuration is not touched.')) { S.record.meta = {}; saveRecord(); render(); } break;
            case 'restore': restoreBackup(t.getAttribute('data-name')); break;
            case 'discard': discardStaged(); break;
            case 'apply': applyToFpp(); break;
        }
    }

    function onChange(ev) {
        var t = ev.target;
        if (t.id === 'wltm-bright') { S.brightness = C.toInt(t.value, 30); var v = root.querySelector('#wltm-bright-val'); if (v) v.textContent = S.brightness + '%'; reshow(); }
        else if (t.id === 'wltm-colour-sel') { allOff(); S.sel = t.value; render(); }
        else if (t.id === 'wltm-count-save') { S.count.save = t.value; }
        else if (t.getAttribute && t.getAttribute('data-change') === 'group-choice') { S.colour.choice[t.getAttribute('data-order')] = t.value; render(); }
    }

    function onKey(ev) {
        var tag = ev.target && ev.target.tagName;
        if (ev.target && ev.target.id === 'wltm-rename') {
            if (ev.key === 'Enter') { ev.preventDefault(); renameCommit(); }
            else if (ev.key === 'Escape') { S.edit = null; render(); }
            return;
        }
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        if (S.tab !== 'count' || S.busy || !liveFor(selRow())) return;
        var d = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : ev.key === 'ArrowUp' ? 10 : ev.key === 'ArrowDown' ? -10 : 0;
        if (!d) return;
        ev.preventDefault();
        countGo(countPos(selRow()) + d);
    }

    function onLeave() {
        // switch test mode off when the page is closed or left
        if (!drv.on && !drv.busy) return;
        try {
            var body = JSON.stringify(offRequest());
            if (!(navigator.sendBeacon && navigator.sendBeacon('api/testmode', body))) {
                var x = new XMLHttpRequest(); x.open('POST', 'api/testmode', false); x.send(body);
            }
        } catch (e) { /* nothing more we can do while unloading */ }
    }

    function start(el) {
        if (root) return;
        C = window.WLTMCore;
        root = el;
        S.plugin = el.getAttribute('data-plugin') || 'fpp-winterlights-test-mode';
        S.version = el.getAttribute('data-version') || '';
        root.addEventListener('click', onClick);
        root.addEventListener('change', onChange);
        root.addEventListener('input', function (ev) { if (ev.target.id === 'wltm-bright' || ev.target.id === 'wltm-count-save') onChange(ev); });
        document.addEventListener('keydown', onKey);
        window.addEventListener('pagehide', onLeave);
        window.addEventListener('beforeunload', onLeave);
        loadState().then(function () {
            render();
            pollStatus();
            setInterval(pollStatus, 4000);
        }).catch(function (e) {
            root.innerHTML = '<div class="wltm-note bad">Could not load the page data: ' + esc(e.message) + '</div>';
        });
    }

    window.WLTMUI = { start: start, _state: S, _drv: drv };
})();
