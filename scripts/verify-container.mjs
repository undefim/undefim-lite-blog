import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

assert.equal(process.env.CONTAINER_SMOKE_TEST,'true','仅允许在隔离 CI 容器内运行');
const revision=process.env.EXPECTED_REVISION;
assert.match(revision||'',/^[a-f0-9]{40,64}$/);
assert.equal(process.env.APP_REVISION,revision);
const root='http://127.0.0.1:4322';
let ready=false;
for(let attempt=0;attempt<180;attempt++){
 try{const response=await fetch(root+'/api/health',{signal:AbortSignal.timeout(2000)});const health=await response.json();if(health.ok&&health.revision===revision&&health.publishing===0&&health.writes===0){ready=true;break}}catch{}
 await new Promise(resolve=>setTimeout(resolve,2000));
}
assert.ok(ready,'容器未在等待时间内完成静态初始化和 API 启动');
const dataDir=process.env.DATA_DIR;
assert.equal(await fs.readFile(path.join(dataDir,'application-revision'),'utf8'),revision);
const current=await fs.readlink(path.join(dataDir,'current'));
const previousFile=path.join(dataDir,'.container-smoke-release');
try{assert.equal(await fs.readFile(previousFile,'utf8'),current,'同版本重启不应重新发布静态站点')}catch(e){if(e.code!=='ENOENT')throw e;await fs.writeFile(previousFile,current,{mode:0o600})}
const page=await fetch(root+'/');assert.equal(page.status,200);assert.match(await page.text(),/data-skin="kiln"/);
const admin=await fetch(root+'/admin/');assert.equal(admin.status,200);assert.equal(admin.headers.get('cache-control'),'no-store');
assert.equal((await fetch(root+'/api/system/update')).status,401);
assert.equal((await fetch(root+'/data/blog.sqlite')).status,404);
console.log('隔离容器验收通过：运行提交、静态标记、前后台、鉴权及同版本重启。');
