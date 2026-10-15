'use strict';
const assert=require('node:assert/strict');
const {initialize,buildCart}=require('../cart');
const orders=new Map(),sessions=new Map(),routes=new Map();let serial=0,checkoutCalls=0,mailCalls=[];
const crypto=require('node:crypto');
process.env.LUSSAN_VERIFICATION_FILE_KEY='a'.repeat(64);
delete process.env.RESEND_API_KEY;delete process.env.LUSSAN_ADMIN_MAIL_FROM;
const client={release(){},async query(sql,p=[]){
 if(sql.startsWith('INSERT INTO lussan_booking.cart_orders')){const id=crypto.randomUUID();orders.set(id,{id,payload:JSON.parse(p[0]),amount_cents:p[1],status:p[2],quote_token:p[3],cost_items:null,valid_until:new Date(Date.now()+86400000)});return {rowCount:1,rows:[{id}]}}
 if(sql.startsWith('SELECT * FROM lussan_booking.cart_orders')){const o=orders.get(p[0]);return {rowCount:o?1:0,rows:o?[o]:[]}}
 if(sql.startsWith("UPDATE lussan_booking.cart_orders SET status='pending'")){Object.assign(orders.get(p[2]),{status:'pending',stripe_checkout_session_id:p[0],appointment_id:p[1]});return {rowCount:1,rows:[]}}
 if(sql.startsWith("UPDATE lussan_booking.cart_orders SET status='confirmed'")){const o=orders.get(p[0]);if(!o||o.stripe_checkout_session_id!==p[1]||o.amount_cents!==p[2]||!['pending','confirmed'].includes(o.status))return {rowCount:0,rows:[]};o.status='confirmed';o.paid_at=new Date();return {rowCount:1,rows:[o]}}
 if(sql.startsWith("UPDATE lussan_booking.cart_orders SET status='cancelled'")){const o=[...orders.values()].find(o=>o.stripe_checkout_session_id===p[0]&&o.status==='pending');if(o)o.status='cancelled';return {rowCount:o?1:0,rows:o?[o]:[]}}
 if(sql.startsWith('SELECT status,amount_cents')){const o=[...orders.values()].find(o=>o.quote_token===p[0]);return {rowCount:o?1:0,rows:o?[o]:[]}}
 if(sql.startsWith('INSERT INTO lussan_booking.appointments'))return {rowCount:1,rows:[{id:crypto.randomUUID()}]};
 if(sql.includes('SELECT 1 FROM lussan_booking.appointments'))return {rowCount:0,rows:[]};
 return {rowCount:1,rows:[]};
}};
const pool={query:client.query,connect:async()=>client};
const stripe={checkout:{sessions:{async create(params){checkoutCalls++;const session={...params,id:'cs_test_fixture'+(++serial),url:'https://checkout.stripe.com/c/pay/fixture',status:'open',livemode:false,currency:'eur',payment_status:'unpaid',amount_total:params.line_items.reduce((n,i)=>n+i.price_data.unit_amount*i.quantity,0)};sessions.set(session.id,session);return session},async retrieve(id){return sessions.get(id)},async expire(){}}}};
const api=initialize({app:{get(p,...h){routes.set('GET '+p,h.at(-1))},post(p,...h){routes.set('POST '+p,h.at(-1))}},pool,stripe,paymentReady:()=>true,liveEnabled:false,services:{}});
const response=()=>({code:200,status(n){this.code=n;return this},json(body){this.body=body;return this},sendStatus(n){this.code=n;return this}});
const req=async(body)=>{const r=response();await routes.get('POST /api/cart')({body},r);return r};
const future=new Date(Date.now()+7*86400000).toISOString().slice(0,10);
const base={name:'QA Fixture',contact:'+32000000000',location:'onsite',date:future,time:'15:00',details:'Retrato natural',locale:'pt'};
(async()=>{
 for(const [minutes,cents] of [[30,8000],[60,15000],[90,22500],[120,30000]]){const r=await req({...base,skus:['massage_'+minutes]});assert.equal(r.code,200);assert(r.body.url.startsWith('https://checkout.stripe.com/'));assert.equal([...sessions.values()].at(-1).amount_total,cents)}
 let before=checkoutCalls,r=await req({...base,skus:['travel_120'],location:'travel',address:'Rua fixture 100',city:'Brussels',country:'Belgium',transport:'car'});assert.equal(r.code,201);assert.equal(checkoutCalls,before);assert.equal(r.body.estimateCents,40000);assert(r.body.quoteUrl.includes('?quote='));
 r=await req({...base,skus:['photos_3'],photoBirthDate:'2015-01-01',photoAdultDeclaration:true});assert.equal(r.code,403);
 for(const [count,cents] of [[3,2000],[5,3000],[10,5000]]){r=await req({...base,skus:['photos_'+count],photoBirthDate:'1990-01-01',photoAdultDeclaration:true,photoMethod:'email',photoContact:'qa@example.invalid'});assert.equal(r.code,200);assert.equal([...sessions.values()].at(-1).amount_total,cents)}
 const s=[...sessions.values()].at(-1);s.payment_status='paid';const order=orders.get(s.client_reference_id);
 r=response();await api.status(s,r);assert.equal(r.body.verified,false); // Return page cannot confirm the payment itself.
 r=response();await api.webhook({type:'checkout.session.completed',data:{object:{...s,payment_status:'unpaid'}}},r);assert.equal(order.status,'pending');
 r=response();await api.webhook({type:'checkout.session.async_payment_succeeded',data:{object:{...s,amount_total:1}}},r);assert.equal(r.code,409);assert.equal(order.status,'pending');
 r=response();await api.webhook({type:'checkout.session.completed',data:{object:{...s,livemode:true}}},r);assert.equal(r.code,400);assert.equal(order.status,'pending');
 process.env.RESEND_API_KEY='fixture';process.env.LUSSAN_ADMIN_MAIL_FROM='QA <qa@example.invalid>';global.fetch=async(url,o)=>{mailCalls.push({url,options:o});return {ok:true}};
 r=response();await api.webhook({type:'checkout.session.async_payment_succeeded',data:{object:s}},r);assert.equal(r.code,200);assert.equal(order.status,'confirmed');assert.equal(mailCalls.length,1);assert.equal(mailCalls[0].options.headers['Idempotency-Key'],'lussan-paid-'+order.id);
 r=response();await api.status(s,r);assert.equal(r.body.verified,true);assert(r.body.verificationUrl.endsWith('#token='+order.quote_token));assert.equal(r.body.photoContact,'qa@example.invalid');
 r=response();await api.webhook({type:'checkout.session.completed',data:{object:s}},r);assert.equal(r.code,200);assert.equal(mailCalls[1].options.headers['Idempotency-Key'],mailCalls[0].options.headers['Idempotency-Key']);
 r=response();await api.webhook({type:'checkout.session.expired',data:{object:s}},r);assert.equal(order.status,'confirmed');
 r=await req({...base,skus:['photos_3'],photoBirthDate:'1990-01-01',photoAdultDeclaration:true});const pending=[...orders.values()].at(-1);r=response();await api.webhook({type:'checkout.session.expired',data:{object:sessions.get(pending.stripe_checkout_session_id)}},r);assert.equal(pending.status,'cancelled');
 assert.equal(buildCart(['photos_5','massage_60'],{}).total,18000);
 console.log('PASS: test Stripe adapter creates correct photo/massage totals; travel requires approval; under-18 rejected; return cannot confirm unpaid order; mismatched mode/amount rejected; paid async webhook confirms once; notification retries use same idempotency key; private verification link returned only after payment; expiry preserves paid orders and cancels pending orders. No external requests or charges.');
})().catch(e=>{console.error(e);process.exitCode=1});
