// Additive, transactional migration. Existing blog tables and article data are never rewritten.
export function migrateReplicaSchema(db){
 db.exec('BEGIN IMMEDIATE');
 try{
  db.exec('CREATE TABLE IF NOT EXISTS replica_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const latest=db.prepare('SELECT MAX(version) AS version FROM replica_schema_migrations').get().version||0;
  if(latest>1)throw new Error('子站数据库版本高于当前程序，请恢复兼容版本');
  if(!latest){
   const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='replica_sites'").get();
   if(!exists)db.exec(`CREATE TABLE replica_sites (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, primary_url TEXT NOT NULL, site_url TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'all', settings TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending',
    enroll_hash TEXT UNIQUE, enroll_expires_at INTEGER, token_hash TEXT, created_at TEXT NOT NULL,
    enrolled_at TEXT, last_seen_at TEXT, reported_release TEXT, reported_revision TEXT, reported_error TEXT,
    build_id TEXT, build_key TEXT, build_status TEXT, build_error TEXT, built_at TEXT,
    update_id TEXT, update_target TEXT, update_requested_at TEXT, update_status TEXT, update_message TEXT
   )`);
   else{
    // Recognise the pre-release table from development; never pretend CREATE IF NOT EXISTS upgrades it.
    const names=new Set(db.prepare('PRAGMA table_info(replica_sites)').all().map(c=>c.name));
    for(const field of ['id','name','primary_url','site_url','mode','status','enroll_hash','enroll_expires_at','token_hash','created_at','enrolled_at','last_seen_at','reported_release','reported_revision','reported_error','build_id','build_key','build_status','build_error','built_at','update_id','update_target','update_requested_at','update_status','update_message'])if(!names.has(field))throw new Error('检测到不兼容的未发布子站表；请先备份并由维护者迁移，禁止自动覆盖');
    if(!names.has('settings'))db.exec("ALTER TABLE replica_sites ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'");
   }
   db.exec(`CREATE TABLE IF NOT EXISTS replica_documents (
    replica_id TEXT NOT NULL REFERENCES replica_sites(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES documents(id), PRIMARY KEY (replica_id, document_id)
   )`);
   db.prepare('INSERT INTO replica_schema_migrations VALUES (1,?)').run(new Date().toISOString());
  }
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error}
}
