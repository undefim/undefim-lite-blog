// Primary only: builds a separate static site for every enrolled replica from the primary's *published* snapshot
// (current/content.json), filtered by that replica's article rules and built with the replica's own SITE_URL.
// Runs on the same in-process build chain as normal publishing, so there is still exactly one build at a time.
import fs from 'node:fs/promises';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {db,dataDir} from './db.mjs';import {enqueueTask,onPublished,runAstro,writeRedirectPages} from './publish.mjs';
import {MANIFEST_NAME,currentRelease,fileSha256,sha256,walkFiles,validReleaseId} from './replica-protocol.mjs';

export const replicaBuildRoot=path.join(dataDir,'replica-builds');
const now=()=>new Date().toISOString();
const keep=2;// newest builds kept per replica; a replica may still be downloading the previous one
const pending=new Set();
let runner=null;// test hook: replaces the Astro build
export function setReplicaRunner(fn){runner=fn}

// Per-replica overrides of public site settings (theme, header, footer records ...); absent keys follow the primary.
export const replicaOverrides=row=>{try{const v=JSON.parse(row.settings||'{}');return v&&typeof v==='object'&&!Array.isArray(v)?v:{}}catch{return {}}};
export const replicaDocumentIds=id=>db.prepare('SELECT document_id FROM replica_documents WHERE replica_id=? ORDER BY document_id').all(id).map(r=>r.document_id);
// Pages (about, links ...) are always kept so navigation does not break; the rules only choose posts.
export function filterSnapshot(snapshot,mode,ids){const chosen=new Set(ids);return {...snapshot,documents:snapshot.documents.filter(d=>d.kind!=='post'||(mode==='selected'?chosen.has(d.id):!chosen.has(d.id)))}}
async function primarySnapshot(){const release=await currentRelease(dataDir);if(!release)return null;const root=path.join(dataDir,'releases',release);try{return {release,root,content:JSON.parse(await fs.readFile(path.join(root,'content.json'),'utf8'))}}catch{return null}}
// Identifies the inputs of a replica build; a replica is rebuilt only when one of them changed.
const buildKey=(row,release)=>sha256(JSON.stringify([release,row.site_url,row.mode,replicaDocumentIds(row.id),replicaOverrides(row)]));

export async function authorizedBuild(row,id){const source=await currentRelease(dataDir);return Boolean(id&&id===row.build_id&&row.build_status==='success'&&source&&row.build_key===buildKey(row,source))}

export function enqueueReplicaBuild(id,{force=false}={}){
 if(pending.has(id))return null;pending.add(id);
 return enqueueTask(async()=>{pending.delete(id);await buildReplica(id,{force})});
}
export async function reconcileReplicaBuilds(){
 const source=await primarySnapshot();if(!source)return [];
 const queued=[];for(const row of db.prepare("SELECT * FROM replica_sites WHERE status='active'").all())if((row.build_key!==buildKey(row,source.release)||row.build_status!=='success')&&enqueueReplicaBuild(row.id))queued.push(row.id);
 return queued;
}
onPublished(()=>reconcileReplicaBuilds());

export async function buildReplica(id,{force=false}={}){
 const row=db.prepare('SELECT * FROM replica_sites WHERE id=?').get(id);if(!row||row.status!=='active')return null;
 const source=await primarySnapshot();
 if(!source){db.prepare("UPDATE replica_sites SET build_status='failed',build_error=? WHERE id=?").run('主站尚未发布任何版本',id);return null}
 const key=buildKey(row,source.release);if(!force&&row.build_key===key&&row.build_status==='success')return row.build_id;
 const buildId=randomUUID();const root=path.join(replicaBuildRoot,id),target=path.join(root,buildId),site=path.join(target,'site');
 db.prepare("UPDATE replica_sites SET build_status='running',build_error=NULL,build_key=? WHERE id=?").run(key,id);
 let log='';const append=s=>{log=(log+s).slice(-20000)};
 try{
  await fs.mkdir(target,{recursive:true});
  const filtered=filterSnapshot(source.content,row.mode,replicaDocumentIds(id));const snapshot={...filtered,settings:{...filtered.settings,...replicaOverrides(row)}};
  const snapshotFile=path.join(target,'content.json');await fs.writeFile(snapshotFile,JSON.stringify(snapshot));
  if(runner)await runner(site,append,row);else await runAstro(snapshotFile,site,append,{SITE_URL:row.site_url});
  await fs.access(path.join(site,'index.html'));
  // Keep hashed assets of the previous build reachable for HTML still cached by browsers or a CDN.
  if(row.build_id&&validReleaseId(row.build_id))try{await fs.cp(path.join(root,row.build_id,'site/_astro'),path.join(site,'_astro'),{recursive:true,force:false})}catch(e){if(e.code!=='ENOENT')throw e}
  let redirects=[];try{redirects=JSON.parse(await fs.readFile(path.join(source.root,'redirects.json'),'utf8'))}catch{}
  const paths=new Set(snapshot.documents.map(d=>d.path));redirects=redirects.filter(r=>paths.has(r.target)&&!paths.has(r.path));
  await writeRedirectPages(site,redirects,row.site_url);await fs.writeFile(path.join(target,'redirects.json'),JSON.stringify(redirects));
  const files=[];for(const relative of await walkFiles(target))files.push({path:relative,size:(await fs.stat(path.join(target,relative))).size,sha256:await fileSha256(path.join(target,relative))});
  await fs.writeFile(path.join(target,MANIFEST_NAME),JSON.stringify({build:buildId,source:source.release,siteUrl:row.site_url,createdAt:now(),files}));
  // The replica may have been revoked or deleted while building; only then is the result discarded.
  const live=db.prepare('SELECT * FROM replica_sites WHERE id=?').get(id);
  if(live?.status!=='active'||buildKey(live,await currentRelease(dataDir))!==key){await fs.rm(target,{recursive:true,force:true});return null}
  db.prepare("UPDATE replica_sites SET build_id=?,build_status='success',build_error=NULL,built_at=? WHERE id=?").run(buildId,now(),id);
  try{const builds=(await fs.readdir(root,{withFileTypes:true})).filter(e=>e.isDirectory()&&e.name!==buildId);
  const stats=await Promise.all(builds.map(async e=>({name:e.name,time:(await fs.stat(path.join(root,e.name))).mtimeMs})));
  for(const old of stats.sort((a,b)=>b.time-a.time).slice(keep-1))await fs.rm(path.join(root,old.name),{recursive:true,force:true});
  }catch{/* Retention is best-effort; never delete the committed build on a cleanup error. */}
  return buildId;
 }catch(e){
  await fs.rm(target,{recursive:true,force:true});
  db.prepare("UPDATE replica_sites SET build_status='failed',build_error=? WHERE id=?").run(`${e.message}`.slice(0,500),id);
  return null;
 }
}
export async function removeReplicaBuilds(id){await fs.rm(path.join(replicaBuildRoot,id),{recursive:true,force:true})}
