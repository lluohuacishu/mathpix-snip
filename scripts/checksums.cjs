const { createReadStream } = require('node:fs');
const { writeFile } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { version } = require('../package.json');
const directory = path.join(__dirname, '..', 'dist');
const files = [`Math-Snip-Setup-${version}-x64.exe`, `Math-Snip-${version}-x64.zip`];

async function run() {
  const lines = [];
  for (const file of files) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path.join(directory, file))) hash.update(chunk);
    lines.push(hash.digest('hex') + '  ' + file);
  }
  await writeFile(path.join(directory, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
  console.log('Created SHA256SUMS.txt for ' + files.length + ' release files.');
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
