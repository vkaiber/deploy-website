const http = require('http');
const https = require('https');
const { URL } = require('url');

const local = `http://127.0.0.1:${process.env.PORT || 3000}/api/health`;
const publicUrl = `https://${process.env.BCLOUD_HOST || 'app.example.com'}/api/health`;

function check(raw) {
  return new Promise(resolve => {
    const u = new URL(raw); const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(raw,{headers:{'Cache-Control':'no-cache','User-Agent':'Deploy Website-Diagnostic/3.5'}},res=>{
      let body=''; res.setEncoding('utf8'); res.on('data',c=>body+=c); res.on('end',()=>{
        let json=null; try{json=JSON.parse(body)}catch{}
        resolve({url:raw,status:res.statusCode,contentType:res.headers['content-type']||'',server:res.headers.server||'',version:json?.version||null,body:body.slice(0,500)});
      });
    });
    req.setTimeout(8000,()=>req.destroy(new Error('timeout')));
    req.on('error',e=>resolve({url:raw,error:e.message}));
  });
}
(async()=>{
  console.log('Deploy Website 3.5 domain teşhisi\n');
  const [a,b]=await Promise.all([check(local),check(publicUrl)]);
  console.log('LOCAL :',JSON.stringify(a,null,2));
  console.log('\nPUBLIC:',JSON.stringify(b,null,2));
  console.log('\nSONUÇ:');
  if(a.error){console.log('❌ Node 3000 portunda çalışmıyor. Önce npm start çalıştır.');process.exitCode=2;return;}
  if(a.status!==200||!a.version){console.log('❌ Local /api/health beklenen yanıtı vermiyor.');process.exitCode=2;return;}
  if(b.error){console.log('❌ app.example.com dışarıdan erişilemiyor. DNS/Tunnel durumunu kontrol et.');process.exitCode=3;return;}
  if(b.status===502){console.log('❌ Cloudflare Tunnel origin Node 3000\'e ulaşamıyor. cloudflared loglarında origin bağlantısını kontrol et.');process.exitCode=3;return;}
  if(b.status===401){console.log('❌ Public hostname 401 döndürüyor. Cloudflare Access/Zero Trust policy route\'u engelliyor olabilir.');process.exitCode=3;return;}
  if(b.status!==200||!b.version){console.log('❌ Public route Deploy Website health endpointine ulaşmıyor.');process.exitCode=3;return;}
  if(a.version!==b.version){console.log(`⚠️ Local ${a.version}, public ${b.version}. Cloudflare farklı/eski bir origin gösteriyor olabilir.`);process.exitCode=3;return;}
  console.log(`✅ Local + public OK. Sürüm ${a.version}.`);
})();
