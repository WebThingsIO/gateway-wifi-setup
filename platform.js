/*
 * # Raspberry Pi (we'll treat this as the default)
 * pi@gateway:~ $ uname -a
 * Linux gateway 4.4.13-v7+ #894 SMP Mon Jun 13 13:13:27 BST 2016 armv7l GNU/Linux
 *
 */

var uname =
    require('child_process').execFileSync('uname', ['-a'], { encoding:'utf8' })

var platform = require('./platforms/default.js');

module.exports = platform;
