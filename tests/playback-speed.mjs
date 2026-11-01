import { readFileSync } from 'node:fs';
/** Native media rate + elapsed playback, not just the stored setting/label. */
export async function checkPlaybackSpeed({evalIso,check,waitFor,WAIT,pageCdp}) {
  console.log('\n  Playback speed across audio resources');
  await pageCdp.send('Page.bringToFront');
  await evalIso(`__sesliOkuTest.stop();SesliOkuSettings.update({...SesliOkuSettings.defaults,autoFollow:false,paragraphDelay:0})`,true);
  await evalIso(`__sesliOkuTest.syntheticAudio(1200);__sesliOkuTest.startBlocks(['#p1','#p2','#p3','#p4','#p5'])`);
  await waitFor('first audio loaded at normal speed',()=>evalIso(`__sesliOkuTest.snapshot().audioState?.readyState>=2`));
  // Change speed while the first resource is playing, just as in the report.
  await evalIso(`SesliOkuSettings.update({playbackRate:1.5})`,true);
  await waitFor('live speed change',()=>evalIso(`__sesliOkuTest.snapshot().audioState?.rate===1.5`));
  const samples=[];
  for(let index=0;index<5;index++){
    await waitFor(`native playback of resource ${index+1}`,()=>evalIso(`(()=>{const s=__sesliOkuTest.snapshot();return s.index===${index}&&s.audioState?.readyState>=2&&!s.audioState.paused;})()`));
    samples.push(await evalIso(`(()=>{const s=__sesliOkuTest.snapshot();return {index:s.index,rate:s.audioState.rate,defaultRate:s.audioState.defaultRate,label:s.speedLabel,setting:s.settings.playbackRate};})()`));
  }
  await waitFor('five-resource reading finishes',()=>evalIso(`!__sesliOkuTest.snapshot().playing`));
  const played=await evalIso(`__sesliOkuTest.snapshot().testPlayed`);
  const intervals=played.slice(2).map((part,index)=>part.at-played[index+1].at);
  check('1.5x stays effective after multiple audio resources',samples.every(s=>s.rate===1.5),JSON.stringify(samples));
  check('the displayed speed matches the native audio speed',samples.every(s=>s.setting===s.rate&&s.label==='1.5×'),JSON.stringify(samples));
  check('later 1.2-second resources actually play faster than normal',intervals.length===3&&intervals.every(ms=>ms<1080),JSON.stringify(intervals));
  console.log(`  Native rates: ${samples.map(sample=>sample.rate).join(', ')}; later resource intervals: ${intervals.map(Math.round).join(', ')} ms`);
  for(const rate of [.5,.75,1.25,1.75,2]){
    await evalIso(`__sesliOkuTest.stop();SesliOkuSettings.update({playbackRate:${rate}})`,true);
    await evalIso(`__sesliOkuTest.syntheticAudio(650);__sesliOkuTest.startBlocks(['#p1','#p2'])`);
    const actual=[];
    for(let index=0;index<2;index++){
      await waitFor(`resource ${index+1} at ${rate}x`,()=>evalIso(`(()=>{const s=__sesliOkuTest.snapshot();return s.index===${index}&&s.audioState?.readyState>=2&&!s.audioState.paused;})()`));
      actual.push(await evalIso(`__sesliOkuTest.snapshot().audioState`));
    }
    await waitFor(`completion at ${rate}x`,()=>evalIso(`!__sesliOkuTest.snapshot().playing`));
    check(`${rate}x applies from the first resource through the next`,actual.every(audio=>audio.rate===rate&&audio.defaultRate===rate),JSON.stringify(actual));
  }
  await evalIso(`__sesliOkuTest.stop();SesliOkuSettings.update({playbackRate:1.25})`,true);
  await evalIso(`__sesliOkuTest.syntheticAudio(3000);__sesliOkuTest.requestDelay(350);__sesliOkuTest.startBlocks(['#p1','#p2'])`);
  await WAIT(100);await evalIso(`SesliOkuSettings.update({playbackRate:1.75})`,true);
  await waitFor('audio prepared after speed changes',()=>evalIso(`__sesliOkuTest.snapshot().audioState?.readyState>=2&&!__sesliOkuTest.snapshot().audioState.paused`));
  check('a speed change during synthesis applies when audio starts',await evalIso(`__sesliOkuTest.snapshot().audioState.rate===1.75&&__sesliOkuTest.snapshot().audioState.defaultRate===1.75`));
  await evalIso(`__sesliOkuTest.pause();SesliOkuSettings.update({playbackRate:.75})`,true);
  await evalIso(`__sesliOkuTest.playback()`);await WAIT(150);
  check('speed changed while paused survives resume',await evalIso(`__sesliOkuTest.snapshot().audioState.rate===.75&&__sesliOkuTest.snapshot().audioState.defaultRate===.75&&!__sesliOkuTest.snapshot().audioState.paused`));
  await evalIso(`__sesliOkuTest.seekTo(3.2)`);
  await waitFor('seek to a fresh audio resource',()=>evalIso(`__sesliOkuTest.snapshot().index===1&&__sesliOkuTest.snapshot().audioState?.readyState>=2`));
  check('seeking to another resource keeps the selected speed',await evalIso(`__sesliOkuTest.snapshot().audioState.rate===.75&&__sesliOkuTest.snapshot().audioState.defaultRate===.75`));
  await evalIso(`__sesliOkuTest.stop();__sesliOkuTest.requestDelay(0);SesliOkuSettings.update({playbackRate:1.5})`,true);
  const mp3=readFileSync(new URL('./fixture.mp3',import.meta.url)).toString('base64');
  await evalIso(`(()=>{__sesliOkuTest.syntheticAudio(1000);const frame=SesliOkuLibrary.stripMp3Tags(Uint8Array.from(atob(${JSON.stringify(mp3)}),c=>c.charCodeAt(0)));const joined=new Uint8Array(frame.length*5);for(let i=0;i<5;i++)joined.set(frame,i*frame.length);let binary='';for(const byte of joined)binary+=String.fromCharCode(byte);__sesliOkuTest.audioData(btoa(binary));__sesliOkuTest.startBlocks(['#p1','#p2','#p3']);})()`);
  const mp3Rates=[];
  for(let index=0;index<3;index++){
    await waitFor(`MP3 resource ${index+1}`,()=>evalIso(`(()=>{const s=__sesliOkuTest.snapshot();return s.index===${index}&&s.audioState?.readyState>=2&&!s.audioState.paused;})()`));
    mp3Rates.push(await evalIso(`__sesliOkuTest.snapshot().audioState.rate`));
  }
  await waitFor('MP3 completion',()=>evalIso(`!__sesliOkuTest.snapshot().playing`));
  check('real MP3 resources also retain 1.5x across multiple paragraphs',mp3Rates.every(rate=>rate===1.5),JSON.stringify(mp3Rates));
  await evalIso(`__sesliOkuTest.stop();SesliOkuSettings.update(SesliOkuSettings.defaults)`,true);
}
