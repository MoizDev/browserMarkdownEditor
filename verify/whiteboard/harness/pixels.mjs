import { inflateSync } from 'node:zlib';
import fs from 'node:fs/promises';
// Small original PNG reader for Chromium screenshots: non-interlaced, 8-bit RGB/RGBA.
export function decodePNG(buffer) {
  buffer=Buffer.from(buffer);if(buffer.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Not PNG');
  let width,height,channels,depth,interlace;const chunks=[];
  for(let o=8;o<buffer.length;){const n=buffer.readUInt32BE(o),type=buffer.toString('ascii',o+4,o+8),data=buffer.subarray(o+8,o+8+n);if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);depth=data[8];channels=data[9]===6?4:data[9]===2?3:null;interlace=data[12];}if(type==='IDAT')chunks.push(data);o+=n+12;}
  if(depth!==8||!channels||interlace)throw Error('Expected non-interlaced 8-bit RGB/RGBA PNG');
  const raw=inflateSync(Buffer.concat(chunks)),stride=width*channels,pixels=Buffer.alloc(height*stride);let o=0;
  const paeth=(a,b,c)=>{const p=a+b-c,da=Math.abs(p-a),db=Math.abs(p-b),dc=Math.abs(p-c);return da<=db&&da<=dc?a:db<=dc?b:c;};
  for(let y=0;y<height;y++){const f=raw[o++];for(let x=0;x<stride;x++){const a=x>=channels?pixels[y*stride+x-channels]:0,b=y?pixels[(y-1)*stride+x]:0,c=y&&x>=channels?pixels[(y-1)*stride+x-channels]:0;pixels[y*stride+x]=(raw[o++]+(f===0?0:f===1?a:f===2?b:f===3?Math.floor((a+b)/2):f===4?paeth(a,b,c):(()=>{throw Error('Bad PNG filter')})()))&255;}}
  return {width,height,channels,pixels};
}
export function colour(image,x,y){x=Math.floor(x);y=Math.floor(y);if(x<0||x>=image.width||y<0||y>=image.height)throw Error('Pixel outside image');const i=(y*image.width+x)*image.channels;return [...image.pixels.subarray(i,i+3),image.channels===4?image.pixels[i+3]:255];}
export function inkBounds(image,{background=[255,255,255],tolerance=20,region={x:0,y:0,width:image.width,height:image.height}}={}) {
  let x0=Infinity,y0=Infinity,x1=-1,y1=-1,count=0;
  for(let y=Math.max(0,Math.floor(region.y));y<Math.min(image.height,region.y+region.height);y++)for(let x=Math.max(0,Math.floor(region.x));x<Math.min(image.width,region.x+region.width);x++){const c=colour(image,x,y);if(c.slice(0,3).some((v,i)=>Math.abs(v-background[i])>tolerance)){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);count++;}}
  return count?{x:x0,y:y0,width:x1-x0+1,height:y1-y0+1,count}:null;
}
export function diffPNG(a,b,{channelTolerance=0,maxDifferentFraction=0}={}) {
  if(a.width!==b.width||a.height!==b.height)return {pass:false,reason:'dimensions',a:[a.width,a.height],b:[b.width,b.height]};
  let different=0,maxError=0;for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++){const aa=colour(a,x,y),bb=colour(b,x,y),error=Math.max(...aa.map((v,i)=>Math.abs(v-bb[i])));maxError=Math.max(error,maxError);if(error>channelTolerance)different++;}
  const fraction=different/(a.width*a.height);return {pass:fraction<=maxDifferentFraction,different,fraction,maxError};
}
export function screenHelpers(h) {
  return {
    capture:async({path,region,world,pathOfBoard,scale='css'}={})=>{
      let clip=region;
      if(world){const a=await h.probe.worldToCSS(pathOfBoard,world),b=await h.probe.worldToCSS(pathOfBoard,{x:world.x+world.width,y:world.y+world.height});clip={x:a.x,y:a.y,width:b.x-a.x,height:b.y-a.y};}
      return h.page.screenshot({...(path?{path}:{}),...(clip?{clip}:{}),scale});
    },
    pixel:async(x,y)=>colour(decodePNG(await h.page.screenshot({scale:'css'})),x,y),
    inkBounds:async(options={})=>inkBounds(decodePNG(await h.page.screenshot({scale:'css'})),options),
    diff:async(a,b,options)=>diffPNG(decodePNG(typeof a==='string'?await fs.readFile(a):a),decodePNG(typeof b==='string'?await fs.readFile(b):b),options),
  };
}
