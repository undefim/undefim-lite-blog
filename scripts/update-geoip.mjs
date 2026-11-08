// Download or refresh the offline IP -> country database used by visitor analytics (DB-IP Lite, CC BY 4.0).
// Usage: DATA_DIR=./data node scripts/update-geoip.mjs   (the running server picks up the new file within a day,
// or on the next visit to the admin analytics page).
import path from 'node:path';import {createGeoip} from '../server/geoip.mjs';
const dataDir=path.resolve(process.env.DATA_DIR||'./data');
const file=process.env.GEOIP_DB||path.join(dataDir,'geoip','country.mmdb');
const geoip=createGeoip({file,log:m=>console.log(m)});
try{await geoip.download();console.log(JSON.stringify(geoip.status()))}catch(e){console.error(`IP 库更新失败：${e.message}`);process.exit(1)}
