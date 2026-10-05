import fs from 'node:fs';
import assert from 'node:assert/strict';
import {ethers} from 'ethers';
const d=JSON.parse(fs.readFileSync('deployment.sepolia.json','utf8'));
assert.equal(d.complete,true);assert.equal(d.chainId,11155111);
assert.deepEqual(Object.keys(d).sort(),['abi','addresses','admin','chainId','complete','corridorTransactions','createdAt','deploymentGas','deploymentTransactions','startBlock'].sort());
const p=new ethers.JsonRpcProvider(process.env.RPC_URL||'https://ethereum-sepolia-rpc.publicnode.com');
assert.equal(Number((await p.getNetwork()).chainId),11155111);
const contracts={};const evidence={verifiedAt:new Date().toISOString(),chainId:d.chainId,admin:d.admin,contracts:{},corridors:{}};
for(const [name,address] of Object.entries(d.addresses)){
 const a=JSON.parse(fs.readFileSync('artifacts/'+name+'.json','utf8'));
 assert.deepEqual(d.abi[name],a.abi);
 const r=await p.getTransactionReceipt(d.deploymentTransactions[name]);
 assert.equal(r.status,1);assert.equal(r.contractAddress.toLowerCase(),address.toLowerCase());assert.equal(r.from.toLowerCase(),d.admin.toLowerCase());
 const tx=await p.getTransaction(r.hash);assert.ok(tx.data.startsWith(a.bytecode),'Creation bytecode matches authored contract');
 const code=await p.getCode(address);assert.equal((code.length-2)/2,a.runtimeBytes);
 contracts[name]=new ethers.Contract(address,a.abi,p);
 evidence.contracts[name]={address,transaction:r.hash,block:r.blockNumber,gasUsed:r.gasUsed.toString(),runtimeBytes:a.runtimeBytes};
 console.log(name,'verified at',address);
}
const same=(a,b)=>assert.equal(a.toLowerCase(),b.toLowerCase());
same(await contracts.ParticipantRegistry.admin(),d.admin);
assert.equal(await contracts.ParticipantRegistry.roles(d.admin),4n);
assert.equal(await contracts.ParticipantRegistry.approved(d.admin),true);
for(const n of ['DemoUSD','CorridorBook','RemittanceEscrow'])same(await contracts[n].registry(),d.addresses.ParticipantRegistry);
same(await contracts.RemittanceEscrow.token(),d.addresses.DemoUSD);
same(await contracts.RemittanceEscrow.book(),d.addresses.CorridorBook);
for(const [route,rate]of [['SG-PH',56500000n],['SG-IN',83500000n],['SG-BD',120000000n]]){
 const receipt=await p.getTransactionReceipt(d.corridorTransactions[route]);assert.equal(receipt.status,1);same(receipt.from,d.admin);
 const event=receipt.logs.filter(l=>l.address.toLowerCase()===d.addresses.CorridorBook.toLowerCase()).map(l=>contracts.CorridorBook.interface.parseLog(l)).find(l=>l?.name==='CorridorUpdated'&&l.args[0]===ethers.id(route));
 assert.ok(event,'Expected corridor event from the configured contract');assert.equal(event.args[1],rate);assert.equal(event.args[2],50n);assert.equal(event.args[3],true);
 const c=await contracts.CorridorBook.corridors(ethers.id(route));assert.equal(c.rate,rate);assert.equal(c.feeBps,50n);assert.equal(c.active,true);
 evidence.corridors[route]={rate:Number(c.rate)/1e6,feeBps:Number(c.feeBps),active:c.active,transaction:receipt.hash,block:receipt.blockNumber};
 console.log(route,'verified');
}
evidence.transferCount=(await contracts.RemittanceEscrow.nextId()-1n).toString();
fs.writeFileSync('docs/SEPOLIA_VERIFICATION.json',JSON.stringify(evidence,null,2)+'\n');
console.log('Seven successful transactions, contract links and corridor configuration verified. Transfers:',evidence.transferCount);
await p.destroy();
