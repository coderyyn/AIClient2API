import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { Address4, Address6 } from 'ip-address';
import { normalizeClientIp } from './client-network.js';
import { AlibabaAllowlist } from './alibaba-allowlist.js';
import { publicIp } from './public-ip.js';

const blocked = new BlockList();
for (const [ip, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['198.18.0.0',15],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(ip,bits,'ipv4');
for (const [ip,bits] of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8]]) blocked.addSubnet(ip,bits,'ipv6');
export function ipNumber(value) {
    const ip = normalizeClientIp(value);
    if (!ip) throw Error('Invalid IP');
    const family = isIP(ip);
    return { ip, family, value: family === 4 ? new Address4(ip).bigInt() : new Address6(ip).bigInt() };
}
export function policyHash(data) {
    return createHash('sha256').update(JSON.stringify({ schemaVersion:data.schemaVersion, country:data.country, version:data.version, source:data.source, sourceSha256:data.sourceSha256, ipv4:data.ipv4, ipv6:data.ipv6 })).digest('hex');
}
export function validateCountryData(data) {
    if (data.schemaVersion !== 1 || data.country !== 'CN' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(data.version) || policyHash(data) !== data.sha256) throw Error('Invalid country manifest');
    const result = {};
    for (const [name,bits] of [['ipv4',32],['ipv6',128]]) {
        if (!Array.isArray(data[name]) || data[name].length > 500000) throw Error('Invalid range count');
        let previous = -1n;
        result[name] = data[name].map(pair => {
            if (!Array.isArray(pair) || pair.length !== 2 || pair.some(x => typeof x !== 'string' || !/^[0-9a-f]+$/.test(x))) throw Error('Invalid range encoding');
            const a=BigInt('0x'+pair[0]),b=BigInt('0x'+pair[1]);
            if (a <= previous || a > b || b >= (1n<<BigInt(bits))) throw Error('Unsorted or invalid ranges');
            previous=b;return [a,b];
        });
    }
    if (!result.ipv4.length || !result.ipv6.length) throw Error('Both address families required');
    return result;
}
export class MainlandCountryPolicy {
    constructor() { this.last = null; this.path = null; this.mtime = null; this.attemptedStamp = null; this.error = null; }
    refresh(path) {
        if (path !== this.path) { this.last=null;this.mtime=null;this.attemptedStamp=null;this.path=path; }
        try {
            const stat=fs.statSync(path);
            if (stat.size > 32*1024*1024) throw Error('Country file too large');
            const stamp=`${stat.mtimeMs}:${stat.size}:${stat.ino}`;
            if(this.attemptedStamp===stamp)return this.status();
            this.attemptedStamp=stamp;
            const data=JSON.parse(fs.readFileSync(path,'utf8'));const ranges=validateCountryData(data);
            this.last={data,ranges};this.mtime=stamp;
            this.error=null;
        } catch { this.error='country_policy_load_failed'; }
        return this.status();
    }
    status() { return { available:!!this.last, version:this.last?.data.version || null, sha256:this.last?.data.sha256 || null, generatedAt:this.last?.data.generatedAt || null, source:'DB-IP Country Lite', lastError:this.error }; }
    evaluate(ip) {
        const status=this.status();
        if (!status.available) return { allowed:false,status:503,code:'COUNTRY_POLICY_UNAVAILABLE',...status };
        let parsed;
        try { parsed=ipNumber(ip); } catch { return { allowed:false,status:403,code:'CLIENT_IP_UNVERIFIABLE',...status }; }
        if (blocked.check(parsed.ip,parsed.family===4?'ipv4':'ipv6')) return { allowed:false,status:403,code:'CLIENT_IP_UNVERIFIABLE',...status };
        const ranges=this.last.ranges[parsed.family===4?'ipv4':'ipv6'];let left=0,right=ranges.length-1;
        while (left<=right) { const mid=(left+right)>>1;const [a,b]=ranges[mid];if(parsed.value<a)right=mid-1;else if(parsed.value>b)left=mid+1;else return { allowed:true,status:200,code:'MAINLAND_CN',...status }; }
        return { allowed:false,status:403,code:'CLIENT_IP_NOT_MAINLAND',...status };
    }
}
const singleton=new MainlandCountryPolicy();const alibaba=new AlibabaAllowlist();let configured={};
export function configureMainlandPolicy(config) { configured=config;return getMainlandPolicyStatus(); }
export function mainlandRequired(config=configured) { return process.env.MAINLAND_CLIENT_KEYS_ONLY_REQUIRED==='true' || config.MAINLAND_CLIENT_KEYS_ONLY===true; }
function file(config=configured) { return process.env.MAINLAND_COUNTRY_FILE || config.MAINLAND_COUNTRY_FILE_PATH || 'configs/security/cn-ip-ranges.json'; }
function alibabaEnabled(config){return process.env.ALIBABA_ALLOWLIST_ENABLED==='true'||config.ALIBABA_ALLOWLIST_ENABLED===true;}
function alibabaFile(config){return process.env.ALIBABA_ALLOWLIST_FILE||config.ALIBABA_ALLOWLIST_FILE||'configs/security/alibaba-allowlist.json';}
export function getMainlandPolicyStatus(config=configured) {
    if(!mainlandRequired(config))return {enabled:false,available:true,sha256:null,version:null};
    return {enabled:true,...singleton.refresh(file(config)),alibabaAllowlist:alibabaEnabled(config)?alibaba.refresh(alibabaFile(config)):{enabled:false,available:true,sha256:null}};
}
export function evaluateMainlandPolicy(config,ip) {
    singleton.refresh(file(config));
    if(!publicIp(ip))return {...singleton.status(),allowed:false,status:403,code:'CLIENT_IP_UNVERIFIABLE'};
    let match=null;
    if(alibabaEnabled(config)){alibaba.refresh(alibabaFile(config));match=alibaba.match(ip);if(match?.code==='EXPLICIT_IP_ALLOWLIST')return {...singleton.status(),...match,allowed:true,status:200};}
    const decision=singleton.evaluate(ip);
    if(decision.allowed)return decision;
    if(match)return {...decision,...match,allowed:true,status:200};
    if(alibabaEnabled(config)&&!alibaba.status().available)return {...decision,allowed:false,status:503,code:'ALIBABA_ALLOWLIST_UNAVAILABLE'};
    return decision;
}
const poll=setInterval(()=>{if(mainlandRequired())getMainlandPolicyStatus();},1000);poll.unref?.();
