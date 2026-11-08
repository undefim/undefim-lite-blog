import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
// A real primary (Fastify app on a random port, isolated DATA_DIR) and a real replica agent/server in another temp dir.
const primaryDir=await fs.mkdtemp(path.join(os.tmpdir(),'undefim-primary-'));const replicaDir=await fs.mkdtemp(path.join(os.tmpdir(),'undefim-replica-'));
process.env.DATA_DIR=primaryDir;process.env.COOKIE_SECURE='false';process.env.TRUST_PROXY='true';process.env.APP_REVISION='a'.repeat(40);
const {db,saveDocument,document}=await import('../server/db.mjs');const {buildRelease,settledBuilds}=await import('../server/publish.mjs');const {passwordHash}=await import('../server/auth.mjs');
const {createApp}=await import('../server/index.mjs');const {setReplicaRunner}=await import('../server/replica-build.mjs');
const {createAgent}=await import('../replica/agent.mjs');const {createReplicaServer}=await import('../replica/server.mjs');

// Stand-in for Astro: a page per document of the snapshot, the site URL it was built for, and a shared asset.
const pageRunner=async(site,append,row)=>{const snapshot=JSON.parse(await fs.readFile(path.join(path.dirname(site),'content.json'),'utf8'));await fs.mkdir(path.join(site,'_astro'),{recursive:true});await fs.writeFile(path.join(site,'_astro/app.js'),'console.log("shared")');await fs.writeFile(path.join(site,'index.html'),`<p>${row?row.site_url:'primary'}</p><ul>${snapshot.documents.map(d=>`<li>${d.title}</li>`).join('')}</ul>`);await fs.writeFile(path.join(site,'404.html'),'<p>404</p>');for(const d of snapshot.documents){await fs.mkdir(path.join(site,d.path),{recursive:true});await fs.writeFile(path.join(site,d.path,'index.html'),`<h1>${d.title}</h1>${d.markdown}`)}};
setReplicaRunner(pageRunner);
async function publish(changes){const id=randomUUID();db.prepare('INSERT INTO jobs(id,status,created_at) VALUES (?,?,?)').run(id,'queued',new Date().toISOString());await buildRelease(id,changes,pageRunner);assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(id).status,'success');await settledBuilds();return id}
async function allText(root){let out='';for(const entry of await fs.readdir(root,{withFileTypes:true,recursive:true}))if(entry.isFile())out+=await fs.readFile(path.join(entry.parentPath,entry.name),'utf8');return out}
const exists=f=>fs.access(f).then(()=>true,()=>false);

const app=await createApp();await app.listen({port:0,host:'127.0.0.1'});const primaryUrl=`http://127.0.0.1:${app.server.address().port}`;
db.prepare('INSERT INTO users VALUES (?,?)').run('admin',passwordHash('test-password-long-enough'));
const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'admin',password:'test-password-long-enough'}});
const admin={cookie:login.headers['set-cookie'].split(';')[0],'x-csrf-token':login.json().csrf};
const adminApi=(method,url,payload)=>app.inject({method,url,headers:admin,payload});
const logs=[];const agent=()=>createAgent({dataDir:replicaDir,primaryUrl,enrollCode:state.code,revision:'b'.repeat(40),log:m=>logs.push(m)});
const state={};let replicaServer,replicaUrl;
test.after(async()=>{await app.close();if(replicaServer)await new Promise(r=>replicaServer.close(r))});

