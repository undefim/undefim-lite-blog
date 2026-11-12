// Motion shared by every theme: shared elements between a post card and its article, theme reveal, image zoom,
// table-of-contents marker, count-up, scroll ring, like burst. All of it is decorative: without this module, or
// with prefers-reduced-motion, pages are complete and static.
const motion=matchMedia('(prefers-reduced-motion: reduce)');
const root=document.documentElement;

const pathOf=(href:string|URL)=>{
 try{const url=new URL(href,location.href);if(url.origin!==location.origin)return '';let path=url.pathname;try{path=decodeURI(path)}catch{}return path.length>1?path.replace(/\/$/,''):path}catch{return ''}
};

// A post card's title and cover share a view-transition name with the article they open, so the browser morphs
// one into the other. Names are attached with data-morph only for the navigation in progress: a name present on
// one side only would detach that element from the page fade for no benefit.
function morph(){
 let from='';
 const tagCard=(path:string)=>{
  if(!path||path==='/')return;
  for(const link of document.querySelectorAll<HTMLAnchorElement>('.post-card h2 a')){
   if(pathOf(link.href)!==path)continue;
   link.closest('h2')?.setAttribute('data-morph','title');
   link.closest('.post-card')?.querySelector('.post-cover img')?.setAttribute('data-morph','cover');
   return;
  }
 };
 const tagArticle=(doc:Document)=>{
  doc.querySelector('.article-header h1')?.setAttribute('data-morph','title');
  doc.querySelector('.article-cover')?.setAttribute('data-morph','cover');
 };
 document.addEventListener('astro:before-preparation',(e:any)=>{
  document.querySelectorAll('[data-morph]').forEach(el=>el.removeAttribute('data-morph'));
  from=pathOf(e.from);tagCard(pathOf(e.to));tagArticle(document);
 });
 // The incoming article only takes part when the page being left has a partner for it.
 document.addEventListener('astro:before-swap',(e:any)=>{if(document.querySelector('[data-morph=title]'))tagArticle(e.newDocument)});
 // Returning to a list: the card that leads back to the page just left receives its title.
 document.addEventListener('astro:after-swap',()=>tagCard(from));
}

// Light/dark switch: the new theme grows as a circle from the toggle. Falls back to an instant switch.
export function revealTheme(origin:Element,apply:()=>void){
 const start=(document as any).startViewTransition;
 if(motion.matches||typeof start!=='function'||root.hasAttribute('data-theme-switch'))return apply();
 const box=origin.getBoundingClientRect(),x=box.left+box.width/2,y=box.top+box.height/2;
 const props:Record<string,number>={'--reveal-x':x,'--reveal-y':y,'--reveal-r':Math.hypot(Math.max(x,innerWidth-x),Math.max(y,innerHeight-y))};
 for(const [name,value] of Object.entries(props))root.style.setProperty(name,`${value.toFixed(1)}px`);
 root.dataset.themeSwitch='';
 const done=()=>{delete root.dataset.themeSwitch;for(const name of Object.keys(props))root.style.removeProperty(name)};
 try{start.call(document,apply).finished.then(done,done)}catch{done();apply()}
}

// Article images open from where they sit in the text and return there on close.
export function zoomImage(img:HTMLImageElement){
 const dialog=document.createElement('dialog');dialog.className='lightbox';
 const full=document.createElement('img');full.src=img.currentSrc||img.src;full.alt=img.alt;
 const close=document.createElement('button');close.textContent='关闭';
 dialog.append(full,close);
 const animated=!motion.matches&&typeof full.animate==='function';
 if(animated)dialog.classList.add('is-zooming');
 // Uniform scale between the two centres: the inline image may be letterboxed, so widths are compared only.
 const frames=()=>{
  if(!animated||motion.matches)return null;
  const a=img.getBoundingClientRect(),b=full.getBoundingClientRect();if(!a.width||!b.width)return null;
  return [{transform:`translate(${(a.left+a.width/2-b.left-b.width/2).toFixed(1)}px,${(a.top+a.height/2-b.top-b.height/2).toFixed(1)}px) scale(${(a.width/b.width).toFixed(4)})`},{transform:'none'}];
 };
 let leaving=false;
 const leave=()=>{
  if(leaving)return;leaving=true;
  const keys=frames();if(!keys)return dialog.close();
  dialog.classList.add('is-leaving');
  const animation=full.animate([keys[1],keys[0]],{duration:240,easing:'cubic-bezier(.4,0,.2,1)',fill:'forwards'});
  // A stalled timeline (hidden tab) must not leave the dialog open.
  Promise.race([animation.finished.catch(()=>{}),new Promise(resolve=>window.setTimeout(resolve,700))]).then(()=>dialog.close());
 };
 close.addEventListener('click',leave);full.addEventListener('click',leave);
 dialog.addEventListener('click',e=>{if(e.target===dialog)leave()});
 dialog.addEventListener('cancel',e=>{e.preventDefault();leave()});
 dialog.addEventListener('close',()=>dialog.remove());
 const open=()=>{
  if(!img.isConnected)return;
  document.body.append(dialog);dialog.showModal();
  const keys=frames();if(keys)full.animate(keys,{duration:380,easing:'cubic-bezier(.2,.8,.2,1)'});
 };
 // The file is already loaded for the inline image; decoding first gives the dialog its final size at once.
 (full.decode?full.decode():Promise.resolve()).then(open,open);
}

