// Pixel art markup shared by the public site (Astro) and the admin (React), so the mascot and the campfire are drawn
// in exactly one place. Styles live in src/styles/kiln-creatures.css; poses are driven by data-pose / data-stoked.
const escape=text=>String(text).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');

// Three hand-tuned flame frames (column heights above the logs) cycled by CSS for a pixel flicker.
const frames=[
 {outer:[2,4,6,9,11,10,8,5,3,1],mid:[0,2,4,6,8,7,5,3,1,0],core:[0,0,2,3,5,4,3,1,0,0],tip:[4,0]},
 {outer:[1,3,7,10,9,11,7,4,2,1],mid:[0,2,5,7,6,8,5,2,1,0],core:[0,0,2,4,4,5,3,1,0,0],tip:[5,1]},
 {outer:[2,5,6,8,10,9,9,6,3,1],mid:[0,3,4,6,7,7,6,3,0,0],core:[0,1,2,4,5,4,2,1,0,0],tip:[3,1]}
];
const columns=heights=>heights.map((h,i)=>({x:2+i,h})).filter(c=>c.h>0);
const rect=(cls,x,y,width,height)=>`<rect class="${cls}" x="${x}" y="${y}" width="${width}" height="${height}"/>`;

// Shy pose parts (admin only): a small mouth, rosy cheeks and two mittens that travel from the side arms to the eyes.
// Each mitten is a light 5x4 paw with three toe tips on top and a shadow beneath so it reads as sitting in front of
// the face; a short forearm leads back to the shoulder. The right side mirrors the left across the body.
function shyHands(){
 const paw=(side,flip)=>{
  const r=(cls,x,y,w,h)=>rect(cls,flip?22-x-w:x,y,w,h);
  return `<g class="mascot-paw paw-${side}">`+
   `<g class="paw-arm">${r('m-skin',1,7,2,2)}${r('paw-arm-skin',3,8,2,1)}${r('paw-arm-skin',5,7,1,1)}${r('paw-shade',3,9,2,1)}${r('paw-shade',5,8,1,1)}</g>`+
   `<g class="paw-mitt">${r('paw-shade',6,8,4,1)}${r('paw-light',5,4,1,1)}${r('paw-light',7,4,1,1)}${r('paw-light',9,4,1,1)}${r('paw-skin',5,5,5,2)}${r('paw-skin',6,7,4,1)}</g>`+
  `</g>`;
 };
 return `<g class="mascot-hands">`+
  `<g class="shy-cheeks">${rect('',4,10,2,1)}${rect('',16,10,2,1)}</g>`+
  `<g class="shy-mouth">${rect('m-eye',9,9,1,1)}${rect('m-eye',10,10,2,1)}${rect('m-eye',12,9,1,1)}</g>`+
  paw('l',false)+paw('r',true)+`</g>`;
}

