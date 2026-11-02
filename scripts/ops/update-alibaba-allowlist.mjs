import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALIBABA_ASNS, MAX_AGE_MS, manifestHash, validateManifest } from '../../src/utils/alibaba-allowlist.js';
import { publicCidr, publicIp } from '../../src/utils/public-ip.js';

const sourceUrl=asn=>`https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS${asn}`;
export function sourceQueryUrl(asn,now=Date.now()){return sourceUrl(asn)+`&starttime=${Math.floor(now/1000)-172800}&endtime=${Math.floor(now/1000)}`;}
const coded=code=>Object.assign(Error(code),{code});
function timestamp(value){if(typeof value!=='string')throw coded('invalid_source');const n=Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value)?value:value+'Z');if(!Number.isFinite(n))throw coded('invalid_source');return n;}
export function compileResponses(responses,explicitIps=[],now=Date.now()) {
    if(!Array.isArray(responses)||responses.length!==ALIBABA_ASNS.length)throw coded('incomplete_sources');
    const sources=ALIBABA_ASNS.map(asn=>{
        const found=responses.filter(r=>r?.status==='ok'&&String(r.data?.resource).replace(/^AS/,'')===String(asn));
        if(found.length!==1)throw coded('invalid_source');
        const d=found[0].data;const end=timestamp(d.query_endtime);
        if(now-end>MAX_AGE_MS||end>now+300000||!Array.isArray(d.prefixes)||d.prefixes.length>50000)throw coded('invalid_source');
        const prefixes=new Set();
        for(const entry of d.prefixes){
            if(!Array.isArray(entry.timelines)||!entry.timelines.length)throw coded('invalid_source');
            const active=entry.timelines.map(t=>{const a=timestamp(t.starttime),b=timestamp(t.endtime);if(a>b)throw coded('invalid_source');return a<=end&&b>=end;}).some(Boolean);
            // Never turn a historical, withdrawn announcement into an exception.
            if(active)prefixes.add(publicCidr(entry.prefix).cidr);
        }
        if(!prefixes.size)throw coded('empty_asn');
        return {asn,source:sourceUrl(asn),queryEndTime:new Date(end).toISOString(),prefixes:[...prefixes].sort()};
    });
    if(!Array.isArray(explicitIps))throw coded('invalid_exceptions');
    const explicit=[...new Set(explicitIps.map(ip=>{const p=publicIp(ip);if(!p)throw coded('invalid_exceptions');return p.ip;}))].sort();
    const data={schemaVersion:1,kind:'alibaba-cloud',asns:[...ALIBABA_ASNS],generatedAt:new Date(now).toISOString(),sources,explicitIps:explicit};
    data.sha256=manifestHash(data);validateManifest(data);return data;
}
function coverage(prefixes,family){
    const ranges=prefixes.map(publicCidr).filter(p=>p.family===family).sort((a,b)=>a.start<b.start?-1:a.start>b.start?1:0);
    let total=0n,last=null;
    for(const p of ranges){if(last&&p.start<=last.end+1n){if(p.end>last.end)last.end=p.end;}else{if(last)total+=last.end-last.start+1n;last={...p};}}
    return total+(last?last.end-last.start+1n:0n);
}
export function compareManifests(old,next){
    const changes=[];let requiresReview=false;
    for(const s of next.sources){
        const prior=old?.sources.find(x=>x.asn===s.asn);const previous=prior?.prefixes||[];
        const change={asn:s.asn,before:previous.length,after:s.prefixes.length,added:s.prefixes.filter(p=>!previous.includes(p)).length,removed:previous.filter(p=>!s.prefixes.includes(p)).length};
        const metrics=[['prefixCount',BigInt(previous.length),BigInt(s.prefixes.length)],...([4,6].map(f=>['ipv'+f,coverage(previous,f),coverage(s.prefixes,f)]))];
        for(const [key,a,b] of metrics){change[key]={before:a.toString(),after:b.toString()};if(prior&&(a===0n?b!==0n:(a>b?a-b:b-a)*100n>a*25n))requiresReview=true;}
        changes.push(change);
    }
    return {requiresReview,changes,explicitIps:next.explicitIps};
}
async function readJson(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw coded('invalid_local_file');}}
async function atomicWrite(file,text){
    const temp=file+'.'+process.pid+'.tmp';let handle;
    try{handle=await fs.open(temp,'wx',0o644);await handle.writeFile(text);await handle.sync();await handle.close();handle=null;await fs.rename(temp,file);}
    finally{await handle?.close();await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
async function fetchJson(url){
    const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000)});if(!r.ok)throw coded('download_failed');
    let size=0;const parts=[];for await(const chunk of r.body){size+=chunk.length;if(size>16*1024*1024)throw coded('download_failed');parts.push(Buffer.from(chunk));}
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
async function download(){
    const now=Date.now();
    const responses=[];
    for(const asn of ALIBABA_ASNS){let result;for(let n=0;n<3;n++){try{result=await fetchJson(sourceQueryUrl(asn,now));break;}catch{if(n===2)throw coded('download_failed');await new Promise(r=>setTimeout(r,1000*(n+1)));}}responses.push(result);}
    return responses;
}
function loopback(url){const u=new URL(url);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password)throw coded('invalid_health_url');return u;}
export async function verifyConvergence(data,runtimeUrl,edgeUrl){
    loopback(runtimeUrl);loopback(edgeUrl);
    for(let attempt=0;attempt<30;attempt++){
        try{
            const get=async u=>{const r=await fetch(u,{signal:AbortSignal.timeout(700)});if(!r.ok)throw coded('health_failed');return r.json();};
            const [runtime,edge]=await Promise.all([get(runtimeUrl),get(edgeUrl)]);
            const workers=Object.values(runtime.mainlandPolicy?.workers||{});
            if(workers.length===runtime.controlWorkers+runtime.executionWorkers&&workers.length>0&&runtime.mainlandPolicy.ready&&
                workers.every(w=>w.alibabaAllowlist?.enabled&&w.alibabaAllowlist.available&&!w.alibabaAllowlist.lastError&&w.alibabaAllowlist.sha256===data.sha256)&&
                edge.mainlandPolicy?.alibabaAllowlist?.sha256===data.sha256&&edge.mainlandPolicy.alibabaAllowlist.available&&!edge.mainlandPolicy.alibabaAllowlist.lastError)return true;
        }catch{}
        await new Promise(r=>setTimeout(r,1000));
    }
    return false;
}
export async function updateAllowlist(options,deps={}){
    const {output,apply=false,restorePrevious=false,acceptLargeChange=false,bootstrap=false}=options;
    if(!output||!path.isAbsolute(output))throw coded('absolute_output_required');
    const lock=output+'.lock';let handle;
    try{handle=await fs.open(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw coded('update_locked');throw e;}
    let old=null,status=null,activated=false;
    const verify=deps.verify||((data)=>verifyConvergence(data,options.runtimeUrl,options.edgeUrl));
    try{
        await handle.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
        old=await readJson(output);if(old)validateManifest(old);
        status=await readJson(output+'.status.json')||{};
        let data;
        if(restorePrevious){data=await readJson(output+'.previous');validateManifest(data);}
        else if(options.candidate){data=await readJson(options.candidate);validateManifest(data);if(data.sources.some(s=>Date.now()-timestamp(s.queryEndTime)>MAX_AGE_MS||timestamp(s.queryEndTime)>Date.now()+300000))throw coded('stale_candidate');}
        else{
            const explicit=options.exceptionsFile?await readJson(options.exceptionsFile):(old?.explicitIps||[]);
            let responses;try{responses=await (deps.download||download)();}catch{throw coded('download_failed');}
            data=compileResponses(responses,explicit);
        }
        const diff=compareManifests(old,data);
        // A dry run may preserve a review artifact, but never changes live data/status.
        await atomicWrite(output+'.candidate.json',JSON.stringify(data)+'\n');
        if(!apply)return {applied:false,sha256:data.sha256,...diff};
        if(!old&&!bootstrap)throw coded('bootstrap_required');
        if(bootstrap&&old)throw coded('bootstrap_existing_file');
        if(bootstrap&&!options.candidate)throw coded('bootstrap_reviewed_candidate_required');
        if(diff.requiresReview&&!acceptLargeChange&&!restorePrevious)throw coded('change_threshold');
        if(!bootstrap&&!deps.verify){loopback(options.runtimeUrl);loopback(options.edgeUrl);}
        // Keep exact bytes: rollback must not rewrite a concurrent config or lose metadata.
        const oldBytes=old?await fs.readFile(output,'utf8'):null;
        if(oldBytes!==null)await atomicWrite(output+'.previous',oldBytes);
        await atomicWrite(output,JSON.stringify(data)+'\n');activated=true;
        const safeVerify=async d=>{try{return await verify(d);}catch{return false;}};
        if(!bootstrap&&!(await safeVerify(data))){
            if(oldBytes!==null){await atomicWrite(output,oldBytes);activated=false;if(!(await safeVerify(old)))throw coded('rollback_convergence_failed');}
            throw coded('convergence_failed');
        }
        await atomicWrite(output+'.status.json',JSON.stringify({lastSuccessAt:new Date().toISOString(),lastAttemptAt:new Date().toISOString(),lastError:null,sha256:data.sha256})+'\n');
        return {applied:true,sha256:data.sha256,...diff};
    }catch(error){
        const known=new Set(['download_failed','invalid_source','incomplete_sources','empty_asn','invalid_exceptions','stale_candidate','bootstrap_required','bootstrap_existing_file','bootstrap_reviewed_candidate_required','change_threshold','invalid_health_url','convergence_failed','rollback_convergence_failed','invalid_local_file']);
        const code=known.has(error.code)?error.code:'validation_or_io_failed';
        if(apply)await atomicWrite(output+'.status.json',JSON.stringify({...status,lastAttemptAt:new Date().toISOString(),lastError:code,activated})+'\n').catch(()=>{});
        throw coded(code);
    }finally{await handle.close();await fs.unlink(lock);}
}
async function main(){
    const values={};const flags=new Set(['apply','restore-previous','accept-large-change','bootstrap']);
    const allowed=new Set([...flags,'output','candidate','exceptions-file','runtime-url','edge-health-url']);
    for(let i=2;i<process.argv.length;i++){const key=process.argv[i].replace(/^--/,'');if(!process.argv[i].startsWith('--')||!allowed.has(key)||key in values)throw coded('invalid_argument');values[key]=flags.has(key)?true:process.argv[++i];if(values[key]===undefined||String(values[key]).startsWith('--'))throw coded('invalid_argument');}
    if(values.bootstrap&&!values.apply)throw coded('bootstrap_requires_apply');
    const result=await updateAllowlist({output:values.output,apply:values.apply,restorePrevious:values['restore-previous'],acceptLargeChange:values['accept-large-change'],bootstrap:values.bootstrap,candidate:values.candidate,exceptionsFile:values['exceptions-file'],runtimeUrl:values['runtime-url'],edgeUrl:values['edge-health-url']});
    console.log(JSON.stringify(result));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({event:'alibaba_allowlist_update_failed',code:e.code||'update_failed'}));process.exitCode=1;});
