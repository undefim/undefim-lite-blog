import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {migrateReplicaSchema} from '../server/replica-migrations.mjs';
test('子站迁移只新增表，重复执行不改文章与认证数据',()=>{
 const db=new DatabaseSync(':memory:');try{
 db.exec("PRAGMA foreign_keys=ON; CREATE TABLE documents(id TEXT PRIMARY KEY,data TEXT); INSERT INTO documents VALUES ('post','private original')");
 migrateReplicaSchema(db);
 db.exec("INSERT INTO replica_sites(id,name,primary_url,site_url,created_at) VALUES ('r','test','https://primary.example','https://replica.example','now')");
 migrateReplicaSchema(db);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM replica_schema_migrations').get().n,1);
 assert.equal(db.prepare('SELECT data FROM documents').get().data,'private original');
 assert.equal(db.prepare('SELECT settings FROM replica_sites').get().settings,'{}');
 assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close()}
});
test('开发期缺失 settings 列通过 ALTER 升级，不覆写既有数据',()=>{
 const db=new DatabaseSync(':memory:');try{db.exec('CREATE TABLE documents(id TEXT PRIMARY KEY)');migrateReplicaSchema(db);
 db.exec("DELETE FROM replica_schema_migrations; ALTER TABLE replica_sites DROP COLUMN settings; INSERT INTO replica_sites(id,name,primary_url,site_url,created_at,token_hash) VALUES ('r','test','https://primary.example','https://replica.example','now','keep-token')");
 migrateReplicaSchema(db);assert.equal(db.prepare('SELECT token_hash FROM replica_sites').get().token_hash,'keep-token');assert.equal(db.prepare('SELECT settings FROM replica_sites').get().settings,'{}');
 }finally{db.close()}
});
test('未知原型表拒绝迁移并回滚，不删除现有表',()=>{
 const db=new DatabaseSync(':memory:');try{db.exec("CREATE TABLE replica_sites(id TEXT); INSERT INTO replica_sites VALUES ('keep')");assert.throws(()=>migrateReplicaSchema(db),/不兼容/);assert.equal(db.prepare('SELECT id FROM replica_sites').get().id,'keep');assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='replica_schema_migrations'").get().n,0)}finally{db.close()}
});
