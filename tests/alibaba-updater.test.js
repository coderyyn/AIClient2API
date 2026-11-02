import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { compileResponses, updateAllowlist, compareManifests, sourceQueryUrl, verifyConvergence } from '../scripts/ops/update-alibaba-allowlist.mjs';

const now=()=>new Date().toISOString();
function responses(){const end=now();return [37963,45102,134963].map((asn,i)=>({status:'ok',data:{resource:String(asn),query_endtime:end,prefixes:[{prefix:`47.${80+i}.0.0/24`,timelines:[{starttime:'2026-01-01T00:00:00Z',endtime:end}]},{prefix:`2400:32${10+i}::/48`,timelines:[{starttime:'2026-01-01T00:00:00Z',endtime:end}]},{prefix:'8.8.8.0/24',timelines:[{starttime:'2026-01-01T00:00:00Z',endtime:'2026-01-02T00:00:00Z'}]}]}}));}
describe('Alibaba updater transaction',()=>{
    let dir,output;
    beforeEach(async()=>{dir=await fs.mkdtemp(path.join(os.tmpdir(),'alibaba-update-'));output=path.join(dir,'active.json');});
    afterEach(async()=>fs.rm(dir,{recursive:true,force:true}));
    const deps=()=>({download:async()=>responses(),verify:async()=>true});
    test('uses RIPE-supported integer Unix seconds instead of unsupported millisecond ISO timestamps',()=>{
        const u=new URL(sourceQueryUrl(37963,Date.parse('2026-11-02T02:47:44.047Z')));expect(u.searchParams.get('endtime')).toBe('1793587664');expect(Number(u.searchParams.get('endtime'))-Number(u.searchParams.get('starttime'))).toBe(172800);
    });
    test('compiles all three ASNs, filters withdrawn prefixes and preserves explicit exceptions',()=>{
        const d=compileResponses(responses(),['47.76.45.103']);expect(d.sources).toHaveLength(3);expect(d.sources.every(s=>s.prefixes.length===2&&!s.prefixes.includes('8.8.8.0/24'))).toBe(true);expect(d.explicitIps).toEqual(['47.76.45.103']);
    });
    test.each(['partial','empty','old','wrong_asn','private','future','invalid_timeline'])('rejects %s source data',kind=>{
        const rr=responses();
        if(kind==='partial')rr.pop();
        if(kind==='empty')rr[0].data.prefixes=[];
        if(kind==='old')rr[0].data.query_endtime='2026-01-01T00:00:00Z';
        if(kind==='future')rr[0].data.query_endtime='2100-01-01T00:00:00Z';
        if(kind==='wrong_asn')rr[0].data.resource='123';
        if(kind==='private')rr[0].data.prefixes[0].prefix='10.0.0.0/8';
        if(kind==='invalid_timeline')rr[0].data.prefixes[0].timelines[0].starttime='bad';
        expect(()=>compileResponses(rr,[])).toThrow();
    });
    test('default dry run writes candidate only and does not modify active or status',async()=>{
        const result=await updateAllowlist({output},deps());expect(result.applied).toBe(false);await expect(fs.stat(output)).rejects.toHaveProperty('code','ENOENT');await expect(fs.stat(output+'.status.json')).rejects.toHaveProperty('code','ENOENT');expect(JSON.parse(await fs.readFile(output+'.candidate.json','utf8')).asns).toEqual([37963,45102,134963]);
    });
    test('successful apply preserves explicit IPs, writes backup/status and verifies expected hash',async()=>{
        const old=compileResponses(responses(),['47.76.45.103']);await fs.writeFile(output,JSON.stringify(old));let expected;
        const result=await updateAllowlist({output,apply:true},{...deps(),verify:async d=>{expected=d.sha256;return true;}});
        expect(result.applied).toBe(true);expect(JSON.parse(await fs.readFile(output,'utf8')).explicitIps).toEqual(['47.76.45.103']);expect(JSON.parse(await fs.readFile(output+'.previous','utf8')).sha256).toBe(old.sha256);expect(expected).toBe(result.sha256);expect(JSON.parse(await fs.readFile(output+'.status.json','utf8')).lastError).toBe(null);
    });
    test('large change retains candidate and old file; threshold override cannot bypass private ranges',async()=>{
        const old=compileResponses(responses(),[]);await fs.writeFile(output,JSON.stringify(old));const rr=responses();rr[0].data.prefixes[0].prefix='47.80.0.0/16';
        expect(compareManifests(old,compileResponses(rr,[])).requiresReview).toBe(true);
        await expect(updateAllowlist({output,apply:true},{...deps(),download:async()=>rr})).rejects.toThrow('change_threshold');
        expect(JSON.parse(await fs.readFile(output,'utf8')).sha256).toBe(old.sha256);await fs.stat(output+'.candidate.json');
        rr[0].data.prefixes[0].prefix='10.0.0.0/8';await expect(updateAllowlist({output,apply:true,acceptLargeChange:true},{...deps(),download:async()=>rr})).rejects.toThrow();
    });
    test('failed verification restores bytes and verifies rollback; reports failure',async()=>{
        const old=JSON.stringify(compileResponses(responses(),[]));await fs.writeFile(output,old);let calls=0;
        await expect(updateAllowlist({output,apply:true},{...deps(),verify:async()=>++calls>1})).rejects.toThrow('convergence_failed');expect(await fs.readFile(output,'utf8')).toBe(old);expect(calls).toBe(2);expect(JSON.parse(await fs.readFile(output+'.status.json','utf8')).lastError).toBe('convergence_failed');
    });
    test('thrown verification also restores live data',async()=>{
        const old=JSON.stringify(compileResponses(responses(),[]));await fs.writeFile(output,old);let calls=0;
        await expect(updateAllowlist({output,apply:true},{...deps(),verify:async()=>{if(++calls===1)throw Error('timeout');return true;}})).rejects.toThrow('convergence_failed');expect(await fs.readFile(output,'utf8')).toBe(old);
    });
    test('download failure does not replace live manifest',async()=>{
        const old=JSON.stringify(compileResponses(responses(),[]));await fs.writeFile(output,old);
        await expect(updateAllowlist({output,apply:true},{...deps(),download:async()=>{throw Error('network with secret text');}})).rejects.toThrow('download_failed');expect(await fs.readFile(output,'utf8')).toBe(old);expect(await fs.readFile(output+'.status.json','utf8')).not.toContain('secret');
    });
    test('parallel updater is rejected without removing another lock',async()=>{
        await fs.writeFile(output+'.lock','another');await expect(updateAllowlist({output,apply:true},deps())).rejects.toThrow('update_locked');expect(await fs.readFile(output+'.lock','utf8')).toBe('another');
    });
    test('restore previous needs no download and validates convergence',async()=>{
        const old=compileResponses(responses(),['47.76.45.103']);await fs.writeFile(output+'.previous',JSON.stringify(old));await fs.writeFile(output,JSON.stringify(compileResponses(responses(),[])));
        const result=await updateAllowlist({output,apply:true,restorePrevious:true},{download:async()=>{throw Error('must not download');},verify:async()=>true});expect(result.applied).toBe(true);expect(JSON.parse(await fs.readFile(output,'utf8')).sha256).toBe(old.sha256);
    });
    test('checks all live worker and edge hashes against a bounded deadline',async()=>{
        const data=compileResponses(responses(),[]);const policy={enabled:true,available:true,sha256:data.sha256};let edgeHash='wrong';
        const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/edge'?{mainlandPolicy:{alibabaAllowlist:{...policy,sha256:edgeHash}}}:{controlWorkers:1,executionWorkers:1,mainlandPolicy:{ready:true,workers:{control:{alibabaAllowlist:policy},execution:{alibabaAllowlist:policy}}}}));});
        await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
        try{expect(await verifyConvergence(data,base+'/runtime',base+'/edge',{timeoutMs:50})).toBe(false);edgeHash=data.sha256;expect(await verifyConvergence(data,base+'/runtime',base+'/edge',{timeoutMs:500})).toBe(true);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
    });
});
