import { Check } from 'lucide-react';
export function ProgressStatus({ saving, saved, error, retry }: { saving: boolean; saved: boolean; error: string; retry: () => void }) {
  return <div className="save-status" role="status">{saving ? 'Saving your place…' : error ? <><span>{error}</span><button className="text-button" onClick={retry}>Try saving again</button></> : saved ? <><Check size={14} />Your place is saved</> : 'Your progress saves as you explore.'}</div>;
}