const base={kind:'post',format:'markdown',date:'2026-01-01T00:00:00.000Z',categories:[],tags:[],visibility:'public',allowComment:true,author:'undefim'};
test('后台填写主站与子站地址后生成一次性部署命令，地址经过校验',async()=>{
 state.a=saveDocument({...base,title:'文章甲',path:'/archives/a',markdown:'甲正文'},'test',true);
 state.b=saveDocument({...base,title:'文章乙',path:'/archives/b',markdown:'乙正文'},'test',true);
 state.page=saveDocument({...base,kind:'page',title:'关于',path:'/about',markdown:'关于页'},'test',true);
 saveDocument({...base,title:'私密',path:'/archives/secret',visibility:'private',markdown:'PRIVATE-SECRET-MARKER'},'test',true);
 await fs.mkdir(path.join(primaryDir,'media/upload/ns'),{recursive:true});await fs.writeFile(path.join(primaryDir,'media/upload/ns/pic.png'),'png-bytes');
 await publish([state.a,state.b,state.page].map(d=>({id:d.id,data:document(d.id)})));
 saveDocument({...document(state.a.id),markdown:'DRAFT-MARKER 未发布'});
 for(const bad of [{name:'x',primaryUrl:'ftp://a',siteUrl:'https://m.example.com'},{name:'x',primaryUrl:primaryUrl,siteUrl:'https://m.example.com/path'},{name:'x',primaryUrl:primaryUrl,siteUrl:primaryUrl},{name:'x',primaryUrl:"https://a.example.com'; rm -rf /",siteUrl:'https://m.example.com'}])assert.equal((await adminApi('POST','/api/replicas',bad)).statusCode,400,JSON.stringify(bad));
 assert.equal((await app.inject({method:'POST',url:'/api/replicas',payload:{name:'x',primaryUrl,siteUrl:'https://m.example.com'}})).statusCode,401,'需要登录');
 const created=await adminApi('POST','/api/replicas',{name:'海外子站',primaryUrl,siteUrl:'https://mirror.example.com'});assert.equal(created.statusCode,200,created.body);
 const body=created.json();state.id=body.replica.id;state.code=body.code;
 assert.match(body.code,/^[A-Z0-9x]{5}(-[A-Z0-9x]{5}){3}$/i);
 assert.match(body.command,/^git clone https:\/\/github\.com\/undefim\/undefim-lite-blog\.git blog-replica && cd blog-replica &&/);
 assert.ok(body.command.includes(`'PRIMARY_URL=${primaryUrl}'`)&&body.command.includes("'SITE_URL=https://mirror.example.com'")&&body.command.includes(`'ENROLL_CODE=${body.code}'`)&&body.command.endsWith('docker compose -f compose.replica.yaml up -d --build'));
 const listed=(await adminApi('GET','/api/replicas')).json();assert.equal(listed.replicas[0].status,'pending');assert.equal(listed.replicas[0].enroll_hash,undefined);assert.equal(listed.replicas[0].token_hash,undefined);
 assert.equal((await adminApi('POST','/api/replicas',{name:'重复',primaryUrl,siteUrl:'https://mirror.example.com'})).statusCode,409);
});

test('子站用认证码接入后拉取按子站地址构建的页面，私密与草稿不外泄；认证码不能重复使用',async()=>{
 const a=agent();await a.enroll();await settledBuilds();
 const creds=JSON.parse(await fs.readFile(path.join(replicaDir,'replica.json'),'utf8'));assert.equal(creds.siteUrl,'https://mirror.example.com');
 assert.equal(((await fs.stat(path.join(replicaDir,'replica.json'))).mode&0o777),0o600);
 const result=await a.syncOnce();assert.equal(result.state,'synced',JSON.stringify(result));
 assert.match(await fs.readFile(path.join(replicaDir,'current/site/index.html'),'utf8'),/mirror\.example\.com/);
 assert.match(await fs.readFile(path.join(replicaDir,'current/site/archives/a/index.html'),'utf8'),/甲正文/);
 assert.equal(await fs.readFile(path.join(replicaDir,'media/upload/ns/pic.png'),'utf8'),'png-bytes');
 assert.ok((await fs.readlink(path.join(replicaDir,'current'))).startsWith('releases/'));
 const text=await allText(replicaDir);assert.doesNotMatch(text,/PRIVATE-SECRET-MARKER/);assert.doesNotMatch(text,/DRAFT-MARKER/);
 assert.ok(!(await fs.readdir(replicaDir)).some(n=>n.endsWith('.sqlite')));
 assert.equal((await a.syncOnce()).state,'up-to-date');
 const again=await fetch(primaryUrl+'/api/replica/v1/enroll',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:state.code})});assert.equal(again.status,401);
 const row=(await adminApi('GET','/api/replicas')).json().replicas[0];assert.equal(row.status,'active');assert.equal(row.synced,true);assert.equal(row.reported_revision,'b'.repeat(40));
});

