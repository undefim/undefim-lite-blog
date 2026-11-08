import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import JSZip from 'jszip';
process.env.DATA_DIR=await fs.mkdtemp(path.join(os.tmpdir(),'undefim-test-'));process.env.COOKIE_SECURE='false';
const {db,documents,document,saveDocument,validContentPath}=await import('../server/db.mjs');
const {renderMarkdown,safeHtml,importMarkdown}=await import('../server/markdown.mjs');const {markdownUpload,safeArchivePath}=await import('../server/uploads.mjs');const {passwordHash}=await import('../server/auth.mjs');const {createApp}=await import('../server/index.mjs');const {enqueueBuild,settledBuilds,buildRelease}=await import('../server/publish.mjs');
const base={kind:'post',title:'公开示例',path:'/archives/example',format:'markdown',markdown:'# 标题\n\n正常内容',date:'2026-01-01T00:00:00.000Z',categories:[],tags:[],visibility:'public',allowComment:true,author:'undefim'};
let d;
test('公开内容与草稿路径分离，私密与回收站不进入公开导出',()=>{d=saveDocument(base,'test',true);saveDocument({...d,path:'/archives/changed',markdown:'尚未公开的文字'});assert.equal(document(d.id,true).path,base.path);assert.equal(document(d.id,true).markdown,base.markdown);const privateD=saveDocument({...base,path:'/archives/private',visibility:'private',markdown:'私密标记'},'test',true);assert.equal(document(privateD.id,true),null);assert.ok(!documents({published:true}).some(x=>x.id===privateD.id));db.prepare('UPDATE documents SET deleted_at=? WHERE id=?').run(new Date().toISOString(),privateD.id);assert.equal(documents({deleted:true}).length,1)});
test('固定链接与 ZIP 路径拒绝越界、编码绕过和系统路径',()=>{for(const s of ['/../admin','/a/../b','/api/foo','/admin','//foo','/a%2f..%2fadmin','/a%252f..','/a\\b','/a?token=x'])assert.equal(validContentPath(s),false,s);assert.equal(validContentPath('/archives/中文-title'),true);for(const s of ['../secret','a/../../secret','/tmp/key','C:/key','a\\b'])assert.equal(safeArchivePath(s),false,s)});
test('Markdown 支持代码、表格、目录、勾选任务，同时清除脚本与危险链接',async()=>{const rendered=await renderMarkdown('# 示例\n\n- [x] 已完成\n\n| A | B |\n|---|---|\n|1|2|\n\n```js\nconst value = 1;\n```\n\n<script>alert(1)</script>\n[危险](javascript:alert(1))');assert.match(rendered,/<h1 id="示例"/);assert.match(rendered,/<table>/);assert.match(rendered,/checked/);assert.match(rendered,/data-copy/);assert.doesNotMatch(rendered,/<script|href="javascript:/);assert.doesNotMatch(safeHtml('<img src="x" onerror="alert(1)"><iframe src="https://example.com"></iframe>'),/onerror/);assert.match(safeHtml('<iframe src="https://example.com"></iframe>'),/sandbox="allow-scripts allow-forms allow-popups"/)});
test('Front Matter 和 ZIP 相对图片可导入，非法归档不能写入目录',async()=>{const d=importMarkdown('---\ntitle: 新文章\nslug: sample\ndate: 2026-10-02\ntags: [VPS]\n---\n\n正文','file.md');assert.equal(d.path,'/archives/sample');assert.equal(d.title,'新文章');const zip=new JSZip();zip.file('posts/sample.md','---\nslug: zip-sample\n---\n![图片](../images/test.png)');zip.file('images/test.png',Buffer.from([137,80,78,71]));const r=await markdownUpload(await zip.generateAsync({type:'nodebuffer'}),'sample.zip');assert.match(r.documents[0].markdown,/\/upload\/.*test.png/);const evil=new JSZip();evil.file('../secret.md','# 越界');await assert.rejects(()=>markdownUpload(evil.generateAsync({type:'nodebuffer'}),'bad.zip'));const evilBytes=await evil.generateAsync({type:'nodebuffer'});await assert.rejects(()=>markdownUpload(evilBytes,'bad.zip'),/不安全路径/)});
test('后台需要会话与 CSRF，公开评论不返回邮箱和私密内容',async()=>{db.prepare('INSERT INTO users VALUES (?,?)').run('test',passwordHash('test-password-long-enough'));const app=await createApp();assert.equal((await app.inject({url:'/api/documents'})).statusCode,401);const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'test',password:'test-password-long-enough'}});assert.equal(login.statusCode,200);const cookie=login.headers['set-cookie'].split(';')[0];const {csrf}=login.json();const noCsrf=await app.inject({method:'POST',url:'/api/documents',headers:{cookie},payload:base});assert.equal(noCsrf.statusCode,403);const invalidOrigin=await app.inject({method:'POST',url:'/api/documents',headers:{cookie,'x-csrf-token':csrf,origin:'https://evil.example'},payload:base});assert.equal(invalidOrigin.statusCode,403);const privateID=documents({deleted:true})[0].id;assert.equal((await app.inject({url:`/api/public/documents/${privateID}/comments`})).statusCode,404);db.prepare('INSERT INTO comments VALUES (?,?,?,?,?,?,?,?)').run('comment-test',d.id,null,'访客','private@example.com','公开评论','approved',new Date().toISOString());const comments=await app.inject({url:`/api/public/documents/${d.id}/comments`});assert.equal(comments.statusCode,200);assert.ok(!comments.body.includes('private@example.com'));assert.equal((await app.inject({url:'/data/blog.sqlite'})).statusCode,404);await app.close()});
test('后台禁止缓存，前台和媒体保留各自的 CDN 缓存规则',async()=>{const originalCwd=process.cwd();const runtime=path.join(process.env.DATA_DIR,'cache-test');await fs.mkdir(path.join(runtime,'dist/admin'),{recursive:true});await fs.mkdir(path.join(runtime,'dist/site/_astro'),{recursive:true});await fs.writeFile(path.join(runtime,'dist/admin/index.html'),'<html>admin</html>');await fs.writeFile(path.join(runtime,'dist/site/index.html'),'<html>blog</html>');await fs.writeFile(path.join(runtime,'dist/site/_astro/app.hash.js'),'console.log(1)');process.chdir(runtime);const app=await createApp();try{for(const [url,cache] of [['/admin/','no-store'],['/api/documents','no-store'],['/','public, max-age=0, s-maxage=300, stale-while-revalidate=60'],['/_astro/app.hash.js','public, max-age=31536000, immutable'],[db.prepare('SELECT path FROM media LIMIT 1').get().path,'public, max-age=31536000, immutable']]){const response=await app.inject({url});assert.equal(response.headers['cache-control'],cache,url)}}finally{await app.close();process.chdir(originalCwd)}});
test('发布失败保留当前版本，成功只发布捕获的版本并保留更新的草稿',async()=>{const oldRoot=path.join(process.env.DATA_DIR,'previous');await fs.mkdir(oldRoot,{recursive:true});await fs.symlink(oldRoot,path.join(process.env.DATA_DIR,'current'));const failedID='publish-test-failure';db.prepare('INSERT INTO jobs(id,status,created_at) VALUES (?,?,?)').run(failedID,'queued',new Date().toISOString());await buildRelease(failedID,[],async()=>{throw new Error('模拟磁盘或构建失败')});assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(failedID).status,'failed');assert.equal(await fs.realpath(path.join(process.env.DATA_DIR,'current')),await fs.realpath(oldRoot));const captured=document(d.id);const id='publish-test-success';db.prepare('INSERT INTO jobs(id,status,created_at) VALUES (?,?,?)').run(id,'queued',new Date().toISOString());await buildRelease(id,[{id:d.id,data:captured}],async(site)=>{await fs.mkdir(site,{recursive:true});await fs.writeFile(path.join(site,'index.html'),'new release');saveDocument({...captured,markdown:'构建期间继续写的草稿'})});assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(id).status,'success');assert.equal(document(d.id,true).markdown,captured.markdown);assert.equal(document(d.id).markdown,'构建期间继续写的草稿');assert.notEqual(await fs.realpath(path.join(process.env.DATA_DIR,'current')),await fs.realpath(oldRoot))});
test('许可协议兼容旧数据，保存草稿不改公开快照，导入导出和历史恢复保留协议',async()=>{
 const {defaultLicense}=await import('../server/license.mjs');
 const legacy={...base,path:'/archives/license-legacy'};
 const old=saveDocument(legacy,'test',true);
 // Simulate migrated documents and revisions that predate the new fields.
 db.prepare('UPDATE documents SET data=?,published_data=? WHERE id=?').run(JSON.stringify(legacy),JSON.stringify(legacy),old.id);
 assert.equal(document(old.id).licenseName,defaultLicense.licenseName);
 assert.equal(document(old.id,true).copyrightEnabled,true);
 const app=await createApp();
 try {
  const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'test',password:'test-password-long-enough'}});
  const headers={cookie:login.headers['set-cookie'].split(';')[0],'x-csrf-token':login.json().csrf};
  const custom={...document(old.id),copyrightEnabled:false,licenseName:'保留所有权利',licenseUrl:'',licenseNote:'联系作者获取授权。'};
  const saved=await app.inject({method:'PUT',url:`/api/documents/${old.id}`,headers,payload:custom});
  assert.equal(saved.statusCode,200);assert.equal(saved.json().copyrightEnabled,false);
  assert.equal(document(old.id,true).licenseName,defaultLicense.licenseName);
  for(const licenseUrl of ['javascript:alert(1)','//evil.example','https://example.com/" onclick="alert(1)']) {
   const rejected=await app.inject({method:'POST',url:'/api/documents',headers,payload:{...base,path:'/archives/license-unsafe',licenseUrl}});
   assert.equal(rejected.statusCode,400);
  }
  const exported=await app.inject({url:'/api/export',headers});
  const zip=await JSZip.loadAsync(exported.rawPayload);
  const imported=importMarkdown(await zip.file(`documents/${old.id}.md`).async('string'),'restored.md');
  assert.equal(imported.copyrightEnabled,false);assert.equal(imported.licenseUrl,'');assert.equal(imported.licenseNote,custom.licenseNote);
  const revision=db.prepare('SELECT id FROM revisions WHERE document_id=? ORDER BY created_at DESC').get(old.id);
  const restored=await app.inject({method:'POST',url:`/api/documents/${old.id}/revisions/${revision.id}/restore`,headers});
  assert.equal(restored.statusCode,200);assert.equal(restored.json().licenseName,defaultLicense.licenseName);
  assert.equal(restored.json().copyrightEnabled,true);
  const source='---\nlicenseName: 自定义授权\nlicenseUrl: https://example.com/license\nlicenseNote: 请先联系作者。\ncopyrightEnabled: false\n---\n\n正文';
  assert.equal(importMarkdown(source,'license.md').licenseName,'自定义授权');
  assert.equal(importMarkdown(source,'license.md').copyrightEnabled,false);
 } finally {await app.close()}
});
test('保存已发布内容为私密自动撤回，失败可重试且不公开私密草稿',async()=>{
 const old=saveDocument({...base,path:'/archives/private-switch',markdown:'原公开正文'},'test',true);
 const unrelated=document(d.id,true);
 const queued=[];
 const app=await createApp({queueBuild:changes=>{const id=`private-switch-${queued.length}`;queued.push({id,changes});db.prepare('INSERT INTO jobs(id,status,created_at) VALUES (?,?,?)').run(id,'queued',new Date().toISOString());return id}});
 try {
  const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'test',password:'test-password-long-enough'}});
  const headers={cookie:login.headers['set-cookie'].split(';')[0],'x-csrf-token':login.json().csrf};
  const save=()=>app.inject({method:'PUT',url:`/api/documents/${old.id}`,headers,payload:{...document(old.id),visibility:'private',markdown:'私密新增正文'}});
  const response=await save();assert.equal(response.statusCode,200);assert.equal(response.json().unpublishJob,queued[0].id);
  assert.deepEqual(queued[0].changes,[{id:old.id,data:null}]);assert.equal(document(old.id,true).markdown,'原公开正文');
  const previous=await fs.realpath(path.join(process.env.DATA_DIR,'current'));
  await buildRelease(queued[0].id,queued[0].changes,async()=>{throw new Error('模拟撤回失败')});
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(queued[0].id).status,'failed');
  assert.equal(await fs.realpath(path.join(process.env.DATA_DIR,'current')),previous);
  assert.equal(document(old.id,true).markdown,'原公开正文');
  const retry=await save();assert.equal(retry.json().unpublishJob,queued[1].id);
  await buildRelease(queued[1].id,queued[1].changes,async site=>{await fs.mkdir(site,{recursive:true});await fs.writeFile(path.join(site,'index.html'),'撤回后的站点')});
  assert.equal(document(old.id).visibility,'private');assert.equal(document(old.id).markdown,'私密新增正文');assert.equal(document(old.id,true),null);
  const snapshot=JSON.parse(await fs.readFile(path.join(process.env.DATA_DIR,'current/content.json'),'utf8'));
  assert.ok(!snapshot.documents.some(x=>x.id===old.id));assert.ok(!JSON.stringify(snapshot).includes('私密新增正文'));
  assert.deepEqual(document(d.id,true),unrelated);
  const savedAgain=await save();assert.equal(savedAgain.json().unpublishJob,null);assert.equal(queued.length,2);
 } finally {await app.close()}
});
test('前台主题默认为窑火，只接受已登记的主题并写入公开快照',async()=>{
 const {settings}=await import('../server/db.mjs');const {publicExport}=await import('../server/db.mjs');
 assert.equal(settings().siteTheme,'kiln');
 const app=await createApp();
 try {
  const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'test',password:'test-password-long-enough'}});
  const headers={cookie:login.headers['set-cookie'].split(';')[0],'x-csrf-token':login.json().csrf};
  const rejected=await app.inject({method:'PUT',url:'/api/settings',headers,payload:{siteTheme:'neon'}});
  assert.equal(rejected.statusCode,400);assert.equal(settings().siteTheme,'kiln');
  const saved=await app.inject({method:'PUT',url:'/api/settings',headers,payload:{siteTheme:'dream'}});
  assert.equal(saved.statusCode,200);assert.equal(settings().siteTheme,'dream');assert.equal(publicExport().settings.siteTheme,'dream');
  await app.inject({method:'PUT',url:'/api/settings',headers,payload:{siteTheme:'kiln'}});
 } finally {await app.close()}
});
test('备案设置兼容旧库，校验可选文本并随公开快照与内容导出保留，保存不切换静态版本',async()=>{
 const {settings,publicExport}=await import('../server/db.mjs');
 assert.equal(settings().icpRecord,'');assert.equal(settings().publicSecurityRecord,'');
 assert.equal(db.prepare("SELECT count(*) AS n FROM settings WHERE key IN ('icpRecord','publicSecurityRecord')").get().n,0);
 const current=await fs.realpath(path.join(process.env.DATA_DIR,'current'));
 const app=await createApp();
 try {
  const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'test',password:'test-password-long-enough'}});
  const headers={cookie:login.headers['set-cookie'].split(';')[0],'x-csrf-token':login.json().csrf};
  for(const key of ['icpRecord','publicSecurityRecord'])for(const value of [null,123,{},'x'.repeat(101)]) {
   const response=await app.inject({method:'PUT',url:'/api/settings',headers,payload:{[key]:value}});
   assert.equal(response.statusCode,400);assert.equal(settings()[key],'');
  }
  const records={icpRecord:'测试ICP备00000000号',publicSecurityRecord:'测试公网安备00000000000000号'};
  const saved=await app.inject({method:'PUT',url:'/api/settings',headers,payload:Object.fromEntries(Object.entries(records).map(([k,v])=>[k,`  ${v}  `]))});
  assert.equal(saved.statusCode,200);
  const exported=await app.inject({url:'/api/export',headers});
  const zip=await JSZip.loadAsync(exported.rawPayload);
  const exportedSettings=JSON.parse(await zip.file('settings.json').async('string'));
  for(const [key,value] of Object.entries(records)) {
   assert.equal(saved.json()[key],value);assert.equal(publicExport().settings[key],value);assert.equal(exportedSettings[key],value);
  }
  const partial=await app.inject({method:'PUT',url:'/api/settings',headers,payload:{icpRecord:'   '}});
  assert.equal(partial.json().icpRecord,'');assert.equal(partial.json().publicSecurityRecord,records.publicSecurityRecord);
  assert.equal(await fs.realpath(path.join(process.env.DATA_DIR,'current')),current);
  await app.inject({method:'PUT',url:'/api/settings',headers,payload:{publicSecurityRecord:''}});
 } finally {await app.close()}
});
test.after(async()=>{db.close();await fs.rm(process.env.DATA_DIR,{recursive:true,force:true})});
