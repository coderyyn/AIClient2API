import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { publicCidr, publicIp } from './public-ip.js';

export const ALIBABA_ASNS=Object.freeze([37963,45102,134963]);
export const MAX_AGE_MS=72*60*60*1000;
export function manifestHash(data) {
    const {sha256,...payload}=data;
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
export function validateManifest(data) {
    if(data?.schemaVersion!==1||data.kind!=='alibaba-cloud'||manifestHash(data)!==data.sha256||
        JSON.stringify(data.asns)!==JSON.stringify(ALIBABA_ASNS)||!Number.isFinite(Date.parse(data.generatedAt))||
        !Array.isArray(data.sources)||data.sources.length!==3||!Array.isArray(data.explicitIps)||data.explicitIps.length>10000)throw Error('Invalid Alibaba manifest');
    const seen=new Set();const ranges=[];
    for(const s of data.sources){
        if(!ALIBABA_ASNS.includes(s.asn)||seen.has(s.asn)||s.source!==`https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS${s.asn}`||
            !Number.isFinite(Date.parse(s.queryEndTime))||!Array.isArray(s.prefixes)||!s.prefixes.length||s.prefixes.length>50000)throw Error('Invalid ASN source');
        seen.add(s.asn);
        const byFamily={4:[],6:[]};
        const prefixes=new Set();
        for(const prefix of s.prefixes){const p=publicCidr(prefix);if(p.cidr!==prefix||prefixes.has(prefix))throw Error('Duplicate or noncanonical prefix');prefixes.add(prefix);byFamily[p.family].push([p.start,p.end]);}
        for(const family of [4,6]){
            byFamily[family].sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);const merged=[];
            for(const pair of byFamily[family]){const last=merged.at(-1);if(last&&pair[0]<=last[1]+1n){if(pair[1]>last[1])last[1]=pair[1];}else merged.push([...pair]);}
            ranges.push({asn:s.asn,family,ranges:merged});
        }
    }
    const explicit=new Set();
    for(const ip of data.explicitIps){const p=publicIp(ip);if(!p||p.ip!==ip||explicit.has(ip))throw Error('Invalid explicit exception');explicit.add(ip);}
    return {ranges,explicit};
}
export class AlibabaAllowlist {
    constructor(){this.path=null;this.stamp=null;this.last=null;this.error=null;this.update={};}
    refresh(file){
        if(this.path!==file){this.path=file;this.last=null;this.stamp=null;this.error=null;this.update={};}
        try{
            const st=fs.statSync(file);if(st.size>16*1024*1024)throw Error('Too large');
            const stamp=`${st.mtimeMs}:${st.size}:${st.ino}`;
            if(stamp!==this.stamp){const data=JSON.parse(fs.readFileSync(file,'utf8'));const compiled=validateManifest(data);this.last={data,...compiled};this.stamp=stamp;}
            this.error=null;
        }catch{this.error='alibaba_allowlist_load_failed';}
        try{
            const st=fs.statSync(file+'.status.json');if(st.size>65536)throw Error('Too large');
            const update=JSON.parse(fs.readFileSync(file+'.status.json','utf8'));
            if(!update||typeof update!=='object'||Array.isArray(update)||
                (update.lastSuccessAt!=null&&(typeof update.lastSuccessAt!=='string'||!Number.isFinite(Date.parse(update.lastSuccessAt))))||
                (update.lastError!=null&&(typeof update.lastError!=='string'||!/^[a-z_]{1,80}$/.test(update.lastError))))throw Error('Invalid diagnostic status');
            this.update=update;
        }catch{this.update={};}
        return this.status();
    }
    status(){
        const d=this.last?.data;const dataTime=d?new Date(Math.min(...d.sources.map(s=>Date.parse(s.queryEndTime)))).toISOString():null;
        return {enabled:true,available:!!d,version:d?.generatedAt||null,sha256:d?.sha256||null,dataTime,generatedAt:d?.generatedAt||null,
            lastSuccessAt:this.update.lastSuccessAt||d?.generatedAt||null,lastUpdateError:this.update.lastError||null,lastError:this.error,
            stale:!!d&&(Date.now()-Date.parse(dataTime)>MAX_AGE_MS||Date.now()-Date.parse(this.update.lastSuccessAt||d.generatedAt)>MAX_AGE_MS),asns:ALIBABA_ASNS};
    }
    match(ip){
        const p=publicIp(ip);if(!p||!this.last)return null;
        if(this.last.explicit.has(p.ip))return {code:'EXPLICIT_IP_ALLOWLIST',allowlistSha256:this.last.data.sha256,asn:null};
        for(const group of this.last.ranges){
            if(group.family!==p.family)continue;
            let l=0,r=group.ranges.length-1;
            while(l<=r){const m=(l+r)>>1;const [a,b]=group.ranges[m];if(p.value<a)r=m-1;else if(p.value>b)l=m+1;else return {code:'ALIBABA_CLOUD_ALLOWLIST',asn:group.asn,allowlistSha256:this.last.data.sha256};}
        }
        return null;
    }
}
