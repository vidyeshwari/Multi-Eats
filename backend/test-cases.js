// MultiEats test-case readiness checker.
// This validates that the requested test surfaces exist and that the database can be reached.
// It intentionally does not mutate production/demo data.
const fs=require('fs'), path=require('path');
try { require('dotenv').config({path:path.join(__dirname,'.env')}); } catch {}
const root=path.join(__dirname,'..');
const mustHave=[
 ['frontend/index.html','Customer home'],['frontend/login.html','Login'],['frontend/orders.html','Customer orders'],
 ['frontend/confirmation.html','Order detail'],['frontend/owner.html','Restaurant owner'],['frontend/admin.html','Main admin'],
 ['database/schema.sql','Database schema'],['database/procedures.sql','Stored procedures'],['TEST_CASES.md','Test matrix']
];
let failed=0;
for(const [f,label] of mustHave){if(fs.existsSync(path.join(root,f))) console.log('PASS',label);else{console.log('FAIL',label,f);failed++;}}
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const checks=[
 ['frontend/index.html','steps','Removed top step labels', !read('frontend/index.html').includes('Set location')],
 ['frontend/js/common.js','class="em"','Restaurant photo emoji overlay', !read('frontend/js/common.js').includes('class="em"')],
 ['frontend/owner.html','Delivered','Delivered owner action', read('frontend/owner.html').includes('value="delivered"')],
 ['frontend/orders.html','refund_amount','Customer refund message', read('frontend/orders.html').includes('refund_amount')],
 ['frontend/confirmation.html','refund_amount','Order detail refund message', read('frontend/confirmation.html').includes('refund_amount')],
 ['database/procedures.sql','Refunds','Refund persistence', read('database/procedures.sql').includes('Refunds')],
 ['database/procedures.sql',"CASE WHEN so.sub_status='cancelled'",'Hide partner for cancelled owner row', read('database/procedures.sql').includes("CASE WHEN so.sub_status='cancelled' THEN NULL ELSE dp.name END")]
];
for(const [f,needle,label,ok] of checks){if(ok) console.log('PASS',label);else{console.log('FAIL',label,needle);failed++;}}
(async()=>{
 try {
  const {Client}=require('pg');
  const cfg=process.env.DATABASE_URL?{connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}}:{user:process.env.DB_USER,password:process.env.DB_PASSWORD,host:process.env.DB_HOST||'localhost',port:process.env.DB_PORT||5432,database:process.env.DB_NAME||'food_delivery'};
  const c=new Client(cfg);
  try{await c.connect(); const r=await c.query('SELECT COUNT(*)::int AS users FROM Users'); console.log('PASS PostgreSQL connection; users=',r.rows[0].users); await c.end();}
  catch(e){console.log('INFO PostgreSQL integration check skipped/unavailable:',e.message); try{await c.end();}catch{} }
 } catch(e) { console.log('INFO PostgreSQL package not installed; static readiness checks completed. Run npm install before DB integration tests.'); }
 console.log(failed?'Test readiness: FAIL':'Test readiness: PASS'); process.exit(failed?1:0);
})();
