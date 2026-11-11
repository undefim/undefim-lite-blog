import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
process.env.DATA_DIR=await fs.mkdtemp(path.join(os.tmpdir(),'undefim-media-'));process.env.COOKIE_SECURE='false';
const {db,dataDir,saveDocument}=await import('../server/db.mjs');const {storeMedia}=await import('../server/uploads.mjs');const {passwordHash}=await import('../server/auth.mjs');const {createApp}=await import('../server/index.mjs');const {migrateMediaSchema,MEDIA_SCHEMA_VERSION}=await import('../server/media.mjs');

test('媒体库迁移登记版本且可重复执行',()=>{migrateMediaSchema(db);assert.equal(db.prepare('SELECT MAX(version) v FROM media_schema_migrations').get().v,MEDIA_SCHEMA_VERSION);assert.ok(db.prepare('PRAGMA table_info(media)').all().some(c=>c.name==='alt'))});

test('媒体可编辑名称与替代文字，被引用的文件不能删除，未引用文件移出公开目录',async()=>{
 db.prepare('INSERT INTO users VALUES (?,?)').run('m',passwordHash('media-password-long-enough'));
 const app=await createApp();const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'m',password:'media-password-long-enough'}});
 const cookie=login.headers['set-cookie'];const csrf=login.json().csrf;const headers={cookie:Array.isArray(cookie)?cookie.join('; '):cookie,'x-csrf-token':csrf};
 const used=await storeMedia(Buffer.from('a'),'用过的 图.png'),free=await storeMedia(Buffer.from('b'),'free.png');
 saveDocument({kind:'post',title:'引用者',path:'/archives/media-ref',format:'markdown',markdown:`![x](${encodeURI(used.path)})`,date:'2026-01-01T00:00:00.000Z',categories:[],tags:[],visibility:'private',allowComment:true,author:'t'});
 const list=(await app.inject({url:'/api/media',headers})).json();
 assert.equal(list.find(m=>m.id===used.id).usage[0].title,'引用者');assert.equal(list.find(m=>m.id===free.id).usage.length,0);
 const patched=await app.inject({method:'PATCH',url:`/api/media/${free.id}`,headers,payload:{name:'新名字',alt:'说明\u0000文字'}});
 assert.equal(patched.statusCode,200);assert.equal(patched.json().name,'新名字');assert.equal(patched.json().alt,'说明文字');assert.equal(patched.json().path,free.path);
 assert.equal((await app.inject({method:'PATCH',url:`/api/media/${free.id}`,headers,payload:{name:'  '}})).statusCode,400);
 assert.equal((await app.inject({method:'DELETE',url:`/api/media/${used.id}`,headers})).statusCode,409);
 assert.equal((await app.inject({method:'DELETE',url:`/api/media/${free.id}`,headers:{...headers,'x-csrf-token':'bad'}})).statusCode,403);
 assert.equal((await app.inject({method:'DELETE',url:`/api/media/${free.id}`,headers})).statusCode,200);
 await assert.rejects(fs.access(path.join(dataDir,'media',free.path.slice(1))));
 await fs.access(path.join(dataDir,'media-trash',free.id,path.basename(free.path)));
 assert.equal(db.prepare('SELECT 1 FROM media WHERE id=?').get(free.id),undefined);
 await app.close();
});
