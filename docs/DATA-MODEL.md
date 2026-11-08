# 数据模型、内容状态与发布

核对日期：2026-10-02。权威实现：[db.mjs](../server/db.mjs)、[publish.mjs](../server/publish.mjs)、[uploads.mjs](../server/uploads.mjs)。

## 存储布局

```text
data/                         DATA_DIR，可配置；不是网站公开根目录
  blog.sqlite                 SQLite 主库，运行中还会有 WAL/SHM
  media/upload/...            通过 /upload/... 公开访问
  releases/<job-id>/
    content.json              本次公开内容和设置快照
    redirects.json            本次生成的旧路径跳转
    site/                     Astro 产物
  current -> releases/...     当前版本链接，实际目标可能是绝对路径
  backups/*.zip               私有备份
  admin-access.txt            首次管理员凭据，非公开
  application-revision        成功完成初始化静态构建的镜像提交标记
  system-update/              私有更新控制目录，不进入公开快照/内容导出
    config.json               manual/auto 与 intervalHours，缺省 manual/24
    request.json              唯一待处理/运行中请求，完成后移除
    check-request.json        可覆盖的只读重新检查请求，执行器检查后移除
    status.json               执行器心跳、来源、版本检查结果、最近任务/阶段/回退结果
```

`dist/admin` 是后台构建产物；`dist/site` 是本地构建或没有 current 时的回退目录。不要直接编辑产物，它们会被重建覆盖。移动运行目录或容器挂载路径后应检查 `current` 链接是否仍有效。

系统更新文件独立于 SQLite，现有库无需升级；缺失文件按 manual/24、无任务处理。内置 `undefim/undefim-lite-blog`/main 来源由共享纯代码模块提供，状态接口无执行器时也返回默认 source；不新增持久化字段，不将仓库信息写入公开 settings。配置使用原子 rename，请求通过临时文件 + 不覆盖的硬链接发布，同一时刻仅一个请求；Git 元数据中的 Linux flock 内核锁和单执行器串行执行，状态文件记录维护写屏障，心跳仅判断执行器在线，失联不自动解除屏障。完整备份只含原有数据库/媒体，不含更新文件与部署 Compose/.env 配置；恢复后默认手动，需单独审核恢复执行器设置。更新不改正文、私密/回收站状态、历史版本或 published_data；镜像 APP_REVISION 改变时 initialize 重新构建已发布快照，成功后才写 application-revision。回滚代码/镜像不恢复旧数据库，不适用于未经设计的不兼容 schema 变更。

## 表结构

| 表 | 字段 | 关系和用途 |
| --- | --- | --- |
| documents | id PK, kind, path UNIQUE, data, published_data nullable, deleted_at, updated_at | data/published_data 为 JSON 文本；当前草稿与已发布快照分离 |
| revisions | id PK, document_id FK, data, created_at, reason | 保存修改前的草稿；索引 document_id/created_at |
| settings | key PK, value | JSON 值，与 defaultSettings 合并 |
| comments | id PK, document_id FK, parent_id, author, email, content, status, created_at | pending/approved/hidden；parent_id 没有外键；索引 document_id/status |
| stats | document_id PK/FK, visits, likes | 动态计数；新文档自动建立 |
| media | id PK, name, path UNIQUE, type, size, sha256, created_at | 文件元信息，实际字节在 media 目录 |
| users | name PK, password_hash | scrypt 盐与哈希，不保存明文密码 |
| sessions | token_hash PK, username, expires_at, csrf | expires_at 为毫秒时间戳；只保存 Token SHA-256 |
| jobs | id PK, status, created_at, finished_at, log, urls | queued/running/success/failed；urls 是 JSON 字符串 |
| comment_sources | id PK, data | Halo 原评论来源 JSON |
| redirects | path PK, target | 历史发布路径映射 |
| visit_events | id INTEGER PK, site_id（主站为空字符串，子站为其 ID）, visitor, path, source_type, source, created_at（毫秒）, country（v2，两位国家代码，未知为空字符串） | 访客统计明细；索引 site_id/created_at 与 created_at；保留 120 天，写入时每小时最多清理一次 |
| analytics_schema_migrations | version PK, applied_at | 访客统计迁移账本，当前版本 2 |

