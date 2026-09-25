const {readFileSync,existsSync}=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const asar=require('@electron/asar');
const root=path.dirname(__dirname),directory=path.resolve(process.argv[2]||path.join(root,'dist','win-unpacked'));
const archive=path.join(directory,'resources','app.asar');
assert.ok(existsSync(archive),'Build the Windows package first.');
const files=asar.listPackage(archive).map(p=>p.replaceAll('\\','/').replace(/^\//,''));
const allowed=/^(?:node_modules(?:\/|$)|desktop(?:\/|$)|lib(?:\/|$)|public(?:\/|$)|assets(?:\/|$)|server\.js$|package\.json$)/;
for(const file of files){
 assert.ok(allowed.test(file),'Unexpected package path: '+file);
 assert.ok(!/(?:^|\/)(?:\.env(?:\.|$)|credentials\.(?:dpapi|safe)$)|^public\/sample\.png$|^assets\/reference\.docx$|\.map$/i.test(file),'Private or unwanted file: '+file);
}
const ownFiles=files.filter(f=>!f.startsWith('node_modules/'));
for(const expected of ['server.js','public/app.js','public/index.html','public/sample.svg','public/mask-editor.js','public/mask-editor.css','desktop/main.cjs','lib/credentials.js'])assert.ok(ownFiles.includes(expected),'Missing: '+expected);
for(const f of ownFiles){if(!/\.(?:js|cjs|json|html|css|svg)$/.test(f))continue;const s=asar.extractFile(archive,f).toString('utf8');assert.ok(!/[A-Z]:\\+Users\\+/i.test(s),'Private machine information: '+f);}
const pkg=JSON.parse(asar.extractFile(archive,'package.json').toString());
console.log(JSON.stringify({result:'PASS',version:pkg.version,applicationEntries:ownFiles.length,archiveEntries:files.length,checks:['application allowlist','no runtime data or credentials','no private reference material','built frontend present']}));
