import {startBackground} from './background';import {startKiln,kilnPage} from './kiln';import {startMotion,motionPage,revealTheme,zoomImage,markToc,burst} from './motion';
// The ClientRouter swaps <body> on in-site navigation. Persisted regions (background, left column, notice,
// drawer, footer, search dialog) keep their listeners, so they are wired once in boot(); everything inside
// the swapped page (header, main, right column) is wired again by page() on every astro:page-load.
const $ = <T extends Element=HTMLElement>(selector:string)=>document.querySelector<T>(selector);
const skin=document.documentElement.dataset.skin||'kiln',darkOnly=document.documentElement.hasAttribute('data-dark-only');
const reducedMotion=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
let userTheme=false;try{userTheme=['dark','light'].includes(localStorage.getItem('blog-theme')||'')}catch{}
function updateThemeButton(){$('.theme-toggle')?.setAttribute('aria-pressed',String(document.documentElement.dataset.theme==='dark'))}

let searchIndex:any[]|null=null,searchLoading:Promise<void>|null=null,searchError=false;
function renderSearch(){const q=$<HTMLInputElement>('#site-search')!.value.trim().toLowerCase();const box=$('.search-results')!;box.replaceChildren();if(searchIndex===null){box.textContent=searchError?'搜索索引暂时无法加载，请关闭后重试。':'正在加载搜索索引…';return}const found=q?searchIndex.filter(p=>(p.title+' '+p.text).toLowerCase().includes(q)).slice(0,30):[];if(!found.length){const p=document.createElement('p');p.textContent=q?'没有找到相关文章。':'输入关键词，搜索全部公开文章。';box.append(p)}for(const p of found){const a=document.createElement('a');a.className='search-result';a.href=p.path;const strong=document.createElement('strong');strong.textContent=p.title;const excerpt=document.createElement('p');excerpt.textContent=p.excerpt;a.append(strong,excerpt);box.append(a)}}
function loadSearch(){if(searchIndex!==null)return Promise.resolve();if(searchLoading)return searchLoading;searchError=false;searchLoading=(async()=>{try{const response=await fetch('/search-index.json');if(!response.ok)throw new Error('索引加载失败');searchIndex=await response.json()}catch{searchError=true}finally{searchLoading=null;renderSearch()}})();return searchLoading}

