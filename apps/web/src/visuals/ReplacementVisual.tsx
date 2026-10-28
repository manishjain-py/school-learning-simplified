import { useEffect, useId, useRef, useState, type ReactNode, type PointerEvent } from 'react';
import { clamp } from './scene';
import type { VisualStageProps } from './types';

const ids = {
  grid: 'f1fcff61-29c6-4048-bb80-73b864e8a198', distance: '3d2a2716-e34c-458f-a56d-022d590bf661',
  ant: 'a47b29c4-ef3c-4094-ae2a-2c69ab03b3a8', coin: '57ca41d0-2c0e-4147-ae69-bb7a6a244558',
  spin: '2f8f1bc9-95bb-4c17-95ec-dad8cc0bd562', daylight: '25a9e24f-6922-4d32-b0b3-746257818d0e',
  sundial: '19ef15a7-5346-4f4b-b31a-4112241c4238', smooth: '29d57e4f-d902-40f6-ad86-32875823adc5',
  chai: '7a6898c6-8b3d-40e0-9228-0532237b3e06', window: '7e263074-0a48-47b5-a3a3-4d35de780548',
  gas: '8741f5a1-8c31-4ebb-b6fa-fc64091f0277', exchange: '37eb5a78-2767-4b96-9cfd-6d30332685f8',
  straw: '4b0ab576-12a3-42f8-a426-ce2e32d73a79', chain: '46c7ce8b-d42a-41e5-b247-7866c4b60995',
  web: 'f9f7e008-0d58-45af-9065-f561dd7677e0', egg: '19cb8e74-13de-4725-a917-f333b28a86e9',
};
const titles: Record<string, string> = {
  [ids.grid]: 'Split into 100 parts', [ids.distance]: 'Too hot, too cold, just right',
  [ids.ant]: 'An ant on an orange', [ids.coin]: 'A coin and an orange',
  [ids.spin]: 'Spinning like a top', [ids.daylight]: 'Half bright, half dark',
  [ids.sundial]: 'Shadows that tell the time', [ids.smooth]: 'A smooth train ride',
  [ids.chai]: 'The cup of chai', [ids.window]: 'Out of the window', [ids.gas]: 'Two arrows',
  [ids.exchange]: 'Take one side away', [ids.straw]: 'A tube like a straw',
  [ids.chain]: 'Let’s build one chain', [ids.web]: 'The balance of nature', [ids.egg]: 'The baby grows inside',
};
const c = { ink: '#283c35', muted: '#85958a', gold: '#b27c31', teal: '#357567', blue: '#4389b0', orange: '#df8c32', green: '#6c9660', paper: '#fbf8f1' };
const text = (x: number, y: number, label: string, size = 22, fill = c.ink) =>
  <text x={x} y={y} fontSize={size} fill={fill} stroke="none" textAnchor="middle" dominantBaseline="middle">{label}</text>;
