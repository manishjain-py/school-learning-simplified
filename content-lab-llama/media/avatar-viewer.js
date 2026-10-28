/* Newly written stylized mouth overlay. Input artwork is explicit frozen PNG. */
(async()=>{
  'use strict';
  const scene=window.LOCAL_SCENE,config=window.LOCAL_CONFIG;
  const canvas=document.createElement('canvas');canvas.width=512;canvas.height=768;
  document.getElementById('stage').appendChild(canvas);
  const ctx=canvas.getContext('2d');
  const portrait=new Image();portrait.src='artwork.png';await portrait.decode();
  if(portrait.naturalWidth!==512||portrait.naturalHeight!==768)throw new Error('Portrait must be512x768');
  const audio=document.getElementById('audio');audio.src='narration.wav';
  window.renderAt=async t=>{
    const index=Math.max(0,Math.min(scene.energy_curve.length-1,Math.floor(t*config.fps/1000+1e-7)));
    const height=scene.energy_curve[index].mouth_height,m=scene.mouth;
    ctx.clearRect(0,0,512,768);ctx.drawImage(portrait,0,0);
    ctx.fillStyle='#40182a';ctx.beginPath();ctx.ellipse(m.cx,m.cy,m.width/2,height/2,0,0,Math.PI*2);ctx.fill();
    if(height>m.closed_height+5){ctx.fillStyle='#f18e9c';ctx.beginPath();ctx.ellipse(m.cx,m.cy+height*.23,m.width*.29,height*.16,0,0,Math.PI*2);ctx.fill();}
    window.currentTime=t;document.getElementById('clock').textContent=(t/1000).toFixed(2)+'s';
  };
  await window.renderAt(0);
  const play=document.getElementById('play');let playing=false,tailStart=null,frameRequest=null;
  const stop=()=>{playing=false;play.textContent='Play';if(frameRequest!==null)cancelAnimationFrame(frameRequest);frameRequest=null;};
  const schedule=()=>{if(playing&&frameRequest===null)frameRequest=requestAnimationFrame(loop);};
  const loop=async now=>{
    frameRequest=null;if(!playing)return;
    const t=Math.min(config.duration_ms,audio.currentTime*1000+(tailStart===null?0:now-tailStart));
    await window.renderAt(t);
    if(t>=config.duration_ms){stop();return;}schedule();
  };
  // Audio events own the clock so both the native controls and our button work.
  audio.addEventListener('play',()=>{tailStart=null;playing=true;play.textContent='Pause';schedule();});
  audio.addEventListener('pause',()=>{if(!audio.ended){stop();window.renderAt(audio.currentTime*1000);}});
  audio.addEventListener('ended',()=>{tailStart=performance.now();playing=true;play.textContent='Pause';schedule();});
  audio.addEventListener('seeking',()=>{tailStart=null;window.renderAt(audio.currentTime*1000);});
  audio.addEventListener('seeked',()=>{tailStart=null;window.renderAt(audio.currentTime*1000);if(!audio.paused){playing=true;play.textContent='Pause';schedule();}else stop();});
  audio.addEventListener('timeupdate',()=>{if(!playing)window.renderAt(audio.currentTime*1000);});
  play.onclick=async()=>{
    if(playing){stop();audio.pause();return;}
    if(audio.ended||window.currentTime>=config.scene_duration_ms)audio.currentTime=0;
    await audio.play();
  };
  document.getElementById('restart').onclick=async()=>{stop();audio.pause();audio.currentTime=0;tailStart=null;await window.renderAt(0);};
  window.mediaReady={width:512,height:768};
})().catch(error=>{window.mediaFailure=String(error.stack||error);document.getElementById('error').textContent=window.mediaFailure;});
