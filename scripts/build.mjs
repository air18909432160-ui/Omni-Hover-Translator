import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const dest = path.join(root, 'dist');
await mkdir(dest, { recursive: true });
await cp(path.join(root, 'extension'), dest, { recursive: true });
const pdf = path.join(root, 'node_modules/pdfjs-dist');
await mkdir(path.join(dest, 'vendor'), { recursive: true });
for (const name of ['pdf.mjs', 'pdf.worker.mjs']) {
  await cp(path.join(pdf, 'build', name), path.join(dest, 'vendor', name));
}
for (const name of ['cmaps', 'standard_fonts', 'wasm']) {
  await cp(path.join(pdf, name), path.join(dest, 'vendor', name), { recursive: true });
}
await cp(path.join(pdf, 'web/pdf_viewer.css'), path.join(dest, 'vendor/pdf_viewer.css'));
await cp(path.join(pdf, 'LICENSE'), path.join(dest, 'vendor/PDFJS-LICENSE'));
const manifest = JSON.parse(await readFile(path.join(dest, 'manifest.json'), 'utf8'));
await writeFile(path.join(dest, 'BUILD.txt'), `${manifest.name} ${manifest.version}\nPDF.js assets bundled locally.\n`);
console.log(`Chrome → 加载已解压的扩展程序 → ${dest}`);
