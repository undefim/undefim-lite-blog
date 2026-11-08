// Built-in visitor analytics: one row per page view, tagged with the site (primary or an enrolled replica) and the
// traffic source. No raw IP, user agent or full referrer URL is stored; visitors are counted by a hashed random
// first-party cookie (or, without cookies, a hash that changes daily).
import {createHash,randomBytes} from 'node:crypto';

export const ANALYTICS_SCHEMA_VERSION=2;
export const RETENTION_DAYS=120;
// The same visitor viewing the same page again within this window (refreshes, back and forth) is one page view.
export const REPEAT_WINDOW_MINUTES=30;
export const VISITOR_COOKIE='bvid';
export const sourceTypes=['direct','search','social','referral','campaign','internal'];

// Separate, additive migration ledger: older program versions ignore these tables, so rolling back needs no cleanup.
export function migrateAnalyticsSchema(db){
 db.exec('BEGIN IMMEDIATE');
 try{
  db.exec('CREATE TABLE IF NOT EXISTS analytics_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const latest=db.prepare('SELECT MAX(version) AS version FROM analytics_schema_migrations').get().version||0;
  if(latest>ANALYTICS_SCHEMA_VERSION)throw new Error('访客统计数据库版本高于当前程序，请恢复兼容版本');
  if(latest<1){
   if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='visit_events'").get())throw new Error('检测到未登记的 visit_events 表；请先备份并由维护者处理，禁止自动覆盖');
   db.exec(`CREATE TABLE visit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, site_id TEXT NOT NULL DEFAULT '', visitor TEXT NOT NULL, path TEXT NOT NULL,
    source_type TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
   );
   CREATE INDEX visit_events_site_time ON visit_events(site_id, created_at);
   CREATE INDEX visit_events_time ON visit_events(created_at);`);
   db.prepare('INSERT INTO analytics_schema_migrations VALUES (1,?)').run(new Date().toISOString());
  }
  if(latest<2){
   // v2: visitor country (ISO 3166-1 alpha-2, '' when unknown). Rows recorded before stay unknown: no IP was kept.
   db.exec("ALTER TABLE visit_events ADD COLUMN country TEXT NOT NULL DEFAULT ''");
   db.prepare('INSERT INTO analytics_schema_migrations VALUES (2,?)').run(new Date().toISOString());
  }
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error}
}

const searchEngines=[['google','Google'],['bing.com','Bing'],['baidu.com','百度'],['sogou.com','搜狗'],['so.com','360 搜索'],['sm.cn','神马'],['duckduckgo.com','DuckDuckGo'],['yandex','Yandex'],['yahoo','Yahoo'],['search.brave.com','Brave'],['ecosia.org','Ecosia'],['naver.com','Naver'],['toutiao.com','头条搜索']];
const socialSites=[['weibo','微博'],['zhihu.com','知乎'],['bilibili.com','哔哩哔哩'],['douban.com','豆瓣'],['xiaohongshu.com','小红书'],['weixin.qq.com','微信'],['qq.com','QQ'],['t.co','X'],['twitter.com','X'],['x.com','X'],['facebook.com','Facebook'],['reddit.com','Reddit'],['linux.do','LINUX DO'],['v2ex.com','V2EX'],['github.com','GitHub'],['news.ycombinator.com','Hacker News'],['t.me','Telegram'],['telegram.org','Telegram'],['juejin.cn','掘金'],['csdn.net','CSDN']];
// A dotted pattern matches that domain and its subdomains; a bare word matches any label (google.co.jp, cn.bing...).
const matches=(host,pattern)=>pattern.includes('.')?host===pattern||host.endsWith('.'+pattern):host.split('.').includes(pattern);
const clean=(value,max)=>String(value||'').replace(/[\u0000-\u001f<>"'`\\]/g,'').trim().slice(0,max);

// Classify where a page view came from. `siteHosts` are hosts of the site being viewed (same-site navigation is internal).
export function classifySource({referrer='',campaign='',siteHosts=[],reload=false}){
 // A reload keeps the original referrer in the browser; it is never a new arrival.
 if(reload)return {type:'internal',source:''};
 const utm=clean(campaign,60).toLowerCase();
 if(utm)return {type:'campaign',source:utm};
 let host='';try{const url=new URL(String(referrer));if(['http:','https:'].includes(url.protocol))host=url.hostname.toLowerCase()}catch{}
 if(!host)return {type:'direct',source:''};
 if(siteHosts.map(h=>String(h).toLowerCase().replace(/:\d+$/,'')).includes(host))return {type:'internal',source:''};
 const bare=host.replace(/^(www|m|mobile)\./,'');
 for(const [pattern,name] of searchEngines)if(matches(bare,pattern))return {type:'search',source:name};
 for(const [pattern,name] of socialSites)if(matches(bare,pattern))return {type:'social',source:name};
 return {type:'referral',source:bare.slice(0,120)};
}

export const isBot=ua=>!ua||/bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|monitor|curl|wget|python|httpclient|okhttp|java\//i.test(ua);
const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,32);
export const newVisitorId=()=>randomBytes(16).toString('hex');
export const validVisitorId=value=>/^[a-f0-9]{32}$/.test(String(value||''));
export function visitorKey({cookieId,ip,ua,now=Date.now()}){
 if(validVisitorId(cookieId))return 'c'+hash('visitor:'+cookieId);
 return 'd'+hash(`daily:${Math.floor(now/86400000)}:${ip}:${ua}`);
}

export function cleanPath(value){
 const raw=String(value||'');if(!raw.startsWith('/')||raw.startsWith('//'))return null;
 const pathOnly=raw.split(/[?#]/)[0].slice(0,300);
 if(/[\u0000-\u001f\\]/.test(pathOnly)||/^\/(?:admin|api)(?:\/|$)/.test(pathOnly))return null;
 return pathOnly;
}

export function createAnalytics(db){
 const insert=db.prepare('INSERT INTO visit_events(site_id,visitor,path,source_type,source,country,created_at) VALUES (?,?,?,?,?,?,?)');
 // Uses the (site_id, created_at) index; the window holds only the last few minutes of that site's views.
 const recent=db.prepare('SELECT 1 FROM visit_events WHERE site_id=? AND created_at>=? AND visitor=? AND path=? LIMIT 1');
 let lastPrune=0;
 function prune(now){if(now-lastPrune<3600*1000)return;lastPrune=now;db.prepare('DELETE FROM visit_events WHERE created_at<?').run(now-RETENTION_DAYS*86400000)}
 // Returns false when the view repeats one recorded within REPEAT_WINDOW_MINUTES and is therefore not stored.
 function record({siteId='',visitor,path,source,country='',now=Date.now()}){
  if(recent.get(siteId,now-REPEAT_WINDOW_MINUTES*60000,visitor,path))return false;
  insert.run(siteId,visitor,path,source.type,source.source||'',/^[A-Z]{2}$/.test(country)?country:'',now);prune(now);return true;
 }

 // Rolling windows (last 24 h / 7 d / 30 d) per site, plus the breakdown for one site (or all) and one window.
 function report({siteId=null,days=7,tzOffsetMinutes=0,now=Date.now(),sites=[]}={}){
  const windows=[1,7,30];
  const since=d=>now-d*86400000;
  const perSite={};
  for(const d of windows){
   for(const row of db.prepare('SELECT site_id,COUNT(*) AS pageviews,COUNT(DISTINCT visitor) AS visitors FROM visit_events WHERE created_at>=? GROUP BY site_id').all(since(d))){perSite[row.site_id]??={};perSite[row.site_id][d]={visitors:row.visitors,pageviews:row.pageviews}}
  }
  const totals=Object.fromEntries(windows.map(d=>[d,db.prepare('SELECT COUNT(*) AS pageviews,COUNT(DISTINCT site_id||visitor) AS visitors FROM visit_events WHERE created_at>=?').get(since(d))]));
  const known=new Set(sites.map(s=>s.id));
  const siteRows=[...sites,...Object.keys(perSite).filter(id=>!known.has(id)).map(id=>({id,name:'已删除的子站',url:'',removed:true}))]
   .map(s=>({...s,windows:Object.fromEntries(windows.map(d=>[d,perSite[s.id]?.[d]||{visitors:0,pageviews:0}]))}));

  const filter=siteId===null?'':' AND site_id=?';
  const args=d=>siteId===null?[since(d)]:[since(d),siteId];
  const summary=db.prepare(`SELECT COUNT(*) AS pageviews,COUNT(DISTINCT site_id||visitor) AS visitors,SUM(source_type!='internal') AS entries FROM visit_events WHERE created_at>=?${filter}`).get(...args(days));
  const types=db.prepare(`SELECT source_type AS type,COUNT(*) AS visits,COUNT(DISTINCT site_id||visitor) AS visitors FROM visit_events WHERE created_at>=?${filter} AND source_type!='internal' GROUP BY source_type ORDER BY visits DESC`).all(...args(days));
  const sources=db.prepare(`SELECT source_type AS type,source,COUNT(*) AS visits,COUNT(DISTINCT site_id||visitor) AS visitors FROM visit_events WHERE created_at>=?${filter} AND source_type NOT IN ('internal','direct') GROUP BY source_type,source ORDER BY visits DESC LIMIT 20`).all(...args(days));
  const countries=db.prepare(`SELECT country,COUNT(*) AS pageviews,COUNT(DISTINCT site_id||visitor) AS visitors FROM visit_events WHERE created_at>=?${filter} GROUP BY country ORDER BY visitors DESC,pageviews DESC`).all(...args(days));
  const pages=db.prepare(`SELECT path,COUNT(*) AS pageviews,COUNT(DISTINCT site_id||visitor) AS visitors FROM visit_events WHERE created_at>=?${filter} GROUP BY path ORDER BY pageviews DESC LIMIT 20`).all(...args(days));

  // Trend buckets: hourly for one day, otherwise calendar days in the viewer's time zone.
  const offset=tzOffsetMinutes*60000,size=days===1?3600000:86400000,count=days===1?24:days;
  const lastBucket=Math.floor((now-offset)/size);
  const rows=db.prepare(`SELECT CAST((created_at-?)/? AS INTEGER) AS bucket,COUNT(*) AS pageviews,COUNT(DISTINCT site_id||visitor) AS visitors FROM visit_events WHERE created_at>=?${filter} GROUP BY bucket`).all(offset,size,...(siteId===null?[(lastBucket-count+1)*size+offset]:[(lastBucket-count+1)*size+offset,siteId]));
  const byBucket=new Map(rows.map(r=>[Number(r.bucket),r]));
  const trend=Array.from({length:count},(_,i)=>{const b=lastBucket-count+1+i;const r=byBucket.get(b);return {start:new Date(b*size+offset).toISOString(),visitors:r?.visitors||0,pageviews:r?.pageviews||0}});

  return {generatedAt:new Date(now).toISOString(),retentionDays:RETENTION_DAYS,days,siteId,sites:siteRows,totals,
   summary:{visitors:summary.visitors||0,pageviews:summary.pageviews||0,entries:summary.entries||0},types,sources,countries,pages,trend};
 }
 return {record,report};
}
