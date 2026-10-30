import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MainlandCountryPolicy, policyHash } from '../src/utils/mainland-country-policy.js';
import { compileRanges, activateRanges } from '../scripts/ops/update-mainland-ranges.mjs';

export function countryFixture(version='2026-10') {
    return compileRanges([['114.114.114.0','114.114.114.255','CN'],['240e::','240e::ffff','CN'],['8.8.8.0','8.8.8.255','US']], {
        version,source:`https://download.db-ip.com/free/dbip-country-lite-${version}.csv.gz`,sourceSha256:'0'.repeat(64),generatedAt:'2026-10-30T00:00:00Z'
    });
}
describe('offline mainland policy',()=>{
    let dir,file;
    beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'mainland-'));file=path.join(dir,'country.json');});
    afterEach(()=>fs.rmSync(dir,{recursive:true}));
    test.each(['114.114.114.0','114.114.114.255','::ffff:114.114.114.114','::FFFF:7272:7272','240e::','240e::ffff'])('allows CN boundary or mapped IP %s',ip=>{
        fs.writeFileSync(file,JSON.stringify(countryFixture()));const p=new MainlandCountryPolicy();p.refresh(file);expect(p.evaluate(ip).allowed).toBe(true);
    });
    test.each(['114.114.113.255','114.114.115.0','8.8.8.8','127.0.0.1','10.0.0.1','::1','fc00::1','fe80::1','240e::1:0','bad','114.114.114.114/32'])('rejects non-CN, private or invalid IP %s',ip=>{
        fs.writeFileSync(file,JSON.stringify(countryFixture()));const p=new MainlandCountryPolicy();p.refresh(file);expect(p.evaluate(ip)).toMatchObject({allowed:false,status:403});
    });
    test('no data fails closed; invalid update retains the last valid data',()=>{
        const p=new MainlandCountryPolicy();p.refresh(file);expect(p.evaluate('114.114.114.114').status).toBe(503);
        fs.writeFileSync(file,JSON.stringify(countryFixture()));p.refresh(file);const old=p.status().sha256;
        fs.writeFileSync(file,'broken');expect(p.refresh(file)).toMatchObject({available:true,sha256:old,lastError:'country_policy_load_failed'});
        expect(p.evaluate('114.114.114.114').allowed).toBe(true);
        const next=countryFixture('2026-11');fs.writeFileSync(file,JSON.stringify(next));expect(p.refresh(file)).toMatchObject({sha256:next.sha256,lastError:null});
    });
    test('rejects invalid checksums and overlapping ranges',()=>{
        const data=countryFixture();data.ipv4.push(data.ipv4[0]);data.sha256=policyHash(data);fs.writeFileSync(file,JSON.stringify(data));
        const p=new MainlandCountryPolicy();expect(p.refresh(file).available).toBe(false);
        const bad=countryFixture();bad.sha256='0'.repeat(64);fs.writeFileSync(file,JSON.stringify(bad));expect(p.refresh(file).available).toBe(false);
    });
    test('atomic activation backs up valid data and does not replace it with invalid input',async()=>{
        const old=countryFixture(),next=countryFixture('2026-11');await activateRanges(file,old);await activateRanges(file,next);
        expect(JSON.parse(fs.readFileSync(file+'.previous')).sha256).toBe(old.sha256);
        await expect(activateRanges(file,{...next,sha256:'bad'})).rejects.toThrow();
        expect(JSON.parse(fs.readFileSync(file)).sha256).toBe(next.sha256);
    });
});
