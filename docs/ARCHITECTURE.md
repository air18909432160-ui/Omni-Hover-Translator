# 架构与实现

## 2. Manifest 与 PDF 重定向

`manifest.json` 将共享脚本与 `web-injector.js` 顺序注入普通 HTTP(S) 页面，并声明模块式 Service Worker、选项页、DNR 和存储权限。

`background.js` 在安装、浏览器启动与配置变化时注册 / 移除动态 DNR 规则：

```js
{
  id: 1001,
  priority: 1,
  action: {
    type: 'redirect',
    redirect: {
      regexSubstitution: `${chrome.runtime.getURL('pdf-viewer.html')}#url=\\0`
    }
  },
  condition: {
    regexFilter: '^https?://[^?#]+\\.pdf(\\?[^#]*)?$',
    isUrlFilterCaseSensitive: false,
    resourceTypes: ['main_frame'],
    requestMethods: ['get']
  }
}
```

只匹配 GET 主页面，PDF.js 后续子资源请求不会再次重定向。原始 URL 放入 fragment，保留 `?sig=a%2Bb&expires=42` 这类签名参数，阅读器按原始字符串读取，不把它误拆成自身查询参数。

PDF 原始 `#page=...` 等片段不属于网络请求，DNR 不保留这类跳页指令。没有 `.pdf` 后缀、POST 下载、iframe / embed 不自动截获，可使用右键或手动打开。Chrome 自带 PDF 页面无法注入本扩展，翻译发生在内置 PDF.js 阅读页中。

## 3. 共享核心 TranslatorCore

数据流：视图事件 → `captureAtPoint` → `{ root, text, start, end, range }` → `core.hover(candidate)` → 按设置防抖 → 高亮与浮窗 → Service Worker → 所选翻译服务 → 浮窗。

`text-utils.js` 使用 `Intl.Segmenter('en', { granularity: 'sentence' })`，修正常见称谓缩写。分句前将软换行按一对一方式替换为空格，防止 ICU 把普通换行当成句号，并保留原始 UTF-16 偏移；段落边界使用独立标记。随后将跨行、跨 `<strong>` / `<em>` 等文本节点的句子映射回一个 DOM `Range`。浮窗与 API 使用合并空白后的文本，PDF 英文行末断词采用启发式连接。不支持 Segmenter 时提供标点分句回退。

`TranslatorCore.js` 使用 CSS Custom Highlight API，只为当前句子的 Range 注册淡黄色高亮，不包裹或拆分原文节点，不改变文档布局。另备有浮层矩形回退。浮窗使用 Shadow DOM、`textContent` 和独立样式，内容不作为 HTML 注入。

同一句子内移动不重复计时或请求；离开时保留可配置的跨浮窗间隙（默认 250ms），进入浮窗可操作按钮。移出、滚动、缩放、失焦或按 Escape 后清除浮窗、高亮和当前朗读。固定气泡可防止移出关闭。Port 断开后，后台用 `AbortController` 取消网络请求，避免过期响应覆盖新句子。

`translation-service.js` 使用固定的 DeepL Free / Pro 端点，或用户配置的 LibreTranslate 端点，按设置传递源 / 目标语言。DeepL 自动检测时省略 `source_lang`。后台提供 20 秒超时、最多 4 个并发请求、最多 200 条可关闭的内存缓存；缓存键包含服务、端点与语言，配置变化清空缓存。处理缺失 Key、无效 Key、频率限制、额度用尽和网络错误。重试由重新悬停触发，避免后台自动重试消耗额度。

`shared/settings.js` 定义统一默认值和校验规则；后台通过 `oht-settings` Port 只发送不含认证 Key 的偏好，保存时推送更新。MV3 后台休眠使 Port 断开后，在页面重新可见或下一次交互时重连获取最新偏好，不使用轮询保持后台常驻。

Key 保存在本机 `chrome.storage.local`，不加密、不云同步；`setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})` 限制内容脚本直接读取。网页只发送当前句子，后台添加认证头；Key 不放入网页、URL 或浮窗。HTTP(S) 全站权限用于页面注入、PDF 跨域读取和 DNR 重定向。

## 4. 普通网页适配器

`web-injector.js` 同时监听 `mouseover` 和 `mousemove`：前者响应进入节点，后者识别同一个文本节点内跨句移动。使用 `requestAnimationFrame` 合并事件，再通过 `caretPositionFromPoint` / `caretRangeFromPoint` 与字符矩形核验真实文字命中，避免悬停段落空白区域时误触发。

