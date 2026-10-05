import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
export async function openStore() {
  let query, close;
  if(process.env.DATABASE_URL){
    const {Pool}=await import('pg');const pool=new Pool({connectionString:process.env.DATABASE_URL,max:5});
    query=async(sql,args=[]) => (await pool.query(sql,args)).rows;close=()=>pool.end();
  } else {
    if(process.env.NODE_ENV==='production') throw Error('Production requires persistent DATABASE_URL');
    const {DatabaseSync}=await import('node:sqlite'); fs.mkdirSync('data',{recursive:true});const db=new DatabaseSync(process.env.SQLITE_PATH||'data/remit.sqlite');db.exec('PRAGMA journal_mode=WAL');
    query=async(sql,args=[]) => {const s=db.prepare(sql);const bindings=Object.fromEntries(args.map((v,i)=>['$'+(i+1),v]));if(/^\s*(select|.*returning)/is.test(sql)) return args.length?s.all(bindings):s.all();args.length?s.run(bindings):s.run();return [];};close=()=>db.close();
  }
  await query('CREATE TABLE IF NOT EXISTS challenges (address TEXT PRIMARY KEY, nonce TEXT NOT NULL, message TEXT NOT NULL, expires BIGINT NOT NULL)');
  await query('CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, address TEXT NOT NULL, expires BIGINT NOT NULL)');
  await query('CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, owner TEXT NOT NULL, recipient TEXT NOT NULL, memo TEXT NOT NULL, amount TEXT NOT NULL, created BIGINT NOT NULL)');
  await query('CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, owner TEXT NOT NULL, tx TEXT NOT NULL UNIQUE, chain BIGINT NOT NULL, block BIGINT NOT NULL, gas TEXT NOT NULL, created BIGINT NOT NULL)');
  return {query,close,uuid:randomUUID};
}
