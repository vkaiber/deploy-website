const dns = require("dns");
dns.setServers(["1.1.1.1", "1.0.0.1"]);
const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

// Load local .env when running on Node versions that support it.
try { if (typeof process.loadEnvFile === "function") process.loadEnvFile(); } catch (e) { console.warn(".env yüklenemedi:", e.message); }

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const DOMAIN = (process.env.BCLOUD_DOMAIN || "localhost").toLowerCase();
const DASHBOARD_HOST = (process.env.BCLOUD_HOST || `cloud.${DOMAIN}`).toLowerCase();
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").toLowerCase();
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 100) * 1024 * 1024;
const MAX_FILES = Number(process.env.MAX_FILES || 10000);
const MAX_UNZIPPED = Number(process.env.MAX_UNZIPPED_MB || 300) * 1024 * 1024;
const SESSION_MS = Number(process.env.SESSION_HOURS || 24) * 3600 * 1000;
const VERIFY_TOKEN_MS = Number(process.env.EMAIL_VERIFY_MINUTES || 30) * 60 * 1000;
const RESET_TOKEN_MS = Number(process.env.PASSWORD_RESET_MINUTES || 30) * 60 * 1000;
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || "").trim();
const EMAIL_FROM = String(process.env.EMAIL_FROM || "deploy-website <hello@example.com>").trim();
const EMAIL_REPLY_TO = String(process.env.EMAIL_REPLY_TO || "").trim();
const EMAIL_WELCOME_ENABLED = String(process.env.EMAIL_WELCOME_ENABLED || "true").toLowerCase() !== "false";

const ROOT = path.resolve(__dirname, "..");
const STORAGE = path.join(ROOT, "storage");
const DATA = path.join(STORAGE, "data");
const SITES = path.join(STORAGE, "sites");
const TMP = path.join(STORAGE, "tmp");
const RELEASES = path.join(STORAGE, "releases");
const DB_FILE = path.join(DATA, "cloud.json");
const PUBLIC = path.join(ROOT, "public");
const MONGODB_URI = String(process.env.MONGODB_URI || "").trim();
let mongoState = { configured: !!MONGODB_URI, connected: false, error: null };
let mongo = null;
try { mongo = require("./mongodb"); } catch (e) { if (MONGODB_URI) console.warn("MongoDB driver unavailable; JSON storage remains active."); }

for (const d of [DATA, SITES, TMP, RELEASES]) fs.mkdirSync(d, { recursive: true });

function defaultDB() {
  return {
    users: [], projects: [], deployments: [], activity: [], authTokens: [], feedbackReports: [],
    settings: {
      brandName: "deploy-website",
      maintenance: false,
      registration: true,
      publicDirectory: false,
      maxProjectsPerUser: 20
    }
  };
}
function loadDB() {
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    const merged = {...defaultDB(), ...d, settings:{...defaultDB().settings,...(d.settings||{})}};
    if(!Array.isArray(merged.authTokens)) merged.authTokens=[];
    if(!Array.isArray(merged.feedbackReports)) merged.feedbackReports=[];
    if(merged.settings.brandName==="Deploy Website") merged.settings.brandName="deploy-website";
    // Existing accounts remain usable after the email-verification upgrade.
    // Only newly created accounts must verify their email.
    for(const u of merged.users){ if(typeof u.emailVerified !== "boolean") u.emailVerified=true; }
    return merged;
  } catch { return defaultDB(); }
}
let db = loadDB();
let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
    fs.renameSync(tmp, DB_FILE);
    try { mongo?.queueSave(db); } catch (e) { mongoState.error = e.message; }
  }, 30);
}
const sessions = new Map();
const loginAttempts = new Map();
const emailAttempts = new Map();

