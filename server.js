const express=require('express'),crypto=require('crypto'),fs=require('fs'),zlib=require('zlib');
const Database=require('better-sqlite3'),multer=require('multer');
const T=process.env.BOT_TOKEN,ADMINS=(process.env.ADMIN_IDS||'').split(',').filter(Boolean).map(Number);
const DATA=process.env.DATA_DIR||'./data';
fs.mkdirSync(DATA+'/receipts',{recursive:true});fs.mkdirSync(DATA+'/tgs',{recursive:true});
const db=new Database(DATA+'/shop.db');db.pragma('journal_mode=WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT,balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0));
CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,type TEXT,amount INTEGER,bal_before INTEGER,bal_after INTEGER,ref TEXT,at INTEGER);
CREATE TRIGGER IF NOT EXISTS ledger_u BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_d BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TABLE IF NOT EXISTS topups(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,username TEXT,code TEXT,status TEXT,card TEXT,note TEXT,receipt TEXT,amount INTEGER,reason TEXT,admin_id INTEGER,created INTEGER,updated INTEGER);
CREATE TABLE IF NOT EXISTS cart(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,kind TEXT,gift_id TEXT,qty INTEGER,stars INTEGER,base INTEGER,fee INTEGER,total INTEGER,recipient TEXT,message TEXT,created INTEGER);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,idem TEXT UNIQUE,total INTEGER,fee INTEGER,status TEXT,created INTEGER);
CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER,kind TEXT,gift_id TEXT,qty INTEGER,stars INTEGER,base INTEGER,fee INTEGER,total INTEGER,recipient TEXT,message TEXT);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT);
CREATE TABLE IF NOT EXISTS admin_log(id INTEGER PRIMARY KEY AUTOINCREMENT,admin_id INTEGER,action TEXT,detail TEXT,at INTEGER);
`);
const S=(k,d)=>{const r=db.prepare('SELECT v FROM settings WHERE k=?').get(k);return r?r.v:d};
const setS=(k,v)=>db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k,String(v));
const log=(a,x,d)=>db.prepare('INSERT INTO admin_log(admin_id,action,detail,at) VALUES(?,?,?,?)').run(a,x,JSON.stringify(d),Date.now());
const move=(uid,type,amt,ref)=>{const b=db.prepare('SELECT balance FROM users WHERE id=?').get(uid).balance,a=b+amt;
 if(a<0)throw new Error('LOW');db.prepare('UPDATE users SET balance=? WHERE id=?').run(a,uid);
 db.prepare('INSERT INTO ledger(user_id,type,amount,bal_before,bal_after,ref,at) VALUES(?,?,?,?,?,?,?)').run(uid,type,amt,b,a,ref,Date.now())};
async function tgc(m,b){const r=await fetch(`https://api.telegram.org/bot${T}/${m}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})});return (await r.json()).result}
const notify=(id,text)=>tgc('sendMessage',{chat_id:id,text}).catch(()=>{});
// ---- rate & price
async function loadRate(){if(!process.env.RATE_URL)return;try{const j=await (await fetch(process.env.RATE_URL)).json();let v=j;
 for(const k of (process.env.RATE_PATH||'').split('.').filter(Boolean))v=v?.[k];v=Number(String(v).replace(/,/g,''));
 if(v>0){setS('rate',v);setS('rate_at',Date.now())}}catch(e){console.error('rate',e.message)}}
const getRate=()=>{const r=+S('rate',0);return r>0?{rate:r,stale:Date.now()-(+S('rate_at',0))>120000}:null};
const cfg=()=>({starUsd:+S('star_usd',0.014),fee:+S('fee',5)});
function price(stars,qty){const R=getRate();if(!R)throw new Error('NORATE');const c=cfg();
 const base=Math.ceil(stars*qty*c.starUsd*R.rate),fee=Math.ceil(base*c.fee/100);return{base,fee,total:base+fee}}
// ---- gifts
let gifts=[];
async function loadGifts(){try{const r=await tgc('getAvailableGifts'),out=[];
 for(const g of r.gifts){const f=`${DATA}/tgs/${g.id}.json`;
  if(!fs.existsSync(f)){const fi=await tgc('getFile',{file_id:g.sticker.file_id});
   const buf=Buffer.from(await (await fetch(`https://api.telegram.org/file/bot${T}/${fi.file_path}`)).arrayBuffer());
   fs.writeFileSync(f,zlib.gunzipSync(buf))}
  out.push({id:g.id,stars:g.star_count,left:g.remaining_count??null})}
 gifts=out.sort((a,b)=>a.stars-b.stars)}catch(e){console.error('gifts',e.message)}}
