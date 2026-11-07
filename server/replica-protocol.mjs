// Helpers shared by the primary's replica hub and the replica's sync agent. No database access.
import fs from 'node:fs/promises';import path from 'node:path';import {createHash,timingSafeEqual} from 'node:crypto';

export const MANIFEST_NAME='sync-manifest.json';
export const sha256=data=>createHash('sha256').update(data).digest('hex');
export async function fileSha256(file){const hash=createHash('sha256');const handle=await fs.open(file);try{for await(const chunk of handle.createReadStream())hash.update(chunk)}finally{await handle.close().catch(()=>{})}return hash.digest('hex')}
export function sameSecret(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y)}

// Relative POSIX path inside a sync root. Rejects absolute paths, traversal, hidden segments, backslashes and control
// characters; callers still resolve against the root and re-check containment.
export function safeRelative(value){
 if(typeof value!=='string'||!value||value.length>1024||value.startsWith('/')||value.includes('\\')||/[\u0000-\u001f\u007f]/.test(value))return false;
 return value.split('/').every(s=>s&&s!=='.'&&s!=='..'&&!s.startsWith('.'));
}
export function resolveInside(root,relative){if(!safeRelative(relative))throw Object.assign(new Error('同步路径无效'),{statusCode:400});const file=path.resolve(root,relative);if(!file.startsWith(path.resolve(root)+path.sep))throw Object.assign(new Error('同步路径越界'),{statusCode:400});return file}
export const validReleaseId=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(id);

// Regular files only; symlinks and other special files are skipped so a link can never pull anything else in.
export async function walkFiles(root,prefix=''){
 const out=[];let entries;try{entries=await fs.readdir(path.join(root,prefix),{withFileTypes:true})}catch(e){if(e.code==='ENOENT')return out;throw e}
 for(const entry of entries.sort((a,b)=>a.name<b.name?-1:1)){const relative=prefix?`${prefix}/${entry.name}`:entry.name;if(entry.isDirectory())out.push(...await walkFiles(root,relative));else if(entry.isFile())out.push(relative)}
 return out;
}
export async function currentRelease(dataDir){try{const id=path.basename(await fs.readlink(path.join(dataDir,'current')));return validReleaseId(id)?id:null}catch{return null}}

// Public origin (scheme://host[:port]) used for a site's own address and for the primary URL a replica connects to.
export function originOf(value,label='地址'){let url;try{url=new URL(String(value||'').trim())}catch{throw Object.assign(new Error(`${label}必须是完整的 http(s) 地址`),{statusCode:400})}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'&&url.pathname!==''||url.search||url.hash)throw Object.assign(new Error(`${label}只能是 http(s)://域名[:端口]，不含路径和参数`),{statusCode:400});if(!/^[a-zA-Z0-9.:[\]-]+$/.test(url.hostname))throw Object.assign(new Error(`${label}域名包含无效字符`),{statusCode:400});if(url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Object.assign(new Error(`${label}必须使用 HTTPS`),{statusCode:400});return url.origin}