日期通常为 ISO 字符串，前台日期显示使用 Asia/Shanghai。WAL 和外键在连接初始化时启用。原始博客表没有 schema_version（子站与访客统计各有独立迁移账本，见下文），`CREATE TABLE IF NOT EXISTS` 不会升级旧表。新增列/约束时要设计幂等迁移、旧数据转换、备份和兼容回退。

## 文档 JSON 和状态

正文始终存于 `markdown` 字段，`format=html` 时它实际是 HTML 原文。其他字段包括 kind、title、path、date、modifiedAt、categories、tags、excerpt、cover、pinned、allowComment、visibility、author、copyrightEnabled、licenseName、licenseUrl、licenseNote。迁移来源还可能带 `source`、slug 等元数据；API 标准字段见 [API](API.md)。响应另加 id、published、deletedAt、updatedAt。

- `data`：编辑器的最新草稿。
- `published_data`：最后一次成功发布捕获的内容；有值时响应 `published=true`。这个布尔值不等于“最新草稿已经发布”，也不保证当前 URL 一定可见。
- `current/content.json` + `current/site`：此刻正在提供访问的版本；公开评论、计数入口也以 activeContent 为准。
- `deleted_at`：回收站标记，保留正文和版本。没有永久删除接口。

| 操作 | 数据库影响 | 上线时机 |
| --- | --- | --- |
| 新建/保存 | 写 data，修改时保存旧 data 为 revision；保留 published_data；PUT 保存 private 且已有公开快照时自动排队撤回 | 新正文不自动上线；撤回成功后下线 |
| 发布文章 | 捕获提交时草稿，排队 | 构建成功后更新 published_data 和 current |
| 撤回 | 入队 null 发布快照 | 构建成功后撤下 |
| 移入回收站 | 立即写 deleted_at，并排队撤回 | 旧静态页直到成功构建才消失；失败要重试 |
| 恢复回收站 | 清除 deleted_at | 不触发构建，也不会显式清空 published_data；正常完成撤回后是未发布状态 |
| 恢复历史版本 | 写为草稿、保留当前 path，并保存覆盖前草稿版本 | 仍需显式发布 |
| 改设置/分类 | 写设置；同 ID 分类改名同步 draft/published_data 内名称 | 静态页面需再次构建 |
| 整站构建 | 用已有 published_data 和当前设置构建 | 不会发布所有未发布草稿 |

通过 PUT 将已发布文章设为 private 并保存，会自动提交 null 快照撤回任务，响应 unpublishJob。私密正文仅写入后台 data，构建快照移除该篇而不公开新正文。任务成功后清空 published_data 并切换 current；失败保留原公开版本，重新保存私密内容或手动取消发布可重试。需等任务成功并确认页面/搜索/RSS 已消失；缓存开启时还需处理旧缓存。新建私密内容及没有公开快照的私密保存不触发构建，恢复历史版本仍仅恢复草稿。

备案设置 `icpRecord`、`publicSecurityRecord` 为 `settings` 表中的 JSON 字符串，默认均为空。旧库读取时合并空值，旧公开快照缺少字段时也不显示备案区域；无需 SQL 结构升级。保存后纳入下一次公开构建快照、内容导出 settings.json 与完整数据库备份，不改变文章、历史版本或当前静态版本。验证可读取设置并在隔离构建中检查页脚；回退可清空字段再发布，或恢复旧代码重新构建，旧代码忽略多出的设置键，无需回滚数据库。

文章分类标签存名称数组，设置项带稳定 ID/name/slug。改名通过设置 API 按 ID 同步正文模型，历史 revisions 不重写。删除分类设置不等于删除所有文章内引用；修改 slug 也不会自动创建分类路径重定向。保存文章时缺失的分类/标签会自动补入设置。

## 许可协议与兼容

编辑页“文章信息”下的“许可协议”支持常用协议、自定义名称/链接/转载说明及版权区域开关。默认值与常用预设在 `server/license.mjs`，前台显示在 `src/components/Copyright.astro`。旧 JSON 无字段时按原 CC BY 4.0 显示，不批量改写数据库；无需 SQL 表迁移。更新后这些字段进入草稿、历史版本、发布快照和内容导出。恢复没有许可字段的历史版本时使用旧默认值。保存仅影响草稿，发布成功才更新公开声明。

## 发布算法与一致性边界

