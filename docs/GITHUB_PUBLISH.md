# 将此项目上传到 GitHub

已经整理的上传目录是项目中的 `github-upload`。请上传它里面的内容；根目录应直接显示 README.md、extension、dist 和 docs。用户下载仓库 ZIP 后可以直接在 Edge 加载 `dist`。

## 推荐：GitHub Desktop 上传

1. 安装并打开 https://desktop.github.com/ ，选择 Sign in to GitHub，在浏览器登录自己的账号后完成授权。
2. GitHub Desktop → File → Add local repository → Choose，选择本项目的 `github-upload` 文件夹。
3. 若提示“不是 Git 仓库”，点击提示里的 **create a repository here**。本次整理的目录已初始化为本地仓库，正常可直接添加。
4. 左下角 Summary 填 `Initial release 1.3.1`，点击 **Commit to main**。首次提交若要求姓名和邮箱，使用自己的 GitHub 提交身份，可在 GitHub 邮箱设置中找到 noreply 邮箱。
5. 点击顶部 **Publish repository**。Name 改为 `Omni-Hover-Translator`；希望别人能公开下载，就取消 **Keep this code private**。确认账号和可见性后点击 Publish repository。
6. 点击 **View on GitHub**，检查仓库首页能显示中文安装说明，且根目录有 `dist/manifest.json` 和 `dist/vendor/pdf.worker.mjs`。

上传时无需分享账号密码或 Token。个人 API Key 存在浏览器扩展存储里，不需要放到仓库或安装包。

## 给别人提供直接下载的安装包

1. 在仓库页右侧 Releases → **Create a new release**。
2. Tag 选 `v1.3.1`，目标分支选 `main`；标题填 `Omni Hover Translator 1.3.1`。
3. 复制 `docs/RELEASE_v1.3.1.md` 的内容到正文。
4. 在附件区上传 `release-assets/Omni-Hover-Translator-1.3.1-Edge.zip` 和对应 `.zip.sha256` 文件。
5. 点击 **Publish release**。把仓库地址或 Releases 页面地址发给别人。

GitHub 自动生成的 Source code ZIP 不能替代专用安装附件；两种 ZIP 的安装路径在 README 中都有说明。

## 不装 Desktop：浏览器上传

打开 https://github.com/new ，仓库名填 `Omni-Hover-Translator`，选择 Public，创建仓库。进入仓库的“uploading an existing file”或 Add file → Upload files。

将 `github-upload` **里面的文件和文件夹**拖进上传区，不要把整个目录额外套在仓库根目录下面，也不要只上传一个 ZIP；GitHub 不会替你解压。确认包含 README.md、dist、extension、docs、scripts、tests、package.json、package-lock.json、.gitignore、.gitattributes、.github 后提交。

由于 PDF.js 资源文件很多，浏览器批量上传有数量限制，失败时应使用 GitHub Desktop。拖动目录通常比“选择文件”更能保留目录；隐藏文件和 `.github` 也要确认已上传。Release 附件则直接上传 ZIP，无需解压。

## 后续更新

开发目录修改源码后运行：

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run package
npm.cmd run prepare:github
```

打开 GitHub Desktop，查看 `github-upload` 的变更，Commit 后 Push origin。`prepare:github` 保留已有 `.git` 目录和提交记录。同步时如主动删除了源码文件，也应检查上传目录并删除对应旧文件。

仓库包含 CI 和自动 Release 工作流。后续发布新版本时同时更新 manifest.json、package.json、lockfile 和版本说明；推送匹配的 `v版本号` 标签会测试并自动发布附件。第一次可以按上面步骤手动发布；不需要另外配置翻译 Key 或 GitHub Token，工作流使用仓库提供的 GITHUB_TOKEN。

本项目尚未选择项目自身的开源许可证；公开仓库不等于授予任意复用授权。维护者确定授权方式后可再增加 LICENSE。PDF.js 的第三方许可证已随包保留。