// One bar slides to the current entry of the table of contents and keeps it in view inside its scroller.
export function markToc(){
 const nav=document.querySelector<HTMLElement>('.toc nav'),current=nav?.querySelector<HTMLElement>('a.current');
 if(!nav||!current||!current.offsetParent)return;
 let marker=nav.querySelector<HTMLElement>('.toc-marker');
 if(!marker){marker=document.createElement('span');marker.className='toc-marker';marker.setAttribute('aria-hidden','true');nav.append(marker);nav.closest('.toc')?.classList.add('has-marker')}
 const top=current.offsetTop,height=current.offsetHeight;
 marker.style.height=`${height}px`;marker.style.transform=`translate(${current.offsetLeft}px,${top}px)`;marker.style.opacity='1';
 if(top<nav.scrollTop+8||top+height>nav.scrollTop+nav.clientHeight-8)nav.scrollTo({top:top-nav.clientHeight/2+height/2,behavior:motion.matches?'instant':'smooth'});
}

// Small burst of dots from the heart once a like is accepted.
export function burst(button:HTMLElement){
 const icon=button.querySelector('svg');if(motion.matches||!icon)return;
 const a=button.getBoundingClientRect(),b=icon.getBoundingClientRect();
 const dots=document.createElement('span');dots.className='like-burst';dots.setAttribute('aria-hidden','true');
 dots.style.left=`${b.left-a.left-button.clientLeft+b.width/2}px`;dots.style.top=`${b.top-a.top-button.clientTop+b.height/2}px`;
 button.append(dots);window.setTimeout(()=>dots.remove(),800);
}

// Profile numbers count up once per full load.
function countUp(){
 if(motion.matches||document.hidden)return;
 for(const el of document.querySelectorAll<HTMLElement>('.profile-stats strong')){
  const text=(el.textContent||'').trim(),target=Number(text);if(!/^\d+$/.test(text)||target<2)continue;
  const start=performance.now()+350,duration=Math.min(1400,600+target*4);
  el.textContent='0';
  const step=(now:number)=>{const t=Math.min(1,Math.max(0,(now-start)/duration));el.textContent=t<1?String(Math.round(target*(1-Math.pow(1-t,3)))):text;if(t<1)requestAnimationFrame(step)};
  requestAnimationFrame(step);
 }
}

// The back-to-top button carries a ring showing how far the page is scrolled. The button is re-rendered with
// each page, so it is looked up on every update.
let updateRing=()=>{};
function scrollRing(){
 let pending=0;
 const update=updateRing=()=>{
  pending=0;const holder=document.querySelector<HTMLElement>('.floating-actions');if(!holder)return;
  const max=root.scrollHeight-window.innerHeight;
  holder.style.setProperty('--page-progress',(max>0?Math.min(1,Math.max(0,window.scrollY/max)):0).toFixed(3));
 };
 window.addEventListener('scroll',()=>{if(!pending)pending=requestAnimationFrame(update)},{passive:true});
 window.addEventListener('resize',update,{passive:true});
 document.addEventListener('astro:after-swap',update);
}

// Jumping to a heading from the table of contents briefly highlights it. A class is used instead of :target
// because the router may handle same-page hashes without a native fragment navigation.
function flashTargets(){
 document.addEventListener('click',e=>{
  const link=(e.target as Element).closest?.<HTMLAnchorElement>('.toc a[href^="#"],.mobile-toc a[href^="#"]');if(!link||motion.matches)return;
  let id=link.getAttribute('href')!.slice(1);try{id=decodeURIComponent(id)}catch{}
  const heading=document.getElementById(id);if(!heading)return;
  heading.classList.remove('is-flashed');void heading.offsetWidth;heading.classList.add('is-flashed');
  window.setTimeout(()=>heading.classList.remove('is-flashed'),1900);
 });
}

// Once per full load.
export function startMotion(){morph();scrollRing();flashTargets();countUp()}
// For every page, including the first.
export function motionPage(){updateRing()}