// Inner markup of .mascot-walker: the button, speech bubble, thought bubble and sleep letters.
// The mascot is drawn on a 22x16 grid and always faces the reader.
// `hands` adds the shy pose parts used by the admin when a password field has focus (the public site omits them).
export function mascotMarkup({size=3,label='像素吉祥物，点击互动',hands=false}={}){
 return `<button type="button" class="mascot" aria-label="${escape(label)}"><svg width="${22*size}" height="${16*size}" viewBox="0 0 22 16" shape-rendering="crispEdges" aria-hidden="true">`+
  `<rect class="mascot-shadow" x="4" y="15" width="14" height="1"/>`+
  `<g class="mascot-legs-a"><rect class="m-skin" x="4" y="11" width="2" height="3"/><rect class="m-skin" x="12" y="11" width="2" height="3"/></g>`+
  `<g class="mascot-legs-b"><rect class="m-skin" x="8" y="11" width="2" height="3"/><rect class="m-skin" x="16" y="11" width="2" height="3"/></g>`+
  `<g class="mascot-body">`+
   `<g class="mascot-arm mascot-arm-l"><rect class="m-skin" x="1" y="5" width="2" height="3"/></g>`+
   `<g class="mascot-arm mascot-arm-r"><rect class="m-skin" x="19" y="5" width="2" height="3"/>`+
    `<g class="mascot-flag"><rect class="m-pole" x="20" y="0" width="1" height="5"/><g class="flag-a"><rect class="m-cloth" x="21" y="0" width="3" height="1"/><rect class="m-cloth" x="21" y="1" width="2" height="1"/></g><g class="flag-b"><rect class="m-cloth" x="21" y="0" width="2" height="1"/><rect class="m-cloth" x="21" y="1" width="3" height="1"/></g></g>`+
   `</g>`+
   `<rect class="m-skin m-shell" x="3" y="2" width="16" height="10"/>`+
   `<rect class="m-light" x="3" y="2" width="16" height="1"/>`+
   `<g class="mascot-blush"><rect x="4" y="9" width="2" height="1"/><rect x="16" y="9" width="2" height="1"/></g>`+
   `<g class="mascot-look">`+
    `<g class="mascot-eyes eyes-open"><rect class="m-eye" x="7" y="5" width="2" height="3"/><rect class="m-eye" x="13" y="5" width="2" height="3"/></g>`+
    `<g class="mascot-eyes eyes-closed"><rect class="m-eye" x="6" y="7" width="3" height="1"/><rect class="m-eye" x="13" y="7" width="3" height="1"/></g>`+
    `<g class="mascot-eyes eyes-happy"><rect class="m-eye" x="6" y="7" width="1" height="1"/><rect class="m-eye" x="7" y="6" width="2" height="1"/><rect class="m-eye" x="9" y="7" width="1" height="1"/><rect class="m-eye" x="12" y="7" width="1" height="1"/><rect class="m-eye" x="13" y="6" width="2" height="1"/><rect class="m-eye" x="15" y="7" width="1" height="1"/></g>`+
   `</g>`+
   (hands?shyHands():'')+
  `</g></svg></button>`+
  `<span class="mascot-bubble" role="status" aria-live="polite"></span>`+
  `<span class="mascot-thought" aria-hidden="true"><i></i><i></i><i></i><b><svg width="18" height="18" viewBox="0 0 6 6" shape-rendering="crispEdges">`+
   `<g class="idea idea-bulb"><rect x="1" y="0" width="4" height="1"/><rect x="0" y="1" width="6" height="2"/><rect x="1" y="3" width="4" height="1"/><rect class="idea-base" x="2" y="4" width="2" height="1"/><rect class="idea-base dark" x="2" y="5" width="2" height="1"/></g>`+
   `<g class="idea idea-star"><rect x="2" y="0" width="2" height="2"/><rect x="0" y="2" width="6" height="1"/><rect x="1" y="3" width="4" height="1"/><rect x="1" y="4" width="1" height="1"/><rect x="4" y="4" width="1" height="1"/></g>`+
   `<g class="idea idea-code"><rect x="1" y="1" width="1" height="1"/><rect x="0" y="2" width="1" height="1"/><rect x="1" y="3" width="1" height="1"/><rect x="3" y="0" width="1" height="2"/><rect x="2" y="2" width="1" height="2"/><rect x="4" y="1" width="1" height="1"/><rect x="5" y="2" width="1" height="1"/><rect x="4" y="3" width="1" height="1"/></g>`+
   `<g class="idea idea-moon"><rect x="2" y="0" width="3" height="1"/><rect x="1" y="1" width="2" height="1"/><rect x="1" y="2" width="2" height="1"/><rect x="1" y="3" width="2" height="1"/><rect x="2" y="4" width="3" height="1"/></g>`+
  `</svg></b></span>`+
  `<span class="mascot-zzz" aria-hidden="true"><i>z</i><i>z</i><i>Z</i></span>`;
}

// Inner markup of the campfire container: glow, three flame frames, logs, embers and rising sparks.
export function campfireMarkup(){
 const flames=frames.map((f,n)=>`<g class="flame-frame flame-${n+1}">`+
  columns(f.outer).map(c=>rect('flame-outer',c.x,13-c.h,1,c.h)).join('')+
  columns(f.mid).map(c=>rect('flame-mid',c.x,13-c.h,1,c.h)).join('')+
  columns(f.core).map(c=>rect('flame-core',c.x,13-c.h,1,c.h)).join('')+
  rect('flame-outer',2+f.tip[0],13-f.outer[f.tip[0]]-2-f.tip[1],1,1)+`</g>`).join('');
 return `<span class="fire-glow"></span><svg class="kiln-fire" width="42" height="48" viewBox="0 0 14 16" shape-rendering="crispEdges">`+
  `<g class="fire-flames">${flames}</g>`+
  rect('fire-log',1,13,12,2)+rect('fire-log-dark',0,14,5,1)+rect('fire-log-dark',9,14,5,1)+
  rect('fire-ember e1',4,13,1,1)+rect('fire-ember e2',9,14,1,1)+rect('fire-ember e3',6,14,1,1)+
  rect('fire-stone',0,15,2,1)+rect('fire-stone',12,15,2,1)+`</svg>`+
  ['s1','s2','s3','s4','s5','s6'].map(n=>`<span class="spark ${n}"></span>`).join('');
}
