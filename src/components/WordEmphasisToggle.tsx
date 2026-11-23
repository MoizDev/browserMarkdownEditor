import { useSyncExternalStore } from 'react';
import type { EmphasisAvailability } from '../types/reading';
import { getReadingPreferences,setWordEmphasis,subscribeReadingPreferences } from '../utils/readingPreferences';
export default function WordEmphasisToggle({capability,className=''}:{capability:EmphasisAvailability;className?:string}){
 const {emphasis:{enabled}}=useSyncExternalStore(subscribeReadingPreferences,getReadingPreferences);
 const inactive=capability.kind==='inactive';
 const reason=inactive?capability.reason:undefined;
 return <button type="button" className={`word-emphasis-toggle ${className}`} aria-label="Word emphasis" aria-pressed={!inactive&&enabled} aria-disabled={inactive||undefined} aria-description={reason?`Preference ${enabled?'On':'Off'}; inactive in this view. ${reason}`:undefined} data-tooltip={reason?`Preference ${enabled?'On':'Off'}; inactive in this view · ${reason}`:`Word emphasis: ${enabled?'On':'Off'} · all supported reading views`} onClick={()=>{if(!inactive)setWordEmphasis(!getReadingPreferences().emphasis.enabled)}}><span aria-hidden="true"><b>W</b>e</span></button>;
}
