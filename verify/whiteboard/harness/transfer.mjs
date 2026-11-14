export function transferHelpers(h) {
  const {page}=h;
  const serial=items=>Object.fromEntries(Object.entries(items).map(([type,value])=>[type,typeof value==='string'?{text:value}:{bytes:Array.from(value)}]));
  h.clipboard={
    write:async(items)=>page.evaluate(async items=>{
      const data={};for(const [type,value]of Object.entries(items))data[type]=new Blob([value.bytes?new Uint8Array(value.bytes):value.text],{type:type.replace(/^web /,'')});
      await navigator.clipboard.write([new ClipboardItem(data)]);return Object.keys(data);
    },serial(items)),
    read:()=>page.evaluate(async()=>{
      const result=[];for(const item of await navigator.clipboard.read())for(const type of item.types){const blob=await item.getType(type);result.push({type,bytes:Array.from(new Uint8Array(await blob.arrayBuffer())),text:/^(text\/|web )/.test(type)?await blob.text():null});}return result;
    }),
    paste:async({route='native',items,point}={})=>{
      if(point)await page.mouse.click(point.x,point.y);
      if(route==='native'){if(items)await h.clipboard.write(items);const before=h.nativeReceipts.length;await h.input.chord('Mod+v');await new Promise(resolve=>setTimeout(resolve,50));const receipts=h.nativeReceipts.slice(before).filter(e=>e.type==='paste');return {route:'native',receipts,trusted:receipts.some(e=>e.trusted),syntheticAlso:receipts.some(e=>!e.trusted)};}
      if(!items)throw Error('Synthetic paste requires explicit items');
      return page.evaluate(({items,point})=>{
        const dt=new DataTransfer();for(const [type,v]of Object.entries(items)){if(v.text!==undefined)dt.setData(type,v.text);else dt.items.add(new File([new Uint8Array(v.bytes)],type==='image/png'?'paste.png':'paste.bin',{type}));}
        const target=point?document.elementFromPoint(point.x,point.y):document.activeElement;const e=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt});target.dispatchEvent(e);return {route:'synthetic',trusted:e.isTrusted,prevented:e.defaultPrevented,types:[...dt.types]};
      },{items:serial(items),point});
    },
  };
  h.drop=async(point,{files=[],items={}}={})=>page.evaluate(({point,files,items})=>{
    const dt=new DataTransfer();for(const f of files)dt.items.add(new File([new Uint8Array(f.bytes)],f.name,{type:f.type}));for(const [type,text]of Object.entries(items))dt.setData(type,text);
    const target=document.elementFromPoint(point.x,point.y);if(!target)throw Error('Drop point outside page');const events=[];
    for(const type of ['dragenter','dragover','drop']){const e=new DragEvent(type,{dataTransfer:dt,clientX:point.x,clientY:point.y,bubbles:true,cancelable:true});target.dispatchEvent(e);events.push({type,prevented:e.defaultPrevented,trusted:e.isTrusted});}
    return {route:'synthetic-DataTransfer',types:[...dt.types],events};
  },{point,files:files.map(f=>({...f,bytes:Array.from(f.bytes)})),items});
  h.dropNative=async(point,{files=[],items={},operationsMask=1}={})=>{
    if(files.some(p=>!(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(p))))throw Error('Native CDP drag files must be absolute fixture paths');
    const before=h.nativeReceipts.length,data={items:Object.entries(items).map(([mimeType,data])=>({mimeType,data})),files,dragOperationsMask:operationsMask};
    for(const type of ['dragEnter','dragOver','drop'])await h.cdp.send('Input.dispatchDragEvent',{type,x:point.x,y:point.y,data});
    // Node-side journal survives a default navigation/close that destroys the original page.
    await new Promise(resolve=>setTimeout(resolve,50));const sequenceReceipts=h.nativeReceipts.slice(before).filter(e=>['dragenter','dragover','drop'].includes(e.type)),receipts=sequenceReceipts.filter(e=>e.type==='drop');
    return {route:'CDP-native-drag',receipts,sequenceReceipts,trusted:receipts.some(e=>e.trusted),browserDragTrusted:sequenceReceipts.some(e=>e.trusted),syntheticAlso:receipts.some(e=>!e.trusted)};
  };
  return h;
}
