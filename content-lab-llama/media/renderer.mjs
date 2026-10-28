/* Disposable Playwright browser, exact-file loopback server. No personal profile. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const here=path.dirname(fileURLToPath(import.meta.url));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if(process.argv[2]==='--identity'){
  const executable=chromium.executablePath();
  console.log(JSON.stringify({available:fs.existsSync(executable),playwright:JSON.parse(fs.readFileSync(path.join(here,'node_modules/playwright/package.json'))).version,pixi:JSON.parse(fs.readFileSync(path.join(here,'node_modules/pixi.js/package.json'))).version,browser_binary_sha256:fs.existsSync(executable)?hash(executable):null,browser_build:executable.split(path.sep).find(part=>part.startsWith('chromium-'))}));
  process.exit(0);
}
const [scenePath,configPath,outDir]=process.argv.slice(2);
const scene=JSON.parse(fs.readFileSync(scenePath));
const config=JSON.parse(fs.readFileSync(configPath));
const safeJSON=value=>JSON.stringify(value).replaceAll('<','\\u003c');
const pageHTML=`<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local media viewer</title><style>body{margin:0;font:16px system-ui;background:#e8edef;color:#16333d}#stage{position:relative;width:${config.kind==='board'?1000:500}px;max-width:100vw;background:white;line-height:0}#stage>canvas,#stage>svg{display:block;width:100%;height:auto}#controls{padding:12px;display:flex;gap:8px;align-items:center}button{padding:8px 16px}#error{white-space:pre-wrap;color:#a21c1c}</style><div id="stage"></div><div id="controls"><button id="play">Play</button><button id="restart">Restart</button><span id="clock">0s</span><audio id="audio" controls hidden></audio></div><pre id="error"></pre><script>window.LOCAL_SCENE=${safeJSON(scene)};window.LOCAL_CONFIG=${safeJSON(config)};</script>${config.kind==='pixi'?'<script src="pixi.min.js"></script>':''}<script src="viewer.js"></script></html>`;
fs.mkdirSync(outDir,{recursive:true});
fs.writeFileSync(path.join(outDir,'viewer.html'),pageHTML);
fs.copyFileSync(path.join(here,'viewer.js'),path.join(outDir,'viewer.js'));
if(config.kind==='pixi') fs.copyFileSync(path.join(here,'node_modules/pixi.js/dist/pixi.min.js'),path.join(outDir,'pixi.min.js'));
const files=new Map([['/viewer.html',path.join(outDir,'viewer.html')],['/viewer.js',path.join(outDir,'viewer.js')]]);
if(config.kind==='pixi')files.set('/pixi.min.js',path.join(outDir,'pixi.min.js'));
if(config.audio_file)files.set('/'+config.audio_file,path.join(outDir,config.audio_file));
const types={'.html':'text/html','.js':'text/javascript','.wav':'audio/wav'};
const server=http.createServer((req,res)=>{const file=files.get(req.url);if(!file){res.writeHead(403);res.end('not allowlisted');return;}res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});fs.createReadStream(file).pipe(res);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
  browser=await chromium.launch({headless:true,executablePath:chromium.executablePath(),args:['--disable-dev-shm-usage']});
  const context=await browser.newContext({viewport:{width:1100,height:850},deviceScaleFactor:1,serviceWorkers:'block'});
  await context.route('**/*',route=>{const url=route.request().url();if([...files.keys()].some(p=>url===origin+p))return route.continue();return route.abort('blockedbyclient');});
  const page=await context.newPage();
  const diagnostics=[];
  page.on('pageerror',error=>diagnostics.push({kind:'browser_error',message:String(error)}));
  await page.goto(origin+'/viewer.html');
  await page.waitForFunction(()=>window.mediaReady||window.mediaFailure,{timeout:30000});
  const failure=await page.evaluate(()=>window.mediaFailure);if(failure)throw new Error(failure);
  const dims=await page.evaluate(()=>window.mediaReady);
  const frames=[];fs.mkdirSync(path.join(outDir,'frames'),{recursive:true});
  const capture=async(t,view,extra={})=>{
    await page.setViewportSize({width:view==='phone'?390:1100,height:850});
    await page.evaluate(t=>window.renderAt(t),t);
    const filename=`frames/${String(frames.length).padStart(3,'0')}-${view}.png`;
    await page.locator('#stage').screenshot({path:path.join(outDir,filename),animations:'disabled'});
    const box=await page.locator('#stage').boundingBox();
    frames.push({file:filename,format:'png',width:Math.round(box.width),height:Math.round(box.height),t_ms:t,view,...extra});
  };
  for(const t of config.frame_times_ms){if(!Number.isFinite(t)||t<0||t>600000)throw new Error('Invalid frame time');await capture(t,'wide');if(config.kind==='board')await capture(t,'phone');}
  if(config.kind==='pixi'){
    await page.setViewportSize({width:1100,height:850});
    await page.evaluate(t=>window.renderAt(t),config.frame_times_ms[0]);
    const repeated=await page.locator('#stage').screenshot({animations:'disabled'});
    const first=fs.readFileSync(path.join(outDir,frames[0].file));
    if(!repeated.equals(first)) throw new Error('renderAt(t_ms) is not deterministic when revisiting the same time');
  }
  if(config.kind==='pixi'&&scene.interactive){
    const s=scene.interactive, values=config.interaction_values||[s.min,(s.min+s.max)/2,s.max];
    for(const value of values){
      if(!Number.isFinite(value)||value<s.min||value>s.max)throw new Error('Invalid slider capture value');
      // Dispatch the actual viewer input/change listeners, rather than invoking
      // setParam separately from the control implementation under test.
      const actualValue=await page.locator('#interaction').evaluate((el,value)=>{el.value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return Number(el.value);},value);
      await capture(config.frame_times_ms.at(-1),'interaction',{param:s.param,value:actualValue});
    }
  }
  if(config.kind==='board'){
    fs.mkdirSync(path.join(outDir,'video-frames'),{recursive:true});
    await page.setViewportSize({width:1100,height:850});
    const count=config.video_frame_count;
    if(count>18000)throw new Error('Video frame limit exceeded');
    for(let i=0;i<count;i++){await page.evaluate(t=>window.renderAt(t),Math.min(config.scene_duration_ms,i*1000/config.fps));await page.locator('#stage').screenshot({path:path.join(outDir,'video-frames',String(i).padStart(6,'0')+'.png'),animations:'disabled'});}
  }
  await context.close();console.log(JSON.stringify({frames,diagnostics,browser_version:browser.version(),dimensions:dims}));
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
