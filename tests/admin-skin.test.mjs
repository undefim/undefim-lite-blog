import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {generate,warmColour,sourcePath,outputPath} from '../scripts/generate-admin-kiln.mjs';
import {mascotMarkup,campfireMarkup} from '../src/lib/kiln-art.mjs';
import {createSkinController} from '../admin/src/skin.ts';

test('主题预览不保存，离开还原；相同设置再次保存后仍固定正确主题',()=>{
 let visible='dream',stored='dream';
 const skin=createSkinController({read:()=>visible,write:id=>{visible=id},remember:id=>{stored=id}});
 skin.preview('kiln');assert.equal(visible,'kiln');assert.equal(stored,'dream');
 skin.restore();assert.equal(visible,'dream');
 skin.apply('kiln');assert.equal(stored,'kiln');
 skin.preview('dream');skin.restore();assert.equal(visible,'kiln');
 skin.preview('dream');skin.preview('kiln');skin.apply('kiln');skin.restore();
 assert.equal(visible,'kiln');assert.equal(stored,'kiln');
 skin.preview('dream');assert.equal(visible,'dream');
 skin.apply('unknown');assert.equal(visible,'kiln');assert.equal(stored,'kiln');
});

test('本地存储不可用时，登录同步与未保存还原仍正常',()=>{
 let visible='kiln';
 const skin=createSkinController({read:()=>visible,write:id=>{visible=id},remember:()=>{throw new Error('Storage disabled')}});
 skin.preview('dream');skin.restore();assert.equal(visible,'kiln');
 skin.apply('dream');skin.preview('kiln');skin.restore();assert.equal(visible,'dream');
});

test('后台窑火颜色文件与原样式生成结果一致，新增样式后必须重新生成',async()=>{
 const original=await fs.readFile(sourcePath,'utf8');
 assert.equal(await fs.readFile(outputPath,'utf8'),generate(original));
});

test('颜色转换保留状态语义和透明度，规则逐个限定在窑火主题',()=>{
 for(const colour of ['#79b5a0','#d99ca9','#cdb282','#0005'])assert.equal(warmColour(colour),colour.length===5?'#00000055':colour);
 assert.notEqual(warmColour('#7da6e0'),'#7da6e0');
 assert.ok(warmColour('#7da6e044').endsWith('44'));
 const out=generate(':root{color:#dce3ef;display:flex} .a,.b:hover{color:#7da6e0;padding:2px} @media(max-width:767px){.x{background:#101723}}');
 assert.ok(out.includes(':root[data-skin=kiln]{color:'));
 assert.ok(out.includes(':root[data-skin=kiln] .a,:root[data-skin=kiln] .b:hover'));
 assert.ok(out.includes('@media(max-width:767px){:root[data-skin=kiln] .x'));
 assert.ok(!out.includes('padding:'));assert.ok(!out.includes('display:'));
});

test('共享像素标记固定输出，不插入未转义的名称，后台手部是可选项',()=>{
 assert.ok(!mascotMarkup().includes('mascot-hands'));
 assert.ok(mascotMarkup({hands:true}).includes('mascot-hands'));
 const art=mascotMarkup({label:'"><script>bad</script>'});
 assert.ok(!art.includes('<script>'));
 assert.ok(art.includes('aria-label="&quot;>&lt;script>bad&lt;/script>"'));
 const fire=campfireMarkup();
 assert.equal((fire.match(/class="flame-frame /g)||[]).length,3);
 assert.equal((fire.match(/class="spark /g)||[]).length,6);
});
