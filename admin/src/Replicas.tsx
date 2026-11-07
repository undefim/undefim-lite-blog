import React,{useEffect,useMemo,useState} from 'react';
import {Network,Plus,Copy,RefreshCw,Download,KeyRound,Ban,Trash2,SlidersHorizontal,Search,X,Save,ArrowUpRight} from 'lucide-react';
import {siteThemes} from '../../server/themes.mjs';

type Props={api:(url:string,options?:any)=>Promise<any>,notify:(message:string,error?:boolean)=>void};
const date=(value?:string)=>value?new Date(value).toLocaleString('zh-CN'):'尚无记录';
const short=(value?:string)=>value?.slice(0,7)||'—';
const statusText:Record<string,string>={pending:'等待接入',active:'已接入',revoked:'已吊销'};
const buildText:Record<string,string>={queued:'排队中',running:'构建中',success:'构建成功',failed:'构建失败'};
const updateText:Record<string,string>={requested:'等待子站领取',running:'更新中',success:'更新成功',failed:'更新失败',unchanged:'已是该版本'};
// Site settings a replica may override; anything not customised follows the primary.
const overrideFields:[string,string,'theme'|'input'|'textarea'][]=[['siteTheme','前台风格','theme'],['title','站点标题','input'],['description','站点描述','textarea'],['announcement','侧栏公告','textarea'],['icpRecord','ICP 备案号','input'],['publicSecurityRecord','公安备案号','input']];
const overrideLabel=(key:string)=>key==='navigation'?'顶部导航':overrideFields.find(f=>f[0]===key)?.[1]||key;
const online=(r:any)=>r.last_seen_at&&Date.now()-Date.parse(r.last_seen_at)<2*60*1000;

function syncState(r:any){
 if(r.status!=='active')return {tone:'',text:statusText[r.status]||r.status};
 if(r.build_status==='failed')return {tone:'failed',text:'构建失败'};
 if(!r.build_id||['queued','running'].includes(r.build_status))return {tone:'running',text:'正在为子站构建'};
 if(!online(r))return {tone:'failed',text:'子站离线'};
 if(r.reported_error)return {tone:'failed',text:'同步出错'};
 return r.synced?{tone:'success',text:'已同步'}:{tone:'running',text:'等待子站拉取'};
}

