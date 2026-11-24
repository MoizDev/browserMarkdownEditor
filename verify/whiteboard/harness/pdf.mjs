import { createRequire } from 'node:module';
const req=createRequire(import.meta.url);
// pdf-lib is MIT; imported read-only from the installed application dependencies.
const {PDFDocument,PDFName,PDFArray,PDFDict,PDFRawStream,decodePDFRawStream,degrees,StandardFonts,rgb}=req('pdf-lib');
export async function seedPDF(kind='letter') {
  const doc=await PDFDocument.create();const font=await doc.embedFont(StandardFonts.Helvetica);
  const sizes=kind==='mixed'?Array.from({length:12},(_,i)=>i%3===0?[612,792]:i%3===1?[595.28,841.89]:[792,612]):kind==='a4-landscape'?[[841.89,595.28]]:[[612,792]];
  sizes.forEach((size,i)=>{const page=doc.addPage(size);if(kind==='mixed'&&i===3)page.setRotation(degrees(90));page.drawText(`Original fixture page ${i+1}`,{x:42,y:size[1]-60,size:18,font,color:rgb(.05,.1,.2)});page.drawRectangle({x:42,y:42,width:120,height:60,borderWidth:1,borderColor:rgb(.2,.4,.6)});});
  doc.setProducer('Original parity fixture generator (pdf-lib, MIT)');return Buffer.from(await doc.save());
}
export async function inspectPDF(bytes) {
  const doc=await PDFDocument.load(bytes,{updateMetadata:false});const attachments=[];
  const names=doc.catalog.lookupMaybe(PDFName.of('Names'),PDFDict)?.lookupMaybe(PDFName.of('EmbeddedFiles'),PDFDict);
  const walk=tree=>{
    if(!tree)return;const pairs=tree.lookupMaybe(PDFName.of('Names'),PDFArray);
    if(pairs)for(let i=0;i<pairs.size();i+=2){const name=pairs.get(i).decodeText();const spec=pairs.lookup(i+1,PDFDict);const ef=spec.lookup(PDFName.of('EF'),PDFDict);const stream=ef.lookup(PDFName.of('F'),PDFRawStream);const data=Buffer.from(decodePDFRawStream(stream).decode());attachments.push({name,bytes:data,size:data.length});}
    const kids=tree.lookupMaybe(PDFName.of('Kids'),PDFArray);if(kids)for(let i=0;i<kids.size();i++)walk(kids.lookup(i,PDFDict));
  };walk(names);
  return {producer:doc.getProducer(),pageCount:doc.getPageCount(),pages:doc.getPages().map((p,i)=>({index:i,width:p.getWidth(),height:p.getHeight(),rotate:p.getRotation().angle})),attachments};
}
export { PDFDocument };