1. enqueueBuild 深拷贝待发布草稿，创建 queued 任务；单进程 Promise 链串行执行。
2. 任务开始时读取 publicExport 的公开快照与设置，应用本次捕获内容或撤回操作；检查路径冲突。
3. 创建 release，写 content.json，通过 CONTENT_SNAPSHOT/BUILD_DIR 调用 Astro；最长 5 分钟，保留末尾 80000 字符日志。
4. 检查首页产物，拷贝旧版本的哈希资源以兼容仍被缓存的 HTML，生成旧路径 HTML 跳转页。
5. 在 SQLite 事务中更新 published_data/redirects，rename 临时符号链接为 current，提交；常规异常尝试回滚数据库与链接。
6. 标记 success；如配置 Cloudflare，则请求区域级 purge_everything。清除失败仅追加警告，源站发布仍成功。

正常构建失败保留旧版本，发布过程中继续保存的草稿不会被捕获的旧版本覆盖。进程重启会把 queued/running 任务标为 failed，不会自动续跑。

`rename` 的链接替换是原子的，但 SQLite 与文件系统不是同一个事务；断电/强制退出的极短窗口可能留下状态不一致。恢复时对照 current 快照、数据库 published_data、jobs 和目录，不可声称完全崩溃原子性。当前没有分布式锁，不能运行多个写实例或边运行边执行另一个初始化发布进程。

旧文章路径跳转是 HTTP 200 HTML meta refresh + canonical，不是 HTTP 301。HTTP 到 HTTPS 的跳转则由 Nginx 返回 308。旧资源和 release 暂无自动回收策略。

## Markdown 导入与媒体

Markdown 公式由 KaTeX 在 trust=false 下输出原生 MathML，再经相同 HTML 清洗器处理。保留明确列出的数学标签与排版属性，不允许事件、链接属性或任意 CSS/SVG；避免 HTML 公式依赖的定位样式被清洗后造成上标、分数和根号错位。块级公式保留 `.katex-display` 容器滚动，预览与静态正文使用同一渲染器；显示依赖浏览器原生 MathML 支持。

Front Matter 仅接受数据格式：默认 YAML，或显式 `---yaml` / `---yml` / `---json`，均须以独立的 `---` 行结束。YAML 使用 1.1 解析，保留历史日期、布尔值、合并键、数组和许可字段；支持 BOM 与 CRLF，正文不作换行转换。元数据须为字段对象；拒绝 JavaScript/其他语言、未知 YAML 标签、未闭合块和过量别名展开（maxAliasCount=100）。移除 gray-matter 及其旧 js-yaml/argparse/sprintf-js 依赖链；已有数据库正文和历史版本不批量改写。

Front Matter 支持 title、slug/permalink、date、categories/category、tags、description/excerpt、cover、pinned、comments、author、copyrightEnabled、licenseName、licenseUrl、licenseNote。标题依次回退首个 H1、文件名；slug 做 NFKC 规范化，默认路径 `/archives/<slug>`。日期转 ISO。每篇导入为 post；接口强制 visibility=public，默认作为草稿，设置 importAutoPublish=true 才排队发布。

```markdown
---
title: 示例文章
slug: example-post
date: 2026-10-02T10:00:00+08:00
categories: [技术]
tags: [Linux]
comments: true
---

# 正文

![示例](images/example.png)
```

ZIP 中 MD 与 images 目录一起上传，内联 Markdown 相对图片/链接会重写为唯一 `/upload/...` 地址。当前不完整支持引用式链接、HTML src 和 Front Matter cover 的相对资源改写；找不到的映射保留原引用。上传前应检查预览。Front Matter 中 `visibility` 或 `deleted` 不会复原私密/回收站状态，不能把内容导出 ZIP 当作无损恢复备份。

单 MD 最多 5MiB；ZIP 最多 200 个条目、解压总量 120MiB、单项 40MiB；忽略 __MACOSX。服务器另有 multipart 和 Nginx 总请求大小限制，见 API。支持媒体扩展名 png/jpg/jpeg/webp/gif/avif/pdf/mp4/mp3/woff2；当前按扩展名判断，不做字节级 MIME 或恶意文件扫描。媒体使用 UUID 命名空间和随机文件名，记录 SHA-256。

