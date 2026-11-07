# API 参考

核对日期：2026-10-02。注册入口：[server/index.mjs](../server/index.mjs)。Base URL 为同源 `/api`；下表写完整路径。暂无 OpenAPI 文件与独立版本前缀。

## 通用约定与认证

JSON 请求使用 `Content-Type: application/json`；文件用 multipart/form-data，浏览器 FormData 不手动设置 boundary。返回通常为 JSON；导出、备份下载返回 ZIP。通常新建/发布任务提交返回 200；系统程序更新提交单独返回 202。异步操作返回 `{ "job": "任务ID" }`，必须轮询任务直至 success/failed，不能收到 ID 就报告发布成功。

登录返回 username/ csrf，同时写入 `blog_session` Cookie：HttpOnly、SameSite=Strict、Path=/api、7 天；除 COOKIE_SECURE=false 外启用 Secure。数据库保存 Token 哈希；密码为 scrypt 盐化哈希。GET session 可重新获得 csrf。管理员写接口必须同时带 Cookie 和 `X-CSRF-Token`。

所有 POST/PUT/PATCH/DELETE 如果带 Origin，则必须等于 ADMIN_ORIGIN，未设置时等于服务判断的协议和 Host。缺失 Origin 并非全局拒绝，管理员接口仍要求 CSRF。开发跨端口访问要正确设置 Origin，见运维文档。无公开注册、权限角色管理或多用户管理 UI。

错误常见为 `{ "message": "说明" }`：400 输入错误，401 未登录/密码错误，403 来源或 CSRF/评论开关限制，404 不存在，409 显式编辑冲突/导入路径冲突，429 限流，5xx 服务错误。并非所有数据库唯一约束冲突都返回 409，当前统一处理可能返回 400。所有 `/api/` 响应 no-store。

请求体限制：JSON 3MiB；multipart 单文件 40MiB、20 文件、20 字段；正式 Nginx 整个请求最多 42m。因此不能把单文件上限乘以文件数当作生产总额度。

## 公开与认证接口

| 方法 | 路径 | 请求 | 响应/限制 |
| --- | --- | --- | --- |
| GET | `/api/health` | 无 | `{ok:true,revision,publishing,writes}`；revision 为镜像 APP_REVISION（未配置时 null），其余为当前发布数与在途写请求数；仅供存活/排空检查，不返回内容或更新设置，不能代替页面/证书验收 |
| POST | `/api/auth/login` | `{username,password}`，最长 100/256 | `{username,csrf}` + Cookie；8 次/15 分钟 |
| GET | `/api/auth/session` | 登录 Cookie | `{username,csrf}` |
| POST | `/api/auth/logout` | Cookie + CSRF | `{ok:true}`，删除当前会话及 Cookie |
| POST | `/api/auth/password` | `{current,password}` + 鉴权 | `{ok:true}`；新密码 14–256 字符，删除其他会话 |
| GET | `/api/public/documents/:id/comments` | 公开当前版本的文档 ID | 已通过评论数组：id/author/content/created_at/parent_id；不含邮箱 |
| POST | `/api/public/documents/:id/comments` | `{author,email?,content,website?}` | `{ok:true}`，待审核；3 次/10 分钟 |
| POST | `/api/public/documents/:id/visit` | 无正文 | `{visits,likes}`；30 次/分钟，Cookie 1 小时去重 |
| POST | `/api/public/documents/:id/like` | 无正文 | `{visits,likes}`；10 次/分钟，Cookie 365 天去重 |

评论 author 去首尾空白后 1–60 字符，content 1–5000；email 可省略、空或合法邮箱；website 最长 200，是蜜罐字段，非空时返回成功但不写入。关闭评论返回 403。当前提交接口不接收 parent_id；保留历史回复关系不代表已实现新的嵌套回复功能。限流为进程内实现；Cookie 去重不提供强身份或防作弊保证。

以下其余接口均需管理员登录；写方法均需 CSRF。

## 系统程序更新

