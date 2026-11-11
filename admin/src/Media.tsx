import React,{useEffect,useMemo,useState} from 'react';import {createPortal} from 'react-dom';
import {Upload,Search,FileText,Film,Music,Type,X,Copy,Save,Trash2,ExternalLink,Link2} from 'lucide-react';

type Usage={id:string,kind:string,title:string,path:string,deleted:boolean};
type Item={id:string,name:string,alt:string,path:string,type:string,size:number,created_at:string,usage:Usage[]};
type Props={api:(url:string,options?:any)=>Promise<any>,notify:(message:string,error?:boolean)=>void,onAction:(fn:()=>Promise<void>)=>void};

const kinds=[['all','全部'],['image','图片'],['video','视频'],['audio','音频'],['document','文档'],['font','字体']] as const;
const kindOf=(type:string)=>type.startsWith('image/')?'image':type.startsWith('video/')?'video':type.startsWith('audio/')?'audio':type.startsWith('font/')?'font':'document';
const sorts=[['new','最新上传'],['old','最早上传'],['name','名称'],['large','文件最大'],['small','文件最小']] as const;
const formatSize=(n:number)=>n>=1024*1024?(n/1024/1024).toFixed(1)+' MB':(n/1024).toFixed(1)+' KB';
const kindLabel:Record<string,string>={post:'文章',page:'页面',settings:'设置'};
const markdownOf=(m:Item)=>kindOf(m.type)==='image'?`![${(m.alt||m.name).replace(/[\[\]]/g,'')}](${encodeURI(m.path)})`:`[${m.name.replace(/[\[\]]/g,'')}](${encodeURI(m.path)})`;
const Icon=({type}:{type:string})=>{const k=kindOf(type);const C=k==='video'?Film:k==='audio'?Music:k==='font'?Type:FileText;return <div className="media-file"><C size={40}/></div>};

export default function Media({api,notify,onAction}:Props){
 const [items,setItems]=useState<Item[]>([]),[loaded,setLoaded]=useState(false);
 const [query,setQuery]=useState(''),[kind,setKind]=useState('all'),[usage,setUsage]=useState('all'),[sort,setSort]=useState('new');
 const [selected,setSelected]=useState<Item|null>(null);
 const load=()=>api('/media').then((list:Item[])=>{setItems(list);setLoaded(true);setSelected(s=>s?list.find(m=>m.id===s.id)||null:null)});
 useEffect(()=>{load().catch((e:any)=>notify(e.message,true))},[]);
 const counts=useMemo(()=>Object.fromEntries(kinds.map(([k])=>[k,k==='all'?items.length:items.filter(m=>kindOf(m.type)===k).length])),[items]);
 const visible=useMemo(()=>{
  const q=query.trim().toLowerCase();
  const list=items.filter(m=>(kind==='all'||kindOf(m.type)===kind)&&(usage==='all'||(usage==='used')===(m.usage.length>0))&&(!q||[m.name,m.alt,m.path].some(v=>(v||'').toLowerCase().includes(q))));
  const by:Record<string,(a:Item,b:Item)=>number>={new:(a,b)=>b.created_at.localeCompare(a.created_at),old:(a,b)=>a.created_at.localeCompare(b.created_at),name:(a,b)=>a.name.localeCompare(b.name,'zh-CN'),large:(a,b)=>b.size-a.size,small:(a,b)=>a.size-b.size};
  return list.sort(by[sort]);
 },[items,query,kind,usage,sort]);
 const unused=items.filter(m=>!m.usage.length).length;
 return <>
  <div className="page-heading"><div><h1>媒体库</h1><p>点击文件查看详情、编辑说明或复制地址。文件地址上传后固定不变。</p></div><label className="button primary"><Upload size={16}/>上传文件<input className="hidden-input" type="file" multiple accept="image/*,.pdf,.mp4,.mp3,.woff2" onChange={e=>{const files=e.target.files;if(files?.length)onAction(async()=>{const form=new FormData();for(const f of files)form.append('files',f);await api('/media',{method:'POST',body:form});e.target.value='';await load();notify('媒体文件已上传。')})}}/></label></div>
  <div className="list-toolbar media-toolbar">
   <div className="search-input"><Search size={17}/><input aria-label="搜索文件名、说明或地址" placeholder="搜索文件名、说明或地址" value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button className="icon-button" aria-label="清除搜索" onClick={()=>setQuery('')}><X size={15}/></button>}</div>
   <select aria-label="引用状态" value={usage} onChange={e=>setUsage(e.target.value)}><option value="all">全部引用状态</option><option value="used">已被引用</option><option value="unused">未被引用（{unused}）</option></select>
   <select aria-label="排序" value={sort} onChange={e=>setSort(e.target.value)}>{sorts.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select>
   <span>{visible.length} / {items.length} 个文件</span>
  </div>
  <div className="segmented filter-tabs media-kinds" role="group" aria-label="按类型筛选">{kinds.filter(([k])=>k==='all'||counts[k]).map(([k,l])=><button key={k} className={kind===k?'active':''} aria-pressed={kind===k} onClick={()=>setKind(k)}>{l}<span>{counts[k]}</span></button>)}</div>
  {loaded&&!visible.length?<div className="panel media-empty">{items.length?'没有符合条件的文件。':'还没有上传任何文件。'}</div>:
  <div className="media-grid">{visible.map(m=><button className="media-card panel" key={m.id} onClick={()=>setSelected(m)}>{kindOf(m.type)==='image'?<img src={m.path} alt={m.alt||m.name} loading="lazy"/>:<Icon type={m.type}/>}<div><strong>{m.name}</strong><small>{formatSize(m.size)}<span className={'media-usage'+(m.usage.length?'':' unused')}>{m.usage.length?`${m.usage.length} 处引用`:'未引用'}</span></small><code>{m.path}</code></div></button>)}</div>}
  {selected&&<MediaDetail key={selected.id} item={selected} api={api} notify={notify} onAction={onAction} onClose={()=>setSelected(null)} onChanged={load}/>}
 </>;
}

