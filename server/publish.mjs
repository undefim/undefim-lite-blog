import fs from 'node:fs/promises';import path from 'node:path';import {spawn} from 'node:child_process';import {randomUUID} from 'node:crypto';
import {db,dataDir,publicExport,document} from './db.mjs';
export const releaseDir=path.join(dataDir,'releases');
let queue=Promise.resolve(),pendingBuilds=0;
export const publishingCount=()=>pendingBuilds;
const now=()=>new Date().toISOString();
db.prepare("UPDATE jobs SET status='failed',finished_at=?,log=log||? WHERE status IN ('queued','running')").run(now(),'\n服务重启中断，当前版本保持不变。');
export function enqueueBuild(changes=[]) {
 const id=randomUUID();const captured=changes.map(c=>({...c,data:c.data?JSON.parse(JSON.stringify(c.data)):null}));
 db.prepare('INSERT INTO jobs(id,status,created_at) VALUES (?,?,?)').run(id,'queued',now());
 enqueueTask(()=>buildRelease(id,captured));return id;
}
// Every static build (site releases and replica builds) runs on this one in-process chain: one writer, one build at a time.
export function enqueueTask(task){pendingBuilds++;const run=queue.then(task);queue=run.catch(()=>{}).finally(()=>{pendingBuilds--});return run}
const publishedHooks=[];
// Called after a site release has switched successfully; failures are logged into the job, never undo the release.
export function onPublished(hook){publishedHooks.push(hook)}
export async function settledBuilds(){await queue}
export async function runAstro(snapshotFile,site,append,extraEnv={}){
 const env={...process.env,ASTRO_TELEMETRY_DISABLED:'1',CONTENT_SNAPSHOT:snapshotFile,BUILD_DIR:site,...extraEnv};
 await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['node_modules/astro/bin/astro.mjs','build'],{cwd:process.cwd(),env});let timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('构建超过 5 分钟，已停止'))},300000);child.stdout.on('data',b=>append(b.toString()));child.stderr.on('data',b=>append(b.toString()));child.on('error',reject);child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`静态构建失败 (${code})`))})});
}
export async function writeRedirectPages(site,redirects,siteUrl=process.env.SITE_URL||'https://undefi.me'){for(const r of redirects){const directory=path.join(site,r.path.slice(1));await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'index.html'),`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escape(r.target)}"><link rel="canonical" href="${escape(new URL(r.target,siteUrl).href)}"></head><body><a href="${escape(r.target)}">文章已迁移</a></body></html>`)}}
const escape=s=>s.replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
export async function buildRelease(id,changes=[],runner) {
 const target=path.join(releaseDir,id);await fs.mkdir(target,{recursive:true});
 let log='';const append=s=>{log=(log+s).slice(-80000);db.prepare('UPDATE jobs SET log=? WHERE id=?').run(log,id)};
 db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(id);
 try {
  const snapshot=publicExport();const redirects=db.prepare('SELECT * FROM redirects').all();
  for(const c of changes){snapshot.documents=snapshot.documents.filter(d=>d.id!==c.id);if(c.data){if(c.data.visibility==='private')throw new Error('私密文章不能公开发布');const d=document(c.id);if(!d||d.deletedAt)throw new Error('待发布文章已被移入回收站');const {source,...data}=c.data;snapshot.documents.push({...data,id:c.id,...db.prepare('SELECT visits,likes FROM stats WHERE document_id=?').get(c.id)});const old=JSON.parse(db.prepare('SELECT published_data FROM documents WHERE id=?').get(c.id).published_data||'null');if(old&&old.path!==data.path)redirects.push({path:old.path,target:data.path})}}
  if(new Set(snapshot.documents.map(d=>d.path)).size!==snapshot.documents.length)throw new Error('公开文章固定链接冲突');
  const snapshotFile=path.join(target,'content.json');await fs.writeFile(snapshotFile,JSON.stringify(snapshot));
  const site=path.join(target,'site');
  if(runner)await runner(site,append);else await runAstro(snapshotFile,site,append);
  await fs.access(path.join(site,'index.html'));
  // A CDN may still serve an older HTML page. Keep its hashed JS and CSS reachable.
  try{await fs.cp(path.join(dataDir,'current/site/_astro'),path.join(site,'_astro'),{recursive:true,force:false})}catch(e){if(e.code!=='ENOENT')throw e}
  const cleanRedirects=redirects.filter(r=>!snapshot.documents.some(d=>d.path===r.path));
  await writeRedirectPages(site,cleanRedirects);
  await fs.writeFile(path.join(target,'redirects.json'),JSON.stringify(cleanRedirects));
  const link=path.join(dataDir,`current-${id}`);await fs.symlink(target,link);
  let previousTarget=null;try{previousTarget=await fs.readlink(path.join(dataDir,'current'))}catch(e){if(e.code!=='ENOENT')throw e}
  let switched=false;db.exec('BEGIN IMMEDIATE');
  try{for(const c of changes){const row=db.prepare('SELECT data,published_data FROM documents WHERE id=?').get(c.id);if(row)db.prepare('UPDATE documents SET published_data=? WHERE id=?').run(c.data?JSON.stringify(c.data):null,c.id)}for(const r of cleanRedirects)db.prepare('INSERT INTO redirects VALUES (?,?) ON CONFLICT(path) DO UPDATE SET target=excluded.target').run(r.path,r.target);await fs.rename(link,path.join(dataDir,'current'));switched=true;db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');if(switched){if(previousTarget){await fs.symlink(previousTarget,link);await fs.rename(link,path.join(dataDir,'current'))}else await fs.unlink(path.join(dataDir,'current'))}throw e}
  db.prepare("UPDATE jobs SET status='success',finished_at=?,urls=? WHERE id=?").run(now(),JSON.stringify(snapshot.documents.map(d=>d.path)),id);
  append('\n静态版本切换完成。');
  for(const hook of publishedHooks){try{await hook(id)}catch(e){append(`\n子站构建排队失败：${e.message}`)}}
  if(process.env.CLOUDFLARE_ZONE_ID&&process.env.CLOUDFLARE_API_TOKEN){try{const response=await fetch(`https://api.cloudflare.com/client/v4/zones/${process.env.CLOUDFLARE_ZONE_ID}/purge_cache`,{method:'POST',headers:{Authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({purge_everything:true}),signal:AbortSignal.timeout(20000)});const result=await response.json();if(!result.success)throw new Error('CDN 返回失败');append('\nCDN 缓存刷新完成。')}catch{append('\nCDN 刷新失败，请在 CDN 控制台重试；新版本已保存在源站。')}}else append('\n未配置 CDN 自动刷新，HTML 缓存按有效期更新。');
 }catch(e){append(`\n${e.message}\n构建未切换，旧版本继续提供访问。`);db.prepare("UPDATE jobs SET status='failed',finished_at=? WHERE id=?").run(now(),id)}
}
export async function activeContent(){try{return JSON.parse(await fs.readFile(path.join(dataDir,'current/content.json'),'utf8'))}catch{return publicExport()}}
