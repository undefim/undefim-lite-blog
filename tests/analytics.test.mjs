import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
process.env.DATA_DIR=await fs.mkdtemp(path.join(os.tmpdir(),'undefim-analytics-'));process.env.COOKIE_SECURE='false';
const {db}=await import('../server/db.mjs');const {passwordHash}=await import('../server/auth.mjs');const {createApp}=await import('../server/index.mjs');
const {migrateAnalyticsSchema,classifySource,cleanPath,createAnalytics}=await import('../server/analytics.mjs');

const app=await createApp();test.after(()=>app.close());
db.prepare('INSERT INTO users VALUES (?,?)').run('admin',passwordHash('test-password-long-enough'));
const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'admin',password:'test-password-long-enough'}});
const admin={cookie:login.headers['set-cookie'].split(';')[0]};
const ua='Mozilla/5.0 (Macintosh) Test';
const view=(payload,headers={})=>app.inject({method:'POST',url:'/api/public/pageview',headers:{'user-agent':ua,host:'blog.test',...headers},payload});

test('迁移幂等、只新增表，并拒绝更高版本或未登记的同名表',()=>{
 migrateAnalyticsSchema(db);migrateAnalyticsSchema(db);
 assert.deepEqual(db.prepare('SELECT version FROM analytics_schema_migrations').all().map(r=>r.version),[1]);
 assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 const future=new DatabaseSync(':memory:');migrateAnalyticsSchema(future);future.prepare('INSERT INTO analytics_schema_migrations VALUES (2,?)').run('x');
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
