import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const VTPASS_MODE = process.env.VTPASS_MODE || 'sandbox';
const VTPASS_BASE = VTPASS_MODE === 'live' ? 'https://vtpass.com/api' : 'https://sandbox.vtpass.com/api';
const MARKUP = Number(process.env.DATA_MARKUP_PERCENT || 5);
const DB_FILE = path.join(__dirname, 'data.json');

function loadDB(){
  if(!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({users:{}, deposits:{}, purchases:{}}, null, 2));
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveDB(db){ fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function ensureUser(db,email){
  const key = String(email).trim().toLowerCase();
  if(!db.users[key]) db.users[key] = {email:key,balance:0,transactions:[]};
  return db.users[key];
}
function addTx(user,title,amount,meta={}){
  user.transactions.unshift({id:crypto.randomUUID(),title,amount,date:new Date().toISOString(),...meta});
  user.transactions = user.transactions.slice(0,100);
}
function authPaystack(){ return {'Authorization':`Bearer ${PAYSTACK_SECRET_KEY}`,'Content-Type':'application/json'}; }
function authVTPost(){ return {'api-key':process.env.VTPASS_API_KEY || '','secret-key':process.env.VTPASS_SECRET_KEY || '','Content-Type':'application/json'}; }
function authVTGet(){ return {'api-key':process.env.VTPASS_API_KEY || '','public-key':process.env.VTPASS_PUBLIC_KEY || ''}; }
function requestId(){
  const d = new Date(new Date().toLocaleString('en-US',{timeZone:'Africa/Lagos'}));
  const pad=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${crypto.randomBytes(5).toString('hex')}`;
}
const services={MTN:'mtn-data',Airtel:'airtel-data',Glo:'glo-data','9mobile':'9mobile-data'};

app.use(express.json({verify:(req,res,buf)=>{req.rawBody=buf;}}));
app.use(express.static(__dirname));

app.get('/api/health',(req,res)=>res.json({ok:true,mode:VTPASS_MODE,markup:MARKUP}));

app.get('/api/wallet',(req,res)=>{
  const email=String(req.query.email||'').trim().toLowerCase();
  if(!email) return res.status(400).json({error:'Email is required'});
  const db=loadDB(), user=ensureUser(db,email); saveDB(db);
  res.json({email:user.email,balance:user.balance,transactions:user.transactions});
});

app.post('/api/paystack/initialize',async(req,res)=>{
  try{
    if(!PAYSTACK_SECRET_KEY) return res.status(500).json({error:'Paystack secret key is not configured on the server.'});
    const email=String(req.body.email||'').trim().toLowerCase();
    const amount=Number(req.body.amount);
    if(!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({error:'Valid email is required.'});
    if(!Number.isFinite(amount)||amount<100) return res.status(400).json({error:'Minimum funding amount is ₦100.'});
    const reference=`DMD-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const db=loadDB(); ensureUser(db,email);
    db.deposits[reference]={reference,email,amount,status:'pending',createdAt:new Date().toISOString()}; saveDB(db);
    const r=await fetch('https://api.paystack.co/transaction/initialize',{method:'POST',headers:authPaystack(),body:JSON.stringify({email,amount:Math.round(amount*100),currency:'NGN',reference,callback_url:`${PUBLIC_BASE_URL}/payment-callback.html`,metadata:{purpose:'wallet_funding',email}})});
    const data=await r.json();
    if(!r.ok||!data.status) return res.status(502).json({error:data.message||'Paystack initialization failed.'});
    res.json({authorization_url:data.data.authorization_url,reference:data.data.reference});
  }catch(e){res.status(500).json({error:e.message});}
});

async function verifyPaystack(reference){
  const r=await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,{headers:authPaystack()});
  return r.json();
}