loadRate();loadGifts();setInterval(loadRate,(+process.env.RATE_SEC||10)*1000);setInterval(loadGifts,30*60*1000);
// ---- app
const app=express();app.use(express.json());app.use(express.static('public'));
app.get('/tgs/:id',(req,res)=>{const f=`${DATA}/tgs/${req.params.id.replace(/\W/g,'')}.json`;fs.existsSync(f)?res.type('json').sendFile(require('path').resolve(f)):res.status(404).end()});
function auth(req,res,next){const d=req.get('x-init')||'';let u;
 if(d){const p=new URLSearchParams(d),h=p.get('hash');p.delete('hash');
  const s=[...p.entries()].sort(([a],[b])=>a<b?-1:1).map(([k,v])=>k+'='+v).join('\n');
  const k=crypto.createHmac('sha256','WebAppData').update(T).digest();
  if(crypto.createHmac('sha256',k).update(s).digest('hex')!==h||Date.now()/1000-p.get('auth_date')>86400)return res.status(401).json({e:'AUTH'});
  u=JSON.parse(p.get('user'))}
 else if(process.env.DEV==='1')u={id:+req.get('x-dev')||1,username:'dev'};
 else return res.status(401).json({e:'AUTH'});
 db.prepare('INSERT INTO users(id,username) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username').run(u.id,u.username||'');
 req.u=u;req.admin=ADMINS.includes(u.id)||(process.env.DEV==='1'&&!ADMINS.length);next()}
