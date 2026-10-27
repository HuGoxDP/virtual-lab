<?php
// Seeds the demo Moodle: one course, a teacher and a student, and the settings that let Moodle
// reach the platform. Idempotent. Bitnami runs *.php from /docker-entrypoint-init.d once, after
// the first install and before Apache starts; it can also be re-run by hand:
//   docker compose exec moodle php /docker-entrypoint-init.d/10-seed.php
define('CLI_SCRIPT', true);
foreach (['/bitnami/moodle/config.php', '/opt/bitnami/moodle/config.php'] as $c) {
    if (is_readable($c)) { require $c; break; }
}
global $CFG, $DB;
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/user/lib.php');
require_once($CFG->libdir . '/enrollib.php');

// Moodle refuses to curl private addresses by default, and every container on a docker network is
// one. The platform is reached by host name over the docker network, so lift the block (this is a
// demo stand; do NOT do this on a production Moodle).
$CFG->noemailever = true; // no MTA in the container; skip welcome mails
set_config('curlsecurityblockedhosts', '');
set_config('curlsecurityallowedport', "443\n80");

$teacherpass = getenv('DEMO_TEACHER_PASSWORD') ?: 'Teacher#2026lti';
$studentpass = getenv('DEMO_STUDENT_PASSWORD') ?: 'Student#2026lti';
$people = [
    ['teacher', 'Olena', 'Teacher', 'editingteacher', $teacherpass],
    ['student', 'Ivan', 'Student', 'student', $studentpass],
    ['student2', 'Maria', 'Student', 'student', $studentpass],
];

$course = $DB->get_record('course', ['shortname' => 'LAB101']);
if (!$course) {
    $course = create_course((object)[
        'fullname' => 'Virtual Lab demo course', 'shortname' => 'LAB101', 'category' => 1,
        'summary' => 'Course used to demonstrate the LTI 1.3 virtual-lab tool.',
        'format' => 'topics', 'visible' => 1,
    ]);
    echo "course LAB101 created (id {$course->id})\n";
}

$manual = enrol_get_plugin('manual');
$instance = $DB->get_record('enrol', ['courseid' => $course->id, 'enrol' => 'manual'], '*', MUST_EXIST);

foreach ($people as [$name, $first, $last, $role, $pass]) {
    $user = $DB->get_record('user', ['username' => $name, 'mnethostid' => $CFG->mnet_localhost_id]);
    if (!$user) {
        $id = user_create_user((object)[
            'username' => $name, 'password' => $pass, 'firstname' => $first, 'lastname' => $last,
            'email' => "$name@lti.test", 'auth' => 'manual', 'confirmed' => 1,
            'mnethostid' => $CFG->mnet_localhost_id, 'lang' => 'en',
        ]);
        $user = $DB->get_record('user', ['id' => $id], '*', MUST_EXIST);
        echo "user $name created\n";
    }
    $roleid = $DB->get_field('role', 'id', ['shortname' => $role], MUST_EXIST);
    $manual->enrol_user($instance, $user->id, $roleid);
}
// This script runs as root, so the caches it just wrote are root-owned; Apache/PHP-FPM run as
// `daemon` and Moodle's upgrade check dies on them at the next container start.
if (function_exists('posix_geteuid') && posix_geteuid() === 0) {
    passthru('chown -R daemon:daemon ' . escapeshellarg($CFG->dataroot));
}
echo "seed done\n";
