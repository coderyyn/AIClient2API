import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AlibabaAllowlist, manifestHash, validateManifest } from '../src/utils/alibaba-allowlist.js';
import { compileRanges } from '../scripts/ops/update-mainland-ranges.mjs';
import { evaluateMainlandPolicy, getMainlandPolicyStatus } from '../src/utils/mainland-country-policy.js';

export function fixture() {
    const data = {schemaVersion:1,kind:'alibaba-cloud',asns:[37963,45102,134963],generatedAt:new Date().toISOString(),
        sources:[37963,45102,134963].map((asn,i)=>({asn,source:`https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS${asn}`,
            queryEndTime:new Date().toISOString(),prefixes:[['47.242.213.0/24','2400:3200::/48'],['47.76.45.0/24','2400:3201::/48'],['8.219.150.0/24','2400:3202::/48']][i]})),explicitIps:['38.46.215.183']};
    data.sha256=manifestHash(data);return data;
}

describe('independent Alibaba cloud allowlist',()=>{
    let dir,file,config;
    beforeEach(()=>{
        dir=fs.mkdtempSync(path.join(os.tmpdir(),'alibaba-'));file=path.join(dir,'alibaba.json');
        const cn=compileRanges([['114.114.114.0','114.114.114.255','CN'],['240e::','240e::ffff','CN']],{version:'2026-10'});
        fs.writeFileSync(path.join(dir,'cn.json'),JSON.stringify(cn));
        config={MAINLAND_CLIENT_KEYS_ONLY:true,MAINLAND_COUNTRY_FILE_PATH:path.join(dir,'cn.json'),ALIBABA_ALLOWLIST_ENABLED:true,ALIBABA_ALLOWLIST_FILE:file};
    });
    afterEach(()=>fs.rmSync(dir,{recursive:true}));
    test.each(['47.242.213.0','47.242.213.255','47.76.45.103','8.219.150.168','2400:3200::','2400:3201::1','2400:3202::ffff','::ffff:47.76.45.103'])('allows cloud IP %s with ASN evidence',ip=>{
        fs.writeFileSync(file,JSON.stringify(fixture()));
        expect(evaluateMainlandPolicy(config,ip)).toMatchObject({allowed:true,code:'ALIBABA_CLOUD_ALLOWLIST',allowlistSha256:expect.any(String),asn:expect.any(Number)});
    });
    test('explicit exception is distinct from CN; CN remains distinct from cloud',()=>{
        fs.writeFileSync(file,JSON.stringify(fixture()));
        expect(evaluateMainlandPolicy(config,'38.46.215.183').code).toBe('EXPLICIT_IP_ALLOWLIST');
        expect(evaluateMainlandPolicy(config,'114.114.114.114').code).toBe('MAINLAND_CN');
        expect(evaluateMainlandPolicy(config,'47.242.214.0')).toMatchObject({allowed:false,status:403});
        expect(evaluateMainlandPolicy({...config,ALIBABA_ALLOWLIST_ENABLED:false},'47.76.45.103').allowed).toBe(false);
    });
    test('missing allowlist does not reject CN but foreign requires available data',()=>{
        expect(evaluateMainlandPolicy(config,'114.114.114.114').allowed).toBe(true);
        expect(evaluateMainlandPolicy(config,'47.76.45.103')).toMatchObject({allowed:false,status:503,code:'ALIBABA_ALLOWLIST_UNAVAILABLE'});
    });
    test.each(['127.0.0.1','10.0.0.1','169.254.1.1','::1','fc00::1','bad','192.0.2.1','2001:db8::1','2001:2::1'])('never exempts nonpublic or invalid %s',ip=>{
        fs.writeFileSync(file,JSON.stringify(fixture()));expect(evaluateMainlandPolicy(config,ip)).toMatchObject({allowed:false,status:403,code:'CLIENT_IP_UNVERIFIABLE'});
    });
    test('corrupt reload retains good data and exposes error; stale data stays effective',()=>{
        const p=new AlibabaAllowlist();const data=fixture();data.sources.forEach(s=>s.queryEndTime='2026-01-01T00:00:00Z');data.sha256=manifestHash(data);
        fs.writeFileSync(file,JSON.stringify(data));expect(p.refresh(file)).toMatchObject({available:true,stale:true});
        fs.writeFileSync(file,'broken');expect(p.refresh(file)).toMatchObject({available:true,lastError:'alibaba_allowlist_load_failed'});
        expect(p.match('47.76.45.103')).toMatchObject({code:'ALIBABA_CLOUD_ALLOWLIST',asn:45102});
    });
    test('manifest rejects unknown ASNs, checksum mismatch and nonpublic prefix or exception',()=>{
        for(const mutate of [d=>d.asns.push(123),d=>d.sources[0].prefixes.push('0.0.0.0/0'),d=>d.explicitIps.push('127.0.0.1'),d=>d.sources[0].prefixes.push('192.0.2.0/24'),d=>d.sources[0].prefixes.push('2001:db8::/32')]){
            const d=fixture();mutate(d);d.sha256=manifestHash(d);expect(()=>validateManifest(d)).toThrow();
        }
        expect(()=>validateManifest({...fixture(),sha256:'bad'})).toThrow();
    });
    test('health exposes the independent checksum and update failure',()=>{
        fs.writeFileSync(file,JSON.stringify(fixture()));fs.writeFileSync(file+'.status.json',JSON.stringify({lastSuccessAt:'2026-11-02T00:00:00Z',lastError:'download_failed'}));
        expect(getMainlandPolicyStatus(config).alibabaAllowlist).toMatchObject({enabled:true,available:true,sha256:expect.any(String),lastUpdateError:'download_failed'});
    });
    test.each(['null','[]','"text"','{"lastSuccessAt":{},"lastError":[]}'])('diagnostic status %s cannot break admission or health',sidecar=>{
        fs.writeFileSync(file,JSON.stringify(fixture()));fs.writeFileSync(file+'.status.json',sidecar);
        expect(getMainlandPolicyStatus(config).alibabaAllowlist).toMatchObject({available:true,lastUpdateError:null});expect(evaluateMainlandPolicy(config,'47.76.45.103').allowed).toBe(true);
    });
});
