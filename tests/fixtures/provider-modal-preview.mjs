// Read-only static preview server. All account mutations run against synthetic
// in-browser data; no production service, credentials or upstream calls are used.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../static');
const port = Number(process.env.PREVIEW_PORT || 13841);
const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>账号管理 · 模拟验收</title><link rel="stylesheet" href="/app/base.css"><link rel="stylesheet" href="/app/mobile.css"><link rel="stylesheet" href="/components/section-providers.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>body{margin:0;background:var(--bg-secondary);font-family:system-ui,sans-serif}main{padding:24px}#fixture-status{font-size:12px} .provider-modal{background:var(--bg-secondary)}</style></head><body>
<main><h1>账号管理模拟验收</h1><button id="reopen">重新打开</button><p id="fixture-status" role="status">就绪</p></main><div id="toastContainer" class="toast-container"></div>
<script type="module">
import { initI18n } from '/app/i18n.js';
import { showProviderManagerModal } from '/app/modal.js';
const params=new URLSearchParams(location.search); document.documentElement.dataset.theme=params.get('theme')||'light';
const type='openai-codex-oauth';
let accounts=Array.from({length:18},(_,index)=>({uuid:'fixture-'+(index+1),customName:['alex@example.test','river@example.test','morgan@example.test','quinn@example.test','taylor@example.test','sage@example.test'][index%6],isHealthy:index<2,isDisabled:index>=4,isArchived:index>=6,archivedAt:index>=6?'2026-10-14T12:00:00Z':null,lastSuccessTime:'2026-10-14T13:15:00Z',lastHealthCheckTime:'2026-10-15T00:15:00Z',lastHealthCheckModel:'gpt-6-luna',checkModelName:'gpt-6-luna',checkHealth:false,PROXY_ID:'preview-proxy',CODEX_OAUTH_CREDS_FILE_PATH:'configs/preview/account-'+index+'.json',lastErrorMessage:index===2?'授权已过期，请更新授权':''}));
const log=(text)=>{document.querySelector('#fixture-status').textContent=text};
const data=()=>({providerType:type,providers:accounts.map(a=>({...a,uiAvailable:!a.isArchived&&!a.isDisabled&&a.isHealthy})),totalCount:accounts.filter(a=>!a.isArchived).length,healthyCount:accounts.filter(a=>!a.isArchived&&!a.isDisabled&&a.isHealthy).length,runtimeSync:'applied'});
window.confirm=()=>true;
window.apiClient={
 async get(url){
  if(url==='/proxy-pools')return {proxies:[{id:'preview-proxy',name:'住宅出口 A',enabled:true}]};
  if(url.startsWith('/provider-models/'))return {models:['gpt-6-luna','gpt-6-sol']};
  if(url.startsWith('/providers/'))return data();
  return {};
 },
 async post(url){
  log('POST '+url);
  const parts=url.split('/');const a=accounts.find(a=>a.uuid===parts[3]);const action=parts[4];
  if(a){
   if(action==='archive'&&params.get('case')==='bound')throw new Error('请先解除关联 Key 的凭据绑定，再归档：演示 Key');
   if(action==='archive'){a.isArchived=true;a.isDisabled=true;a.archivedAt=new Date().toISOString()}
   if(action==='restore'){a.isArchived=false;a.isDisabled=true;a.archivedAt=null}
   if(action==='enable')a.isDisabled=false;
   if(action==='disable')a.isDisabled=true;
   if(action==='health-check')a.isHealthy=true;
  }
  return {success:true,saved:true,runtimeSync:'applied',results:[],healthy:true,modelName:'gpt-6-luna',resetCount:0,refreshedCount:0,deletedCount:0,message:'模拟操作完成'};
 },
 async put(url,body){log('PUT '+url);const a=accounts.find(a=>a.uuid===url.split('/')[3]);if(a)Object.assign(a,body.providerConfig);return {success:true}},
 async delete(url){log('DELETE '+url);accounts=accounts.filter(a=>a.uuid!==url.split('/')[3]);return {success:true}}
};
window.loadProviders=async()=>{};
window.showCodexAuthMethodSelector=async(type,context)=>log('授权 '+context.targetProviderUuid);
window.showGeminiAuthMethodSelector=window.showCodexAuthMethodSelector;
window.showAddProviderForm=()=>log('添加账号');
initI18n();
const open=()=>showProviderManagerModal(data()); document.querySelector('#reopen').onclick=open;await open();
</script></body></html>`;
const types={'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2'};
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');
 if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page);return;}
 const requested=path.resolve(root,'.'+decodeURIComponent(url.pathname));
 if(!requested.startsWith(root+path.sep)||!fs.existsSync(requested)||!fs.statSync(requested).isFile()){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',types[path.extname(requested)]||'application/octet-stream');res.setHeader('Cache-Control','no-store');fs.createReadStream(requested).pipe(res);
});
server.listen(port,'127.0.0.1',()=>console.log('Preview: http://127.0.0.1:'+port));
setTimeout(()=>server.close(),30*60*1000).unref();
