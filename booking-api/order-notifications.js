'use strict';
const ready=()=>Boolean(process.env.RESEND_API_KEY&&process.env.LUSSAN_ADMIN_MAIL_FROM);
async function paid(orderId,payload){
 if(!ready())return {configured:false};
 const response=await fetch('https://api.resend.com/emails',{
  method:'POST',signal:AbortSignal.timeout(10000),
  headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':'lussan-paid-'+orderId},
  body:JSON.stringify({from:process.env.LUSSAN_ADMIN_MAIL_FROM,to:['llucianouam@gmail.com'],subject:'LUSSAN — pagamento confirmado · '+orderId,
   text:'Pagamento confirmado para o pedido '+orderId+'.\nServiços: '+(payload?.skus||[]).join(', ')+'.\n\nConsulte o pedido no serviço Lussan. Para fotos, a entrega continua condicionada à aprovação da maioridade. Os documentos só devem ser consultados no painel privado:\nhttps://lussan.onrender.com/admin-privado.html'})
 });
 if(!response.ok)throw Error('notification_unavailable');
 return {configured:true,accepted:true};
}
module.exports={ready,paid};
