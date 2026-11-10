<?php
/*
 * Winterlights Test Mode - backend.
 * Reached through FPP's plugin loader:  plugin.php?plugin=<dir>&page=api.php&nopage=1&action=<name>
 *
 * It only touches two things on disk:
 *   - FPP's pixel-string config (co-bbbStrings.json), and only on "apply" / "restore", after saving a backup;
 *   - its own folder  <config>/winterlights-test-mode/  holding record.json and the backups.
 * Lighting pixels is done by the page itself through FPP's own /api/testmode.
 */

function wltm_config_dir() {
    global $settings;
    if (isset($settings['configDirectory']) && $settings['configDirectory'] != '') return rtrim($settings['configDirectory'], '/');
    return '/home/fpp/media/config';
}
function wltm_strings_file() {
    global $settings;
    if (isset($settings['co-bbbStrings']) && $settings['co-bbbStrings'] != '') return $settings['co-bbbStrings'];
    return wltm_config_dir() . '/co-bbbStrings.json';
}
function wltm_data_dir() { return wltm_config_dir() . '/winterlights-test-mode'; }
function wltm_backup_dir() { return wltm_data_dir() . '/backups'; }
function wltm_record_file() { return wltm_data_dir() . '/record.json'; }

function wltm_out($data, $code = 200) {
    while (ob_get_level() > 0) { @ob_end_clean(); }
    if (!headers_sent()) {
        http_response_code($code);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
    }
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit(0);
}
function wltm_fail($msg, $code = 400) { wltm_out(array('ok' => false, 'error' => $msg), $code); }

function wltm_ensure_dirs() {
    foreach (array(wltm_data_dir(), wltm_backup_dir()) as $d) {
        if (!is_dir($d) && !@mkdir($d, 0775, true) && !is_dir($d)) wltm_fail('Cannot create folder ' . $d, 500);
    }
}

/* Write a file so a crash or power cut can never leave half of it behind. */
function wltm_write_atomic($file, $text) {
    $tmp = $file . '.tmp' . getmypid();
    if (@file_put_contents($tmp, $text, LOCK_EX) !== strlen($text)) { @unlink($tmp); return false; }
    if (!@rename($tmp, $file)) { @unlink($tmp); return false; }
    return true;
}

function wltm_backups() {
    $out = array();
    $d = wltm_backup_dir();
    if (is_dir($d)) {
        foreach (scandir($d) as $f) {
            if (preg_match('/^co-bbbStrings-\d{8}-\d{6}(-\d+)?\.json$/', $f)) $out[] = $f;
        }
    }
    rsort($out);
    return $out;
}

/* Copy the current FPP config into the backup folder. Returns the backup name, '' if there is nothing to back up. */
function wltm_backup_current() {
    $src = wltm_strings_file();
    if (!file_exists($src)) return '';
    $text = file_get_contents($src);
    if ($text === false) wltm_fail('Cannot read ' . $src, 500);
    $base = 'co-bbbStrings-' . date('Ymd-His');
    $name = $base . '.json';
    $n = 1;
    while (file_exists(wltm_backup_dir() . '/' . $name)) { $name = $base . '-' . $n . '.json'; $n++; }
    if (!wltm_write_atomic(wltm_backup_dir() . '/' . $name, $text)) wltm_fail('Cannot write the backup; nothing was changed.', 500);
    // keep the newest 30
    $all = wltm_backups();
    for ($i = 30; $i < count($all); $i++) @unlink(wltm_backup_dir() . '/' . $all[$i]);
    return $name;
}

function wltm_body() {
    $raw = file_get_contents('php://input');
    return $raw === false ? '' : $raw;
}

function wltm_require_post() {
    if (!isset($_SERVER['REQUEST_METHOD']) || $_SERVER['REQUEST_METHOD'] !== 'POST') wltm_fail('This action needs a POST request.', 405);
}

