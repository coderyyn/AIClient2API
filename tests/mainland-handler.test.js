import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileRanges } from '../scripts/ops/update-mainland-ranges.mjs';
import { manifestHash } from '../src/utils/alibaba-allowlist.js';
import { getClientIp } from '../src/utils/common.js';
import { getPluginManager } from '../src/core/plugin-manager.js';
jest.mock('../src/ui-modules/auth.js', () => ({ checkAuth: jest.fn(async () => false) }));
import { EventEmitter } from 'events';
import requestContext from '../src/utils/context.js';
import { getProviderLeaseScope, registerProviderLease } from '../src/runtime/provider-lease-scope.js';
import { createRequestHandler } from '../src/handlers/request-handler.js';
import { handleAPIRequests } from '../src/services/api-manager.js';

jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    runWithContext: (_id, callback) => callback()
} }));
jest.mock('../src/utils/common.js', () => ({
    getClientIp: jest.fn(),
    getRequestBody: jest.fn(),
    handleError: (res, error) => { res.statusCode = error.status || 500; res.end('{}'); }
}));
jest.mock('../src/services/ui-manager.js', () => ({ handleUIApiRequests: async () => false, serveStaticFiles: async () => false }));
jest.mock('../src/services/api-manager.js', () => ({ handleAPIRequests: jest.fn() }));
jest.mock('../src/services/service-manager.js', () => ({ getApiService: jest.fn(), getProviderStatus: jest.fn(), getProviderPoolManager: () => null }));
jest.mock('../src/providers/adapter.js', () => ({ getRegisteredProviders: () => ['openai-codex-oauth'], isRegisteredProvider: type => type === 'openai-codex-oauth' }));
jest.mock('../src/utils/grok-assets-proxy.js', () => ({ handleGrokAssetsProxy: jest.fn() }));
jest.mock('../src/core/config-manager.js', () => ({ PROMPT_LOG_FILENAME: null }));
jest.mock('../src/core/plugin-manager.js', () => ({ getPluginManager: jest.fn() }));

class Response extends EventEmitter {
    constructor() { super(); this.statusCode = 200; this.headers = {}; }
    setHeader(name, value) { this.headers[name] = value; }
    writeHead(status) { this.statusCode = status; }
    write() { return true; }
    end() { this.writableEnded = this.writableFinished = true; this.emit('finish'); }
}

