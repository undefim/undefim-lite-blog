// Replica sync agent: enrolls once with a one-time code, then periodically reports its state to the primary and pulls
// the static build the primary made for it. Downloads are verified by size and SHA-256, unchanged files are hard-linked
// from the release being served, and data/current is switched atomically only after the whole build is in place.
import fs from 'node:fs/promises';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import {MANIFEST_NAME,currentRelease,resolveInside,safeRelative,validReleaseId,originOf,fileSha256} from '../server/replica-protocol.mjs';
import {publishUpdateRequest,readUpdateFile} from '../server/system-update.mjs';

const KEEP_RELEASES=3;
const fail=(message,extra={})=>Object.assign(new Error(message),extra);

export function createAgent({dataDir,primaryUrl,enrollCode,revision=null,log=()=>{},fetchImpl=fetch}){
 const credentialsFile=path.join(dataDir,'replica.json');
 let credentials=null,lastError=null;
 async function load(){if(credentials)return credentials;try{credentials=JSON.parse(await fs.readFile(credentialsFile,'utf8'))}catch(e){if(e.code!=='ENOENT')throw fail('data/replica.json 无法读取，请检查文件或重新接入')}return credentials}
 async function request(route,{method='GET',body,auth=true,timeout=60000}={}){
  const creds=auth?await load():null;const base=originOf(creds?.primaryUrl||primaryUrl,'主站地址');
  let response;try{response=await fetchImpl(base+route,{method,redirect:'error',signal:AbortSignal.timeout(timeout),headers:{...(auth?{authorization:`Replica ${creds.replicaId}.${creds.token}`}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined})}catch(e){throw fail(`无法连接主站 ${base}：${e.name==='TimeoutError'?'请求超时':'网络错误或证书无效'}`)}
  if(!response.ok){let message='';try{message=(await response.json()).message||''}catch{}throw fail(`主站返回 ${response.status}${message?`：${message}`:''}`,{status:response.status})}
  return response;
 }
 async function enroll(){
  if(await load())return credentials;
  if(!primaryUrl||!enrollCode)throw fail('尚未接入主站：请在 .env 中设置 PRIMARY_URL 和 ENROLL_CODE 后重启');
  const result=await (await request('/api/replica/v1/enroll',{method:'POST',auth:false,body:{code:enrollCode}})).json();
  if(!/^[0-9a-f-]{36}$/.test(result.replicaId||'')||typeof result.token!=='string')throw fail('主站返回的接入信息无效');
  const value={primaryUrl:result.primaryUrl||primaryUrl,replicaId:result.replicaId,token:result.token,siteUrl:result.siteUrl,name:result.name,enrolledAt:new Date().toISOString()};
  await fs.mkdir(dataDir,{recursive:true});const temp=`${credentialsFile}.${randomUUID()}.tmp`;await fs.writeFile(temp,JSON.stringify(value),{mode:0o600});await fs.rename(temp,credentialsFile);
  credentials=value;log(`已接入主站 ${value.primaryUrl}，子站地址 ${value.siteUrl}`);return value;
 }
 // Streams a primary file to a temp path, verifies it, then renames it into place.
 async function download(route,target,expected){
  const response=await request(route,{timeout:600000});await fs.mkdir(path.dirname(target),{recursive:true});
  const temp=path.join(path.dirname(target),`.sync-${randomUUID()}`);const hash=createHash('sha256');let size=0;const handle=await fs.open(temp,'wx',0o644);
  try{for await(const chunk of response.body){size+=chunk.length;if(size>expected.size)throw fail('下载文件超过清单大小');hash.update(chunk);await handle.writeFile(chunk)}
   if(size!==expected.size||expected.sha256&&hash.digest('hex')!==expected.sha256)throw fail(`文件校验失败：${path.basename(target)}`);
   await handle.close();await fs.rename(temp,target);
  }finally{await handle.close().catch(()=>{});await fs.rm(temp,{force:true})}
 }
 async function updateReport(){
  const status=await readUpdateFile(path.join(dataDir,'system-update','status.json')).catch(()=>null);const job=status?.job;
  return job?.id?{id:job.id,status:job.status,message:job.message||null}:null;
 }
 async function requestUpdate(update){
  if(!/^[a-f0-9-]{36}$/.test(update?.id||'')||!/^[a-f0-9]{40,64}$/.test(update?.revision||''))return;
  const status=await readUpdateFile(path.join(dataDir,'system-update','status.json')).catch(()=>null);if(status?.job?.id===update.id)return;
  try{await publishUpdateRequest(path.join(dataDir,'system-update'),{id:update.id,trigger:'manual',requestedAt:new Date().toISOString(),revision:update.revision});log(`已收到主站的更新请求，目标版本 ${update.revision.slice(0,7)}`)}catch(e){if(e.statusCode!==409)throw e}
 }
 async function pull(build){
  const manifest=await (await request('/api/replica/v1/manifest?'+new URLSearchParams({build}))).json();
  const files=Array.isArray(manifest.files)?manifest.files:[];
  if(!files.some(f=>f.path==='site/index.html'))throw fail('主站版本缺少首页');
  if(files.length>100000||!Array.isArray(manifest.media||[])||(manifest.media||[]).length>100000)throw fail('文件清单过大');
  const all=[...files,...(manifest.media||[])];if(all.reduce((n,f)=>n+(Number(f.size)||0),0)>20*1024**3)throw fail('同步体积超过限制');
  if(new Set(files.map(f=>f.path)).size!==files.length)throw fail('文件清单重复');
  for(const f of files)if(f.path===MANIFEST_NAME||!/^([a-f0-9]{64})$/.test(f.sha256||''))throw fail('文件清单无效');
  for(const f of all)if(!safeRelative(f?.path)||!Number.isSafeInteger(f.size)||f.size<0||f.size>1024**3)throw fail('主站清单含无效路径');
  // Media first: new pages may reference new uploads.
  const mediaRoot=path.join(dataDir,'media');let media=0;
  for(const m of manifest.media||[]){if(!m.path.startsWith('upload/'))continue;const target=resolveInside(mediaRoot,m.path);try{const s=await fs.lstat(target);if(s.isFile()&&s.size===m.size&&m.sha256&&await fileSha256(target)===m.sha256)continue}catch{}await download('/api/replica/v1/media?'+new URLSearchParams({path:m.path}),target,{size:m.size,sha256:m.sha256});media++}
  const releases=path.join(dataDir,'releases');await fs.mkdir(releases,{recursive:true});
  for(const name of await fs.readdir(releases))if(name.endsWith('.partial'))await fs.rm(path.join(releases,name),{recursive:true,force:true});
  const staging=path.join(releases,`${build}.partial`);await fs.mkdir(staging);
  const previous=new Map();const current=await currentRelease(dataDir);
  if(current)try{for(const f of JSON.parse(await fs.readFile(path.join(releases,current,MANIFEST_NAME),'utf8')).files||[])if(safeRelative(f.path))previous.set(f.sha256,path.join(releases,current,f.path))}catch{}
  let downloaded=0,reused=0;
  for(const f of files){
   if(!/^[a-f0-9]{64}$/.test(f.sha256||''))throw fail('主站清单缺少文件哈希');
   const target=resolveInside(staging,f.path);const source=previous.get(f.sha256);
   if(source){try{const s=await fs.stat(source);if(s.isFile()&&s.size===f.size){await fs.mkdir(path.dirname(target),{recursive:true});try{await fs.link(source,target)}catch{await fs.copyFile(source,target)}reused++;continue}}catch{}}
   await download('/api/replica/v1/file?'+new URLSearchParams({build,path:f.path}),target,f);downloaded++;
  }
  await fs.writeFile(path.join(staging,MANIFEST_NAME),JSON.stringify({build,files,receivedAt:new Date().toISOString()}));
  const final=path.join(releases,build);await fs.rm(final,{recursive:true,force:true});await fs.rename(staging,final);
  // Relative link target: resolves the same inside the container and on the host.
  const link=path.join(dataDir,`current-sync-${randomUUID()}`);await fs.symlink(path.join('releases',build),link);
  try{await fs.rename(link,path.join(dataDir,'current'))}catch(e){await fs.rm(link,{force:true});throw e}
  const old=(await fs.readdir(releases,{withFileTypes:true})).filter(e=>e.isDirectory()&&e.name!==build&&validReleaseId(e.name));
  const dated=await Promise.all(old.map(async e=>({name:e.name,time:(await fs.stat(path.join(releases,e.name))).mtimeMs})));
  for(const d of dated.sort((a,b)=>b.time-a.time).slice(KEEP_RELEASES-1))await fs.rm(path.join(releases,d.name),{recursive:true,force:true});
  return {build,downloaded,reused,media};
 }
 async function syncOnce(){
  await enroll();
  try{
   const release=await currentRelease(dataDir);
   const state=await (await request('/api/replica/v1/sync',{method:'POST',body:{release,revision,error:lastError,update:await updateReport()}})).json();
   if(state.siteUrl&&state.siteUrl!==credentials.siteUrl){credentials.siteUrl=originOf(state.siteUrl);const temp=`${credentialsFile}.tmp`;await fs.writeFile(temp,JSON.stringify(credentials),{mode:0o600});await fs.rename(temp,credentialsFile)}
   if(state.update)await requestUpdate(state.update);
   let result={state:'up-to-date',release};
   if(state.build&&validReleaseId(state.build)&&state.build!==release){const pulled=await pull(state.build);result={state:'synced',...pulled};log(`已切换到主站版本 ${pulled.build}：下载 ${pulled.downloaded} 个文件，复用 ${pulled.reused} 个，新增媒体 ${pulled.media} 个`)}
   lastError=null;return result;
  }catch(e){lastError=e.message;throw e}
 }
 return {enroll,syncOnce,credentials:load};
}
