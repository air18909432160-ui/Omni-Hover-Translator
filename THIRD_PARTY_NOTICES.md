# 第三方组件说明

PDF 阅读器使用 `pdfjs-dist` 6.5.438（Mozilla PDF.js），由 `package-lock.json` 固定版本。构建时从已安装依赖复制到 `dist/vendor`，运行时使用本地脚本和 Worker，不从 CDN 加载远程代码。

- PDF.js 主许可证：`dist/vendor/PDFJS-LICENSE`（Apache License 2.0）。
- CMap 资源：`dist/vendor/cmaps/LICENSE`。
- 标准字体：`dist/vendor/standard_fonts/LICENSE_FOXIT` 和 `LICENSE_LIBERATION`。
- WASM 及相关组件：`dist/vendor/wasm` 目录内的各 `LICENSE*` 文件。

安装包和 GitHub 目录保留上述资源及其许可证。仓库中的路径以 `dist/vendor` 开头，专用安装 ZIP 解压后对应 `vendor` 目录。组件出处：https://github.com/mozilla/pdf.js 。开发测试使用 Playwright，其版本记录在 lockfile，测试工具不打进扩展安装包。