async function creditDeposit(reference){
  const db=loadDB(); const dep=db.deposits[reference];
  if(!dep) return {ok:false,error:'Deposit not found'};
  if(dep.status==='success') return {ok:true,already:true};
  const verified=await verifyPaystack(reference);
  if(!verified.status || verified.data?.status!=='success') return {ok:false,error:'Payment is not successful yet.'};
  const user=ensureUser(db,dep.email); user.balance += Number(dep.amount); addTx(user,'Wallet funding',Number(dep.amount),{reference}); dep.status='success'; dep.verifiedAt=new Date().toISOString(); saveDB(db); return {ok:true,balance:user.balance};
}

app.get('/api/paystack/verify/:reference',async(req,res)=>{try{res.json(await creditDeposit(req.params.reference));}catch(e){res.status(500).json({error:e.message});}});

app.post('/api/paystack/webhook',async(req,res)=>{
  const signature=req.headers['x-paystack-signature'];
  if(!PAYSTACK_SECRET_KEY || !signature) return res.sendStatus(401);
  const hash=crypto.createHmac('sha512',PAYSTACK_SECRET_KEY).update(req.rawBody).digest('hex');
  if(hash!==signature) return res.sendStatus(401);
  res.sendStatus(200);
  if(req.body?.event==='charge.success' && req.body?.data?.reference){
    try{await creditDeposit(req.body.data.reference);}catch(e){console.error('Webhook credit error',e);}
  }
});

