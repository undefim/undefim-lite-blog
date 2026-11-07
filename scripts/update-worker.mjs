import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {defaultUpdateConfig,readUpdateFile,writeUpdateFile,publishUpdateRequest,validateUpdateConfig} from '../server/system-update.mjs';
import {defaultUpdateSource,matchesUpdateRemote} from '../server/update-source.mjs';

const exec=promisify(execFile);
const timestamp=()=>new Date().toISOString();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const requireValue=(condition,message)=>{if(!condition)throw new Error(message)};
export async function command(program,args,{cwd,timeout=120000}={}){
 try{const result=await exec(program,args,{cwd,timeout,maxBuffer:1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1'}});return result.stdout.trim()}
 catch{throw new Error(`${program==='git'?'Git':'Docker'} 操作失败或超时，请在宿主机检查仓库、网络与服务状态`)}
}
export function workerOptions(env=process.env){
 const repository=env.UPDATE_REPOSITORY||defaultUpdateSource.repository,branch=env.UPDATE_BRANCH||defaultUpdateSource.branch,project=env.UPDATE_PROJECT;
 requireValue(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)&&!repository.includes('..'),'UPDATE_REPOSITORY 必须是 GitHub owner/repo');
 requireValue(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch)&&!branch.includes('..')&&!branch.includes('//')&&!branch.endsWith('/')&&!branch.endsWith('.lock'),'UPDATE_BRANCH 无效');
 requireValue(project&&/^[a-z0-9][a-z0-9_-]*$/.test(project),'必须设置现有 Compose 项目的 UPDATE_PROJECT');
 const repoDir=path.resolve(env.UPDATE_REPO_DIR||process.cwd()),dataDir=path.resolve(env.UPDATE_DATA_DIR||path.join(repoDir,'data'));
 const healthUrl=env.UPDATE_HEALTH_URL||'http://127.0.0.1:4322/api/health';
 const url=new URL(healthUrl);
 const container=env.UPDATE_RUNTIME==='compose';
 requireValue(url.protocol==='http:'&&['127.0.0.1','[::1]','localhost',...(container?['blog']:[])].includes(url.hostname)&&!url.username&&!url.password&&url.pathname==='/api/health','健康检查必须使用本机或 Compose 内 blog 的 /api/health');
 // replica: the lightweight replica stack (compose.replica.yaml). It has no database, backups or static build marker.
 const mode=(env.UPDATE_MODE||'primary')==='replica'?'replica':'primary';
 requireValue(['primary','replica'].includes(env.UPDATE_MODE||'primary'),'UPDATE_MODE 只能是 primary 或 replica');
 return {repoDir,dataDir,repository,branch,project,healthUrl,mode,composeFile:mode==='replica'?'compose.replica.yaml':'compose.yaml'};
}
export async function readHealth(url){try{const response=await fetch(url,{signal:AbortSignal.timeout(3000),redirect:'error'});return response.ok?await response.json():null}catch{return null}}
export async function waitForHealth(health,predicate,{attempts=180,delay=3000}={}){
 for(let i=0;i<attempts;i++){const value=await health();if(value?.ok&&predicate(value))return value;await sleep(delay)}
 throw new Error('服务或静态发布未在等待时间内就绪');
}
function composeContract(config,dataDir){
 const service=config.services?.blog;
 requireValue(service&&Object.keys(config.services).every(name=>['blog','updater'].includes(name)), '自动更新仅支持 blog 与独立 updater，禁止额外写实例');
 requireValue(!service.volumes?.some(v=>v.target==='/var/run/docker.sock'),'博客容器不能挂载 Docker socket');
 requireValue(service.image&&/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*$/.test(service.image),'Compose 必须配置固定 blog 镜像名');
 const mount=service.volumes?.find(v=>v.target==='/app/data');
 requireValue(mount?.type==='bind'&&path.resolve(mount.source)===dataDir&&!mount.read_only,'UPDATE_DATA_DIR 必须匹配 blog 的 /app/data 绑定目录');
 return {image:service.image,volumes:service.volumes,ports:service.ports,user:service.user,updater:config.services.updater};
}
export async function executeUpdate(options,{run=command,health=()=>readHealth(options.healthUrl),report=async()=>{},wait=waitForHealth}={}){
 const {repoDir,dataDir,branch,repository,project,targetRevision}=options;const replica=options.mode==='replica',composeFile=options.composeFile||'compose.yaml';
 const git=(...args)=>run('git',['-c','core.hooksPath=/dev/null','-c','protocol.file.allow=never','-c','protocol.ext.allow=never',...args],{cwd:repoDir});
 const envFile=path.join(repoDir,'.env');
 const envArgs=await fs.access(envFile).then(()=>['--env-file',envFile]).catch(e=>{if(e.code==='ENOENT')return [];throw e});
 const compose=(file,...args)=>run('docker',['compose','--project-name',project,...envArgs,'--project-directory',repoDir,'-f',file,...args],{cwd:repoDir,timeout:20*60*1000});
 const liveCompose=path.join(repoDir,composeFile);
 let from,to,oldImage,contract,worktree,buildOverride,codeChanged=false,serviceTouched=false,oldCurrent,oldMarker;
 const progress=async(message,extra={})=>report({message,...extra});
 const clean=async()=>requireValue(!(await git('status','--porcelain','--untracked-files=all')),'部署工作区有本地修改或未跟踪文件，已拒绝覆盖；请先由维护者处理');
 try{
  await progress('检查部署目录、GitHub 来源和分支。');
  requireValue(await git('rev-parse','--show-toplevel')===repoDir,'UPDATE_REPO_DIR 必须是仓库根目录');
  await clean();
  requireValue(await git('branch','--show-current')===branch,'本地分支与跟踪分支不同，已停止更新');
  const remote=await git('remote','get-url','origin');
  requireValue(matchesUpdateRemote(remote,repository),'origin 与部署端固定的 GitHub 仓库不匹配，仅支持无内嵌凭据的 HTTPS 来源');
  from=await git('rev-parse','HEAD');
  requireValue(/^[0-9a-f]{40,64}$/.test(from),'本地版本无效');
  await progress('正在检查 GitHub 分支。',{from});
  await git('fetch','--no-tags',`https://github.com/${repository}.git`,`+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  to=await git('rev-parse',`refs/remotes/origin/${branch}`);
  requireValue(/^[0-9a-f]{40,64}$/.test(to),'远端版本无效');
  // A pinned target (replica updates requested by the primary) must be a commit already on the tracked branch.
  if(targetRevision){requireValue(/^[0-9a-f]{40,64}$/.test(targetRevision),'目标版本格式无效');try{await git('merge-base','--is-ancestor',targetRevision,`refs/remotes/origin/${branch}`)}catch{throw new Error('目标版本不在固定仓库的跟踪分支上，已拒绝更新')}to=targetRevision}
  await progress('已获取远端版本。',{to});
  const currentHealth=await health();
  const marker=replica?to:await fs.readFile(path.join(dataDir,'application-revision'),'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e});
  if(from===to&&currentHealth?.ok&&currentHealth.revision===from&&marker===from)return {status:'unchanged',from,to,message:'当前运行程序与静态版本均为跟踪分支的最新版本。'};
  try{await git('merge-base','--is-ancestor',from,to)}catch{throw new Error('本地与远端分支发生分叉或远端回退，禁止自动覆盖')}
  // Runtime tooling cannot safely replace the container that is supervising this job.
  requireValue(!(await git('diff','--name-only',from,to,'--','Dockerfile.updater','scripts/updater-entrypoint.sh')),'执行器基础运行环境发生变化，请维护者运行 docker compose up -d --build 更新全部服务');
  contract=composeContract(JSON.parse(await compose(liveCompose,'config','--format','json')),dataDir);
  const container=await compose(liveCompose,'ps','-q','blog');
  requireValue(/^[0-9a-f]{12,64}$/.test(container),'未找到唯一的运行中 blog 容器，请核对 UPDATE_PROJECT');
  const staging=await fs.mkdtemp(path.join(os.tmpdir(),'blog-update-'));
  worktree=path.join(staging,'source');buildOverride=path.join(staging,'build.json');
  await git('worktree','add','--detach',worktree,to);
  const candidateConfig=JSON.parse(await compose(path.join(worktree,composeFile),'config','--format','json'));
  const candidateContract=composeContract(candidateConfig,dataDir);
  requireValue(JSON.stringify(candidateContract)===JSON.stringify(contract),'此次提交改变镜像名、数据挂载、端口或运行用户，必须由维护者手动部署');
  const candidateImage=`undefim-blog-update:${replica?'replica':'primary'}-${project}-${randomUUID()}`;
  await writeUpdateFile(buildOverride,{services:{blog:{image:candidateImage,build:{context:worktree,args:{APP_REVISION:to}}}}});
  await progress('正在隔离工作树构建新镜像，当前服务仍可访问。');
  await run('docker',['compose','--project-name',project,...envArgs,'--project-directory',repoDir,'-f',path.join(worktree,composeFile),'-f',buildOverride,'build','blog'],{cwd:repoDir,timeout:20*60*1000});
  await clean();requireValue(await git('rev-parse','HEAD')===from,'构建期间本地版本已变化，已停止更新');
  await progress('暂停写操作，等待已有发布完成。',{maintenance:true});
  await wait(health,value=>value.publishing===0&&value.writes===0,{attempts:120,delay:3000});
  oldImage=await run('docker',['inspect','--format','{{.Image}}',container],{cwd:repoDir});
  requireValue(/^sha256:[0-9a-f]{64}$/.test(oldImage),'无法保留旧镜像，已停止更新');
  let backup;
  if(!replica){
  oldCurrent=await fs.readlink(path.join(dataDir,'current'));
  try{oldMarker=await fs.readFile(path.join(dataDir,'application-revision'),'utf8')}catch(e){if(e.code!=='ENOENT')throw e}
  await progress('正在创建更新前的完整备份。');
  const backupOutput=await compose(liveCompose,'exec','-T','blog','node','scripts/backup.mjs');
  backup=path.basename(backupOutput.split('\n').at(-1)||'');
  requireValue(/^\d{4}-\d{2}-\d{2}-[a-f0-9-]+\.zip$/.test(backup),'备份未返回有效文件名，已停止更新');
  await fs.access(path.join(dataDir,'backups',backup));
  await progress('备份完成，准备切换代码和镜像。',{backup});
  }else await progress('子站没有数据库，内容可随时从主站重新同步，跳过备份。');
  await clean();requireValue(await git('rev-parse','HEAD')===from,'切换前本地版本已变化，已停止更新');
  await git('merge','--ff-only',to);codeChanged=true;
  serviceTouched=true;
  await run('docker',['image','tag',candidateImage,contract.image],{cwd:repoDir});
  await compose(liveCompose,'stop','blog');
  await progress('正在启动新版本并重新生成已发布快照，请稍候。');
  await compose(liveCompose,'up','-d','--no-build','--force-recreate','--no-deps','blog');
  await wait(health,value=>value.revision===to&&value.publishing===0);
  if(replica)return {status:'success',from,to,message:'子站程序已更新，页面内容继续由主站同步。'};
  requireValue(await fs.readFile(path.join(dataDir,'application-revision'),'utf8')===to,'静态版本标记未完成');
  return {status:'success',from,to,backup,message:'程序与已发布快照已更新，草稿、私密内容及历史版本保持不变。'};
 }catch(error){
  let rollback;
  if(codeChanged||serviceTouched){
   await progress('更新异常，正在尝试恢复旧代码、镜像和静态入口。');
   try{
    if(serviceTouched)await compose(liveCompose,'stop','blog');
    await clean();requireValue(await git('rev-parse','HEAD')===to,'本地版本被其他操作修改，拒绝自动回退覆盖');
    await git('reset','--hard',from);
    await run('docker',['image','tag',oldImage,contract.image],{cwd:repoDir});
    if(!replica){
    const link=path.join(dataDir,`current-update-${randomUUID()}`);
    await fs.symlink(oldCurrent,link);await fs.rename(link,path.join(dataDir,'current'));
    }
    if(!replica){if(oldMarker===undefined)await fs.rm(path.join(dataDir,'application-revision'),{force:true});else await fs.writeFile(path.join(dataDir,'application-revision'),oldMarker,{mode:0o600});}
    await compose(liveCompose,'up','-d','--no-build','--force-recreate','--no-deps','blog');
    await wait(health,value=>replica?value.revision===from:!oldMarker||value.revision===oldMarker);
    rollback='已恢复旧代码、镜像与静态入口；保留当前数据库，未恢复旧备份。';
   }catch{rollback='自动回退未完成，请立即在宿主机恢复服务；数据与更新前备份均未删除。'}
  }
  return {status:'failed',from,to,message:error.message,rollback,maintenance:Boolean(rollback&&!rollback.startsWith('已恢复'))};
 }finally{
  if(worktree){try{await git('worktree','remove','--force',worktree);await fs.rm(path.dirname(worktree),{recursive:true,force:true})}catch{}}
 }
}
export const checkIntervalMs=10*60*1000;
const subjectText=value=>String(value).replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,100);
class CheckBlocked extends Error{constructor(reason,message){super(message);this.reason=reason}}
// Read-only comparison: fetches the tracked branch ref and never touches the working tree, images or data.
export async function checkForUpdate(options,{run=command,health=()=>readHealth(options.healthUrl),now=()=>new Date().toISOString()}={}){
 const {repoDir,dataDir,branch,repository}=options;
 const git=(...args)=>run('git',['-c','core.hooksPath=/dev/null','-c','protocol.file.allow=never','-c','protocol.ext.allow=never',...args],{cwd:repoDir,timeout:30000});
 const checkedAt=now();
 let from=null,to=null;
 try{
  requireValue(await git('rev-parse','--show-toplevel')===repoDir,'更新目录不是仓库根目录');
  from=await git('rev-parse','HEAD');
  requireValue(/^[0-9a-f]{40,64}$/.test(from),'本地版本无效');
  if(await git('branch','--show-current')!==branch)throw new CheckBlocked('branch','本地分支与跟踪分支不同，已停止自动更新。');
  if(!matchesUpdateRemote(await git('remote','get-url','origin'),repository))throw new CheckBlocked('remote','origin 与部署端固定的仓库不匹配。');
  if(await git('status','--porcelain','--untracked-files=all'))throw new CheckBlocked('dirty','部署目录有本地修改或未跟踪文件，已拒绝自动覆盖，请维护者先处理。');
  try{await git('fetch','--no-tags',`https://github.com/${repository}.git`,`+refs/heads/${branch}:refs/remotes/origin/${branch}`)}
  catch{return {state:'error',checkedAt,from,message:'暂时无法连接 GitHub，稍后会自动重试。'}}
  to=await git('rev-parse',`refs/remotes/origin/${branch}`);
  requireValue(/^[0-9a-f]{40,64}$/.test(to),'远端版本无效');
  if(from===to){
   const running=await health();
   const marker=options.mode==='replica'?from:await fs.readFile(path.join(dataDir,'application-revision'),'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e});
   if(!running?.ok)return {state:'error',checkedAt,from,to,message:'博客服务暂时无响应，无法确认当前运行版本。'};
   if(running.revision===from&&marker===from)return {state:'latest',checkedAt,from,to,message:'当前已是最新版。'};
   return {state:'available',reason:'redeploy',checkedAt,from,to,ahead:0,commits:[],message:'代码已是最新，但运行中的程序或静态版本落后，可重新部署修复。'};
  }
  try{await git('merge-base','--is-ancestor',from,to)}
  catch{
   try{await git('merge-base','--is-ancestor',to,from)}catch{throw new CheckBlocked('diverged','本地与远端分支已分叉，已停止自动更新。')}
   throw new CheckBlocked('ahead','本地代码领先远端分支，已停止自动更新以免覆盖。');
  }
  if(await git('diff','--name-only',from,to,'--','Dockerfile.updater','scripts/updater-entrypoint.sh'))throw new CheckBlocked('manual-deploy','新版本修改了更新执行器运行环境，请维护者手动运行 docker compose up -d --build。');
  const ahead=Number(await git('rev-list','--count',`${from}..${to}`));
  const log=await git('log','--format=%h%x09%s','-n','5',`${from}..${to}`);
  const commits=log?log.split('\n').map(line=>{const [sha,...subject]=line.split('\t');return {sha:subjectText(sha).slice(0,12),subject:subjectText(subject.join(' '))}}):[];
  return {state:'available',reason:'new-commits',checkedAt,from,to,ahead:Number.isSafeInteger(ahead)?ahead:commits.length,commits,message:'GitHub 上有新版本。'};
 }catch(error){
  if(error instanceof CheckBlocked)return {state:'blocked',reason:error.reason,checkedAt,from,to,message:error.message};
  return {state:'error',checkedAt,from,to,message:'无法完成版本检查，请在宿主机检查仓库与服务状态。'};
 }
}
export async function workerCheckTick(options,state,{check=checkForUpdate,now=Date.now()}={}){
 const directory=path.join(options.dataDir,'system-update');
 const requested=await readUpdateFile(path.join(directory,'check-request.json'));
 if(!requested&&state.check&&state.nextCheckAt&&Date.parse(state.nextCheckAt)>now)return false;
 state.check=await check(options);
 state.nextCheckAt=new Date(now+checkIntervalMs).toISOString();
 if(requested)await fs.rm(path.join(directory,'check-request.json'),{force:true});
 return true;
}
export function nextUpdateAt(config,state,now=Date.now()){
 if(config.mode!=='auto'||state.paused)return null;
 return new Date(Date.parse(state.lastCheckedAt||state.scheduleAnchorAt||state.startedAt||new Date(now).toISOString())+config.intervalHours*3600000).toISOString();
}
export async function workerTick(options,state,{execute=executeUpdate,now=Date.now(),persist}={}){
 const directory=path.join(options.dataDir,'system-update');
 const config=validateUpdateConfig(await readUpdateFile(path.join(directory,'config.json'),defaultUpdateConfig));
 state.nextRunAt=nextUpdateAt(config,state,now);
 let request=await readUpdateFile(path.join(directory,'request.json'));
 if(options.mode!=='replica'&&!request&&state.nextRunAt&&Date.parse(state.nextRunAt)<=now){
  const automatic={id:randomUUID(),trigger:'auto',requestedAt:new Date(now).toISOString()};
  try{await publishUpdateRequest(directory,automatic);request=automatic}catch(e){if(e.statusCode!==409)throw e;request=await readUpdateFile(path.join(directory,'request.json'))}
 }
 if(!request)return;
 requireValue(/^[a-f0-9-]{36}$/.test(request.id)&&['manual','auto'].includes(request.trigger)&&(request.revision===undefined||/^[a-f0-9]{40,64}$/.test(request.revision)),'更新请求格式无效，请由维护者检查队列');
 const inheritedMaintenance=state.job?.maintenance===true;
 state.job={id:request.id,trigger:request.trigger,startedAt:new Date(now).toISOString(),status:'running',message:'准备检查更新。',maintenance:inheritedMaintenance};
 const save=persist||(()=>writeUpdateFile(path.join(directory,'status.json'),{...state,heartbeatAt:timestamp()}));
 await save();
 try{
  const result=await execute(request.revision?{...options,targetRevision:request.revision}:options,{report:async change=>{Object.assign(state.job,change);await save()}});
  Object.assign(state.job,result,{finishedAt:timestamp(),maintenance:result.status==='failed'&&(inheritedMaintenance||result.maintenance===true)});
  state.lastCheckedAt=timestamp();state.paused=result.status==='failed';
  if(result.status==='success'||result.status==='unchanged')state.revision=result.to;
  else if(result.rollback?.startsWith('已恢复'))state.revision=result.from;
  state.nextRunAt=nextUpdateAt(config,state);
  state.check=null;state.nextCheckAt=null;
  await save();
 }finally{await fs.rm(path.join(directory,'request.json'),{force:true})}
 return state.job.status;
}
// flock is owned by the kernel and works across PID namespaces. The helper's
// stdin closes even if its parent is killed, releasing the lock after a crash.
export async function acquireWorkerLock(repoDir){
 const child=spawn('flock',['--exclusive','--nonblock',path.join(repoDir,'.git','blog-update-worker.lock'),process.execPath,'--input-type=module','-e',`process.stdout.write('locked');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`],{stdio:['pipe','pipe','pipe']});
 let releasing=false,acquired=false;
 const closed=new Promise(resolve=>child.once('close',code=>{resolve(code);if(acquired&&!releasing)process.exit(1)}));
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill();reject(new Error('执行器锁获取超时'))},5000);
  const fail=()=>{clearTimeout(timer);reject(new Error('已有执行器持锁，或系统缺少 flock'))};
  child.once('error',fail);child.once('exit',fail);
  child.stdout.once('data',()=>{acquired=true;clearTimeout(timer);child.removeListener('exit',fail);resolve()});
 });
 return async()=>{releasing=true;child.stdin.end();await closed};
}
export async function runWorker(options){
 const directory=path.join(options.dataDir,'system-update');
 await fs.mkdir(directory,{recursive:true,mode:0o700});
 const releaseLock=await acquireWorkerLock(options.repoDir);
 try{
 const previous=await readUpdateFile(path.join(directory,'status.json'),{});
 const state={...previous,check:null,nextCheckAt:null,repository:options.repository,branch:options.branch,scheduleAnchorAt:previous.scheduleAnchorAt||previous.startedAt||timestamp(),startedAt:timestamp(),heartbeatAt:timestamp()};
 if(state.job?.status==='running'){
  state.job={...state.job,status:'failed',finishedAt:timestamp(),message:'执行器重启中断了任务，请先检查宿主机代码、镜像和静态版本；不会自动重放。'};
  state.paused=true;
  const pending=await readUpdateFile(path.join(directory,'request.json'));
  if(pending?.id===state.job.id)await fs.rm(path.join(directory,'request.json'),{force:true});
 }
 const pending=await readUpdateFile(path.join(directory,'request.json'));
 if(pending?.id===state.job?.id&&state.job?.status!=='running')await fs.rm(path.join(directory,'request.json'),{force:true});
 let writes=Promise.resolve();
 const beat=()=>{const snapshot=JSON.parse(JSON.stringify({...state,heartbeatAt:timestamp()}));writes=writes.then(()=>writeUpdateFile(path.join(directory,'status.json'),snapshot));return writes};
 let stopping=false;
 const stop=()=>{stopping=true};process.on('SIGTERM',stop);process.on('SIGINT',stop);
 const timer=setInterval(()=>beat().catch(()=>{stopping=true}),10000);
 try{
  state.revision=await command('git',['rev-parse','HEAD'],{cwd:options.repoDir});
  await beat();
  while(!stopping){const outcome=await workerTick(options,state,{persist:beat});if(outcome==='success'){await beat();break}await workerCheckTick(options,state);await beat();await sleep(5000)}
 }finally{
  clearInterval(timer);process.off('SIGTERM',stop);process.off('SIGINT',stop);
  await writes.catch(()=>{});
  await writeUpdateFile(path.join(directory,'status.json'),{...state,heartbeatAt:null});
 }
 }finally{await releaseLock()}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await runWorker(workerOptions())}catch{console.error('更新执行器启动或运行失败。请检查专用部署目录、环境配置、文件权限及执行器锁；未输出原始命令日志。');process.exitCode=1}
}
