import { cp, mkdir, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'github-upload');
const entries = ['extension', 'dist', 'docs', 'scripts', 'tests', 'previews', '.github', '.gitignore', '.gitattributes',
  'README.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', 'playwright.config.mjs'];
await readFile(path.join(root, 'dist/vendor/pdf.worker.mjs'));
await mkdir(destination, { recursive: true });
for (const entry of entries) await cp(path.join(root, entry), path.join(destination, entry), { recursive: true });

// A concrete allowlist keeps old deliveries, credentials and browser profiles out.
const inspect = async directory => {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name === '.git') continue;
    if (item.isSymbolicLink() || /^(node_modules|test-results|playwright-report|release-assets|github-upload)$/.test(item.name) || /^\.env(?:\.|$)/.test(item.name)) {
      throw new Error(`Unexpected item in upload folder: ${path.relative(destination, path.join(directory, item.name))}`);
    }
    if (item.isDirectory()) await inspect(path.join(directory, item.name));
  }
};
await inspect(destination);
console.log(`GitHub 上传目录：${destination}`);
console.log('包含源码和可直接加载的 dist；保留已有 .git，不包含依赖和历史安装包。');