function id(prefix) { return `${prefix}_${crypto.randomBytes(10).toString("hex")}`; }
function now() { return new Date().toISOString(); }
function sha(s) { return crypto.createHash("sha256").update(s).digest("hex"); }
function tokenValue(){ return crypto.randomBytes(32).toString("hex"); }
function cleanupAuthTokens(){ const t=Date.now(); db.authTokens=db.authTokens.filter(x=>x.expiresAt>t && !x.used); }
function emailEsc(v){
  return String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function emailUrl(v){
  const s=String(v||"");
  return /^https:\/\/[^\s"<>]+$/i.test(s) ? s : "#";
}
function emailButton(label,url){
  const safeUrl=emailUrl(url);
  return `<a href="${safeUrl}" style="display:inline-block;background:#5865f2;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;line-height:20px;padding:13px 20px;border-radius:10px">${emailEsc(label)}</a>`;
}
function emailLayout({eyebrow="DEPLOY WEBSITE",title,preheader="",intro="",body="",buttonLabel="",buttonUrl="",footnote="",support=""}){
  const safeTitle=emailEsc(title), safeIntro=emailEsc(intro), safeFootnote=emailEsc(footnote), safeSupport=emailEsc(support);
  const button=buttonLabel&&buttonUrl?emailButton(buttonLabel,buttonUrl):"";
  const plainLink=buttonUrl?`<div style="margin-top:18px;font-size:12px;line-height:18px;color:#8e96a8;word-break:break-all">${emailEsc(buttonUrl)}</div>`:"";
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><meta name="supported-color-schemes" content="dark light"><title>${safeTitle}</title></head><body style="margin:0;padding:0;background:#0b0d10;color:#f2f3f5;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;-webkit-font-smoothing:antialiased"><div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${emailEsc(preheader)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0b0d10"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px"><tr><td style="padding:0 4px 14px"><div style="font-size:20px;line-height:24px;font-weight:800;letter-spacing:-.02em;color:#ffffff">deploy-website</div><div style="margin-top:4px;font-size:10px;line-height:14px;letter-spacing:.16em;font-weight:700;color:#8f98ff">${emailEsc(eyebrow)}</div></td></tr><tr><td style="background:#171a21;border:1px solid #2b2f39;border-radius:18px;padding:32px 30px"><div style="font-size:11px;line-height:16px;letter-spacing:.12em;font-weight:800;color:#8f98ff">${emailEsc(eyebrow)}</div><h1 style="margin:10px 0 12px;font-size:28px;line-height:34px;letter-spacing:-.03em;color:#ffffff">${safeTitle}</h1>${safeIntro?`<p style="margin:0 0 18px;font-size:15px;line-height:24px;color:#c6cad3">${safeIntro}</p>`:""}<div style="font-size:14px;line-height:23px;color:#b5bac5">${body}</div>${button?`<div style="padding-top:24px">${button}</div>`:""}${plainLink}<div style="height:1px;background:#2b2f39;margin:28px 0 18px"></div><div style="font-size:12px;line-height:19px;color:#7f8797">${safeFootnote||"Bu e-posta deploy-website hesabınla ilgili otomatik bir bildiridir."}</div>${safeSupport?`<div style="margin-top:8px;font-size:12px;line-height:19px;color:#7f8797">${safeSupport}</div>`:""}</td></tr><tr><td style="padding:16px 4px 0;font-size:11px;line-height:18px;color:#606878">deploy-website · Private deployment cloud</td></tr></table></td></tr></table></body></html>`;
}
function emailText({title,intro="",body="",buttonLabel="",buttonUrl="",footnote=""}){
  const lines=[title,"",intro,body.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim()];
  if(buttonLabel&&buttonUrl) lines.push("",`${buttonLabel}: ${buttonUrl}`);
  if(footnote) lines.push("",footnote);
  return lines.filter(Boolean).join("\n");
}
async function sendEmail({to,subject,html,text,category,userId,idempotencyKey}){
  if(!RESEND_API_KEY) throw new Error("E-posta servisi yapılandırılmamış. RESEND_API_KEY gerekli.");
  const payload={
    from:EMAIL_FROM,
    to:[to],
    subject,
    html,
    text:text||undefined,
    tags:[
      {name:"category",value:String(category||"transactional")},
      ...(userId?[{name:"user_id",value:String(userId)}]:[])
    ],
    headers:{"X-Entity-Ref-ID":`deploy-website/${category||"transactional"}/${userId||to}`}
  };
  if(EMAIL_REPLY_TO) payload.reply_to=EMAIL_REPLY_TO;
  const r=await fetch("https://api.resend.com/emails",{
    method:"POST",
    headers:{"Authorization":`Bearer ${RESEND_API_KEY}`,"Content-Type":"application/json","Idempotency-Key":String(idempotencyKey || `cloud-${category||"transactional"}-${userId||to}-${sha(subject+to+Date.now()).slice(0,24)}`)},
    body:JSON.stringify(payload)
  });
  const raw=await r.text(); let data={}; try{data=JSON.parse(raw)}catch{}
  if(!r.ok) throw new Error(data.message||data.error||`E-posta gönderilemedi (HTTP ${r.status})`);
  return data;
}
function publicUrl(pathname){ return `https://${DASHBOARD_HOST}${pathname}`; }
function safeUser(u) {
  return {
    id:u.id,email:u.email,emailVerified:u.emailVerified!==false,role:u.role,badge:u.badge,createdAt:u.createdAt,
    banned:!!u.banned,banReason:u.banReason||null,bannedAt:u.bannedAt||null,
    firstName:u.firstName||"",lastName:u.lastName||"",displayName:u.displayName||u.email,username:u.username||"",phone:u.phone||"",website:u.website||"",bio:u.bio||"",termsAcceptedAt:u.termsAcceptedAt||null,lastLoginAt:u.lastLoginAt||null
  };
}
function safeSlug(v) {
  return String(v||"").toLowerCase().trim()
    .replace(/[^a-z0-9-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,48);
}
function uniqueSlug(base, ignoreId=null) {
  const raw = safeSlug(base) || `site-${Date.now().toString(36)}`;
  let s=raw, n=1;
  while (db.projects.some(p => p.slug===s && p.id!==ignoreId)) s=`${raw}-${n++}`;
  return s;
}
function safePath(input) {
  let s=String(input||"").replace(/\\/g,"/");
  if (!s || s.includes("\0") || s.startsWith("/")) throw new Error("Güvensiz dosya yolu");
  const parts=s.split("/").filter(Boolean);
  if (parts.some(p=>p===".." || p===".")) throw new Error("Güvensiz dosya yolu");
  return parts.join("/");
}
function log(action, meta={}, actor="system") {
  db.activity.unshift({id:id("act"),at:now(),action,actor,meta});
  db.activity=db.activity.slice(0,1000); saveDB();
}
function cookies(req) {
  const out={};
  for(const p of (req.headers.cookie||"").split(";")) {
    const i=p.indexOf("="); if(i>0) out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim());
  }
  return out;
}
function userFromReq(req) {
  const token=cookies(req).kc_session, s=token&&sessions.get(token);
  if(!s || s.expires<Date.now()) { if(token) sessions.delete(token); return null; }
  const u=db.users.find(x=>x.id===s.userId);
  if(!u || u.banned) return null;
  return u;
}
function auth(req,res,next) {
  const u=userFromReq(req);
  if(!u) return res.status(401).json({ok:false,error:"Oturum gerekli"});
  req.user=u; next();
}
function admin(req,res,next) {
  const u=userFromReq(req);
  if(!u || u.email!==ADMIN_EMAIL || u.role!=="admin") return res.status(403).json({ok:false,error:"Sadece admin"});
  req.user=u; next();
}
function setSession(res,u) {
  const token=crypto.randomBytes(32).toString("hex");
  sessions.set(token,{userId:u.id,expires:Date.now()+SESSION_MS});
  const proto=String(res.req?.headers?.["x-forwarded-proto"]||"").split(",")[0].trim().toLowerCase();
  const secure=(res.req?.secure===true || proto==="https")?"; Secure":"";
  res.setHeader("Set-Cookie",`kc_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_MS/1000)}${secure}`);
}
function rateLimited(ip) {
  const a=(loginAttempts.get(ip)||[]).filter(t=>Date.now()-t<10*60*1000);
  loginAttempts.set(ip,a); return a.length>=8;
}
function failLogin(ip) {
  const a=loginAttempts.get(ip)||[]; a.push(Date.now()); loginAttempts.set(ip,a);
}
function emailRateLimited(key){ const a=(emailAttempts.get(key)||[]).filter(t=>Date.now()-t<15*60*1000); emailAttempts.set(key,a); return a.length>=5; }
function hitEmailRateLimit(key){ const a=emailAttempts.get(key)||[]; a.push(Date.now()); emailAttempts.set(key,a); }
function passwordHash(password,salt) {
  return crypto.scryptSync(password,salt,64).toString("hex");
}
app.use((req,res,next)=>{
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("X-Frame-Options","SAMEORIGIN");
  res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy","camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy","same-origin");
  res.setHeader("X-Deploy Website-Version","4.1.0");
  res.setHeader("X-Deploy Website-Origin","node");
  next();
});
app.use(express.json({limit:"2mb"}));
app.use(express.urlencoded({extended:false,limit:"2mb"}));
app.use((req,res,next)=>{
  if(req.method!=="GET" && req.path.startsWith("/api/") && !["/api/auth/login","/api/auth/register"].includes(req.path)){
    const origin=req.headers.origin;
    if(origin){ try{const u=new URL(origin); const allowed=[DASHBOARD_HOST,`localhost:${PORT}`,`127.0.0.1:${PORT}`]; if(!allowed.includes(u.host) && u.hostname!==DASHBOARD_HOST) return res.status(403).json({ok:false,error:"İstek kaynağı reddedildi"});}catch{return res.status(403).json({ok:false,error:"Geçersiz istek kaynağı"})} }
  } next();
});

const upload=multer({
  dest:TMP,
  limits:{fileSize:MAX_UPLOAD,files:MAX_FILES}
});

function countTree(dir) {
  let bytes=0, files=0;
  const walk=d=>{
    for(const e of fs.readdirSync(d,{withFileTypes:true})) {
      const p=path.join(d,e.name);
      if(e.isDirectory()) walk(p);
      else { files++; bytes+=fs.statSync(p).size; }
      if(files>MAX_FILES || bytes>MAX_UNZIPPED) throw new Error("Proje boyutu veya dosya limiti aşıldı");
    }
  };
  walk(dir); return {files,bytes};
}
function findPublishRoot(base) {
  const roots=["index.html","dist/index.html","build/index.html","out/index.html","public/index.html"];
  for(const c of roots) if(fs.existsSync(path.join(base,c))) return path.dirname(path.join(base,c));
  const q=[{d:base,depth:0}];
  while(q.length) {
    const {d,depth}=q.shift(); if(depth>=4) continue;
    for(const e of fs.readdirSync(d,{withFileTypes:true})) {
      if(!e.isDirectory() || e.name.startsWith(".")) continue;
      const nd=path.join(d,e.name);
      if(fs.existsSync(path.join(nd,"index.html"))) return nd;
      q.push({d:nd,depth:depth+1});
    }
  }
  return null;
}
function publish(root,slug) {
  const dest=path.join(SITES,slug);
  const stage=path.join(SITES,`.stage-${slug}-${crypto.randomBytes(4).toString("hex")}`);
  fs.rmSync(stage,{recursive:true,force:true});
  fs.cpSync(root,stage,{recursive:true});
  fs.rmSync(dest,{recursive:true,force:true});
  fs.renameSync(stage,dest);
}
function projectFor(req,idValue) {
  const p=db.projects.find(x=>x.id===idValue);
  if(!p) return null;
  if(req.user.email!==ADMIN_EMAIL && p.ownerId!==req.user.id) return null;
  return p;
}
async function createDeployment(root,user,name,requestedSlug,existingProject=null,preview=false){
  if(db.settings.maintenance && user.email!==ADMIN_EMAIL) throw new Error("Sistem bakım modunda");
  if(preview && !existingProject) throw new Error("Preview için önce bir proje oluşturmalısın");
  const publishRoot=findPublishRoot(root);
  if(!publishRoot) throw new Error("index.html bulunamadı. Kök, dist, build, out veya public içinde index.html olmalı.");
  const stats=countTree(publishRoot);
  if(stats.files===0) throw new Error("Yayınlanacak dosya yok");
  let project=existingProject;
  if(!project && db.projects.filter(p=>p.ownerId===user.id).length>=Number(db.settings.maxProjectsPerUser||20) && user.email!==ADMIN_EMAIL)
    throw new Error("Proje limitine ulaştın");
  const slug=project?.slug || uniqueSlug(requestedSlug||name);
  const projectId=project?.id || id("prj"), depId=id("dep");
  const releaseDir=path.join(RELEASES,projectId,depId);
  fs.mkdirSync(path.dirname(releaseDir),{recursive:true});
  fs.cpSync(publishRoot,releaseDir,{recursive:true});
  const previewHost=`preview-${depId.slice(-10)}`;
  if(!preview){ publish(publishRoot,slug); }
  const dep={id:depId,projectId,status:"success",createdAt:now(),durationMs:Math.floor(250+Math.random()*900),files:stats.files,bytes:stats.bytes,commit:"manual-upload",message:preview?"Preview deployment":"Manual deployment",releasePath:releaseDir,previewHost};
  if(project){
    if(!preview){ project.updatedAt=now(); project.files=stats.files; project.bytes=stats.bytes; project.currentDeploymentId=depId; project.status="live"; }
  }else{
    project={id:projectId,name:String(name||slug).slice(0,100),slug,ownerId:user.id,ownerEmail:user.email,status:"live",createdAt:now(),updatedAt:now(),files:stats.files,bytes:stats.bytes,views:0,public:true,currentDeploymentId:depId};
    db.projects.unshift(project);
  }
  db.deployments.unshift(dep);
  log(preview?"preview_published":"deployment_published",{projectId:project.id,slug,files:stats.files,bytes:stats.bytes,deploymentId:depId},user.email);
  saveDB();
  return {...project,url:`https://${slug}.${DOMAIN}`,previewUrl:`https://${previewHost}.${DOMAIN}`,deploymentId:depId};
}

// Cache policy: dashboard shell and all API responses must never become stale.
// This middleware is intentionally registered BEFORE API/static responses.
app.use((req,res,next)=>{
  if(req.path.startsWith("/api/") || req.path==="/" || req.path==="/index.html" || req.path==="/app.js" || req.path==="/favicon.svg" || req.path==="/favicon.png" || req.path.startsWith("/branding/") || req.path.startsWith("/ui/")) {
    res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("CDN-Cache-Control","no-store");
    res.setHeader("Cloudflare-CDN-Cache-Control","no-store");
    res.setHeader("Pragma","no-cache");
    res.setHeader("Expires","0");
  }
  next();
});

app.get("/api/config",(req,res)=>res.json({
  ok:true,brand:db.settings.brandName,domain:DOMAIN,dashboardHost:DASHBOARD_HOST,
  adminEmail:ADMIN_EMAIL,registration:!!db.settings.registration
}));

app.post("/api/auth/register",async(req,res)=>{
  if(!db.settings.registration) return res.status(403).json({ok:false,error:"Yeni üyelikler kapalı"});
  if(String(req.body.website||"").trim()) return res.status(400).json({ok:false,error:"Kayıt doğrulaması başarısız"});
  const email=String(req.body.email||"").trim().toLowerCase(), password=String(req.body.password||"");
  const username=safeSlug(req.body.username||"").slice(0,30);
  if(email===ADMIN_EMAIL) return res.status(403).json({ok:false,error:"Bu adres özel admin hesabıdır"});
  if(req.body.termsAccepted!==true) return res.status(400).json({ok:false,error:"Kayıt olmak için Kullanım Koşulları kabul edilmelidir."});
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || password.length<10 || !username)
    return res.status(400).json({ok:false,error:"Kullanıcı adı, geçerli e-posta ve en az 10 karakter şifre gerekli"});
  if(db.users.some(u=>u.email===email)) return res.status(409).json({ok:false,error:"Bu e-posta zaten kayıtlı"});
  if(db.users.some(u=>u.username===username)) return res.status(409).json({ok:false,error:"Bu kullanıcı adı zaten kullanımda"});
  if(!RESEND_API_KEY) return res.status(503).json({ok:false,error:"E-posta doğrulaması henüz yapılandırılmadı. Admin .env dosyasına RESEND_API_KEY eklemeli."});
  const salt=crypto.randomBytes(16).toString("hex");
  const u={id:id("usr"),email,username,salt,hash:passwordHash(password,salt),role:"member",badge:"uye.png",createdAt:now(),banned:false,emailVerified:false,firstName:username,lastName:"",displayName:username,phone:"",website:"",bio:"",termsAcceptedAt:now()};
  db.users.push(u);
  cleanupAuthTokens();
  const raw=tokenValue(); db.authTokens.push({id:id("tok"),userId:u.id,type:"verify",hash:sha(raw),expiresAt:Date.now()+VERIFY_TOKEN_MS,used:false});
  saveDB();
  try{
    const link=publicUrl(`/verify-email?token=${encodeURIComponent(raw)}`);
    const title="E-posta adresini doğrula";
    const intro=`deploy-website hesabını oluşturduğun için teşekkürler. Hesabını aktifleştirmek için son bir adım kaldı.`;
    const body=`<p style="margin:0">Aşağıdaki butona tıklayarak e-posta adresini doğrula ve çalışma alanına giriş yap.</p>`;
    const footnote=`Bu bağlantı ${Math.round(VERIFY_TOKEN_MS/60000)} dakika geçerlidir. Bu hesabı sen oluşturmadıysan bu e-postayı yok sayabilirsin.`;
    await sendEmail({to:u.email,subject:"E-postanı doğrula · deploy-website",html:emailLayout({title,preheader:"deploy-website hesabını aktifleştirmek için son bir adım.",intro,body,buttonLabel:"E-postamı doğrula",buttonUrl:link,footnote}),text:emailText({title,intro,body,buttonLabel:"E-postamı doğrula",buttonUrl:link,footnote}),category:"verify_email",userId:u.id,idempotencyKey:`verify-${u.id}-${raw}`});
  }catch(err){ db.users=db.users.filter(x=>x.id!==u.id); db.authTokens=db.authTokens.filter(x=>x.userId!==u.id); saveDB(); return res.status(502).json({ok:false,error:"Doğrulama e-postası gönderilemedi. Resend ayarlarını kontrol et."}); }
  log("member_registered",{email,displayName:u.displayName},email);
  res.json({ok:true,verificationRequired:true,email:u.email});
});

app.get("/api/auth/verify-email",async(req,res)=>{
  cleanupAuthTokens(); const raw=String(req.query.token||""); if(!raw) return res.status(400).json({ok:false,error:"Geçersiz doğrulama bağlantısı"});
  const t=db.authTokens.find(x=>x.type==="verify"&&x.hash===sha(raw)&&!x.used&&x.expiresAt>Date.now());
  if(!t) return res.status(400).json({ok:false,error:"Bu doğrulama bağlantısı geçersiz veya süresi dolmuş."});
  const u=db.users.find(x=>x.id===t.userId); if(!u) return res.status(404).json({ok:false,error:"Hesap bulunamadı"});
  u.emailVerified=true; t.used=true; saveDB(); log("email_verified",{userId:u.id},u.email);
  if(EMAIL_WELCOME_ENABLED && RESEND_API_KEY){
    try{
      const title="Hoş geldin 👋";
      const intro=`E-posta adresin doğrulandı. Artık deploy-website çalışma alanına hazırsın.`;
      const body=`<p style="margin:0">İlk projen için giriş yap ve yayınlamaya başla. Hesabın hazır, kontrol sende.</p>`;
      const link=publicUrl("/");
      const footnote="Bu e-posta hesap doğrulaman tamamlandığı için gönderildi.";
      await sendEmail({to:u.email,subject:"Hoş geldin · deploy-website",html:emailLayout({eyebrow:"WELCOME TO DEPLOY WEBSITE",title,preheader:"E-posta adresin doğrulandı. Çalışma alanın hazır.",intro,body,buttonLabel:"Çalışma alanına git",buttonUrl:link,footnote}),text:emailText({title,intro,body,buttonLabel:"Çalışma alanına git",buttonUrl:link,footnote}),category:"welcome",userId:u.id,idempotencyKey:`welcome-${u.id}-${u.emailVerified}`});
    }catch(err){ console.warn("Hoş geldin e-postası gönderilemedi:",err.message); }
  }
  res.json({ok:true,emailVerified:true});
});

app.post("/api/auth/resend-verification",async(req,res)=>{
  cleanupAuthTokens(); const email=String(req.body.email||"").trim().toLowerCase(); const key=`${req.ip||"unknown"}:${email}`; if(emailRateLimited(key)) return res.status(429).json({ok:false,error:"Çok fazla e-posta isteği. Birkaç dakika sonra tekrar dene."}); hitEmailRateLimit(key); const u=db.users.find(x=>x.email===email);
  if(!u || u.emailVerified) return res.json({ok:true,message:"Eğer hesap uygunsa doğrulama e-postası gönderildi."});
  if(!RESEND_API_KEY) return res.status(503).json({ok:false,error:"E-posta servisi yapılandırılmamış."});
  const raw=tokenValue(); db.authTokens.push({id:id("tok"),userId:u.id,type:"verify",hash:sha(raw),expiresAt:Date.now()+VERIFY_TOKEN_MS,used:false}); saveDB();
  try{
    const link=publicUrl(`/verify-email?token=${encodeURIComponent(raw)}`);
    const title="E-postanı doğrula";
    const intro="Hesabın henüz doğrulanmadı. Güvenli bağlantıyı kullanarak işlemi tamamlayabilirsin.";
    const body=`<p style="margin:0">Hesabına devam etmek için aşağıdaki butona tıkla.</p>`;
    const footnote=`Bu bağlantı ${Math.round(VERIFY_TOKEN_MS/60000)} dakika geçerlidir. İsteği sen yapmadıysan bu e-postayı yok sayabilirsin.`;
    await sendEmail({to:u.email,subject:"E-postanı doğrula · deploy-website",html:emailLayout({title,preheader:"Hesabını doğrulamak için güvenli bağlantın hazır.",intro,body,buttonLabel:"E-postamı doğrula",buttonUrl:link,footnote}),text:emailText({title,intro,body,buttonLabel:"E-postamı doğrula",buttonUrl:link,footnote}),category:"verify_email",userId:u.id,idempotencyKey:`verify-${u.id}-${raw}`});
  } catch{ return res.status(502).json({ok:false,error:"E-posta gönderilemedi."}); }
  res.json({ok:true,message:"Doğrulama e-postası gönderildi."});
});

app.post("/api/auth/forgot-password",async(req,res)=>{
  cleanupAuthTokens(); const email=String(req.body.email||"").trim().toLowerCase(); const key=`${req.ip||"unknown"}:${email}`; if(emailRateLimited(key)) return res.status(429).json({ok:false,error:"Çok fazla e-posta isteği. Birkaç dakika sonra tekrar dene."}); hitEmailRateLimit(key); const u=db.users.find(x=>x.email===email);
  if(!u || u.banned) return res.json({ok:true,message:"Eğer bu e-posta kayıtlıysa şifre sıfırlama bağlantısı gönderildi."});
  if(!RESEND_API_KEY) return res.status(503).json({ok:false,error:"E-posta servisi yapılandırılmamış."});
  const raw=tokenValue(); db.authTokens.push({id:id("tok"),userId:u.id,type:"reset",hash:sha(raw),expiresAt:Date.now()+RESET_TOKEN_MS,used:false}); saveDB();
  try{
    const link=publicUrl(`/reset-password?token=${encodeURIComponent(raw)}`);
    const title="Şifreni sıfırla";
    const intro="deploy-website hesabın için bir şifre sıfırlama isteği aldık.";
    const body=`<p style="margin:0">Şifreni yenilemek ve hesabına geri dönmek için aşağıdaki butonu kullan.</p>`;
    const footnote=`Bu bağlantı ${Math.round(RESET_TOKEN_MS/60000)} dakika geçerlidir. Bu isteği sen yapmadıysan hiçbir işlem yapmana gerek yok; e-postayı yok sayabilirsin.`;
    await sendEmail({to:u.email,subject:"Şifreni sıfırla · deploy-website",html:emailLayout({title,preheader:"Hesabına güvenli şekilde geri dönmek için şifreni yenile.",intro,body,buttonLabel:"Şifremi sıfırla",buttonUrl:link,footnote}),text:emailText({title,intro,body,buttonLabel:"Şifremi sıfırla",buttonUrl:link,footnote}),category:"password_reset",userId:u.id,idempotencyKey:`reset-${u.id}-${raw}`});
  } catch{ return res.status(502).json({ok:false,error:"E-posta gönderilemedi."}); }
  res.json({ok:true,message:"Eğer bu e-posta kayıtlıysa şifre sıfırlama bağlantısı gönderildi."});
});

app.post("/api/auth/reset-password",async(req,res)=>{
  cleanupAuthTokens(); const raw=String(req.body.token||""), next=String(req.body.password||"");
  if(!raw || next.length<10) return res.status(400).json({ok:false,error:"Geçerli bir bağlantı ve en az 10 karakter şifre gerekli."});
  const t=db.authTokens.find(x=>x.type==="reset"&&x.hash===sha(raw)&&!x.used&&x.expiresAt>Date.now());
  if(!t) return res.status(400).json({ok:false,error:"Bu sıfırlama bağlantısı geçersiz veya süresi dolmuş."});
  const u=db.users.find(x=>x.id===t.userId); if(!u) return res.status(404).json({ok:false,error:"Hesap bulunamadı"});
  const salt=crypto.randomBytes(16).toString("hex"); u.salt=salt; u.hash=passwordHash(next,salt); u.emailVerified=true; t.used=true;
  for(const [token,sess] of sessions){if(sess.userId===u.id)sessions.delete(token);}
  saveDB(); log("password_reset",{userId:u.id},u.email); res.json({ok:true});
});

app.post("/api/auth/login",async(req,res)=>{
  const ip=req.ip||"unknown"; if(rateLimited(ip)) return res.status(429).json({ok:false,error:"Çok fazla deneme. 10 dakika bekle."});
  if(String(req.body.website||"").trim()) return res.status(400).json({ok:false,error:"Giriş doğrulaması başarısız"});
  const email=String(req.body.email||"").trim().toLowerCase(), password=String(req.body.password||"");
  const u=db.users.find(x=>x.email===email);
  if(u?.banned){ failLogin(ip); return res.status(403).json({ok:false,code:"BANNED",error:"Bu hesap yasaklandı.",message:u.banReason||"Bu hesap yöneticiniz tarafından erişime kapatıldı.",bannedAt:u.bannedAt||null}); }
  let valid=false;
  if(u && typeof u.salt === "string" && typeof u.hash === "string") {
    const a=Buffer.from(passwordHash(password,u.salt)), b=Buffer.from(u.hash);
    valid=a.length===b.length && crypto.timingSafeEqual(a,b);
  }
  if(!valid){failLogin(ip);return res.status(401).json({ok:false,error:"E-posta veya şifre hatalı"});}
  if(u.emailVerified===false) return res.status(403).json({ok:false,code:"EMAIL_NOT_VERIFIED",error:"Önce e-posta adresini doğrula."});
  u.lastLoginAt=now(); setSession(res,u); log("login",{email},email); saveDB(); res.json({ok:true,user:safeUser(u)});
});
app.post("/api/auth/logout",(req,res)=>{
  const t=cookies(req).kc_session;if(t)sessions.delete(t);
  res.setHeader("Set-Cookie","kc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  res.json({ok:true});
});
app.get("/api/auth/me",(req,res)=>{const u=userFromReq(req);res.json({ok:true,user:u?safeUser(u):null});});

app.get("/api/health",(req,res)=>res.json({ok:true,status:"online",version:"4.1.0",service:"Deploy Website",database:{type:mongoState.configured?"mongodb+json-fallback":"json",mongodb:mongoState},domain:DOMAIN,dashboardHost:DASHBOARD_HOST,users:db.users.length,admin:!!db.users.find(u=>u.email===ADMIN_EMAIL&&u.role==="admin"),host:req.hostname,forwardedHost:req.headers["x-forwarded-host"]||null,forwardedProto:req.headers["x-forwarded-proto"]||null,time:now()}));

app.patch("/api/account/profile",auth,(req,res)=>{
  const u=req.user;
  if(req.body.firstName!==undefined) u.firstName=String(req.body.firstName).trim().slice(0,50);
  if(req.body.lastName!==undefined) u.lastName=String(req.body.lastName).trim().slice(0,50);
  if(req.body.username!==undefined){const username=safeSlug(req.body.username).slice(0,30); if(username && db.users.some(x=>x.id!==u.id&&x.username===username)) return res.status(409).json({ok:false,error:"Bu kullanıcı adı zaten kullanımda"}); u.username=username;}
  if(req.body.phone!==undefined) u.phone=String(req.body.phone).trim().slice(0,30);
  if(req.body.website!==undefined) u.website=String(req.body.website).trim().slice(0,160);
  if(req.body.bio!==undefined) u.bio=String(req.body.bio).trim().slice(0,300);
  u.displayName=[u.firstName,u.lastName].filter(Boolean).join(" ")||u.email; saveDB(); log("profile_updated",{userId:u.id},u.email); res.json({ok:true,user:safeUser(u)});
});
app.post("/api/feedback/report",auth,async(req,res)=>{
  const category=String(req.body.category||"Other").slice(0,40);
  const subject=String(req.body.subject||"").trim().slice(0,120);
  const message=String(req.body.message||"").trim().slice(0,4000);
  const page=String(req.body.page||"/").slice(0,160);
  if(!subject||!message) return res.status(400).json({ok:false,error:"Subject and details are required."});
  const report={id:id("report"),createdAt:now(),userId:req.user.id,email:req.user.email,category,subject,message,page,status:"new"};
  db.feedbackReports.unshift(report); db.feedbackReports=db.feedbackReports.slice(0,500); saveDB();
  log("feedback_reported",{reportId:report.id,category,subject,page},req.user.email);
  if(RESEND_API_KEY){
    try{
      const body=`<p><strong>Category:</strong> ${emailEsc(category)}</p><p><strong>Page:</strong> ${emailEsc(page)}</p><p><strong>User:</strong> ${emailEsc(req.user.email)}</p><div style="margin-top:18px;padding:14px;border:1px solid #2b2f39;border-radius:10px;color:#c6cad3;white-space:pre-wrap">${emailEsc(message)}</div>`;
      await sendEmail({to:ADMIN_EMAIL,subject:`[deploy-website] ${category}: ${subject}`,html:emailLayout({eyebrow:"SUPPORT REPORT",title:subject,preheader:"New issue report from deploy-website.",intro:`Reported by ${req.user.email} on ${page}.`,body,footnote:"This is an internal deploy-website support report."}),text:emailText({title:subject,intro:`Reported by ${req.user.email} on ${page}.`,body:`Category: ${category}\n\n${message}`}),category:"support_report",userId:req.user.id,idempotencyKey:`report-${report.id}`});
      report.status="notified"; saveDB();
    }catch(err){ console.warn("Support report email failed:",err.message); }
  }
  res.json({ok:true,reportId:report.id});
});
app.post("/api/account/password",auth,(req,res)=>{
  const current=String(req.body.currentPassword||""), next=String(req.body.newPassword||"");
  if(next.length<12) return res.status(400).json({ok:false,error:"Yeni şifre en az 12 karakter olmalı"});
  if(!uPasswordMatches(req.user,current)) return res.status(400).json({ok:false,error:"Mevcut şifre hatalı"});
  const salt=crypto.randomBytes(16).toString("hex"); req.user.salt=salt; req.user.hash=passwordHash(next,salt);
  for(const [token,sess] of sessions){if(sess.userId===req.user.id)sessions.delete(token);}
  setSession(res,req.user); saveDB(); log("password_changed",{userId:req.user.id},req.user.email); res.json({ok:true});
});
function uPasswordMatches(u,password){ if(!u||typeof u.salt!=="string"||typeof u.hash!=="string")return false; const a=Buffer.from(passwordHash(password,u.salt)),b=Buffer.from(u.hash); return a.length===b.length&&crypto.timingSafeEqual(a,b);}

app.get("/api/dashboard",auth,(req,res)=>{
  const all=req.user.email===ADMIN_EMAIL;
  const projects=db.projects.filter(p=>all||p.ownerId===req.user.id);
  const deps=db.deployments.filter(d=>projects.some(p=>p.id===d.projectId));
  res.json({
    ok:true, user:safeUser(req.user),
    stats:{projects:projects.length,live:projects.filter(p=>p.status==="live").length,deployments:deps.length,storage:deps.reduce((a,d)=>a+(d.bytes||0),0),members:all?db.users.length:undefined},
    projects:projects.map(p=>({...p,url:`https://${p.slug}.${DOMAIN}`})),
    recent:db.activity.slice(0,15)
  });
});
app.get("/api/projects",auth,(req,res)=>{
  const all=req.user.email===ADMIN_EMAIL;
  res.json({ok:true,projects:db.projects.filter(p=>all||p.ownerId===req.user.id).map(p=>({...p,url:`https://${p.slug}.${DOMAIN}`}))});
});
app.get("/api/projects/:id",auth,(req,res)=>{
  const p=projectFor(req,req.params.id); if(!p)return res.status(404).json({ok:false,error:"Proje bulunamadı"});
  const deps=db.deployments.filter(d=>d.projectId===p.id);
  res.json({ok:true,project:{...p,url:`https://${p.slug}.${DOMAIN}`},deployments:deps});
});
app.patch("/api/projects/:id",auth,(req,res)=>{
  const p=projectFor(req,req.params.id); if(!p)return res.status(404).json({ok:false,error:"Proje bulunamadı"});
  if(req.body.name!==undefined) p.name=String(req.body.name).trim().slice(0,100)||p.name;
  if(req.body.public!==undefined) p.public=!!req.body.public;
  p.updatedAt=now();saveDB();log("project_updated",{projectId:p.id},req.user.email);
  res.json({ok:true,project:{...p,url:`https://${p.slug}.${DOMAIN}`}});
});
app.delete("/api/projects/:id",auth,(req,res)=>{
  const p=projectFor(req,req.params.id); if(!p)return res.status(404).json({ok:false,error:"Proje bulunamadı"});
  db.projects=db.projects.filter(x=>x.id!==p.id);db.deployments=db.deployments.filter(d=>d.projectId!==p.id);
  fs.rmSync(path.join(SITES,p.slug),{recursive:true,force:true}); fs.rmSync(path.join(RELEASES,p.id),{recursive:true,force:true});
  saveDB();log("project_deleted",{projectId:p.id,slug:p.slug},req.user.email);res.json({ok:true});
});

app.post("/api/deploy/zip",auth,upload.single("file"),async(req,res)=>{
  if(!req.file)return res.status(400).json({ok:false,error:"ZIP seçilmedi"});
  const work=path.join(TMP,id("extract"));
  try{
    fs.mkdirSync(work,{recursive:true});
    const zip=new AdmZip(req.file.path), entries=zip.getEntries();
    if(entries.length>MAX_FILES)throw new Error("Dosya sayısı limiti aşıldı");
    for(const e of entries){
      if(e.isDirectory)continue;
      const rel=safePath(e.entryName.replace(/\/+$/,"")), dest=path.join(work,rel);
      if(!dest.startsWith(work+path.sep))throw new Error("Güvensiz ZIP yolu");
      const data=e.getData();
      if(data.length>MAX_UNZIPPED)throw new Error("Tek dosya boyutu limiti aşıldı");
      fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,data);
    }
    const existing=req.body.projectId?projectFor(req,req.body.projectId):null; if(req.body.projectId&&!existing)throw new Error("Proje bulunamadı"); const p=await createDeployment(work,req.user,req.body.name,req.body.slug,existing,String(req.body.preview)==="true");
    res.json({ok:true,project:p});
  }catch(e){res.status(400).json({ok:false,error:e.message||"Deployment başarısız"});}
  finally{try{fs.unlinkSync(req.file.path)}catch{}fs.rmSync(work,{recursive:true,force:true});}
});

app.post("/api/deploy/folder",auth,upload.array("files",MAX_FILES),async(req,res)=>{
  const files=req.files||[],work=path.join(TMP,id("folder"));
  try{
    fs.mkdirSync(work,{recursive:true});
    let paths=req.body.paths||[];if(!Array.isArray(paths))paths=[paths];
    if(paths.length!==files.length)throw new Error("Dosya yolları eşleşmedi");
    for(let i=0;i<files.length;i++){
      const rel=safePath(paths[i]),dest=path.join(work,rel);
      if(!dest.startsWith(work+path.sep))throw new Error("Güvensiz yol");
      fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(files[i].path,dest);
    }
    const existing=req.body.projectId?projectFor(req,req.body.projectId):null; if(req.body.projectId&&!existing)throw new Error("Proje bulunamadı"); const p=await createDeployment(work,req.user,req.body.name,req.body.slug,existing,String(req.body.preview)==="true");res.json({ok:true,project:p});
  }catch(e){res.status(400).json({ok:false,error:e.message||"Deployment başarısız"});}
  finally{for(const f of files)try{fs.unlinkSync(f.path)}catch{}fs.rmSync(work,{recursive:true,force:true});}
});

app.get("/api/projects/:id/deployments",auth,(req,res)=>{
  const p=projectFor(req,req.params.id);if(!p)return res.status(404).json({ok:false,error:"Proje bulunamadı"});
  res.json({ok:true,deployments:db.deployments.filter(d=>d.projectId===p.id)});
});

app.post("/api/projects/:id/rollback/:deploymentId",auth,(req,res)=>{
  const p=projectFor(req,req.params.id);if(!p)return res.status(404).json({ok:false,error:"Proje bulunamadı"});
  const d=db.deployments.find(x=>x.id===req.params.deploymentId&&x.projectId===p.id);
  if(!d)return res.status(404).json({ok:false,error:"Deployment bulunamadı"});
  if(!d.releasePath || !fs.existsSync(d.releasePath))return res.status(409).json({ok:false,error:"Bu deployment için snapshot bulunamadı."});
  const dest=path.join(SITES,p.slug),stage=path.join(SITES,`.rollback-${p.slug}-${crypto.randomBytes(4).toString("hex")}`);
  fs.cpSync(d.releasePath,stage,{recursive:true});fs.rmSync(dest,{recursive:true,force:true});fs.renameSync(stage,dest);
  p.currentDeploymentId=d.id;p.updatedAt=now();p.files=d.files;p.bytes=d.bytes;p.status="live";
  saveDB();log("deployment_rollback",{projectId:p.id,deploymentId:d.id},req.user.email);
  res.json({ok:true,project:{...p,url:`https://${p.slug}.${DOMAIN}`},deployment:d});
});

app.get("/api/admin/system",admin,(req,res)=>{
  let storage=0; const walk=d=>{if(!fs.existsSync(d))return; for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name); if(e.isDirectory())walk(p); else {try{storage+=fs.statSync(p).size}catch{}}}}; walk(STORAGE);
  res.json({ok:true,node:process.version,platform:process.platform,uptime:process.uptime(),memory:process.memoryUsage(),storage,projects:db.projects.length,deployments:db.deployments.length,users:db.users.length});
});

app.get("/api/admin/overview",admin,(req,res)=>{
  const storage=db.deployments.reduce((a,d)=>a+(d.bytes||0),0);
  res.json({ok:true,admin:{email:ADMIN_EMAIL},users:db.users.map(safeUser),projects:db.projects.map(p=>({...p,url:`https://${p.slug}.${DOMAIN}`})),deployments:db.deployments,activity:db.activity,feedbackReports:db.feedbackReports.slice(0,200),settings:{...db.settings},metrics:{users:db.users.length,projects:db.projects.length,live:db.projects.filter(p=>p.status==="live").length,banned:db.users.filter(u=>u.banned).length,deployments:db.deployments.length,storage}});
});
app.patch("/api/admin/settings",admin,(req,res)=>{
  if(typeof req.body.brandName==="string"&&req.body.brandName.trim())db.settings.brandName=req.body.brandName.trim().slice(0,40);
  for(const k of ["maintenance","registration","publicDirectory"]) if(req.body[k]!==undefined)db.settings[k]=!!req.body[k];
  if(req.body.maxProjectsPerUser!==undefined)db.settings.maxProjectsPerUser=Math.max(1,Math.min(100,Number(req.body.maxProjectsPerUser)||20));
  saveDB();log("settings_updated",db.settings,req.user.email);res.json({ok:true,settings:db.settings});
});
app.patch("/api/admin/users/:id",admin,(req,res)=>{
  const u=db.users.find(x=>x.id===req.params.id);if(!u)return res.status(404).json({ok:false,error:"Üye bulunamadı"});
  if(u.email===ADMIN_EMAIL)return res.status(400).json({ok:false,error:"Admin hesabı değiştirilemez"});
  if(req.body.banned!==undefined){u.banned=!!req.body.banned;u.banReason=String(req.body.reason||"").trim().slice(0,240)||null;u.bannedAt=u.banned?now():null;}
  if(u.banned){for(const [token,sess] of sessions){if(sess.userId===u.id)sessions.delete(token);}}
  saveDB();log(u.banned?"member_banned":"member_unbanned",{userId:u.id,email:u.email,reason:u.banReason||null},req.user.email);res.json({ok:true,user:safeUser(u)});
});
app.delete("/api/admin/users/:id",admin,(req,res)=>{
  const u=db.users.find(x=>x.id===req.params.id);if(!u||u.email===ADMIN_EMAIL)return res.status(400).json({ok:false,error:"Bu hesap silinemez"});
  const owned=db.projects.filter(p=>p.ownerId===u.id); for(const p of owned){fs.rmSync(path.join(SITES,p.slug),{recursive:true,force:true});fs.rmSync(path.join(RELEASES,p.id),{recursive:true,force:true});}
  const ids=new Set(owned.map(p=>p.id)); db.projects=db.projects.filter(x=>x.ownerId!==u.id); db.deployments=db.deployments.filter(d=>!ids.has(d.projectId)); db.users=db.users.filter(x=>x.id!==u.id);
  for(const [token,sess] of sessions){if(sess.userId===u.id)sessions.delete(token);} saveDB();log("member_deleted",{email:u.email,projectsDeleted:owned.length},req.user.email);res.json({ok:true,projectsDeleted:owned.length});
});
app.patch("/api/admin/projects/:id/status",admin,(req,res)=>{
  const p=db.projects.find(x=>x.id===req.params.id);if(!p)return res.status(404).json({ok:false,error:"Proje bulunamadı"});
  const allowed=["live","suspended","maintenance"];
  if(!allowed.includes(req.body.status))return res.status(400).json({ok:false,error:"Geçersiz durum"});
  p.status=req.body.status;p.updatedAt=now();saveDB();log("project_status_changed",{projectId:p.id,status:p.status},req.user.email);res.json({ok:true,project:p});
});
app.delete("/api/admin/projects/:id",admin,(req,res)=>{
  const p=db.projects.find(x=>x.id===req.params.id);if(!p)return res.status(404).json({ok:false,error:"Proje bulunamadı"});
  db.projects=db.projects.filter(x=>x.id!==p.id);db.deployments=db.deployments.filter(d=>d.projectId!==p.id);
  fs.rmSync(path.join(SITES,p.slug),{recursive:true,force:true});fs.rmSync(path.join(RELEASES,p.id),{recursive:true,force:true});
  saveDB();log("admin_project_deleted",{projectId:p.id,slug:p.slug,owner:p.ownerEmail},req.user.email);res.json({ok:true});
});
app.delete("/api/admin/activity/:id",admin,(req,res)=>{
  const before=db.activity.length;
  db.activity=db.activity.filter(a=>a.id!==req.params.id);
  if(before===db.activity.length)return res.status(404).json({ok:false,error:"Aktivite kaydı bulunamadı"});
  saveDB();
  res.json({ok:true});
});
app.delete("/api/admin/activity",admin,(req,res)=>{
  const removed=db.activity.length;
  db.activity=[];
  saveDB();
  res.json({ok:true,removed});
});

app.get("/api/admin/public-projects",admin,(req,res)=>{
  res.json({ok:true,projects:db.projects.map(p=>({...p,url:`https://${p.slug}.${DOMAIN}`}))});
});

function hostProject(req){
  const host=(req.hostname||"").toLowerCase().split(":")[0];
  if(host===DASHBOARD_HOST||!host.endsWith("."+DOMAIN))return null;
  const prefix=host.slice(0,-(DOMAIN.length+1));
  if(!prefix||prefix.includes("."))return null;
  if(prefix.startsWith("preview-")){
    const dep=db.deployments.find(d=>d.previewHost===prefix);
    if(!dep)return {kind:"preview",slug:null,dep:null};
    const p=db.projects.find(x=>x.id===dep.projectId);
    return {kind:"preview",slug:p?.slug||null,dep,p};
  }
  return {kind:"live",slug:safeSlug(prefix)};
}
app.use((req,res,next)=>{
  const route=hostProject(req); if(!route)return next();
  if(route.kind==="preview"){
    if(!route.dep||!route.p)return res.status(404).send("Preview not found");
    if(!route.dep.releasePath||!fs.existsSync(route.dep.releasePath))return res.status(404).send("Preview files not found");
    return express.static(route.dep.releasePath,{index:"index.html",fallthrough:true,setHeaders:(r,pth)=>{
      r.setHeader("Cache-Control","no-store");
    }})(req,res,next);
  }
  const p=db.projects.find(x=>x.slug===route.slug);
  if(!p)return res.status(404).send("Project not found");
  if(p.status!=="live")return res.status(503).send("Project temporarily unavailable");
  const wantsDocument=req.method==="GET" && (req.path==="/" || /\.html?$/i.test(req.path) || String(req.headers.accept||"").includes("text/html"));
  if(wantsDocument){p.views=(p.views||0)+1; p.lastViewedAt=now(); saveDB();}
  const dir=path.join(SITES,route.slug);
  if(!fs.existsSync(dir))return res.status(404).send("Project files not found");
  return express.static(dir,{index:"index.html",fallthrough:true,setHeaders:(r,pth)=>{
    r.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
    r.setHeader("Pragma","no-cache");
    r.setHeader("Expires","0");
  }})(req,res,next);
});

app.use(express.static(PUBLIC,{index:"index.html",setHeaders:(r,pth)=>{
  if(/\.(html|js|css|svg|png|jpg|jpeg|webp|gif|ico)$/i.test(pth)){
    r.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
    r.setHeader("Pragma","no-cache");
    r.setHeader("Expires","0");
  }
}}));
app.use((req,res)=>{
  if(req.path.startsWith("/api/"))return res.status(404).json({ok:false,error:"Not found"});
  res.sendFile(path.join(PUBLIC,"index.html"));
});
async function startServer(){
  if (mongo && MONGODB_URI) {
    const result = await mongo.initMongo(MONGODB_URI, db);
    mongoState = { configured:true, connected:!!result.connected, error:result.error||null };
    if (result.connected && result.data) {
      const incoming = result.data;
      db = {...defaultDB(), ...incoming, settings:{...defaultDB().settings,...(incoming.settings||{})}};
      if(!Array.isArray(db.authTokens)) db.authTokens=[];
      if(!Array.isArray(db.feedbackReports)) db.feedbackReports=[];
      for(const u of db.users){ if(typeof u.emailVerified !== "boolean") u.emailVerified=true; }
      saveDB();
      console.log("MongoDB connected: cloud state loaded.");
    } else {
      console.warn("MongoDB unavailable; continuing with local JSON storage.");
    }
  }
  const server = app.listen(PORT,HOST,()=>console.log(`deploy-website 4.1 running at http://${HOST}:${PORT}`));
  const shutdown = async () => {
    clearTimeout(saveTimer);
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8"); } catch {}
    try { await mongo?.closeMongo(); } catch {}
    server.close(()=>process.exit(0));
  };
  process.on("SIGINT",shutdown);
  process.on("SIGTERM",shutdown);
}
startServer().catch(err=>{ console.error("Deploy Website startup failed:",err); process.exit(1); });
