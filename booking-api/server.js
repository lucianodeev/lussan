'use strict';
const express=require('express');
const {Pool}=require('pg');
const databaseConfig=require('./database-config');
const app=express();
app.disable('x-powered-by');
const Stripe=require('stripe');
const stripe=process.env.STRIPE_SECRET_KEY?new Stripe(process.env.STRIPE_SECRET_KEY):null;
const liveEnabled=process.env.ENABLE_LIVE_PAYMENTS==='true';
const stripeMode=liveEnabled?'live':'test';
const modeKey=()=>new RegExp('^(sk|rk)_'+stripeMode+'_').test(process.env.STRIPE_SECRET_KEY||'');
const paymentReady=()=>Boolean(stripe&&modeKey()&&process.env.STRIPE_WEBHOOK_SECRET&&process.env.DATABASE_URL);
app.post('/api/stripe-webhook',express.raw({type:'application/json'}),async(req,res)=>{
 if(!paymentReady())return res.sendStatus(503);
 let event;
 try{event=stripe.webhooks.constructEvent(req.body,req.headers['stripe-signature'],process.env.STRIPE_WEBHOOK_SECRET)}catch(e){return res.sendStatus(400)}
 if(await cartApi.webhook(event,res))return;
 const session=event.data.object;
 const photos=session.metadata?.order_type==='photos'&&session.metadata?.project==='lussan';
 const services=session.metadata?.order_type==='service'&&session.metadata?.project==='lussan';
 if(!photos&&!services&&event.type.startsWith('checkout.session.')){
  if(session.metadata?.project&&session.metadata.project!=='lussan')return res.json({received:true});
  try{const own=await pool.query('SELECT 1 FROM lussan_booking.appointments WHERE stripe_checkout_session_id=$1',[session.id]);if(!own.rowCount)return res.json({received:true})}catch(e){return res.sendStatus(503)}
 }
 if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)&&session.payment_status==='paid'){
  if(session.livemode!==liveEnabled||session.currency!=='eur')return res.sendStatus(400);
  try{
   if(services){
    const result=await pool.query("UPDATE lussan_booking.service_orders SET status='confirmed',paid_at=now() WHERE id=$1 AND stripe_checkout_session_id=$2 AND status='pending' AND amount_cents=$3 RETURNING id",[session.client_reference_id,session.id,session.amount_total]);
    if(!result.rowCount){const already=await pool.query("SELECT 1 FROM lussan_booking.service_orders WHERE id=$1 AND stripe_checkout_session_id=$2 AND status IN ('confirmed','fulfilled') AND amount_cents=$3",[session.client_reference_id,session.id,session.amount_total]);if(!already.rowCount)return res.sendStatus(409)}
   }else if(photos){
    const result=await pool.query("UPDATE lussan_booking.photo_orders SET status='confirmed',paid_at=now(),delivery_due_at=now()+interval '3 days' WHERE id=$1 AND stripe_checkout_session_id=$2 AND status='pending' AND amount_cents=$3 RETURNING id",[session.client_reference_id,session.id,session.amount_total]);
    if(!result.rowCount){const already=await pool.query("SELECT 1 FROM lussan_booking.photo_orders WHERE id=$1 AND stripe_checkout_session_id=$2 AND status IN ('confirmed','delivered') AND amount_cents=$3",[session.client_reference_id,session.id,session.amount_total]);if(!already.rowCount)return res.sendStatus(409)}
   }else{
   const result=await pool.query("UPDATE lussan_booking.appointments SET status='confirmed',paid_at=now() WHERE id=$1 AND stripe_checkout_session_id=$2 AND status='pending' AND amount_cents=$3 RETURNING id",[session.client_reference_id,session.id,session.amount_total]);
   if(!result.rowCount){const already=await pool.query("SELECT 1 FROM lussan_booking.appointments WHERE id=$1 AND stripe_checkout_session_id=$2 AND status='confirmed'",[session.client_reference_id,session.id]);if(!already.rowCount)return res.sendStatus(409)}
   }
  }catch(e){return res.sendStatus(503)}
 }
 if(['checkout.session.expired','checkout.session.async_payment_failed'].includes(event.type)){
  try{const table=services?'service_orders':photos?'photo_orders':'appointments';await pool.query("UPDATE lussan_booking."+table+" SET status='cancelled' WHERE stripe_checkout_session_id=$1 AND status='pending'",[session.id])}catch(e){return res.sendStatus(503)}
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
const pool=process.env.DATABASE_URL?new Pool(databaseConfig(process.env.DATABASE_URL)):null;
const ZONE='Europe/Brussels';
const prices={30:8000,60:15000,90:22500,120:30000};
function localDate(){return new Intl.DateTimeFormat('en-CA',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
const timeRe=/^([01]\d|2[0-3]):(00|30)$/;
function check(date,time,duration){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!timeRe.test(time)||!prices[duration])return false;
 const mins=Number(time.slice(0,2))*60+Number(time.slice(3));
 if(mins<660||mins+duration>1380||date<localDate()||date+'T'+time<=new Intl.DateTimeFormat('sv-SE',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date()).replace(' ','T'))return false;
 return true;
}
app.get('/health',(_,res)=>res.json({ok:true}));
app.get('/api/readiness',async(_req,res)=>{
 const status={api:'ok',database:'unavailable',stripe_test:!liveEnabled&&paymentReady()?'configured':'not_ready',stripe_live:liveEnabled&&paymentReady()?'configured':'not_ready',live_payments:liveEnabled?'enabled':'disabled',configuration:{database_url:Boolean(process.env.DATABASE_URL),stripe_mode:stripeMode,stripe_key_valid:modeKey(),webhook_secret:Boolean(process.env.STRIPE_WEBHOOK_SECRET)}};
 if(!pool)return res.status(503).json(status);
 try{await pool.query('SELECT 1 FROM lussan_booking.appointments LIMIT 1');status.database='connected';return res.json(status)}
 catch(e){const code=String(e.code||'');const category=code==='28P01'?'authentication':code==='3D000'?'database_name':code==='42P01'?'schema_or_table':code==='ENOTFOUND'?'dns':code==='ETIMEDOUT'||code==='ECONNREFUSED'?'network':/CERT|TLS|SSL|SELF_SIGNED/i.test(code+' '+e.message)?'tls_certificate':'connection_other';console.error('database readiness failure:',category,'code:',code||'unknown');return res.status(503).json(status)}
});
const serviceCatalog={"messages_20":{"name":"Conversa por mensagens no WhatsApp — 20 min","amount":1500,"kind":"online","duration":20},"messages_30":{"name":"Conversa por mensagens no WhatsApp — 30 min","amount":2000,"kind":"online","duration":30},"messages_60":{"name":"Conversa por mensagens no WhatsApp — 60 min","amount":3500,"kind":"online","duration":60},"voice_20":{"name":"Conversa por chamada de voz — 20 min","amount":2000,"kind":"online","duration":20},"voice_30":{"name":"Conversa por chamada de voz — 30 min","amount":2500,"kind":"online","duration":30},"voice_60":{"name":"Conversa por chamada de voz — 60 min","amount":4500,"kind":"online","duration":60},"video_20":{"name":"Videochamada — 20 min","amount":2500,"kind":"online","duration":20},"video_30":{"name":"Videochamada — 30 min","amount":3500,"kind":"online","duration":30},"video_60":{"name":"Videochamada — 60 min","amount":6000,"kind":"online","duration":60},"wax_underarms":{"name":"Depilação masculina com cera fria — Axilas","amount":1500,"kind":"physical"},"wax_shoulders":{"name":"Depilação masculina com cera fria — Ombros","amount":2000,"kind":"physical"},"wax_chest":{"name":"Depilação masculina com cera fria — Peito","amount":3500,"kind":"physical"},"wax_abdomen":{"name":"Depilação masculina com cera fria — Abdómen","amount":2500,"kind":"physical"},"wax_back":{"name":"Depilação masculina com cera fria — Costas","amount":3500,"kind":"physical"},"wax_arms":{"name":"Depilação masculina com cera fria — Braços completos","amount":3000,"kind":"physical"},"wax_legs":{"name":"Depilação masculina com cera fria — Pernas completas","amount":4500,"kind":"physical"},"wax_chest_abdomen":{"name":"Depilação masculina com cera fria — Peito + abdómen","amount":5000,"kind":"physical"}};
const cartApi=require('./cart').initialize({app,pool,stripe,paymentReady,liveEnabled,services:serviceCatalog});
app.post('/api/service-checkout',async(req,res)=>{
 if(!paymentReady())return res.status(503).json({error:'checkout_not_configured'});
 const sku=typeof req.body?.sku==='string'?req.body.sku:'';
 if(/^(voice|video)_/.test(sku)||!Object.hasOwn(serviceCatalog,sku))return res.status(400).json({error:'invalid_service'});
 const contact=typeof req.body?.contact==='string'?req.body.contact.trim():'';
 const details=typeof req.body?.details==='string'?req.body.details.trim():'';
 if(details.length>1000||contact.length>100||!/^[+\d ()-]+$/.test(contact)||contact.replace(/\D/g,'').length<7||contact.replace(/\D/g,'').length>15)return res.status(400).json({error:'invalid_service_contact'});
 const item=serviceCatalog[sku];let id;
 try{
  const result=await pool.query('INSERT INTO lussan_booking.service_orders(sku,amount_cents,client_contact,request_details) VALUES($1,$2,$3,$4) RETURNING id',[sku,item.amount,contact,details]);id=result.rows[0].id;
  const session=await stripe.checkout.sessions.create({mode:'payment',client_reference_id:id,
   metadata:{project:'lussan',order_type:'service',sku},
   line_items:[{price_data:{currency:'eur',unit_amount:item.amount,product_data:{name:item.name,description:'Horário combinado pelo WhatsApp após confirmação do pagamento.'}},quantity:1}],
   success_url:'https://lussan.onrender.com/?payment=processing&session_id={CHECKOUT_SESSION_ID}',cancel_url:'https://lussan.onrender.com/?payment=cancelled#service-order',expires_at:Math.floor(Date.now()/1000)+1800
  },{idempotencyKey:'lussan-service-'+id});
  await pool.query('UPDATE lussan_booking.service_orders SET stripe_checkout_session_id=$1 WHERE id=$2',[session.id,id]);return res.json({url:session.url});
 }catch(e){if(id)try{await pool.query("UPDATE lussan_booking.service_orders SET status='cancelled' WHERE id=$1 AND status='pending'",[id])}catch{};console.error('service checkout error',e.code||e.type||'unknown');return res.status(503).json({error:'service_checkout_unavailable'})}
});

const photoPrices={3:2000,5:3000,10:5000};
app.post('/api/photo-checkout',async(req,res)=>{
 if(!paymentReady())return res.status(503).json({error:'checkout_not_configured'});
 const count=Number(req.body?.count),method=req.body?.deliveryMethod;
 const contact=typeof req.body?.contact==='string'?req.body.contact.trim():'';
 const details=typeof req.body?.details==='string'?req.body.details.trim():'';
 if(details.length<3||details.length>1000)return res.status(400).json({error:'invalid_photo_details'});
 if(!photoPrices[count]||!['email','whatsapp'].includes(method)||contact.length>254||(method==='email'?!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact):!/^[+\d ()-]+$/.test(contact)||contact.replace(/\D/g,'').length<7||contact.replace(/\D/g,'').length>15))return res.status(400).json({error:'invalid_photo_order'});
 let id;
 try{
  const result=await pool.query('INSERT INTO lussan_booking.photo_orders(package_count,amount_cents,delivery_method,delivery_contact,request_details) VALUES($1,$2,$3,$4,$5) RETURNING id',[count,photoPrices[count],method,contact,details]);id=result.rows[0].id;
  const session=await stripe.checkout.sessions.create({mode:'payment',client_reference_id:id,
   metadata:{project:'lussan',order_type:'photos',package_count:String(count),delivery_method:method,delivery_contact:contact},
   ...(method==='email'?{customer_email:contact}:{}),
   line_items:[{price_data:{currency:'eur',unit_amount:photoPrices[count],product_data:{name:'Fotos — '+count+' fotos',description:'Entrega em até 3 dias após confirmação do pagamento, por link do Drive enviado por e-mail ou WhatsApp.'}},quantity:1}],
   success_url:'https://lussan.onrender.com/?payment=processing&session_id={CHECKOUT_SESSION_ID}',cancel_url:'https://lussan.onrender.com/?payment=cancelled#private-photos',expires_at:Math.floor(Date.now()/1000)+1800
  },{idempotencyKey:'lussan-photos-'+id});
  await pool.query('UPDATE lussan_booking.photo_orders SET stripe_checkout_session_id=$1 WHERE id=$2',[session.id,id]);
  return res.json({url:session.url});
 }catch(e){if(id)try{await pool.query("UPDATE lussan_booking.photo_orders SET status='cancelled' WHERE id=$1 AND status='pending'",[id])}catch{};console.error('photo checkout error',e.code||e.type||'unknown');return res.status(503).json({error:'photo_checkout_unavailable'})}
});
app.get('/api/availability',async(req,res)=>{
 const {date}=req.query;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))return res.status(400).json({error:'invalid_date'});
 if(!pool)return res.status(503).json({error:'database_not_configured'});try{const r=await pool.query("SELECT start_time,end_time FROM lussan_booking.appointments WHERE service_date=$1 AND status IN ('pending','confirmed') UNION ALL SELECT start_time,end_time FROM lussan_booking.blocked_slots WHERE service_date=$1",[date]);res.json({date,timezone:ZONE,busy:r.rows})}catch(e){res.status(503).json({error:'unavailable'})}
});
app.post('/api/booking-requests',async(req,res)=>{
 const {date,time,duration,name,contact}=req.body||{};
 if(!paymentReady())return res.status(503).json({error:'checkout_not_configured'});
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
   mode:'payment',client_reference_id:id,metadata:{project:'lussan',order_type:'massage'},
   line_items:[{price_data:{currency:'eur',unit_amount:booking.amount_cents,product_data:{name:'Massagem — '+booking.duration_minutes+' min'}},quantity:1}],
   success_url:'https://lussan.onrender.com/?payment=processing&session_id={CHECKOUT_SESSION_ID}',
   cancel_url:'https://lussan.onrender.com/?payment=cancelled',
   expires_at:Math.floor(Date.now()/1000)+1800
  },{idempotencyKey:'lussan-massage-'+id});
  const saved=await pool.query("UPDATE lussan_booking.appointments SET stripe_checkout_session_id=$1 WHERE id=$2 AND status='pending' AND stripe_checkout_session_id IS NULL RETURNING id",[session.id,id]);
  if(!saved.rowCount)return res.status(409).json({error:'booking_unavailable'});
  res.json({url:session.url});
 }catch(e){console.error('checkout error',e.code||e.type||'unknown');res.status(503).json({error:'checkout_unavailable'})}
});
app.get('/api/payment-status',async(req,res)=>{
 const id=String(req.query.session_id||'');
 if(!new RegExp('^cs_'+stripeMode+'_[a-zA-Z0-9]+$').test(id)||!paymentReady())return res.status(400).json({verified:false});
 try{
  const session=await stripe.checkout.sessions.retrieve(id);
  if(session.livemode!==liveEnabled)return res.status(400).json({verified:false});
  if(session.payment_status!=='paid')return res.json({verified:false,status:'pending'});
  if(await cartApi.status(session,res))return;
  if(session.metadata?.project==='lussan'&&session.metadata?.order_type==='service'){
   const result=await pool.query('SELECT sku,status,client_contact,request_details,amount_cents FROM lussan_booking.service_orders WHERE stripe_checkout_session_id=$1 AND id=$2',[id,session.client_reference_id]);
   if(!result.rowCount)return res.status(404).json({verified:false});const order=result.rows[0],item=serviceCatalog[order.sku];
   return res.json({kind:'service',verified:Boolean(item)&&['confirmed','fulfilled'].includes(order.status)&&order.amount_cents===session.amount_total&&session.currency==='eur',status:order.status,serviceName:item?.name,contact:order.client_contact,details:order.request_details});
  }
  if(session.metadata?.project==='lussan'&&session.metadata?.order_type==='photos'){
   const result=await pool.query('SELECT status,package_count,delivery_method,delivery_contact,request_details,delivery_due_at,amount_cents FROM lussan_booking.photo_orders WHERE stripe_checkout_session_id=$1 AND id=$2',[id,session.client_reference_id]);
   if(!result.rowCount)return res.status(404).json({verified:false});const order=result.rows[0];
   return res.json({kind:'photos',verified:['confirmed','delivered'].includes(order.status)&&order.amount_cents===session.amount_total&&session.currency==='eur',status:order.status,count:order.package_count,deliveryMethod:order.delivery_method,contact:order.delivery_contact,details:order.request_details,deliveryDueAt:order.delivery_due_at});
  }
  const result=await pool.query("SELECT id,status,duration_minutes,service_date,start_time FROM lussan_booking.appointments WHERE stripe_checkout_session_id=$1 AND id=$2",[id,session.client_reference_id]);
  if(!result.rowCount)return res.status(404).json({verified:false});
  const booking=result.rows[0];
  return res.json({verified:booking.status==='confirmed',status:booking.status,date:booking.service_date instanceof Date?new Intl.DateTimeFormat('en-CA',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(booking.service_date):booking.service_date,time:booking.start_time,duration:booking.duration_minutes});
 }catch(e){console.error('payment status error',e.code||'unknown');return res.status(503).json({verified:false})}
});
app.listen(process.env.PORT||3000,()=>console.log('Lussan booking API listening'));