describe('mainland rejection before provider and quota dispatch',()=>{
    let dir,file,plugin;
    beforeEach(()=>{
        jest.clearAllMocks();dir=fs.mkdtempSync(path.join(os.tmpdir(),'geo-handler-'));file=path.join(dir,'country.json');
        const data=compileRanges([['114.114.114.0','114.114.114.255','CN'],['240e::','240e::ffff','CN']],{version:'2026-10',source:'synthetic',sourceSha256:'0'.repeat(64)});
        fs.writeFileSync(file,JSON.stringify(data));
        getClientIp.mockReturnValue({clientIp:'114.114.114.114',peerIp:'172.21.0.1',clientIpSource:'trusted-x-real-ip'});
        plugin={isPluginStaticPath:()=>false,getPluginByStaticPath:()=>null,executeRoutes:jest.fn(async()=>false),executeAuth:jest.fn(async()=>({authorized:true})),executeMiddleware:async()=>({handled:false}),executeHook:jest.fn(async()=>{})};
        getPluginManager.mockReturnValue(plugin);
        handleAPIRequests.mockImplementation(async(_m,_p,_q,res)=>{res.writeHead(200);res.end();return true;});
    });
    afterEach(()=>fs.rmSync(dir,{recursive:true}));
    async function request(clientIp,missing=false,url='/v1/responses',forcedStatus=null,headers=null,extraConfig={}){
        getClientIp.mockReturnValue({clientIp,peerIp:'172.21.0.1',clientIpSource:'trusted-x-real-ip',...(forcedStatus?{edgeDeniedStatus:forcedStatus}:{})});
        const req=new EventEmitter();Object.assign(req,{method:url.includes('potluckuser')?'GET':'POST',url,headers:{host:'localhost',...(headers || {authorization:'Bearer maki_synthetic'})},socket:{remoteAddress:'127.0.0.1'}});
        const res=new Response();await createRequestHandler({MODEL_PROVIDER:'openai-codex-oauth',UI_ENABLED:true,MAINLAND_CLIENT_KEYS_ONLY:true,MAINLAND_COUNTRY_FILE_PATH:missing?file+'.missing':file,REQUEST_AUDIT_NETWORK_METADATA_ENABLED:true,...extraConfig},null)(req,res);
        await new Promise(r=>setImmediate(r));return res;
    }
    test.each(['8.8.8.8','127.0.0.1','invalid'])('rejects %s without entering plugin authentication/quota or upstream',async ip=>{
        expect((await request(ip)).statusCode).toBe(403);expect(plugin.executeAuth).not.toHaveBeenCalled();expect(plugin.executeRoutes).not.toHaveBeenCalled();expect(handleAPIRequests).not.toHaveBeenCalled();
        const finalized=plugin.executeHook.mock.calls.filter(x=>x[0]==='onRequestCompleted');expect(finalized).toHaveLength(1);
        expect(finalized[0][1]).toMatchObject({clientIp:ip,potluckKeyHash:expect.any(String),mainlandPolicy:{allowed:false}});
        expect(finalized[0][1].potluckApiKey).toBeUndefined();
    });
    test('missing database returns 503 and is audited',async()=>{
        expect((await request('114.114.114.114',true)).statusCode).toBe(503);expect(handleAPIRequests).not.toHaveBeenCalled();
        expect(plugin.executeHook.mock.calls.filter(x=>x[0]==='onRequestCompleted')).toHaveLength(1);
    });
    test('CN request retains normal authentication and dispatch',async()=>{
        expect((await request('114.114.114.114')).statusCode).toBe(200);expect(plugin.executeAuth).toHaveBeenCalledTimes(1);expect(handleAPIRequests).toHaveBeenCalledTimes(1);
        expect(plugin.executeHook.mock.calls.find(x=>x[0]==='onRequestCompleted')[1]).toMatchObject({clientIp:'114.114.114.114',mainlandPolicy:{allowed:true,code:'MAINLAND_CN'}});
    });
    test.each([['47.80.0.1','ALIBABA_CLOUD_ALLOWLIST',37963],['47.76.45.103','EXPLICIT_IP_ALLOWLIST',null]])('audits %s cloud/explicit reason and preserves key authentication',async(ip,code,asn)=>{
        const d={schemaVersion:1,kind:'alibaba-cloud',asns:[37963,45102,134963],generatedAt:new Date().toISOString(),sources:[37963,45102,134963].map((a,i)=>({asn:a,source:`https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS${a}`,queryEndTime:new Date().toISOString(),prefixes:[`47.${80+i}.0.0/24`]})),explicitIps:['47.76.45.103']};d.sha256=manifestHash(d);const allow=path.join(dir,'alibaba.json');fs.writeFileSync(allow,JSON.stringify(d));
        const extra={ALIBABA_ALLOWLIST_ENABLED:true,ALIBABA_ALLOWLIST_FILE:allow};
        expect((await request(ip,false,'/v1/responses',null,null,extra)).statusCode).toBe(200);expect(plugin.executeAuth).toHaveBeenCalledTimes(1);
        expect(plugin.executeHook.mock.calls.find(x=>x[0]==='onRequestCompleted')[1].mainlandPolicy).toMatchObject({allowed:true,code,asn,allowlistSha256:d.sha256});
    });
    test.each([401,403,429,503])('trusted edge denial %s is audited without quota or upstream',async status=>{
        expect((await request('114.114.114.114',false,'/v1/responses',status)).statusCode).toBe(status);expect(plugin.executeAuth).not.toHaveBeenCalled();expect(handleAPIRequests).not.toHaveBeenCalled();expect(plugin.executeHook.mock.calls.filter(x=>x[0]==='onRequestCompleted')).toHaveLength(1);
        expect(plugin.executeHook.mock.calls.find(x=>x[0]==='onRequestCompleted')[1]).toMatchObject({mainlandPolicy:{allowed:true,code:'MAINLAND_CN'},outcome:'admission_rejected'});
    });
    test('user usage cannot bypass country restriction',async()=>{
        expect((await request('8.8.8.8',false,'/api/potluckuser/usage')).statusCode).toBe(403);expect(plugin.executeRoutes).not.toHaveBeenCalled();
    });
    test.each([
        ['/v1/responses',{authorization:'Bearer ordinary','x-api-key':'maki_synthetic'}],
        ['/v1/responses',{'x-api-key':'ordinary','x-goog-api-key':'maki_synthetic'}],
        ['/v1/responses?key=maki_synthetic',{authorization:'Bearer ordinary'}],
        ['/api/potluckuser/usage',{authorization:'Bearer ordinary','x-api-key':'maki_synthetic'}]
    ])('mixed credentials cannot hide the authenticated client key on %s',async(url,headers)=>{
        expect((await request('8.8.8.8',false,url,null,headers)).statusCode).toBe(403);
        expect(plugin.executeAuth).not.toHaveBeenCalled();expect(plugin.executeRoutes).not.toHaveBeenCalled();expect(handleAPIRequests).not.toHaveBeenCalled();
        expect(plugin.executeHook.mock.calls.find(x=>x[0]==='onRequestCompleted')[1]).toMatchObject({potluckKeyHash:expect.any(String),mainlandPolicy:{allowed:false}});
    });
    test.each(['/v1beta/models/gemini:generateContent/suffix','/nested/path/v1beta/models/gemini:streamGenerateContent','/other/count_tokens'])('all paths recognized by existing model dispatchers are gated: %s',async url=>{
        expect((await request('8.8.8.8',false,url)).statusCode).toBe(403);
        expect(plugin.executeAuth).not.toHaveBeenCalled();expect(plugin.executeRoutes).not.toHaveBeenCalled();expect(handleAPIRequests).not.toHaveBeenCalled();
    });
});