导入先处理媒体再完成文档路径检查；文档逐条保存，整个批次不是全局事务。冲突或失败可能留下媒体或部分已保存文档，重试前应核对已有记录，不要直接重复提交。

## 安全与备份边界

公开产物只使用公开已发布内容，剥离 source。私密正文和删除内容仍保存在数据库与完整备份；媒体 URL 本身没有权限隔离，知道链接即可访问，即便仅在私密文章引用。

完整备份包括整个 SQLite（含会话、账户、任务等所有表）和 media；manifest 中的列表不是数据库裁剪范围。数据库在线备份是一致快照，但媒体遍历与数据库快照不是全局同一时刻的事务。高可靠备份可在维护窗口暂停写入，并执行恢复验证。内容导出只含当前草稿与设置，不含完整历史、媒体字节和账户，不能替代完整备份。

## 访客统计数据与迁移

[analytics.mjs](../server/analytics.mjs) 的 `migrateAnalyticsSchema` 在启动时于事务中执行：使用独立的 `analytics_schema_migrations` 账本（不复用子站迁移版本，避免旧程序因版本号升高拒绝启动），版本 1 新建 `visit_events` 及索引，不修改任何已有表；版本 2 用显式 `ALTER TABLE visit_events ADD COLUMN country TEXT NOT NULL DEFAULT ''` 增加国家列，已有记录保留并记为未知（从未保存 IP，无法回填）。账本缺失但已有同名 `visit_events` 时报错回滚，不自动覆盖；账本版本高于程序时拒绝启动。

- 隐私：不保存 IP、UA、完整来源 URL 或查询串；国家由主站用本地 IP 库（见 [运维](OPERATIONS.md#访客统计-ip-国家库)）即时查询，只存国家代码。visitor 为随机 `bvid` Cookie 的 SHA-256 截断值；浏览器不接受 Cookie 时退化为“当日 + IP + UA”的哈希（每日变化，跨天会重复计数）。来源只存分类和名称/域名；path 去掉查询和锚点。数据只经管理员接口读取，不进入公开快照。
- 计数口径：页面加载一次计一次浏览，但同一访客在同一站点 30 分钟内重复浏览同一路径（刷新、来回切换）只计一次（`REPEAT_WINDOW_MINUTES`，按 visitor+path 查询近期记录，利用 site_id/created_at 索引，无结构变化）；刷新归为站内跳转，不计进站与来源。JS 执行才记录，爬虫 UA 忽略，不是防作弊统计；访客为窗口内去重 visitor；进站次数排除站内跳转。与文章 `stats.visits`（1 小时 Cookie 去重的文章计数）是两套独立数据。
- 升级：按现有流程完整备份并验证；启动后检查 `SELECT * FROM analytics_schema_migrations`、`PRAGMA integrity_check`。回退：未引入统计的旧程序忽略这两张表，直接回退代码即可；含 v1 统计但不认识 v2 的程序会因账本版本更高而拒绝启动；如需回退到 v1，先备份并停写，由维护者在事务中执行 `ALTER TABLE visit_events DROP COLUMN country; DELETE FROM analytics_schema_migrations WHERE version=2;`，仅丢弃国家信息，保留原访问记录；如需清除统计，在备份与停写条件下由维护者 `DROP TABLE visit_events; DROP TABLE analytics_schema_migrations;`，不要用旧整库覆盖新文章。

## 子站数据与迁移

新增 `replica_sites`（域名、名称、筛选模式、JSON 外观覆盖、认证码/长期令牌哈希、通信/构建/更新状态）、`replica_documents`（子站与文章 ID 的复合主键，all 模式为排除集、selected 模式为允许集）、`replica_schema_migrations`（当前版本 1）。字段定义以 [replica-migrations.mjs](../server/replica-migrations.mjs) 为准。迁移在事务中完成，新表不重写已有文章；旧开发期缺 settings 列用 ALTER，未知原型报错不覆盖。升级备份、校验和回退见 [子站运维](REPLICA-SITES.md)。

子站构建只读当前公开快照，文章草稿与私密正文不发送；公开媒体仍无访问控制。子站设置不改主站 settings。完整主站备份中的 SQLite 会包含新增表，故含子站认证哈希与管理状态；子站本地长期凭据保存在其私有 data/replica.json，不进入主站静态导出。replica-builds 是可重新生成的私有产物，不替代正式备份。
