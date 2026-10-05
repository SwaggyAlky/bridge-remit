import fs from 'node:fs';
import solc from 'solc';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
fs.mkdirSync('artifacts', {recursive:true}); fs.mkdirSync('abi', {recursive:true}); fs.mkdirSync('public/vendor', {recursive:true});
const source = fs.readFileSync('contracts/BridgeRemit.sol','utf8');
const input = {language:'Solidity',sources:{'BridgeRemit.sol':{content:source}},settings:{optimizer:{enabled:true,runs:200},evmVersion:'shanghai',viaIR:true,outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
for(const e of output.errors || []) { console.log(e.formattedMessage); if(e.severity==='error') process.exitCode=1; }
if(process.exitCode) process.exit(1);
for(const [name,c] of Object.entries(output.contracts['BridgeRemit.sol'])) {
  fs.writeFileSync(`abi/${name}.json`, JSON.stringify(c.abi,null,2));
  fs.writeFileSync(`artifacts/${name}.json`, JSON.stringify({abi:c.abi,bytecode:'0x'+c.evm.bytecode.object,runtimeBytes:c.evm.deployedBytecode.object.length/2},null,2));
}
fs.copyFileSync(require.resolve('ethers').replace(/lib.commonjs[\\/]index.js$/, 'dist/ethers.umd.min.js'), 'public/vendor/ethers.js');
console.log('Built four contracts and local browser library.');
