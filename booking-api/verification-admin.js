'use strict';
const crypto=require('node:crypto');
const SUPABASE_URL='https://lcvuuqtdboucayrysdvc.supabase.co';
const PUBLISHABLE_KEY='sb_publishable_971K_Gj5xcyfxuLof3wGZA_ChEcm0iq';
const adminCache=new Map();
module.exports=function registerVerificationAdmin(app,pool){
 const requireAdmin=async(req,res,next)=>{
  const match=/^Bearer ([-\w.]+)$/.exec(req.headers.authorization||'');
  if(!match)return res.status(401).json({error:'login_required'});
  if(!pool)return res.status(503).json({error:'database_unavailable'});
  try{
   // Validate the token with Supabase Auth on EVERY privileged request.
   const response=await fetch(SUPABASE_URL+'/auth/v1/user',{headers:{apikey:PUBLISHABLE_KEY,Authorization:'Bearer '+match[1]}});
   if(!response.ok)return res.status(401).json({error:'invalid_session'});
   const user=await response.json();
   if(!/^[0-9a-f-]{36}$/i.test(user.id||''))return res.status(401).json({error:'invalid_session'});
   const allowed=await pool.query('SELECT 1 FROM lussan_booking.verification_admins WHERE user_id=$1',[user.id]);
   if(!allowed.rowCount)return res.status(403).json({error:'not_authorized'});
   req.verificationAdminId=user.id;next();
  }catch(e){console.error('verification admin auth failed',e.code||'unavailable');res.status(503).json({error:'authentication_unavailable'})}
 };
 app.get('/api/verification-admin/me',requireAdmin,(req,res)=>res.json({authorized:true}));
 app.get('/api/verification-admin/queue',requireAdmin,async(req,res)=>{
  try{
   const q=await pool.query(`SELECT v.id,v.cart_order_id,v.verification_status,v.created_at,'photos' AS product FROM lussan_booking.photo_verifications v
   UNION ALL SELECT v.id,v.cart_order_id,v.verification_status,v.created_at,'magazine' AS product FROM lussan_booking.magazine_verifications v
   ORDER BY created_at DESC LIMIT 100`);
   res.json({requests:q.rows});
  }catch(e){console.error('verification queue error',e.code||'unavailable');res.status(503).json({error:'queue_unavailable'})}
 });
};