| 方法 | 路径 | 输入 | 返回与语义 |
| --- | --- | --- | --- |
| GET | `/api/system/update` | 管理员 Cookie | `{config,source,online,check,checking,worker,pending}`；首次 worker/pending/check 为 null，config 为 `{mode:"manual",intervalHours:24}`；source 始终包含预设仓库、分支与 GitHub 链接，不依赖执行器在线；check 为最近一次版本对比，checking 表示有尚未被执行器处理的重新检查请求 |
| POST | `/api/system/update/check` | Cookie + CSRF，无正文或空对象 | **202** `{checking:true}`；只提交只读“重新检查”请求，不更新、不暂停写入；执行器离线 503，带参数 400，限 6 次/分钟 |
| PUT | `/api/system/update/config` | Cookie + CSRF，`{mode,intervalHours}` | 原样返回已验证的配置；mode 仅 manual/auto，intervalHours 仅数字 1/6/12/24/168；未知键一律 400；可离线保存，不启动执行器 |
| POST | `/api/system/update/run` | Cookie + CSRF，无正文或空对象 | **202** `{id,requestedAt,trigger:"manual"}`；只是原子提交请求，不代表更新完成；不接收仓库、分支、命令或凭据 |

执行器离线（45 秒无心跳）时提交返回 503；已有 pending/running 任务返回 409；无会话 401，CSRF/Origin 失败 403。全部响应 no-store。配置独立保存在 DATA_DIR/system-update，不进入站点公开 settings 或内容导出，无 SQL 迁移。

`source` 为 `{repository,branch,url}`，默认 `undefim/undefim-lite-blog`、`main` 与 `https://github.com/undefim/undefim-lite-blog`；执行器曾提供部署端自定义来源时采用其来源，不再对旧 owner 做别名转换。该字段只表示来源已配置，不能替代 `online` 或授权执行更新，未启动执行器仍返回 online=false。来源无需在后台填写、不写入公开站点设置。

`check`（同时位于 worker.check）为 `{state,reason?,checkedAt,from,to?,ahead?,commits?,message}`。state：`latest`（本地代码、运行程序和静态标记都等于远端分支，后台显示“已是最新版”且不显示更新按钮）、`available`（可更新：reason 为 `new-commits` 时附 ahead 与最多 5 条 `{sha,subject}`，为 `redeploy` 时代码一致但运行/静态版本落后）、`blocked`（存在更新但不能自动执行，reason 为 dirty、branch、remote、diverged、ahead 或 manual-deploy，不显示更新按钮）、`error`（GitHub 或博客服务无法确认，只给通用提示，不含 Git/Docker 原始输出）。执行器启动后立即检查，之后每 10 分钟及收到重新检查请求时只读执行 `git fetch` 对比，更新任务结束后重新检查；更新开始后 check 清空直到下一次检查。commit subject 为公开仓库文本，限 100 字符并去除控制字符，前端按纯文本显示。该字段只用于展示，真正更新前执行器仍重新校验全部条件。

worker 可含 `repository,branch,revision,startedAt,heartbeatAt,lastCheckedAt,nextRunAt,paused,job`。revision 是执行器已知的部署代码版本，不能单独证明真实运行容器；任务成功需要执行器同时核对运行健康 revision 与初始化静态标记。job 为最近一条任务：`id,trigger,startedAt,finishedAt,status,message,maintenance,from,to,backup?,rollback?`；status 为 running/success/failed/unchanged；backup 仅备份文件名，不含路径/内容，rollback 为恢复结果。pending 为尚未完成请求，运行时也保留直到完成；字段未发生时可省略。没有完整历史或原始 Git/Docker 日志接口。

