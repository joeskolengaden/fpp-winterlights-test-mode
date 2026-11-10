#!/usr/bin/env python3
"""
Check a real FPP controller with Winterlights Test Mode installed. Python 3 standard library only.

    python3 tests/hw/check_fpp.py                      # read-only checks against http://192.168.7.2
    python3 tests/hw/check_fpp.py http://fpp.local --light
    python3 tests/hw/check_fpp.py --light --roundtrip  # also lights channels 1-3 briefly / rewrites the config unchanged

Default is read-only. --light turns three channels on at low brightness for a moment and off again.
--roundtrip writes the pixel-string config back exactly as it is (through the plugin's Apply path, which
makes a backup) and does NOT restart fppd. Paste the whole output back to get bugs fixed.
"""
import argparse, hashlib, json, sys, time, urllib.request, urllib.error

PLUGIN = "fpp-winterlights-test-mode"
results = []


def say(ok, name, detail=""):
    results.append(ok)
    print(("PASS  " if ok else "FAIL  ") + name + (("  -  " + detail) if detail else ""))


def get(base, path, data=None, timeout=15):
    req = urllib.request.Request(base + path, data=None if data is None else data.encode(), method="GET" if data is None else "POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.headers.get("Content-Type", ""), r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", ""), e.read().decode("utf-8", "replace")


def plug(action):
    return "/plugin.php?plugin=%s&page=api.php&nopage=1&action=%s" % (PLUGIN, action)