const uptimeText:Record<string,string>={up:'所有服务运行正常',degraded:'部分服务异常',down:'服务中断',unknown:'服务状态'};
// Footer status pill: hidden unless the server has an Uptime Kuma page configured; failures fall back to a plain link.
async function loadUptime(){const line=$('.uptime-line'),pill=$<HTMLAnchorElement>('.uptime-pill');if(!line||!pill)return;try{const r=await fetch('/api/public/uptime');if(!r.ok)return;const d=await r.json();if(!d.configured||!/^https?:\/\//.test(d.url))return;const status=uptimeText[d.status]?d.status:'unknown';pill.href=d.url;pill.dataset.status=status;const pct=status!=='unknown'&&typeof d.uptime==='number'?` · ${(Math.floor(d.uptime*10000)/100).toFixed(2)}%`:'';pill.querySelector('.uptime-text')!.textContent=uptimeText[status]+pct;pill.title=d.window?`查看状态页（可用率统计窗口：${d.window==='30d'?'30 天':'24 小时'}）`:'查看状态页';line.hidden=false}catch{}}
function boot(){
 matchMedia('(prefers-color-scheme: dark)').addEventListener('change',e=>{if(!userTheme&&!darkOnly){document.documentElement.dataset.theme=e.matches?'dark':'light';updateThemeButton()}});
 const background=$<HTMLCanvasElement>('.background-stars');if(background)startBackground(background,skin);
 loadUptime();const days=$('#site-days');if(days)days.textContent=String(Math.max(0,Math.floor((Date.now()-new Date((days as HTMLElement).dataset.start!).getTime())/86400000)));
 const dialog=$<HTMLDialogElement>('.search-dialog')!;
 $('.search-close')?.addEventListener('click',()=>dialog.close());
 dialog?.addEventListener('click',e=>{if(e.target===dialog)dialog.close()});
 $('#site-search')?.addEventListener('input',renderSearch);
 // Header buttons are re-rendered on every page, so they are handled by delegation.
 document.addEventListener('click',e=>{
  const t=e.target as Element;
  if(t.closest?.('.theme-toggle')){const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';userTheme=true;try{localStorage.setItem('blog-theme',theme)}catch{}revealTheme(t.closest('.theme-toggle')!,()=>{document.documentElement.dataset.theme=theme;updateThemeButton()})}
  else if(t.closest?.('.search-trigger')){dialog.showModal();$('#site-search')?.focus();loadSearch();renderSearch()}
  else if(t.closest?.('.mobile-menu')){const drawer=$<HTMLElement>('.mobile-drawer')!;drawer.hidden=!drawer.hidden;$('.mobile-menu')?.setAttribute('aria-expanded',String(!drawer.hidden))}
  else if(t.closest?.('.back-top'))window.scrollTo({top:0,behavior:reducedMotion()?'instant':'smooth'});
 });
 routerHooks();startMotion();
 // Persisted cards have finished their entrance; mark them so re-attaching after a swap does not replay it.
 window.setTimeout(()=>document.querySelectorAll<HTMLElement>('[data-astro-transition-persist]').forEach(el=>el.dataset.settled=''),1200);
 if(skin==='kiln')startKiln();
}

function routerHooks(){
 const progress=$<HTMLElement>('.route-progress');let slow=0,doneTimer=0;
 const finish=()=>{clearTimeout(slow);if(!progress?.classList.contains('is-loading'))return;progress.classList.replace('is-loading','is-done');doneTimer=window.setTimeout(()=>progress.classList.remove('is-done'),500)};
 document.addEventListener('astro:before-preparation',()=>{
  clearTimeout(slow);clearTimeout(doneTimer);
  // Only show progress when loading is noticeable; prefetched pages swap before it appears.
  slow=window.setTimeout(()=>{if(!progress)return;progress.classList.remove('is-done');void progress.offsetWidth;progress.classList.add('is-loading')},140);
 });
 document.addEventListener('astro:before-swap',(e:any)=>{
  const next:Document=e.newDocument;
  // A republish between page loads changes the hashed bundle; load that page normally instead of mixing versions.
  const scripts=(doc:Document)=>[...doc.querySelectorAll<HTMLScriptElement>('script[type=module][src]')].map(s=>new URL(s.getAttribute('src')!,location.href).pathname).sort().join();
  if(scripts(next)!==scripts(document)){e.swap=()=>location.assign(e.to);return}
  // The theme lives on <html>, whose attributes are replaced by the new page's; carry the current choice over.
  // Marks a swapped-in page so shell elements (header) skip their first-load entrance animation.
  next.documentElement.dataset.routed='';
  if(!darkOnly&&document.documentElement.dataset.theme)next.documentElement.dataset.theme=document.documentElement.dataset.theme;
  $<HTMLDialogElement>('.search-dialog')?.close();
  const drawer=$<HTMLElement>('.mobile-drawer');if(drawer)drawer.hidden=true;
 });
 document.addEventListener('astro:after-swap',finish);
 document.addEventListener('astro:page-load',finish);
}

// One page view per loaded page, including client-router navigations. Only the landing page carries the external
// referrer and utm_source; later views report the previous in-site page so they count as internal traffic.
// Browsers keep the original referrer on reload, so a reloaded page is flagged and never counted as a new arrival.
let lastPage='';
function trackPageview(){
 const landing=!lastPage,referrer=landing?document.referrer:lastPage;lastPage=location.href;
 const reload=landing&&(performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming|undefined)?.type==='reload';
 let path=location.pathname;try{path=decodeURI(path)}catch{}
 const campaign=landing&&!reload?new URLSearchParams(location.search).get('utm_source')||'':'';
 fetch('/api/public/pageview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path,referrer,campaign,reload}),keepalive:true,credentials:'same-origin'}).catch(()=>{});
}

// Everything below lives inside the swapped page and is wired for each page.
function page(){
 updateThemeButton();
 trackPageview();
 // Copy feedback returns to the original label after a moment.
 document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(b=>{const label=b.textContent||'复制';let reset=0;b.addEventListener('click',async()=>{let copied=true;try{await navigator.clipboard.writeText(b.closest('.code-block')!.querySelector('code')!.textContent||'')}catch{copied=false}b.textContent=copied?'已复制':'请选中代码复制';b.classList.toggle('is-copied',copied);clearTimeout(reset);reset=window.setTimeout(()=>{b.textContent=label;b.classList.remove('is-copied')},1800)})});
 $('.share-button')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(location.href);$('.share-button')!.textContent='链接已复制'}catch{$('.share-button')!.textContent='请复制地址栏链接'}});
 document.querySelectorAll<HTMLImageElement>('.prose img').forEach(img=>img.addEventListener('click',()=>zoomImage(img)));
 const id=$<HTMLElement>('main')?.dataset.documentId;
 async function comments(){if(!id||!$('.comment-list'))return;try{const rows=await(await fetch(`/api/public/documents/${id}/comments`)).json();const list=$('.comment-list')!;list.replaceChildren();if(!rows.length)list.textContent='还没有评论，欢迎留下你的想法。';for(const [n,c] of rows.entries()){const item=document.createElement('div');item.className='comment-item';item.style.setProperty('--i',String(Math.min(n,8)));const name=document.createElement('strong');name.textContent=c.author;const time=document.createElement('time');time.textContent=new Date(c.created_at).toLocaleDateString('zh-CN');const body=document.createElement('p');body.textContent=c.content;item.append(name,time,body);list.append(item)}}catch{const list=$('.comment-list');if(list)list.textContent='评论暂时无法加载。'}}
 if(id){comments();fetch(`/api/public/documents/${id}/visit`,{method:'POST'}).then(r=>r.json()).then(s=>{if($('.visit-count'))$('.visit-count')!.textContent=s.visits}).catch(()=>{});$('.like-button')?.addEventListener('click',async()=>{try{const r=await fetch(`/api/public/documents/${id}/like`,{method:'POST'});const s=await r.json();if(r.ok){const button=$<HTMLButtonElement>('.like-button')!;$('.like-count')!.textContent=s.likes;button.disabled=true;button.classList.add('is-liked');burst(button)}}catch{}})}
 $('.comment-form')?.addEventListener('submit',async e=>{e.preventDefault();const form=e.target as HTMLFormElement;const button=form.querySelector('button')!;button.disabled=true;try{const values=Object.fromEntries(new FormData(form));const r=await fetch(`/api/public/documents/${id}/comments`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)});const result=await r.json();if(!r.ok)throw new Error(result.message||'提交失败');$('.form-status')!.textContent='评论已提交，审核后显示。';form.reset()}catch(e){$('.form-status')!.textContent=(e as Error).message}finally{button.disabled=false}});
 const headings=document.querySelectorAll('.prose h1,.prose h2,.prose h3,.prose h4,.prose h5,.prose h6');if(headings.length&&'IntersectionObserver' in window){const observer=new IntersectionObserver(entries=>{if(!document.contains(headings[0]))return observer.disconnect();for(const entry of entries)if(entry.isIntersecting){document.querySelectorAll('.toc a').forEach(a=>a.classList.toggle('current',a.getAttribute('href')===`#${entry.target.id}`));markToc()}},{rootMargin:'-70px 0px -70% 0px'});headings.forEach(h=>observer.observe(h));document.addEventListener('astro:before-swap',()=>observer.disconnect(),{once:true})}
 motionPage();
 if(skin==='kiln')kilnPage();
}

// A bundled module runs once per full load; guard against a second copy (e.g. served from another build).
const w=window as any;
if(!w.__blogBooted){w.__blogBooted=true;boot();document.addEventListener('astro:page-load',page)}
