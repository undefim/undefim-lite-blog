# 后续 AI 的阅读入口、修改指引与提示词

开始前读 [AGENTS.md](../AGENTS.md) 和 [文档索引](README.md)，然后按下表收敛范围。文档帮助定位，实际修改前必须阅读源码，不凭文档猜接口。代码、文档、生产报告可能有不同更新时间，需明确区别。

## 任务阅读矩阵

| 要改什么 | 必读源码 | 常见修改点 | 必须验证 | 同步文档 |
| --- | --- | --- | --- | --- |
| 首页/主题/响应式 | Site.astro、site.css、kiln.css、themes.mjs、PostCard/Listing、Mascot、site.ts、kiln.ts、background.ts | `src/layouts`、`components`、`styles`；新主题样式限定 `data-skin` | 每个主题都检查完整三栏/两栏/单栏、明暗遮罩、字体、动态暂停/减少动态、焦点、长内容无页面溢出 | ARCHITECTURE、CHANGELOG |
| 文章正文/代码/公式 | server/markdown.mjs、src/lib/content.mjs、通配页面、前后台 CSS | 渲染器、清洗白名单、正文样式、后台预览 | 预览与发布一致，HTML/XSS、公式/代码/表格/图片 | DATA-MODEL、必要时 API、CHANGELOG |
| 许可协议/版权区域 | server/license.mjs、index.mjs docSchema、db.mjs、markdown.mjs、admin Editor、Copyright.astro | 默认值、预设、每篇字段、导入导出与历史恢复 | 旧内容默认、自定义/空链接/隐藏、草稿隔离、URL 安全、多宽度 | API、DATA-MODEL、ARCHITECTURE、CHANGELOG |
| 新增文章字段 | db.mjs、index.mjs docSchema、admin Editor、content.mjs、页面、导入导出 | 前后端 schema/默认值、历史恢复、公开快照、导入导出 | 旧数据兼容，新增/编辑/发布/版本恢复，私密隔离 | API、DATA-MODEL、CHANGELOG |
| 后台编辑交互 | admin main.tsx/style.css、对应 API | 表单、请求封装、错误与任务反馈 | updatedAt 冲突、草稿不意外发布、手机表单 | API 如有变化、ARCHITECTURE、CHANGELOG |
| MD/ZIP 导入 | uploads.mjs、markdown.mjs、index.mjs /import、core tests | Front Matter、资源映射、限额、批处理 | 路径穿越、重复路径、缺图、扩展名、失败残留、默认草稿 | API、DATA-MODEL、CHANGELOG |
| 发布/CDN/旧 URL | publish.mjs、db.mjs、Astro config、静态分发、Compose | 快照、队列、切换、重定向、缓存刷新 | 失败保旧站、并发草稿、路径碰撞、重启、旧哈希资产 | DATA-MODEL、API、OPERATIONS、CHANGELOG |
| 评论/喜欢/统计 | index.mjs public routes、site.ts、db.mjs、analytics.mjs、geoip.mjs、update-geoip.mjs、Analytics.tsx、replica/server.mjs 代理白名单 | API、前台动态区域、限流 | 私密 ID 返回 404、邮箱不公开、审核/蜜罐、缓存 | API、DATA-MODEL、CHANGELOG |
| 登录/权限 | auth.mjs、index hooks、admin api/Login/Account、代理配置 | Cookie、会话、CSRF、Origin | 未登录、伪造来源、无效 CSRF、改密注销其他会话 | API、OPERATIONS、CHANGELOG |
| 分类/标签/站点设置 | defaultSettings、cleanSettings、Taxonomy/SiteSettings、页面路由 | 稳定 ID 改名、slug、设置和生成页面 | 草稿/快照名称、历史不重写、路径冲突、保存后构建 | API、DATA-MODEL、ARCHITECTURE、CHANGELOG |
| 独立子站 | replica-hub/build/protocol/migrations、replica agent/server、Replicas.tsx、publish、update-worker、compose.replica | 接入码、范围/外观、过滤构建、同步与程序更新 | 隔离两站、一次性码、哈希/路径、筛选、评论限流、更新来源、迁移幂等、多宽度；Docker 与替身测试分别记录 | REPLICA-SITES、API、DATA-MODEL、OPERATIONS、CHANGELOG |
| SQLite 结构 | db.mjs、backup/verify-backup、import-halo、所有读写调用方 | 版本迁移、数据转换与回退 | 旧库升级、幂等、完整性、备份恢复、失败回退 | DATA-MODEL、OPERATIONS、CHANGELOG |
| 后台 GitHub 更新 | update-source.mjs、system-update.mjs、update-worker.mjs、SystemUpdate.tsx、index hooks、publish、initialize、compose、Dockerfile/updater、updater-entrypoint、verify-compose、system-update tests | 私有文件队列、固定来源、心跳/flock/容器重启、定时、维护排空、备份/镜像/快照切换与回退 | 未登录/CSRF/Origin、重复请求、只读版本检查的最新/可更新/受阻/失败状态与按钮显隐、脏树/分叉拒绝、定时暂停恢复、失败不切换/保留数据；Docker 实测与命令替身测试分开记录；后台八宽度 | API、DATA-MODEL、ARCHITECTURE、OPERATIONS、README、CHANGELOG |
| 部署/证书/备份 | Dockerfile、compose、nginx-oracle、initialize、backup | 环境变量、代理、镜像、恢复步骤 | health + 实际页面、TLS、Cookie、缓存与恢复 | OPERATIONS、README、状态报告（仅实测）、CHANGELOG |
| 依赖/运行时安全 | package.json/lock、Dockerfile、漏洞涉及的调用方、markdown-security tests | 核对官方公告、精确锁定版本、元数据解析与运行时基线 | npm audit、补丁 Node 上 test/check/隔离构建；排版变化检查公式与多宽度；生产版本单独核实 | ARCHITECTURE、OPERATIONS、行为涉及的 API/DATA-MODEL、CHANGELOG |
| 搜索/SEO/RSS | search-index/rss/sitemap、Site、site.ts、content | 索引、metadata、客户端搜索 | 只含公开内容、慢网输入、中文、规范链接与日期 | ARCHITECTURE、CHANGELOG |

