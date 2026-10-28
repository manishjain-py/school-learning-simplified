/* Newly written local-media/v1 browser ABI. No source runtime or assets. */
(async () => {
  'use strict';
  const scene = window.LOCAL_SCENE;
  const config = window.LOCAL_CONFIG;
  const stage = document.getElementById('stage');
  const diagnostics = [];
  const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  let render, duration = config.duration_ms || Math.max(1000, ...(config.frame_times_ms || [0]));
  let app;
  if (config.kind === 'pixi') {
    if (typeof scene.pixi_code !== 'string' || !scene.pixi_code.trim()) throw new Error('Missing authored pixi_code');
    // Model code runs only in this disposable browser. Requests remain blocked by
    // the renderer context. No application creation, imports or remote assets ABI.
    if (/\b(?:import|require|fetch|XMLHttpRequest|WebSocket|Worker|eval)\b|new\s+(?:PIXI\.)?Application\b/.test(scene.pixi_code)) throw new Error('pixi_code uses an unsupported import/application/network API');
    app = new PIXI.Application();
    await app.init({width:500,height:350,background:0xffffff,antialias:true,autoStart:false,preference:'webgl',resolution:1});
    app.ticker.stop();
    stage.appendChild(app.canvas);
    await (new Function('app', 'PIXI', `"use strict"; return (async()=>{${scene.pixi_code}\n})();`))(app, PIXI);
    app.ticker.stop();
    if (typeof globalThis.renderAt !== 'function') throw new Error('pixi_code must expose globalThis.renderAt(t_ms)');
    const authoredRender = globalThis.renderAt;
    render = async t => { await authoredRender(t); app.renderer.render(app.stage); };
    const slider = scene.interactive;
    if (slider != null) {
      if (slider.type !== 'slider' || typeof slider.param !== 'string' || !slider.param || !Number.isFinite(slider.min) || !Number.isFinite(slider.max) || slider.max <= slider.min || typeof globalThis.setParam !== 'function') throw new Error('Interactive ABI requires slider bounds, param and exposed setParam');
      for (const key of ['x','y','width']) if (!Number.isFinite(slider[key])) throw new Error('Slider requires finite x/y/width');
      if (slider.x < 0 || slider.y < 0 || slider.width <= 0 || slider.x + slider.width > 500 || slider.y + 30 > 350) throw new Error('Slider bounds exceed 500x350 canvas');
      if (slider.step != null && (!Number.isFinite(slider.step) || slider.step <= 0)) throw new Error('Invalid slider step');
      if (slider.steps != null && (!Number.isInteger(slider.steps) || slider.steps < 1 || slider.step != null)) throw new Error('steps requires a positive count and no step');
      const wrapper = document.createElement('label');
      wrapper.style.cssText = `position:absolute;left:${slider.x/5}%;top:${slider.y/3.5}%;width:${slider.width/5}%;font:12px system-ui;color:#16333d;background:#fffffff0`;
      wrapper.textContent = slider.label || slider.param;
      const input = document.createElement('input');
      input.id = 'interaction'; input.type = 'range'; input.min=slider.min; input.max=slider.max; input.step=slider.step || (slider.steps ? (slider.max-slider.min)/slider.steps : 'any'); input.value=slider.min;
      input.style.cssText='display:block;width:100%;margin:0';
      input.addEventListener('input', async () => { globalThis.setParam(slider.param, Number(input.value), true); await render(window.currentTime || 0); });
      input.addEventListener('change', async () => { globalThis.setParam(slider.param, Number(input.value), false); await render(window.currentTime || 0); });
      wrapper.appendChild(input); stage.appendChild(wrapper);
      globalThis.setParam(slider.param, Number(input.value), false);
    }
  } else if (config.kind === 'svg') {
    if (scene.medium !== 'svg_illustration' || scene.source_medium !== 'illustration' || typeof scene.adaptation !== 'string' || !scene.adaptation.trim() || typeof scene.svg_source !== 'string') throw new Error('SVG illustration needs explicit adapted local ABI');
    const xml = new DOMParser().parseFromString(scene.svg_source, 'image/svg+xml');
    const svg = xml.documentElement;
    if (svg.localName !== 'svg' || xml.querySelector('parsererror')) throw new Error('Invalid SVG');
    const allowed = new Set(['svg','g','path','text','tspan','rect','ellipse','circle','line','polyline','polygon','defs','linearGradient','radialGradient','stop','clipPath','title','desc']);
    for (const node of [svg, ...svg.querySelectorAll('*')]) {
      if (!allowed.has(node.localName)) throw new Error('Unsupported SVG element: '+node.localName);
      for (const attr of [...node.attributes]) {
        if (attr.name==='xmlns' && attr.value==='http://www.w3.org/2000/svg') continue;
        if (/^on/i.test(attr.name) || /(?:href|src)$/i.test(attr.name) || /(?:https?:|file:|data:|javascript:|@import)/i.test(attr.value) || /url\(\s*[^#]/i.test(attr.value)) throw new Error('External/executable SVG attributes unsupported');
      }
    }
    svg.setAttribute('width','500'); svg.setAttribute('height','350');
    if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox','0 0 500 350');
    stage.appendChild(document.importNode(svg,true)); render = async () => {};
  } else if (config.kind === 'board') {
    if (scene.schema !== 'local-board/v1') throw new Error('Unsupported board schema');
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox','0 0 1000 700'); svg.setAttribute('width','1000'); svg.setAttribute('height','700');
    svg.style.background='#fffdf7';
    stage.appendChild(svg);
    const built = new Map();
    for (const node of scene.nodes) {
      const group = document.createElementNS(ns,'g');
      const shape = document.createElementNS(ns, node.type === 'arrow' ? 'path' : node.type);
      const attrs = {stroke:node.stroke || '#263238', fill:node.fill || (node.type === 'text' ? '#263238':'none'), 'stroke-width':node.stroke_width || 3, 'stroke-linecap':'round', 'stroke-linejoin':'round'};
      for (const [key,value] of Object.entries(node)) if (!['id','type','stroke','fill','stroke_width','text','font_size'].includes(key)) attrs[key]=value;
      if (node.type === 'text') {
        shape.textContent=node.text; attrs['font-size']=node.font_size; attrs['font-family']='Arial, sans-serif'; attrs.stroke='none';
      }
      if (node.type === 'arrow') {
        const {x1,y1,x2,y2}=node, a=Math.atan2(y2-y1,x2-x1), h=18;
        for(const key of ['x1','y1','x2','y2']) delete attrs[key];
        attrs.d=`M ${x1} ${y1} L ${x2} ${y2} M ${x2-h*Math.cos(a-.5)} ${y2-h*Math.sin(a-.5)} L ${x2} ${y2} L ${x2-h*Math.cos(a+.5)} ${y2-h*Math.sin(a+.5)}`;
      }
      for (const [key,value] of Object.entries(attrs)) shape.setAttribute(key,value);
      group.appendChild(shape); svg.appendChild(group);
      let length = node.type === 'text' ? 0 : shape.getTotalLength();
      if (!Number.isFinite(length)) throw new Error('Invalid vector geometry');
      built.set(node.id, {group,shape,length,node});
    }
    render = async t => {
      for (const [id,entry] of built) {
        const draw = scene.cues.find(c => c.action === 'draw' && c.targets.includes(id));
        const progress = draw ? Math.max(0,Math.min(1,(t-draw.start_ms)/(draw.end_ms-draw.start_ms || 1))) : 0;
        entry.group.setAttribute('opacity', progress > 0 ? '1':'0');
        if (entry.node.type === 'text') {
          // Progressive text reveal preserves the immutable authored string.
          entry.shape.textContent = entry.node.text.slice(0,Math.ceil(entry.node.text.length*progress));
        } else {
          entry.shape.setAttribute('stroke-dasharray', `${entry.length} ${entry.length}`);
          entry.shape.setAttribute('stroke-dashoffset', String(entry.length*(1-progress)));
          entry.shape.setAttribute('fill-opacity', String(progress === 1 ? 1 : 0));
        }
        const emph = scene.cues.some(c => c.action === 'emphasize' && c.targets.includes(id) && t >= c.start_ms && t <= c.end_ms+c.hold_ms);
        entry.group.style.filter = emph ? 'drop-shadow(0 0 5px #f4a621)' : '';
      }
    };
  } else throw new Error('Unknown renderer kind');
  window.renderAt = async t => { window.currentTime=t; await render(t); document.getElementById('clock').textContent=(t/1000).toFixed(2)+'s'; };
  await window.renderAt(0);
  const audio = document.getElementById('audio');
  if (config.audio_file) {audio.src=config.audio_file; audio.hidden=false;}
  const play = document.getElementById('play'); let playing=false, begin=0, saved=0, tailStart=null;
  const loop = async now => { if(!playing) return; if(config.audio_file&&audio.ended&&tailStart===null)tailStart=now; const t=config.audio_file?audio.currentTime*1000+(tailStart===null?0:now-tailStart):Math.min(duration,saved+now-begin); await window.renderAt(t); if(t>=duration){playing=false;play.textContent='Play';return;}requestAnimationFrame(loop);};
  play.onclick=async()=>{playing=!playing;play.textContent=playing?'Pause':'Play';if(playing){begin=performance.now();saved=window.currentTime||0;if(config.audio_file){tailStart=null;audio.currentTime=saved/1000;await audio.play();}requestAnimationFrame(loop);}else{saved=window.currentTime||0;audio.pause();}};
  audio.addEventListener('seeked',()=>window.renderAt(audio.currentTime*1000));
  document.getElementById('restart').onclick=async()=>{playing=false;play.textContent='Play';audio.pause();audio.currentTime=0;tailStart=null;saved=0;await window.renderAt(0);};
  window.mediaReady={diagnostics, width:config.kind==='board'?1000:500,height:config.kind==='board'?700:350};
})().catch(error=>{window.mediaFailure=String(error.stack||error);document.getElementById('error').textContent=window.mediaFailure;});
