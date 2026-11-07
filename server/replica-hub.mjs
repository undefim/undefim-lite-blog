// Primary only: replica management (admin API), the replica-facing sync API and verification of replica-proxied
// public requests. Replicas authenticate with "Authorization: Replica <id>.<token>"; only a SHA-256 of the token
// is stored. Enrollment codes are one-time, expire after 24 hours and are also stored only as hashes.
import fs from 'node:fs';import fsp from 'node:fs/promises';import path from 'node:path';import net from 'node:net';import {randomBytes,randomUUID} from 'node:crypto';import {z} from 'zod';
import {db,dataDir,document} from './db.mjs';import {defaultUpdateSource} from './update-source.mjs';
import {MANIFEST_NAME,originOf,resolveInside,safeRelative,sameSecret,sha256,validReleaseId,walkFiles,fileSha256} from './replica-protocol.mjs';
import {enqueueReplicaBuild,reconcileReplicaBuilds,removeReplicaBuilds,replicaBuildRoot,replicaDocumentIds,replicaOverrides,authorizedBuild} from './replica-build.mjs';import {siteThemes} from './themes.mjs';
// Same rules as the primary's settings API for these keys.
const siteUrlRule=z.string().max(2000).regex(/^[^<>"'\\\u0000-\u001f]*$/,'地址含无效字符').refine(s=>!s||s.startsWith('/')&&!s.startsWith('//')||/^https?:\/\//.test(s),'请使用站内路径或 HTTP 地址');
export const overrideSchema=z.object({
 siteTheme:z.string().refine(v=>siteThemes.some(t=>t.id===v),'前台主题无效'),
 title:z.string().trim().min(1).max(100),description:z.string().max(3000),announcement:z.string().max(3000),
 navigation:z.array(z.object({label:z.string().trim().min(1).max(40),href:siteUrlRule})).max(20),
 icpRecord:z.string().trim().max(100),publicSecurityRecord:z.string().trim().max(100)
}).partial().strict();

const fail=(statusCode,message)=>Object.assign(new Error(message),{statusCode});
const now=()=>new Date().toISOString();
const ENROLL_TTL=24*60*60*1000;
const newCode=()=>randomBytes(15).toString('base64url').replace(/[-_]/g,'x').toUpperCase().match(/.{5}/g).join('-');
const codeHash=code=>sha256(String(code).trim().toUpperCase());
const shortError=v=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,300):null;
const revisionText=v=>typeof v==='string'&&/^[a-f0-9]{7,64}$/.test(v)?v:null;

export function deployCommand(row,code){
 // Every interpolated value is validated (origins, code alphabet), so the line is safe to paste into a shell.
 const revision=/^[a-f0-9]{40,64}$/.test(process.env.APP_REVISION||'')?process.env.APP_REVISION:null;
 const lines=['COMPOSE_PROJECT_NAME=blog-replica',`PRIMARY_URL=${row.primary_url}`,`SITE_URL=${row.site_url}`,`ENROLL_CODE=${code}`];
 return `git clone ${defaultUpdateSource.url}.git blog-replica && cd blog-replica && ${revision?`git reset --hard ${revision} && `:''}umask 077 && printf '%s\\n' ${lines.map(l=>`'${l}'`).join(' ')} > .env && printf 'APP_REVISION=%s\\n' \"$(git rev-parse HEAD)\" >> .env && docker compose -f compose.replica.yaml up -d --build`;
}
function view(row){
 const {enroll_hash,token_hash,...rest}=row;
 return {...rest,settings:replicaOverrides(row),documentIds:replicaDocumentIds(row.id),enrollPending:Boolean(enroll_hash&&row.enroll_expires_at>Date.now()),synced:Boolean(row.build_id&&row.reported_release===row.build_id)};
}
function issueCode(id,primaryUrl){
 const code=newCode();
 db.prepare("UPDATE replica_sites SET enroll_hash=?,enroll_expires_at=?,primary_url=?,status=CASE WHEN status='revoked' THEN 'pending' ELSE status END WHERE id=?").run(codeHash(code),Date.now()+ENROLL_TTL,primaryUrl,id);
 return code;
}
const row=id=>{const r=db.prepare('SELECT * FROM replica_sites WHERE id=?').get(id);if(!r)throw fail(404,'子站不存在');return r};
function replicaFromAuth(req){
 const header=String(req.headers.authorization||'');const match=/^Replica ([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,200})$/.exec(header);if(!match)return null;
 const r=db.prepare("SELECT * FROM replica_sites WHERE id=? AND status='active'").get(match[1]);
 return r&&r.token_hash&&sameSecret(r.token_hash,sha256(match[2]))?r:null;
}
const replicaAuth=async req=>{req.replica=replicaFromAuth(req);if(!req.replica)throw fail(401,'子站凭据无效或已被吊销')};
function sendFile(reply,file){const stream=fs.createReadStream(file);return reply.header('Cache-Control','no-store').type('application/octet-stream').send(stream)}

// Comment / visit / like requests forwarded by a replica: trust its reported reader IP for rate limiting only when
// the replica credential is valid. Requests without the header are ordinary public requests.
export function replicaClientHook(){
 return async req=>{
  if(!req.url.startsWith('/api/public/')||!req.headers.authorization)return;
  const r=replicaFromAuth(req);if(!r)throw fail(401,'子站凭据无效或已被吊销');
  const match=/^\/api\/public\/documents\/([a-zA-Z0-9-]+)\/(comments|visit|like)(?:\?|$)/.exec(req.url);if(!match)throw fail(404,'接口不存在');
  const doc=document(match[1],true);const ids=replicaDocumentIds(r.id);if(!doc||doc.kind==='post'&&(r.mode==='selected'?!ids.includes(doc.id):ids.includes(doc.id)))throw fail(404,'文章不存在');
  const ip=String(req.headers['x-replica-client-ip']||'');req.replicaClientIp=net.isIP(ip)?ip:null;
 };
}

export function registerReplicaRoutes(app,{auth,primaryRevision=()=>process.env.APP_REVISION}){
 const siteSchema=z.object({name:z.string().trim().min(1).max(100),primaryUrl:z.string(),siteUrl:z.string()});
 // ---- admin API ----
 app.get('/api/replicas',{preHandler:auth},async()=>{const revision=primaryRevision();return {primaryRevision:revisionText(revision),replicas:db.prepare('SELECT * FROM replica_sites ORDER BY created_at').all().map(view)}});
 app.post('/api/replicas',{preHandler:auth},async req=>{
  const input=siteSchema.parse(req.body);const primaryUrl=originOf(input.primaryUrl,'主站地址'),siteUrl=originOf(input.siteUrl,'子站地址');
  if(primaryUrl===siteUrl)throw fail(400,'子站地址不能与主站地址相同');
  if(db.prepare("SELECT 1 FROM replica_sites WHERE site_url=? AND status!='revoked'").get(siteUrl))throw fail(409,'该子站地址已存在');
  const id=randomUUID();db.prepare('INSERT INTO replica_sites(id,name,primary_url,site_url,created_at) VALUES (?,?,?,?,?)').run(id,input.name,primaryUrl,siteUrl,now());
  const code=issueCode(id,primaryUrl);const r=row(id);return {replica:view(r),code,command:deployCommand(r,code),expiresAt:new Date(r.enroll_expires_at).toISOString()};
 });
 app.put('/api/replicas/:id',{preHandler:auth},async req=>{
  const r=row(req.params.id);const input=z.object({name:z.string().trim().min(1).max(100),siteUrl:z.string(),mode:z.enum(['all','selected']),documentIds:z.array(z.string().max(100)).max(20000),settings:overrideSchema.default({})}).parse(req.body);
  const siteUrl=originOf(input.siteUrl,'子站地址');if(siteUrl===r.primary_url)throw fail(400,'子站地址不能与主站地址相同');
  if(db.prepare("SELECT 1 FROM replica_sites WHERE site_url=? AND id!=? AND status!='revoked'").get(siteUrl,r.id))throw fail(409,'该子站地址已存在');
  const ids=[...new Set(input.documentIds)];for(const id of ids)if(!document(id))throw fail(400,'文章不存在');
  db.exec('BEGIN IMMEDIATE');
  try{db.prepare('UPDATE replica_sites SET name=?,site_url=?,mode=?,settings=? WHERE id=?').run(input.name,siteUrl,input.mode,JSON.stringify(input.settings),r.id);db.prepare('DELETE FROM replica_documents WHERE replica_id=?').run(r.id);const insert=db.prepare('INSERT INTO replica_documents VALUES (?,?)');for(const id of ids)insert.run(r.id,id);db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}
  await reconcileReplicaBuilds();return view(row(r.id));
 });
 app.post('/api/replicas/:id/code',{preHandler:auth},async req=>{
  const r=row(req.params.id);const primaryUrl=originOf(req.body?.primaryUrl||r.primary_url,'主站地址');const code=issueCode(r.id,primaryUrl);const fresh=row(r.id);
  return {replica:view(fresh),code,command:deployCommand(fresh,code),expiresAt:new Date(fresh.enroll_expires_at).toISOString()};
 });
 app.post('/api/replicas/:id/build',{preHandler:auth},async(req,reply)=>{const r=row(req.params.id);if(r.status!=='active')throw fail(409,'子站尚未接入');enqueueReplicaBuild(r.id,{force:true});db.prepare("UPDATE replica_sites SET build_status='queued' WHERE id=?").run(r.id);reply.code(202);return view(row(r.id))});
 app.post('/api/replicas/:id/update',{preHandler:auth},async(req,reply)=>{
  const r=row(req.params.id);if(r.status!=='active')throw fail(409,'子站尚未接入');
  const target=primaryRevision();if(!/^[a-f0-9]{40,64}$/.test(target||''))throw fail(409,'主站程序版本未知，无法指定子站更新目标；请通过系统更新部署主站后再试');
  db.prepare("UPDATE replica_sites SET update_id=?,update_target=?,update_requested_at=?,update_status='requested',update_message=? WHERE id=?").run(randomUUID(),target,now(),'等待子站领取更新任务',r.id);
  reply.code(202);return view(row(r.id));
 });
 app.post('/api/replicas/:id/revoke',{preHandler:auth},async req=>{const r=row(req.params.id);db.prepare("UPDATE replica_sites SET status='revoked',token_hash=NULL,enroll_hash=NULL,enroll_expires_at=NULL WHERE id=?").run(r.id);return view(row(r.id))});
 app.delete('/api/replicas/:id',{preHandler:auth},async req=>{const r=row(req.params.id);db.prepare('DELETE FROM replica_sites WHERE id=?').run(r.id);await removeReplicaBuilds(r.id);return {ok:true}});

 // ---- replica API ----
 app.post('/api/replica/v1/enroll',{config:{rateLimit:{max:10,timeWindow:'15 minutes'}}},async req=>{
  const code=z.object({code:z.string().trim().min(10).max(64)}).parse(req.body).code;
  const r=db.prepare('SELECT * FROM replica_sites WHERE enroll_hash=?').get(codeHash(code));
  if(!r||!(r.enroll_expires_at>Date.now()))throw fail(401,'认证码无效、已使用或已过期，请在主站后台重新生成');
  const token=randomBytes(32).toString('base64url');
  db.prepare("UPDATE replica_sites SET token_hash=?,status='active',enroll_hash=NULL,enroll_expires_at=NULL,enrolled_at=?,last_seen_at=? WHERE id=?").run(sha256(token),now(),now(),r.id);
  await reconcileReplicaBuilds();
  return {replicaId:r.id,token,name:r.name,siteUrl:r.site_url,primaryUrl:r.primary_url};
 });
 app.post('/api/replica/v1/sync',{preHandler:replicaAuth},async req=>{
  const r=req.replica;const body=req.body&&typeof req.body==='object'?req.body:{};
  const update=body.update&&typeof body.update==='object'?body.update:null;
  db.prepare('UPDATE replica_sites SET last_seen_at=?,reported_release=?,reported_revision=?,reported_error=? WHERE id=?').run(now(),validReleaseId(body.release)?body.release:null,revisionText(body.revision),shortError(body.error),r.id);
  if(update&&update.id===r.update_id&&['running','success','failed','unchanged'].includes(update.status))db.prepare('UPDATE replica_sites SET update_status=?,update_message=? WHERE id=?').run(update.status,shortError(update.message),r.id);
  const fresh=row(r.id);
  return {build:await authorizedBuild(fresh,fresh.build_id)?fresh.build_id:null,siteUrl:fresh.site_url,update:fresh.update_id&&fresh.update_status==='requested'?{id:fresh.update_id,revision:fresh.update_target}:null};
 });
 app.get('/api/replica/v1/manifest',{preHandler:replicaAuth},async req=>{
  const build=String(req.query.build||'');if(!validReleaseId(build))throw fail(400,'版本编号无效');if(!await authorizedBuild(req.replica,build))throw fail(404,'版本已失效，请重新同步');
  let manifest;try{manifest=JSON.parse(await fsp.readFile(path.join(replicaBuildRoot,req.replica.id,build,MANIFEST_NAME),'utf8'))}catch{throw fail(404,'版本不存在或已被清理')}
  const mediaRoot=path.join(dataDir,'media');const media=[];for(const relative of await walkFiles(mediaRoot,'upload'))if(safeRelative(relative))media.push({path:relative,size:(await fsp.stat(path.join(mediaRoot,relative))).size,sha256:await fileSha256(path.join(mediaRoot,relative))});
  return {...manifest,media};
 });
 app.get('/api/replica/v1/file',{preHandler:replicaAuth},async(req,reply)=>{
  const build=String(req.query.build||''),relative=String(req.query.path||'');if(!validReleaseId(build)||relative===MANIFEST_NAME)throw fail(400,'文件无效');
  if(!await authorizedBuild(req.replica,build))throw fail(404,'版本已失效，请重新同步');
  const file=resolveInside(path.join(replicaBuildRoot,req.replica.id,build),relative);
  try{if(!(await fsp.lstat(file)).isFile())throw new Error()}catch{throw fail(404,'文件不存在')}
  return sendFile(reply,file);
 });
 app.get('/api/replica/v1/media',{preHandler:replicaAuth},async(req,reply)=>{
  const relative=String(req.query.path||'');if(!relative.startsWith('upload/'))throw fail(400,'媒体路径无效');
  const file=resolveInside(path.join(dataDir,'media'),relative);
  try{if(!(await fsp.lstat(file)).isFile())throw new Error()}catch{throw fail(404,'媒体不存在')}
  return sendFile(reply,file);
 });
}
