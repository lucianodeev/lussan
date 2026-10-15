'use strict';
// Self-declared dates never count as independently verified age.
function isAdult(value,today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Brussels',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const birth=new Date(value+'T00:00:00Z');if(Number.isNaN(birth.getTime())||birth.toISOString().slice(0,10)!==value)return false;
 const [y,m,d]=value.split('-').map(Number),[ty,tm,td]=today.split('-').map(Number);
 return y>=1900&&ty-y-(tm<m||tm===m&&td<d?1:0)>=18&&value<=today;
}
function magazineError(body){
 if(!isAdult(body?.birthDate)||body?.adultDeclaration!==true)return 'adult_declaration_required';
 return null; // Declaration for purchase only; identity verification required before content access.
}
module.exports={isAdult,magazineError};