test('文章范围支持排除与只显示选中两种模式，页面始终保留，新发布文章按模式处理',async()=>{
 const a=agent();
 const save=(mode,documentIds)=>adminApi('PUT',`/api/replicas/${state.id}`,{name:'海外子站',siteUrl:'https://mirror.example.com',mode,documentIds});
 assert.equal((await save('all',[state.b.id])).statusCode,200);await settledBuilds();await a.syncOnce();
 assert.ok(await exists(path.join(replicaDir,'current/site/archives/a/index.html')));assert.ok(!await exists(path.join(replicaDir,'current/site/archives/b/index.html')));assert.ok(await exists(path.join(replicaDir,'current/site/about/index.html')));
 assert.equal((await save('selected',[state.b.id])).statusCode,200);await settledBuilds();const r=await a.syncOnce();assert.equal(r.state,'synced');assert.ok(r.reused>0,'未变化文件应复用');
 assert.ok(!await exists(path.join(replicaDir,'current/site/archives/a/index.html')));assert.ok(await exists(path.join(replicaDir,'current/site/archives/b/index.html')));assert.ok(await exists(path.join(replicaDir,'current/site/about/index.html')));
 const c=saveDocument({...base,title:'文章丙',path:'/archives/c',markdown:'丙正文'},'test',true);await publish([{id:c.id,data:document(c.id)}]);await a.syncOnce();
 assert.ok(!await exists(path.join(replicaDir,'current/site/archives/c/index.html')),'只显示选中模式下新文章默认不显示');
 assert.equal((await save('all',[])).statusCode,200);await settledBuilds();await a.syncOnce();
 assert.ok(await exists(path.join(replicaDir,'current/site/archives/c/index.html')));
 assert.equal((await save('all',['missing-id'])).statusCode,400);
 // Appearance, header and footer overrides go into this replica's snapshot only.
 const custom=(settings)=>adminApi('PUT',`/api/replicas/${state.id}`,{name:'海外子站',siteUrl:'https://mirror.example.com',mode:'all',documentIds:[],settings});
 for(const bad of [{siteTheme:'unknown'},{other:'x'},{navigation:[{label:'x',href:'javascript:alert(1)'}]},{title:''}])assert.equal((await custom(bad)).statusCode,400,JSON.stringify(bad));
 assert.equal((await custom({siteTheme:'kiln',title:'子站标题',navigation:[{label:'首页',href:'/'}],icpRecord:'',publicSecurityRecord:'子站公安备案'})).statusCode,200);await settledBuilds();await a.syncOnce();
 const replicaSettings=JSON.parse(await fs.readFile(path.join(replicaDir,'current/content.json'),'utf8')).settings;
 assert.equal(replicaSettings.siteTheme,'kiln');assert.equal(replicaSettings.title,'子站标题');assert.deepEqual(replicaSettings.navigation,[{label:'首页',href:'/'}]);assert.equal(replicaSettings.icpRecord,'');assert.equal(replicaSettings.publicSecurityRecord,'子站公安备案');
 const primarySettings=JSON.parse(await fs.readFile(path.join(primaryDir,'current/content.json'),'utf8')).settings;assert.notEqual(primarySettings.title,'子站标题','主站不受影响');
 assert.deepEqual((await adminApi('GET','/api/replicas')).json().replicas.find(r=>r.id===state.id).settings.title,'子站标题');
 assert.ok((await fs.readdir(path.join(replicaDir,'releases'))).length<=3,'子站只保留最近的版本');
});

