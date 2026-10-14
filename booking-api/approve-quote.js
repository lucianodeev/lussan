'use strict';
// Run inside the existing Render API service. DATABASE_URL is never printed.
const databaseConfig=require('./database-config');
function costsFor(location,args,pricingVersion=1){
 const euro=key=>{const n=Number(args[key]||0);if(!Number.isFinite(n)||n<0||n>20000)throw Error('Invalid '+key);return Math.round(n*100)};
 if(location==='local')return [{name:'Deslocação da dupla em Bruxelas',amount:2500}];
 if(location!=='travel')throw Error('Only travel/address quotes can be approved');
 const transport=euro('transport'),hotel=euro('hotel'),hours=Number(args['travel-hours']||0);
 if(pricingVersion===2){if(hotel||hours)throw Error('New travel package: approve transport only; package price is already included');return transport?[{name:'Transporte ida e volta para dois',amount:transport}]:[]}
 if(!Number.isFinite(hours)||hours<0||hours>72)throw Error('Invalid travel hours');
 const lines=[];if(transport)lines.push({name:'Transporte ida e volta para dois',amount:transport});if(hotel)lines.push({name:'Hospedagem da dupla — total confirmado',amount:hotel});if(hours)lines.push({name:'Tempo de viagem da dupla — '+hours+'h × €60',amount:Math.round(hours*6000)});return lines;
}
async function main(){
 const {Pool}=require('pg');
 const args={};for(let i=2;i<process.argv.length;i++){const key=process.argv[i];if(key==='--confirm'){args.confirm=true;continue}if(!/^--(id|transport|hotel|travel-hours)$/.test(key)||process.argv[i+1]===undefined)throw Error('Use --id UUID [--transport EUR] [--hotel EUR] [--travel-hours HOURS] [--confirm]');args[key.slice(2)]=process.argv[++i]}
 if(!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(args.id||''))throw Error('Invalid quote ID');
 if(!process.env.DATABASE_URL)throw Error('Run in the Render API service environment');
 const pool=new Pool(databaseConfig(process.env.DATABASE_URL)),c=await pool.connect();
 try{await c.query('BEGIN');const r=await c.query('SELECT id,status,payload,amount_cents,stripe_checkout_session_id FROM lussan_booking.cart_orders WHERE id=$1 FOR UPDATE',[args.id]);const o=r.rows[0];if(!o||o.status!=='requested'||o.stripe_checkout_session_id)throw Error('Quote not awaiting approval');
 const costs=costsFor(o.payload.location,args,o.payload.pricingVersion||1),total=o.amount_cents+costs.reduce((n,x)=>n+x.amount,0);
 if(o.payload.location==='travel'&&!o.payload.skus.includes('massage_120'))throw Error('Travel requires a 2h massage');
 console.log(JSON.stringify({id:o.id,date:o.payload.date,time:o.payload.time,servicesCents:o.amount_cents,costs,totalCents:total,action:args.confirm?'APPROVE':'PREVIEW'}));
 if(args.confirm){await c.query("UPDATE lussan_booking.cart_orders SET status='approved',cost_items=$1::jsonb,amount_cents=$2,valid_until=now()+interval '24 hours' WHERE id=$3 AND status='requested'",[JSON.stringify(costs),total,o.id]);await c.query('COMMIT');console.log('Approved. Customer can pay using the original private quote link.')}else await c.query('ROLLBACK');
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release();await pool.end()}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={costsFor};