/* A pixel-string config must at least be an object holding a channelOutputs list of objects. */
function wltm_valid_config($text) {
    $d = json_decode($text, true);
    if (!is_array($d) || !isset($d['channelOutputs']) || !is_array($d['channelOutputs'])) return false;
    foreach ($d['channelOutputs'] as $k => $co) {
        if (!is_int($k) || !is_array($co)) return false;
        if (isset($co['outputs'])) {
            if (!is_array($co['outputs'])) return false;
            foreach ($co['outputs'] as $port) {
                if (!is_array($port)) return false;
                foreach (array('virtualStrings', 'virtualStringsB', 'virtualStringsC', 'virtualStringsD', 'virtualStringsE', 'virtualStringsF') as $key) {
                    if (!isset($port[$key])) continue;
                    if (!is_array($port[$key])) return false;
                    foreach ($port[$key] as $vs) {
                        if (!is_array($vs)) return false;
                        if (isset($vs['_uid']) || isset($vs['_live'])) return false;
                        if (isset($vs['pixelCount']) && (!is_numeric($vs['pixelCount']) || $vs['pixelCount'] < 0 || $vs['pixelCount'] > 1600)) return false;
                        if (isset($vs['startChannel']) && !is_numeric($vs['startChannel'])) return false;
                        if (isset($vs['colorOrder']) && (!is_string($vs['colorOrder']) || !preg_match('/^[A-Za-z0-9]{1,10}$/', $vs['colorOrder']))) return false;
                        if (isset($vs['description']) && !is_string($vs['description'])) return false;
                    }
                }
            }
        }
    }
    return true;
}

$wltmAction = isset($_GET['action']) ? (string)$_GET['action'] : '';

if ($wltmAction === 'state') {
    $file = wltm_strings_file();
    $liveText = file_exists($file) ? file_get_contents($file) : false;
    $recFile = wltm_record_file();
    $recText = file_exists($recFile) ? file_get_contents($recFile) : false;
    wltm_out(array(
        'ok' => true,
        'liveExists' => $liveText !== false,
        'liveText' => $liveText === false ? '' : $liveText,
        'liveHash' => $liveText === false ? '' : md5($liveText),
        'recordText' => $recText === false ? '' : $recText,
        'backups' => wltm_backups(),
        'configFile' => $file
    ));
}

if ($wltmAction === 'saveRecord') {
    wltm_require_post();
    $text = wltm_body();
    if (strlen($text) > 4 * 1024 * 1024) wltm_fail('Record too large.');
    $d = json_decode($text, true);
    if (!is_array($d) || !isset($d['version'])) wltm_fail('The record is not valid JSON.');
    wltm_ensure_dirs();
    if (!wltm_write_atomic(wltm_record_file(), $text)) wltm_fail('Cannot write the record file.', 500);
    wltm_out(array('ok' => true));
}

if ($wltmAction === 'apply') {
    wltm_require_post();
    $req = json_decode(wltm_body(), true);
    if (!is_array($req) || !isset($req['configText']) || !is_string($req['configText']) || !isset($req['expectHash'])) wltm_fail('Bad request.');
    $text = $req['configText'];
    if (!wltm_valid_config($text)) wltm_fail('The new configuration did not pass the safety check; nothing was changed.');
    $file = wltm_strings_file();
    $cur = file_exists($file) ? file_get_contents($file) : false;
    $curHash = $cur === false ? '' : md5($cur);
    if ($curHash !== (string)$req['expectHash']) {
        wltm_fail('FPP\'s pixel-string configuration changed since this page loaded it. Reload the page and try again; nothing was changed.', 409);
    }
    wltm_ensure_dirs();
    $backup = wltm_backup_current();
    if (substr($text, -1) !== "\n") $text .= "\n";
    if (!wltm_write_atomic($file, $text)) wltm_fail('Cannot write ' . $file . '; nothing was changed.', 500);
    wltm_out(array('ok' => true, 'liveHash' => md5($text), 'backup' => $backup, 'backups' => wltm_backups()));
}

if ($wltmAction === 'restore') {
    wltm_require_post();
    $req = json_decode(wltm_body(), true);
    $name = is_array($req) && isset($req['name']) ? (string)$req['name'] : '';
    if (!in_array($name, wltm_backups(), true)) wltm_fail('That backup does not exist.');
    $text = file_get_contents(wltm_backup_dir() . '/' . $name);
    if ($text === false || json_decode($text, true) === null) wltm_fail('That backup cannot be read.', 500);
    wltm_ensure_dirs();
    $backup = wltm_backup_current();
    if (!wltm_write_atomic(wltm_strings_file(), $text)) wltm_fail('Cannot write the configuration; nothing was changed.', 500);
    wltm_out(array('ok' => true, 'liveHash' => md5($text), 'backup' => $backup, 'restored' => $name, 'backups' => wltm_backups()));
}

wltm_fail('Unknown action.', 404);
