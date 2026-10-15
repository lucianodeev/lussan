'use strict';
const assert=require('node:assert/strict'),{initialize,buildCart}=require('../cart');
const queries=[],payload={skus:['photos_3','magazine_presale']},order={status:'confirmed',amount_cents:2990,payload,quote_token:'b'.repeat(64),paid_at:new Date()};
const client={async query(sql){queries.push(sql);if(sql.startsWith('UPDATE lussan_booking.cart_orders'))return {rowCount:1,rows:[{payload}]};if(sql.startsWith('SELECT * FROM'))return {rowCount:1,rows:[order]};return {rows:[],rowCount:1}},release(){}};
const pool={query:client.query,connect:async()=>client},app={get(){},post(){}};
const api=initialize({app,pool,stripe:null,paymentReady:()=>true,liveEnabled:true,services:{}});
const res=()=>({code:200,status(n){this.code=n;return this},json(x){this.body=x;return this},sendStatus(n){this.code=n;return this}});
(async()=>{
 assert.equal(buildCart(payload.skus,{}).total,2990);
 const session={metadata:{project:'lussan',order_type:'cart'},payment_status:'paid',livemode:true,currency:'eur',client_reference_id:'fixture',id:'cs_live_fixture',amount_total:2990};
 let response=res();assert.equal(await api.webhook({type:'checkout.session.completed',data:{object:session}},response),true);assert.equal(response.code,200);
 assert(queries.some(q=>q.includes('INSERT INTO lussan_booking.photo_verifications')));assert(queries.some(q=>q.includes('INSERT INTO lussan_booking.magazine_verifications')));assert(queries.every(q=>!q.startsWith('INSERT INTO')||q.includes('ON CONFLICT')));
 response=res();await api.status(session,response);assert.equal(response.body.verified,true);assert.equal(response.body.verificationUrl,'https://lussan.onrender.com/verificacao.html#token='+order.quote_token);
 response=res();await api.status({...session,amount_total:1},response);assert.equal(response.body.verified,false);assert.equal(response.body.verificationUrl,undefined);
 response=res();await api.webhook({type:'checkout.session.completed',data:{object:{...session,livemode:false}}},response);assert.equal(response.code,400);
 queries.length=0;response=res();await api.webhook({type:'checkout.session.completed',data:{object:{...session,payment_status:'unpaid'}}},response);assert.equal(queries.length,0);
 console.log('PASS: combined digital total; paid webhook creates both verification records idempotently; verified payment returns private upload link; amount mismatch withholds link; wrong Stripe mode rejected; unpaid webhook creates no verification.');
})().catch(e=>{console.error(e);process.exitCode=1});
