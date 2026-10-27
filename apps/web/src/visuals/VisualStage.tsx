import { useState } from 'react';
import { NarratedScene } from './NarratedScene';
import { ReplacementVisual } from './ReplacementVisual';
import { sameOriginAsset } from './scene';
import type { VisualStageProps } from './types';
import './visuals.css';

function PreparedImage({url,description}:{url:string;description:string}) {
  const [failed,setFailed]=useState(false),[retry,setRetry]=useState(0);
  if(!sameOriginAsset(url))return <p className="sls-visual-error" role="alert">This illustration is unavailable.</p>;
  return failed ? <div className="sls-visual-message" role="alert">This illustration could not load. You can keep reading.<button type="button" onClick={()=>{setFailed(false);setRetry(n=>n+1);}}>Retry image</button></div> :
    <img key={retry} className="sls-prepared-image" src={url} alt={description} onError={()=>setFailed(true)}/>;
}
export function VisualStage(props: VisualStageProps) {
  const { visual } = props;
  return <figure className="sls-lesson-visual" aria-label={visual.title || 'Lesson illustration'}>
    {visual.type === 'scene' ? <NarratedScene {...props}/> : visual.type === 'replacement' ? <ReplacementVisual {...props}/> :
      <PreparedImage key={visual.imageUrl} url={visual.imageUrl} description={visual.description || visual.title || 'Lesson illustration'}/>}
  </figure>;
}
