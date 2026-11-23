import { lazy,Suspense,useEffect,useMemo,useRef,useState,useSyncExternalStore } from 'react';
import type { ReaderIdentity,ReaderIntegration,ReadOnlyFileSnapshot } from '../types/reading';
import { getReadingPreferences,subscribeReadingPreferences,setWordEmphasis,updateReadingTypography } from '../utils/readingPreferences';
import { readReaderViewState,flushReaderViewState } from '../utils/readerViewState';
import { registerView } from '../utils/viewRegistry';
import type { EpubViewInfo } from '../utils/viewRegistry';
const EpubPane=lazy(()=>import('./EpubPane'));
export default function EpubReaderHost({identity,integration,isFocused,onFocusPane,onRetryRead,registerKeyboardTarget,theme}:{identity:ReaderIdentity;integration:ReaderIntegration;isFocused:boolean;onFocusPane(path:string):void;onRetryRead(path:string):Promise<boolean>;registerKeyboardTarget(path:string,take:()=>void):()=>void;theme:'light'|'dark'}){
 const [snapshot,setSnapshot]=useState<ReadOnlyFileSnapshot|null>(null),[error,setError]=useState('');
 const preferences=useSyncExternalStore(subscribeReadingPreferences,getReadingPreferences);
 const readerPreferences=useMemo(()=>({...preferences,appTheme:theme}),[preferences,theme]);
 const info=useRef<EpubViewInfo>({kind:'epub',status:'loading',visibleCanonicalText:'',selectedCanonicalText:null});
 useEffect(()=>{
  setSnapshot(null);setError('');info.current={kind:'epub',status:'loading',visibleCanonicalText:'',selectedCanonicalText:null};
  integration.onReaderStatus(identity,{phase:'loading',message:'Opening book locally…'});
  const abort=new AbortController();let owned:ReadOnlyFileSnapshot|undefined;
  void integration.acquireSnapshot(identity,abort.signal).then(value=>{owned=value;if(abort.signal.aborted)value.dispose();else setSnapshot(value)}).catch(error=>{if(!abort.signal.aborted){const message=String(error);setError(message);info.current={...info.current,status:'error'};integration.onReaderStatus(identity,{phase:'error',message})}});
  const unregister=registerView(identity.path,{kind:'epub',describe:()=>info.current});
  return ()=>{abort.abort();owned?.dispose();unregister();flushReaderViewState()};
 },[identity,integration]);
 if(error)return <div className="unread-pane" role="status"><p>{error}</p><button onClick={()=>void onRetryRead(identity.path)}>Retry</button></div>;
 if(!snapshot)return <div className="unread-pane" role="status">Opening EPUB…</div>;
 return <Suspense fallback={<div role="status">Loading EPUB reader…</div>}><EpubPane identity={identity} snapshot={snapshot} initialRecord={readReaderViewState(identity.vaultId,identity.path)} isFocused={isFocused}
 {...integration} onFocusPane={onFocusPane} onRetryRead={onRetryRead} registerKeyboardTarget={registerKeyboardTarget}
 preferences={readerPreferences}
 onPreferencesChange={next=>{setWordEmphasis(next.emphasis.enabled);updateReadingTypography(next.typography)}}
 onReaderStatus={(token,status)=>{info.current={...info.current,status:status.phase};integration.onReaderStatus(token,status)}}
 onReaderCapabilities={(token,caps)=>{info.current={...info.current,capabilities:caps};integration.onReaderCapabilities(token,caps)}}
 onReaderLocation={(token,location,cause)=>{info.current={...info.current,locator:location.value.locator,flow:location.value.requestedLayout};integration.onReaderLocation(token,location,cause)}}
 onReaderMetadata={(_token,metadata)=>{info.current={...info.current,title:metadata.title,author:metadata.author}}}
 onReaderSelection={(_token,selection)=>{info.current={...info.current,selectedCanonicalText:selection?.text.slice(0,16000)??null}}}
 onReaderVisibleText={(_token,text)=>{info.current={...info.current,visibleCanonicalText:text.slice(0,24000)}}}
 /></Suspense>;
}
