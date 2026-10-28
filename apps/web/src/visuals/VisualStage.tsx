import { useState } from 'react';
import { NarratedScene } from './NarratedScene';
import { ReplacementVisual } from './ReplacementVisual';
import { sameOriginAsset } from './scene';
import type { VisualStageProps } from './types';
import './visuals.css';

function PreparedImage({url,description,language}:{url:string;description:string;language:VisualStageProps['language']}) {
  const [failed,setFailed]=useState(false),[retry,setRetry]=useState(0);
  const copy=(en:string,hi:string)=>language==='hi'?hi:en;
  if(!sameOriginAsset(url))return <p className="sls-visual-error" role="alert">{copy('This illustration is unavailable.','यह चित्र उपलब्ध नहीं है।')}</p>;
  return failed ? <div className="sls-visual-message" role="alert">{copy('This illustration could not load. You can keep reading.','यह चित्र लोड नहीं हो सका। आप पढ़ना जारी रख सकते हैं।')}<button type="button" onClick={()=>{setFailed(false);setRetry(n=>n+1);}}>{copy('Retry image','चित्र फिर से खोलें')}</button></div> :
    <img key={retry} className="sls-prepared-image" src={url} alt={description} onError={()=>setFailed(true)}/>;
}
export function VisualStage(props: VisualStageProps) {
  const { visual, language } = props;
  const fallback=language==='hi'?'पाठ का चित्र':'Lesson illustration';
  return <figure className="sls-lesson-visual" aria-label={visual.title || fallback}>
    {visual.type === 'scene' ? <NarratedScene {...props}/> : visual.type === 'replacement' ? <ReplacementVisual {...props}/> :
      <PreparedImage key={visual.imageUrl} url={visual.imageUrl} language={language} description={visual.description || visual.title || fallback}/>}
  </figure>;
}
