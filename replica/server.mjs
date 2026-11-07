// Lightweight replica site. No npm dependencies, no database, no admin: serves the static build pulled from the primary,
// public media, and forwards comment / visit / like requests to the primary with the replica credential.
import http from 'node:http';import fs from 'node:fs';import fsp from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {currentRelease} from '../server/replica-protocol.mjs';import {createAgent} from './agent.mjs';

const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.xml':'application/xml; charset=utf-8','.txt':'text/plain; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.ico':'image/x-icon','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.pdf':'application/pdf','.mp4':'video/mp4','.mp3':'audio/mpeg','.webmanifest':'application/manifest+json'};
const MAX_PROXY_BODY=64*1024;

export function createReplicaServer({dataDir,agent,revision=null,trustProxy=false,fetchImpl=fetch}){
 const json=(res,status,value,headers={})=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});res.end(JSON.stringify(value))};
 const isFile=async f=>{try{return (await fsp.stat(f)).isFile()}catch{return false}};
 const inside=(root,relative)=>{const file=path.resolve(root,relative);return file.startsWith(path.resolve(root)+path.sep)?file:null};
 function sendFile(req,res,file,status,cache){const stream=fs.createReadStream(file);stream.on('error',()=>res.destroy());res.writeHead(status,{'content-type':types[path.extname(file).toLowerCase()]||'application/octet-stream','cache-control':cache});if(req.method==='HEAD'){stream.destroy();return res.end()}stream.pipe(res)}
 const interactionCookie=value=>String(value||'').split(';').map(s=>s.trim()).filter(s=>/^(?:visit|like)_[a-f0-9]{12}=1$/.test(s)).join('; ');
 const clientIp=req=>{if(trustProxy){const forwarded=String(req.headers['x-forwarded-for']||'').split(',')[0].trim();if(forwarded)return forwarded}return req.socket.remoteAddress||''};
 async function proxy(req,res,creds,route){
  // Same-origin check for browser writes, mirroring the primary's Origin rule.
  if(req.method!=='GET'&&req.method!=='HEAD'&&req.headers.origin){const proto=trustProxy&&req.headers['x-forwarded-proto']?String(req.headers['x-forwarded-proto']).split(',')[0]:'http';if(![creds.siteUrl,`${proto}://${req.headers.host}`].includes(req.headers.origin))return json(res,403,{message:'请求来源无效'})}
  const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>MAX_PROXY_BODY)return json(res,413,{message:'请求过大'});chunks.push(chunk)}
  const headers={authorization:`Replica ${creds.replicaId}.${creds.token}`,'x-replica-client-ip':clientIp(req)};
  const cookiesIn=interactionCookie(req.headers.cookie);if(cookiesIn)headers.cookie=cookiesIn;
  for(const h of ['content-type','user-agent','accept'])if(req.headers[h])headers[h]=req.headers[h];
  let upstream;try{upstream=await fetchImpl(creds.primaryUrl+route,{method:req.method,headers,body:chunks.length?Buffer.concat(chunks):undefined,redirect:'manual',signal:AbortSignal.timeout(10000)})}catch{return json(res,502,{message:'暂时无法连接主站，请稍后重试'})}
  const out={'content-type':upstream.headers.get('content-type')||'application/json; charset=utf-8','cache-control':'no-store'};const cookies=(upstream.headers.getSetCookie?.()||[]).filter(s=>/^(?:visit|like)_[a-f0-9]{12}=1;/.test(s));if(cookies.length)out['set-cookie']=cookies;
  res.writeHead(upstream.status,out);res.end(Buffer.from(await upstream.arrayBuffer()));
 }
 async function handle(req,res){
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('X-Frame-Options','SAMEORIGIN');
  const url=new URL(req.url,'http://replica');let route;try{route=decodeURIComponent(url.pathname)}catch{return json(res,400,{message:'请求路径无效'})}
  if(route.includes('\0')||route.includes('\\')||route.split('/').some(s=>s.startsWith('.')))return json(res,404,{message:'页面不存在'});
  const creds=await agent.credentials().catch(()=>null);
  if(route==='/api/health')return json(res,200,{ok:true,role:'replica',revision,release:await currentRelease(dataDir),enrolled:Boolean(creds),publishing:0,writes:0});
  if(route.startsWith('/api/public/')){if(!/^\/api\/public\/documents\/[a-zA-Z0-9-]+\/(comments|visit|like)$/.test(route)||!['GET','POST','HEAD'].includes(req.method))return json(res,404,{message:'接口不存在'});if(!creds)return json(res,503,{message:'子站尚未接入主站'});return proxy(req,res,creds,url.pathname+url.search)}
  if(route==='/api'||route.startsWith('/api/'))return json(res,404,{message:'接口不存在'});
  if(route==='/admin'||route.startsWith('/admin/')){if(!creds)return json(res,404,{message:'页面不存在'});res.writeHead(302,{location:creds.primaryUrl+'/admin/','cache-control':'no-store'});return res.end()}
  if(req.method!=='GET'&&req.method!=='HEAD')return json(res,405,{message:'子站只提供浏览'});
  if(route.startsWith('/upload/')){const file=inside(path.join(dataDir,'media'),route.slice(1));if(file&&await isFile(file))return sendFile(req,res,file,200,'public, max-age=31536000, immutable');const bundled=inside(path.join(dataDir,'current/site'),route.slice(1));if(bundled&&await isFile(bundled))return sendFile(req,res,bundled,200,'public, max-age=31536000, immutable');return json(res,404,{message:'文件不存在'})}
  const root=path.join(dataDir,'current/site');
  if(!await isFile(path.join(root,'index.html'))){res.writeHead(503,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store','retry-after':'60'});return res.end(creds?'站点正在等待主站同步，请稍后访问。':'子站尚未接入主站。')}
  const relative=route.slice(1)||'index.html';let file=inside(root,relative);if(file&&!await isFile(file))file=inside(root,path.join(relative,'index.html'));
  if(!file||!await isFile(file)){const missing=path.join(root,'404.html');if(await isFile(missing))return sendFile(req,res,missing,404,'no-store');return json(res,404,{message:'页面不存在'})}
  return sendFile(req,res,file,200,route.startsWith('/_astro/')?'public, max-age=31536000, immutable':route.startsWith('/assets/')?'public, max-age=86400':'public, max-age=0, s-maxage=300, stale-while-revalidate=60');
 }
 return http.createServer((req,res)=>{handle(req,res).catch(()=>{if(!res.headersSent)json(res,500,{message:'服务暂时不可用'});else res.destroy()})});
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const dataDir=path.resolve(process.env.DATA_DIR||'./data');
 const revision=/^[a-f0-9]{40,64}$/.test(process.env.APP_REVISION||'')?process.env.APP_REVISION:null;
 const log=message=>console.log(`[${new Date().toISOString()}] ${message}`);
 const primaryUrl=(process.env.PRIMARY_URL||'').trim().replace(/\/+$/,'');
 if(primaryUrl&&!/^https?:\/\/[^/?#\s]+$/.test(primaryUrl)){console.error('PRIMARY_URL 必须是 http(s)://域名[:端口]');process.exit(1)}
 const agent=createAgent({dataDir,primaryUrl,enrollCode:(process.env.ENROLL_CODE||'').trim(),revision,log});
 const server=createReplicaServer({dataDir,agent,revision,trustProxy:process.env.TRUST_PROXY==='true'});
 server.listen(Number(process.env.PORT||4322),process.env.HOST||'127.0.0.1',()=>log('子站服务已启动'));
 const interval=Math.max(5,Number(process.env.SYNC_INTERVAL_SECONDS||20))*1000;let failures=0,stopping=false;
 const loop=async()=>{while(!stopping){try{await agent.syncOnce();if(failures)log('与主站的同步已恢复');failures=0}catch(e){failures++;log(`同步失败（第 ${failures} 次）：${e.message}`)}const wait=failures?Math.min(10*60*1000,interval*2**Math.min(failures,6)):interval;for(let t=0;t<wait&&!stopping;t+=500)await new Promise(r=>setTimeout(r,500))}};
 loop();
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopping=true;server.close(()=>process.exit(0))});
}
