"""Flask REST backend. Wallets sign transactions; this server holds no wallet keys."""
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from decimal import Decimal

from flask import Flask, jsonify, request, send_from_directory
from werkzeug.exceptions import HTTPException
from eth_account import Account
from eth_account.messages import encode_defunct
from web3 import Web3
from web3.exceptions import TransactionNotFound

ROOT = Path(__file__).resolve().parent
NAMES = ['ParticipantRegistry', 'DemoUSD', 'CorridorBook', 'RemittanceEscrow']
STATUSES = ['Pending', 'Completed', 'Cancelled', 'Refunded', 'Disputed']
SCHEMA = [
 'CREATE TABLE IF NOT EXISTS challenges (address TEXT PRIMARY KEY, nonce TEXT NOT NULL, message TEXT NOT NULL, expires BIGINT NOT NULL)',
 'CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, address TEXT NOT NULL, expires BIGINT NOT NULL)',
 'CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, owner TEXT NOT NULL, recipient TEXT NOT NULL, memo TEXT NOT NULL, amount TEXT NOT NULL, created BIGINT NOT NULL)',
 'CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, owner TEXT NOT NULL, tx TEXT NOT NULL UNIQUE, chain BIGINT NOT NULL, block BIGINT NOT NULL, gas TEXT NOT NULL, created BIGINT NOT NULL)',
]

class APIError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message

class Store:
    """A connection per transaction; schema remains compatible with the old service."""
    def __init__(self, url=None, filename=None, production=False):
        self.url = url
        if production and not url:
            raise RuntimeError('Production requires persistent DATABASE_URL')
        self.filename = str(filename or ROOT / 'data' / 'remit.sqlite')
        if not url:
            Path(self.filename).parent.mkdir(parents=True, exist_ok=True)
        for sql in SCHEMA:
            self.query(sql)

    def query(self, sql, args=()):
        if self.url:
            import psycopg
            from psycopg.rows import dict_row
            connection = psycopg.connect(self.url, row_factory=dict_row, connect_timeout=10)
            sql = sql.replace('?', '%s')
        else:
            connection = sqlite3.connect(self.filename, timeout=10)
            connection.row_factory = sqlite3.Row
            connection.execute('PRAGMA journal_mode=WAL')
        try:
            with connection:
                cursor = connection.execute(sql, args)
                return [dict(row) for row in cursor.fetchall()] if cursor.description else []
        finally:
            connection.close()

def now():
    return int(time.time() * 1000)

def sha(value):
    return hashlib.sha256(value.encode()).hexdigest()

def address(value):
    if not isinstance(value, str) or not Web3.is_address(value):
        raise APIError(400, 'Invalid wallet address')
    if value != value.lower() and value != value.upper() and not Web3.is_checksum_address(value):
        raise APIError(400, 'Invalid wallet address checksum')
    return value.lower()

def units(value):
    return format(Decimal(value) / Decimal(1000000), 'f')

def hexstr(value):
    return Web3.to_hex(value)

