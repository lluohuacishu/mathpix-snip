import { build } from 'esbuild';
await build({ entryPoints: ['src/app.js'], bundle: true, minify: true, outfile: 'public/app.js', target: ['chrome120', 'edge120'], sourcemap: true });
console.log('Frontend built.');
