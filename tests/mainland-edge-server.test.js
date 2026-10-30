import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createEdgeAuthServer } from '../src/edge-auth/server.js';
import { compileRanges } from '../scripts/ops/update-mainland-ranges.mjs';

describe('country admission before lease acquisition',()=>{
    let dir,instance,service,base;
    beforeEach(async()=>{
        dir=fs.mkdtempSync(path.join(os.tmpdir(),'country-edge-'));const file=path.join(dir,'ranges.json');
        fs.writeFileSync(file,JSON.stringify(compileRanges([['114.114.114.0','114.114.114.255','CN'],['240e::','240e::ffff','CN']],{version:'2026-10',source:'synthetic',sourceSha256:'0'.repeat(64)})));
        fs.writeFileSync(path.join(dir,'keys.json'),'{}');
        service={authorize:jest.fn(async()=>({allowed:true,keyHash:'synthetic',leaseId:'synthetic-lease',leaseMode:'enforce'})),replacePolicies:async()=>{},snapshot:()=>({})};
        instance=createEdgeAuthServer({service,policyFile:path.join(dir,'keys.json'),config:{MAINLAND_CLIENT_KEYS_ONLY:true,MAINLAND_COUNTRY_FILE_PATH:file},trustedProxyIps:['127.0.0.1']});
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
    test('untrusted proxy header cannot select a CN address',async()=>{
        // A distinct, untrusted address would be evaluated as its peer, not the header.
        const other=createEdgeAuthServer({service,policyFile:path.join(dir,'keys.json'),config:{MAINLAND_CLIENT_KEYS_ONLY:true,MAINLAND_COUNTRY_FILE_PATH:path.join(dir,'ranges.json')},trustedProxyIps:[]});
        await new Promise(r=>other.server.listen(0,'127.0.0.1',r));const old=base;base=other.server.address().port;
        try{expect((await request('114.114.114.114')).status).toBe(403);expect(service.authorize).not.toHaveBeenCalled();}finally{base=old;await other.close();}
    });
});