export default function Replicas({api,notify}:Props){
 const [data,setData]=useState<any>(null),[docs,setDocs]=useState<any[]>([]),[primary,setPrimary]=useState<any>({}),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [form,setForm]=useState({name:'',primaryUrl:window.location.origin,siteUrl:'https://'});
 const [deploy,setDeploy]=useState<any>(null),[editing,setEditing]=useState<any>(null);
 const load=()=>api('/replicas').then(next=>{setData(next);setError('')}).catch(e=>setError(e.message));
 useEffect(()=>{load();api('/documents').then(setDocs).catch(()=>{});api('/settings').then(setPrimary).catch(()=>{});const timer=setInterval(load,5000);return()=>clearInterval(timer)},[api]);
 const action=async(fn:()=>Promise<any>)=>{setBusy(true);try{await fn();await load()}catch(e){notify((e as Error).message,true)}finally{setBusy(false)}};
 const posts=useMemo(()=>docs.filter(d=>d.kind==='post'&&d.published&&d.visibility!=='private'),[docs]);
 const replicas=data?.replicas||[];
 return <>
  <div className="page-heading"><div><h1>子站</h1><p>子站拥有独立域名，由主站按各自的文章范围构建页面；评论与计数统一写入主站。</p></div></div>
  {error&&<p className="inline-error" role="alert">{error}</p>}
  <section className="panel settings-panel replica-create">
   <div className="panel-title"><h2>新建子站</h2></div>
   <p className="muted">填写主站与子站的访问地址后生成一次性部署命令。在子站服务器上运行该命令即可自动接入；认证码 24 小时内有效，只能使用一次。</p>
   <form onSubmit={e=>{e.preventDefault();action(async()=>{const result=await api('/replicas',{method:'POST',body:form});setDeploy(result);setForm({...form,name:'',siteUrl:'https://'})})}}>
    <div className="form-grid replica-form">
     <label className="field"><span>名称</span><input required maxLength={100} value={form.name} placeholder="例如：海外子站" onChange={e=>setForm({...form,name:e.target.value})}/></label>
     <label className="field"><span>主站地址</span><input required value={form.primaryUrl} placeholder="https://blog.example.com" onChange={e=>setForm({...form,primaryUrl:e.target.value})}/></label>
     <label className="field"><span>子站地址</span><input required value={form.siteUrl} placeholder="https://mirror.example.com" onChange={e=>setForm({...form,siteUrl:e.target.value})}/></label>
    </div>
    <button className="button primary" type="submit" disabled={busy}><Plus size={16}/><span>生成部署命令</span></button>
   </form>
  </section>
  {data&&!replicas.length&&<section className="panel"><div className="empty">还没有子站。</div></section>}
  {replicas.map((r:any)=>{const state=syncState(r);const outdated=r.status==='active'&&data.primaryRevision&&r.reported_revision&&r.reported_revision!==data.primaryRevision;const updating=['requested','running'].includes(r.update_status);return <section className="panel settings-panel update-panel replica-card" key={r.id}>
   <div className="panel-title"><div className="replica-title"><Network size={18}/><h2>{r.name}</h2></div><span className={'job-status '+state.tone}>{state.text}</span></div>
   <dl className="update-details">
    <div><dt>子站地址</dt><dd><a href={r.site_url} target="_blank" rel="noopener noreferrer">{r.site_url}</a></dd></div>
    <div><dt>文章范围</dt><dd>{r.mode==='selected'?`只显示选中的 ${r.documentIds.length} 篇`:r.documentIds.length?`显示全部，排除 ${r.documentIds.length} 篇`:'显示全部文章'}<span className="muted">（自定义页面始终显示）</span></dd></div>
    <div><dt>页面定制</dt><dd>{Object.keys(r.settings||{}).length?Object.keys(r.settings).map(overrideLabel).join('、'):'全部跟随主站'}</dd></div>
    <div><dt>最后通信</dt><dd>{r.status==='pending'?(r.enrollPending?'等待子站使用认证码接入':'认证码已过期，请重新生成部署命令'):date(r.last_seen_at)}</dd></div>
    {r.status==='active'&&<div><dt>页面版本</dt><dd>{buildText[r.build_status]||'尚未构建'}{r.built_at&&<span className="muted">，{date(r.built_at)}</span>}{r.build_error&&<span className="inline-error replica-error">{r.build_error}</span>}{r.reported_error&&<span className="inline-error replica-error">子站报告：{r.reported_error}</span>}</dd></div>}
    {r.status==='active'&&<div><dt>程序版本</dt><dd><code>{short(r.reported_revision)}</code><span className="muted">{outdated?`，主站为 ${short(data.primaryRevision)}`:r.reported_revision?'，与主站一致':''}</span>{r.update_status&&<span className="muted replica-update">更新：{updateText[r.update_status]||r.update_status}{r.update_message?`，${r.update_message}`:''}</span>}</dd></div>}
   </dl>
   <div className="replica-actions">
    {r.status!=='revoked'&&<button className="button" disabled={busy} onClick={()=>setEditing({id:r.id,name:r.name,siteUrl:r.site_url,mode:r.mode,documentIds:r.documentIds,settings:r.settings||{}})}><SlidersHorizontal size={16}/><span>子站设置</span></button>}
    {r.status==='active'&&<button className="button" disabled={busy} onClick={()=>action(async()=>{await api(`/replicas/${r.id}/build`,{method:'POST'});notify('已加入构建队列。')})}><RefreshCw size={16}/><span>重新构建</span></button>}
    {r.status==='active'&&<button className="button" disabled={busy||updating||!data.primaryRevision} title={data.primaryRevision?'':'主站程序版本未知'} onClick={()=>{if(window.confirm(`让子站从 GitHub 更新到主站当前版本 ${short(data.primaryRevision)}？更新期间子站会短暂重启。`))action(async()=>{await api(`/replicas/${r.id}/update`,{method:'POST'});notify('更新请求已发出，子站下次同步时领取。')})}}><Download size={16}/><span>{updating?'更新进行中':'更新子站程序'}</span></button>}
    <button className="button" disabled={busy} onClick={()=>action(async()=>setDeploy(await api(`/replicas/${r.id}/code`,{method:'POST',body:{primaryUrl:r.primary_url}})))}><KeyRound size={16}/><span>{r.status==='active'?'重新生成部署命令':'生成新的部署命令'}</span></button>
    {r.status==='active'&&<button className="button" disabled={busy} onClick={()=>{if(window.confirm('吊销后子站无法再同步新内容，也无法转发评论；已同步的页面会继续显示。确定吊销吗？'))action(async()=>{await api(`/replicas/${r.id}/revoke`,{method:'POST'});notify('子站凭据已吊销。')})}}><Ban size={16}/><span>吊销</span></button>}
    <button className="button" disabled={busy} onClick={()=>{if(window.confirm('删除子站记录及主站上为它构建的页面？子站服务器上的文件不会被删除。'))action(async()=>{await api(`/replicas/${r.id}`,{method:'DELETE'});notify('子站已删除。')})}}><Trash2 size={16}/><span>删除</span></button>
   </div>
  </section>})}
  {deploy&&<DeployModal deploy={deploy} notify={notify} onClose={()=>setDeploy(null)}/>}
  {editing&&<ScopeModal value={editing} posts={posts} primary={primary} busy={busy} onClose={()=>setEditing(null)} onSave={(v:any)=>action(async()=>{await api(`/replicas/${v.id}`,{method:'PUT',body:v});setEditing(null);notify('子站设置已保存，将自动重新构建。')})}/>}
 </>;
}