function MediaDetail({item,api,notify,onAction,onClose,onChanged}:Props&{item:Item,onClose:()=>void,onChanged:()=>Promise<void>}){
 const [name,setName]=useState(item.name),[alt,setAlt]=useState(item.alt||''),[confirming,setConfirming]=useState(false);
 const dirty=name!==item.name||alt!==(item.alt||'');
 useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==='Escape')onClose()};addEventListener('keydown',key);return ()=>removeEventListener('keydown',key)},[]);
 const copy=async(text:string,label:string)=>{try{await navigator.clipboard.writeText(text);notify(label+'已复制。')}catch{notify('无法访问剪贴板，请手动复制。',true)}};
 const k=kindOf(item.type);
 return createPortal(<div className="modal-backdrop" onClick={e=>{if(e.target===e.currentTarget)onClose()}}><div className="modal media-detail" role="dialog" aria-modal="true" aria-label="媒体详情">
  <div className="media-detail-head"><h2>媒体详情</h2><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={18}/></button></div>
  <div className="media-detail-grid">
   <div className="media-preview">{k==='image'?<img src={item.path} alt={item.alt||item.name}/>:k==='video'?<video src={item.path} controls preload="metadata"/>:k==='audio'?<audio src={item.path} controls preload="metadata"/>:<Icon type={item.type}/>}</div>
   <div className="media-detail-body">
    <dl className="media-meta"><dt>类型</dt><dd>{item.type}</dd><dt>大小</dt><dd>{formatSize(item.size)}</dd><dt>上传时间</dt><dd>{new Date(item.created_at).toLocaleString('zh-CN')}</dd><dt>地址</dt><dd><code>{item.path}</code></dd></dl>
    <label className="field"><span>显示名称</span><input maxLength={200} value={name} onChange={e=>setName(e.target.value)}/></label>
    {k==='image'&&<label className="field"><span>替代文字（alt）</span><input maxLength={300} placeholder="描述图片内容，复制 Markdown 时使用" value={alt} onChange={e=>setAlt(e.target.value)}/></label>}
    <div className="media-actions">
     <button className="button primary" disabled={!dirty||!name.trim()} onClick={()=>onAction(async()=>{await api(`/media/${item.id}`,{method:'PATCH',body:{name,alt}});await onChanged();notify('媒体信息已保存。')})}><Save size={16}/><span>保存</span></button>
     <button className="button" onClick={()=>copy(item.path,'文件地址')}><Copy size={16}/><span>复制地址</span></button>
     <button className="button" onClick={()=>copy(markdownOf({...item,name,alt}),'Markdown')}><Link2 size={16}/><span>复制 Markdown</span></button>
     <a className="button" href={item.path} target="_blank" rel="noreferrer"><ExternalLink size={16}/><span>打开</span></a>
    </div>
    <h3>引用位置</h3>
    {item.usage.length?<ul className="media-usage-list">{item.usage.map(u=><li key={u.id}><span>{kindLabel[u.kind]||u.kind}{u.deleted?' · 回收站':''}</span><strong>{u.title||'无标题'}</strong>{u.path&&<code>{u.path}</code>}</li>)}</ul>:<p className="muted">没有内容或站点设置引用此文件。</p>}
    <div className="media-danger">
     {item.usage.length?<p className="muted">被引用的文件不能删除，请先从上述内容中移除。</p>:confirming?<><p>删除后公开地址立即失效，文件会移到服务器的 media-trash 目录，不再对外提供。</p><div className="media-actions"><button className="button danger" onClick={()=>onAction(async()=>{await api(`/media/${item.id}`,{method:'DELETE'});onClose();await onChanged();notify('文件已从媒体库删除。')})}><Trash2 size={16}/><span>确认删除</span></button><button className="button" onClick={()=>setConfirming(false)}><span>取消</span></button></div></>:<button className="button" onClick={()=>setConfirming(true)}><Trash2 size={16}/><span>删除文件</span></button>}
    </div>
   </div>
  </div>
 </div></div>,document.body);
}