def parse(text):
    a, b = text.find("{"), text.rfind("}")
    return json.loads(text[a:b + 1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base", nargs="?", default="http://192.168.7.2")
    ap.add_argument("--light", action="store_true")
    ap.add_argument("--roundtrip", action="store_true")
    a = ap.parse_args()
    base = a.base.rstrip("/")

    try:
        code, _, body = get(base, "/api/fppd/status")
    except Exception as e:
        print("Cannot reach %s: %s" % (base, e)); sys.exit(2)
    try:
        st = json.loads(body)
    except Exception:
        st = {}
    say(code == 200 and st.get("fppd") == "running", "fppd status", "version=%s mode=%s status=%s fppd=%s platform=%s" % (st.get("version"), st.get("mode_name"), st.get("status_name"), st.get("fppd"), st.get("platform", st.get("Platform", "?"))))
    print("      raw status keys: " + ", ".join(sorted(st.keys())[:40]))
    if st.get("status_name") not in ("idle", "testing", None):
        print("WARN  FPP status is %r - stop the playlist before testing" % st.get("status_name"))

    code, _, body = get(base, "/api/plugin")
    say(code == 200 and PLUGIN in body, "plugin is installed", body[:120].replace("\n", " "))

    code, _, body = get(base, "/plugin.php?plugin=%s&page=plugin.php&nopage=1" % PLUGIN)
    say(code == 200 and 'id="wltm"' in body, "page shell served", "%d bytes" % len(body))
    for f, ctype in (("js/wltm-core.js", "javascript"), ("js/wltm-ui.js", "javascript"), ("css/wltm.css", "css")):
        code, ct, body = get(base, "/plugin.php?plugin=%s&file=%s&nopage=1" % (PLUGIN, f))
        say(code == 200 and ctype in ct and len(body) > 1000, "serves " + f, "%s %s %d bytes" % (code, ct, len(body)))

    code, _, body = get(base, "/")
    code2, _, menu = get(base, "/plugin.php?plugin=%s&page=plugin.php" % PLUGIN)
    say(code2 == 200 and "wltm" in menu and "<html" in menu.lower(), "full page (with FPP menu) loads", "has menu: %s" % ("navbar" in menu.lower() or "menu" in menu.lower()))
    say(menu.count("wltm-core.js") >= 1 and menu.count("wltm.css") >= 1, "FPP adds the plugin's js/css to the page head")

    try:
        code, _, body = get(base, plug("state"))
        d = parse(body)
        say(code == 200 and d.get("ok"), "api: state", "config file %s, %d backups" % (d.get("configFile"), len(d.get("backups", []))))
    except Exception as e:
        say(False, "api: state", "%s :: %s" % (e, body[:300])); d = {}
    live = None
    if d.get("liveText"):
        try:
            live = json.loads(d["liveText"])
        except Exception as e:
            say(False, "pixel-string config is valid JSON", str(e))
    if live is not None:
        outs = [co for co in live.get("channelOutputs", []) if co.get("type") == "BBB48String"]
        say(len(outs) > 0, "BBB48String output present", "enabled=%s subType=%s ports=%s" % (outs[0].get("enabled") if outs else "-", outs[0].get("subType") if outs else "-", len(outs[0].get("outputs", [])) if outs else 0))
        for co in outs:
            for p in co.get("outputs", []):
                row = []
                for i, k in enumerate(("virtualStrings", "virtualStringsB", "virtualStringsC", "virtualStringsD", "virtualStringsE", "virtualStringsF")):
                    s = [(v.get("description", ""), v.get("pixelCount"), v.get("colorOrder")) for v in (p.get(k) or []) if v.get("pixelCount")]
                    if s: row.append("%s:%s" % ("ABCDEF"[i], s))
                if row: print("      port %d diff=%s  %s" % (p.get("portNumber", -1) + 1, p.get("differentialType", 0), "  ".join(row)))
    if d.get("recordText"):
        try: json.loads(d["recordText"]); say(True, "test record readable")
        except Exception as e: say(False, "test record readable", str(e))

    code, _, body = get(base, plug("apply"))
    say(code == 405, "api: apply refuses GET", str(code))
    code, _, body = get(base, plug("apply"), json.dumps({"expectHash": "x", "configText": "[]"}))
    say(code == 400, "api: apply refuses a bad config", "%s %s" % (code, body[:100].strip()))

    code, _, body = get(base, "/api/testmode")
    print("      GET /api/testmode -> %s %s" % (code, body[:200].strip().replace("\n", " ")))

    if a.light:
        off = json.dumps({"enabled": 0, "mode": "RGBFill", "cycleMS": 1000, "color1": 0, "color2": 0, "color3": 0, "channelSet": "1-1", "channelSetType": "channelRange"})
        on = json.dumps({"enabled": 1, "mode": "RGBFill", "cycleMS": 1000, "color1": 60, "color2": 0, "color3": 0, "channelSet": "1-3", "channelSetType": "channelRange"})
        code, _, body = get(base, "/api/testmode", on)
        print("      POST testmode on -> %s %r" % (code, body[:120]))
        time.sleep(1.0)
        code2, _, body2 = get(base, "/api/testmode")
        try: t = json.loads(body2)
        except Exception: t = {}
        say(code == 200 and t.get("enabled") == 1, "test mode turns on", body2[:160].strip().replace("\n", " "))
        say(t.get("channelSet") == "1-3" and t.get("color1") == 60, "test mode echoes the request", json.dumps(t)[:160])
        code, _, body = get(base, "/api/testmode", off)
        time.sleep(0.5)
        code2, _, body2 = get(base, "/api/testmode")
        try: t = json.loads(body2)
        except Exception: t = {}
        say(t.get("enabled") == 0, "test mode turns off", body2[:120].strip())
        code, _, body = get(base, "/api/fppd/status")
        print("      status after: %s" % (json.loads(body).get("status_name") if code == 200 else code))
        print("      (did channels 1-3 of port 1 light red briefly? that is the one thing this script cannot see)")

    if a.roundtrip and live is not None:
        text = d["liveText"]
        h = d["liveHash"]
        code, _, body = get(base, plug("apply"), json.dumps({"expectHash": h, "configText": text}))
        try: r = parse(body)
        except Exception: r = {}
        say(code == 200 and r.get("ok"), "apply round trip (no restart)", (r.get("error") or ("backup " + str(r.get("backup")))))
        d2 = parse(get(base, plug("state"))[2])
        a1, a2 = json.loads(d["liveText"]), json.loads(d2["liveText"])
        say(a1 == a2, "config is semantically unchanged after apply", "hash %s -> %s" % (h[:8], d2.get("liveHash", "")[:8]))
        say(len(d2.get("backups", [])) == len(d.get("backups", [])) + 1, "a backup was added", str(d2.get("backups", [])[:1]))
        code, _, body = get(base, "/api/configfile/co-bbbStrings.json")
        try: json.loads(body); say(True, "FPP can still read its own config file")
        except Exception as e: say(False, "FPP can still read its own config file", str(e))

    print("\n%d of %d checks passed" % (sum(results), len(results)))
    sys.exit(0 if all(results) else 1)


main()
