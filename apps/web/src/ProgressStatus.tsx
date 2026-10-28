import { Check } from 'lucide-react';
import type { Language } from './types';
export function ProgressStatus({ saving, saved, error, retry, language = 'en' }: { saving: boolean; saved: boolean; error: string; retry: () => void; language?: Language }) {
  const copy = (en: string, hi: string) => language === 'hi' ? hi : en;
  const errorCopy = /sign in|session has ended|account changed|verify your email/i.test(error)
    ? copy(error, 'अपने सत्यापित खाते से फिर साइन इन करें और यह पाठ दोबारा खोलें।')
    : error.startsWith('Saved progress could not be loaded.')
      ? copy(error, 'सहेजी हुई प्रगति नहीं खुल सकी। दोबारा सहेजने से पहले पेज फिर से खोलें।')
      : copy(error, 'आपकी प्रगति सहेजी नहीं जा सकी। फिर कोशिश करें।');
  return <div className="save-status" role="status">{saving ? copy('Saving your place…', 'आपकी प्रगति सहेजी जा रही है…') : error ? <><span>{errorCopy}</span><button className="text-button" onClick={retry}>{copy('Try saving again', 'फिर से सहेजें')}</button></> : saved ? <><Check size={14} />{copy('Your place is saved', 'आपकी प्रगति सहेज ली गई है')}</> : copy('Your progress saves as you explore.', 'आगे बढ़ते हुए आपकी प्रगति अपने-आप सहेजी जाती है।')}</div>;
}