表中短文件名均在架构文档的模块表中给出完整目录。若一个需求横跨多行，读完相关链路后再修改。

## 可直接复制的通用开发提示词

```text
你正在维护 undefim 独立博客。先阅读根目录 AGENTS.md、docs/README.md，
再按 docs/AI-MAINTENANCE.md 的阅读矩阵查看本任务对应源码。
本次需求：<描述期望行为、触发方式、当前问题和验收标准>。
允许操作的环境与范围：<本地开发/隔离预览/已授权正式部署>。

先确认当前实现、数据流和影响文件，再完成修改；保持原有固定链接、
草稿/发布快照隔离、私密内容保护、统一美学及 PC/移动端布局，不使用 emoji。
新增字段需考虑旧数据、导入导出、历史恢复、API 和编辑器的兼容。
在隔离数据上执行必要验证，写明实际执行的命令和结果；不能用旧报告冒充本次验证。
同步更新对应开发文档及 docs/CHANGELOG.md，说明接口、字段、流程或运维变化。
若仅更改文档，无需重启生产；如部署前台修改，完成静态重新发布后再核验页面。
最终交付修改文件、验证结果、文档更新项、剩余问题和回退方式。
```

### 修改布局或美术

```text
需求：<布局或样式目标>。先阅读 AGENTS.md、docs/ARCHITECTURE.md，
src/layouts/Site.astro、src/styles/site.css、相关组件、src/scripts/site.ts、src/scripts/background.ts。
先查看完整桌面三栏及手机页面；沿用背景、字体、半透明卡片和明暗主题，
不使用 emoji。不要因为当前窗口较窄而漏掉左右栏。
改后验证 360/390/767/768/1199/1200/1440/1920px，包含首页、长文章、
目录、搜索、代码表格和图片，无页面整体横向溢出。
主题改动要核对背景遮罩与卡片分层、字体预加载和分档容器宽度；
动画不得拦截操作，页面隐藏/恢复与减少动态偏好需验证。
记录实际观察到的结果，更新架构断点说明和 CHANGELOG。
```

### 新增内容字段或后台功能

```text
需求：<字段名、类型、默认值、后台交互、前台是否展示>。
先读 docs/API.md、docs/DATA-MODEL.md，追踪 db.mjs → index.mjs 的 schema →
admin/src/main.tsx → 公开快照 → Astro 页面；检查 MD 导入、内容导出和版本恢复。
定义旧内容缺少字段时的兼容方式，保持保存草稿与发布分离。
必要时写数据库迁移和回退方案，不用建表语句假装完成旧表升级。
验证完整链路后同步字段契约、数据模型和 CHANGELOG。
```

### 改导入或 Markdown 排版

```text
需求：<支持的新语法/Front Matter/ZIP 资源格式>。
先读 docs/DATA-MODEL.md 和 API.md，检查 server/markdown.mjs、uploads.mjs、
index.mjs、src/lib/content.mjs 及 tests/core.test.mjs。
统一后台预览与发布渲染，保留 HTML 清洗、路径穿越防护和体积限制。
使用隔离 MD/ZIP 样例验证相对资源、冲突、中文路径、异常与默认草稿行为。
不要把导出 ZIP 当作全库备份，也不要自动把 private 标记忽略后公开发布。
将新增能力和仍未支持的格式明确写入文档与 CHANGELOG。
```

### 部署或排查生产问题

```text
目标：<部署已验证变更/排查具体异常>；授权范围：<具体操作范围>。
先读 docs/OPERATIONS.md、DATA-MODEL.md 及当前实际配置，核对已授权的目标主机、
应用目录、data 挂载、current 版本、任务状态和域名响应。
不要复用 preview 打包脚本生成的 HTTP 环境覆盖生产 .env；不输出凭据。
需要写操作时保留最新数据与回退点，按已获授权执行。
前台代码更新后显式重新发布静态站点，检查完整桌面和移动页面；
不能只以容器健康或 API 返回任务 ID 作为上线成功。
记录真实核验结果，更新运维文档与 CHANGELOG；只有实测后才修改生产状态报告。
```

## 文档更新规则

每次有行为变更，在同一交付中完成对应文档更新，不留“以后补”。新增 API 写清方法、路径、鉴权、字段、返回、错误、异步语义；新增环境变量写默认值、读取位置、Compose 是否传入、重启还是重新构建生效；新增数据写默认值、迁移和恢复办法。改断点写清 PC/平板/手机行为并实际验收。

维护记录格式：日期、需求、修改范围、接口/数据兼容性、实际验证、部署状态、已知限制。对于代码没变的文档整理，明确说明“无业务代码改动、未重部署”，不要给生产报告换日期制造新验收。

完成前检查相对链接存在、接口表没有虚构能力、示例无真实密码与 Token、已实现与计划分开。遇到文档与源码不一致先确认事实再纠正；重要的产品行为变化要向用户说明，不能靠修改文档掩盖代码缺陷。
