import { frames, until } from './runtime.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export function inputHelpers(h) {
  const {page,cdp}=h;
  const modifiers=keys=>(keys.includes('Alt')?1:0)|(keys.includes('Control')?2:0)|(keys.includes('Meta')?4:0)|(keys.includes('Shift')?8:0);
  async function pointer(type,p,{kind='pen',button='left',buttons=1,keys=[]}={}) {
    await cdp.send('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,pointerType:kind,button,buttons,force:p.pressure??0.5,tiltX:p.tiltX??0,tiltY:p.tiltY??0,twist:p.twist??0,modifiers:modifiers(keys),clickCount:type==='mouseMoved'?0:1});
  }
  async function touch(type,points,keys=[]) {
    await cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map((p,i)=>({id:p.id??i,x:p.x,y:p.y,force:p.pressure??0.5,radiusX:p.radiusX??1,radiusY:p.radiusY??1,rotationAngle:p.rotation??0})),modifiers:modifiers(keys)});
  }
  return {
    settleModifiers:async(n=14,{minimumMs=250,path,point,release=['alt','shift']}={})=>{
      // Headless frame cadence is not a wall clock. Fourteen frames still left Alt active
      // in the FIG sweep. If a shortcut swallowed key-up, a real neutral hover starts the
      // release grace; time alone cannot. Opt in with point rather than silently moving input.
      if(point)await pointer('mouseMoved',point,{kind:'mouse',button:'none',buttons:0,keys:[]});
      await Promise.all([frames(page,n),pause(minimumMs)]);
      if(path)await until(async()=>{const s=await h.probe.session(path);return release.every(key=>!s.input.modifiers[key]);},{timeout:2000,description:`released modifier state for ${path}`});
    },
    chord:chord=>page.keyboard.press(chord.replaceAll('Mod',h.modKey)),
    text:text=>page.keyboard.insertText(text),
    type:(text,options)=>page.keyboard.type(text,options),
    ime:async(text,{selectionStart=text.length,selectionEnd=selectionStart,commit=true}={})=>{
      await cdp.send('Input.imeSetComposition',{text,selectionStart,selectionEnd});
      if(commit)await cdp.send('Input.insertText',{text});
    },
    pointer,touch,
    stroke:async(points,{kind='mouse',button='left',buttons=1,keys=[],delay=0,settleFrames=2}={})=>{
      if(points.length<2)throw Error('A stroke requires at least two points');
      if(kind==='touch'){
        await touch('touchStart',[points[0]],keys);
        for(const p of points.slice(1)){if(p.dt??delay)await pause(p.dt??delay);await touch('touchMove',[p],keys);}
        await touch('touchEnd',[],keys);
      }else{
        await pointer('mouseMoved',points[0],{kind,button:'none',buttons:0,keys});
        await pointer('mousePressed',points[0],{kind,button,buttons,keys});
        for(const p of points.slice(1)){if(p.dt??delay)await pause(p.dt??delay);await pointer('mouseMoved',p,{kind,button:'none',buttons,keys});}
        await pointer('mouseReleased',{...points.at(-1),pressure:0},{kind,button,buttons:0,keys});
      }
      if(settleFrames)await frames(page,settleFrames);
    },
    tap:async(p,{kind='touch'}={})=>{if(kind==='touch'){await touch('touchStart',[p]);await touch('touchEnd',[]);}else{await pointer('mousePressed',p,{kind});await pointer('mouseReleased',{...p,pressure:0},{kind,buttons:0});}},
    pinch:async(center,{from=60,to=120,steps=12,panX=0,panY=0}={})=>{
      const pts=(r,x,y)=>[{id:1,x:x-r/2,y},{id:2,x:x+r/2,y}];
      await touch('touchStart',pts(from,center.x,center.y));
      for(let i=1;i<=steps;i++){const t=i/steps;await touch('touchMove',pts(from+(to-from)*t,center.x+panX*t,center.y+panY*t));await pause(16);}
      await touch('touchEnd',[]);await frames(page);
    },
    twoFingerPan:async(center,{dx=0,dy=100,distance=80,steps=12}={})=>h.input.pinch(center,{from:distance,to:distance,panX:dx,panY:dy,steps}),
    wheel:async({x,y,deltaX=0,deltaY=0,ctrl=false,keys=[]})=>{await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x,y,deltaX,deltaY,modifiers:modifiers(ctrl?[...keys,'Control']:keys)});await frames(page);},
    events:()=>page.evaluate(()=>window.__harness.input),
    clearEvents:()=>page.evaluate(()=>{window.__harness.input=[];}),
  };
}