test('子站服务只提供浏览，评论经子站转发写入主站并按读者 IP 限流',async()=>{
 replicaServer=createReplicaServer({dataDir:replicaDir,agent:agent(),revision:'b'.repeat(40),trustProxy:true});await new Promise(r=>replicaServer.listen(0,'127.0.0.1',r));replicaUrl=`http://127.0.0.1:${replicaServer.address().port}`;
 const home=await fetch(replicaUrl+'/');assert.equal(home.status,200);assert.match(await home.text(),/mirror/);
 assert.equal((await fetch(replicaUrl+'/archives/a')).status,200);assert.equal((await fetch(replicaUrl+'/nope')).status,404);
 assert.equal((await fetch(replicaUrl+'/upload/ns/pic.png')).headers.get('cache-control'),'public, max-age=31536000, immutable');
 const adminRedirect=await fetch(replicaUrl+'/admin/',{redirect:'manual'});assert.equal(adminRedirect.status,302);assert.equal(adminRedirect.headers.get('location'),primaryUrl+'/admin/');
 for(const url of ['/api/documents','/api/replicas','/%61pi/documents','/../replica.json','/replica.json','/.env'])assert.equal((await fetch(replicaUrl+url)).status,404,url);
 assert.equal((await fetch(replicaUrl+'/archives/a',{method:'POST'})).status,405);
 const health=await (await fetch(replicaUrl+'/api/health')).json();assert.equal(health.role,'replica');assert.equal(health.enrolled,true);assert.equal(health.publishing,0);
 const post=(ip,content,origin='https://mirror.example.com')=>fetch(`${replicaUrl}/api/public/documents/${state.a.id}/comments`,{method:'POST',headers:{'content-type':'application/json',origin,'x-forwarded-for':ip},body:JSON.stringify({author:'读者',content})});
 assert.equal((await post('203.0.113.1','来源不对','https://evil.example')).status,403);
 for(let i=0;i<3;i++)assert.equal((await post('203.0.113.1',`读者一的评论 ${i}`)).status,200);
 assert.equal((await post('203.0.113.1','超出限制')).status,429,'同一读者受限');
 assert.equal((await post('203.0.113.2','另一位读者')).status,200,'不同读者不受影响');
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM comments WHERE content LIKE '读者一的评论%' OR content='另一位读者'").get().n,4);
 const like=await fetch(`${replicaUrl}/api/public/documents/${state.a.id}/like`,{method:'POST',headers:{'x-forwarded-for':'203.0.113.3'}});assert.equal(like.status,200);assert.match(like.headers.get('set-cookie')||'',/like_/);
 // Page views forwarded by the replica are attributed to that replica, keep one visitor per cookie and classify sources.
 const view=(ip,referrer,cookie)=>fetch(`${replicaUrl}/api/public/pageview`,{method:'POST',headers:{'content-type':'application/json','user-agent':'Mozilla/5.0 Test',origin:'https://mirror.example.com','x-forwarded-for':ip,...(cookie?{cookie}:{})},body:JSON.stringify({path:'/archives/a',referrer})});
 const first=await view('203.0.113.4','https://www.google.com/search?q=x');assert.equal(first.status,200);const vid=/bvid=[a-f0-9]{32}/.exec(first.headers.get('set-cookie')||'')?.[0];assert.ok(vid,'子站转发访客 Cookie');
 assert.equal((await view('203.0.113.4','https://mirror.example.com/',`blog_session=x; ${vid}`)).status,200);
 assert.equal((await fetch(`${replicaUrl}/api/public/pageview`)).status,404);
 const views=db.prepare("SELECT site_id,source_type,source,visitor FROM visit_events WHERE path='/archives/a' ORDER BY id").all();
 assert.deepEqual(views.map(v=>[v.site_id,v.source_type,v.source]),[[state.id,'search','Google'],[state.id,'internal','']]);assert.equal(views[0].visitor,views[1].visitor);
 const report=(await adminApi('GET',`/api/analytics?site=${state.id}&days=1`)).json();
 assert.equal(report.sites.find(s=>s.id===state.id).windows[1].visitors,1);assert.equal(report.sites.find(s=>s.id==='').windows[1].pageviews,0);assert.equal(report.summary.pageviews,2);assert.deepEqual(report.sources.map(s=>s.source),['Google']);
 const forgedView=await app.inject({method:'POST',url:'/api/public/pageview',headers:{authorization:`Replica ${state.id}.forged-token-forged-token-forged`},payload:{path:'/'}});assert.equal(forgedView.statusCode,401);
 const forged=await app.inject({method:'POST',url:`/api/public/documents/${state.a.id}/like`,headers:{authorization:`Replica ${state.id}.forged-token-forged-token-forged`,'x-replica-client-ip':'198.51.100.9'}});assert.equal(forged.statusCode,401);
});