app.get('/api/plans/:network',async(req,res)=>{
  try{
    const network=String(req.params.network); const serviceID=services[network];
    if(!serviceID) return res.status(400).json({error:'Unsupported network'});
    const r=await fetch(`${VTPASS_BASE}/service-variations?serviceID=${serviceID}`,{headers:authVTGet()});
    const data=await r.json();
    if(!r.ok || data.response_description==='INVALID AUTHORIZATION') return res.status(502).json({error:data.response_description||'Could not load plans'});
    const variations=data.content?.variations || data.content?.varations || [];
    res.json({network,plans:variations.map(v=>({variation_code:v.variation_code,name:v.name,base_price:Number(v.variation_amount),sell_price:Math.ceil(Number(v.variation_amount)*(1+MARKUP/100))}))});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/data/purchase',async(req,res)=>{
  try{
    const {email,phone,network,variation_code}=req.body||{};
    if(!email||!phone||!network||!variation_code) return res.status(400).json({error:'email, phone, network and variation_code are required.'});
    if(!/^0\d{10}$/.test(String(phone))) return res.status(400).json({error:'Enter a valid 11-digit Nigerian phone number.'});
    const serviceID=services[network]; if(!serviceID) return res.status(400).json({error:'Unsupported network'});
    const plansResp=await fetch(`${VTPASS_BASE}/service-variations?serviceID=${serviceID}`,{headers:authVTGet()}); const plans=await plansResp.json();
    const v=(plans.content?.variations||plans.content?.varations||[]).find(x=>x.variation_code===variation_code);
    if(!v) return res.status(400).json({error:'Invalid data plan.'});
    const base=Number(v.variation_amount), sell=Math.ceil(base*(1+MARKUP/100));
    const db=loadDB(), user=ensureUser(db,email);
    if(user.balance<sell) return res.status(400).json({error:`Insufficient wallet balance. You need ₦${sell.toLocaleString()}.`,balance:user.balance});
    const rid=requestId();
    const r=await fetch(`${VTPASS_BASE}/pay`,{method:'POST',headers:authVTPost(),body:JSON.stringify({request_id:rid,serviceID,billersCode:String(phone),variation_code,amount:base,phone:String(phone)})});
    const data=await r.json();
    const status=data.content?.transactions?.status || '';
    if(!r.ok || !['delivered','successful'].includes(String(status).toLowerCase()) || data.code!=='000') return res.status(502).json({error:data.response_description||'Data purchase failed or is pending.',provider_status:status,request_id:rid});
    user.balance-=sell; addTx(user,`Data purchase • ${network} • ${v.name} • ${phone}`,-sell,{provider_request_id:rid,variation_code}); db.purchases[rid]={email,phone,network,variation_code,base,sell,status:'delivered',createdAt:new Date().toISOString()}; saveDB(db);
    res.json({ok:true,status:'delivered',balance:user.balance,request_id:rid,plan:v.name});
  }catch(e){res.status(500).json({error:e.message});}
});
app.listen(PORT,()=>console.log(`DAHIRU MAN D DATA running on ${PUBLIC_BASE_URL}`));
app.get('/// ================= ADMIN AUTH =================

const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');

function createAdminToken(email){
  const payload = `${email}:${Date.now()}`;
  const secret = ADMIN_PASSWORD || 'change-this-secret';
  const signature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  return Buffer.from(`${payload}:${signature}`).toString('base64url');
}

function verifyAdminToken(token){
  try{
    const decoded = Buffer.from(String(token || ''), 'base64url').toString('utf8');
    const parts = decoded.split(':');

    if(parts.length < 3) return false;

    const email = parts[0];
    const timestamp = Number(parts[1]);
    const signature = parts.slice(2).join(':');

    if(!email || !Number.isFinite(timestamp)) return false;

    // Token expires after 24 hours
    if(Date.now() - timestamp > 24 * 60 * 60 * 1000) return false;

    const payload = `${email}:${timestamp}`;
    const expected = crypto
      .createHmac('sha256', ADMIN_PASSWORD || 'change-this-secret')
      .update(payload)
      .digest('hex');

    if(signature !== expected) return false;
    if(email !== ADMIN_EMAIL) return false;

    return true;
  }catch{
    return false;
  }
}

function requireAdmin(req,res,next){
  const auth = String(req.headers.authorization || '');

  if(!auth.startsWith('Bearer ')){
    return res.status(401).json({error:'Admin login required.'});
  }

  const token = auth.slice(7);

  if(!verifyAdminToken(token)){
    return res.status(401).json({error:'Invalid or expired admin session.'});
  }

  next();
}

app.post('/api/admin/login',(req,res)=>{
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if(!ADMIN_EMAIL || !ADMIN_PASSWORD){
    return res.status(500).json({
      error:'Admin credentials are not configured on the server.'
    });
  }

  if(email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD){
    return res.status(401).json({
      error:'Incorrect email or password.'
    });
  }

  const token = createAdminToken(email);

  res.json({
    ok:true,
    token
  });
});

app.get('/api/admin/overview',requireAdmin,(req,res)=>{
  try{
    const db = loadDB();

    const users = Object.values(db.users || {});
    const deposits = Object.values(db.deposits || {});
    const purchases = Object.values(db.purchases || {});

    const totalBalance = users.reduce(
      (sum,user)=>sum + Number(user.balance || 0),0
    );

    const successfulDeposits = deposits.filter(
      x => x.status === 'success'
    );

    const totalDeposits = successfulDeposits.reduce(
      (sum,x)=>sum + Number(x.amount || 0),0
    );

    const totalPurchases = purchases.reduce(
      (sum,x)=>sum + Number(x.sell || 0),0
    );

    res.json({
      users: users.map(user=>({
        email:user.email,
        balance:Number(user.balance || 0),
        transactions:(user.transactions || []).slice(0,20)
      })),
      stats:{
        users:users.length,
        balance:totalBalance,
        deposits:totalDeposits,
        purchases:totalPurchases
      },
      recentDeposits:deposits.slice(-20).reverse(),
      recentPurchases:purchases.slice(-20).reverse()
    });

  }catch(e){
    res.status(500).json({error:e.message});
  }
});

// ================= END ADMIN AUTH =================payment-callback.html',(req,res)=>res.sendFile(path.join(__dirname,'payment-callback.html')));
app.listen(PORT,()=>console.log(`DAHIRU MAN D DATA running on ${PUBLIC_BASE_URL}`));
