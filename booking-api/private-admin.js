'use strict';
const crypto=require('node:crypto');
const EMAIL='llucianouam@gmail.com';
const attempts=new Map();
const key=()=>process.env.LUSSAN_ADMIN_SESSION_SECRET||'';
const configured=()=>Boolean(key().length>=32&&/^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/i.test(process.env.LUSSAN_ADMIN_PASSWORD_HASH||''));
function verifyPassword(password){
 const [,salt,hex]=(process.env.LUSSAN_ADMIN_PASSWORD_HASH||'').split(':');
 if(!salt||!hex||typeof password!=='string'||password.length>256)return false;
 const derived=crypto.scryptSync(password,Buffer.from(salt,'hex'),64);
 return crypto.timingSafeEqual(derived,Buffer.from(hex,'hex'));
}
function signature(data){return crypto.createHmac('sha256',key()).update(data).digest('base64url')}
function validate(req){
 const match=/^Bearer ([-\w.]+)$/.exec(req.headers.authorization||'');if(!match)return false;
 const [body,sig]=match[1].split('.');if(!body||!sig)return false;
 const expected=signature(body);if(sig.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return false;
 try{const payload=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));return payload.role==='lussan-admin'&&payload.exp>Date.now()&&payload.exp<Date.now()+9*3600000}catch{return false}
}
module.exports=function(app,pool){
 app.get('/api/private-admin/status',(req,res)=>res.json({ready:configured()}));
 app.post('/api/private-admin/login',async(req,res)=>{
  res.set('Cache-Control','no-store');
  if(!configured())return res.status(503).json({error:'setup_required'});
  const ip=req.ip||'unknown',now=Date.now(),record=attempts.get(ip)||{count:0,until:0};
  if(record.until>now)return res.status(429).json({error:'try_later'});
  const email=String(req.body?.email||'').trim().toLowerCase();
  const password=req.body?.password;
  const good=email===EMAIL&&verifyPassword(password);
  if(!good){const count=record.count+1;attempts.set(ip,{count,until:count>=5?now+15*60000:0});return res.status(401).json({error:'invalid_credentials'})}
  attempts.delete(ip);
  const body=Buffer.from(JSON.stringify({role:'lussan-admin',exp:Date.now()+2*3600000})).toString('base64url');
  return res.json({token:body+'.'+signature(body),expires_in:7200});
 });
 const requireAdmin=(req,res,next)=>{if(!configured())return res.status(503).json({error:'setup_required'});if(!validate(req))return res.status(401).json({error:'unauthorized'});next()};
 app.get('/api/private-admin/me',requireAdmin,(req,res)=>res.json({authorized:true}));
 app.get('/api/private-admin/queue',requireAdmin,async(req,res)=>{
  if(!pool)return res.status(503).json({error:'database_unavailable'});
  try{const q=await pool.query(`SELECT id,cart_order_id,verification_status,created_at,'photos' AS product FROM lussan_booking.photo_verifications UNION ALL SELECT id,cart_order_id,verification_status,created_at,'magazine' AS product FROM lussan_booking.magazine_verifications ORDER BY created_at DESC LIMIT 100`);res.json({requests:q.rows})}catch(e){console.error('private admin queue',e.code||'unavailable');res.status(503).json({error:'queue_unavailable'})}
 });
};
