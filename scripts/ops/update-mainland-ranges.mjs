import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ipNumber, policyHash, validateCountryData } from '../../src/utils/mainland-country-policy.js';

export function compileRanges(rows, metadata) {
    const groups={ipv4:[],ipv6:[]};
    for (const [start,end,country] of rows) {
        if (country!=='CN') continue;
        const a=ipNumber(start),b=ipNumber(end);
        if(a.family!==b.family || a.value>b.value) throw Error('Invalid source range');
        groups[a.family===4?'ipv4':'ipv6'].push([a.value,b.value]);
    }
    const data={schemaVersion:1,country:'CN',...metadata,ipv4:[],ipv6:[]};
    for(const name of ['ipv4','ipv6']) {
        groups[name].sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
        const merged=[];
        for(const pair of groups[name]) { const last=merged.at(-1);if(last&&pair[0]<=last[1]+1n){if(pair[1]>last[1])last[1]=pair[1];}else merged.push([...pair]); }
        data[name]=merged.map(pair=>pair.map(x=>x.toString(16)));
    }
    data.sha256=policyHash(data);validateCountryData(data);return data;
}

export async function activateRanges(file,data) {
    validateCountryData(data);
    await fs.mkdir(path.dirname(file),{recursive:true,mode:0o755});
    try { const old=JSON.parse(await fs.readFile(file,'utf8'));validateCountryData(old);if(old.version>data.version)throw Error('Refusing country data downgrade');await fs.writeFile(file+'.previous',JSON.stringify(old)+'\n',{mode:0o644}); }
    catch(error) { if(error.code!=='ENOENT') throw Error('Existing country data is invalid; inspect it before replacing'); }
    const temporary=file+'.'+process.pid+'.tmp';
    try { const handle=await fs.open(temporary,'wx',0o644);try {await handle.writeFile(JSON.stringify(data)+'\n');await handle.sync();}finally{await handle.close();}await fs.rename(temporary,file); }
    catch(error){await fs.unlink(temporary).catch(()=>{});throw error;}
}

async function main() {
    const args=Object.fromEntries(process.argv.slice(2).reduce((all,value,index,array)=>{if(value.startsWith('--'))all.push([value.slice(2),array[index+1]]);return all;},[]));
    const month=args.month || new Date().toISOString().slice(0,7);
    if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)||!args.output||!path.isAbsolute(args.output))throw Error('--output absolute-file [--month YYYY-MM] required');
    const source=`https://download.db-ip.com/free/dbip-country-lite-${month}.csv.gz`;
    const response=await fetch(source,{redirect:'error',signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw Error(`Country download failed: ${response.status}`);
    const hash=createHash('sha256');let compressed=0,decoded=0;
    const limit=new Transform({transform(chunk,_encoding,callback){compressed+=chunk.length;if(compressed>64*1024*1024)return callback(Error('Compressed data exceeds limit'));hash.update(chunk);callback(null,chunk);}});
    const plainLimit=new Transform({transform(chunk,_encoding,callback){decoded+=chunk.length;if(decoded>256*1024*1024)return callback(Error('Decoded data exceeds limit'));callback(null,chunk);}});
    const input=Readable.fromWeb(response.body);const unzip=createGunzip();
    // Forward pipeline errors into readline's source so incomplete downloads cannot activate.
    input.on('error',e=>plainLimit.destroy(e));limit.on('error',e=>plainLimit.destroy(e));unzip.on('error',e=>plainLimit.destroy(e));
    const lines=createInterface({input:input.pipe(limit).pipe(unzip).pipe(plainLimit),crlfDelay:Infinity});
    const rows=[];let total=0;
    for await(const line of lines){if(!line.trim())continue;const match=/^"?([^",]+)"?,"?([^",]+)"?,"?([A-Z0-9]{2})"?$/.exec(line);if(!match)throw Error('Invalid CSV row');total++;if(match[3]==='CN')rows.push(match.slice(1));}
    const data=compileRanges(rows,{version:month,source,sourceSha256:hash.digest('hex'),generatedAt:new Date().toISOString(),attribution:'IP Geolocation by DB-IP — https://db-ip.com'});
    if(total<10000||data.ipv4.length<100||data.ipv6.length<10)throw Error('Unexpectedly small dataset; refusing activation');
    await activateRanges(args.output,data);
    if(args['runtime-url']) {
        if(!args['edge-health-url'])throw Error('--edge-health-url is required with runtime verification');
        const edgeUrl=new URL(args['edge-health-url']);if(edgeUrl.hostname!=='127.0.0.1'||edgeUrl.protocol!=='http:')throw Error('Edge verification must use loopback HTTP');
        const url=new URL(args['runtime-url']);if(url.hostname!=='127.0.0.1'||url.protocol!=='http:')throw Error('Runtime verification must use loopback HTTP');
        let ready=false;
        for(let attempt=0;attempt<30;attempt++){try{const h=await fetch(url,{signal:AbortSignal.timeout(3000)}).then(r=>r.json());const workers=Object.values(h.mainlandPolicy?.workers||{});const edge=await fetch(edgeUrl,{signal:AbortSignal.timeout(3000)}).then(r=>r.json());if(workers.length===4&&workers.every(w=>w.available&&w.sha256===data.sha256)&&edge.mainlandPolicy?.sha256===data.sha256){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,1000));}
        if(!ready)throw Error('Data activated but workers did not converge; inspect before continuing');
    }
    console.log(JSON.stringify({version:data.version,sha256:data.sha256,sourceSha256:data.sourceSha256,ipv4Ranges:data.ipv4.length,ipv6Ranges:data.ipv6.length,output:args.output}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
