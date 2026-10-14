'use strict';
const express=require('express');
const {Pool}=require('pg');
const app=express();
app.disable('x-powered-by');
const Stripe=require('stripe');
const stripe=process.env.STRIPE_SECRET_KEY?new Stripe(process.env.STRIPE_SECRET_KEY):null;
const paymentReady=()=>Boolean(stripe&&process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')&&process.env.STRIPE_WEBHOOK_SECRET&&process.env.DATABASE_URL);
app.post('/api/stripe-webhook',express.raw({type:'application/json'}),async(req,res)=>{
 if(!paymentReady())return res.sendStatus(503);
 let event;
 try{event=stripe.webhooks.constructEvent(req.body,req.headers['stripe-signature'],process.env.STRIPE_WEBHOOK_SECRET)}catch(e){return res.sendStatus(400)}
 const session=event.data.object;
 if(event.type==='checkout.session.completed'&&session.payment_status==='paid'){
  try{
   const result=await pool.query("UPDATE lussan_booking.appointments SET status='confirmed',paid_at=now() WHERE id=$1 AND stripe_checkout_session_id=$2 AND status='pending' AND amount_cents=$3 RETURNING id",[session.client_reference_id,session.id,session.amount_total]);
   if(!result.rowCount){const already=await pool.query("SELECT 1 FROM lussan_booking.appointments WHERE id=$1 AND stripe_checkout_session_id=$2 AND status='confirmed'",[session.client_reference_id,session.id]);if(!already.rowCount)return res.sendStatus(409)}
  }catch(e){return res.sendStatus(503)}
 }
 if(event.type==='checkout.session.expired'){
  try{await pool.query("UPDATE lussan_booking.appointments SET status='cancelled' WHERE stripe_checkout_session_id=$1 AND status='pending'",[session.id])}catch(e){return res.sendStatus(503)}
 }
 res.json({received:true});
});
app.use((req,res,next)=>{
 const origin=req.headers.origin;
 if(origin==='https://lussan.onrender.com'){
  res.setHeader('Access-Control-Allow-Origin',origin);
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
 }
 if(req.method==='OPTIONS')return res.sendStatus(origin==='https://lussan.onrender.com'?204:403);
 next();
});
app.use(express.json({limit:'8kb'}));
const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSL==='disable'?false:{rejectUnauthorized:true}}):null;
const ZONE='Europe/Brussels';
const prices={30:8000,60:15000,90:22500,120:30000};
function localDate(){return new Intl.DateTimeFormat('en-CA',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
const timeRe=/^([01]\d|2[0-3]):(00|30)$/;
function check(date,time,duration){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!timeRe.test(time)||!prices[duration])return false;
 const mins=Number(time.slice(0,2))*60+Number(time.slice(3));
 if(mins<660||mins+duration>1380||date<localDate())return false;
 return true;
}
app.get('/health',(_,res)=>res.json({ok:true}));
app.get('/api/readiness',async(_req,res)=>{
 const status={api:'ok',database:'unavailable',stripe_test:paymentReady()?'configured':'not_ready',live_payments:'disabled'};
 if(!pool)return res.status(503).json(status);
 try{await pool.query('SELECT 1 FROM lussan_booking.appointments LIMIT 1');status.database='connected';return res.json(status)}
 catch(e){const code=String(e.code||'');const category=code==='28P01'?'authentication':code==='3D000'?'database_name':code==='42P01'?'schema_or_table':code==='ENOTFOUND'?'dns':code==='ETIMEDOUT'||code==='ECONNREFUSED'?'network':/CERT|TLS|SSL|SELF_SIGNED/i.test(code+' '+e.message)?'tls_certificate':'connection_other';console.error('database readiness failure:',category,'code:',code||'unknown');return res.status(503).json(status)}
});
app.post('/api/photo-checkout',(_req,res)=>res.status(503).json({error:'photo_payments_pending_processor_approval'}));
app.get('/api/availability',async(req,res)=>{
 const {date}=req.query;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))return res.status(400).json({error:'invalid_date'});
 if(!pool)return res.status(503).json({error:'database_not_configured'});try{const r=await pool.query("SELECT start_time,end_time FROM lussan_booking.appointments WHERE service_date=$1 AND status IN ('pending','confirmed') UNION ALL SELECT start_time,end_time FROM lussan_booking.blocked_slots WHERE service_date=$1",[date]);res.json({date,timezone:ZONE,busy:r.rows})}catch(e){res.status(503).json({error:'unavailable'})}
});
app.post('/api/booking-requests',async(req,res)=>{
 const {date,time,duration,name,contact}=req.body||{};
 if(!check(date,time,Number(duration))||typeof name!=='string'||name.trim().length<2||name.length>100||typeof contact!=='string'||contact.trim().length<5||contact.length>160)return res.status(400).json({error:'invalid_request'});
 const start=Number(time.slice(0,2))*60+Number(time.slice(3)),end=start+Number(duration);
 const endTime=String(Math.floor(end/60)).padStart(2,'0')+':'+String(end%60).padStart(2,'0');
 if(!pool)return res.status(503).json({error:'database_not_configured'});let client;try{client=await pool.connect()}catch(e){return res.status(503).json({error:'unavailable'})}
 try{
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[date]);
  const collision=await client.query("SELECT 1 FROM lussan_booking.appointments WHERE service_date=$1 AND status IN ('pending','confirmed') AND start_time<$3 AND end_time>$2 UNION ALL SELECT 1 FROM lussan_booking.blocked_slots WHERE service_date=$1 AND start_time<$3 AND end_time>$2 LIMIT 1",[date,time,endTime]);
  if(collision.rowCount){await client.query('ROLLBACK');return res.status(409).json({error:'slot_unavailable'})}
  const result=await client.query("INSERT INTO lussan_booking.appointments(service_date,start_time,end_time,duration_minutes,amount_cents,client_name,client_contact,status) VALUES($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id,status",[date,time,endTime,Number(duration),prices[duration],name.trim(),contact.trim()]);
  await client.query('COMMIT');return res.status(201).json({id:result.rows[0].id,status:'pending',message:'Request received; payment not enabled'});
 }catch(e){await client.query('ROLLBACK');res.status(503).json({error:'unavailable'})}finally{client.release()}
});

