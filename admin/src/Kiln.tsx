import React,{useEffect,useMemo,useRef,useState} from 'react';
import {mascotMarkup,campfireMarkup} from '../../src/lib/kiln-art.mjs';
import {createSkinController,SKIN_KEY} from './skin';import {defaultSiteTheme} from '../../server/themes.mjs';

// Saved site theme is authoritative after login; the inline script restores the last choice for the first paint.
const currentSkin=()=>document.documentElement.dataset.skin||defaultSiteTheme;
const skinController=createSkinController({
 read:()=>document.documentElement.dataset.skin,
 write:id=>{document.documentElement.dataset.skin=id},
 remember:id=>localStorage.setItem(SKIN_KEY,id)
});
export const applySkin=skinController.apply;
export const previewSkin=skinController.preview;
export const restoreSkin=skinController.restore;
export function useSkin(){
 const [skin,setSkin]=useState(currentSkin());
 useEffect(()=>{
  const observer=new MutationObserver(()=>setSkin(currentSkin()));
  observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-skin']});
  return()=>observer.disconnect();
 },[]);
 return skin;
}

export type Notice={id:number;error:boolean}|null;
type Props={variant?:'sidebar'|'login';building?:boolean;busy?:boolean;shy?:boolean;notice?:Notice};
const tips=['保存草稿不会更新前台，发布后才会。','私密内容不会进入公开站点。','发布失败时，旧版本会继续保留。','点击发布后，窑火会烧到构建完成。'];
const motion=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
const random=(min:number,max:number)=>min+Math.random()*(max-min);

