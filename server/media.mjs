// Media library metadata, usage lookup and safe removal. File paths never change after upload: published pages and
// replicas link to them directly, so "editing" only touches the display name and alt text.
import fs from 'node:fs/promises';import path from 'node:path';

export const MEDIA_SCHEMA_VERSION=1;

// Separate, additive migration ledger (same pattern as analytics): older program versions ignore the extra column.
export function migrateMediaSchema(db){
 db.exec('BEGIN IMMEDIATE');
 try{
  db.exec('CREATE TABLE IF NOT EXISTS media_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const latest=db.prepare('SELECT MAX(version) AS version FROM media_schema_migrations').get().version||0;
  if(latest>MEDIA_SCHEMA_VERSION)throw new Error('媒体库数据库版本高于当前程序，请恢复兼容版本');
  if(latest<1){
   // v1: alt text used when inserting the file into content.
   const columns=db.prepare('PRAGMA table_info(media)').all().map(c=>c.name);
   if(!columns.includes('alt'))db.exec("ALTER TABLE media ADD COLUMN alt TEXT NOT NULL DEFAULT ''");
   db.prepare('INSERT INTO media_schema_migrations VALUES (1,?)').run(new Date().toISOString());
  }
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error}
}

const variants=p=>{const set=new Set([p]);try{set.add(encodeURI(p))}catch{}return [...set]};
const references=(text,p)=>variants(p).some(v=>text.includes(v));

// Every place a file is referenced: drafts, published snapshots, trashed content (it can be restored) and site settings.
export function mediaUsage(db,items){
 const docs=db.prepare('SELECT id,kind,path,data,published_data,deleted_at FROM documents').all().map(row=>{let title='';try{title=JSON.parse(row.data).title||''}catch{}return {...row,title,text:row.data+'\n'+(row.published_data||'')}});
 const settingsText=db.prepare('SELECT value FROM settings').all().map(r=>r.value).join('\n');
 return items.map(m=>({...m,usage:[
  ...docs.filter(d=>references(d.text,m.path)).map(d=>({id:d.id,kind:d.kind,title:d.title,path:d.path,deleted:!!d.deleted_at})),
  ...(references(settingsText,m.path)?[{id:'settings',kind:'settings',title:'站点设置',path:'',deleted:false}]:[])
 ]}));
}

const clean=(value,max)=>String(value??'').replace(/[\u0000-\u001f]/g,'').trim().slice(0,max);
export function cleanMediaPatch(input={}){
 const patch={};
 if('name' in input){patch.name=clean(input.name,200);if(!patch.name)throw Object.assign(new Error('显示名称不能为空'),{statusCode:400})}
 if('alt' in input)patch.alt=clean(input.alt,300);
 return patch;
}

// Removal moves the file out of the public media root into media-trash/<id>/, so a mistaken delete can be recovered by hand.
export async function removeMedia(db,dataDir,item){
 const root=path.join(dataDir,'media'),file=path.resolve(root,item.path.replace(/^\/+/,''));
 if(!file.startsWith(root+path.sep))throw Object.assign(new Error('媒体路径无效'),{statusCode:400});
 const target=path.join(dataDir,'media-trash',item.id,path.basename(file));
 await fs.mkdir(path.dirname(target),{recursive:true});
 try{await fs.rename(file,target)}catch(e){if(e.code!=='ENOENT')throw e}
 await fs.writeFile(path.join(path.dirname(target),'meta.json'),JSON.stringify({...item,deletedAt:new Date().toISOString()},null,2));
 db.prepare('DELETE FROM media WHERE id=?').run(item.id);
}
