<?php
// Menu entries for Winterlights Test Mode (FPP includes this once per menu section).
$menuEntries = Array(
    Array('text' => 'Winterlights Test Mode', 'type' => 'status', 'page' => 'plugin.php', 'wrap' => 1)
);
foreach ($menuEntries as $entry) {
    if ($entry['type'] != $menu) continue;
    printf("<li><a href='plugin.php?plugin=%s&page=%s'>%s</a></li>\n", $plugin, $entry['page'], $entry['text']);
}
?>
