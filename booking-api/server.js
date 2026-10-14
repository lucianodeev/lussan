'use strict';
const express=require('express');
const {Pool}=require('pg');
const app=express();
app.disable('x-powered-by');
app.use(express.json({limit:'8kb'}));
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSL==='disable'?false:{rejectUnauthorized:false}});
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
app.get('/api/availability',async(req,res)=>{
 const {date}=req.query;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))return res.status(400).json({error:'invalid_date'});
 try{const r=await pool.query("SELECT start_time,end_time FROM lussan_booking.appointments WHERE service_date=$1 AND status IN ('pending','confirmed') UNION ALL SELECT start_time,end_time FROM lussan_booking.blocked_slots WHERE service_date=$1",[date]);res.json({date,timezone:ZONE,busy:r.rows})}catch(e){res.status(503).json({error:'unavailable'})}
});
app.post('/api/booking-requests',async(req,res)=>{
 const {date,time,duration,name,contact}=req.body||{};
 if(!check(date,time,Number(duration))||typeof name!=='string'||name.trim().length<2||name.length>100||typeof contact!=='string'||contact.trim().length<5||contact.length>160)return res.status(400).json({error:'invalid_request'});
 const start=Number(time.slice(0,2))*60+Number(time.slice(3)),end=start+Number(duration);
 const endTime=String(Math.floor(end/60)).padStart(2,'0')+':'+String(end%60).padStart(2,'0');
 let client;try{client=await pool.connect()}catch(e){return res.status(503).json({error:'unavailable'})}
 try{
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[date]);
  const collision=await client.query("SELECT 1 FROM lussan_booking.appointments WHERE service_date=$1 AND status IN ('pending','confirmed') AND start_time<$3 AND end_time>$2 UNION ALL SELECT 1 FROM lussan_booking.blocked_slots WHERE service_date=$1 AND start_time<$3 AND end_time>$2 LIMIT 1",[date,time,endTime]);
  if(collision.rowCount){await client.query('ROLLBACK');return res.status(409).json({error:'slot_unavailable'})}
  const result=await client.query("INSERT INTO lussan_booking.appointments(service_date,start_time,end_time,duration_minutes,amount_cents,client_name,client_contact,status) VALUES($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id,status",[date,time,endTime,Number(duration),prices[duration],name.trim(),contact.trim()]);
  await client.query('COMMIT');return res.status(201).json({id:result.rows[0].id,status:'pending',message:'Request received; payment not enabled'});
 }catch(e){await client.query('ROLLBACK');res.status(503).json({error:'unavailable'})}finally{client.release()}
});
app.listen(process.env.PORT||3000,()=>console.log('Lussan booking API listening'));
