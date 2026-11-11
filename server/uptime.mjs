// Public service status from a self-hosted Uptime Kuma status page, shown as the footer status pill.
// The blog fetches the status page's public heartbeat API server-side (no CORS dependency, one upstream
// request per cache window) and exposes only an aggregate: overall state, uptime ratio and the page link.
// Monitor names, URLs and messages are never passed through.
const CACHE_MS=60_000,TIMEOUT_MS=5_000;

export function uptimeConfig(env=process.env){
 const slug=String(env.UPTIME_KUMA_SLUG||'').trim();let base;
 try{base=new URL(String(env.UPTIME_KUMA_URL||'').trim());if(!['http:','https:'].includes(base.protocol))base=null}catch{base=null}
 if(!base||!/^[a-z0-9-]+$/i.test(slug))return null;
 const root=base.origin+base.pathname.replace(/\/+$/,'');
 return {pageUrl:`${root}/status/${slug}`,apiUrl:`${root}/api/status-page/heartbeat/${slug}`};
}

// Kuma heartbeat status: 0 down, 1 up, 2 pending, 3 maintenance. Each monitor counts by its latest beat.
export function summarize(body){
 const lists=Object.values(body?.heartbeatList||{}).filter(Array.isArray);
 const latest=lists.map(list=>list.at(-1)?.status).filter(s=>Number.isInteger(s));
 if(!latest.length)return {status:'unknown',uptime:null,window:null};
 const down=latest.filter(s=>s===0).length,degraded=latest.filter(s=>s===2||s===3).length;
 const status=down===latest.length?'down':down||degraded?'degraded':'up';
 // Prefer the 30-day ratio (Kuma 2.x key "<id>_720"), otherwise the 24-hour one every version reports.
 const ratios=window=>Object.entries(body?.uptimeList||{}).filter(([k,v])=>k.endsWith(`_${window}`)&&Number.isFinite(v)).map(([,v])=>v);
 for(const [window,label] of [[720,'30d'],[24,'24h']]){const r=ratios(window);if(r.length)return {status,uptime:r.reduce((a,b)=>a+b,0)/r.length,window:label}}
 return {status,uptime:null,window:null};
}

// config is a value or a function (read on every call, so admin setting changes apply without restart).
export function createUptime({config=uptimeConfig(),fetchImpl=fetch,now=Date.now}={}){
 let cached=null,pending=null;
 async function refresh(config){
  try{
   const response=await fetchImpl(config.apiUrl,{signal:AbortSignal.timeout(TIMEOUT_MS),headers:{accept:'application/json'}});
   if(!response.ok)throw new Error(`HTTP ${response.status}`);
   return {...summarize(await response.json()),url:config.pageUrl};
  }catch{return {status:'unknown',uptime:null,window:null,url:config.pageUrl}}
 }
 return {
  async status(){
   const current=typeof config==='function'?config():config;
   if(!current)return {configured:false};
   if(cached&&cached.key===current.apiUrl&&now()-cached.at<CACHE_MS)return cached.value;
   if(pending?.key!==current.apiUrl){const key=current.apiUrl;const promise=refresh(current).then(value=>{cached={key,at:now(),value:{configured:true,...value}};return cached.value}).finally(()=>{if(pending?.promise===promise)pending=null});pending={key,promise}}
   return pending.promise;
  }
 };
}
