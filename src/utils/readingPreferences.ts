import type { ReadingTypography } from '../types/reading';
export interface ReadingPreferences {v:1;emphasis:{enabled:boolean;algorithm:'latin-prefix-v1'};typography:ReadingTypography}
const DEFAULT:ReadingPreferences={v:1,emphasis:{enabled:false,algorithm:'latin-prefix-v1'},typography:{family:'serif',size:18,leading:1.6,measure:'comfortable',margins:'medium',theme:'follow-app'}};
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
function validate(value:unknown):ReadingPreferences {
 if(!object(value)||value.v!==1||!object(value.typography)||!object(value.emphasis))return DEFAULT;
 const t=value.typography,d=DEFAULT.typography;
 const choice=<T extends string>(x:unknown,values:readonly T[],fallback:T):T=>values.includes(x as T)?x as T:fallback;
 const number=(x:unknown,min:number,max:number,fallback:number)=>typeof x==='number'&&Number.isFinite(x)?Math.min(max,Math.max(min,x)):fallback;
 return {v:1,emphasis:{enabled:value.emphasis.enabled===true,algorithm:'latin-prefix-v1'},typography:{family:choice(t.family,['serif','sans','publisher'],d.family),size:number(t.size,12,40,d.size),leading:number(t.leading,1.2,2.2,d.leading),measure:choice(t.measure,['compact','comfortable','wide'],d.measure),margins:choice(t.margins,['small','medium','large'],d.margins),theme:choice(t.theme,['follow-app','light','sepia','dark'],d.theme)}};
}
const freeze=(value:ReadingPreferences):ReadingPreferences=>Object.freeze({...value,emphasis:Object.freeze({...value.emphasis}),typography:Object.freeze({...value.typography})});
let state:ReadingPreferences=freeze(DEFAULT);
try{state=freeze(validate(JSON.parse(localStorage.getItem('readingPreferences')??'null')))}catch{/* Storage is optional. */}
const listeners=new Set<()=>void>();
export const getReadingPreferences=()=>state;
export const subscribeReadingPreferences=(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener)}};
let persistenceFailed=false;
export const readingPersistenceUnavailable=()=>persistenceFailed;
function publish(value:unknown,persist=true){const next=validate(value);if(JSON.stringify(state)===JSON.stringify(next))return;state=freeze(next);if(persist)try{localStorage.setItem('readingPreferences',JSON.stringify(next));persistenceFailed=false}catch{if(!persistenceFailed&&typeof window!=='undefined')window.dispatchEvent(new Event('reading-persistence-unavailable'));persistenceFailed=true}listeners.forEach(f=>f())}
export const setWordEmphasis=(enabled:boolean)=>publish({...state,emphasis:{enabled,algorithm:'latin-prefix-v1'}});
export const updateReadingTypography=(patch:Partial<ReadingTypography>)=>publish({...state,typography:{...state.typography,...patch}});
export const resetReadingPreferences=()=>publish(DEFAULT);
if(typeof window!=='undefined')window.addEventListener('storage',event=>{if(event.key==='readingPreferences'){try{publish(JSON.parse(event.newValue??'null'),false)}catch{publish(DEFAULT,false)}}});
