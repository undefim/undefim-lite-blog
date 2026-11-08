import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
process.env.DATA_DIR=await fs.mkdtemp(path.join(os.tmpdir(),'undefim-analytics-'));process.env.COOKIE_SECURE='false';
const {db}=await import('../server/db.mjs');const {passwordHash}=await import('../server/auth.mjs');const {createApp}=await import('../server/index.mjs');
import {gzipSync} from 'node:zlib';
const {createGeoip,openCountryDatabase,geoipUrls}=await import('../server/geoip.mjs');
const {migrateAnalyticsSchema,classifySource,cleanPath,createAnalytics,REPEAT_WINDOW_MINUTES}=await import('../server/analytics.mjs');

const app=await createApp();test.after(()=>app.close());
db.prepare('INSERT INTO users VALUES (?,?)').run('admin',passwordHash('test-password-long-enough'));
const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'admin',password:'test-password-long-enough'}});
const admin={cookie:login.headers['set-cookie'].split(';')[0]};
const ua='Mozilla/5.0 (Macintosh) Test';
const view=(payload,headers={})=>app.inject({method:'POST',url:'/api/public/pageview',headers:{'user-agent':ua,host:'blog.test',...headers},payload});

test('迁移幂等、只新增表，并拒绝更高版本或未登记的同名表',()=>{
 migrateAnalyticsSchema(db);migrateAnalyticsSchema(db);
 assert.deepEqual(db.prepare('SELECT version FROM analytics_schema_migrations').all().map(r=>r.version),[1,2]);
 assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 const future=new DatabaseSync(':memory:');migrateAnalyticsSchema(future);future.prepare('INSERT INTO analytics_schema_migrations VALUES (3,?)').run('x');
 assert.throws(()=>migrateAnalyticsSchema(future),/版本高于/);
 const stray=new DatabaseSync(':memory:');stray.exec('CREATE TABLE visit_events (id INTEGER)');
 assert.throws(()=>migrateAnalyticsSchema(stray),/未登记/);assert.equal(stray.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='analytics_schema_migrations'").get().n,0,'失败回滚');
});

test('来源分类：搜索、社区、外链、推广参数、直接与站内',()=>{
 const hosts=['blog.test'];
 assert.deepEqual(classifySource({referrer:'https://www.google.co.jp/',siteHosts:hosts}),{type:'search',source:'Google'});
 assert.deepEqual(classifySource({referrer:'https://m.baidu.com/s?wd=x',siteHosts:hosts}),{type:'search',source:'百度'});
 assert.deepEqual(classifySource({referrer:'https://linux.do/t/topic/1',siteHosts:hosts}),{type:'social',source:'LINUX DO'});
 assert.deepEqual(classifySource({referrer:'https://www.friend.example/links',siteHosts:hosts}),{type:'referral',source:'friend.example'});
 assert.deepEqual(classifySource({referrer:'https://x.example/',campaign:'Newsletter',siteHosts:hosts}),{type:'campaign',source:'newsletter'});
 assert.deepEqual(classifySource({referrer:'',siteHosts:hosts}),{type:'direct',source:''});
 assert.deepEqual(classifySource({referrer:'javascript:alert(1)',siteHosts:hosts}),{type:'direct',source:''});
 assert.deepEqual(classifySource({referrer:'https://blog.test/a',siteHosts:['blog.test:443']}),{type:'internal',source:''});
 assert.deepEqual(classifySource({referrer:'https://www.google.com/',campaign:'x',reload:true,siteHosts:hosts}),{type:'internal',source:''},'刷新不算新的进站');
 assert.equal(cleanPath('/archives/a?x=1#y'),'/archives/a');for(const bad of ['//evil.example','/admin/','/api/x','x','/a\\b'])assert.equal(cleanPath(bad),null,bad);
});

test('公开记录接口：同一 Cookie 计一位访客，忽略爬虫，拒绝无效路径，不保存 IP',async()=>{
 const first=await view({path:'/archives/hello',referrer:'https://www.bing.com/'});assert.equal(first.statusCode,200);
 const cookie=first.headers['set-cookie'].split(';')[0];assert.match(cookie,/^bvid=[a-f0-9]{32}$/);assert.match(first.headers['set-cookie'],/Path=\/api\/public/);assert.match(first.headers['set-cookie'],/HttpOnly/);
 assert.equal((await view({path:'/about',referrer:'http://blog.test/archives/hello'},{cookie})).statusCode,200);
 assert.equal((await view({path:'/about'},{'user-agent':'Googlebot/2.1'})).json().recorded,false);
 assert.equal((await view({path:'/admin/'})).statusCode,400);
 assert.equal((await view({path:'/'},{origin:'https://evil.example'})).statusCode,403);
 const rows=db.prepare('SELECT * FROM visit_events ORDER BY id').all();
 assert.equal(rows.length,2);assert.equal(rows[0].visitor,rows[1].visitor);assert.deepEqual(rows.map(r=>r.source_type),['search','internal']);
 assert.ok(!JSON.stringify(rows).includes('127.0.0.1'),'不保存 IP');assert.ok(rows.every(r=>r.site_id===''));
});

test('统计接口需要登录，按 1/7/30 天窗口和站点汇总，来源排除站内跳转',async()=>{
 assert.equal((await app.inject({url:'/api/analytics'})).statusCode,401);
 const now=Date.now(),day=86400000,a=createAnalytics(db);
 a.record({visitor:'old',path:'/a',source:{type:'search',source:'Google'},now:now-10*day});
 a.record({visitor:'old',path:'/a',source:{type:'direct',source:''},now:now-40*day});
 a.record({siteId:'gone-replica',visitor:'r1',path:'/a',source:{type:'referral',source:'friend.example'},now:now-2*day});
 const r=(await app.inject({url:'/api/analytics?site=all&days=30&tz=-480',headers:admin})).json();
 assert.equal(r.trend.length,30);
 const main=r.sites.find(s=>s.id==='');assert.deepEqual([main.windows[1].visitors,main.windows[7].visitors,main.windows[30].visitors],[1,1,2]);
 assert.equal(r.sites.find(s=>s.id==='gone-replica').removed,true,'已删除子站的历史数据仍可见');
 assert.equal(r.totals[30].visitors,3);assert.equal(r.summary.pageviews,4);assert.equal(r.summary.entries,3);
 assert.ok(!r.types.some(t=>t.type==='internal'));assert.deepEqual(r.sources.map(s=>s.source).sort(),['Bing','Google','friend.example']);
 const mainOnly=(await app.inject({url:'/api/analytics?site=main&days=7',headers:admin})).json();assert.equal(mainOnly.summary.pageviews,2);assert.equal(mainOnly.trend.length,7);
 assert.equal((await app.inject({url:'/api/analytics?site=nope&days=7',headers:admin})).statusCode,404);
 assert.equal((await app.inject({url:'/api/analytics?days=2',headers:admin})).statusCode,400);
});

test('刷新与 30 分钟内重复浏览同一页不重复计数，超时或换页后才计',async()=>{
 const cookie='bvid=0123456789abcdef0123456789abcdef',count=()=>db.prepare("SELECT COUNT(*) AS n FROM visit_events WHERE path LIKE '/repeat/%'").get().n;
 const landing=await view({path:'/repeat/a',referrer:'https://www.google.com/'},{cookie});assert.equal(landing.json().recorded,true);
 for(let i=0;i<5;i++)assert.equal((await view({path:'/repeat/a',referrer:'https://www.google.com/',reload:true},{cookie})).json().recorded,false);
 assert.equal((await view({path:'/repeat/b',referrer:'http://blog.test/repeat/a'},{cookie})).json().recorded,true);
 assert.equal((await view({path:'/repeat/a',referrer:'http://blog.test/repeat/b'},{cookie})).json().recorded,false,'来回切换也不重复');
 assert.equal(count(),2);
 // A reload of a page not yet recorded (e.g. after the window) is stored as internal traffic, not a search arrival.
 assert.equal((await view({path:'/repeat/c',referrer:'https://www.google.com/',reload:true},{cookie})).json().recorded,true);
 assert.equal(db.prepare("SELECT source_type FROM visit_events WHERE path='/repeat/c'").get().source_type,'internal');
 const a=createAnalytics(db),t=Date.now()+60*86400000;
 assert.equal(a.record({visitor:'w',path:'/repeat/w',source:{type:'direct'},now:t}),true);
 assert.equal(a.record({visitor:'w',path:'/repeat/w',source:{type:'direct'},now:t+(REPEAT_WINDOW_MINUTES-1)*60000}),false);
 assert.equal(a.record({visitor:'w',path:'/repeat/w',source:{type:'direct'},now:t+(REPEAT_WINDOW_MINUTES+1)*60000}),true,'超过窗口再计');
 assert.equal(a.record({siteId:'other',visitor:'w',path:'/repeat/w',source:{type:'direct'},now:t+(REPEAT_WINDOW_MINUTES+2)*60000}),true,'不同站点分别计');
 db.prepare("DELETE FROM visit_events WHERE path='/repeat/w'").run();
});

test('v1 统计库升级到 v2：新增 country 列，保留已有记录且记为未知',()=>{
 const old=new DatabaseSync(':memory:');
 old.exec(`CREATE TABLE analytics_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);INSERT INTO analytics_schema_migrations VALUES (1,'2026-11-08');
 CREATE TABLE visit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id TEXT NOT NULL DEFAULT '', visitor TEXT NOT NULL, path TEXT NOT NULL, source_type TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
 INSERT INTO visit_events(visitor,path,source_type,created_at) VALUES ('v','/old','direct',1);`);
 migrateAnalyticsSchema(old);migrateAnalyticsSchema(old);
 assert.deepEqual(old.prepare('SELECT version FROM analytics_schema_migrations ORDER BY version').all().map(r=>r.version),[1,2]);
 assert.deepEqual({...old.prepare('SELECT path,country FROM visit_events').get()},{path:'/old',country:''});
});

test('按 IP 记录国家/地区：只存国家代码，统计接口返回国家分布与 IP 库状态',async()=>{
 const seen=[];const geoip={load:async()=>true,country:ip=>{seen.push(ip);return ip==='198.51.100.7'?'JP':''},status:()=>({available:true,build:'2026-11-01T00:00:00.000Z',source:{name:'DB-IP',url:'https://db-ip.com',license:'CC BY 4.0'}})};
 const geoApp=await createApp({geoip});try{
 const send=(ip,path)=>geoApp.inject({method:'POST',url:'/api/public/pageview',remoteAddress:ip,headers:{'user-agent':ua,host:'blog.test'},payload:{path}});
 assert.equal((await send('198.51.100.7','/geo/a')).json().recorded,true);assert.equal((await send('192.0.2.9','/geo/b')).json().recorded,true);
 assert.deepEqual(seen,['198.51.100.7','192.0.2.9']);
 assert.deepEqual(db.prepare("SELECT path,country FROM visit_events WHERE path LIKE '/geo/%' ORDER BY id").all().map(r=>[r.path,r.country]),[['/geo/a','JP'],['/geo/b','']]);
 assert.ok(!JSON.stringify(db.prepare("SELECT * FROM visit_events WHERE path LIKE '/geo/%'").all()).includes('198.51.100.7'),'不保存 IP');
 const r=(await geoApp.inject({url:'/api/analytics?site=main&days=1',headers:admin})).json();
 assert.equal(r.geoip.available,true);assert.ok(r.countries.some(c=>c.country==='JP'&&c.visitors===1));assert.ok(r.countries.some(c=>c.country===''));
 }finally{await geoApp.close()}
 const a=createAnalytics(db);assert.equal(a.record({visitor:'x',path:'/geo/bad',source:{type:'direct'},country:'<script>'}),true);
 assert.equal(db.prepare("SELECT country FROM visit_events WHERE path='/geo/bad'").get().country,'','非法国家代码记为未知');
});

test('IP 库下载失败或内容无效时不覆盖现有文件，未下载时查询返回未知',async()=>{
 const file=path.join(process.env.DATA_DIR,'geoip-test','country.mmdb');const logs=[];
 const bad=createGeoip({file,log:m=>logs.push(m),fetchImpl:async()=>new Response('not found',{status:404})});
 await bad.refresh();assert.equal(bad.status().available,false);assert.equal(bad.country('8.8.8.8'),'');assert.ok(logs.some(m=>m.includes('更新失败')));
 await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'previous');
 const garbage=createGeoip({file,log:()=>{},fetchImpl:async()=>new Response(gzipSync(Buffer.from('not a database')))});
 await assert.rejects(garbage.download());assert.equal(await fs.readFile(file,'utf8'),'previous','校验失败不替换');
 assert.throws(()=>openCountryDatabase(Buffer.from('x')));
 assert.match(geoipUrls(new Date(Date.UTC(2026,0,15)))[1],/dbip-country-lite-2025-12\.mmdb\.gz$/,'跨年回退上月');
});

test('国家列表不截断，超过 30 个国家的占比仍包含完整数据',()=>{
 const local=new DatabaseSync(':memory:');migrateAnalyticsSchema(local);const analytics=createAnalytics(local);
 for(let i=0;i<35;i++)analytics.record({visitor:`country-${i}`,path:'/',country:String.fromCharCode(65+Math.floor(i/26),65+i%26),source:{type:'direct'}});
 const report=analytics.report({days:1});assert.equal(report.countries.length,35);assert.equal(report.countries.reduce((sum,c)=>sum+c.visitors,0),35);local.close();
});

test('IP 库流式下载超限时提前终止并保留旧文件',async()=>{
 const file=path.join(process.env.DATA_DIR,'geoip-size','country.mmdb');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'previous');
 let cancelled=0,pulled=0;
 const geo=createGeoip({file,fetchImpl:async()=>new Response(new ReadableStream({pull(controller){pulled++;controller.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled++}}))});
 await assert.rejects(geo.download(),/下载文件过大/);assert.equal(cancelled,2,'本月与上月下载都应取消');assert.ok(pulled<140,'不能继续读取无限响应');assert.equal(await fs.readFile(file,'utf8'),'previous');
});
