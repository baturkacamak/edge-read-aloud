# Playback speed regression

Reproduced in headless Microsoft Edge using the actual HTML audio pipeline,
without a synthesis request:

1. Play five 1.2-second audio resources at normal speed.
2. Change playback speed to 1.5 while the first resource is playing.
3. Inspect each new element's native `playbackRate`, the stored preference and
   the panel label, and measure the time between resource starts.

Before the fix, observed native rates were `[1.5, 1, 1, 1, 1]`; the label and
stored setting stayed at 1.5 throughout. Later resources took about 1280 ms
between starts. Every element still had `defaultPlaybackRate === 1`.

The player set `playbackRate` before assigning `src`. Resource loading restores
that property from `defaultPlaybackRate`, so the temporary rate was lost. The
fix applies both values together when creating audio and on live preference
changes, and reapplies the latest preference when metadata arrives. Source
loading therefore preserves the selected default, including changes made while
synthesis/loading is pending. The browser behavior is described in the
[HTML media specification](https://html.spec.whatwg.org/multipage/media.html)
and [MDN's playback-rate guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Audio_and_video_delivery/WebAudio_playbackRate_explained).

After the fix, all five native rates were 1.5 and later resource intervals were
about 895 ms (including browser/startup overhead). The tests assert both the
native speed and elapsed time, so a correct-looking label alone cannot pass.

`SPEED_ONLY=1 npm test` covers this reproduction, 0.5/0.75/1.25/1.75/2x playback,
a change while synthesis is pending, pause/resume, seeking to another resource,
and repeated real MP3 resource loads. It also runs as part of `npm test`.