获取最近块级段落后，调用 `OmniHover.text.captureAtPoint(event)`，再交给 `core.hover()`。代码区、表单、编辑区域与扩展浮窗会被跳过。

## 5. PDF 阅读器与 TextLayer

`pdf-viewer.html` 加载 PDF.js 自带的 `pdf_viewer.css` 与阅读器样式，再加载共享核心和模块阅读器。每个页面容器同时持有一个 Canvas 和一个 `.textLayer`，两者使用同一个 viewport：

```js
pdfjsLib.GlobalWorkerOptions.workerSrc =
  chrome.runtime.getURL('vendor/pdf.worker.mjs');

const viewport = page.getViewport({ scale: zoom });
await page.render({ canvasContext, viewport }).promise;

const textLayer = new pdfjsLib.TextLayer({
  textContentSource: page.streamTextContent(),
  container: textLayerElement,
  viewport
});
await textLayer.render();
```

实际代码还设置页面的 `--scale-factor`、`--user-unit` 与 TextLayer 所需的 CSS 变量，并按设备像素比渲染 Canvas，限制单页画布最多约 1600 万像素。**Canvas 展示页面，TextLayer 提供透明可选文字与准确坐标，二者都必须渲染。**

阅读器在 `mouseover` / `mousemove` 时找到最近的 `.textLayer`，调用：

```js
const candidate = OmniHover.text.captureAtPoint(event, {
  boundary: textLayerElement,
  pdf: true
});
core.hover(candidate);
```

PDF 文本节点按提取顺序组成文本，并根据相邻字形坐标推断行间或词间空白，避免把 PDF 跨 span 的单词一律拆开。连续文本行视为软换行，较大的垂直间隔或向右跨栏视为段落边界。后续分句、Range、高亮、翻译与 UI 全部复用共享核心。

阅读功能包括连续滚动、50%–300% 缩放、当前页检测、上一页 / 下一页、页码输入、嵌套目录与目录目标跳转、密码 PDF 输入。本地文件直接转为字节交给 PDF.js，无需开启 Chrome 的本地文件访问权限。

可视区前后 800px 范围内按队列渲染，远处页面保留占位容器并释放画布与 TextLayer；缩放时取消旧任务并重新布局。异步任务使用版本标识，防止旧文档或旧缩放的结果写回新页面。

### 已知边界

- 扫描图片没有 TextLayer 文本，需要额外 OCR，本版未实现 OCR。
- PDF 的双栏、乱序字形、断词连字符、公式和复杂排版依赖文档的文字提取顺序，可能需要额外版面重建。本版将每页 TextLayer 作为捕获范围，句子不会跨页连接。
- 原始文档的书签目标在本版定位到对应页面，不恢复精确的页内坐标；不包含批注编辑、表单填写和 PDF 搜索。
- 登录态、Cookie 策略、防盗链、需要 POST 的下载或过期签名可能使远程读取失败；可下载后打开本地文件。PDF.js 默认禁用动态 eval，不执行 PDF 内嵌脚本。
- Chrome 内部页、扩展商店以及原生 PDF 阅读器不允许普通内容脚本注入；本版不穿透网页自身的封闭 Shadow DOM。
- 超过 2500 字符的单句和超过 60000 字符的捕获块跳过，避免异常文本造成长任务。
- TTS 使用浏览器 / 系统语音，各语言声音可用性取决于系统；复制使用 Clipboard API。

### 验证

`npm.cmd test`：9 组单元测试，验证多语言分句与偏移、软换行 / 断词 / 段落边界、请求编码、错误与取消、DNR 签名参数、设置校验 / Key 隔离、自动语言 / 目标语言以及 LibreTranslate 的请求与地址限制。

`npm.cmd run test:browser`：24 组真实浏览器测试，实际加载打包后的 Manifest V3 扩展。除网页 / PDF 跨行、高亮、复制、朗读、DNR、目录、缩放、本地文件外，覆盖设置页自动保存与重新打开后的持久化、多设置页防覆盖、无效输入不阻塞其他设置、后台 Worker 实际停止后恢复同步、自定义延迟 / 不透明度 / 字号 / 宽度、语言与请求参数、Key 不公开、修饰键、固定气泡、暂停 / 排除网站、划词 / 段落模式、中文 / 日文悬停、PDF 偏好实时更新、快捷面板、按语言隔离缓存、LibreTranslate、本地历史及恢复默认。翻译网络响应在测试中模拟，没有使用真实 API Key，也未产生翻译费用。真实服务连接需要用户配置后点击“保存并测试连接”。

PDF.js 的许可证随构建输出置于 `dist/vendor/PDFJS-LICENSE`。
