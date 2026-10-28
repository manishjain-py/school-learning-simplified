/* Local explicit-artwork Avatar extension. Reuses R7's pinned Playwright runtime. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const here=path.dirname(fileURLToPath(import.meta.url));
const [scenePath,configPath,outDir]=process.argv.slice(2);
const scene=JSON.parse(fs.readFileSync(scenePath));
const config=JSON.parse(fs.readFileSync(configPath));
const safeJSON=value=>JSON.stringify(value).replaceAll('<','\\u003c');
if(scene.schema!=='local-avatar/v1'||config.schema!=='local-avatar-render/v1')throw new Error('Unsupported Avatar ABI');
if(config.artwork_file!=='artwork.png'||config.audio_file!=='narration.wav')throw new Error('Avatar uses fixed local media filenames');
const pageHTML=`<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local stylized Avatar</title><style>body{margin:0;font:16px system-ui;background:#e8edef;color:#16333d}#stage{width:512px;max-width:100vw;line-height:0}canvas{display:block;width:100%;height:auto}#controls{padding:12px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}audio{width:300px;max-width:100%;min-width:0}p,#error{padding:12px}#error{white-space:pre-wrap;color:#a21c1c}</style><div id="stage"></div><div id="controls"><button id="play">Play</button><button id="restart">Restart</button><span id="clock">0s</span><audio id="audio" controls></audio></div><p>Stylized audio-energy-driven animation. Not photorealistic or phoneme-accurate lip-sync.</p><pre id="error"></pre><script>window.LOCAL_SCENE=${safeJSON(scene)};window.LOCAL_CONFIG=${safeJSON(config)};</script><script src="avatar-viewer.js"></script></html>`;
fs.mkdirSync(outDir,{recursive:true});
fs.writeFileSync(path.join(outDir,'viewer.html'),pageHTML);
fs.copyFileSync(path.join(here,'avatar-viewer.js'),path.join(outDir,'avatar-viewer.js'));
const files=new Map([['/viewer.html',path.join(outDir,'viewer.html')],['/avatar-viewer.js',path.join(outDir,'avatar-viewer.js')],['/artwork.png',path.join(outDir,'artwork.png')],['/narration.wav',path.join(outDir,'narration.wav')]]);
const types={'.html':'text/html','.js':'text/javascript','.wav':'audio/wav','.png':'image/png'};
const server=http.createServer((req,res)=>{
  const file=files.get(req.url);if(!file){res.writeHead(403);res.end('not allowlisted');return;}
  const total=fs.statSync(file).size;
  const range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const start=range?Number(range[1]):0,end=range&&range[2]?Number(range[2]):total-1;
  if(req.headers.range&&(!range||start>=total||end<start||end>=total)){
    res.writeHead(416,{'Content-Range':`bytes */${total}`});res.end();return;
  }
  res.writeHead(range?206:200,{'Content-Type':types[path.extname(file)],'Accept-Ranges':'bytes',
    'Content-Length':end-start+1,...(range?{'Content-Range':`bytes ${start}-${end}/${total}`}:{})});
  fs.createReadStream(file,{start,end}).pipe(res);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
  browser=await chromium.launch({headless:true,executablePath:chromium.executablePath(),args:['--disable-dev-shm-usage']});
  const context=await browser.newContext({viewport:{width:700,height:900},deviceScaleFactor:1,serviceWorkers:'block'});
  await context.route('**/*',route=>{const url=route.request().url();return [...files.keys()].some(p=>url===origin+p)?route.continue():route.abort('blockedbyclient');});
  const page=await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.goto(origin+'/viewer.html');
  await page.waitForFunction(()=>window.mediaReady||window.mediaFailure,{timeout:30000});
  const failure=await page.evaluate(()=>window.mediaFailure);if(failure)throw new Error(failure);
  fs.mkdirSync(path.join(outDir,'video-frames'),{recursive:true});
  if(!Number.isInteger(config.video_frame_count)||config.video_frame_count<1||config.video_frame_count>18000)throw new Error('Avatar video frame limit exceeded');
  for(let i=0;i<config.video_frame_count;i++){
    await page.evaluate(t=>window.renderAt(t),i*1000/config.fps);
    await page.locator('#stage').screenshot({path:path.join(outDir,'video-frames',String(i).padStart(6,'0')+'.png'),animations:'disabled'});
  }
  await page.evaluate(()=>window.renderAt(0));
  const replay=await page.locator('#stage').screenshot({animations:'disabled'});
  if(!replay.equals(fs.readFileSync(path.join(outDir,'video-frames/000000.png'))))throw new Error('Avatar renderAt is not deterministic');
  if(errors.length)throw new Error(errors.join('\n'));
  const dimensions=await page.evaluate(()=>window.mediaReady);
  await context.close();
  console.log(JSON.stringify({browser_version:browser.version(),dimensions,rendered_frames:config.video_frame_count,deterministic_replay:true,network:'exact four-file loopback allowlist; all other requests blocked'}));
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
