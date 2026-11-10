# PRO Test Mode - By WinterLights.in

An FPP plugin that adds a test page for BeagleBone pixel outputs. It is built for commissioning a controller:
find out which port is which, how many LEDs each one really has, and what colour order the pixels use, then
write the results back to FPP.

**Supported:** FPP 5.4.x on a BeagleBone (`BBB48String` pixel outputs, including smart-receiver subports A to F).

## Install

Content Setup → Plugin Manager → paste this URL → Install:

```
https://raw.githubusercontent.com/joeskolengaden/fpp-winterlights-test-mode/main/pluginInfo.json
```

The plugin is plain PHP and JavaScript. It does not patch or rebuild FPP. Open it from
**Status/Control → PRO Test Mode - By WinterLights.in**.

## What it does

| Tab | What you do there |
| --- | --- |
| **Ports & identify** | See every port and subport from the Pixel Strings config. Light one string, blink it, or light only its first pixel. "Identify all ports" lights as many pixels as the port number on every port at once. Rename ports and subports, add a string to a port or subport. **Chase start → end (loop)**: runs a lit block from the first pixel to the last and starts again, so you can see which end the data enters and which way the string runs (Slow / Normal / Fast). It follows the string's own pixel order, so a reversed string shows its real direction. Long strings use a wider block so a pass takes a few seconds. **Stop test · all off**, changing string or changing tab ends it. |
| **Count LEDs** | Step a single lit pixel (±1, ±10, ±50, arrow keys) until it sits on the last real LED, then save the count. "Split here" turns the pixels after the lit one into a new string on the same port. Type a **note** in the box under the strip (what the LEDs show, which prop, which direction; the **Tags** chips add your own words, a **Direction** row adds left to right, clockwise and so on) and it is added to the end of the generated description as `port 9 A \| Front roofline, left to right`. The generated name is never changed, saving again replaces only the note, and the whole description stays within FPP's 60 characters. Splitting letters the parts after the generated name: `port 9` becomes `port 9 A` and `port 9 B`, splitting B gives A, B, C, and splitting an earlier part moves the later ones down a letter. The note stays with the part you counted. |
| **Colour order** | Send one colour at a time (red, green, blue, and white on RGBW strings) to all ports or to the ports you tick (**Chosen ports**: one box per port and per subport, and a port's own box ticks or unticks all its subports; the lights follow the ticks), and click the colour each string actually shows. Strings with the same result are grouped; each group's colour order can be changed with one button and verified afterwards. |
| **Record** | The saved result for every string (count, detected order, verified, dates), CSV export, and the configuration backups with a Restore button. |

### Master switch

The **Test mode enabled / DISABLED** switch at the top of the page turns all testing on or off. Switching it off
turns every light off at once and disables every light, colour, count and identify button (and the arrow keys)
until you switch it back on. Renaming, saved results and Apply keep working while it is off. It always starts
enabled when the page is opened.

### Changes wait until you apply them

Renames, counts, colour orders, new strings and splits are collected at the bottom of the page. Nothing reaches
FPP until you press **Apply to FPP**. Apply then:

1. saves a backup of `co-bbbStrings.json`,
2. writes the new configuration,
3. restarts fppd (the lights go dark for a few seconds).

If the Pixel Strings configuration was changed somewhere else in the meantime, Apply refuses and reloads instead
of overwriting it.

### How the colour order is worked out

FPP's colour-order setting lists the colours in the order they go down the wire. If FPP is set to `RGB` and
sending red makes the string show green, the pixel's first colour is green. Three answers (four with white) give
the full order. After applying it, **Verify** sends each colour again and you confirm it; only then is the string
marked verified.

## Limits and things to know

- **Counting only reaches the configured length.** FPP sends data for as many pixels as a port is set to. If the
  last configured pixel lights and the string goes on, raise the count on the Pixel Strings page and count again.
- **Stop playlists first.** A running sequence shows through the test. The page warns and offers a Stop button.
- **New strings need an Apply** before they can be lit, because fppd does not know them yet. Split parts can be
  tested straight away.
- **Enabling a new smart-receiver subport** (changing the receiver type or count of a port) is done on FPP's
  Pixel Strings page. This page adds strings to subports that are already enabled.
- **Strings with 4 or more channels per pixel** may light only their first pixels during the all-ports colour
  test. fppd accepts about 4 KB per test request, and those strings need one entry per pixel.
- **5/6-channel and 16-bit chips** (orders added by the Pixel IC Support plugin): red, green and blue are tested;
  the extra white channels are not.
- **Renaming a string renames its automatic pixel overlay model**, because FPP names those after the description.
- **Deleting a subport:** the trash button deletes a subport and its strings. The subports after it move up one place (delete B of A, B, C and C becomes B) and the port's receiver count goes down by one, because FPP numbers subports by position. A port's only subport cannot be deleted. Strings keep their test results when they move. Until you apply, the lights still follow FPP's current layout.
- Strings using grouping or zig-zag can be counted, but not split here.

## Files it writes

| Path | Purpose |
| --- | --- |
| `/home/fpp/media/config/co-bbbStrings.json` | FPP's own file. Written only by Apply and Restore. |
| `/home/fpp/media/config/winterlights-test-mode/record.json` | Test results and the changes that are waiting. |
| `/home/fpp/media/config/winterlights-test-mode/tags.json` | Your description tags. Starts as: Lip, driver side eye, cleaner side eye, top grill, main grill, bottom grill, top light, u bar centre, u bar driver side beam, u bar cleaner side beam, eye, eyebrow. **✎ Edit tags** in the Count tab adds, removes and reorders them; "Reset to the standard list" restores that list. |
| `/home/fpp/media/config/winterlights-test-mode/backups/` | The newest 30 configuration backups. |

Uninstalling the plugin keeps that folder; delete it by hand to remove the record and backups.

## Tests

```
node --test tests/core.test.js     # logic, against a model of fppd 5.4's channel tester and pixel mapping
node --test tests/e2e.test.js      # the whole page in a browser against a stand-in FPP (needs php and playwright)
```

The tests do not use real hardware. The model in `tests/fppd-sim.js` follows FPP 5.4's `TestPatternBase.cpp`,
`RGBFill.cpp` and `PixelString::SetupMap`.

## Running the tests

```bash
node --test tests/core.test.js                # logic, the "no api.php" rule and a replay of FPP's plugin loader
node --test tests/e2e.test.js                 # whole page in a browser against a stand-in FPP (needs php + playwright)
python3 tests/hw/check_fpp.py http://<fpp>    # read-only checks against a real controller (add --light --roundtrip for more)
```

The browser test needs the checkout folder to be named `fpp-winterlights-test-mode`, because the page derives the plugin name from its folder.
Set `WLTM_CHROME=/path/to/chrome` to use an installed browser instead of Playwright's. The same tests run on GitHub for every push.