test('主站接口拒绝越权与路径穿越',async()=>{
 const creds=JSON.parse(await fs.readFile(path.join(replicaDir,'replica.json'),'utf8'));const auth={authorization:`Replica ${creds.replicaId}.${creds.token}`};
 assert.equal((await fetch(primaryUrl+'/api/replica/v1/manifest?build=x',{headers:{authorization:`Replica ${creds.replicaId}.wrong-token-wrong-token-wrong`}})).status,401);
 const row=db.prepare('SELECT build_id FROM replica_sites WHERE id=?').get(creds.replicaId);
 for(const p of ['../../../blog.sqlite','../content.json/../../x','sync-manifest.json','/etc/passwd'])assert.ok([400,404].includes((await fetch(primaryUrl+'/api/replica/v1/file?'+new URLSearchParams({build:row.build_id,path:p}),{headers:auth})).status),p);
 for(const p of ['upload/../blog.sqlite','blog.sqlite','backups/x.zip'])assert.ok([400,404].includes((await fetch(primaryUrl+'/api/replica/v1/media?'+new URLSearchParams({path:p}),{headers:auth})).status),p);
 // Another replica's build is not reachable with this credential.
 const other=(await adminApi('POST','/api/replicas',{name:'另一个',primaryUrl,siteUrl:'https://other.example.com'})).json();
 const enrolled=await (await fetch(primaryUrl+'/api/replica/v1/enroll',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:other.code})})).json();await settledBuilds();
 const otherBuild=db.prepare('SELECT build_id FROM replica_sites WHERE id=?').get(enrolled.replicaId).build_id;assert.ok(otherBuild);
 assert.equal((await fetch(primaryUrl+'/api/replica/v1/manifest?build='+otherBuild,{headers:auth})).status,404);
 assert.equal((await adminApi('DELETE',`/api/replicas/${enrolled.replicaId}`)).statusCode,200);
 assert.ok(!await exists(path.join(primaryDir,'replica-builds',enrolled.replicaId)));
});

test('主站发起子站更新：子站把固定目标版本交给自己的更新执行器并回报结果',async()=>{
 const a=agent();
 const requested=await adminApi('POST',`/api/replicas/${state.id}/update`);assert.equal(requested.statusCode,202);assert.equal(requested.json().update_status,'requested');
 await a.syncOnce();
 const request=JSON.parse(await fs.readFile(path.join(replicaDir,'system-update/request.json'),'utf8'));
 assert.equal(request.revision,'a'.repeat(40));assert.equal(request.trigger,'manual');
 // Simulate the replica's updater finishing the job.
 await fs.writeFile(path.join(replicaDir,'system-update/status.json'),JSON.stringify({job:{id:request.id,status:'success',message:'子站程序已更新'}}));await fs.rm(path.join(replicaDir,'system-update/request.json'));
 await a.syncOnce();
 const row=(await adminApi('GET','/api/replicas')).json().replicas.find(r=>r.id===state.id);assert.equal(row.update_status,'success');
 await a.syncOnce();assert.ok(!await exists(path.join(replicaDir,'system-update/request.json')),'完成后不会再次请求');
 const saved=process.env.APP_REVISION;process.env.APP_REVISION='unknown';try{assert.equal((await adminApi('POST',`/api/replicas/${state.id}/update`)).statusCode,409)}finally{process.env.APP_REVISION=saved}
});

test('吊销后子站无法同步或转发评论，已同步页面继续可访问',async()=>{
 assert.equal((await adminApi('POST',`/api/replicas/${state.id}/revoke`)).statusCode,200);
 await assert.rejects(agent().syncOnce(),/401/);
 assert.equal((await fetch(replicaUrl+'/')).status,200);
 const comment=await fetch(`${replicaUrl}/api/public/documents/${state.a.id}/comments`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({author:'读者',content:'吊销后'})});assert.equal(comment.status,401);
 const regenerated=(await adminApi('POST',`/api/replicas/${state.id}/code`,{primaryUrl})).json();assert.equal(regenerated.replica.status,'pending');assert.ok(regenerated.code);
});