const move = (x: number, y: number) => 'translate(' + x + ' ' + y + ')';
function Arrow({ x1, y1, x2, y2, color = c.ink, width = 5, broken = false, progress = 1 }: {
  x1: number; y1: number; x2: number; y2: number; color?: string; width?: number; broken?: boolean; progress?: number;
}) {
  const dx = x2 - x1, dy = y2 - y1, angle = Math.atan2(dy, dx), length = Math.hypot(dx, dy) * progress;
  return <g transform={move(x1,y1) + ' rotate(' + angle * 180 / Math.PI + ')'} opacity={progress > 0 ? 1 : 0}>
    {broken ? <><line x2={length * .34} stroke={color} strokeWidth={width}/><line x1={length*.65} x2={length-10} stroke={color} strokeWidth={width}/></> :
      <line x2={length-10} stroke={color} strokeWidth={width}/>}
    <path d={'M'+length+' 0 L'+(length-15)+' -9 L'+(length-15)+' 9 Z'} fill={color}/>
  </g>;
}
function Orange({ x, y, r = 65, turn = 0 }: {x:number;y:number;r?:number;turn?:number}) {
  return <g><circle cx={x} cy={y} r={r} fill="#ed9e41" stroke="#bf782f" strokeWidth="3"/>
    <path d={'M'+x+' '+(y-r)+' q18 -23 36 -9 q-10 23 -36 9'} fill={c.green}/>
    {[-.6,-.2,.25,.6].map((p,i)=><ellipse key={i} cx={x+Math.sin(p+turn)*r*.6} cy={y+(i%2?.35:-.2)*r} rx="3" ry="4" fill="#bc762a" opacity=".55"/>)}</g>;
}
function Planet({ x, y, r = 65, turn = 0 }: {x:number;y:number;r?:number;turn?:number}) {
  const a=useId().replace(/:/g,'');
  return <g><defs><clipPath id={a}><circle cx={x} cy={y} r={r}/></clipPath></defs>
    <circle cx={x} cy={y} r={r} fill={c.blue}/>
    <g clipPath={'url(#'+a+')'} fill={c.green} transform={move(Math.sin(turn)*r*.25,0)}>
      <path d={'M'+(x-r*.8)+' '+(y-r*.6)+' l'+r*.65+' '+(-r*.1)+' l'+r*.15+' '+r*.5+' l'+(-r*.3)+' '+r*.6+' l'+(-r*.4)+' '+(-r*.2)+' Z'}/>
      <path d={'M'+(x+r*.2)+' '+(y-r*.4)+' l'+r*.8+' '+r*.2+' l'+(-r*.3)+' '+r*.35+' l'+(-r*.2)+' '+r*.7+' l'+(-r*.4)+' '+(-r*.35)+' Z'}/>
    </g><circle cx={x} cy={y} r={r} fill="none" stroke="#316f8f" strokeWidth="2"/></g>;
}
function Train({ x = 160, y = 180, scale = 1, startled = false }: {x?:number;y?:number;scale?:number;startled?:boolean}) {
  return <g transform={move(x,y)+' scale('+scale+')'}><rect width="180" height="65" rx="10" fill="#398d82"/>
    {[18,70,122].map(a=><rect key={a} x={a} y="12" width="40" height="32" rx="4" fill="#fff0d3"/>)}
    {[22,62,118,158].map(a=><circle key={a} cx={a} cy="68" r="10" fill="#3f4743"/>)}
    <circle cx="90" cy="28" r="14" fill="#f3d9af"/>
    {startled?<><circle cx="85" cy="25" r="2.5"/><circle cx="95" cy="25" r="2.5"/><circle cx="90" cy="34" r="3"/></>:
      <path d="M82 26q3 4 6 0 M92 26q3 4 6 0 M86 33q4 4 8 0" fill="none" stroke={c.ink} strokeWidth="2"/>}</g>;
}
function Slider({label,value,min,max,step=1,onChange,valueText}:{label:string;value:number;min:number;max:number;step?:number;onChange:(value:number)=>void;valueText?:string}) {
  return <label className="sls-visual-slider"><span>{label}</span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={e=>onChange(Number(e.target.value))} aria-valuetext={valueText}/>
    <span className="sls-control-result" aria-live="polite">{valueText}</span></label>;
}
function useAnimation(key:string, enabled:boolean, playback?:{playing:boolean;ended:boolean}) {
  const [time,setTime]=useState(0),[running,setRunning]=useState(enabled),[replay,setReplay]=useState(0); const elapsedRef=useRef(0);
  useEffect(()=>{const reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;elapsedRef.current=reduce?9:0;setTime(elapsedRef.current);setRunning(enabled&&!reduce);},[key,enabled]);
  useEffect(()=>{
    if(!playback)return;
    if(playback.ended){elapsedRef.current=9;setTime(9);setRunning(false);}
    else setRunning(enabled&&playback.playing&&elapsedRef.current<9&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  },[key,enabled,playback?.playing,playback?.ended]);
  useEffect(()=>{
    if(!running)return;
    let frame=0, previous=performance.now();
    const tick=(now:number)=>{elapsedRef.current=Math.min(9,elapsedRef.current+Math.min(.1,(now-previous)/1000));previous=now;setTime(elapsedRef.current);if(elapsedRef.current>=9){setRunning(false);return;}frame=requestAnimationFrame(tick);};
    frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);
  },[running,replay,key]);
  return {time,running,toggle:()=>{if(time>=9){elapsedRef.current=0;setTime(0);setReplay(n=>n+1);}setRunning(!running);},restart:()=>{elapsedRef.current=0;setTime(0);setReplay(n=>n+1);setRunning(true);}};
}

