import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VisualStage, type VisualDescriptor } from './index';
const variants=[
 ['Scene','scene'],['100 parts','f1fcff61-29c6-4048-bb80-73b864e8a198'],['Distance','3d2a2716-e34c-458f-a56d-022d590bf661'],
 ['Ant','a47b29c4-ef3c-4094-ae2a-2c69ab03b3a8'],['Coin','57ca41d0-2c0e-4147-ae69-bb7a6a244558'],
 ['Rotation','2f8f1bc9-95bb-4c17-95ec-dad8cc0bd562'],['Day/night','25a9e24f-6922-4d32-b0b3-746257818d0e'],
 ['Sundial','19ef15a7-5346-4f4b-b31a-4112241c4238'],['Smooth train','29d57e4f-d902-40f6-ad86-32875823adc5'],
 ['Chai','7a6898c6-8b3d-40e0-9228-0532237b3e06'],['Window','7e263074-0a48-47b5-a3a3-4d35de780548'],
 ['Gases','8741f5a1-8c31-4ebb-b6fa-fc64091f0277'],['Exchange','37eb5a78-2767-4b96-9cfd-6d30332685f8'],
 ['Straw','4b0ab576-12a3-42f8-a426-ce2e32d73a79'],['Food chain','46c7ce8b-d42a-41e5-b247-7866c4b60995'],
 ['Food web','f9f7e008-0d58-45af-9065-f561dd7677e0'],['Egg','19cb8e74-13de-4725-a917-f333b28a86e9'],
];
function Harness(){
 const [id,setId]=useState(variants[2][1]),[stage,setStage]=useState(1),[language,setLanguage]=useState<'en'|'hi'>('en');
 const [line,setLine]=useState(0),[time,setTime]=useState(0),[started,setStarted]=useState(false),[replay,setReplay]=useState(0);
 const visual:VisualDescriptor=id==='scene'?{type:'scene',sceneUrl:'/content/releases/m2/scenes/7818d587-2954-43fc-95f0-5f0576b12f66/3f28b75d-8bf5-4926-9f25-74aab2758c85.json',title:'Our Earth scene'}:{type:'replacement',sourceCardId:id,stage,title:variants.find(v=>v[1]===id)?.[0]};
 return <main style={{maxWidth:650,margin:'30px auto',fontFamily:'system-ui',padding:16}}>
 <h1>Lesson visual verification</h1><p>Local harness — controls below supply a test narration clock.</p>
 <label>Visual <select value={id} onChange={e=>{setId(e.target.value);setStage(1);}}>{variants.map(([label,key])=><option key={key} value={key}>{label}</option>)}</select></label>
 <label> Language <select value={language} onChange={e=>setLanguage(e.target.value as 'en'|'hi')}><option value="en">English</option><option value="hi">Hindi</option></select></label>
 <label> Stage <input aria-label="Stage" type="number" min="1" max="7" value={stage} onChange={e=>setStage(Number(e.target.value))} style={{width:45}}/></label>
 {id==='scene'&&<fieldset><legend>Clock</legend><label>Line <input aria-label="Line" type="number" min="0" max="4" value={line} onChange={e=>setLine(Number(e.target.value))}/></label><label>Seconds <input aria-label="Seconds" type="number" step=".1" min="0" value={time} onChange={e=>setTime(Number(e.target.value))}/></label><button onClick={()=>setStarted(true)}>Start clock</button><button onClick={()=>{setLine(0);setTime(0);setReplay(n=>n+1);setStarted(true);}}>Replay clock</button></fieldset>}
 <VisualStage key={id} visual={visual} language={language} currentLine={line} currentTime={time} playing={false} replayKey={replay} hasStarted={started}/>
 </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Harness/></React.StrictMode>);
