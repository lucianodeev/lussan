'use strict';
const crypto=require('node:crypto');
const {promisify}=require('node:util');
const scrypt=promisify(crypto.scrypt);
const EMAIL='llucianouam@gmail.com';
const HASH=/^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/i;
const attempts=new Map(),resetAttempts=new Map();
const key=()=>process.env.LUSSAN_ADMIN_SESSION_SECRET||'';
const signature=data=>crypto.createHmac('sha256',key()).update(data).digest('base64url');
const digest=token=>crypto.createHash('sha256').update(token).digest('hex');
const mailReady=()=>Boolean(process.env.RESEND_API_KEY&&process.env.LUSSAN_ADMIN_MAIL_FROM);
async function passwordHash(password){
 const salt=crypto.randomBytes(16),derived=await scrypt(password,salt,64);
 return 'scrypt:'+salt.toString('hex')+':'+derived.toString('hex');
}
async function verifyPassword(password,hash){
 if(!HASH.test(hash||'')||typeof password!=='string'||password.length>256)return false;
 const [,salt,hex]=hash.split(':');
 return crypto.timingSafeEqual(await scrypt(password,Buffer.from(salt,'hex'),64),Buffer.from(hex,'hex'));
}
function validate(req,version){
 const match=/^Bearer ([-\w.]+)$/.exec(req.headers.authorization||'');if(!match)return false;
 const parts=match[1].split('.');if(parts.length!==2)return false;
 const [body,sig]=parts,expected=signature(body);
 if(sig.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return false;
 try{const payload=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));return payload.role==='lussan-admin'&&payload.version===version&&Number.isFinite(payload.exp)&&payload.exp>Date.now()&&payload.exp<=Date.now()+2*3600000}catch{return false}
}
function limited(map,ip,max,window){
 const now=Date.now();for(const [address,entry] of map)if(entry.resetAt<=now)map.delete(address);
 const record=map.get(ip)||{count:0,resetAt:now+window};record.count++;map.set(ip,record);return record.count>max;
}
async function sendResetEmail(link){
 const response=await fetch('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.LUSSAN_ADMIN_MAIL_FROM,to:[EMAIL],subject:'LUSSAN — definir nova senha',text:'Abra o link para definir a sua senha Lussan. É válido por 30 minutos e só pode ser usado uma vez.\n\n'+link+'\n\nSe não pediu esta alteração, ignore este e-mail.'})});
 if(!response.ok)throw Error('mail_unavailable');
}
module.exports=function(app,pool){
 async function credential(){
  if(pool){const result=await pool.query('SELECT password_hash,session_version FROM lussan_booking.private_admin_credentials WHERE email=$1',[EMAIL]);if(result.rows[0])return result.rows[0]}
  return {password_hash:process.env.LUSSAN_ADMIN_PASSWORD_HASH||'',session_version:'legacy'};
 }
 const ready=c=>key().length>=32&&HASH.test(c.password_hash||'');
 app.use('/api/private-admin',(_req,res,next)=>{res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');next()});
 app.get('/api/private-admin/status',async(_req,res)=>{
  try{const c=await credential();res.json({ready:ready(c),reset_email_ready:mailReady()})}catch{res.status(503).json({error:'authentication_unavailable'})}
 });
 app.post('/api/private-admin/login',async(req,res)=>{
  try{
   const c=await credential();if(!ready(c))return res.status(503).json({error:'setup_required'});
   const ip=req.ip||'unknown';if(limited(attempts,ip,5,15*60000))return res.status(429).json({error:'try_later'});
   const email=typeof req.body?.email==='string'?req.body.email.trim().toLowerCase():'';
   const good=await verifyPassword(req.body?.password,c.password_hash);
   if(email!==EMAIL||!good)return res.status(401).json({error:'invalid_credentials'});
   attempts.delete(ip);
   const body=Buffer.from(JSON.stringify({role:'lussan-admin',version:c.session_version,exp:Date.now()+2*3600000})).toString('base64url');
   res.json({token:body+'.'+signature(body),expires_in:7200});
  }catch{res.status(503).json({error:'authentication_unavailable'})}
 });
 app.post('/api/private-admin/request-password-reset',async(req,res)=>{
  if(limited(resetAttempts,req.ip||'unknown',3,3600000))return res.status(429).json({error:'try_later'});
  const email=typeof req.body?.email==='string'?req.body.email.trim().toLowerCase():'';
  if(email!==EMAIL)return res.status(202).json({accepted:true});
  if(!pool||key().length<32||!mailReady())return res.status(503).json({error:'email_setup_required'});
  let tokenHash;
  try{
   const recent=await pool.query("SELECT count(*)::int AS count FROM lussan_booking.private_admin_password_resets WHERE created_at>now()-interval '1 hour'");
   if(recent.rows[0].count>=3)return res.status(429).json({error:'try_later'});
   const token=crypto.randomBytes(32).toString('base64url');tokenHash=digest(token);
   await pool.query("INSERT INTO lussan_booking.private_admin_password_resets(token_hash,expires_at) VALUES($1,now()+interval '30 minutes')",[tokenHash]);
   await sendResetEmail('https://lussan.onrender.com/admin-privado.html#reset='+token);
   return res.status(202).json({accepted:true});
  }catch{
   if(tokenHash)try{await pool.query('DELETE FROM lussan_booking.private_admin_password_resets WHERE token_hash=$1 AND used_at IS NULL',[tokenHash])}catch{}
   return res.status(503).json({error:'email_unavailable'});
  }
 });
 app.post('/api/private-admin/reset-password',async(req,res)=>{
  if(!pool||key().length<32)return res.status(503).json({error:'setup_required'});
  if(limited(resetAttempts,'redeem:'+(req.ip||'unknown'),10,15*60000))return res.status(429).json({error:'try_later'});
  const token=req.body?.token,password=req.body?.password;
  if(typeof token!=='string'||!/^[-\w]{43}$/.test(token))return res.status(400).json({error:'invalid_or_expired_link'});
  if(typeof password!=='string'||password.length<12||password.length>256)return res.status(400).json({error:'password_length'});
  try{
   const tokenHash=digest(token);
   const check=await pool.query('SELECT 1 FROM lussan_booking.private_admin_password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now()',[tokenHash]);
   if(!check.rowCount)return res.status(400).json({error:'invalid_or_expired_link'});
   const hash=await passwordHash(password);
   // Consume the link and change the password atomically. Concurrent replays cannot both succeed.
   const result=await pool.query(`WITH consumed AS (
    UPDATE lussan_booking.private_admin_password_resets SET used_at=now()
    WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING token_hash
   ), invalidated AS (
    UPDATE lussan_booking.private_admin_password_resets SET used_at=now()
    WHERE token_hash<>$1 AND used_at IS NULL AND EXISTS(SELECT 1 FROM consumed)
   ) INSERT INTO lussan_booking.private_admin_credentials(email,password_hash,session_version,updated_at)
   SELECT $2,$3,gen_random_uuid(),now() FROM consumed
   ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash,session_version=EXCLUDED.session_version,updated_at=now()
   RETURNING email`,[tokenHash,EMAIL,hash]);
   if(!result.rowCount)return res.status(400).json({error:'invalid_or_expired_link'});
   attempts.clear();return res.json({updated:true});
  }catch{return res.status(503).json({error:'password_update_unavailable'})}
 });
 const requireAdmin=async(req,res,next)=>{
  try{const c=await credential();if(!ready(c))return res.status(503).json({error:'setup_required'});if(!validate(req,c.session_version))return res.status(401).json({error:'unauthorized'});next()}catch{res.status(503).json({error:'authentication_unavailable'})}
 };
 app.get('/api/private-admin/me',requireAdmin,(_req,res)=>res.json({authorized:true}));
 app.get('/api/private-admin/queue',requireAdmin,async(_req,res)=>{
  if(!pool)return res.status(503).json({error:'database_unavailable'});
  try{const q=await pool.query(`SELECT id,cart_order_id,verification_status,created_at,'photos' AS product FROM lussan_booking.photo_verifications UNION ALL SELECT id,cart_order_id,verification_status,created_at,'magazine' AS product FROM lussan_booking.magazine_verifications ORDER BY created_at DESC LIMIT 100`);res.json({requests:q.rows})}catch(e){console.error('private admin queue',e.code||'unavailable');res.status(503).json({error:'queue_unavailable'})}
 });
};
