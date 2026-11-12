import fs from 'node:fs';
import path from 'node:path';

const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};

// Only public upload images may be embedded in the static icon.
export function faviconSvg(logo,roots){
 let rel;
 try{rel=decodeURIComponent(String(logo||'').split(/[?#]/)[0])}catch{return null}
 if(!rel.startsWith('/upload/'))return null;
 for(const root of roots){
  try{
   const base=fs.realpathSync(root),file=fs.realpathSync(path.resolve(base,rel.slice(1)));
   if(!file.startsWith(path.join(base,'upload')+path.sep))continue;
   const type=mime[path.extname(file).toLowerCase()];
   if(!type)continue;
   const href=`data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
   return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><clipPath id="c"><circle cx="32" cy="32" r="32"/></clipPath></defs><image href="${href}" width="64" height="64" preserveAspectRatio="xMidYMid slice" clip-path="url(#c)"/></svg>`;
  }catch{}
 }
 return null;
}