export function ReplacementVisual({visual,language,replayKey,playing,hasStarted,ended}:VisualStageProps) {
  const key=visual.type==='replacement'?visual.sourceCardId:'';
  const stage=visual.type==='replacement'?Math.max(1,visual.stage||1):1;
  const [value,setValue]=useState(key===ids.distance?237:0),[pick,setPick]=useState('');
  const animation=useAnimation(key+':'+language+':'+replayKey,![ids.distance,ids.coin,ids.daylight,ids.web,ids.egg,ids.chain,ids.sundial].includes(key),ended===undefined?undefined:{playing,ended}),uid=useId().replace(/:/g,'');
  useEffect(()=>{setValue(key===ids.distance?237:0);setPick('');},[key,language,replayKey]);
  const t=ended?9:animation.time,p=clamp((t-1.5)/4.5);
  let drawing:ReactNode=null,control:ReactNode=null,background=c.paper;
  const interactive=[ids.distance,ids.coin,ids.daylight,ids.gas,ids.web,ids.egg].includes(key);
  const board=key===ids.sundial||key===ids.chain;
  const title=visual.title||titles[key];
  const mark=(at:number)=>at===stage?c.gold:'#5c7064',age=(at:number)=>at===stage?1:.68;
  const onOrbit=(e:PointerEvent<SVGCircleElement>)=>{
    if(e.type==='pointermove'&&!e.buttons)return;
    const svg=e.currentTarget.ownerSVGElement!; const matrix=svg.getScreenCTM(); if(!matrix)return;
    const point=svg.createSVGPoint(); point.x=e.clientX; point.y=e.clientY;
    const {x,y}=point.matrixTransform(matrix.inverse());
    setValue((Math.atan2(y-170,x-335)*180/Math.PI+360)%360);
    if(e.type==='pointerdown')e.currentTarget.setPointerCapture(e.pointerId);
  };
  if(key===ids.grid) {
    const show=t<1.5?0:t<3.2?71:100;
    drawing=<>{Array.from({length:100},(_,i)=><rect key={i} x={28+i%10*25} y={48+Math.floor(i/10)*25} width="22" height="22" rx="2" fill={i<show?(i<71?c.blue:'#9c724c'):'#f4f0e6'} stroke="#a0aca4" strokeWidth="1"/>)}
      {t>=1.5&&<><rect x="311" y="78" width="23" height="23" fill={c.blue}/>{text(392,90,'71 water',25)}</>}
      {t>=3.2&&<><rect x="311" y="140" width="23" height="23" fill="#9c724c"/>{text(392,152,'29 land',25)}</>}
      {t>=4.5&&text(386,226,'71 + 29 = 100',24)}{t>=6&&<><path d="M285 48h8v247h-8" fill="none" stroke={c.ink} strokeWidth="2"/>{text(375,292,'whole surface',18)}</>}</>;
  } else if(key===ids.distance) {
    background='#14273f';const result=value<175?'Too hot':value>300?'Too cold':'Just right';
    drawing=<><circle cx="0" cy="175" r="560" fill="#82c5d8" opacity=".28"/><circle cx="0" cy="175" r="300" fill="#4d9a6a" opacity=".7"/><circle cx="0" cy="175" r="175" fill="#bc5637" opacity=".8"/><circle cx="0" cy="175" r="70" fill="#ffc45d"/>
      {text(27,175,'Sun',20,'#14273f')}{text(124,87,'too hot',20,'white')}{text(244,55,'just right',20,'white')}{text(407,95,'too cold',20,'white')}
      <Planet x={value} y={175} r={23}/>{text(value,217,'Earth',19,'white')}</>;
    control=<Slider label={language==='hi'?'ग्रह को Sun के पास या दूर ले जाएँ':'Move the planet nearer to or farther from the Sun'} value={value} min={110} max={413} onChange={setValue} valueText={result}/>;
  } else if(key===ids.ant) {
    const a=Math.PI*.66-p*Math.PI*2,ax=250+Math.cos(a)*110,ay=175+Math.sin(a)*30;
    drawing=<><Orange x={250} y={175} r={110}/><ellipse cx="250" cy="175" rx="110" ry="30" fill="none" stroke="#75502b" strokeWidth="2" strokeDasharray="5 5"/>
      <path d="M195 204v-30l22 8-22 8" fill="#c85e4c" stroke="#75502b"/>{text(195,241,'start',19)}
      <g transform={move(ax,ay)+' rotate('+Math.atan2(-30*Math.cos(a),110*Math.sin(a))*180/Math.PI+')'} opacity={Math.sin(a)<0?.35:1}>
        {[-8,0,8].map(x=><ellipse key={x} cx={x} rx="5" ry="4" fill="#28342c"/>)}<path d="M-3 -3l-7 -7 M3 -3l5 -7 M-3 3l-7 7 M3 3l5 7 M0 -4v-8 M0 4v8" stroke="#28342c" strokeWidth="2"/></g>
      {t>1.5&&text(376,66,'straight ahead',18)}{p>=1&&text(250,29,'back to the start!',24)}</>;
  } else if(key===ids.coin) {
    const w=Math.max(6,130*Math.cos(value*Math.PI/180));
    drawing=<>{text(140,67,'coin',25)}{text(360,67,'orange',25)}<ellipse cx="140" cy="170" rx={w/2} ry="65" fill="#bbc4c3" stroke="#697b76" strokeWidth="4"/>
      <g transform={move(140,170)+' scale('+w/130+' 1)'}>{text(0,0,'1',38,'#596b64')}</g><Orange x={360} y={170} turn={value*Math.PI/180}/>
      {text(140,272,value>65?'thin from the side':'flat and round',19)}{text(360,272,'round like a ball',19)}</>;
    control=<Slider label={language==='hi'?'coin और orange को घुमाएँ':'Turn the coin and the orange'} value={value} min={0} max={90} onChange={setValue} valueText={value>65?'The coin is thin; the orange stays round.':'Both faces look round.'}/>;
  } else if(key===ids.spin) {
    drawing=<><path d="M90 130Q90 90 130 90T170 130Q164 190 130 245Q96 190 90 130" fill="#d77348"/><path d="M95 139q35 15 70 0 M105 177q25 10 50 0" fill="none" stroke="#f7ddb3" strokeWidth="12"/>
      <line x1="80" x2="180" y1="248" y2="248" stroke={c.ink}/><line x1="130" x2="130" y1="68" y2="265" stroke={c.ink} strokeDasharray="7 6"/>
      <Planet x={350} y={170} r={75} turn={t*2}/><line x1="310" y1="264" x2="390" y2="76" stroke={c.ink} strokeWidth="3" strokeDasharray="7 6"/>
      {t>1&&<><path d="M84 146Q130 185 174 146" fill="none" stroke={c.orange} strokeWidth="5"/><Arrow x1={157} y1={157} x2={177} y2={144} color={c.orange}/></>}
      {t>3&&<><path d="M280 169Q350 225 420 169" fill="none" stroke={c.orange} strokeWidth="5"/><Arrow x1={401} y1={188} x2={423} y2={169} color={c.orange}/>{text(278,217,'west',18)}{text(423,217,'east',18)}</>}
      {text(130,294,'lattu (top)',21)}{text(350,294,'Earth',21)}{t>4&&text(350,38,'rotation',26,c.gold)}</>;
  } else if(key===ids.daylight) {
    background='#172b42';const a=value*Math.PI/180;
    drawing=<><defs><clipPath id={uid+'-half'}><circle cx="335" cy="170" r="90"/></clipPath></defs><path d="M53 168h64l-12 -40H65Z" fill="#d9a855"/><circle cx="85" cy="176" r="11" fill="#ffe18c"/>
      <path d="M85 187v93 M54 287h62" stroke="#bfbc9f" strokeWidth="8"/>
      {[-55,-28,0,28,55].map(y=><line key={y} x1="102" y1="176" x2="237" y2={170+y} stroke="#f2d581" opacity=".55" strokeWidth="3"/>)}
      <circle cx="335" cy="170" r="90" fill="#5a4435"/><rect x="245" y="80" width="90" height="180" fill="#f1a34f" clipPath={'url(#'+uid+'-half)'}/>
      {text(292,170,'day',24,'#172b42')}{text(379,170,'night',24,'white')}
      <circle cx="335" cy="170" r="97" fill="none" stroke="#a0b7bd" strokeDasharray="4 5"/><circle cx={335+97*Math.cos(a)} cy={170+97*Math.sin(a)} r="14" fill="#d5b367" stroke="white" strokeWidth="2" aria-hidden="true"/><circle cx={335+97*Math.cos(a)} cy={170+97*Math.sin(a)} r="32" fill="transparent" onPointerDown={onOrbit} onPointerMove={onOrbit} style={{touchAction:'none',cursor:'grab'}} aria-hidden="true"/>
      {text(85,318,'lamp = Sun',19,'white')}</>;
    control=<Slider label={language==='hi'?'lamp के सामने orange को घुमाएँ':'Turn the orange in front of the lamp'} value={value} min={0} max={360} onChange={setValue} valueText={Math.cos(a)<0?'The marked place faces the lamp: day.':'The marked place faces away: night.'}/>;
  } else if(key===ids.sundial) {
    drawing=<><g opacity={age(1)} stroke={mark(1)} fill="none" strokeWidth="3"><circle cx="60" cy="60" r="22"/>
      {Array.from({length:8},(_,i)=><line key={i} x1={60+29*Math.cos(i*Math.PI/4)} y1={60+29*Math.sin(i*Math.PI/4)} x2={60+39*Math.cos(i*Math.PI/4)} y2={60+39*Math.sin(i*Math.PI/4)}/>)}
      <ellipse cx="262" cy="215" rx="168" ry="80"/>{text(300,32,'sundial',29,mark(1))}</g>
      {stage>=2&&<g className={!ended&&stage===2?'sls-stage-new':''} opacity={age(2)}><line x1="262" y1="215" x2="262" y2="95" stroke={mark(2)} strokeWidth="8"/>{text(330,95,'gnomon',24,mark(2))}{text(144,118,'flat surface',20,mark(2))}<Arrow x1={145} y1={130} x2={160} y2={152} color={mark(2)} width={2}/></g>}
      {stage>=3&&<g className={!ended&&stage===3?'sls-stage-new':''} opacity={age(3)}><line x1="83" y1="65" x2="257" y2="97" stroke={mark(3)} strokeWidth="2" strokeDasharray="5 5"/>
        <path d="M262 215L399 253" stroke={mark(3)} strokeWidth="9"/><path d="M262 215L262 268 M262 215L125 253" stroke={mark(3)} strokeWidth="3" strokeDasharray="6 5" fill="none"/>
        {text(372,209,'shadow',21,mark(3))}<path d="M375 248Q250 302 140 253" stroke={mark(3)} fill="none" strokeWidth="3"/>{text(316,274,'moves',20,mark(3))}</g>}
      {stage>=4&&<g className={ended?undefined:'sls-stage-new'}>{Array.from({length:7},(_,i)=>{const a=.24+i*(Math.PI-.48)/6;return <line key={i} x1={262+145*Math.cos(a)} y1={215+65*Math.sin(a)} x2={262+158*Math.cos(a)} y2={215+74*Math.sin(a)} stroke={mark(4)} strokeWidth={i%3===0?4:2}/>;})}
        {text(427,278,'9',29,mark(4))}{text(262,318,'12',29,mark(4))}{text(97,278,'3',29,mark(4))}<circle cx="427" cy="278" r="24" fill="none" stroke={mark(4)} strokeWidth="2"/></g>}</>;
  } else if([ids.smooth,ids.chai,ids.window].includes(key)) {
    background='#edf4f4';
    if(key===ids.smooth)drawing=<>{text(250,27,'smooth: you cannot tell',22)}<path d="M20 147H480" stroke="#735846" strokeWidth="4"/><Train x={145+p*40} y={75}/>
      <line x1="20" x2="480" y1="174" y2="174" stroke="#bcc8c4"/>{text(250,201,'bumps, starts, stops: you feel it',21)}
      <path d="M20 323H300q12 -28 24 0H480" fill="none" stroke="#735846" strokeWidth="4"/><g transform={'rotate('+Math.sin(t*7)*3+' 270 288)'}><Train x={160} y={250} startled/></g><path d="M160 249l-8 -13 M340 249l9 -13 M351 260l13 -4" stroke="#cc7947" strokeWidth="4"/></>;
    if(key===ids.chai)drawing=<><rect x="50" y="70" width="400" height="180" rx="18" fill="#398d82"/><rect x="67" y="87" width="366" height="144" rx="10" fill="#fff0d3"/>
      <rect x="91" y="100" width="140" height="68" fill="#c1dde2"/><rect x="91" y="148" width="140" height="20" fill="#8aa576"/>
      <path d="M243 204h125 M259 205v26 M352 205v26" stroke="#8a6444" strokeWidth="8"/><path d="M280 169h50v29q-25 13 -50 0Z" fill="white" stroke="#80603f" strokeWidth="3"/><ellipse cx="305" cy="170" rx="25" ry="5" fill="#b78048"/>
      <path d="M331 176q23 -1 12 18h-12 M295 154q-10 -10 0 -20 M313 154q-10 -10 0 -20" stroke="#8f795f" strokeWidth="3" fill="none"/>
      {[100,200,300,400].map(x=><circle key={x} cx={x} cy="258" r="16" fill="#3f4743"/>)}<line x1="20" x2="480" y1="277" y2="277" stroke="#735846" strokeWidth="4"/>
      {t>2&&<><Arrow x1={120} y1={303} x2={380} y2={303}/>{text(250,330,'train moves',21)}</>}{t>4&&<><Arrow x1={275} y1={110} x2={366} y2={110}/>{text(322,55,'chai moves along too',19)}</>}</>;
    if(key===ids.window)drawing=<><defs><clipPath id={uid+'-window'}><rect x="85" y="42" width="330" height="140"/></clipPath></defs><rect x="80" y="37" width="340" height="150" rx="7" fill="#398d82"/>
      <g clipPath={'url(#'+uid+'-window)'}><rect x="85" y="42" width="330" height="140" fill="#c1dde2"/><rect x="85" y="150" width="330" height="32" fill="#8eaf77"/>
        <g transform={move(-p*150,0)}>{[210,350].map(x=><g key={x}><path d={'M'+x+' 160v-60'} stroke="#856445" strokeWidth="9"/><circle cx={x} cy="96" r="25" fill="#6b9363"/></g>)}<path d="M410 160V70m-20 8h40" stroke="#7b8785" strokeWidth="5"/></g></g>
      {text(250,19,'seem to rush backwards',20)}{text(250,213,'trees stay still. You move!',22,c.teal)}
      {[250,390].map(x=><g key={x}><path d={'M'+x+' 309v-65'} stroke="#856445" strokeWidth="7"/><circle cx={x} cy="249" r="20" fill="#6b9363"/></g>)}
      <path d="M442 310v-68m-15 8h30 M20 322H480" stroke="#7b8785" strokeWidth="4"/><Train x={45+p*150} y={267} scale={.7}/></>;
  } else if(key===ids.gas||key===ids.exchange) {
    const absent=key===ids.exchange?(t>1.5&&t<3.75?'plant':t>=4.15&&t<6.5?'animal':''):'';
    const panel=(side:'animal'|'plant',x:number)=><g opacity={absent===side?.25:1}><rect x={x} y="90" width="120" height="170" rx="16" fill={side==='animal'?'#cbdadd':'#d0dfc1'}/>{text(x+60,175,side.toUpperCase(),22)}
      {absent===side&&<path d={'M'+(x+42)+' 135l36 80m0 -80l-36 80'} stroke="#bd584b" strokeWidth="6"/>}</g>;
    const gasArrow=(gas:string,y:number,toPlant:boolean,label:string)=><g onClick={key===ids.gas?()=>setPick(gas):undefined} role={key===ids.gas?'button':undefined} tabIndex={key===ids.gas?0:undefined} aria-label={label}
      onKeyDown={e=>{if(key===ids.gas&&(e.key==='Enter'||e.key===' ')){e.preventDefault();setPick(gas);}}}
      style={key===ids.gas?{cursor:'pointer'}:undefined} opacity={key===ids.exchange&&((toPlant&&absent==='animal')||(!toPlant&&absent==='plant'))?.12:pick&&pick!==gas?.25:1}>
      <rect x="145" y={y-33} width="210" height="55" fill="transparent"/><Arrow x1={toPlant?145:355} y1={y} x2={toPlant?355:145} y2={y} color={toPlant?'#c2733e':c.teal} width={pick===gas?8:5} progress={key===ids.gas&&!pick?clamp((t-(toPlant?1.5:3.5))/.6):1}/>{text(250,y-17,label,17,toPlant?'#a55d2e':c.teal)}</g>;
    drawing=<>{panel('animal',20)}{panel('plant',360)}{key===ids.gas?<>{gasArrow('carbon-dioxide',137,true,'CARBON DIOXIDE')}{gasArrow('oxygen',222,false,'OXYGEN')}</>:<>{gasArrow('food',119,false,'FOOD')}{gasArrow('oxygen',160,false,'OXYGEN')}{gasArrow('carbon-dioxide',207,true,'CARBON DIOXIDE')}{gasArrow('seeds',250,true,'POLLEN, SEEDS')}</>}</>;
    if(key===ids.gas)control=<div className="sls-visual-picks"><p>{language==='hi'?'एक तीर चुनें':'Choose an arrow'}</p><button type="button" aria-pressed={pick==='carbon-dioxide'} onClick={()=>setPick('carbon-dioxide')}>Carbon dioxide</button><button type="button" aria-pressed={pick==='oxygen'} onClick={()=>setPick('oxygen')}>Oxygen</button>
      <p aria-live="polite">{pick==='carbon-dioxide'?'The animal gives out carbon dioxide.':pick==='oxygen'?'The plant gives out oxygen.':'Follow the arrow from one living thing to the other.'}</p></div>;
  } else if(key===ids.straw) {
    const left=clamp((t-1.5)/1.2),right=clamp((t-3.5)/1.2);
    drawing=<><line x1="250" x2="250" y1="55" y2="290" stroke="#bbc7bf" strokeWidth="2"/><path d="M85 170h90l-10 110H95Z" fill="none" stroke={c.ink} strokeWidth="4"/><path d="M90 205h80l-6 71H96Z" fill="#e9a04c"/>
      <path d="M125 215L155 115" stroke="#6e7c72" strokeWidth="14"/><path d="M125 215L155 115" stroke="#ed9e41" strokeWidth="7" pathLength="1" strokeDasharray="1" strokeDashoffset={1-left}/>{text(130,311,'STRAW',25)}
      <path d="M370 250v50" stroke={c.green} strokeWidth="6"/>{Array.from({length:5},(_,i)=><circle key={i} cx={370+25*Math.cos(i*2*Math.PI/5)} cy={235+25*Math.sin(i*2*Math.PI/5)} r="21" fill="#d689a0"/>)}
      <circle cx="370" cy="235" r="20" fill="#e8be5b"/><ellipse cx="408" cy="120" rx="25" ry="20" fill="#e99a46"/><ellipse cx="450" cy="120" rx="25" ry="20" fill="#e99a46"/>
      <path d="M429 101v40 M406 142Q380 157 370 228" stroke={c.ink} strokeWidth="7" fill="none"/><path d="M370 228Q380 157 406 142" stroke="#ed9e41" strokeWidth="4" fill="none" pathLength="1" strokeDasharray="1" strokeDashoffset={1-right}/>{text(322,311,'TUBE',25)}</>;
  } else if(key===ids.chain) {
    drawing=<>{text(250,34,'OUR FOOD CHAIN',26,mark(1))}{[25,190,355].map((x,i)=>{const at=i+2;return <g key={x} opacity={stage>=at?age(at):.45} className={!ended&&stage===at?'sls-stage-new':''}>
      <rect x={x} y="100" width="120" height="96" rx="11" fill="none" stroke={stage>=at?mark(at):c.muted} strokeWidth={stage>=at?4:2} strokeDasharray={stage>=at?undefined:'6 5'}/>{stage>=at&&text(x+60,148,['GRASS','DEER','TIGER'][i],26,mark(at))}</g>;})}
      {stage>=5&&<g className={!ended&&stage===5?'sls-stage-new':''} opacity={age(5)}><Arrow x1={145} y1={148} x2={190} y2={148} color={mark(5)}/><Arrow x1={310} y1={148} x2={355} y2={148} color={mark(5)}/></g>}
      {stage>=6&&<g className={!ended&&stage===6?'sls-stage-new':''} opacity={age(6)}><Arrow x1={128} y1={246} x2={168} y2={246} color={mark(6)} width={3}/>{text(283,246,'IS EATEN BY',22,mark(6))}</g>}
      {stage>=7&&<g className={ended?undefined:'sls-stage-new'}><rect x="18" y="86" width="464" height="124" rx="13" fill="none" stroke={mark(7)} strokeWidth="2"/>{text(250,296,'3 LINKS, 2 ARROWS',25,mark(7))}</g>}</>;
  } else if(key===ids.web) {
    const nodes:Record<string,[number,number,string]>={grass:[90,250,c.green],rabbit:[90,110,'#477eaa'],deer:[250,180,'#477eaa'],tiger:[420,110,'#ba7344'],snake:[420,250,'#ba7344']};
    const links=[['grass','deer'],['grass','rabbit'],['deer','tiger'],['rabbit','snake']];
    drawing=<>{text(250,30,'BALANCE OF NATURE',25)}{links.map(([a,b])=>{const [x,y]=nodes[a],[xx,yy]=nodes[b],dx=xx-x,dy=yy-y,len=Math.hypot(dx,dy),gap=Math.abs(dx)>Math.abs(dy)?52:28;return <Arrow key={a+b} x1={x+dx/len*gap} y1={y+dy/len*gap} x2={xx-dx/len*gap} y2={yy-dy/len*gap} color={a===pick||b===pick?'#bb5147':c.ink} broken={a===pick||b===pick}/>;})}
      {Object.entries(nodes).map(([name,[x,y,fill]])=><g key={name} role={name!=='grass'?'button':undefined} tabIndex={name!=='grass'?0:undefined} aria-label={name!=='grass'?'Remove '+name:undefined}
        onClick={name!=='grass'?()=>setPick(name):undefined} onKeyDown={e=>{if(name!=='grass'&&(e.key==='Enter'||e.key===' ')){e.preventDefault();setPick(name);}}}
        opacity={pick===name?.25:(pick==='rabbit'&&name==='snake')||(pick==='deer'&&name==='tiger')?.5:1}>
        <rect x={x-48} y={y-23} width="96" height="46" rx="9" fill={fill}/>{text(x,y,name.toUpperCase(),21,'white')}{pick===name&&<path d={'M'+(x-17)+' '+(y-18)+'l34 36m0 -36l-34 36'} stroke="#b84237" strokeWidth="6"/>}</g>)}</>;
    control=<div className="sls-visual-picks"><p>{language==='hi'?'किसी एक animal को हटाकर देखें':'Take one animal out of the web'}</p>{['rabbit','deer','tiger','snake'].map(name=><button type="button" key={name} aria-pressed={pick===name} onClick={()=>setPick(name)}>{name}</button>)}
      <button type="button" onClick={()=>setPick('')}>Restore all</button><p aria-live="polite">{pick?'The links touching the '+pick+' are broken.':'All the links are connected.'}</p></div>;
  } else if(key===ids.egg) {
    const chick=clamp((value-.08)/.92);
    drawing=<><ellipse cx="250" cy="165" rx="90" ry="115" fill="#fffdf7" stroke={c.ink} strokeWidth="4"/><circle cx="250" cy="190" r={48-value*26} fill="#e6c458"/>
      {chick>0&&<g opacity={clamp(chick*5)} transform={move(250,171)+' scale('+(.36+.64*chick)+')'}><ellipse cy="23" rx="48" ry="40" fill="#f4d894"/><circle cx="7" cy="-27" r="30" fill="#f4d894"/>
        {chick>.5&&<><path d="M33 -29l18 7-18 9" fill="#de9340"/><circle cx="17" cy="-31" r="3.5" fill={c.ink}/></>}</g>}
      <line x1="100" x2="400" y1="300" y2="300" stroke={c.ink} strokeWidth="3"/><circle cx={100+value*300} cy="300" r="13" fill={c.teal}/>{text(100,329,'LAID',20)}{text(400,329,'READY',20)}</>;
    control=<Slider label={language==='hi'?'LAID से READY तक आगे बढ़ाएँ':'Move from LAID to READY'} value={value} min={0} max={1} step={.01} onChange={setValue} valueText={value<.1?'Yolk inside the unbroken egg.':value<.7?'The baby is growing inside.':'The baby fills more of the egg; the shell is still unbroken.'}/>;
  }
  if(!drawing)return <div className="sls-visual-message" role="alert">This illustration is not available yet. You can keep reading.</div>;
  return <div className="sls-replacement" data-visual-id={key} data-animation-time={!interactive&&!board?t.toFixed(2):undefined} data-control-value={interactive?(pick||value):undefined}>
    <svg className="sls-replacement-canvas" viewBox="0 0 500 350" role="img" aria-label={title}><title>{title}</title><rect width="500" height="350" rx="14" fill={background}/>{(ended!==undefined&&!ended&&!hasStarted&&!interactive&&!board)?null:drawing}</svg>
    {control}{board&&<p className="sls-visual-caption">{language==='hi'?'चित्र का चरण':'Picture stage'} {stage} / {key===ids.chain?7:4}</p>}
    {ended===undefined&&(!interactive||key===ids.gas)&&!board&&<div className="sls-animation-controls"><button type="button" onClick={animation.toggle}>{animation.running?'Pause animation':animation.time>=9?'Replay animation':'Play animation'}</button><button type="button" onClick={animation.restart}>Restart</button></div>}
  </div>;
}
