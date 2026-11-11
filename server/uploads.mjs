import JSZip from 'jszip';import path from 'node:path';import fs from 'node:fs/promises';import {randomUUID,createHash} from 'node:crypto';
import {db,dataDir,validContentPath} from './db.mjs';import {importMarkdown} from './markdown.mjs';
const types={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.avif':'image/avif','.pdf':'application/pdf','.mp4':'video/mp4','.mp3':'audio/mpeg','.woff2':'font/woff2'};
export function safeArchivePath(name){return typeof name==='string'&&name.length<240&&!name.startsWith('/')&&!name.includes('\\')&&!name.includes('\0')&&!name.split('/').some(s=>!s||s==='.'||s==='..')&&!/^[A-Za-z]:/.test(name)}
export async function storeMedia(buffer,name,namespace=randomUUID()){
 const ext=path.extname(name).toLowerCase();if(!types[ext])throw new Error('仅支持图片、PDF、音视频与 WOFF2 字体');
 if(buffer.length>40*1024*1024)throw new Error('文件超过 40 MB');
 const safe=path.basename(name).normalize('NFKC').replace(/[^\p{L}\p{N}._-]/gu,'-');const url=`/upload/${namespace}/${randomUUID().slice(0,8)}-${safe}`;
 const file=path.join(dataDir,'media',url.slice(1));await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,buffer);
 const media={id:randomUUID(),name,path:url,type:types[ext],size:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex'),created_at:new Date().toISOString(),alt:''};
 db.prepare('INSERT INTO media (id,name,path,type,size,sha256,created_at) VALUES (?,?,?,?,?,?,?)').run(media.id,media.name,media.path,media.type,media.size,media.sha256,media.created_at);return media;
}
export async function markdownUpload(bytes,filename){
 if(bytes.length>40*1024*1024)throw new Error('上传超过 40 MB');
 let sources=[],assets=[];
 if(/\.zip$/i.test(filename)){
  const zip=await JSZip.loadAsync(bytes);const files=Object.values(zip.files).filter(f=>!f.dir&&!f.name.startsWith('__MACOSX/'));if(files.length>200)throw new Error('ZIP 最多 200 个文件');let expanded=0;
  for(const f of files){if(!safeArchivePath(f.unsafeOriginalName||f.name))throw new Error('ZIP 含不安全路径');const size=f._data?.uncompressedSize||0;expanded+=size;if(size>40*1024*1024||expanded>120*1024*1024)throw new Error('ZIP 解压体积超过限制');if(!/\.md$/i.test(f.name)&&!types[path.extname(f.name).toLowerCase()])throw new Error(`ZIP 不支持此文件类型：${f.name}`)}
  const buffers=[];for(const f of files){const b=await f.async('nodebuffer');buffers.push({name:f.name,bytes:b})}
  sources=buffers.filter(f=>/\.md$/i.test(f.name));if(!sources.length)throw new Error('ZIP 中没有 Markdown 文件');
  const docs=sources.map(s=>({filename:s.name,...importMarkdown(s.bytes.toString('utf8'),path.basename(s.name))}));for(const d of docs)if(!validContentPath(d.path))throw new Error('Markdown 固定链接无效');
  const namespace=randomUUID();const mapping=new Map();for(const f of buffers.filter(f=>!/\.md$/i.test(f.name))){const m=await storeMedia(f.bytes,path.basename(f.name),`${namespace}/${path.dirname(f.name)==='.'?'root':path.dirname(f.name)}`);mapping.set(f.name,m.path);assets.push(m)}
  for(const d of docs)d.markdown=d.markdown.replace(/(!?\[[^\]]*\]\()([^\s)]+)([^)]*\))/g,(all,start,url,end)=>{if(/^(?:https?:|data:|#|\/)/.test(url))return all;const relative=path.posix.normalize(path.posix.join(path.posix.dirname(d.filename),url));return mapping.has(relative)?`${start}${mapping.get(relative)}${end}`:all});
  return {documents:docs,assets};
 }
 if(!/\.md$/i.test(filename)||bytes.length>5*1024*1024)throw new Error('请选择 .md 或包含 Markdown 与附件的 .zip 文件');
 const d=importMarkdown(bytes.toString('utf8'),filename);if(!validContentPath(d.path))throw new Error('Markdown 固定链接无效');return {documents:[d],assets};
}
