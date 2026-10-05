import fs from 'node:fs';
import { ethers } from 'ethers';
export async function deploy(signer) {
  const result={addresses:{},abi:{},deploymentGas:{},deploymentTransactions:{}};
  const deployOne = async(name,args=[])=>{const a=JSON.parse(fs.readFileSync(`artifacts/${name}.json`));const c=await new ethers.ContractFactory(a.abi,a.bytecode,signer).deploy(...args);const receipt=await c.deploymentTransaction().wait();result.addresses[name]=await c.getAddress();result.abi[name]=a.abi;result.deploymentGas[name]=receipt.gasUsed.toString();result.deploymentTransactions[name]=receipt.hash;return c;};
  const r=await deployOne('ParticipantRegistry'); const t=await deployOne('DemoUSD',[await r.getAddress()]);const b=await deployOne('CorridorBook',[await r.getAddress()]);const e=await deployOne('RemittanceEscrow',[await r.getAddress(),await t.getAddress(),await b.getAddress()]);
  for(const [route,rate] of [['SG-PH',56500000],['SG-IN',83500000],['SG-BD',120000000]]) await (await b.setCorridor(ethers.id(route),rate,50,true)).wait();
  result.chainId=Number((await signer.provider.getNetwork()).chainId); result.startBlock=await signer.provider.getBlockNumber();result.admin=await signer.getAddress();result.createdAt=new Date().toISOString();
  return result;
}
if(process.argv[1]?.endsWith('deploy.mjs')) {
  const sepolia=process.argv.includes('--sepolia');
  const provider=new ethers.JsonRpcProvider(process.env.RPC_URL || (sepolia ? undefined : 'http://127.0.0.1:8545'));
  if(sepolia && (!process.env.RPC_URL || !process.env.DEPLOYER_PRIVATE_KEY)) throw Error('Set RPC_URL and DEPLOYER_PRIVATE_KEY locally, never in chat or Render.');
  if(sepolia && (await provider.getNetwork()).chainId!==11155111n) throw Error('Sepolia network required');
  if(!sepolia) provider.pollingInterval=100;
  const signer=sepolia?new ethers.NonceManager(new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY,provider)):await provider.getSigner(0);
  const d=await deploy(signer);fs.writeFileSync(sepolia?'deployment.sepolia.json':'deployment.local.json',JSON.stringify(d,null,2));console.log(JSON.stringify({chainId:d.chainId,addresses:d.addresses},null,2));
}