const adm=(q,s,n)=>q.admin?n():s.status(403).json({e:'FORBIDDEN'});
const wrap=f=>(q,s)=>{try{f(q,s)}catch(e){s.status(400).json({e:e.message})}};
app.get('/api/me',auth,wrap((q,s)=>{const u=db.prepare('SELECT balance FROM users WHERE id=?').get(q.u.id);s.json({id:q.u.id,balance:u.balance,admin:q.admin})}));
app.get('/api/prices',auth,wrap((q,s)=>{const R=getRate();s.json({rate:R&&R.rate,stale:R?R.stale:true,...cfg()})}));
app.get('/api/gifts',auth,wrap((q,s)=>s.json(gifts.filter(g=>g.left!==0))));
app.get('/api/cart',auth,wrap((q,s)=>s.json(db.prepare('SELECT * FROM cart WHERE user_id=?').all(q.u.id))));
app.delete('/api/cart/:id',auth,wrap((q,s)=>{db.prepare('DELETE FROM cart WHERE id=? AND user_id=?').run(q.params.id,q.u.id);s.json({ok:1})}));
app.post('/api/cart',auth,wrap((q,s)=>{const{kind,gift_id,recipient,message}=q.body,qty=Math.floor(+q.body.qty);
 if(!(qty>=1&&qty<=100000))throw new Error('QTY');if(!String(recipient||'').trim())throw new Error('RECIPIENT');
 let stars,unit;
 if(kind==='gift'){const g=gifts.find(x=>x.id===gift_id&&x.left!==0);if(!g)throw new Error('GIFT');unit=g.stars;if(qty>50)throw new Error('QTY')}
 else if(kind==='stars'){if(qty<50)throw new Error('MIN50');unit=1}else throw new Error('KIND');
 const p=price(unit,qty);
 db.prepare('INSERT INTO cart(user_id,kind,gift_id,qty,stars,base,fee,total,recipient,message,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
  .run(q.u.id,kind,gift_id||null,qty,unit*qty,p.base,p.fee,p.total,String(recipient).trim(),String(message||'').slice(0,200),Date.now());s.json({ok:1})}));
app.post('/api/checkout',auth,wrap((q,s)=>{const idem=String(q.body.key||'');if(idem.length<8)throw new Error('KEY');
 const r=db.transaction(()=>{const ex=db.prepare('SELECT id FROM orders WHERE idem=?').get(idem);if(ex)return{id:ex.id,dup:1};
  const it=db.prepare('SELECT * FROM cart WHERE user_id=?').all(q.u.id);if(!it.length)throw new Error('EMPTY');
  const tot=it.reduce((a,i)=>a+i.total,0),fee=it.reduce((a,i)=>a+i.fee,0);
  const o=db.prepare('INSERT INTO orders(user_id,idem,total,fee,status,created) VALUES(?,?,?,?,?,?)').run(q.u.id,idem,tot,fee,'processing',Date.now());
  for(const i of it)db.prepare('INSERT INTO order_items(order_id,kind,gift_id,qty,stars,base,fee,total,recipient,message) VALUES(?,?,?,?,?,?,?,?,?,?)').run(o.lastInsertRowid,i.kind,i.gift_id,i.qty,i.stars,i.base,i.fee,i.total,i.recipient,i.message);
  move(q.u.id,'purchase',-tot,'order:'+o.lastInsertRowid);db.prepare('DELETE FROM cart WHERE user_id=?').run(q.u.id);return{id:o.lastInsertRowid}})();
 if(!r.dup)ADMINS.forEach(a=>notify(a,'New order #'+r.id));s.json(r)}));
// topup (user)
const OPEN=`('requested','card_sent','receipt_uploaded')`;
app.post('/api/topup',auth,wrap((q,s)=>{if(db.prepare(`SELECT 1 FROM topups WHERE user_id=? AND status IN ${OPEN}`).get(q.u.id))throw new Error('OPEN');
 const code=crypto.randomBytes(3).toString('hex').toUpperCase(),n=Date.now();
 db.prepare('INSERT INTO topups(user_id,username,code,status,created,updated) VALUES(?,?,?,?,?,?)').run(q.u.id,q.u.username||'',code,'requested',n,n);
 ADMINS.forEach(a=>notify(a,'Card request '+code));s.json({ok:1})}));
app.get('/api/topups',auth,wrap((q,s)=>s.json(db.prepare('SELECT id,code,status,card,note,amount,reason,created FROM topups WHERE user_id=? ORDER BY id DESC LIMIT 20').all(q.u.id))));
const up=multer({dest:DATA+'/receipts',limits:{fileSize:5e6},fileFilter:(r,f,cb)=>cb(null,['image/jpeg','image/png'].includes(f.mimetype))});
app.post('/api/topup/:id/receipt',auth,up.single('f'),wrap((q,s)=>{if(!q.file)throw new Error('FILE');
 const r=db.prepare(`UPDATE topups SET status='receipt_uploaded',receipt=?,updated=? WHERE id=? AND user_id=? AND status='card_sent'`).run(q.file.filename,Date.now(),q.params.id,q.u.id);
 if(!r.changes){fs.unlink(q.file.path,()=>{});throw new Error('STATE')}ADMINS.forEach(a=>notify(a,'Receipt uploaded #'+q.params.id));s.json({ok:1})}));
// admin
app.get('/api/admin/topups',auth,adm,wrap((q,s)=>s.json(db.prepare(`SELECT * FROM topups WHERE status IN ${OPEN} ORDER BY id`).all())));
app.get('/api/admin/receipt/:id',auth,adm,wrap((q,s)=>{const t=db.prepare('SELECT receipt FROM topups WHERE id=?').get(q.params.id);
 if(!t||!t.receipt)throw new Error('NONE');s.sendFile(require('path').resolve(DATA,'receipts',t.receipt))}));
app.post('/api/admin/topup/:id/card',auth,adm,wrap((q,s)=>{const t=db.prepare('SELECT * FROM topups WHERE id=?').get(q.params.id);
 const r=db.prepare(`UPDATE topups SET status='card_sent',card=?,note=?,admin_id=?,updated=? WHERE id=? AND status='requested'`).run(q.body.card,q.body.note||'',q.u.id,Date.now(),t.id);
 if(!r.changes)throw new Error('STATE');log(q.u.id,'card',{id:t.id});notify(t.user_id,'Card details ready. Tracking code: '+t.code);s.json({ok:1})}));
app.post('/api/admin/topup/:id/approve',auth,adm,wrap((q,s)=>{const amt=Math.floor(+q.body.amount);if(!(amt>0))throw new Error('AMOUNT');
 const t=db.transaction(()=>{const t=db.prepare('SELECT * FROM topups WHERE id=?').get(q.params.id);
  const r=db.prepare(`UPDATE topups SET status='approved',amount=?,admin_id=?,updated=? WHERE id=? AND status='receipt_uploaded'`).run(amt,q.u.id,Date.now(),t.id);
  if(!r.changes)throw new Error('STATE');move(t.user_id,'topup',amt,'topup:'+t.id);log(q.u.id,'approve',{id:t.id,amt});return t})();
 notify(t.user_id,'Wallet charged: '+amt+' Toman');s.json({ok:1})}));
app.post('/api/admin/topup/:id/reject',auth,adm,wrap((q,s)=>{if(!String(q.body.reason||'').trim())throw new Error('REASON');
 const t=db.prepare('SELECT * FROM topups WHERE id=?').get(q.params.id);
 const r=db.prepare(`UPDATE topups SET status='rejected',reason=?,admin_id=?,updated=? WHERE id=? AND status='receipt_uploaded'`).run(q.body.reason,q.u.id,Date.now(),t.id);
 if(!r.changes)throw new Error('STATE');log(q.u.id,'reject',{id:t.id});notify(t.user_id,'Receipt rejected: '+q.body.reason);s.json({ok:1})}));
app.get('/api/admin/settings',auth,adm,wrap((q,s)=>s.json({...cfg(),rate:S('rate',0)})));
app.post('/api/admin/settings',auth,adm,wrap((q,s)=>{for(const k of['fee','star_usd','rate']){const v=q.body[k];if(v!==undefined&&v!==''){if(!(+v>=0))throw new Error('VALUE');setS(k,+v);if(k==='rate')setS('rate_at',Date.now());log(q.u.id,'set_'+k,{v})}}s.json({ok:1})}));
app.get('/api/admin/orders',auth,adm,wrap((q,s)=>{const o=db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 30').all();
 o.forEach(x=>x.items=db.prepare('SELECT * FROM order_items WHERE order_id=?').all(x.id));s.json(o)}));
app.post('/api/admin/order/:id/done',auth,adm,wrap((q,s)=>{db.prepare(`UPDATE orders SET status='delivered' WHERE id=?`).run(q.params.id);log(q.u.id,'delivered',{id:q.params.id});s.json({ok:1})}));
app.listen(process.env.PORT||3000);
