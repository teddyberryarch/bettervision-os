// PostgreSQL 래퍼. DATABASE_URL 없으면 메모리 폴백(로컬/DB 미설정 시).
let pool=null, ready=false, mem=[];
try{
  if(process.env.DATABASE_URL){
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL==='off'? false : { rejectUnauthorized:false } });
  }
}catch(e){ console.warn('pg 모듈 없음 — 메모리 폴백'); }

async function init(){
  if(!pool){ ready=false; return; }
  await pool.query(`CREATE TABLE IF NOT EXISTS bookings(
    id SERIAL PRIMARY KEY,
    store TEXT NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL,
    name TEXT NOT NULL, phone TEXT, created_at TIMESTAMPTZ DEFAULT now()
  )`);
  ready=true;
}
async function listBookings(store,date){
  if(ready){ const r=await pool.query(
    'SELECT store,date,time,name,phone FROM bookings WHERE ($1::text IS NULL OR store=$1) AND ($2::text IS NULL OR date=$2) ORDER BY date,time',
    [store||null,date||null]); return r.rows; }
  return mem.filter(b=>(!store||b.store===store)&&(!date||b.date===date));
}
async function countSlot(store,date,time){
  if(ready){ const r=await pool.query('SELECT COUNT(*)::int AS c FROM bookings WHERE store=$1 AND date=$2 AND time=$3',[store,date,time]); return r.rows[0].c; }
  return mem.filter(b=>b.store===store&&b.date===date&&b.time===time).length;
}
async function addBooking(b){
  if(ready){ const r=await pool.query('INSERT INTO bookings(store,date,time,name,phone) VALUES($1,$2,$3,$4,$5) RETURNING store,date,time,name,phone',
    [b.store,b.date,b.time,b.name,b.phone||'']); return r.rows[0]; }
  const row={store:b.store,date:b.date,time:b.time,name:b.name,phone:b.phone||''}; mem.push(row); return row;
}
module.exports={ init, listBookings, countSlot, addBooking, get ready(){return ready;} };
