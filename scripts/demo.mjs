import ganache from 'ganache';
import fs from 'node:fs';
import { ethers } from 'ethers';
import { deploy } from './deploy.mjs';
const chain=ganache.server({chain:{chainId:1337,hardfork:'shanghai'},wallet:{totalAccounts:8},logging:{quiet:true}});
await chain.listen(8545,'127.0.0.1');
const provider=new ethers.JsonRpcProvider('http://127.0.0.1:8545',undefined,{cacheTimeout:0});provider.pollingInterval=100;const admin=await provider.getSigner(0);const d=await deploy(admin);
const r=new ethers.Contract(d.addresses.ParticipantRegistry,d.abi.ParticipantRegistry,admin);
const t=new ethers.Contract(d.addresses.DemoUSD,d.abi.DemoUSD,admin);
for(let i=1;i<=4;i++){const who=await provider.getSigner(i);const address=await who.getAddress();await(await r.setRole(address,i<=2?1:i===3?2:3)).wait();await(await r.setApproval(address,true)).wait();if(i<=2) await(await t.connect(who).faucet()).wait();}
fs.writeFileSync('deployment.local.json',JSON.stringify(d,null,2));
console.log('Local demo chain only. Wallet import keys below are ephemeral test keys; never fund them with real money.');
const accounts=chain.provider.getInitialAccounts();for(const [i,[address,a]] of Object.entries(accounts).entries())console.log(['Admin','Sender','Recipient','Auditor','Agent'][i]||'Test',address,a.secretKey);
process.env.RPC_URL='http://127.0.0.1:8545';process.env.CHAIN_ID='1337';process.env.DEPLOYMENT_FILE='deployment.local.json';
await import('../server/index.mjs');
