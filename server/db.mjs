import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {defaultLicense} from './license.mjs';
import {defaultSiteTheme} from './themes.mjs';
import {migrateReplicaSchema} from './replica-migrations.mjs';
import {migrateAnalyticsSchema} from './analytics.mjs';
import {migrateMediaSchema} from './media.mjs';

export const dataDir = path.resolve(process.env.DATA_DIR || './data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
export const db = new DatabaseSync(path.join(dataDir, 'blog.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS documents (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT UNIQUE NOT NULL,
 data TEXT NOT NULL, published_data TEXT, deleted_at TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS revisions (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
 data TEXT NOT NULL, created_at TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS comments (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), parent_id TEXT,
 author TEXT NOT NULL, email TEXT, content TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stats (document_id TEXT PRIMARY KEY REFERENCES documents(id), visits INTEGER NOT NULL DEFAULT 0, likes INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT UNIQUE NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, password_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at INTEGER NOT NULL, csrf TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT, log TEXT NOT NULL DEFAULT '', urls TEXT NOT NULL DEFAULT '[]');
CREATE INDEX IF NOT EXISTS revision_document ON revisions(document_id, created_at);
CREATE INDEX IF NOT EXISTS comment_document ON comments(document_id, status);
CREATE TABLE IF NOT EXISTS comment_sources (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS redirects (path TEXT PRIMARY KEY, target TEXT NOT NULL);
`);

migrateReplicaSchema(db);
migrateAnalyticsSchema(db);
migrateMediaSchema(db);

export const defaultSettings = {
 title: "undefim'blog", description: '技术随笔与实践记录，分享网络技术、服务器部署和生活点滴。',
 author: 'undefim', bio: 'Crafting my own path, forever undefined!', location: '中国 · 浙江',
 avatar: '/upload/b2cc1237-c3cf-44ef-a6b9-a83528b74f9f.png', logo: '/upload/IMG_3447.JPG',
 background: '/assets/background.webp', accent: '#5d93db', cardOpacity: 0.78, siteTheme: defaultSiteTheme,
 announcement: '欢迎来访我的个人博客。\nWelcome to visit my personal blog.', email: 'undefim@linux.do',
 github: 'https://github.com/qumingla', qq: '3068768267', startDate: '2023-04-01',
 navigation: [{label:'首页',href:'/'},{label:'动态',href:'/categories/ri-chang'},{label:'友链',href:'/you-lian'},{label:'关于',href:'/about'}],
 categories: [], tags: [], links: [], assetMap: {}, importAutoPublish: false, umamiWebsiteId: '',
 icpRecord: '', publicSecurityRecord: '', uptimeKumaUrl: '', uptimeKumaSlug: ''
};
export function settings() {
 const rows = db.prepare('SELECT key,value FROM settings').all();
 return { ...defaultSettings, ...Object.fromEntries(rows.map(r => [r.key, JSON.parse(r.value)])) };
}
export function setSettings(values) {
 const q = db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
 for (const [key, value] of Object.entries(values)) q.run(key, JSON.stringify(value));
}
function decode(row, published = false) {
 if (!row) return null;
 if (published && (!row.published_data || row.deleted_at)) return null;
 const data = JSON.parse(published ? row.published_data : row.data);
 if (published && data.visibility === 'private') return null;
 return { ...defaultLicense, ...data, id: row.id, kind: row.kind, path: published ? data.path : row.path,
   published: Boolean(row.published_data), deletedAt: row.deleted_at, updatedAt: row.updated_at };
}
export function documents({ published = false, deleted = false } = {}) {
 return db.prepare(`SELECT * FROM documents WHERE ${published ? 'published_data IS NOT NULL AND' : ''} deleted_at IS ${deleted ? 'NOT' : ''} NULL ORDER BY updated_at DESC`).all().map(r=>decode(r,published)).filter(Boolean);
}
export function document(id, published = false) { return decode(db.prepare('SELECT * FROM documents WHERE id=?').get(id), published); }
export function validContentPath(value) {
 if (typeof value !== 'string' || !value.startsWith('/') || value === '/' || /[?#\\\u0000-\u001f]/.test(value)) return false;
 const segments = value.split('/').slice(1);
 if (segments.some(p => !p || p === '.' || p === '..')) return false;
 try { if (decodeURIComponent(value) !== value) return false; } catch { return false; }
 return !['admin','api','assets','upload','categories','tags','page','index','search','rss.xml','sitemap.xml','search-index.json'].includes(segments[0]);
}
export function saveDocument(input, reason = 'edit', publish = false) {
 const id = input.id || randomUUID();
 if (!validContentPath(input.path)) throw new Error('固定链接路径无效或与系统路径冲突');
 const previous = db.prepare('SELECT * FROM documents WHERE id=?').get(id);
 const { id: unused, published, deletedAt, updatedAt, ...data } = {...defaultLicense,...input};
 const timestamp = new Date().toISOString();
 db.exec('BEGIN IMMEDIATE');
 try {
  if (previous) db.prepare('INSERT INTO revisions VALUES (?,?,?,?,?)').run(randomUUID(), id, previous.data, timestamp, reason);
  const occupied = documents({published:true}).find(d=>d.path===input.path && d.id!==id);
  if(occupied) throw new Error('路径仍被另一篇已发布文章使用');
  const publishedData = publish && data.visibility !== 'private' ? JSON.stringify(data) : previous?.published_data || null;
  db.prepare(`INSERT INTO documents VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,path=excluded.path,data=excluded.data,published_data=excluded.published_data,updated_at=excluded.updated_at`).run(id,input.kind || 'post', input.path, JSON.stringify(data), publishedData, previous?.deleted_at || null,timestamp);
  db.prepare('INSERT OR IGNORE INTO stats(document_id) VALUES (?)').run(id);
  const s=settings();
  for(const type of ['categories','tags']) {
   const list=[...s[type]];
   for(const name of data[type]||[])if(!list.some(t=>t.name===name)) {
    const base=name.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}_-]/gu,'-').replace(/^-+|-+$/g,'')||'topic';
    let slug=base;while(list.some(t=>t.slug===slug))slug=`${base}-${randomUUID().slice(0,6)}`;
    list.push({id:randomUUID(),name,slug,description:''});
   }
   setSettings({[type]:list});
  }
  db.exec('COMMIT');
 } catch (e) { db.exec('ROLLBACK'); throw e; }
 return document(id);
}
export function setPublished(id, enabled) {
 const row = db.prepare('SELECT * FROM documents WHERE id=?').get(id);
 if (!row || row.deleted_at) throw new Error('文章不存在');
 if(enabled && JSON.parse(row.data).visibility==='private') throw new Error('私密文章不能公开发布');
 db.prepare('UPDATE documents SET published_data=?,updated_at=? WHERE id=?').run(enabled ? row.data : null,new Date().toISOString(),id);
}
export function trash(id, restore = false) {
 db.prepare('UPDATE documents SET deleted_at=?,updated_at=? WHERE id=?').run(restore ? null : new Date().toISOString(),new Date().toISOString(),id);
}
export function publicExport() {
 const s=settings();
 const allowed=Object.keys(defaultSettings);
 const clean=Object.fromEntries(allowed.map(k=>[k,s[k]]));
 return { settings: clean, documents: documents({published:true}).map(({source,...d})=>({...d,...db.prepare('SELECT visits,likes FROM stats WHERE document_id=?').get(d.id),commentCount:db.prepare("SELECT COUNT(*) AS n FROM comments WHERE document_id=? AND status='approved'").get(d.id).n})) };
}
