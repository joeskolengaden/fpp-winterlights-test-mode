<?php
/*
 * Winterlights Test Mode - page shell.
 * FPP 5.4 adds every file in js/ and css/ to the page head by itself; the small loader below covers FPP
 * versions that do not, so the page works either way.
 */
$wltmPlugin = basename(dirname(__FILE__));
$wltmVersion = '';
$wltmInfo = @json_decode(@file_get_contents(dirname(__FILE__) . '/pluginInfo.json'), true);
if (is_array($wltmInfo) && isset($wltmInfo['version'])) $wltmVersion = (string)$wltmInfo['version'];
?>
<div id="wltm" data-plugin="<?php echo htmlspecialchars($wltmPlugin, ENT_QUOTES, 'UTF-8'); ?>" data-version="<?php echo htmlspecialchars($wltmVersion, ENT_QUOTES, 'UTF-8'); ?>">
  <noscript>This page needs JavaScript.</noscript>
  <div class="wltm-loading">Loading Winterlights Test Mode&hellip;</div>
</div>
<script>
(function () {
    var el = document.getElementById('wltm');
    var base = 'plugin.php?plugin=' + encodeURIComponent(el.getAttribute('data-plugin')) + '&nopage=1&file=';
    function css(name) {
        if (document.querySelector('link[href*="' + name + '"]')) return;
        var l = document.createElement('link'); l.rel = 'stylesheet'; l.type = 'text/css'; l.href = base + 'css/' + name;
        document.head.appendChild(l);
    }
    function js(name, present, next) {
        if (present()) { next(); return; }
        var s = document.createElement('script'); s.src = base + 'js/' + name; s.onload = next;
        s.onerror = function () { el.innerHTML = '<div class="wltm-loading">Could not load ' + name + '.</div>'; };
        document.head.appendChild(s);
    }
    css('wltm.css');
    js('wltm-core.js', function () { return !!window.WLTMCore; }, function () {
        js('wltm-ui.js', function () { return !!window.WLTMUI; }, function () { window.WLTMUI.start(el); });
    });
})();
</script>
