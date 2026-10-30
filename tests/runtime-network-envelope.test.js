import { resolveClientNetwork, signNetworkHeaders } from '../src/utils/client-network.js';

describe('runtime proxy network trust boundary',()=>{
    const saved={...process.env};
    afterEach(()=>{for(const key of ['RUNTIME_NETWORK_SECRET','RUNTIME_WORKER_ROLE']){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}});
    test('untrusted peer cannot choose x-real-ip or x-forwarded-for',()=>{
        const req={method:'POST',url:'/v1/responses',headers:{'x-real-ip':'114.114.114.114','x-forwarded-for':'114.114.114.114'},socket:{remoteAddress:'8.8.8.8'}};
        expect(resolveClientNetwork(req,{TRUST_PROXY:true,TRUSTED_PROXY_IPS:['127.0.0.1']},{detailed:true})).toEqual({clientIp:'8.8.8.8',peerIp:'8.8.8.8',clientIpSource:'peer'});
    });
    test('authenticated network metadata preserves the original peer across loopback workers',()=>{
        const secret='synthetic-network-key';const original={method:'POST',url:'/v1/responses?x=1'};
        const network={clientIp:'114.114.114.114',peerIp:'172.21.0.1',clientIpSource:'trusted-x-real-ip'};
        process.env.RUNTIME_NETWORK_SECRET=secret;process.env.RUNTIME_WORKER_ROLE='execution';
        const req={...original,headers:signNetworkHeaders(secret,original,network),socket:{remoteAddress:'127.0.0.1'}};
        expect(resolveClientNetwork(req,{TRUST_PROXY:true},{detailed:true})).toEqual(network);
        req.url='/v1/responses?x=2';req.headers['x-real-ip']='114.114.114.114';
        expect(resolveClientNetwork(req,{TRUST_PROXY:true,TRUSTED_PROXY_IPS:['127.0.0.1']},{detailed:true})).toMatchObject({clientIp:'127.0.0.1',clientIpSource:'unverified-runtime-peer'});
    });
    test('a forged envelope is not accepted from an external peer',()=>{
        process.env.RUNTIME_NETWORK_SECRET='synthetic';process.env.RUNTIME_WORKER_ROLE='control';
        const req={method:'GET',url:'/api/potluckuser/usage',headers:{'x-aiclient-network':'fake','x-real-ip':'114.114.114.114'},socket:{remoteAddress:'203.0.113.5'}};
        expect(resolveClientNetwork(req,{TRUST_PROXY:true,TRUSTED_PROXY_IPS:['127.0.0.1']},{detailed:true}).clientIp).toBe('203.0.113.5');
    });
});
