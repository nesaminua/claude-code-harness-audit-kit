'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ensureDir } = require('./paths');

const PRIVATE_MODE = 0o600;

// Writes through a tmp file and renames onto the resolved path, so a symlink stays a symlink.
// Without `mode`, an existing file keeps its mode and a new one is created user-only. The mode is
// set again with chmod because the umask can strip bits from the one given at creation.
function writeFileAtomic(file, data, { mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const exists = fs.existsSync(file);
  const target = exists ? fs.realpathSync(file) : file;
  const finalMode = mode ?? (exists ? fs.statSync(target).mode & 0o777 : PRIVATE_MODE);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data, { mode: finalMode });
  fs.chmodSync(tmp, finalMode);
  fs.renameSync(tmp, target);
}

// The kit's own data files are user-only whatever mode an older version left them in.
const writePrivate = (file, data) => {
  ensureDir(path.dirname(file));
  writeFileAtomic(file, data, { mode: PRIVATE_MODE });
};

module.exports = { PRIVATE_MODE, writeFileAtomic, writePrivate };
