<?php
/*
 * Stand-in for an FPP 5.4 web server, for the browser tests:  php -S 127.0.0.1:PORT tests/mock-fpp/router.php
 * It loads the plugin the same way FPP's www/plugin.php does (js/ and css/ files added to <head>, pages included
 * with $settings in scope) and records what the page asks FPP to do in $WLTM_MOCK_DIR.
 */
$mock = getenv('WLTM_MOCK_DIR');
$pluginRoot = dirname(dirname(__DIR__));
$pluginName = 'fpp-winterlights-test-mode';
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$settings = array('configDirectory' => $mock . '/config', 'co-bbbStrings' => $mock . '/config/co-bbbStrings.json');

function mock_log($line) { global $mock; file_put_contents($mock . '/requests.log', $line . "\n", FILE_APPEND | LOCK_EX); }

if ($path === '/api/testmode') {
    if ($_SERVER['REQUEST_METHOD'] === 'POST') mock_log('testmode ' . file_get_contents('php://input'));
    header('Content-Type: application/json'); echo 'null'; return true;
}
if ($path === '/api/fppd/status') {
    $f = $mock . '/status.json';
    header('Content-Type: application/json');
    echo file_exists($f) ? file_get_contents($f) : '{"fppd":"running","status_name":"idle","mode_name":"player"}';
    return true;
}
if ($path === '/api/system/fppd/restart') { mock_log('restart'); header('Content-Type: application/json'); echo '{"status":"OK"}'; return true; }
if ($path === '/api/playlists/stop') { mock_log('stop-playlist'); @unlink($mock . '/status.json'); header('Content-Type: application/json'); echo '{"status":"OK"}'; return true; }

if ($path === '/plugin.php') {
    if (!isset($_GET['plugin']) || $_GET['plugin'] !== $pluginName) { http_response_code(404); echo 'unknown plugin'; return true; }
    if (isset($_GET['file'])) {
        $file = $pluginRoot . '/' . $_GET['file'];
        if (strpos($_GET['file'], '..') !== false || !file_exists($file)) { http_response_code(404); echo 'missing'; return true; }
        $ext = pathinfo($file, PATHINFO_EXTENSION);
        header('Content-type: ' . ($ext === 'js' ? 'text/javascript;' : ($ext === 'css' ? 'text/css;' : 'text/plain;')));
        readfile($file); return true;
    }
    if (isset($_GET['nopage'])) {
        echo "\n\n";                                   // FPP's loader can emit stray whitespace before a plugin page
        include $pluginRoot . '/' . $_GET['page'];
        return true;
    }
    $autoload = !isset($_GET['_noautoload']);     // an FPP that does not add a plugin's js/ and css/ files itself
    echo "<!DOCTYPE html><html><head><meta charset='utf-8'><title>FPP mock</title>";
    echo "<style>body{margin:0;background:#eef1f4;font-family:Arial} .mainContainer{padding:20px 24px} h1.title{font-size:22px;margin:0 0 4px} table{border:3px solid red} button{border:3px solid red}</style>";
    if ($autoload) {
        foreach (array_reverse(scandir($pluginRoot . '/js')) as $f) {      // reversed on purpose: FPP's order is not guaranteed
            if ($f[0] !== '.') printf("<script type='text/javascript' src='plugin.php?plugin=%s&file=js/%s&nopage=1'></script>\n", $pluginName, $f);
        }
        foreach (scandir($pluginRoot . '/css') as $f) {
            if ($f[0] !== '.') printf("<link rel='stylesheet' type='text/css' href='/plugin.php?plugin=%s&file=css/%s&nopage=1'>\n", $pluginName, $f);
        }
    }
    echo "</head><body><div id='bodyWrapper'><div class='mainContainer'><h1 class='title'>Winterlights Test Mode</h1><div class='pageContent'>";
    include $pluginRoot . '/' . (isset($_GET['page']) ? $_GET['page'] : 'plugin.php');
    echo "</div></div></div></body></html>";
    return true;
}
http_response_code(404); echo 'not found: ' . htmlspecialchars($path);
return true;
