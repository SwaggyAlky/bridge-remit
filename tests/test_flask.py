import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from eth_account import Account
from eth_account.messages import encode_defunct
from web3 import Web3
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import create_app, Store

class FlaskIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory()
        cls.d=json.loads(Path('data/flask-fixture.json').read_text())
        cls.w3=Web3(Web3.HTTPProvider('http://127.0.0.1:18546'))
        cls.wallets=list(cls.d['accounts'])
        cls.registry=cls.w3.eth.contract(address=cls.d['addresses']['ParticipantRegistry'],abi=cls.d['abi']['ParticipantRegistry'])
        for i in (1,2,3):
            cls.tx(cls.registry.functions.setRole(cls.checksum(i),2 if i==3 else 1),0)
            cls.tx(cls.registry.functions.setApproval(cls.checksum(i),True),0)
        cls.settings={'SQLITE_PATH':str(Path(cls.temp.name)/'test.sqlite'),'DEPLOYMENT_FILE':'data/flask-fixture.json','RPC_URL':'http://127.0.0.1:18546','APP_ORIGIN':'http://localhost:3000','APP_ENV':'development','DATABASE_URL':''}
        cls.app=create_app(cls.settings)

    @classmethod
    def checksum(cls,i):return Web3.to_checksum_address(cls.wallets[i])
    @classmethod
    def tx(cls,fn,i):
        h=fn.transact({'from':cls.checksum(i),'gas':4000000});r=cls.w3.eth.wait_for_transaction_receipt(h);assert r.status==1;return Web3.to_hex(h)
    def post(self,c,path,data,origin='http://localhost:3000'):
        return c.post(path,json=data,headers={'Origin':origin})
    def setUp(self):
        self.app=create_app(self.settings)
    def login(self,i):
        c=self.app.test_client();challenge=self.post(c,'/api/auth/challenge',{'address':self.wallets[i]}).json
        sig=Account.sign_message(encode_defunct(text=challenge['message']),private_key=self.d['accounts'][self.wallets[i]]['secretKey']).signature
        response=self.post(c,'/api/auth/verify',{'address':self.wallets[i],'signature':Web3.to_hex(sig)})
        self.assertEqual(response.status_code,200)
        return c

    def test_health_static_and_artifacts(self):
        c=self.app.test_client();self.assertEqual(c.get('/health').json['backend'],'flask');self.assertTrue(c.get('/api/config').json['ready'])
        self.assertEqual(len(c.get('/api/deploy-artifacts').json),4)
        with c.get('/') as page:self.assertIn(b'lang="en"',page.data)
        self.assertEqual(c.get('/../app.py').status_code,404)
        with c.get('/') as page:self.assertIn('frame-ancestors',page.headers['Content-Security-Policy'])

    def test_end_to_end_transfer_snapshot_and_audit(self):
        c=self.login(1);recipient=self.login(2)
        token=self.w3.eth.contract(address=self.d['addresses']['DemoUSD'],abi=self.d['abi']['DemoUSD'])
        escrow=self.w3.eth.contract(address=self.d['addresses']['RemittanceEscrow'],abi=self.d['abi']['RemittanceEscrow'])
        book=self.w3.eth.contract(address=self.d['addresses']['CorridorBook'],abi=self.d['abi']['CorridorBook'])
        self.tx(token.functions.faucet(),1);self.tx(token.functions.approve(escrow.address,100000000),1)
        draft=self.post(c,'/api/invoices',{'recipient':self.wallets[2],'amount':'10','memo':'Integration transfer'}).json
        route=Web3.keccak(text='SG-PH');fee,destination,_=book.functions.quote(route,10000000).call()
        h=self.tx(escrow.functions.create(self.checksum(2),10000000,route,bytes.fromhex(draft['referenceHash'][2:]),self.w3.eth.get_block('latest')['timestamp']+86400,destination,fee),1)
        self.assertEqual(self.post(c,'/api/receipts',{'hash':h}).status_code,200)
        snapshot=c.get('/api/snapshot').json;self.assertEqual(snapshot['items'][0]['status'],'Pending');identifier=snapshot['items'][0]['id']
        h=self.tx(escrow.functions.claim(identifier),2);self.assertEqual(self.post(recipient,'/api/receipts',{'hash':h}).status_code,200)
        self.assertEqual(c.get('/api/snapshot').json['items'][0]['status'],'Completed')
        self.assertEqual(recipient.get('/api/snapshot').json['balance'],'9.95')
        self.assertTrue(any(r['tx']==h for r in self.login(3).get('/api/audit').json))

    def test_origin_anonymous_and_input_guards(self):
        c=self.app.test_client();self.assertEqual(c.get('/api/snapshot').status_code,401)
        self.assertEqual(self.post(c,'/api/auth/challenge',{'address':self.wallets[1]},'https://evil.example').status_code,403)
        self.assertEqual(self.post(c,'/api/auth/challenge',{'address':'bad'}).status_code,400)
        self.assertEqual(self.post(c,'/api/auth/challenge',[]).status_code,400)
        self.assertEqual(c.post('/api/auth/challenge',data='x',headers={'Origin':'http://localhost:3000','Content-Type':'text/plain'}).status_code,415)
        self.assertEqual(self.post(c,'/api/auth/challenge',{'x':'a'*17000}).status_code,413)

    def test_signature_replay_and_forgery(self):
        c=self.app.test_client();who=self.wallets[4];challenge=self.post(c,'/api/auth/challenge',{'address':who}).json
        payload={'address':who,'signature':'0x1234'};self.assertEqual(self.post(c,'/api/auth/verify',payload).status_code,401)
        payload['signature']=Web3.to_hex(Account.sign_message(encode_defunct(text=challenge['message']),private_key=self.d['accounts'][who]['secretKey']).signature)
        response=self.post(c,'/api/auth/verify',payload);self.assertEqual(response.status_code,200)
        self.assertIn('HttpOnly',response.headers['Set-Cookie']);self.assertIn('SameSite=Strict',response.headers['Set-Cookie'])
        self.assertEqual(self.post(c,'/api/auth/verify',payload).status_code,401)

    def test_snapshot_and_roles(self):
        c=self.login(1);x=c.get('/api/snapshot').json;self.assertEqual(x['role'],1);self.assertTrue(x['approved']);self.assertEqual(len(x['corridors']),3)
        self.assertEqual(c.get('/api/snapshot?offset=-1').status_code,400)
        self.assertEqual(c.get('/api/audit').status_code,403);self.assertEqual(self.login(3).get('/api/audit').status_code,200)

    def test_invoice_isolation_and_restart_persistence(self):
        c=self.login(1);other=self.login(2)
        r=self.post(c,'/api/invoices',{'recipient':self.wallets[2],'amount':'200','memo':'Persistent supplier invoice'})
        self.assertEqual(r.status_code,201);self.assertEqual(r.json['referenceHash'],Web3.to_hex(Web3.keccak(text=r.json['id'])))
        self.assertFalse(any(x['id']==r.json['id'] for x in other.get('/api/invoices').json))
        restarted=create_app(self.settings).test_client()
        restarted.set_cookie('remit_session',c.get_cookie('remit_session').value)
        self.assertTrue(any(x['id']==r.json['id'] for x in restarted.get('/api/invoices').json))
        self.assertEqual(self.post(c,'/api/invoices',{'recipient':self.wallets[2],'amount':'NaN','memo':'bad'}).status_code,400)
        self.assertEqual(self.post(self.login(3),'/api/invoices',{'recipient':self.wallets[2],'amount':'200','memo':''}).status_code,403)

    def test_receipts_ownership_and_forwarding(self):
        c=self.login(1);other=self.login(2)
        token=self.w3.eth.contract(address=self.d['addresses']['DemoUSD'],abi=self.d['abi']['DemoUSD'])
        h=self.tx(token.functions.approve(self.d['addresses']['RemittanceEscrow'],100000000),1)
        self.assertEqual(self.post(other,'/api/receipts',{'hash':h}).status_code,400)
        self.assertEqual(self.post(c,'/api/receipts',{'hash':h}).status_code,200)
        self.assertEqual(self.post(c,'/api/receipts',{'hash':h.upper().replace('0X','0x')}).status_code,200)
        relay=self.w3.eth.contract(address=self.d['relay']['address'],abi=self.d['relay']['abi'])
        h=self.tx(relay.functions.forward(token.address,bytes.fromhex(token.functions.approve(self.checksum(2),1)._encode_transaction_data()[2:])),1)
        self.assertEqual(self.post(c,'/api/receipts',{'hash':h}).status_code,200)
        h=self.w3.eth.send_transaction({'from':self.checksum(1),'to':self.checksum(2),'value':1});self.w3.eth.wait_for_transaction_receipt(h)
        self.assertEqual(self.post(c,'/api/receipts',{'hash':Web3.to_hex(h)}).status_code,400)

    def test_logout(self):
        c=self.login(2);self.assertEqual(self.post(c,'/api/auth/logout',{}).status_code,200);self.assertEqual(c.get('/api/invoices').status_code,401)

    def test_production_requires_database(self):
        with self.assertRaisesRegex(RuntimeError,'DATABASE_URL'):Store(production=True)

    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()

if __name__=='__main__':unittest.main()
