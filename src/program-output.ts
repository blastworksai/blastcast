// CodexBWAI — the guest sees the same scene video the host records, with live call audio.
export function composeProgramOutput(
  scene: Pick<MediaStream, 'getVideoTracks'>,
  audio: Pick<MediaStream, 'getAudioTracks'>,
  create: () => MediaStream = () => new MediaStream(),
): MediaStream {
  const output = create();
  for (const track of scene.getVideoTracks()) output.addTrack(track);
  for (const track of audio.getAudioTracks()) output.addTrack(track);
  return output;
}
