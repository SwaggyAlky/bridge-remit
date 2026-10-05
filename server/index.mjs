import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { ethers } from 'ethers';
import { openStore } from './store.mjs';
const db=await openStore();const production=process.env.NODE_ENV==='production';
const port=Number(process.env.PORT||3000);const origin=process.env.APP_ORIGIN||`http://localhost:${port}`;
if(production && !origin.startsWith('https://')) throw Error('Set APP_ORIGIN to your HTTPS Render URL');
const file=process.env.DEPLOYMENT_FILE||'deployment.sepolia.json';
let deployment=null;if(fs.existsSync(file)) deployment=JSON.parse(fs.readFileSync(file,'utf8'));
if(deployment){
  const required=['ParticipantRegistry','DemoUSD','CorridorBook','RemittanceEscrow'];
  if(deployment.complete===false||!required.every(n=>ethers.isAddress(deployment.addresses?.[n])&&Array.isArray(deployment.abi?.[n])&&deployment.abi[n].length))throw Error('Incomplete deployment configuration; finish all four contracts and corridor setup first');
  if(!Number.isSafeInteger(deployment.chainId)||(production&&deployment.chainId!==11155111))throw Error('Production deployment must use Sepolia');
}
const provider=deployment&&process.env.RPC_URL?new ethers.JsonRpcProvider(process.env.RPC_URL,undefined,{cacheTimeout:0}):null;
const contracts={};if(deployment)for(const name of Object.keys(deployment.addresses))contracts[name]=new ethers.Contract(deployment.addresses[name],deployment.abi[name],provider);
if(provider){const network=await provider.getNetwork();if(Number(network.chainId)!==deployment.chainId)throw Error('RPC and deployment chain mismatch');for(const addr of Object.values(deployment.addresses))if(await provider.getCode(addr)==='0x')throw Error('Deployment has no contract bytecode');}
const sha=s=>createHash('sha256').update(s).digest('hex');const rates=new Map();
const err=(status,message)=>Object.assign(new Error(message),{status});
const address=a=>{if(typeof a!=='string'||!ethers.isAddress(a))throw err(400,'Invalid wallet address');return a.toLowerCase();};
const ensureChain=()=>{if(!provider)throw err(503,'Contracts not configured. Complete the wallet deployment setup.');};
async function roleFor(a){ensureChain();return Number(await contracts.ParticipantRegistry.roles(a));}
async function identity(req){const match=(req.headers.cookie||'').match(/(?:^|;\s*)remit_session=([a-f0-9]{64})(?:;|$)/);if(!match)throw err(401,'Connect and sign in with your wallet');const rows=await db.query('SELECT address FROM sessions WHERE hash=$1 AND expires>$2',[sha(match[1]),Date.now()]);if(!rows.length)throw err(401,'Session expired');return rows[0].address;}
async function body(req){let s='';for await(const c of req){s+=c;if(Buffer.byteLength(s)>16384)throw err(413,'Request too large');}try{return JSON.parse(s||'{}');}catch{throw err(400,'Invalid JSON');}}
function limit(req,category,max){const ip=req.socket.remoteAddress;const key=ip+category;const now=Date.now();let a=rates.get(key);if(!a||a.until<now){a={count:0,until:now+60000};rates.set(key,a);}if(++a.count>max)throw err(429,'Too many requests; retry in one minute');if(rates.size>10000)for(const [k,v]of rates)if(v.until<now)rates.delete(k);}
const statusNames=['Pending','Completed','Cancelled','Refunded','Disputed'];
async function snapshot(who,offset=0){
  const {ParticipantRegistry:r,DemoUSD:t,CorridorBook:b,RemittanceEscrow:e}=contracts;
  const role=Number(await r.roles(who));const last=Number(await e.nextId())-1;const items=[];
  const start=Math.max(0,last-offset);const stop=Math.max(0,start-100);
  for(let id=start;id>stop;id--){const x=await e.remittances(id);if([2,4].includes(role)||x.sender.toLowerCase()===who||x.recipient.toLowerCase()===who||role===3){items.push({id,sender:x.sender,recipient:x.recipient,amount:ethers.formatUnits(x.amount,6),fee:ethers.formatUnits(x.fee,6),destination:ethers.formatUnits(x.destination,6),rate:ethers.formatUnits(x.rate,6),corridor:x.corridor,reference:x.referenceHash,deadline:Number(x.deadline),status:statusNames[Number(x.status)],attestation:x.attestation});}}
  const corridors=[];for(const [id,currency]of [['SG-PH','PHP'],['SG-IN','INR'],['SG-BD','BDT']]){const x=await b.corridors(ethers.id(id));corridors.push({id,currency,rate:ethers.formatUnits(x.rate,6),feeBps:Number(x.feeBps),active:x.active});}
  return {wallet:who,role,approved:await r.approved(who),balance:ethers.formatUnits(await t.balanceOf(who),6),allowance:ethers.formatUnits(await t.allowance(who,deployment.addresses.RemittanceEscrow),6),paused:await e.paused(),fees:ethers.formatUnits(await e.earnedFees(),6),items,corridors,nextOffset:stop>0?offset+100:null,total:last,block:await provider.getBlockNumber()};
}
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  try{
    const url=new URL(req.url,origin);const p=url.pathname;
    if(p.startsWith('/api/')||p==='/health'){
      limit(req,'api',180);
      if(req.method==='POST') {if(req.headers.origin!==origin)throw err(403,'Origin mismatch');if(!(req.headers['content-type']||'').startsWith('application/json'))throw err(415,'JSON required');}
      if(p==='/health'&&req.method==='GET'){await db.query('SELECT 1');return json(200,{status:'ok',database:process.env.DATABASE_URL?'postgres':'sqlite',chainConfigured:!!provider});}
      if(p==='/api/deploy-artifacts'&&req.method==='GET'){const data={};for(const name of ['ParticipantRegistry','DemoUSD','CorridorBook','RemittanceEscrow'])data[name]=JSON.parse(fs.readFileSync(`artifacts/${name}.json`));return json(200,data);}
      if(p==='/api/config'&&req.method==='GET')return json(200,{deployment,ready:!!provider,mode:'testnet',routes:[{id:'SG-PH',currency:'PHP',rate:56.5},{id:'SG-IN',currency:'INR',rate:83.5},{id:'SG-BD',currency:'BDT',rate:120}],notice:'Test assets only. Indicative FX, simulated KYC and off-ramp. Not real money transfer.'});
      if(p==='/api/auth/challenge'&&req.method==='POST'){
        limit(req,'challenge',10);ensureChain();const a=address((await body(req)).address);const nonce=randomBytes(20).toString('hex');const expires=Date.now()+300000;
        const message=`BridgeRemit wallet sign-in\nOrigin: ${origin}\nWallet: ${a}\nChain ID: ${deployment.chainId}\nNonce: ${nonce}\nExpires: ${new Date(expires).toISOString()}\nThis signature signs you in. It does not transfer funds.`;
        await db.query('INSERT INTO challenges(address,nonce,message,expires) VALUES($1,$2,$3,$4) ON CONFLICT(address) DO UPDATE SET nonce=excluded.nonce,message=excluded.message,expires=excluded.expires',[a,nonce,message,expires]);
        return json(200,{message});
      }
      if(p==='/api/auth/verify'&&req.method==='POST'){
        limit(req,'verify',15);const input=await body(req);const a=address(input.address);const [c]=await db.query('SELECT * FROM challenges WHERE address=$1 AND expires>$2',[a,Date.now()]);if(!c)throw err(401,'Challenge expired');
        let recovered;try{recovered=ethers.verifyMessage(c.message,input.signature).toLowerCase();}catch{throw err(401,'Invalid signature');}if(recovered!==a)throw err(401,'Invalid signature');
        const used=await db.query('DELETE FROM challenges WHERE address=$1 AND nonce=$2 AND expires>$3 RETURNING address',[a,c.nonce,Date.now()]);if(!used.length)throw err(401,'Challenge already used');
        const session=randomBytes(32).toString('hex');await db.query('INSERT INTO sessions(hash,address,expires) VALUES($1,$2,$3)',[sha(session),a,Date.now()+3600000]);
        res.setHeader('Set-Cookie',`remit_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${production?'; Secure':''}`);return json(200,{wallet:a,role:await roleFor(a)});
      }
      if(p==='/api/auth/logout'&&req.method==='POST'){const m=(req.headers.cookie||'').match(/remit_session=([a-f0-9]{64})/);if(m)await db.query('DELETE FROM sessions WHERE hash=$1',[sha(m[1])]);res.setHeader('Set-Cookie','remit_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return json(200,{ok:true});}
      const who=await identity(req);
      if(p==='/api/snapshot'&&req.method==='GET'){ensureChain();const offset=Number(url.searchParams.get('offset')||0);if(!Number.isSafeInteger(offset)||offset<0)throw err(400,'Invalid offset');return json(200,await snapshot(who,offset));}
      if(p==='/api/invoices'&&req.method==='GET')return json(200,await db.query('SELECT * FROM invoices WHERE owner=$1 ORDER BY created DESC LIMIT 100',[who]));
      if(p==='/api/invoices'&&req.method==='POST'){
        if(await roleFor(who)!==1||!await contracts.ParticipantRegistry.approved(who))throw err(403,'Approved customer only');
        const x=await body(req);const to=address(x.recipient);if(typeof x.memo!=='string'||x.memo.length>200||typeof x.amount!=='string'||!/^\d{1,6}(\.\d{1,6})?$/.test(x.amount)||Number(x.amount)<1||Number(x.amount)>100000)throw err(400,'Invalid invoice');
        const id=db.uuid();await db.query('INSERT INTO invoices(id,owner,recipient,memo,amount,created) VALUES($1,$2,$3,$4,$5,$6)',[id,who,to,x.memo,x.amount,Date.now()]);return json(201,{id,referenceHash:ethers.id(id)});
      }
      if(p==='/api/receipts'&&req.method==='POST'){
        ensureChain();const x=await body(req);if(typeof x.hash!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(x.hash))throw err(400,'Invalid transaction hash');
        const receipt=await provider.getTransactionReceipt(x.hash);const tx=await provider.getTransaction(x.hash);
        if(!receipt||receipt.status!==1||!tx||tx.from.toLowerCase()!==who||!Object.values(deployment.addresses).some(a=>a.toLowerCase()===tx.to?.toLowerCase()))throw err(400,'Not a successful transaction from your wallet to this deployment');
        const head=await provider.getBlockNumber();if(head-receipt.blockNumber+1<(deployment.chainId===1337?1:2))throw err(409,'Waiting for confirmations; refresh later');
        await db.query('INSERT INTO receipts(id,owner,tx,chain,block,gas,created) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tx) DO NOTHING',[db.uuid(),who,x.hash,deployment.chainId,receipt.blockNumber,receipt.gasUsed.toString(),Date.now()]);return json(200,{ok:true,gasUsed:receipt.gasUsed.toString()});
      }
      if(p==='/api/audit'&&req.method==='GET'){
        if(![2,4].includes(await roleFor(who)))throw err(403,'Auditor or admin only');return json(200,await db.query('SELECT tx,owner,chain,block,gas,created FROM receipts ORDER BY created DESC LIMIT 200'));
      }
      throw err(404,'Endpoint not found');
    }
    if(req.method!=='GET')throw err(405,'Method not allowed');
    const relative=p==='/'?'index.html':decodeURIComponent(p).slice(1);const root=path.resolve('public');const target=path.resolve(root,relative);
    if(!target.startsWith(root+path.sep)||!fs.existsSync(target)||!fs.statSync(target).isFile())throw err(404,'Not found');
    const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json'};res.writeHead(200,{'Content-Type':types[path.extname(target)]||'application/octet-stream'});fs.createReadStream(target).pipe(res);
  }catch(e){const code=e.status||503;if(code===503)console.error('Request failed:',e.shortMessage||e.message);json(code,{error:e.status?e.message:'Service unavailable. Check chain connection and retry.'});}
});
server.listen(port,'0.0.0.0',()=>console.log(`BridgeRemit listening on ${port}; ${provider?'chain connected':'deployment setup required'}`));
let cleaning=false;const cleanup=setInterval(async()=>{if(cleaning)return;cleaning=true;try{await db.query('DELETE FROM challenges WHERE expires<$1',[Date.now()]);await db.query('DELETE FROM sessions WHERE expires<$1',[Date.now()]);}catch(e){console.error('Session cleanup failed');}finally{cleaning=false;}},60000);cleanup.unref();
export {server,db};
