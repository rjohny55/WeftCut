// Local, fixed document: no user HTML, network, filesystem or editor controls.
export const GPU_EXPORT_HOST = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><style>html,body{margin:0;overflow:hidden;background:#000}canvas{display:block}</style></head><body><canvas></canvas><script>
const canvas=document.querySelector('canvas');let context;
async function paint(bitmap,width,height){
 if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;context=null;}
 context??=canvas.getContext('2d',{alpha:false});context.drawImage(bitmap,0,0);bitmap.close();
 await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
}
window.__gpuProbe=async function(index,width,height){
 const test=document.createElement('canvas');test.width=width;test.height=height;
 const c=test.getContext('2d');const gradient=c.createLinearGradient(0,0,width,height);
 gradient.addColorStop(0,['#802010','#108040','#204080'][index]);gradient.addColorStop(1,'#282828');c.fillStyle=gradient;c.fillRect(0,0,width,height);
 c.fillStyle=['#ff3030','#30ff30','#3030ff'][index];c.fillRect(width*.1,height*.2,width*.3,height*.4);
 c.fillStyle='#fff';c.font=Math.max(24,Math.floor(height*.08))+'px sans-serif';c.fillText('GPU '+index+' · Aa 123',width*.08,height*.85);
 await paint(await createImageBitmap(test),width,height);
};
window.addEventListener('message',event=>{
 if(event.source!==window||event.data?.type!=='gpu-export-port'||event.ports.length!==1)return;
 const token=event.data.token,port=event.ports[0];port.onmessage=async event=>{
  const data=event.data;if(data?.type!=='gpu-final-frame'||data.token!==token)return;
  try{const size=await window.gpuFrame.prepare(data.index);await paint(data.bitmap,size.width,size.height);await window.gpuFrame.consume(data.index);port.postMessage({type:'gpu-frame-ack',token,index:data.index});}
  catch(error){data.bitmap?.close();port.postMessage({type:'gpu-frame-ack',token,index:data.index,error:String(error)});}
 };port.start();
});
</script></body></html>`;
