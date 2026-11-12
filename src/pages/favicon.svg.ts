import path from 'node:path';
import {dataDir} from '../../server/db.mjs';
import {config} from '../lib/content.mjs';
import {faviconSvg} from '../lib/favicon.mjs';

export function GET(){
 const svg=faviconSvg(config.logo,[path.join(dataDir,'media'),path.resolve('public')])||'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"/>';
 return new Response(svg,{headers:{'Content-Type':'image/svg+xml'}});
}
