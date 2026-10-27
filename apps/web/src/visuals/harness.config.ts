import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
export default defineConfig({
 root:fileURLToPath(new URL('../../',import.meta.url)),
 plugins:[react(),{name:'local-visual-assets',configureServer(server){server.middlewares.use(async(req,res,next)=>{
  const url=new URL(req.url||'/', 'http://localhost');
  const base=url.pathname.startsWith('/media/')?process.env.SLS_VISUAL_MEDIA_DIR:url.pathname.startsWith('/content/')?process.env.SLS_VISUAL_CONTENT_DIR:null;
  if(!base)return next();
  const prefix=url.pathname.startsWith('/media/')?'/media/':'/content/';
  const file=resolve(base,url.pathname.slice(prefix.length));
  if(!file.startsWith(resolve(base)+sep)){res.statusCode=400;res.end();return;}
  try{await stat(file);res.setHeader('Content-Type',file.endsWith('.json')?'application/json':file.endsWith('.mp3')?'audio/mpeg':file.endsWith('.png')?'image/png':'image/jpeg');createReadStream(file).pipe(res);}
  catch{res.statusCode=404;res.end('Asset unavailable');}
 });}}],
 server:{host:'127.0.0.1',port:4190,strictPort:true},
});
