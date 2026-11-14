// Original mock transport by wb-enum-paged, packaged by wb-harness.
// No model/helper runs. Browser tools still use the app's real validation/host/save path.
export async function installToolTransport(page,{modKey}={}) {
  modKey??=await page.evaluate(()=>/Mac|iPhone|iPad/.test(navigator.platform)?'Meta':'Control');
  let socket=null,run=null,next=1,resolveStart;
  const started=new Promise(resolve=>{resolveStart=resolve;});const waiters=new Map(),messages=[];
  await page.route(/^http:\/\/(?:127\.0\.0\.1|localhost):4782[3-7]\//,route=>{
    if(new URL(route.request().url()).pathname==='/health')return route.fulfill({json:{app:'vaultagent',version:'0.1.2',protocol:1,platform:'macos'},headers:{'access-control-allow-origin':'*'}});
    return route.abort();
  });
  await page.routeWebSocket(/^ws:\/\/(?:127\.0\.0\.1|localhost):4782[3-7]\/ws$/,ws=>{
    socket=ws;
    ws.onMessage(data=>{
      const m=JSON.parse(String(data));messages.push(m);
      if(m.type==='tool.result'){const w=waiters.get(m.callId);if(w){waiters.delete(m.callId);clearTimeout(w.timer);w.resolve(m.result);}return;}
      const reply=result=>ws.send(JSON.stringify({type:'response',reqId:m.reqId,ok:true,result}));
      switch(m.type){
        case 'hello':reply({version:'0.1.2',protocol:1,platform:'macos',sessionsDir:'/fixture-only'});break;
        case 'agents.status':reply(['claude','codex','opencode'].map(agent=>({agent,installed:true,version:'fixture-transport',loggedIn:true,loginCommand:'',installCommand:''})));break;
        case 'models.list':reply([{id:'fixture',label:'Fixture transport',efforts:[],defaultEffort:null,images:true,isDefault:true}]);break;
        case 'vault.sync':reply({written:m.files.length,removed:0});break;
        case 'run.start':run=m;reply({accepted:true});resolveStart(m);break;
        case 'run.cancel':reply({cancelled:true});ws.send(JSON.stringify({type:'run.done',runId:m.runId,sessionId:null,status:'cancelled'}));break;
        case 'session.history':reply({found:false,items:[]});break;
        case 'session.delete':reply({deleted:true});break;
        default:ws.send(JSON.stringify({type:'response',reqId:m.reqId,ok:false,error:{code:'unsupported',message:'Not provided by the parity transport'}}));
      }
    });
  });
  return {
    messages,
    async start(prompt='Parity transport: wait for fixture operations'){
      await page.keyboard.press(modKey+'+Shift+x');
      await page.getByRole('button',{name:'Connect',exact:true}).click();
      const field=page.getByRole('textbox',{name:'Message the agent',exact:true});await field.fill(prompt);await page.getByRole('button',{name:'Send',exact:true}).click();
      let timer;try{return await Promise.race([started,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Agent transport run.start timeout')),30000);})]);}finally{clearTimeout(timer);}
    },
    async call(name,args){
      if(!socket||!run)throw Error('Transport has no active run; call start first');const callId='fixture-'+next++;
      const result=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiters.delete(callId);reject(Error('Tool did not answer: '+name));},30000);waiters.set(callId,{resolve,timer});});
      socket.send(JSON.stringify({type:'tool.call',runId:run.runId,callId,name,args}));return result;
    },
    finish(){if(run&&socket)socket.send(JSON.stringify({type:'run.done',runId:run.runId,sessionId:null,status:'ok'}));},
    getRun:()=>run,
  };
}