// Mascot and campfire that react to what the admin is really doing:
//  building  -> the fire burns brighter and the mascot walks over to warm its hands (a publish is "firing the kiln")
//  busy      -> a save or request is in flight: the mascot nods
//  notice    -> a toast appeared: cheer on success, startle on error
//  shy       -> a password field has focus: it covers its eyes
// Idle behaviour (blinking, looking around, nodding off after a while) pauses with the tab and reduced motion.
export function KilnCompanion({variant='sidebar',building=false,busy=false,shy=false,notice=null}:Props){
 const stage=useRef<HTMLDivElement>(null),walker=useRef<HTMLSpanElement>(null);
 const live=useRef({building,busy,shy});live.current={building,busy,shy};
 const control=useRef<{refresh:()=>void;react:(n:{id:number;error:boolean})=>void}|null>(null);
 const art=useMemo(()=>({mascot:mascotMarkup({size:3,label:'像素吉祥物，点击查看小提示',hands:true}),fire:campfireMarkup()}),[]);

 useEffect(()=>{
  const root=stage.current,w=walker.current;if(!root||!w)return;
  const button=w.querySelector<HTMLButtonElement>('.mascot')!,bubble=w.querySelector<HTMLElement>('.mascot-bubble')!,eyes=w.querySelector<SVGGElement>('.mascot-look')!;
  const canWalk=variant==='sidebar';
  const timers=new Set<number>();
  const after=(fn:()=>void,ms:number)=>{const id=window.setTimeout(()=>{timers.delete(id);fn()},ms);timers.add(id);return id};
  // Re-check visibility when the timer fires instead of piling up work for a background tab.
  const later=(fn:()=>void,min:number,max:number)=>after(()=>{if(dead)return;if(document.hidden||!root.getClientRects().length){later(fn,min,max);return}fn()},random(min,max));
  let transient:string|null=null,asleep=false,gaze=false,moving=false,atFire=false,x=0,lastActivity=Date.now(),held:[number,number]|null=null,pointer:[number,number]=[0,0],tip=Math.floor(Math.random()*tips.length),bubbleTimer=0,arrival=0,dead=false;

  const eyesAt=()=>{const [dx,dy]=held||pointer;eyes.style.transform=`translate(${dx.toFixed(2)}px,${dy.toFixed(2)}px)`};
  const say=(text:string)=>{bubble.textContent=text;bubble.classList.add('is-visible');clearTimeout(bubbleTimer);bubbleTimer=window.setTimeout(()=>bubble.classList.remove('is-visible'),2600)};
  const hop=()=>{if(motion())return;button.classList.remove('is-hopping');void button.offsetWidth;button.classList.add('is-hopping')};
  const warmSpot=()=>{const fire=root.querySelector<HTMLElement>('.kiln-campfire')!;return Math.max(0,fire.offsetLeft-w.offsetLeft-w.offsetWidth+2)};

  const refresh=()=>{
   if(dead)return;
   const {building,busy,shy}=live.current;
   let pose='idle';
   if(shy)pose='shy';
   else if(transient)pose=transient;
   else if(moving)pose='walk';
   else if(building&&atFire)pose='warm';
   else if(asleep)pose='doze';
   else if(gaze)pose='gaze';
   w.dataset.pose=pose;
   w.classList.toggle('is-reading',busy&&!building&&pose==='idle');
   root.toggleAttribute('data-stoked',building);
  };
  const walkTo=(target:number)=>{
   const distance=Math.abs(target-x);
   const arrive=()=>{moving=false;w.style.transition='';atFire=canWalk&&target>0&&target>=warmSpot()-2;held=null;eyesAt();refresh()};
   if(!canWalk||motion()||distance<4){x=target;w.style.transform=`translateX(${target}px)`;arrive();return}
   moving=true;atFire=false;held=[target>x?1:-1,0];eyesAt();
   const seconds=distance/44;w.style.transition=`transform ${seconds.toFixed(2)}s linear`;w.style.transform=`translateX(${target}px)`;x=target;
   clearTimeout(arrival);arrival=window.setTimeout(arrive,seconds*1000+40);refresh();
  };
  // Walk to the fire while a publish is running; stroll back once it is done.
  let wasBuilding=false;
  const sync=()=>{
   const {building}=live.current;
   if(building&&!wasBuilding)walkTo(warmSpot());
   else if(!building&&wasBuilding)after(()=>{if(!live.current.building)walkTo(0)},1500);
   wasBuilding=building;refresh();
  };
  const react=(n:{id:number;error:boolean})=>{
   transient=n.error?'startled':'cheer';asleep=false;refresh();hop();say(n.error?'出了点问题':'好了');
   after(()=>{transient=null;refresh()},n.error?1400:1600);
  };
  control.current={refresh:sync,react};

  button.addEventListener('animationend',e=>{if(e.animationName==='kiln-hop')button.classList.remove('is-hopping')});
  button.addEventListener('click',()=>{
   if(asleep){asleep=false;transient='startled';refresh();hop();say('我没睡着');after(()=>{transient=null;refresh()},1100);return}
   hop();say(tips[tip++%tips.length]);
  });
  const wake=()=>{
   lastActivity=Date.now();
   if(asleep){asleep=false;transient='stretch';refresh();after(()=>{transient=null;refresh()},900)}
  };
  let pending=0;
  const onMove=(e:PointerEvent)=>{
   wake();
   if(!matchMedia('(pointer: fine)').matches||motion()||pending||held)return;
   pending=requestAnimationFrame(()=>{pending=0;const box=w.getBoundingClientRect();if(!box.width)return;
    pointer=[Math.max(-1,Math.min(1,(e.clientX-box.left-box.width/2)/180)),Math.max(-1,Math.min(1,(e.clientY-box.top-box.height/2)/180))];eyesAt()});
  };
  window.addEventListener('pointermove',onMove,{passive:true});
  const onDown=(e:PointerEvent)=>{if(!button.contains(e.target as Node))wake()};
  window.addEventListener('keydown',wake);window.addEventListener('pointerdown',onDown);

  const blink=()=>{if(!motion()&&['idle','gaze','walk'].includes(w.dataset.pose||'')){w.classList.add('is-blinking');after(()=>w.classList.remove('is-blinking'),140)}later(blink,2500,6500)};
  later(blink,800,4000);
  const wander=()=>{
   const calm=!moving&&!transient&&!asleep&&!live.current.shy&&!live.current.building&&!live.current.busy;
   if(calm&&!motion()){
    const roll=Math.random();
    if(roll<.5){held=[Math.random()<.5?-1:1,0];eyesAt();after(()=>{held=null;eyesAt()},900)}
    else if(roll<.75){gaze=true;refresh();after(()=>{gaze=false;refresh()},2200)}
    else if(canWalk){const room=warmSpot();if(room>30)walkTo(Math.round(random(room*.2,room*.8)));after(()=>{if(!live.current.building&&!moving)walkTo(0)},random(3000,5000))}
   }
   later(wander,6000,12000);
  };
  later(wander,3000,7000);
  // Nod off after a quiet while (sidebar only: the login page is always in use).
  const drowse=window.setInterval(()=>{
   const {building,busy,shy}=live.current;
   if(variant==='sidebar'&&!motion()&&!document.hidden&&!asleep&&!transient&&!moving&&!building&&!busy&&!shy&&Date.now()-lastActivity>45000){asleep=true;refresh()}
  },5000);
  refresh();wasBuilding=false;sync();

  return()=>{
   dead=true;control.current=null;timers.forEach(clearTimeout);clearInterval(drowse);clearTimeout(bubbleTimer);clearTimeout(arrival);cancelAnimationFrame(pending);
   window.removeEventListener('pointermove',onMove);window.removeEventListener('keydown',wake);window.removeEventListener('pointerdown',onDown);
  };
 },[variant]);

 useEffect(()=>{control.current?.refresh()},[building,busy,shy]);
 useEffect(()=>{if(notice)control.current?.react(notice)},[notice?.id]);

 return <div ref={stage} className={'camp-stage camp-'+variant}>
  <span ref={walker} className="mascot-walker" data-pose="idle" dangerouslySetInnerHTML={{__html:art.mascot}}/>
  <div className="kiln-campfire" aria-hidden="true" dangerouslySetInnerHTML={{__html:art.fire}}/>
 </div>;
}
