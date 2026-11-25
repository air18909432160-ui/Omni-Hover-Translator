import { cp, mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { zipDirectory } from './archive.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const readJSON = async file => JSON.parse((await readFile(path.join(root, file), 'utf8')).replace(/^\uFEFF/, ''));
const manifest = await readJSON('dist/manifest.json');
const source = await readJSON('extension/manifest.json');
const pkg = await readJSON('package.json');
if (manifest.version !== source.version || source.version !== pkg.version) throw new Error('Version mismatch; build before packaging');
await readFile(path.join(root, 'dist/vendor/pdf.worker.mjs'));

const temporary = await mkdtemp(path.join(tmpdir(), 'oht-package-'));
try {
  const name = `Omni-Hover-Translator-${manifest.version}-Edge`;
  const staging = path.join(temporary, name);
  await mkdir(staging);
  await cp(path.join(root, 'dist'), staging, { recursive: true });
  await cp(path.join(root, 'docs/EDGE_INSTALL.md'), path.join(staging, '安装与使用说明.md'));
  await cp(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(staging, 'THIRD_PARTY_NOTICES.md'));
  const output = await zipDirectory(staging, path.join(root, 'release-assets', `${name}.zip`));
  const hash = createHash('sha256').update(await readFile(output)).digest('hex');
  await writeFile(output + '.sha256', `${hash}  ${path.basename(output)}\n`);
  console.log(`Edge 安装附件：${output}`);
  console.log('解压后选择直接包含 manifest.json 的文件夹。');
} finally {
  if (path.dirname(temporary) !== path.resolve(tmpdir()) || !path.basename(temporary).startsWith('oht-package-')) throw new Error('Unexpected temporary path');
  await rm(temporary, { recursive: true, force: true });
}
