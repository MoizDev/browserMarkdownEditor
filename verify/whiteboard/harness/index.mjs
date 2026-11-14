import { launchRuntime, frames, until } from './runtime.mjs';
import { vaultHelpers } from './vault.mjs';
import { installProbe, probeHelpers } from './today/probe.mjs';
import { fieldControls } from './today/controls.mjs';
import { inputHelpers } from './input.mjs';
import { transferHelpers } from './transfer.mjs';
import { screenHelpers } from './pixels.mjs';
import { seedPDF, inspectPDF } from './pdf.mjs';
import { installToolTransport } from './agent.mjs';
import { controlHelpers } from './control.mjs';
import { lifecycleHelpers } from './lifecycle.mjs';
export { buildMutant } from './mutant-build.mjs';
export { frames, until };

export async function launch(options={}) {
  const h=await launchRuntime({...options,afterInstrumentation:[installProbe,...(options.afterInstrumentation||[])]});
  h.referenceOnly=true;
  try {
  // Install interception before the panel can attempt a connection to the user's helper.
  h.agent=await installToolTransport(h.page,{modKey:h.modKey});
  h.vault=vaultHelpers(h);h.probe=probeHelpers(h);h.input=inputHelpers(h);transferHelpers(h);h.screen=screenHelpers(h);h.pdf={seed:seedPDF,inspect:inspectPDF};
  const {page}=h;
  h.ui={
    openFile:async path=>{await page.locator(`.tree-item[data-path=${JSON.stringify(path)}]`).click();if(/\.(tldraw|notebook)$/.test(path))await h.probe.ready(path);},
    switchTab:async path=>{await page.locator(`[role="tab"][data-tooltip=${JSON.stringify(path)}]`).click();},
    closeTab:async path=>{await page.locator(`[role="tab"][data-tooltip=${JSON.stringify(path)}]`).getByRole('button',{name:/^Close /}).click();},
    menu:async label=>page.getByRole('menuitem',{name:label,exact:true}).click(),
    tooltip:async name=>page.locator(`[data-tooltip=${JSON.stringify(name)}]`).click(),
    createDrawing:async(name='Board.tldraw')=>h.ui.createCanvas(name,'New Drawing'),
    createNotebook:async(name='Notes.notebook')=>h.ui.createCanvas(name,'New Notebook'),
    createCanvas:async(name,label)=>{
      await page.locator('[data-tooltip="New drawing or notebook"]').click();
      await page.getByRole('menuitem',{name:label,exact:true}).click();
      // The app's focused inline name box is a plain input; no internal create callback is invoked.
      await page.locator('input:focus').fill(name);
      await page.locator('input:focus').press('Enter');
      await h.probe.ready(name);return name;
    },
    annotate:async path=>{await h.ui.openFile(path);await page.locator('.pdf-viewer-page:visible canvas').first().waitFor({timeout:30000});await h.input.chord('Mod+e');await h.probe.ready(path);return path;},
    split:async(path,{targetPane=0,side='right'}={})=>{
      const source=page.locator(`[role="tab"][data-tooltip=${JSON.stringify(path)}]`);
      const target=page.locator('.editor-slot').nth(targetPane);
      const r=await target.boundingBox();if(!r)throw Error('No split target');
      const dt=await page.evaluateHandle(()=>new DataTransfer());
      await source.dispatchEvent('dragstart',{dataTransfer:dt});
      const x=side==='left'?r.x+r.width*0.15:r.x+r.width*0.85,y=r.y+r.height*0.55;
      await page.mouse.move(x,y);await page.locator('.editor-split-dropzone').waitFor();
      const zone=page.locator('.editor-split-dropzone');await zone.dispatchEvent('dragover',{dataTransfer:dt,clientX:x,clientY:y});await zone.dispatchEvent('drop',{dataTransfer:dt,clientX:x,clientY:y});
      await source.dispatchEvent('dragend',{dataTransfer:dt}).catch(()=>{});await dt.dispose();
      await frames(page);return page.locator('.editor-slot').count();
    },
    reload:async()=>{
      await page.evaluate(()=>{window.__reloadMarker=true;});await page.reload();
      await page.waitForFunction(()=>!window.__reloadMarker);
      await page.locator('.vault-switcher').waitFor();return true;
    },
  };
  lifecycleHelpers(h);h.referenceControls=fieldControls(h);return await controlHelpers(h,options);
  } catch (error) { await h.close(); throw error; }
}
