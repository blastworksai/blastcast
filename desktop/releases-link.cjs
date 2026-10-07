// ClaudeBWAI — einh 5 Oct: the GitHub releases link lives here alone so the Mac App Store bundle can leave this file out (updates come through the store).
const releasesUrl = 'https://github.com/blastworksai/blastcast/releases';
async function openReleases(shell) {
  try { await shell.openExternal(releasesUrl); return { ok: true }; }
  catch { return { ok: false, message: 'GitHub releases could not open. Visit github.com/blastworksai/blastcast/releases in your browser.' }; }
}
module.exports = { releasesUrl, openReleases };