test('域名拒绝命令注入和公网明文，部署固定提交并保护环境文件',async()=>{
 for(const host of ["https://x'$(id)'",'https://$HOME.example','http://public.example']){
  const r=await adminApi('POST','/api/replicas',{name:'unsafe',primaryUrl:host,siteUrl:'https://safe.example'});assert.equal(r.statusCode,400,host);
 }
 const r=(await adminApi('POST','/api/replicas',{name:'pinned',primaryUrl,siteUrl:'https://pin.example'})).json();
 assert.ok(r.command.includes('git reset --hard '+'a'.repeat(40)));assert.ok(r.command.includes('umask 077'));assert.ok(r.command.includes('git rev-parse HEAD'));
 await adminApi('DELETE',`/api/replicas/${r.replica.id}`);
});

test('更改文章范围立即拒绝旧构建下载，构建中改规则不发布过时产物',async()=>{
 const made=(await adminApi('POST','/api/replicas',{name:'race',primaryUrl,siteUrl:'https://race.example'})).json();
 const en=await (await fetch(primaryUrl+'/api/replica/v1/enroll',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:made.code})})).json();await settledBuilds();
 const old=db.prepare('SELECT build_id FROM replica_sites WHERE id=?').get(en.replicaId).build_id;
 let entered,release;const started=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
 setReplicaRunner(async(...args)=>{entered();await wait;return pageRunner(...args)});
 const save=ids=>adminApi('PUT',`/api/replicas/${en.replicaId}`,{name:'race',siteUrl:'https://race.example',mode:'selected',documentIds:ids});
 await save([state.a.id]);await started;
 const auth={authorization:`Replica ${en.replicaId}.${en.token}`};
 assert.equal((await fetch(primaryUrl+'/api/replica/v1/manifest?build='+old,{headers:auth})).status,404);
 await save([state.b.id]);setReplicaRunner(pageRunner);release();await settledBuilds();
 const next=db.prepare('SELECT build_id FROM replica_sites WHERE id=?').get(en.replicaId).build_id;
 const snap=JSON.parse(await fs.readFile(path.join(primaryDir,'replica-builds',en.replicaId,next,'content.json'),'utf8'));
 assert.ok(!snap.documents.some(d=>d.id===state.a.id));assert.ok(snap.documents.some(d=>d.id===state.b.id));
 await adminApi('DELETE',`/api/replicas/${en.replicaId}`);
});

test('子站公开代理不转发后台 Cookie，也不接受上游设置后台 Cookie',async()=>{
 let sent;const server=createReplicaServer({dataDir:replicaDir,agent:{credentials:async()=>({siteUrl:'https://safe.example',primaryUrl:'https://primary.example',replicaId:'test',token:'test'})},fetchImpl:async(url,options)=>{sent=options.headers;return new Response('{}',{headers:{'content-type':'application/json','set-cookie':'blog_session=should-not-pass; Path=/'}})}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
 const url=`http://127.0.0.1:${server.address().port}`;
 const response=await fetch(url+'/api/public/documents/test/like',{method:'POST',headers:{cookie:'blog_session=private; visit_abcdef123456=1; other=secret'}});
 assert.equal(response.status,200);assert.equal(sent.cookie,'visit_abcdef123456=1');assert.equal(response.headers.get('set-cookie'),null);
 assert.equal((await fetch(url+'/api/public/arbitrary',{method:'POST'})).status,404);
 const id='0123456789abcdef0123456789abcdef';await fetch(url+'/api/public/pageview',{method:'POST',headers:{cookie:`blog_session=private; bvid=${id}; other=secret`},body:'{}'});assert.equal(sent.cookie,`bvid=${id}`);
 }finally{await new Promise(r=>server.close(r))}
});
