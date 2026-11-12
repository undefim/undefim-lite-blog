import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {faviconSvg} from '../src/lib/favicon.mjs';

function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'blog-favicon-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const root=path.join(dir,'media');fs.mkdirSync(path.join(root,'upload'),{recursive:true});
 return {dir,root};
}

test('站点图标内嵌公开位图并支持编码路径、备用 public 目录',t=>{
 const {dir,root}=fixture(t),file=path.join(root,'upload','图 标.png');
 fs.writeFileSync(file,Buffer.from('public-image'));
 const svg=faviconSvg('/upload/%E5%9B%BE%20%E6%A0%87.png?v=1',[path.join(dir,'missing'),root]);
 assert.match(svg,/clip-path="url\(#c\)"/);
 assert.match(svg,/data:image\/png;base64,cHVibGljLWltYWdl/);
 assert.doesNotMatch(svg,/图 标|href="https?:/);
});

test('站点图标拒绝越界、符号链接、无效编码及不支持的图像',t=>{
 const {dir,root}=fixture(t);
 fs.writeFileSync(path.join(dir,'secret.png'),'private');
 fs.writeFileSync(path.join(root,'secret.png'),'private');
 fs.symlinkSync(path.join(dir,'secret.png'),path.join(root,'upload','linked.png'));
 fs.writeFileSync(path.join(root,'upload','script.svg'),'<svg onload="alert(1)"/>');
 for(const logo of ['/upload/../secret.png','/upload/../../secret.png','/upload/%2e%2e/%2e%2e/secret.png','/upload/linked.png','/upload/%','/upload/missing.png','/upload/script.svg','https://example.invalid/logo.png','/assets/logo.png','"/><script>alert(1)</script>']){
  assert.equal(faviconSvg(logo,[root]),null,logo);
 }
});
