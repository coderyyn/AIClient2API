import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {OpenAIApiService} from '/app/src/providers/openai/openai-core.js';
let retries=0,connects=0,aborted=0;const sockets=new Set();const children=[];
const upstream=https.createServer({key:fs.readFileSync('/fixtures/key.pem'),cert:fs.readFileSync('/fixtures/cert.pem'),ALPNProtocols:['http/1.1']},async(req,res)=>{
 for await(const _ of req){}
 if(req.url==='/retry' && ++retries===1){res.writeHead(500,{'content-type':'application/json'});res.end('{}');return;}
 if(req.url==='/stream' || req.url==='/abort'){
  res.writeHead(200,{'content-type':'text/event-stream'});let n=0;
  const timer=setInterval(()=>{res.write('data: synthetic\n\n');if(req.url==='/stream' && ++n===3){clearInterval(timer);res.end('data: [DONE]\n\n');}},50);
  res.once('close',()=>{clearInterval(timer);if(req.url==='/abort')aborted++;});return;
 }
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,protocol:req.socket.getProtocol()}));
});
const proxy=http.createServer();proxy.on('connect',(req,client,head)=>{
 connects++;const host=req.url.split(':')[0],port=Number(req.url.split(':')[1]);const target=net.connect(port,host);
 sockets.add(client);sockets.add(target);target.once('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)target.write(head);client.pipe(target);target.pipe(client);});
 client.on('error',()=>target.destroy());target.on('error',()=>client.destroy());client.once('close',()=>target.destroy());
});
const listen=(server,port)=>new Promise(r=>server.listen(port,'127.0.0.1',r));
async function sidecar(port,trusted){
 const env={...process.env,TLS_SIDECAR_PORT:String(port)};if(trusted)env.SSL_CERT_FILE='/fixtures/cert.pem';else delete env.SSL_CERT_FILE;
 const child=spawn('/app/tls-sidecar/tls-sidecar',[],{env,stdio:'ignore'});children.push(child);
 for(let i=0;i<40;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}
 throw Error('sidecar not ready');
}
async function call(path,proxyUrl=null,port=19090){return fetch(`http://127.0.0.1:${port}/`,{headers:{'X-Target-Url':'https://localhost:19443'+path,...(proxyUrl?{'X-Proxy-Url':proxyUrl}:{})}});}
try{
 await listen(upstream,19443);await listen(proxy,19444);await sidecar(19090,true);
 let response=await call('/plain');assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
 response=await call('/plain','http://127.0.0.1:19444');assert.equal(response.status,200);assert.equal((await response.json()).ok,true);assert(connects>0);
 response=await call('/stream','http://127.0.0.1:19444');assert((await response.text()).includes('[DONE]'));
 response=await call('/abort');const reader=response.body.getReader();await reader.read();await reader.cancel();
 for(let i=0;i<20&&!aborted;i++)await new Promise(r=>setTimeout(r,50));assert(aborted>0);
 const service=new OpenAIApiService({OPENAI_API_KEY:'synthetic',OPENAI_BASE_URL:'http://127.0.0.1:19090',REQUEST_MAX_RETRIES:1,REQUEST_BASE_DELAY:1,MODEL_PROVIDER:'openai-custom'});
 service.axiosInstance.defaults.proxy=false;service.axiosInstance.interceptors.request.use(config=>{config.headers['X-Target-Url']='https://localhost:19443/retry';return config;});
 assert.equal((await service.callApi('/retry',{})).ok,true);assert.equal(retries,2);
 await sidecar(19091,false);assert.equal((await call('/plain',null,19091)).status,502);
 console.log(JSON.stringify({status:'passed',network:'none; loopback mock only',scenarios:['verified-TLS-handshake','HTTP-CONNECT-proxy','SSE-through-proxy','client-abort-propagation','real-Axios-upstream-500-retry','untrusted-certificate-rejected'],connects,retries,aborted,paidCalls:0}));
}finally{
 for(const socket of sockets)socket.destroy();proxy.closeAllConnections();upstream.closeAllConnections();proxy.close();upstream.close();
 await Promise.all(children.map(async child=>{const exited=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),3000);await exited;clearTimeout(timer);}));
}
