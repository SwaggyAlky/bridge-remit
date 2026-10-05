/* global ethers */
const button=document.getElementById('deploy-contracts'),output=document.getElementById('deploy-progress'),download=document.getElementById('download');
let result,link;
function save(){if(link)URL.revokeObjectURL(link);link=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));download.href=link;download.classList.remove('hidden');download.textContent=result.complete?'下载完整公共部署配置':'下载当前进度（尚未完成）';}
button.addEventListener('click',async()=>{button.disabled=true;result={addresses:{},abi:{},deploymentGas:{},deploymentTransactions:{},corridorTransactions:{},chainId:11155111,complete:false};const lines=[];const log=s=>{lines.push(s);output.textContent=lines.join('\n\n');};try{
 if(!window.ethereum)throw Error('请用安装 MetaMask 的浏览器打开此页面。');
 const provider=new ethers.BrowserProvider(window.ethereum);await provider.send('eth_requestAccounts',[]);
 if((await provider.getNetwork()).chainId!==11155111n)throw Error('请先在 MetaMask 切换到 Sepolia，再重新开始。');
 const signer=await provider.getSigner();const admin=await signer.getAddress();result.admin=admin;
 const r=await fetch('/api/deploy-artifacts');if(!r.ok)throw Error('无法读取编译产物');const artifacts=await r.json();
 const deployOne=async(name,args=[])=>{if((await provider.getNetwork()).chainId!==11155111n||(await signer.getAddress())!==admin)throw Error('网络或账户已改变，已停止');const a=artifacts[name];const factory=new ethers.ContractFactory(a.abi,a.bytecode,signer);const pending=await factory.getDeployTransaction(...args);const gas=await signer.estimateGas(pending);log(`${name}：预计 ${gas} gas，请在钱包核对并签名。`);const c=await factory.deploy(...args);log(`等待确认 ${c.deploymentTransaction().hash}`);const receipt=await c.deploymentTransaction().wait(2);result.addresses[name]=await c.getAddress();result.abi[name]=a.abi;result.deploymentGas[name]=receipt.gasUsed.toString();result.deploymentTransactions[name]=receipt.hash;save();log(`${name} 部署完成：${await c.getAddress()}`);return c;};
 const registry=await deployOne('ParticipantRegistry');await deployOne('DemoUSD',[await registry.getAddress()]);const book=await deployOne('CorridorBook',[await registry.getAddress()]);await deployOne('RemittanceEscrow',[result.addresses.ParticipantRegistry,result.addresses.DemoUSD,result.addresses.CorridorBook]);
 for(const [route,rate]of [['SG-PH',56500000],['SG-IN',83500000],['SG-BD',120000000]]){log(`配置 ${route}，参考汇率 ${rate/1e6}，费率 50 基点。请钱包签名。`);const tx=await book.setCorridor(ethers.id(route),rate,50,true);await tx.wait(2);result.corridorTransactions[route]=tx.hash;save();}
 result.startBlock=await provider.getBlockNumber();result.createdAt=new Date().toISOString();result.complete=true;save();log('七笔交易已确认。请下载完整配置并提交到 GitHub 仓库根目录，重新部署 Render 后验证实际汇款流程。');
}catch(e){if(Object.keys(result.addresses).length)save();log('部署停止：'+(e.shortMessage||e.message));}finally{button.disabled=false;}});
