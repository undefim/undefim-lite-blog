import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
process.env.DATA_DIR=await fs.mkdtemp(path.join(os.tmpdir(),'undefim-uptime-'));process.env.COOKIE_SECURE='false';delete process.env.UPTIME_KUMA_URL;delete process.env.UPTIME_KUMA_SLUG;
const {uptimeConfig,summarize,createUptime}=await import('../server/uptime.mjs');

test('配置：需要合法的 http(s) 地址和 slug，否则视为未配置',()=>{
 assert.equal(uptimeConfig({}),null);
 assert.equal(uptimeConfig({UPTIME_KUMA_URL:'ftp://x.test',UPTIME_KUMA_SLUG:'main'}),null);
 assert.equal(uptimeConfig({UPTIME_KUMA_URL:'https://status.example.test',UPTIME_KUMA_SLUG:'../x'}),null);
 assert.deepEqual(uptimeConfig({UPTIME_KUMA_URL:'https://status.example.test/',UPTIME_KUMA_SLUG:'main'}),{pageUrl:'https://status.example.test/status/main',apiUrl:'https://status.example.test/api/status-page/heartbeat/main'});
});

test('汇总：按各监控最新心跳判断整体状态，优先 30 天可用率',()=>{
 assert.equal(summarize({}).status,'unknown');
 assert.deepEqual(summarize({heartbeatList:{1:[{status:0},{status:1}],2:[{status:1}]},uptimeList:{'1_24':1,'2_24':0.98}}),{status:'up',uptime:0.99,window:'24h'});
 assert.equal(summarize({heartbeatList:{1:[{status:1}],2:[{status:0}]}}).status,'degraded');
 assert.equal(summarize({heartbeatList:{1:[{status:3}]}}).status,'degraded');
 assert.equal(summarize({heartbeatList:{1:[{status:0}],2:[{status:0}]}}).status,'down');
 assert.deepEqual(summarize({heartbeatList:{1:[{status:1}]},uptimeList:{'1_24':1,'1_720':0.995}}),{status:'up',uptime:0.995,window:'30d'});
});

test('服务：缓存 60 秒、上游失败返回 unknown 且仍带状态页链接、只输出汇总字段',async()=>{
 let calls=0,t=0,fail=false;
 const fetchImpl=async()=>{calls++;if(fail)throw new Error('down');return {ok:true,json:async()=>({heartbeatList:{1:[{status:1,msg:'secret'}]},uptimeList:{'1_24':1}})}};
 const config=uptimeConfig({UPTIME_KUMA_URL:'https://status.example.test',UPTIME_KUMA_SLUG:'main'});
 const u=createUptime({config,fetchImpl,now:()=>t});
 const [a,b]=await Promise.all([u.status(),u.status()]);
 assert.equal(calls,1);assert.deepEqual(a,b);
 assert.deepEqual(a,{configured:true,status:'up',uptime:1,window:'24h',url:'https://status.example.test/status/main'});
 t=30_000;await u.status();assert.equal(calls,1);
 t=61_000;fail=true;const c=await u.status();assert.equal(calls,2);
 assert.equal(c.status,'unknown');assert.equal(c.url,'https://status.example.test/status/main');
 assert.deepEqual(await createUptime({config:null}).status(),{configured:false});
});

test('配置为函数时每次读取，地址变化立即换用新地址',async()=>{
 let env={UPTIME_KUMA_URL:'https://a.test',UPTIME_KUMA_SLUG:'main'};const urls=[];
 const u=createUptime({config:()=>uptimeConfig(env),fetchImpl:async url=>{urls.push(url);return {ok:true,json:async()=>({})}},now:()=>0});
 assert.equal((await u.status()).url,'https://a.test/status/main');
 env={UPTIME_KUMA_URL:'https://b.test',UPTIME_KUMA_SLUG:'ops'};
 assert.equal((await u.status()).url,'https://b.test/status/ops');assert.equal(urls.length,2);
 env={};assert.deepEqual(await u.status(),{configured:false});
});

test('后台设置：校验 Kuma 地址与 slug，保存后公开接口按设置返回',async()=>{
 const {db}=await import('../server/db.mjs');const {passwordHash}=await import('../server/auth.mjs');const {createApp}=await import('../server/index.mjs');
 const fetchImpl=globalThis.fetch;globalThis.fetch=async()=>({ok:true,json:async()=>({heartbeatList:{1:[{status:1}]},uptimeList:{'1_24':1}})});
 const app=await createApp();
 try{
  db.prepare('INSERT INTO users VALUES (?,?)').run('admin',passwordHash('test-password-long-enough'));
  const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'admin',password:'test-password-long-enough'}});
  const headers={cookie:login.headers['set-cookie'].split(';')[0],'x-csrf-token':login.json().csrf};
  assert.deepEqual((await app.inject({url:'/api/public/uptime'})).json(),{configured:false});
  assert.equal((await app.inject({method:'PUT',url:'/api/settings',headers,payload:{uptimeKumaUrl:'javascript:alert(1)'}})).statusCode,400);
  assert.equal((await app.inject({method:'PUT',url:'/api/settings',headers,payload:{uptimeKumaSlug:'../x'}})).statusCode,400);
  const saved=await app.inject({method:'PUT',url:'/api/settings',headers,payload:{uptimeKumaUrl:' https://status.example.test ',uptimeKumaSlug:'main'}});
  assert.equal(saved.statusCode,200);assert.equal(saved.json().uptimeKumaUrl,'https://status.example.test');
  assert.deepEqual((await app.inject({url:'/api/public/uptime'})).json(),{configured:true,status:'up',uptime:1,window:'24h',url:'https://status.example.test/status/main'});
 }finally{globalThis.fetch=fetchImpl;await app.close()}
});
