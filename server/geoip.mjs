// Offline IP -> country lookup for visitor analytics. Uses the free DB-IP "IP to Country Lite" database
// (CC BY 4.0, attribution shown in the admin analytics page), stored privately in DATA_DIR/geoip/country.mmdb.
// Visitor IPs are only looked up locally and never sent to a third party; only the country code is kept.
import fs from 'node:fs/promises';import path from 'node:path';import zlib from 'node:zlib';import {promisify} from 'node:util';import {Reader} from 'mmdb-lib';

const gunzip=promisify(zlib.gunzip);
const MAX_DOWNLOAD=64*1024*1024,MAX_AGE_DAYS=32;
export const geoipSource={name:'DB-IP',url:'https://db-ip.com',license:'CC BY 4.0'};
const month=date=>`${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}`;
export const geoipUrls=(now=new Date())=>[now,new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,1))].map(d=>`https://download.db-ip.com/free/dbip-country-lite-${month(d)}.mmdb.gz`);

// Reject anything that is not a working country database before it replaces the current file.
export function openCountryDatabase(buffer){
 const reader=new Reader(buffer);
 if(!/country/i.test(reader.metadata.databaseType||''))throw new Error('IP 库类型不是国家库');
 if(reader.get('8.8.8.8')?.country?.iso_code!=='US')throw new Error('IP 库校验失败');
 return reader;
}

export function createGeoip({file,fetchImpl=fetch,log=()=>{}}={}){
 let reader=null,mtime=0,updating=null;
 async function load(){
  try{const stat=await fs.stat(file);if(reader&&stat.mtimeMs===mtime)return true;reader=openCountryDatabase(await fs.readFile(file));mtime=stat.mtimeMs;return true}
  catch(e){if(e.code!=='ENOENT')log(`IP 库加载失败：${e.message}`);return Boolean(reader)}
 }
 async function download(){
  let lastError;
  for(const url of geoipUrls()){
   try{
    const response=await fetchImpl(url,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error(`下载失败 HTTP ${response.status}`);
    const size=Number(response.headers.get('content-length')||0);
    if(size>MAX_DOWNLOAD){await response.body?.cancel();throw new Error('下载文件过大')}
    if(!response.body)throw new Error('下载文件为空');
    const chunks=[];let received=0;
    for await(const chunk of response.body){received+=chunk.byteLength;if(received>MAX_DOWNLOAD)throw new Error('下载文件过大');chunks.push(Buffer.from(chunk))}
    const buffer=await gunzip(Buffer.concat(chunks),{maxOutputLength:MAX_DOWNLOAD*2});openCountryDatabase(buffer);
    await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const temp=`${file}.${process.pid}.partial`;
    try{await fs.writeFile(temp,buffer,{mode:0o600});await fs.rename(temp,file)}finally{await fs.rm(temp,{force:true})}
    log(`IP 库已更新：${url.split('/').pop()}`);return load();
   }catch(e){lastError=e}
  }
  throw lastError;
 }
 // Download when missing or older than MAX_AGE_DAYS (DB-IP publishes monthly). Failures keep the current file.
 async function refresh(){
  if(updating)return updating;
  updating=(async()=>{try{let stale=true;try{stale=Date.now()-(await fs.stat(file)).mtimeMs>MAX_AGE_DAYS*86400000}catch{}if(stale)await download();else await load()}catch(e){log(`IP 库更新失败，继续使用现有数据：${e.message}`)}finally{updating=null}})();
  return updating;
 }
 function start({autoUpdate=true}={}){
  load().then(()=>autoUpdate&&refresh());
  const timer=setInterval(()=>{autoUpdate?refresh():load()},24*3600*1000);timer.unref();return ()=>clearInterval(timer);
 }
 function country(ip){
  if(!reader||!ip)return '';
  try{const code=reader.get(String(ip).replace(/^::ffff:/,''))?.country?.iso_code;return /^[A-Z]{2}$/.test(code||'')?code:''}catch{return ''}
 }
 const status=()=>({available:Boolean(reader),build:reader?new Date(reader.metadata.buildEpoch).toISOString():null,source:geoipSource});
 return {load,download,refresh,start,country,status};
}