后台每 5 秒读状态，重启断线后自动重试。失败会暂停自动更新，手动成功/unchanged 后恢复；执行器重启会将 running 标失败并暂停，不自动重放，保留已启用的维护屏障；心跳离线不会自动解锁。维护阶段除登录/退出、系统更新提交/检查/配置以外的写方法返回 503“系统正在更新，写操作暂时暂停，请稍后重试”，GET 仍可读取；写屏障和在途请求/发布队列计数用于停止唯一写实例前排空。执行器默认由 Compose 的 updater 服务运行，API 路径/鉴权与队列格式不变。安装、权限、周期语义与回退边界见 [运维](OPERATIONS.md#后台-github-更新)。

## 文档与历史版本

| 方法 | 路径 | 输入 | 返回与语义 |
| --- | --- | --- | --- |
| GET | `/api/documents` | 可选 `?deleted=true` | 文档数组；默认非回收站，true 只列回收站；无分页 |
| GET | `/api/documents/:id` | ID | 完整草稿 Document |
| POST | `/api/documents` | DocumentInput | 新草稿 Document |
| PUT | `/api/documents/:id` | 完整 DocumentInput，可附 updatedAt | Document + unpublishJob（任务 ID 或 null）；不是局部 PATCH；时间戳不匹配为 409 |
| POST | `/api/documents/:id/publish` | 无正文 | `{job}`；只接受公开且不在回收站的文档 |
| POST | `/api/documents/:id/unpublish` | 无正文 | `{job}`；成功构建后撤回 |
| POST | `/api/documents/:id/trash` | 无正文 | `{job}`；立即标回收站并排队撤回 |
| POST | `/api/documents/:id/restore` | 无正文 | Document；清除回收站标记，不构建 |
| GET | `/api/documents/:id/revisions` | 无 | `[{id,created_at,reason}]`，时间倒序 |
| GET | `/api/documents/:id/revisions/:revision` | 无 | `{id,document_id,data,created_at,reason}`，data 已解析 |
| POST | `/api/documents/:id/revisions/:revision/restore` | 无正文 | Document；恢复为草稿，保留当前固定链接 |

DocumentInput：

| 字段 | 类型、约束与默认 |
| --- | --- |
| kind | 必填 `post` / `page` |
| title | 必填字符串，trim 后 1–500 |
| path | 必填站内绝对路径，见下文 |
| format | 必填 `markdown` / `html` |
| markdown | 必填字符串，最多 2000000 字符；两种格式都使用这个字段 |
| date | 必填字符串，Date.parse 可解析 |
| modifiedAt | 可选日期字符串；新建/更新接口实际写当前时间 |
| categories | 字符串数组，每项 <=100，最多 20，默认 [] |
| tags | 字符串数组，每项 <=100，最多 50，默认 [] |
| excerpt | <=2000，默认空串 |
| cover | 安全 URL，默认空串 |
| pinned | boolean，默认 false |
| allowComment | boolean，默认 true |
| visibility | public/private，默认 public |
| author | <=100，默认 undefim |
| copyrightEnabled | boolean，默认 true；关闭隐藏整块作者/链接/许可区域 |
| licenseName | trim 后 1–100，默认 CC BY 4.0 |
| licenseUrl | 安全 URL 或空串，默认 https://creativecommons.org/licenses/by/4.0/；空串显示纯文本 |
| licenseNote | trim 后 <=1000，允许空串，默认“转载请注明出处。” |

许可字段为每篇文章/页面独立设置，保存草稿后仍需发布。历史内容没有这些字段时读取默认值；旧版本恢复时也回到默认 CC BY 4.0，不沿用当前自定义许可。MD 导入和内容导出的 Front Matter 保留这四个字段。

PUT 保存私密内容且仍有公开快照时自动排队取消发布，响应 `unpublishJob` 为任务 ID；否则为 null。该字段仅为响应元数据，不进入文章 JSON。须轮询任务成功才确认前台下线；失败可重试保存或取消发布，旧公开版本暂时保留。

Document 追加 id、published、deletedAt、updatedAt，可能保留迁移元数据。PUT 应发送完整表单值及最新 updatedAt；省略有默认值的字段会回到默认值。updatedAt 冲突校验是可选字段触发，不能省略后仍声称防止并发覆盖。

path 必须以 `/` 开始，不可为根；不含 query/hash、反斜线、控制符、空段、`.`、`..` 或百分号编码；首段不能为 admin/api/assets/upload/categories/tags/page/index/search/rss.xml/sitemap.xml/search-index.json。这不是所有构建页面的完整冲突探测器，新增路径仍需检查静态路由。URL 字段最长 2000，允许空串、单斜线开头的站内路径、HTTP(S)，拒绝协议相对地址及引号/尖括号/反斜线/控制符。

完整新建示例：

```json
{
  "kind": "post",
  "title": "维护示例",
  "path": "/archives/maintenance-example",
  "format": "markdown",
  "markdown": "# 正文\n\n文章内容。",
  "date": "2026-10-02T02:00:00.000Z",
  "categories": ["技术"],
  "tags": ["维护"],
  "excerpt": "示例摘要",
  "cover": "",
  "pinned": false,
  "allowComment": true,
  "visibility": "public",
  "author": "undefim"
}
```

## 预览、导入、媒体与评论管理

| 方法 | 路径 | 输入 | 返回 |
| --- | --- | --- | --- |
| POST | `/api/preview` | `{source,format}`，source <=2000000，format markdown/html | `{html}`，经过安全清洗；不保存 |
| POST | `/api/import` | multipart，通常重复 files 字段，.md 或 .zip | `{documents:Document[],job:null或ID}` |
| GET | `/api/media` | 无 | 媒体数组，按 created_at 倒序 |
| POST | `/api/media` | multipart files | 媒体数组，每项 id/name/path/type/size/sha256/created_at |
| GET | `/api/comments` | 无 | 原评论字段 + path/document_title，含后台可见 email |
| PATCH | `/api/comments/:id` | `{status,content?}` | `{ok:true}`；status approved/pending/hidden，content <=5000 |

导入无更新/覆盖模式，遇到同批或已有路径（含回收站）冲突为 409。Front Matter 仅支持 YAML/JSON 字段对象；不支持的语言/标签、未闭合分隔符、错误格式或过量 YAML 别名展开返回 400，不执行元数据代码。自动发布由设置控制；导入不读取 Front Matter 的私密标记。文件上限、支持格式和相对引用限制见 [数据模型](DATA-MODEL.md)。没有媒体删除接口，不能假设 DELETE `/api/media/:id` 可用。评论修改立即影响动态列表；静态摘要计数需要另行构建。

## 设置、构建和备份

| 方法 | 路径 | 输入 | 返回 |
| --- | --- | --- | --- |
| GET | `/api/settings` | 无 | 合并默认值的设置对象 |
| PUT | `/api/settings` | 部分允许的键 | 完整设置；无自动构建 |
| POST | `/api/build` | 无正文 | `{job}`；按已发布快照重新生成站点 |
| GET | `/api/jobs` | 无 | 最近 50 条 Job |
| GET | `/api/jobs/:id` | 无 | Job |
| GET | `/api/export` | 无 | application/zip，文件名 blog-content.zip |
| POST | `/api/backup` | 无正文 | `{name:"日期-UUID.zip"}` |
| GET | `/api/backups/:name` | 合法 ZIP 基础文件名 | ZIP 下载；需要登录 |

设置键：title、description、author、bio、location、announcement、email、github、qq、startDate、umamiWebsiteId（字符串 <=3000）；avatar/logo/background（URL）；accent（六位十六进制色）；cardOpacity（0.5–1）；siteTheme（`dream` 或 `kiln`，登记于 `server/themes.mjs`，其他值 400“前台主题无效”；旧数据缺省为 `dream`）；importAutoPublish（boolean）；navigation、categories、tags、links；assetMap（迁移资源映射，目前缺少专门结构校验，不能存放秘密）。只接收 defaultSettings 中的键，其他键被忽略；公开构建导出这些默认键，不应把 Token 加入其中。

- icpRecord、publicSecurityRecord：可选备案文本，trim 后最多 100 字符，默认空串；空白归为空串，非字符串或超长返回 400。分别链接工信部备案系统与公安备案系统；公安文本含独立的 14 位数字时链接对应查询，否则链接公安备案首页。不解析 HTML，不接收自定义链接，前台按转义文本显示。保存不会自动构建，须点击“发布站点”生效。
- navigation：最多 20 个 `{label<=40,href:URL}`。
- categories/tags：各最多 1000 个 `{id?,name,slug,description?,color?,children?,hidden?}`；name 1–100，slug 1–150 且只含 Unicode 字母/数字/点/下划线/连字符，同组 slug 不重复，description <=2000，children 为字符串数组。
- links：最多 300 个 `{name<=100,url:URL,logo?:URL}`。
- 分类按稳定 ID 改名会同步草稿和 published_data，历史版本不改；静态版本仍需构建。

Job 示例（urls 当前是字符串，不是数组）：

```json
{"id":"job-id","status":"success","created_at":"2026-10-02T02:00:00.000Z","finished_at":"2026-10-02T02:00:05.000Z","log":"静态版本切换完成。","urls":"[\"/archives/example\"]"}
```

## 客户端调用流程示例

仅在隔离测试环境运行写入示例。真实后台已有封装，位于 `admin/src/main.tsx`，优先复用。

```js
// 浏览器同源环境；已通过登录页面建立 Cookie。
const session = await fetch('/api/auth/session').then(r => r.json());
async function write(route, body) {
  const r = await fetch('/api' + route, {
    method: 'POST',
    headers: {'X-CSRF-Token': session.csrf,
      ...(body instanceof FormData ? {} : {'Content-Type':'application/json'})},
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined
  });
  const result = await r.json();
  if (!r.ok) throw new Error(result.message);
  return result;
}
const form = new FormData();
form.append('files', new File(['# 示例正文'], 'example.md', {type:'text/markdown'}));
const imported = await write('/import', form);
// 默认草稿；确认内容后按需调用 /documents/<id>/publish。
// 若 imported.job 非空，则轮询 /api/jobs/<id>，成功后再验收公开页面。
```

接口增加/修改时同步更新此文档及调用方，涉及隐私和发布行为还必须更新数据模型与回归测试。

## 独立子站

以下管理接口需要现有管理员 Cookie；写操作沿用 CSRF、Origin、维护写屏障和 no-store。

| 方法 | 路径 | 输入与结果 |
| --- | --- | --- |
| GET | `/api/replicas` | `{primaryRevision,replicas}`，不返回认证哈希或长期令牌 |
| POST | `/api/replicas` | `{name,primaryUrl,siteUrl}`；返回 `{replica,code,command,expiresAt}`，仅此次显示认证码 |
| PUT | `/api/replicas/:id` | `{name,siteUrl,mode,documentIds,settings}`；mode 为 all/selected，保存后排队构建 |
| POST | `/api/replicas/:id/code` | 可选 `{primaryUrl}`；重新生成认证码与部署命令，旧认证码失效 |
| POST | `/api/replicas/:id/build` | 202；强制重新构建已接入子站 |
| POST | `/api/replicas/:id/update` | 202；请求更新至主站运行中的提交，版本未知时 409 |
| POST | `/api/replicas/:id/revoke` | 吊销凭据，停止后续同步/评论代理；不远程删除子站现存页面 |
| DELETE | `/api/replicas/:id` | 删除管理记录及主站为该站生成的产物；不删除子站服务器文件 |

settings 可覆盖 `siteTheme`、`title`、`description`、`announcement`、`navigation`（label/href）、`icpRecord`、`publicSecurityRecord`，其他字段拒绝；缺省键继承主站已发布设置。空备案字符串表示不显示。documentIds 的语义随 mode 改变；自定义页面始终保留。

子站接入端点 `POST /api/replica/v1/enroll` 接收 `{code}`，有速率限制；返回子站 ID、长期令牌、主站/子站地址等。认证码一次性且 24 小时过期；后续接口使用 `Authorization: Replica <id>.<token>`，必须通过 HTTPS 传输，不使用后台会话。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/replica/v1/sync` | 上报 release/revision/error/update，返回目标 build、siteUrl、待执行 update |
| GET | `/api/replica/v1/manifest?build=<id>` | 本子站版本文件路径、大小、哈希与媒体清单 |
| GET | `/api/replica/v1/file?build=<id>&path=<relative>` | 下载本子站版本文件，不得越界 |
| GET | `/api/replica/v1/media?path=upload/...` | 下载公开媒体 |

主站 `/api/health` 保持原有契约。轻量子站的 `/api/health` 额外报告 role、release、enrolled；healthy 仅代表程序在线，不保证已接入或已同步。子站不开放管理接口，`/admin/` 跳转主站；`/api/public/*` 经子站凭据转发至主站，访客原始 Cookie/身份敏感头不能任意转交。详见 [子站运维及限制](REPLICA-SITES.md)。
