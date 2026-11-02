import { isIP } from 'node:net';
import { Address4, Address6 } from 'ip-address';
import { normalizeClientIp } from './client-network.js';

export function ipNumber(value) {
    const ip=normalizeClientIp(value);
    if(!ip)throw Error('Invalid IP');
    const family=isIP(ip);
    return {ip,family,value:family===4?new Address4(ip).bigInt():new Address6(ip).bigInt()};
}
const denied4=['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.0.0.0/24','192.0.2.0/24','192.168.0.0/16','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/3'];
const denied6=['2001:db8::/32','2001::/23','2002::/16','3fff::/20'];
function rawCidr(cidr) {
    if(typeof cidr!=='string'||!cidr.includes('/'))throw Error('Invalid CIDR');
    const [address,length,...extra]=cidr.split('/');const family=isIP(address);const bits=family===4?32:128;
    if(extra.length||!family||!/^\d+$/.test(length)||+length>bits)throw Error('Invalid CIDR');
    const value=family===4?new Address4(address).bigInt():new Address6(address).bigInt();
    const size=1n<<BigInt(bits-Number(length));const start=value/size*size;
    return {family,start,end:start+size-1n,value,bits:Number(length)};
}
const denied=[...denied4,...denied6].map(rawCidr);
export function publicRange(range) {
    if(range.family===6&&(range.start<0x20000000000000000000000000000000n||range.end>=0x40000000000000000000000000000000n))return false;
    return !denied.some(d=>d.family===range.family&&range.start<=d.end&&range.end>=d.start);
}
export function publicIp(value) {
    try {const p=ipNumber(value);return publicRange({family:p.family,start:p.value,end:p.value})?p:null;}catch{return null;}
}
export function publicCidr(cidr) {
    const p=rawCidr(cidr);
    if(p.value!==p.start||!publicRange(p))throw Error('CIDR is not canonical public address space');
    const address=p.family===4?Address4.fromBigInt(p.start).address:Address6.fromBigInt(p.start).correctForm();
    return {...p,cidr:`${address}/${p.bits}`};
}
