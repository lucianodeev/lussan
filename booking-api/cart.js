'use strict';
const crypto=require('node:crypto');
const massagePrices={30:8000,60:15000,90:22500,120:30000};
function buildCart(skus,services,allowRetired=false){
 if(!Array.isArray(skus)||!skus.length||skus.length>12||new Set(skus).size!==skus.length)throw Error('invalid_cart');
 let massage=0,photos=0,physicalMinutes=0;
 const items=skus.map(sku=>{
  if(typeof sku!=='string'||!allowRetired&&/^(voice|video)_/.test(sku))throw Error('invalid_cart');
  if(/^massage_(30|60|90|120)$/.test(sku)){if(massage)throw Error('one_massage');massage=Number(sku.split('_')[1]);physicalMinutes+=massage;return {sku,name:'Massagem com Lussan & Pedro — '+massage+' min',amount:massagePrices[massage]}}
  if(/^photos_(3|5|10)$/.test(sku)){if(photos)throw Error('one_photo_package');photos=Number(sku.split('_')[1]);return {sku,name:'Fotos — '+photos+' fotos',amount:{3:2000,5:3000,10:5000}[photos]}}
  if(!Object.hasOwn(services,sku))throw Error('invalid_cart');
  const item=services[sku];if(item.kind==='physical')physicalMinutes+=sku==='wax_legs'?60:30;
  return {sku,name:item.name,amount:item.amount};
 });
 if(skus.includes('wax_chest_abdomen')&&(skus.includes('wax_chest')||skus.includes('wax_abdomen')))throw Error('overlapping_wax');
 return {items,massage,photos,physicalMinutes,total:items.reduce((n,x)=>n+x.amount,0)};
}
function initialize({app,pool,stripe,paymentReady,liveEnabled,services}){
 const zone='Europe/Brussels';
 const stamp=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date()).replace(' ','T');
 const clean=(x,max)=>typeof x==='string'&&x.trim().length<=max?x.trim():'';
 const phone=x=>/^[+\d ()-]+$/.test(x)&&x.replace(/\D/g,'').length>=7&&x.replace(/\D/g,'').length<=15;
 const line=x=>({price_data:{currency:'eur',unit_amount:x.amount,product_data:{name:x.name}},quantity:1});
 const secure=(_,res,next)=>{res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');next()};
 async function checkout(id,res){
  let client;let session;let created=false;try{
   client=await pool.connect();await client.query('BEGIN');
   const r=await client.query('SELECT * FROM lussan_booking.cart_orders WHERE id=$1 FOR UPDATE',[id]);const order=r.rows[0];
   if(!order||!['approved','pending'].includes(order.status)||new Date(order.valid_until)<=new Date())throw Error('quote_unavailable');
   if(order.stripe_checkout_session_id){session=await stripe.checkout.sessions.retrieve(order.stripe_checkout_session_id);if(session.status!=='open')throw Error('checkout_unavailable');await client.query('COMMIT');return res.json({url:session.url})}
   const data=order.payload,cart=buildCart(data.skus,services);
   const costs=order.cost_items;
   if(!Array.isArray(costs)||costs.some(x=>typeof x.name!=='string'||x.name.length>150||!Number.isSafeInteger(x.amount)||x.amount<=0)||cart.total+costs.reduce((n,x)=>n+x.amount,0)!==order.amount_cents)throw Error('invalid_quote');
   let appointment;
   if(cart.physicalMinutes){
    const {date,time}=data;const start=Number(time.slice(0,2))*60+Number(time.slice(3)),end=start+cart.physicalMinutes;
    if(date+'T'+time<=stamp()||end>1380)throw Error('invalid_schedule');
    // Travel quotes reserve the complete working day for the duo. Adjacent travel days are confirmed by the owner.
    const format=m=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
    const begin=data.location==='travel'?'11:00':format(data.location==='local'?Math.max(660,start-30):start),finish=data.location==='travel'?'23:00':format(data.location==='local'?Math.min(1380,end+30):end);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[date]);
    const busy=await client.query("SELECT 1 FROM lussan_booking.appointments WHERE service_date=$1 AND status IN ('pending','confirmed') AND start_time<$3 AND end_time>$2 UNION ALL SELECT 1 FROM lussan_booking.blocked_slots WHERE service_date=$1 AND start_time<$3 AND end_time>$2 LIMIT 1",[date,begin,finish]);
    if(busy.rowCount)throw Error('slot_unavailable');
    const a=await client.query("INSERT INTO lussan_booking.appointments(service_date,start_time,end_time,duration_minutes,amount_cents,client_name,client_contact,status) VALUES($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id",[date,begin,finish,cart.massage||30,order.amount_cents,data.name,data.contact]);appointment=a.rows[0].id;
   }
   session=await stripe.checkout.sessions.create({mode:'payment',client_reference_id:id,metadata:{project:'lussan',order_type:'cart'},line_items:[...cart.items,...costs].map(line),success_url:'https://lussan.onrender.com/?payment=processing&session_id={CHECKOUT_SESSION_ID}',cancel_url:'https://lussan.onrender.com/?payment=cancelled#cart',expires_at:Math.floor(Date.now()/1000)+1800},{idempotencyKey:'lussan-cart-'+id});
   created=true;
   if(appointment)await client.query('UPDATE lussan_booking.appointments SET stripe_checkout_session_id=$1 WHERE id=$2',[session.id,appointment]);
   await client.query("UPDATE lussan_booking.cart_orders SET status='pending',stripe_checkout_session_id=$1,appointment_id=$2 WHERE id=$3",[session.id,appointment||null,id]);
   await client.query('COMMIT');return res.json({url:session.url});
  }catch(e){if(client)await client.query('ROLLBACK');if(created&&session?.id)try{await stripe.checkout.sessions.expire(session.id)}catch{};console.error('cart checkout:',e.code||e.message);return res.status(['slot_unavailable','invalid_schedule','quote_unavailable','checkout_unavailable','invalid_quote'].includes(e.message)?409:503).json({error:['slot_unavailable','invalid_schedule','quote_unavailable'].includes(e.message)?e.message:'checkout_unavailable'})}finally{client?.release()}
 }
 app.post('/api/cart',secure,async(req,res)=>{
  if(!paymentReady())return res.status(503).json({error:'checkout_not_configured'});
  let cart;try{cart=buildCart(req.body?.skus,services)}catch(e){return res.status(400).json({error:e.message})}
  const b=req.body||{},name=clean(b.name,100),contact=clean(b.contact,100),details=clean(b.details,1000),location=b.location||'onsite';
  if(name.length<2||!phone(contact)||!['onsite','local','travel'].includes(location)||typeof b.details==='string'&&b.details.length>1000)return res.status(400).json({error:'invalid_contact'});
  if(cart.physicalMinutes>720)return res.status(400).json({error:'invalid_schedule'});
 const payload={skus:cart.items.map(x=>x.sku),name,contact,details,location};
  if(cart.photos){const method=b.photoMethod||'whatsapp',delivery=method==='whatsapp'?contact:clean(b.photoContact,254);if(!['email','whatsapp'].includes(method)||method==='email'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(delivery)||details.length<3)return res.status(400).json({error:'invalid_photo_details'});payload.photoMethod=method;payload.photoContact=delivery}
  if(cart.physicalMinutes){
   if(typeof b.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(b.date)||Number.isNaN(Date.parse(b.date))||new Date(b.date).toISOString().slice(0,10)!==b.date||!/^([01]\d|2[0-3]):(00|30)$/.test(b.time||''))return res.status(400).json({error:'invalid_schedule'});
   const start=Number(b.time.slice(0,2))*60+Number(b.time.slice(3));if(b.date+'T'+b.time<=stamp()||start<660||start+cart.physicalMinutes>1380)return res.status(400).json({error:'invalid_schedule'});payload.date=b.date;payload.time=b.time;
  }else if(location!=='onsite')return res.status(400).json({error:'travel_requires_physical_service'});
  if(location==='travel'&&cart.massage<120)return res.status(400).json({error:'travel_minimum_120'});
  if(location!=='onsite'){
   const address=clean(b.address,400),city=clean(b.city,100),country=clean(b.country,100);if(address.length<5||city.length<2||country.length<2)return res.status(400).json({error:'invalid_address'});
   if(!['plane','bus','train','car'].includes(b.transport))return res.status(400).json({error:'invalid_transport'});
   const nights=Number(b.nights||0),transportBudget=Number(b.transportBudget||0),hotelBudget=Number(b.hotelBudget||0),travelHours=Number(b.travelHours||0);
   if(!Number.isInteger(nights)||nights<0||nights>14||![transportBudget,hotelBudget,travelHours].every(Number.isFinite)||transportBudget<0||transportBudget>10000||hotelBudget<0||hotelBudget>2000||travelHours<0||travelHours>72)return res.status(400).json({error:'invalid_budget'});
   Object.assign(payload,{address,city,country,transport:b.transport,nights,transportBudget,hotelBudget,travelHours,professionals:2,origin:'Brussels'});
  }
  try{
   const token=crypto.randomBytes(32).toString('hex');
   const r=await pool.query('INSERT INTO lussan_booking.cart_orders(payload,amount_cents,status,quote_token) VALUES($1::jsonb,$2,$3,$4) RETURNING id',[JSON.stringify(payload),cart.total,location==='onsite'?'approved':'requested',token]);
   if(location==='onsite')return checkout(r.rows[0].id,res);
   // Budgets are informational only. Only owner-approved cost_items can be charged.
   const estimate=cart.total+(location==='local'?2500:Math.round(payload.transportBudget*100+payload.nights*payload.hotelBudget*100+payload.travelHours*6000));
   return res.status(201).json({quoteUrl:'https://lussan.onrender.com/?quote='+token+'#cart',reference:r.rows[0].id,estimateCents:estimate,status:'requested'});
  }catch(e){console.error('cart request:',e.code||'unknown');return res.status(503).json({error:'cart_unavailable'})}
 });
 app.get('/api/cart-quotes/:token',secure,async(req,res)=>{
  if(!/^[a-f0-9]{64}$/.test(req.params.token))return res.sendStatus(404);
  try{const r=await pool.query('SELECT status,amount_cents,cost_items,payload,valid_until FROM lussan_booking.cart_orders WHERE quote_token=$1',[req.params.token]);const o=r.rows[0];if(!o)return res.sendStatus(404);return res.json({status:o.status,total:o.amount_cents,items:buildCart(o.payload.skus,services,true).items,costs:o.cost_items,date:o.payload.date,time:o.payload.time,location:o.payload.location,validUntil:o.valid_until,canPay:['approved','pending'].includes(o.status)&&new Date(o.valid_until)>new Date()})}catch(e){return res.sendStatus(503)}
 });
 app.post('/api/cart-quote-checkout',secure,async(req,res)=>{
  if(!paymentReady()||!/^[a-f0-9]{64}$/.test(req.body?.token||''))return res.sendStatus(400);
  try{const r=await pool.query('SELECT id FROM lussan_booking.cart_orders WHERE quote_token=$1',[req.body.token]);if(!r.rowCount)return res.sendStatus(404);return checkout(r.rows[0].id,res)}catch(e){return res.sendStatus(503)}
 });
 async function webhook(event,res){
  const s=event.data.object;if(s.metadata?.project!=='lussan'||s.metadata?.order_type!=='cart')return false;
  if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)&&s.payment_status==='paid'){
   if(s.livemode!==liveEnabled||s.currency!=='eur'){res.sendStatus(400);return true}
   let c;try{c=await pool.connect();await c.query('BEGIN');const r=await c.query("UPDATE lussan_booking.cart_orders SET status='confirmed',paid_at=COALESCE(paid_at,now()) WHERE id=$1 AND stripe_checkout_session_id=$2 AND amount_cents=$3 AND status IN ('pending','confirmed') RETURNING appointment_id",[s.client_reference_id,s.id,s.amount_total]);if(!r.rowCount){await c.query('ROLLBACK');res.sendStatus(409);return true}if(r.rows[0].appointment_id)await c.query("UPDATE lussan_booking.appointments SET status='confirmed',paid_at=COALESCE(paid_at,now()) WHERE id=$1 AND status IN ('pending','confirmed')",[r.rows[0].appointment_id]);await c.query('COMMIT')}catch(e){if(c)await c.query('ROLLBACK');res.sendStatus(503);return true}finally{c?.release()}
  }
  if(['checkout.session.expired','checkout.session.async_payment_failed'].includes(event.type)){
   let c;try{c=await pool.connect();await c.query('BEGIN');const r=await c.query("UPDATE lussan_booking.cart_orders SET status='cancelled' WHERE stripe_checkout_session_id=$1 AND status='pending' RETURNING appointment_id",[s.id]);if(r.rows[0]?.appointment_id)await c.query("UPDATE lussan_booking.appointments SET status='cancelled' WHERE id=$1 AND status='pending'",[r.rows[0].appointment_id]);await c.query('COMMIT')}catch(e){if(c)await c.query('ROLLBACK');res.sendStatus(503);return true}finally{c?.release()}
  }
  res.json({received:true});return true;
 }
 async function status(session,res){
  if(session.metadata?.project!=='lussan'||session.metadata?.order_type!=='cart')return false;
  const r=await pool.query('SELECT * FROM lussan_booking.cart_orders WHERE id=$1 AND stripe_checkout_session_id=$2',[session.client_reference_id,session.id]);const o=r.rows[0];if(!o){res.status(404).json({verified:false});return true}
  const verified=o.status==='confirmed'&&session.currency==='eur'&&o.amount_cents===session.amount_total;
  res.json({kind:'cart',status:o.status,verified,...(verified?{items:buildCart(o.payload.skus,services,true).items,costs:o.cost_items,contact:o.payload.contact,details:o.payload.details,date:o.payload.date,time:o.payload.time,location:o.payload.location,address:o.payload.address,photoMethod:o.payload.photoMethod,photoContact:o.payload.photoContact,deliveryDueAt:o.paid_at?new Date(new Date(o.paid_at).getTime()+3*86400000).toISOString():null}:{})});return true;
 }
 return {webhook,status};
}
module.exports={initialize,buildCart};
