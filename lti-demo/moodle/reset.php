<?php
// Brings the demo Moodle back to "ready for a defense": no LTI activities (and so no gradebook
// items or grades) in LAB101, the tool registration Active, in the activity chooser, launching in
// a new window. Idempotent. Run as the web user (a root run leaves root-owned caches):
//   docker compose exec -u daemon moodle php /tmp/reset-demo.php
// Prints KEY=value lines for reset-demo.ps1; exits non-zero when the registration is missing.
define('CLI_SCRIPT', true);
foreach (['/bitnami/moodle/config.php', '/opt/bitnami/moodle/config.php'] as $c) {
    if (is_readable($c)) { require $c; break; }
}
global $CFG, $DB;
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/mod/lti/locallib.php');
require_once($CFG->libdir . '/gradelib.php');

\core\session\manager::set_user(get_admin());
$course = $DB->get_record('course', ['shortname' => 'LAB101'], '*', MUST_EXIST);

// 1. Delete every LTI activity of the course (course_delete_module also removes its grade item and grades).
$cmids = $DB->get_fieldset_sql(
    "SELECT cm.id FROM {course_modules} cm JOIN {modules} m ON m.id = cm.module
      WHERE m.name = 'lti' AND cm.course = ?", [$course->id]);
foreach ($cmids as $cmid) {
    course_delete_module((int)$cmid);
}
echo 'DELETED_ACTIVITIES=' . count($cmids) . "\n";
// Orphans a half-finished deletion could have left behind.
foreach (grade_item::fetch_all(['courseid' => $course->id, 'itemtype' => 'mod', 'itemmodule' => 'lti']) ?: [] as $item) {
    $item->delete('reset-demo');
}
echo 'LTI_ACTIVITIES=' . $DB->count_records_sql(
    "SELECT COUNT(*) FROM {course_modules} cm JOIN {modules} m ON m.id = cm.module WHERE m.name = 'lti' AND cm.course = ?",
    [$course->id]) . "\n";
echo 'LTI_GRADE_ITEMS=' . $DB->count_records('grade_items', ['courseid' => $course->id, 'itemmodule' => 'lti']) . "\n";
echo 'LTI_GRADES=' . $DB->count_records_sql(
    "SELECT COUNT(*) FROM {grade_grades} gg JOIN {grade_items} gi ON gi.id = gg.itemid
      WHERE gi.courseid = ? AND gi.itemmodule = 'lti'", [$course->id]) . "\n";

// 2. The tool registration: Active, "Show in activity chooser", default launch container "New window".
$types = $DB->get_records_select('lti_types', "tooldomain = ? AND " . $DB->sql_like('baseurl', '?'),
    ['lab.lti.test', 'https://lab.lti.test/%']);
echo 'TOOLS=' . count($types) . "\n";
if (count($types) !== 1) {
    echo "ERROR=register the tool in Moodle first (docs/lti-demo.md, Register the tool in Moodle)\n";
    exit(2);
}
$type = reset($types);
$changed = [];
if ((int)$type->state !== LTI_TOOL_STATE_CONFIGURED) {
    $DB->set_field('lti_types', 'state', LTI_TOOL_STATE_CONFIGURED, ['id' => $type->id]);
    $changed[] = 'state';
}
if ((int)$type->coursevisible !== LTI_COURSEVISIBLE_ACTIVITYCHOOSER) {
    $DB->set_field('lti_types', 'coursevisible', LTI_COURSEVISIBLE_ACTIVITYCHOOSER, ['id' => $type->id]);
    $changed[] = 'coursevisible';
}
foreach (['coursevisible' => LTI_COURSEVISIBLE_ACTIVITYCHOOSER, 'launchcontainer' => LTI_LAUNCH_CONTAINER_WINDOW] as $name => $value) {
    $row = $DB->get_record('lti_types_config', ['typeid' => $type->id, 'name' => $name]);
    if (!$row) {
        $DB->insert_record('lti_types_config', (object)['typeid' => $type->id, 'name' => $name, 'value' => $value]);
        $changed[] = $name;
    } else if ((int)$row->value !== $value) {
        $DB->set_field('lti_types_config', 'value', $value, ['id' => $row->id]);
        $changed[] = $name;
    }
}
if ($changed) {
    purge_caches(); // the activity chooser is cached
}
echo 'TOOL_FIXED=' . ($changed ? implode(',', $changed) : 'none') . "\n";
$type = $DB->get_record('lti_types', ['id' => $type->id], '*', MUST_EXIST);
echo 'TOOL_NAME=' . $type->name . "\n";
echo 'TOOL_STATE=' . ($type->state == LTI_TOOL_STATE_CONFIGURED ? 'Active' : $type->state) . "\n";
echo 'TOOL_IN_CHOOSER=' . ($type->coursevisible == LTI_COURSEVISIBLE_ACTIVITYCHOOSER ? 'yes' : 'no') . "\n";
echo 'TOOL_LAUNCH=' . ($DB->get_field('lti_types_config', 'value', ['typeid' => $type->id, 'name' => 'launchcontainer']) == LTI_LAUNCH_CONTAINER_WINDOW ? 'new window' : 'other') . "\n";

// 3. Accounts: present, not suspended, with an active enrolment in LAB101.
$ready = [];
foreach (['teacher', 'student', 'student2'] as $name) {
    $u = $DB->get_record('user', ['username' => $name, 'deleted' => 0]);
    $ok = $u && !$u->suspended && $DB->record_exists_sql(
        "SELECT 1 FROM {user_enrolments} ue JOIN {enrol} e ON e.id = ue.enrolid
          WHERE e.courseid = ? AND ue.userid = ? AND ue.status = 0", [$course->id, $u->id]);
    if ($ok) { $ready[] = $name; }
}
echo 'USERS_ENROLLED=' . implode(',', $ready) . "\n";
