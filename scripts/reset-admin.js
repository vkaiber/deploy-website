const fs=require("fs"),path=require("path"),crypto=require("crypto"),readline=require("readline");
const dataDir=path.join(__dirname,"..","storage","data");
const file=path.join(dataDir,"cloud.json");
const defaults={users:[],projects:[],deployments:[],activity:[],authTokens:[],feedbackReports:[],settings:{brandName:"Deploy Website",maintenance:false,registration:true,publicDirectory:false,maxProjectsPerUser:20}};
fs.mkdirSync(dataDir,{recursive:true});
let db=defaults;
if(fs.existsSync(file)){try{db={...defaults,...JSON.parse(fs.readFileSync(file,"utf8"))};}catch(e){console.error("Database could not be read:",e.message);}}
db.users=Array.isArray(db.users)?db.users:[];
const rl=readline.createInterface({input:process.stdin,output:process.stdout});
rl.question("Admin email: ",email=>{
  email=String(email||"").trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){console.error("Enter a valid email address.");rl.close();process.exitCode=1;return;}
  rl.question("New admin password (min 12 chars): ",p=>{
    if(p.length<12){console.error("Password must be at least 12 characters.");rl.close();process.exitCode=1;return;}
    const salt=crypto.randomBytes(16).toString("hex");
    const user={id:"usr_"+crypto.randomBytes(8).toString("hex"),email,salt,hash:crypto.scryptSync(p,salt,64).toString("hex"),role:"admin",badge:"admin.png",createdAt:new Date().toISOString(),banned:false,emailVerified:true};
    db.users=db.users.filter(u=>u.email!==email); db.users.push(user);
    fs.writeFileSync(file,JSON.stringify(db,null,2),"utf8");
    console.log("Admin password updated:",email); rl.close();
  });
});
