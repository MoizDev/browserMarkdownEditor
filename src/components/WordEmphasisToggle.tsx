import { useSyncExternalStore } from 'react';
import type { EmphasisAvailability } from '../types/reading';
import { getReadingPreferences,setWordEmphasis,subscribeReadingPreferences } from '../utils/readingPreferences';
export default function WordEmphasisToggle({capability,onPdfTextAction,className=''}:{capability:EmphasisAvailability;onPdfTextAction?:()=>void;className?:string}){
 const {emphasis:{enabled}}=useSyncExternalStore(subscribeReadingPreferences,getReadingPreferences);
 const pdf=capability.kind==='pdf-text-action',inactive=capability.kind==='inactive'||(pdf&&!onPdfTextAction);
 const reason=capability.kind==='inactive'?capability.reason:pdf&&!onPdfTextAction?'Extracted PDF text is available from the PDF toolbar':undefined;
 return <button type="button" className={`word-emphasis-toggle ${className}`} aria-label={pdf?'Read extracted PDF text with word emphasis':'Word emphasis'} aria-pressed={capability.kind==='toggle'?enabled:undefined} aria-disabled={inactive||undefined} aria-description={reason?`Preference ${enabled?'On':'Off'}; inactive in this view. ${reason}`:pdf?'Opens extracted text in this PDF and enables Word emphasis in all supported reading views':undefined} data-tooltip={reason?`Preference ${enabled?'On':'Off'}; inactive in this view · ${reason}`:pdf?'Opens extracted text in this PDF and enables Word emphasis in all supported reading views':`Word emphasis: ${enabled?'On':'Off'} · all supported reading views`} onClick={()=>{if(inactive)return;if(pdf)onPdfTextAction?.();else setWordEmphasis(!enabled)}}><span aria-hidden="true"><b>W</b>e</span></button>;
}