function DeployModal({deploy,notify,onClose}:any){
 const copy=async()=>{try{await navigator.clipboard.writeText(deploy.command);notify('部署命令已复制。')}catch{notify('无法访问剪贴板，请手动选择命令复制。',true)}};
 return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="子站部署命令"><section className="modal replica-deploy">
  <div className="panel-title"><h2>部署 {deploy.replica.name}</h2><button aria-label="关闭" onClick={onClose}><X/></button></div>
  <p>在子站服务器上（需已安装 Docker 与 Git）运行下面的命令。它会从 GitHub 拉取源码、构建轻量子站镜像并用认证码接入主站。</p>
  <pre className="command-box">{deploy.command}</pre>
  <p className="muted">认证码只在此处显示一次，有效期至 {date(deploy.expiresAt)}。之后请在子站服务器配置 {deploy.replica.site_url} 的 HTTPS 反向代理到 127.0.0.1:4322。</p>
  <div className="replica-actions"><button className="button primary" onClick={copy}><Copy size={16}/><span>复制命令</span></button><button className="button" onClick={onClose}><span>完成</span></button></div>
 </section></div>;
}

function ScopeModal({value,posts,primary,busy,onClose,onSave}:any){
 const [v,setV]=useState(value),[query,setQuery]=useState('');
 const chosen=new Set<string>(v.documentIds);
 const shown=posts.filter((p:any)=>(p.title+' '+p.path).toLowerCase().includes(query.toLowerCase()));
 const toggle=(id:string)=>setV({...v,documentIds:chosen.has(id)?v.documentIds.filter((x:string)=>x!==id):[...v.documentIds,id]});
 const custom=(key:string)=>Object.prototype.hasOwnProperty.call(v.settings,key);
 const setOverride=(key:string,value:any)=>setV({...v,settings:{...v.settings,[key]:value}});
 const toggleOverride=(key:string)=>{const next={...v.settings};if(custom(key))delete next[key];else next[key]=key==='navigation'?(primary.navigation||[]).map((n:any)=>({label:n.label,href:n.href})):primary[key]??'';setV({...v,settings:next})};
 const nav=custom('navigation')?v.settings.navigation:primary.navigation||[];
 const visible=v.mode==='selected'?posts.filter((p:any)=>chosen.has(p.id)).length:posts.filter((p:any)=>!chosen.has(p.id)).length;
 return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="子站文章范围"><section className="modal replica-scope">
  <div className="panel-title"><h2>子站设置</h2><button aria-label="关闭" onClick={onClose}><X/></button></div>
  <div className="form-grid"><label className="field"><span>名称</span><input value={v.name} maxLength={100} onChange={e=>setV({...v,name:e.target.value})}/></label><label className="field"><span>子站地址</span><input value={v.siteUrl} onChange={e=>setV({...v,siteUrl:e.target.value})}/></label></div>
  <h3 className="replica-section">文章范围</h3>
  <label className="field"><span>显示方式</span><select value={v.mode} onChange={e=>setV({...v,mode:e.target.value})}><option value="all">显示全部文章，排除勾选的文章</option><option value="selected">只显示勾选的文章</option></select></label>
  <p className="muted">{v.mode==='selected'?'以后新发布的文章默认不在子站显示，需要回到这里勾选。':'以后新发布的文章默认在子站显示。'}自定义页面始终显示。当前子站将显示 {visible} / {posts.length} 篇已发布文章。</p>
  <div className="search-input replica-search"><Search size={15}/><input aria-label="搜索文章" placeholder="搜索标题或路径" value={query} onChange={e=>setQuery(e.target.value)}/></div>
  <div className="replica-doc-list">{shown.length?shown.map((p:any)=><label className="check-row" key={p.id}><input type="checkbox" checked={chosen.has(p.id)} onChange={()=>toggle(p.id)}/><span><strong>{p.title}</strong><small>{p.path}</small></span></label>):<div className="empty">没有匹配的已发布文章。</div>}</div>
  <h3 className="replica-section">外观与页面信息</h3>
  <p className="muted">未勾选“自定义”的项目跟随主站的站点设置；主站修改后子站会随下次构建更新。</p>
  {overrideFields.map(([key,label,kind])=><div className="replica-override" key={key}>
   <label className="check-row"><input type="checkbox" checked={custom(key)} onChange={()=>toggleOverride(key)}/><span>自定义{/^[A-Za-z]/.test(label)?' ':''}{label}</span></label>
   {custom(key)?kind==='theme'?<select aria-label={label} value={v.settings[key]} onChange={e=>setOverride(key,e.target.value)}>{siteThemes.map((t:any)=><option key={t.id} value={t.id}>{t.name}</option>)}</select>:kind==='textarea'?<textarea aria-label={label} rows={3} value={v.settings[key]} onChange={e=>setOverride(key,e.target.value)}/>:<input aria-label={label} value={v.settings[key]} placeholder={key.endsWith('Record')?'留空则不显示':''} onChange={e=>setOverride(key,e.target.value)}/>
   :<p className="replica-inherit">{kind==='theme'?siteThemes.find((t:any)=>t.id===primary[key])?.name||'—':String(primary[key]||'').trim()||'（主站未填写）'}</p>}
  </div>)}
  <div className="replica-override">
   <label className="check-row"><input type="checkbox" checked={custom('navigation')} onChange={()=>toggleOverride('navigation')}/><span>自定义顶部导航</span></label>
   {custom('navigation')?<div className="replica-nav">{nav.map((n:any,i:number)=><div className="replica-nav-row" key={i}><input aria-label="导航名称" value={n.label} maxLength={40} placeholder="名称" onChange={e=>setOverride('navigation',nav.map((x:any,j:number)=>j===i?{...x,label:e.target.value}:x))}/><input aria-label="导航地址" value={n.href} placeholder="/about 或 https://" onChange={e=>setOverride('navigation',nav.map((x:any,j:number)=>j===i?{...x,href:e.target.value}:x))}/><button className="small-icon" aria-label="删除导航" onClick={()=>setOverride('navigation',nav.filter((_:any,j:number)=>j!==i))}><X size={16}/></button></div>)}{nav.length<20&&<button className="button" onClick={()=>setOverride('navigation',[...nav,{label:'',href:'/'}])}><Plus size={16}/><span>添加导航</span></button>}</div>
   :<p className="replica-inherit">{nav.map((n:any)=>n.label).join(' / ')||'（主站未设置导航）'}</p>}
  </div>
  <div className="replica-actions"><button className="button primary" disabled={busy} onClick={()=>onSave(v)}><Save size={16}/><span>保存并重新构建</span></button><a className="button" href={v.siteUrl} target="_blank" rel="noopener noreferrer"><ArrowUpRight size={16}/><span>访问子站</span></a></div>
 </section></div>;
}
