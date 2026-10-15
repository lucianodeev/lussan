'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
process.env.LUSSAN_VERIFICATION_FILE_KEY=crypto.randomBytes(32).toString('hex');
const vf=require('../verification-files'),{isAdult,magazineError}=require('../age-policy');
const png={type:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGTkAAAAASUVORK5CYII='};
const bytes=vf.image(png).bytes;
const maxImage=Buffer.alloc(4*1024*1024);maxImage[0]=255;maxImage[1]=216;maxImage[2]=255;maxImage[maxImage.length-2]=255;maxImage[maxImage.length-1]=217;assert.equal(vf.image({type:'image/jpeg',data:maxImage.toString('base64')}).bytes.length,maxImage.length);assert.throws(()=>vf.image({type:'image/jpeg',data:Buffer.alloc(maxImage.length+1).toString('base64')}));
assert.throws(()=>vf.image({type:'text/html',data:png.data}));assert.throws(()=>vf.image({type:'image/png',data:Buffer.from('this is not an image').toString('base64')}));
const encrypted=vf.encrypt(bytes,'order:document');assert(!encrypted.includes(bytes));assert.deepEqual(vf.decrypt(encrypted,'order:document'),bytes);assert.throws(()=>vf.decrypt(encrypted,'order:selfie'));const bad=Buffer.from(encrypted);bad[30]^=1;assert.throws(()=>vf.decrypt(bad,'order:document'));
assert.equal(isAdult('2015-01-01'),false);assert.equal(isAdult('2000-02-31'),false);assert.equal(magazineError({birthDate:'2000-01-01',adultDeclaration:true}),null);assert.equal(magazineError({birthDate:'2015-01-01',adultDeclaration:true}),'adult_declaration_required');
const id='12345678-1234-4234-8234-123456789abc',token='a'.repeat(64);let saved=null,paid=true,auth=false,queries=[];
const pool={async query(sql,args=[]){queries.push(sql);if(sql.startsWith('SELECT id,payload'))return {rows:paid&&args[0]===token?[{id,payload:{skus:['photos_3','magazine_presale']}}]:[]};if(sql.startsWith('SELECT review_status'))return {rows:saved?[{review_status:saved.review_status,expires_at:new Date(Date.now()+86400000)}]:[]};if(sql.startsWith('INSERT INTO lussan_booking.verification_uploads')){saved={review_status:'pending_review',document_cipher:args[1],selfie_cipher:args[2],document_type:args[3],selfie_type:args[4]};return {rowCount:1}}if(sql.startsWith('SELECT document_cipher'))return {rows:saved?[saved]:[]};if(sql.startsWith('UPDATE lussan_booking.verification_uploads')){if(saved?.review_status!=='pending_review')return {rowCount:0};saved.review_status=args[1];saved.document_cipher=saved.selfie_cipher=null;return {rowCount:1}}return {rowCount:1,rows:[]}},async connect(){return {...this,release(){}}}};
const routes=new Map(),app={post(p,...h){routes.set('POST '+p,h)},get(p,...h){routes.set('GET '+p,h)}};
vf.registerPublic(app,pool);vf.registerAdmin(app,pool,(_req,res,next)=>auth?next():res.status(401).json({error:'unauthorized'}));
async function call(method,path,body={},params={}){const req={body,params,ip:'test'},res={code:200,set(){return this},status(n){this.code=n;return this},json(x){this.body=x;return this},send(x){this.body=x;return this},sendStatus(n){this.code=n;return this}};const h=routes.get(method+' '+path);let i=0;const pending=[];function next(){if(h[i]){const p=Promise.resolve(h[i++](req,res,next));pending.push(p);return p}}next();for(let j=0;j<pending.length;j++)await pending[j];return res}
(async()=>{
 assert.equal((await call('POST','/api/verification-status',{token:'bad'})).code,404);
 paid=false;assert.equal((await call('POST','/api/verification-upload',{token,consent:true,document:png,selfie:png})).code,404);paid=true;
 assert.equal((await call('POST','/api/verification-upload',{token,consent:false,document:png,selfie:png})).code,400);
 assert.equal((await call('POST','/api/verification-upload',{token,consent:true,document:png,selfie:png})).body.status,'pending_review');
 assert(queries.some(q=>q.includes("photo_verifications(cart_order_id")));assert(queries.some(q=>q.includes("magazine_verifications(cart_order_id")));
 const original=Buffer.from(saved.document_cipher);await call('POST','/api/verification-upload',{token,consent:true,document:png,selfie:png});assert.deepEqual(saved.document_cipher,original);
 assert.equal((await call('GET','/api/private-admin/files/:orderId/:kind',{}, {orderId:id,kind:'document'})).code,401);auth=true;
 assert.deepEqual((await call('GET','/api/private-admin/files/:orderId/:kind',{}, {orderId:id,kind:'document'})).body,bytes);
 assert.equal((await call('POST','/api/private-admin/review',{orderId:id,decision:'approved'})).body.updated,true);assert.equal(saved.document_cipher,null);assert.equal(saved.selfie_cipher,null);
 assert.equal((await call('POST','/api/private-admin/review',{orderId:id,decision:'approved'})).code,409);
 assert.equal((await call('GET','/api/private-admin/files/:orderId/:kind',{}, {orderId:id,kind:'document'})).code,404);
 console.log('PASS: adult eligibility; invalid files; authenticated encryption; tamper and document-swap rejection; unpaid link blocked; consent required; upload covers both products; duplicate submission immutable; admin authorization; file retrieval; approval deletes copies; review replay blocked.');
})().catch(e=>{console.error(e);process.exitCode=1});