def create_app(settings=None):
    settings = settings or {}
    get = lambda key, default=None: settings.get(key, os.environ.get(key, default))
    production = get('APP_ENV', get('NODE_ENV', 'development')) == 'production'
    origin = get('APP_ORIGIN', 'http://localhost:' + str(get('PORT', '3000')))
    if production and not origin.startswith('https://'):
        raise RuntimeError('Set APP_ORIGIN to your HTTPS Render URL')
    app = Flask(__name__, static_folder=None)
    app.config.update(MAX_CONTENT_LENGTH=16384)
    db = Store(get('DATABASE_URL'), get('SQLITE_PATH'), production)
    deployment_path = Path(get('DEPLOYMENT_FILE', str(ROOT / 'deployment.sepolia.json')))
    deployment = json.loads(deployment_path.read_text()) if deployment_path.exists() else None
    if deployment:
        if deployment.get('complete') is False or set(deployment.get('addresses', {})) != set(NAMES) or not all(Web3.is_address(deployment['addresses'][n]) and isinstance(deployment.get('abi', {}).get(n), list) and deployment['abi'][n] for n in NAMES):
            raise RuntimeError('Incomplete deployment configuration')
        chain = deployment.get('chainId')
        if type(chain) is not int or chain <= 0 or (production and chain != 11155111):
            raise RuntimeError('Invalid deployment chain; production requires Sepolia')
    rpc = get('RPC_URL')
    w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={'timeout': 20})) if deployment and rpc else None
    contracts = {}
    if w3:
        if w3.eth.chain_id != deployment['chainId']:
            raise RuntimeError('RPC and deployment chain mismatch')
        for name in NAMES:
            addr = Web3.to_checksum_address(deployment['addresses'][name])
            if not w3.eth.get_code(addr):
                raise RuntimeError('Deployment has no contract bytecode')
            contracts[name] = w3.eth.contract(address=addr, abi=deployment['abi'][name])
    app.extensions.update(store=db, web3=w3, contracts=contracts, deployment=deployment)
    rates, lock = {}, threading.Lock()
    cleanup_at = [0]

    def limit(category, maximum):
        key = (request.remote_addr, category)
        tick = now()
        with lock:
            count, until = rates.get(key, (0, 0))
            if tick >= until:
                count, until = 0, tick + 60000
            rates[key] = (count + 1, until)
            if len(rates) > 10000:
                for k in list(rates):
                    if rates[k][1] < tick:
                        del rates[k]
            if count >= maximum:
                raise APIError(429, 'Too many requests; retry in one minute')

    def ensure_chain():
        if not w3:
            raise APIError(503, 'Contracts not configured. Complete the wallet deployment setup.')

    def call(name, method, *args):
        ensure_chain()
        return getattr(contracts[name].functions, method)(*args).call()

    def role(who):
        return call('ParticipantRegistry', 'roles', Web3.to_checksum_address(who))

    def identity():
        token = request.cookies.get('remit_session', '')
        if not re.fullmatch(r'[0-9a-f]{64}', token):
            raise APIError(401, 'Connect and sign in with your wallet')
        rows = db.query('SELECT address FROM sessions WHERE hash=? AND expires>?', (sha(token), now()))
        if not rows:
            raise APIError(401, 'Session expired')
        return rows[0]['address']

    def body():
        x = request.get_json()
        if not isinstance(x, dict):
            raise APIError(400, 'JSON object required')
        return x

    @app.before_request
    def guard():
        if request.path.startswith('/api/') or request.path == '/health':
            limit('api', 180)
            if request.method == 'POST':
                if request.headers.get('Origin') != origin:
                    raise APIError(403, 'Origin mismatch')
                if request.mimetype != 'application/json':
                    raise APIError(415, 'JSON required')
            with lock:
                clean = now() - cleanup_at[0] >= 60000
                if clean:
                    cleanup_at[0] = now()
            if clean:
                db.query('DELETE FROM challenges WHERE expires<?', (now(),))
                db.query('DELETE FROM sessions WHERE expires<?', (now(),))

    @app.after_request
    def headers(response):
        response.headers.update({'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'X-Frame-Options':'DENY', 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"})
        if request.path.startswith('/api/') or request.path == '/health':
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.errorhandler(APIError)
    def api_error(error):
        return jsonify(error=error.message), error.status

    @app.errorhandler(HTTPException)
    def http_error(error):
        return jsonify(error=error.description), error.code

    @app.errorhandler(Exception)
    def unavailable(error):
        app.logger.exception('Request failed')
        return jsonify(error='Service unavailable. Check chain connection and retry.'), 503

    @app.get('/health')
    def health():
        db.query('SELECT 1')
        return jsonify(status='ok', database='postgres' if db.url else 'sqlite', chainConfigured=bool(w3), backend='flask')

    @app.get('/api/config')
    def config():
        return jsonify(deployment=deployment, ready=bool(w3), mode='testnet', backend='flask', routes=[{'id':'SG-PH','currency':'PHP','rate':56.5},{'id':'SG-IN','currency':'INR','rate':83.5},{'id':'SG-BD','currency':'BDT','rate':120}], notice='Test assets only. Indicative FX, simulated KYC and off-ramp. Not real money transfer.')

    @app.get('/api/deploy-artifacts')
    def artifacts():
        return jsonify({n:json.loads((ROOT / 'artifacts' / (n+'.json')).read_text()) for n in NAMES})

    @app.post('/api/auth/challenge')
    def challenge():
        limit('challenge', 10)
        ensure_chain()
        who = address(body().get('address'))
        nonce, expiry = secrets.token_hex(20), now()+300000
        iso = datetime.fromtimestamp(expiry/1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        message = f'BridgeRemit wallet sign-in\nOrigin: {origin}\nWallet: {who}\nChain ID: {deployment["chainId"]}\nNonce: {nonce}\nExpires: {iso}\nThis signature signs you in. It does not transfer funds.'
        db.query('INSERT INTO challenges(address,nonce,message,expires) VALUES(?,?,?,?) ON CONFLICT(address) DO UPDATE SET nonce=excluded.nonce,message=excluded.message,expires=excluded.expires', (who,nonce,message,expiry))
        return jsonify(message=message)

    @app.post('/api/auth/verify')
    def verify():
        limit('verify', 15)
        x = body(); who = address(x.get('address'))
        rows = db.query('SELECT * FROM challenges WHERE address=? AND expires>?', (who,now()))
        if not rows:
            raise APIError(401, 'Challenge expired')
        c = rows[0]
        try:
            recovered = Account.recover_message(encode_defunct(text=c['message']), signature=x.get('signature')).lower()
        except Exception:
            raise APIError(401, 'Invalid signature')
        if recovered != who:
            raise APIError(401, 'Invalid signature')
        current_role = role(who)
        used = db.query('DELETE FROM challenges WHERE address=? AND nonce=? AND expires>? RETURNING address', (who,c['nonce'],now()))
        if not used:
            raise APIError(401, 'Challenge already used')
        token = secrets.token_hex(32)
        db.query('INSERT INTO sessions(hash,address,expires) VALUES(?,?,?)', (sha(token),who,now()+3600000))
        response = jsonify(wallet=who, role=current_role)
        response.set_cookie('remit_session',token,max_age=3600,httponly=True,secure=production,samesite='Strict',path='/')
        return response

    @app.post('/api/auth/logout')
    def logout():
        db.query('DELETE FROM sessions WHERE hash=?', (sha(request.cookies.get('remit_session','')),))
        response = jsonify(ok=True)
        response.set_cookie('remit_session','',max_age=0,httponly=True,secure=production,samesite='Strict',path='/')
        return response

    @app.get('/api/snapshot')
    def snapshot():
        who = identity(); ensure_chain()
        raw = request.args.get('offset','0')
        if not re.fullmatch(r'\d{1,15}',raw):
            raise APIError(400,'Invalid offset')
        offset = int(raw); wallet = Web3.to_checksum_address(who)
        r = role(who); last = call('RemittanceEscrow','nextId')-1
        start = max(0,last-offset); stop = max(0,start-100); items=[]
        for i in range(start,stop,-1):
            x = call('RemittanceEscrow','remittances',i)
            if r in (2,3,4) or who in (x[0].lower(),x[1].lower()):
                items.append(dict(id=i,sender=x[0],recipient=x[1],amount=units(x[2]),fee=units(x[3]),destination=units(x[4]),rate=units(x[5]),corridor=hexstr(x[6]),reference=hexstr(x[7]),deadline=x[8],status=STATUSES[x[9]],attestation=hexstr(x[10])))
        corridors=[]
        for route,currency in [('SG-PH','PHP'),('SG-IN','INR'),('SG-BD','BDT')]:
            x=call('CorridorBook','corridors',Web3.keccak(text=route))
            corridors.append(dict(id=route,currency=currency,rate=units(x[0]),feeBps=x[1],active=x[2]))
        return jsonify(wallet=who,role=r,approved=call('ParticipantRegistry','approved',wallet),balance=units(call('DemoUSD','balanceOf',wallet)),allowance=units(call('DemoUSD','allowance',wallet,Web3.to_checksum_address(deployment['addresses']['RemittanceEscrow']))),paused=call('RemittanceEscrow','paused'),fees=units(call('RemittanceEscrow','earnedFees')),items=items,corridors=corridors,nextOffset=offset+100 if stop>0 else None,total=last,block=w3.eth.block_number)

    @app.route('/api/invoices',methods=['GET','POST'])
    def invoices():
        who=identity()
        if request.method=='GET':
            return jsonify(db.query('SELECT * FROM invoices WHERE owner=? ORDER BY created DESC LIMIT 100',(who,)))
        if role(who)!=1 or not call('ParticipantRegistry','approved',Web3.to_checksum_address(who)):
            raise APIError(403,'Approved customer only')
        x=body(); to=address(x.get('recipient')); amount=x.get('amount'); memo=x.get('memo')
        if not isinstance(memo,str) or len(memo)>200 or not isinstance(amount,str) or not re.fullmatch(r'\d{1,6}(\.\d{1,6})?',amount) or not 1<=Decimal(amount)<=100000:
            raise APIError(400,'Invalid invoice')
        identifier=str(uuid.uuid4())
        db.query('INSERT INTO invoices(id,owner,recipient,memo,amount,created) VALUES(?,?,?,?,?,?)',(identifier,who,to,memo,amount,now()))
        return jsonify(id=identifier,referenceHash=hexstr(Web3.keccak(text=identifier))),201

    @app.post('/api/receipts')
    def receipts():
        who=identity(); ensure_chain(); txhash=body().get('hash')
        if not isinstance(txhash,str) or not re.fullmatch(r'0x[0-9a-fA-F]{64}',txhash):
            raise APIError(400,'Invalid transaction hash')
        try:
            receipt=w3.eth.get_transaction_receipt(txhash); tx=w3.eth.get_transaction(txhash)
        except TransactionNotFound:
            raise APIError(400,'Transaction not found')
        targets={a.lower() for a in deployment['addresses'].values()}
        relevant=(tx.get('to') or '').lower() in targets
        # Wallet Smart Transactions may use an outer forwarding contract.
        # Accept only genuine configured-contract logs with known event signatures.
        if not relevant:
            for name in NAMES:
                topics={hexstr(Web3.keccak(text=abi['name']+'('+','.join(i['type'] for i in abi['inputs'])+')')) for abi in deployment['abi'][name] if abi['type']=='event' and not abi.get('anonymous')}
                relevant=any(log['address'].lower()==deployment['addresses'][name].lower() and log['topics'] and hexstr(log['topics'][0]) in topics for log in receipt['logs'])
                if relevant:
                    break
        if receipt['status']!=1 or tx['from'].lower()!=who or not relevant:
            raise APIError(400,'Not a successful transaction from your wallet to this deployment')
        if w3.eth.block_number-receipt['blockNumber']+1 < (1 if deployment['chainId']==1337 else 2):
            raise APIError(409,'Waiting for confirmations; refresh later')
        canonical=hexstr(receipt['transactionHash'])
        db.query('INSERT INTO receipts(id,owner,tx,chain,block,gas,created) VALUES(?,?,?,?,?,?,?) ON CONFLICT(tx) DO NOTHING',(str(uuid.uuid4()),who,canonical,deployment['chainId'],receipt['blockNumber'],str(receipt['gasUsed']),now()))
        return jsonify(ok=True,gasUsed=str(receipt['gasUsed']))

    @app.get('/api/audit')
    def audit():
        who=identity()
        if role(who) not in (2,4):
            raise APIError(403,'Auditor or admin only')
        return jsonify(db.query('SELECT tx,owner,chain,block,gas,created FROM receipts ORDER BY created DESC LIMIT 200'))

    @app.route('/',defaults={'filename':'index.html'})
    @app.route('/<path:filename>')
    def static(filename):
        return send_from_directory(ROOT/'public',filename)

    return app

if __name__ == '__main__':
    create_app().run(host='0.0.0.0',port=int(os.environ.get('PORT','3000')),debug=False)