app.post('/api/checkout',async(req,res)=>{
 if(!paymentReady())return res.status(503).json({error:'checkout_not_approved_or_configured'});
 const id=req.body?.bookingId;
 if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id))return res.status(400).json({error:'invalid_booking'});
 try{
  const result=await pool.query("SELECT id,amount_cents,duration_minutes,status,stripe_checkout_session_id FROM lussan_booking.appointments WHERE id=$1",[id]);
  const booking=result.rows[0];
  if(!booking||booking.status!=='pending')return res.status(409).json({error:'booking_unavailable'});
  if(booking.stripe_checkout_session_id)return res.status(409).json({error:'checkout_already_created'});
  const session=await stripe.checkout.sessions.create({
   mode:'payment',client_reference_id:id,
   line_items:[{price_data:{currency:'eur',unit_amount:booking.amount_cents,product_data:{name:'Massagem relaxante não sexual — '+booking.duration_minutes+' min'}},quantity:1}],
   success_url:'https://lussan.onrender.com/?payment=processing&session_id={CHECKOUT_SESSION_ID}',
   cancel_url:'https://lussan.onrender.com/?payment=cancelled',
   expires_at:Math.floor(Date.now()/1000)+1800
  },{idempotencyKey:'lussan-massage-'+id});
  const saved=await pool.query("UPDATE lussan_booking.appointments SET stripe_checkout_session_id=$1 WHERE id=$2 AND status='pending' AND stripe_checkout_session_id IS NULL RETURNING id",[session.id,id]);
  if(!saved.rowCount)return res.status(409).json({error:'booking_unavailable'});
  res.json({url:session.url});
 }catch(e){console.error('checkout error',e.message);res.status(503).json({error:'checkout_unavailable'})}
});
app.get('/api/payment-status',async(req,res)=>{
 const id=String(req.query.session_id||'');
 if(!/^cs_test_[a-zA-Z0-9]+$/.test(id)||!paymentReady())return res.status(400).json({verified:false});
 try{
  const session=await stripe.checkout.sessions.retrieve(id);
  if(session.payment_status!=='paid')return res.json({verified:false,status:'pending'});
  const result=await pool.query("SELECT id,status,duration_minutes,service_date,start_time FROM lussan_booking.appointments WHERE stripe_checkout_session_id=$1 AND id=$2",[id,session.client_reference_id]);
  if(!result.rowCount)return res.status(404).json({verified:false});
  const booking=result.rows[0];
  return res.json({verified:booking.status==='confirmed',status:booking.status,date:booking.service_date,time:booking.start_time,duration:booking.duration_minutes});
 }catch(e){console.error('payment status error',e.code||'unknown');return res.status(503).json({verified:false})}
});
app.listen(process.env.PORT||3000,()=>console.log('Lussan booking API listening'));
