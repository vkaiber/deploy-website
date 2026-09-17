const fs=require("fs"),path=require("path");
const dataDir=path.join(__dirname,"..","storage","data");
const file=path.join(dataDir,"cloud.json");
const email=String(process.argv[2]||process.env.ADMIN_EMAIL||"").trim().toLowerCase();
if(!email){console.error("Usage: node scripts/check-admin.js admin@example.com");process.exit(1);}
if(!fs.existsSync(file)){console.log(JSON.stringify({db:file,users:0,adminFound:false,role:null,banned:false,hasSalt:false,hasHash:false,dbExists:false},null,2));process.exit(0)}
let db; try{db=JSON.parse(fs.readFileSync(file,"utf8"));}catch(e){console.error("Invalid cloud.json:",e.message);process.exit(1)}
const users=Array.isArray(db.users)?db.users:[]; const u=users.find(x=>String(x.email||"").toLowerCase()===email);
console.log(JSON.stringify({db:file,dbExists:true,users:users.length,adminFound:!!u,role:u?.role||null,banned:!!u?.banned,hasSalt:!!u?.salt,hasHash:!!u?.hash},null,2));
