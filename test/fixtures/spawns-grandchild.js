#!/usr/bin/env node
/**
 * A stand-in for an agent that starts other processes - a compiler, a language server, a search - and
 * then hangs. The grandchild's pid is written to the marker file so the test can check it was cleaned
 * up along with its parent.
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const markerFile = process.argv[2];

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
});

writeFileSync(markerFile, String(grandchild.pid));
console.error(`spawned grandchild ${grandchild.pid}`);

setInterval(() => console.error('still working'), 250);
