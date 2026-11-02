import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createEdgeAuthServer } from '../src/edge-auth/server.js';
import { compileRanges } from '../scripts/ops/update-mainland-ranges.mjs';
import { manifestHash } from '../src/utils/alibaba-allowlist.js';

describe('country admission before lease acquisition',()=>{
    let dir,instance,service,base;
    beforeEach(async()=>{
        dir=fs.mkdtempSync(path.join(os.tmpdir(),'country-edge-'));const file=path.join(dir,'ranges.json');
        fs.writeFileSync(file,JSON.stringify(compileRanges([['114.114.114.0','114.114.114.255','CN'],['240e::','240e::ffff','CN']],{version:'2026-10',source:'synthetic',sourceSha256:'0'.repeat(64)})));
        fs.writeFileSync(path.join(dir,'keys.json'),'{}');
        service={authorize:jest.fn(async()=>({allowed:true,keyHash:'synthetic',leaseId:'synthetic-lease',leaseMode:'enforce'})),replacePolicies:async()=>{},snapshot:()=>({})};
        const cloud={schemaVersion:1,kind:'alibaba-cloud',asns:[37963,45102,134963],generatedAt:new Date().toISOString(),sources:[37963,45102,134963].map((asn,i)=>({asn,source:`https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS${asn}`,queryEndTime:new Date().toISOString(),prefixes:[`47.${80+i}.0.0/24`]})),explicitIps:['47.76.45.103']};cloud.sha256=manifestHash(cloud);fs.writeFileSync(path.join(dir,'alibaba.json'),JSON.stringify(cloud));
        instance=createEdgeAuthServer({service,policyFile:path.join(dir,'keys.json'),config:{MAINLAND_CLIENT_KEYS_ONLY:true,MAINLAND_COUNTRY_FILE_PATH:file,ALIBABA_ALLOWLIST_ENABLED:true,ALIBABA_ALLOWLIST_FILE:path.join(dir,'alibaba.json')},trustedProxyIps:['127.0.0.1']});
        await new Promise(r=>instance.server.listen(0,'127.0.0.1',r));base=instance.server.address().port;
    });
    afterEach(async()=>{await instance.close();fs.rmSync(dir,{recursive:true});});
    async function request(ip){return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:base,path:'/authorize',headers:{Authorization:'Bearer maki_synthetic','X-Edge-Client-IP':ip,'X-Edge-Original-URI':'/v1/responses'}},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,headers:res.headers}));});req.on('error',reject);req.end();});}
    test('non-CN key cannot acquire a lease',async()=>{
        const r=await request('8.8.8.8');expect(r.status).toBe(403);expect(r.headers['x-edge-response-status']).toBe('403');expect(service.authorize).not.toHaveBeenCalled();
    });
    test('CN key retains normal key validation and lease acquisition',async()=>{
        const r=await request('114.114.114.114');expect(r.status).toBe(204);expect(r.headers['x-edge-lease-id']).toBe('synthetic-lease');expect(service.authorize).toHaveBeenCalledTimes(1);
    });
    test.each(['47.80.0.1','47.81.0.1','47.82.0.1','47.76.45.103'])('cloud and explicit %s continue normal authentication',async ip=>{
        expect((await request(ip)).status).toBe(204);expect(service.authorize).toHaveBeenCalledTimes(1);
    });
    test('cold missing cloud file preserves CN admission and denies foreign with audited 503 marker',async()=>{
        fs.unlinkSync(path.join(dir,'alibaba.json'));
        expect((await request('114.114.114.114')).status).toBe(204);
        const r=await request('47.80.0.1');expect(r.status).toBe(403);expect(r.headers['x-edge-response-status']).toBe('503');
    });
    test('untrusted proxy header cannot select a CN address',async()=>{
        // A distinct, untrusted address would be evaluated as its peer, not the header.
        const other=createEdgeAuthServer({service,policyFile:path.join(dir,'keys.json'),config:{MAINLAND_CLIENT_KEYS_ONLY:true,MAINLAND_COUNTRY_FILE_PATH:path.join(dir,'ranges.json')},trustedProxyIps:[]});
        await new Promise(r=>other.server.listen(0,'127.0.0.1',r));const old=base;base=other.server.address().port;
        try{expect((await request('114.114.114.114')).status).toBe(403);expect(service.authorize).not.toHaveBeenCalled();}finally{base=old;await other.close();}
    });
});
