'use strict';
const crypto=require('node:crypto');
const MAX=4*1024*1024,attempts=new Map();
const configured=()=>/^[a-f0-9]{64}$/i.test(process.env.LUSSAN_VERIFICATION_FILE_KEY||'');
const key=()=>Buffer.from(process.env.LUSSAN_VERIFICATION_FILE_KEY,'hex');
function encrypt(bytes,aad){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key(),iv);c.setAAD(Buffer.from(aad));const body=Buffer.concat([c.update(bytes),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body])}
function decrypt(bytes,aad){const d=crypto.createDecipheriv('aes-256-gcm',key(),bytes.subarray(0,12));d.setAuthTag(bytes.subarray(12,28));d.setAAD(Buffer.from(aad));return Buffer.concat([d.update(bytes.subarray(28)),d.final()])}
function image(file){
 if(!file||!['image/jpeg','image/png'].includes(file.type)||typeof file.data!=='string'||file.data.length>Math.ceil(MAX/3)*4||file.data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(file.data))throw Error('invalid_files');
 const b=Buffer.from(file.data,'base64');if(b.length<20||b.length>MAX||b.toString('base64')!==file.data)throw Error('invalid_files');
 const valid=file.type==='image/png'?b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):b[0]===255&&b[1]===216&&b[2]===255&&b[b.length-2]===255&&b[b.length-1]===217;
 if(!valid)throw Error('invalid_files');return {bytes:b,type:file.type};
}
const secure=(_req,res,next)=>{res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');res.set('X-Content-Type-Options','nosniff');next()};
async function order(pool,token,client=pool,lock=false){
 if(typeof token!=='string'||! /^[a-f0-9]{64}$/.test(token))return null;
 const r=await client.query("SELECT id,payload FROM lussan_booking.cart_orders WHERE quote_token=$1 AND status='confirmed' AND paid_at>now()-interval '30 days'"+(lock?' FOR UPDATE':''),[token]);
 const o=r.rows[0];return o&&o.payload?.skus?.some(s=>/^(photos_|magazine_)/.test(s))?o:null;
}
async function states(client,o){const products=o.payload.skus;let status='awaiting_submission';const result=await client.query('SELECT review_status,expires_at FROM lussan_booking.verification_uploads WHERE cart_order_id=$1',[o.id]);if(result.rows[0])status=new Date(result.rows[0].expires_at)<=new Date()?'expired':result.rows[0].review_status;return {status,photos:products.some(s=>s.startsWith('photos_')),magazine:products.includes('magazine_presale')}}
function registerPublic(app,pool){
 app.post('/api/verification-status',secure,async(req,res)=>{try{if(!pool||!configured())return res.status(503).json({error:'verification_not_configured'});const o=await order(pool,req.body?.token);if(!o)return res.status(404).json({error:'invalid_or_expired_link'});res.json(await states(pool,o))}catch{res.status(503).json({error:'verification_unavailable'})}});
 app.post('/api/verification-upload',secure,async(req,res)=>{
  if(!pool||!configured())return res.status(503).json({error:'verification_not_configured'});
  const now=Date.now();for(const [k,v] of attempts)if(v.until<=now)attempts.delete(k);const ip=req.ip||'unknown',record=attempts.get(ip)||{count:0,until:now+3600000};record.count++;attempts.set(ip,record);if(record.count>20)return res.status(429).json({error:'try_later'});
  let client;
  try{
   if(req.body?.consent!==true)return res.status(400).json({error:'consent_required'});
   const doc=image(req.body.document),selfie=image(req.body.selfie);
   client=await pool.connect();await client.query('BEGIN');const o=await order(pool,req.body.token,client,true);
   if(!o){await client.query('ROLLBACK');return res.status(404).json({error:'invalid_or_expired_link'})}
   const state=await states(client,o);if(['pending_review','approved'].includes(state.status)){await client.query('ROLLBACK');return res.json({accepted:true,status:state.status})}
   await client.query(`INSERT INTO lussan_booking.verification_uploads(cart_order_id,document_cipher,selfie_cipher,document_type,selfie_type,review_status,expires_at)
    VALUES($1,$2,$3,$4,$5,'pending_review',now()+interval '30 days') ON CONFLICT(cart_order_id) DO UPDATE SET document_cipher=EXCLUDED.document_cipher,selfie_cipher=EXCLUDED.selfie_cipher,document_type=EXCLUDED.document_type,selfie_type=EXCLUDED.selfie_type,review_status='pending_review',submitted_at=now(),reviewed_at=NULL,expires_at=EXCLUDED.expires_at`,[o.id,encrypt(doc.bytes,o.id+':document'),encrypt(selfie.bytes,o.id+':selfie'),doc.type,selfie.type]);
   if(state.photos)await client.query("INSERT INTO lussan_booking.photo_verifications(cart_order_id,verification_status) VALUES($1,'pending_review') ON CONFLICT(cart_order_id) DO UPDATE SET verification_status='pending_review'",[o.id]);
   if(state.magazine)await client.query("INSERT INTO lussan_booking.magazine_verifications(cart_order_id,verification_status,delivery_status) VALUES($1,'pending_review','not_released') ON CONFLICT(cart_order_id) DO UPDATE SET verification_status='pending_review',updated_at=now()",[o.id]);
   await client.query('COMMIT');res.json({accepted:true,status:'pending_review'});
  }catch(e){if(client)await client.query('ROLLBACK');res.status(e.message==='invalid_files'?400:503).json({error:e.message==='invalid_files'?'invalid_files':'upload_unavailable'})}finally{client?.release()}
 });
 // Expired documents are never returned; purge when this service starts and hourly while awake.
 if(pool){const purge=()=>pool.query('DELETE FROM lussan_booking.verification_uploads WHERE expires_at<=now()').catch(()=>{});purge();const timer=setInterval(purge,3600000);timer.unref()}
}
function registerAdmin(app,pool,requireAdmin){
 app.get('/api/private-admin/files/:orderId/:kind',secure,requireAdmin,async(req,res)=>{
  if(!configured())return res.status(503).json({error:'verification_not_configured'});
  const {orderId,kind}=req.params;if(!/^[0-9a-f-]{36}$/i.test(orderId)||!['document','selfie'].includes(kind))return res.sendStatus(404);
  try{const r=await pool.query('SELECT document_cipher,selfie_cipher,document_type,selfie_type FROM lussan_booking.verification_uploads WHERE cart_order_id=$1 AND expires_at>now()',[orderId]);const row=r.rows[0],bytes=row?.[kind+'_cipher'];if(!bytes)return res.sendStatus(404);res.set('Content-Type',row[kind+'_type']);res.set('Content-Security-Policy',"default-src 'none'; sandbox");res.set('Content-Disposition','attachment; filename="'+kind+(row[kind+'_type']==='image/png'?'.png':'.jpg')+'"');res.send(decrypt(bytes,orderId+':'+kind))}catch{res.status(503).json({error:'file_unavailable'})}
 });
 app.post('/api/private-admin/review',secure,requireAdmin,async(req,res)=>{
  const {orderId,decision}=req.body||{};if(!/^[0-9a-f-]{36}$/i.test(orderId||'')||!['approved','rejected'].includes(decision))return res.status(400).json({error:'invalid_review'});
  let c;try{c=await pool.connect();await c.query('BEGIN');const r=await c.query("UPDATE lussan_booking.verification_uploads SET review_status=$2,reviewed_at=now(),document_cipher=NULL,selfie_cipher=NULL WHERE cart_order_id=$1 AND review_status='pending_review' AND expires_at>now() RETURNING cart_order_id",[orderId,decision]);if(!r.rowCount){await c.query('ROLLBACK');return res.status(409).json({error:'not_pending'})}await c.query('UPDATE lussan_booking.photo_verifications SET verification_status=$2,reviewed_at=now() WHERE cart_order_id=$1',[orderId,decision]);await c.query('UPDATE lussan_booking.magazine_verifications SET verification_status=$2,verified_at=CASE WHEN $2=\'approved\' THEN now() ELSE NULL END,updated_at=now() WHERE cart_order_id=$1',[orderId,decision]);await c.query('COMMIT');res.json({updated:true,status:decision})}catch{if(c)await c.query('ROLLBACK');res.status(503).json({error:'review_unavailable'})}finally{c?.release()}
 });
}
module.exports={configured,registerPublic,registerAdmin,image,encrypt,decrypt};
