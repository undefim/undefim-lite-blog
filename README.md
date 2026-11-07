# undefim 独立博客

基于 Astro、React、Fastify 和 SQLite 的独立博客，支持 Markdown / HTML 编辑、历史版本、草稿与发布分离、媒体管理、评论和备份。使用 Node.js 24 LTS，最低 24.22.1（版本文件见 `.node-version`）。

## 独立子站

主站后台“子站”可填写主站/子站地址并生成一次性接入码和部署命令。子站使用独立轻量镜像，文章范围、主题、顶部导航和备案信息由主站管理；程序更新由主站发起、子站从固定 GitHub 仓库构建。详见 [子站部署与安全边界](docs/REPLICA-SITES.md)。DNS、TLS、Docker 安装仍由部署者完成。

## Docker Compose 部署

仓库提供 `Dockerfile`、`Dockerfile.updater` 和 `compose.yaml`，可在支持 Docker Compose 的 Linux 服务器上运行。

```sh
git clone https://github.com/undefim/undefim-lite-blog.git /srv/blog
cd /srv/blog
cp .env.example .env
chmod 600 .env
```

按自己的站点填写 `.env`，HTTPS 部署示例：

```dotenv
SITE_URL=https://blog.example.com
ADMIN_ORIGIN=https://blog.example.com
COOKIE_SECURE=true
TRACKING_ENABLED=false
```

启动并检查服务：

```sh
APP_REVISION=$(git rev-parse HEAD) docker compose up -d --build
docker compose ps
docker compose logs --tail=100 blog
curl --fail http://127.0.0.1:4322/api/health
```

容器端口仅绑定宿主机 `127.0.0.1:4322`，通过自己的 Nginx 或其他反向代理提供 HTTPS。`deploy/` 中的配置需按实际域名、证书和目录调整，不应直接覆盖现有服务配置。

`./data` 挂载到 `/app/data`，保存数据库、媒体、备份和静态发布版本。首次启动自动创建管理员并构建初始站点；初始凭据保存在 `data/admin-access.txt`，登录后修改密码并删除该文件。已有数据时只重建已发布快照，不发布草稿。

更新源码后执行 `APP_REVISION=$(git rev-parse HEAD) docker compose up -d --build`，提交版本变化会自动重建已发布快照，成功后才启动 API；只改公开设置或没有设置有效 APP_REVISION 时，仍需在后台点击“发布站点”并等待成功。整站构建不会发布尚未发布的草稿。

## 后台 GitHub 更新

后台“系统更新”会自动对比 GitHub：启动后立即、之后每 10 分钟检查一次，也可点击“重新检查”。已是最新时显示“已是最新版”；有新版本时显示更新数量与内容并出现“立即更新”；无法自动更新（如部署目录有本地修改）时说明原因且不显示更新按钮。也可保存定时自动更新（每 1/6/12/24/168 小时）；默认仅手动。已自动预设开源仓库 [`undefim/undefim-lite-blog`](https://github.com/undefim/undefim-lite-blog) 的 `main` 分支，无需手动填写仓库地址；未启动执行器时也显示已配置来源。只使用规范仓库地址，部署端显式自定义来源仍生效。

**默认由同一 Docker Compose 一次安装 blog 与 updater 两个容器**：在专用普通克隆中设置 `.env` 后执行 `APP_REVISION=$(git rev-parse HEAD) docker compose up -d --build`。无需宿主机 Node/npm 或 systemd。只有 updater 访问 Docker socket，blog 不持有 Docker 控制权限；执行器离线时按钮禁用。已有 systemd 部署须先停用旧执行器，保留原项目名、生产环境与数据，详见 [部署、权限与迁移](docs/OPERATIONS.md#后台-github-更新)。执行器基础镜像/入口变化需维护者用同一 Compose 命令更新全部服务，普通脚本更新可随博客部署后重载。

更新先检查干净工作区与快进关系，隔离构建镜像，暂停写入并等待已有发布完成，再完整备份、重启并重建**已发布快照**。不会发布所有草稿。切换后异常会尝试恢复旧代码/镜像/静态入口，不恢复旧数据库；失败暂停自动更新，必须排查后手动恢复。自动更新仅用于已经验证且数据库向后兼容的可信分支，不能替代数据库升级设计。

## 本地开发

使用独立的数据目录，不在正式数据上运行开发写操作：

```sh
npm ci
DATA_DIR=./data-dev node scripts/create-admin.mjs
DATA_DIR=./data-dev npm run build
DATA_DIR=./data-dev COOKIE_SECURE=false npm start
```

打开 `http://127.0.0.1:4322`，后台位于 `/admin/`。仅本地 HTTP 开发使用 `COOKIE_SECURE=false`，正式 HTTPS 使用 `true`。热更新与代理配置见 [开发与运维](docs/OPERATIONS.md)。

如需从 Halo 导入，仅在全新隔离数据库中执行：

```sh
DATA_DIR=./data-dev node scripts/import-halo.mjs /absolute/path/to/halo-backup.zip
```

已有正式数据时禁止重复导入。原始备份、数据库、环境文件和初始凭据不能提交或放到公开目录。

## 写作与发布

后台支持 Markdown / HTML、预览、分类标签、封面、置顶、私密内容、历史版本与回收站。上传 `.md` 默认创建草稿，ZIP 可包含多篇文章及相对图片，路径冲突会报错。Front Matter 示例：

```markdown
---
title: 示例文章
slug: example-post
date: 2026-10-02
categories: [技术]
tags: [示例]
description: 可选摘要
cover: /upload/example.png
---

# 正文

示例内容。
```

编辑文章时，在“文章信息”下的“许可协议”区域可选择常用协议、编辑名称/链接/转载说明，或关闭整块版权区域；保存草稿后发布该篇内容才会更新前台。旧文章默认保持 CC BY 4.0。Markdown Front Matter 支持 `copyrightEnabled`、`licenseName`、`licenseUrl`、`licenseNote`。

`permalink` 可指定站内路径。支持代码块、表格、任务列表、脚注和公式。检查预览后显式发布；可在站点设置中开启导入后自动发布。

保存不等于发布。构建成功后原子切换静态版本，失败保留旧版，构建期间保存的新草稿不会被覆盖。私密正文不进入公开站点，但上传媒体目前是公开资源。

私密文章/页面的编辑页主按钮显示“保存”，仅保存后台内容；公开内容显示“发布”。已有公开版本改为私密后，点击“保存”自动提交取消发布任务；任务成功后从前台下线，失败需在发布记录中查看原因并重试。

## 缓存与备份

后台与 API 使用 `no-store`；公开 HTML 提供 CDN 缓存响应头，哈希资源和唯一媒体地址支持长期缓存。是否启用边缘缓存取决于自己的 CDN 配置。Cloudflare 缓存刷新凭据只通过受保护的环境变量设置。

后台支持内容导出和完整备份。命令行可运行：

```sh
docker compose exec blog npm run backup
docker compose exec blog npm run backup:verify
```

完整备份含私密内容、评论邮箱、账户哈希和会话，必须私下保存。恢复应使用全新数据目录，保留恢复前的数据用于回退。完整步骤见 [开发与运维](docs/OPERATIONS.md)。

## 验证与维护

```sh
npm test
npm run check
DATA_DIR=./data-dev npm run build
```

技术架构、API 和维护要求见 [开发文档索引](docs/README.md)、[AGENTS.md](AGENTS.md) 及 [维护记录](docs/CHANGELOG.md)。公开文档仅描述源码和通用操作，不记录实际服务器、账号、证书、备份位置或生产内容统计。迁移与生产验收记录仅保留在私有环境。
