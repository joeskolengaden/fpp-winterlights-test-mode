<?php
// Menu entries for PRO Test Mode - By WinterLights.in (FPP includes this once per menu section).
$menuEntries = Array(
    Array('text' => 'PRO Test Mode - By WinterLights.in', 'type' => 'status', 'page' => 'plugin.php', 'wrap' => 1)
);
foreach ($menuEntries as $entry) {
    if ($entry['type'] != $menu) continue;
    printf("<li><a href='plugin.php?plugin=%s&page=%s'>%s</a></li>\n", $plugin, $entry['page'], $entry['text']);
}
?>
