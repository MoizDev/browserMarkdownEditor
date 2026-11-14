import { runSvgFrame } from './svgFrameRuntime';
import { svgHeaderInIsolatedRealm } from './svgXmlRuntime';

runSvgFrame(async blob => {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer());
    return svgHeaderInIsolatedRealm(text);
});
