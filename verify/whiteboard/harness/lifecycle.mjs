// A real browser close, not a synthetic beforeunload event and not a close-flush shortcut.
import{until}from'./runtime.mjs';
export function lifecycleHelpers(h){
 h.closeReceipts=[];h.ui.closeWindow=async({decision='stay',timeout=5000}={})=>{
  if(!['stay','leave'].includes(decision))throw Error('closeWindow decision must be stay/leave');if(h.page.isClosed())throw Error('App page already closed');
  const before=h.nativeReceipts.length,r={decision,at:new Date().toISOString(),beforePages:h.context.pages().length,prompted:false,closed:false},page=h.page;let task;const onClose=()=>{r.closed=true;},onDialog=d=>{task=(async()=>{r.dialogType=d.type();r.prompted=d.type()==='beforeunload';if(!r.prompted){await d.dismiss();throw Error('Unexpected non-beforeunload dialog');}if(decision==='stay')await d.dismiss();else await d.accept();})().catch(e=>{r.error=String(e);});};page.on('close',onClose);page.on('dialog',onDialog);
  try{await page.close({runBeforeUnload:true});await until(()=>r.prompted||r.closed,{timeout,description:'real browser close or beforeunload dialog'});if(task)await task;if(r.error)throw Error(r.error);if(r.prompted&&decision==='leave')await until(()=>page.isClosed(),{timeout,description:'actual page close after accepting beforeunload'});r.closed=page.isClosed();r.afterPages=h.context.pages().length;return r;}
  finally{await new Promise(resolve=>setTimeout(resolve,30));r.nativeEvents=h.nativeReceipts.slice(before).filter(e=>e.type==='beforeunload');page.off('close',onClose);page.off('dialog',onDialog);h.closeReceipts.push(r);}
 };return h;
}
