// scripts/test/fixtures/trap-whole-read.mjs
//
// A preload (`node --import`) that makes any whole-file read of a *.gz path,
// or any whole-file gunzip, throw. Both the CommonJS builtin and the named ESM
// exports are patched and synchronised, so even a static `import { readFileSync }`
// in the loaded module sees the trap. Phase 5's point: the CLIs must reach the
// streaming verifier, which never calls either whole-file API.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { syncBuiltinESMExports } from 'node:module';

const realRead = fs.readFileSync;
const realGunzip = zlib.gunzipSync;

fs.readFileSync = (...args) => {
  if (String(args[0]).endsWith('.gz')) throw new Error('whole-file read attempted');
  return realRead(...args);
};
zlib.gunzipSync = () => { throw new Error('whole-file gunzip attempted'); };
syncBuiltinESMExports();
