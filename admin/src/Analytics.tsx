import React,{useEffect,useState} from 'react';
import {RefreshCw,Users,Eye,LogIn,Globe} from 'lucide-react';

type Props={api:(url:string,options?:any)=>Promise<any>,notify:(message:string,error?:boolean)=>void};
const windows=[[1,'近 1 天'],[7,'近 7 天'],[30,'近 30 天']] as const;
export const sourceTypeText:Record<string,string>={direct:'直接访问',search:'搜索引擎',social:'社交与社区',referral:'外部链接',campaign:'推广参数',internal:'站内跳转'};
const n=(value:number)=>value.toLocaleString('zh-CN');
const pct=(part:number,whole:number)=>whole?`${Math.round(part/whole*1000)/10}%`:'0%';
const siteKey=(id:string)=>id===''?'main':id;

export default function Analytics({api,notify}:Props){
 const [site,setSite]=useState('all'),[days,setDays]=useState(7),[data,setData]=useState<any>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const load=async()=>{setLoading(true);try{setData(await api(`/analytics?site=${encodeURIComponent(site)}&days=${days}&tz=${new Date().getTimezoneOffset()}`));setError('')}catch(e){setError((e as Error).message)}finally{setLoading(false)}};
 useEffect(()=>{load()},[site,days]);
 useEffect(()=>{const timer=setInterval(()=>{if(document.visibilityState==='visible')load()},60000);return()=>clearInterval(timer)},[site,days]);
 const sites=data?.sites||[];
 const current=site==='all'?'全部站点':sites.find((s:any)=>siteKey(s.id)===site)?.name||'站点';
 const s=data?.summary||{visitors:0,pageviews:0,entries:0};
 const external=(data?.types||[]).filter((t:any)=>t.type!=='direct').reduce((a:number,t:any)=>a+t.visits,0);
 const metrics=[['访客',s.visitors,Users],['浏览量',s.pageviews,Eye],['进站次数',s.entries,LogIn],['外部来源进站',external,Globe]] as const;
 return <>
  <div className="page-heading"><div><h1>访客统计</h1><p>主站与各子站分别统计；访客按浏览器去重，不保存 IP 地址。数据保留 {data?.retentionDays||120} 天。</p></div><button className="button" disabled={loading} onClick={()=>load().then(()=>notify('统计已刷新。'))}><RefreshCw size={16}/><span>刷新</span></button></div>
  {error&&<p className="inline-error" role="alert">{error}</p>}
  <section className="panel table-panel analytics-sites">
   <table><caption className="sr-only">各站点访客人数</caption><thead><tr><th scope="col">站点</th>{windows.map(([d,label])=><th scope="col" key={d}>{label}</th>)}</tr></thead>
    <tbody>
     {data&&<tr className={site==='all'?'active':''}><th scope="row"><button onClick={()=>setSite('all')}>全部站点</button></th>{windows.map(([d])=><td key={d}><strong>{n(data.totals[d].visitors)}</strong><small>{n(data.totals[d].pageviews)} 次浏览</small></td>)}</tr>}
     {sites.map((x:any)=><tr key={x.id||'main'} className={site===siteKey(x.id)?'active':''}><th scope="row"><button onClick={()=>setSite(siteKey(x.id))}>{x.name}</button>{x.url&&<small>{x.url.replace(/^https?:\/\//,'')}{x.status==='revoked'?'（已吊销）':''}</small>}{x.removed&&<small>历史数据</small>}</th>{windows.map(([d])=><td key={d}><strong>{n(x.windows[d].visitors)}</strong><small>{n(x.windows[d].pageviews)} 次浏览</small></td>)}</tr>)}
    </tbody></table>
   {!data&&<div className="empty">{loading?'正在加载统计…':'暂无数据'}</div>}
  </section>
  <div className="analytics-controls">
   <label className="field"><span>站点</span><select value={site} onChange={e=>setSite(e.target.value)}><option value="all">全部站点</option>{sites.map((x:any)=><option key={x.id||'main'} value={siteKey(x.id)}>{x.name}</option>)}</select></label>
   <div className="segmented" role="group" aria-label="统计时间范围">{windows.map(([d,label])=><button key={d} className={days===d?'active':''} aria-pressed={days===d} onClick={()=>setDays(d)}>{label}</button>)}</div>
  </div>
  <div className="metrics analytics-metrics">{metrics.map(([label,value,Icon])=><div className="metric" key={label}><Icon size={21}/><span>{label}</span><strong>{n(value)}</strong></div>)}</div>
  {data&&<>
   <section className="panel"><div className="panel-title"><h2>{current} · 访客趋势</h2><span className="muted">{days===1?'按小时':'按天'}</span></div><Trend trend={data.trend} hourly={days===1}/></section>
   <div className="overview-columns analytics-columns">
    <section className="panel"><div className="panel-title"><h2>来源类型</h2><span className="muted">按进站次数</span></div>
     {data.types.length?<BarList rows={data.types.map((t:any)=>({key:t.type,label:sourceTypeText[t.type]||t.type,value:t.visits,detail:`${n(t.visitors)} 位访客`}))} total={s.entries}/>:<div className="empty">暂无进站记录。</div>}
    </section>
    <section className="panel"><div className="panel-title"><h2>来源网站</h2><span className="muted">不含直接访问</span></div>
     {data.sources.length?<BarList rows={data.sources.map((t:any)=>({key:t.type+t.source,label:t.source,tag:sourceTypeText[t.type],value:t.visits,detail:`${n(t.visitors)} 位访客`}))} total={s.entries}/>:<div className="empty">暂无来自其他网站的访问。</div>}
    </section>
   </div>
   <section className="panel"><div className="panel-title"><h2>热门页面</h2><span className="muted">按浏览量</span></div>
    {data.pages.length?<BarList rows={data.pages.map((p:any)=>({key:p.path,label:p.path,value:p.pageviews,detail:`${n(p.visitors)} 位访客`}))} total={s.pageviews}/>:<div className="empty">暂无浏览记录。</div>}
   </section>
  </>}
 </>;
}

// Single-series column chart of visitors; the hovered/focused column shows exact values. A table follows for screen readers.
function Trend({trend,hourly}:{trend:any[],hourly:boolean}){
 const [active,setActive]=useState<number|null>(null);
 const peak=Math.max(0,...trend.map(t=>t.visitors)),max=Math.max(1,peak);
 const label=(t:any)=>{const d=new Date(t.start);return hourly?`${d.getHours()}:00`:`${d.getMonth()+1}/${d.getDate()}`};
 const step=hourly?6:trend.length>10?5:1;
 const shown=active===null?null:trend[active];
 return <div className="trend">
  <div className="trend-readout" aria-hidden="true">{shown?<><strong>{label(shown)}</strong>{n(shown.visitors)} 位访客 · {n(shown.pageviews)} 次浏览</>:<span className="muted">峰值 {n(peak)} 位访客，指向柱形查看详情</span>}</div>
  <div className="trend-plot" onMouseLeave={()=>setActive(null)} aria-hidden="true">
   {trend.map((t,i)=><div className={'trend-col'+(active===i?' active':'')} key={t.start} onMouseEnter={()=>setActive(i)}><span className="trend-bar" style={{height:t.visitors?`max(4px, ${t.visitors/max*100}%)`:'0'}}/></div>)}
  </div>
  <div className="trend-axis" aria-hidden="true">{trend.map((t,i)=><span key={t.start}>{i%step===0||i===trend.length-1?label(t):''}</span>)}</div>
  <div className="sr-only"><table><caption>访客趋势</caption><thead><tr><th>时间</th><th>访客</th><th>浏览量</th></tr></thead><tbody>{trend.map(t=><tr key={t.start}><td>{label(t)}</td><td>{t.visitors}</td><td>{t.pageviews}</td></tr>)}</tbody></table></div>
 </div>;
}

function BarList({rows,total}:{rows:{key:string,label:string,tag?:string,value:number,detail:string}[],total:number}){
 const max=Math.max(1,...rows.map(r=>r.value));
 return <ol className="bar-list">{rows.map(r=><li key={r.key} title={`${r.label}：${n(r.value)} 次，${r.detail}`}>
  <div className="bar-list-text"><span className="bar-list-label">{r.label}{r.tag&&<small>{r.tag}</small>}</span><span className="bar-list-value"><strong>{n(r.value)}</strong><small>{pct(r.value,total)}</small></span></div>
  <span className="bar-list-track"><span style={{width:`${r.value/max*100}%`}}/></span>
 </li>)}</ol>;
}
