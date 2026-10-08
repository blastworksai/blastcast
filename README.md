# BlastCast

**Your studio. Your machine. Your recordings.**

BlastCast is a host-owned podcast and video recording studio for conversations
with up to eight people. The host runs the desktop app, guests join from their
browser, and the recording files stay under the host's control.

> **Buy an activation key:** _&lt;where to buy your key&gt;_
>
> Already have a key? Download BlastCast from
> [GitHub Releases](https://github.com/blastworksai/blastcast/releases).

![BlastCast studio with a three-camera scene](docs/images/studio-overview.png)

## A local studio built for real conversations

- Record the composed programme in **1080p or 4K**.
- Bring in as many as **eight participants** through private guest links.
- Keep a mixed episode recording alongside separate participant originals.
- Switch between one-to-eight-camera scenes and dedicated screen-share layouts.
- Let guests share their screen, blur their background, or use a local image;
  background effects run on-device with Google's MediaPipe selfie segmenter.
- Chat live with every admitted guest in a back-channel that never appears in the
  programme feed or the recordings.
- Save recordings to a folder you choose on the host computer.
- Recover guest originals after a temporary connection loss.
- Activate offline with a signed key—no account sign-in is required by the app.

![BlastCast recording a live three-camera scene](docs/images/recording-live.png)

## How it works

1. **Get BlastCast.** Buy an activation key and download the installer.
2. **Activate once.** Open **Settings → Activation**, paste the complete key,
   and choose **Activate BlastCast**.
3. **Set up your studio.** Choose your microphone, camera, recording folder,
   scene, and 1080p or 4K output.
4. **Invite your guests.** Send the generated private link. Guests use their
   browser and do not need a BlastCast key.
5. **Record.** BlastCast saves the composed episode and tracks the status of
   each participant original on your machine.

Activation keys are signed for offline verification. Official builds contain
the public verification key only; the private signing key is not included in
this repository or in the application package.

## Install

BlastCast 0.3.1 is available for Windows, macOS and Linux.

### macOS (Apple Silicon)

Download [BlastCast-0.3.1-macos-arm64.pkg](https://github.com/blastworksai/blastcast/releases/latest/download/BlastCast-0.3.1-macos-arm64.pkg)
and open it. The package is signed with a Developer ID and notarized by Apple,
so it installs without a Gatekeeper warning. On first use, macOS asks for
camera and microphone access.

### Windows (x64)

Download [BlastCast-0.3.1-windows-x64.exe](https://github.com/blastworksai/blastcast/releases/latest/download/BlastCast-0.3.1-windows-x64.exe)
and run it. The Windows installer is not publisher-signed yet, so Windows may
show an unknown-publisher warning. Setup upgrades an installed BlastCast in one
run; your activation, settings and recordings are kept.

### Linux (Debian, Ubuntu and derivatives, amd64)

Install from the signed BlastCast package feed, so `apt` keeps it up to date:

```sh
curl -fsSL https://github.com/blastworksai/blastcast/releases/latest/download/blastcast-archive-keyring.gpg | sudo tee /usr/share/keyrings/blastcast-archive-keyring.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/blastcast-archive-keyring.gpg] https://github.com/blastworksai/blastcast/releases/latest/download/ ./" | sudo tee /etc/apt/sources.list.d/blastcast.list
sudo apt update && sudo apt install blastcast
```

The feed is signed with the Blastworks.ai key, fingerprint
`0228 CC4C A5A0 866D 6EB6  EFDF D503 A8AE 60F9 BD33`; `apt` refuses the
package if the signature does not match. You can also download
[BlastCast-0.3.1-linux-amd64.deb](https://github.com/blastworksai/blastcast/releases/latest/download/BlastCast-0.3.1-linux-amd64.deb)
directly and install it with `sudo apt install ./BlastCast-0.3.1-linux-amd64.deb`.

### Verify a download

Every release carries `SHA256SUMS.txt` and its GPG signature `SHA256SUMS.txt.asc`. In the folder with your download:

```sh
curl -fsSLO https://github.com/blastworksai/blastcast/releases/latest/download/blastcast-archive-keyring.gpg
gpgv --keyring ./blastcast-archive-keyring.gpg SHA256SUMS.txt.asc SHA256SUMS.txt
sha256sum --check --ignore-missing SHA256SUMS.txt
```

## Source and licence

The source is available for inspection and contribution under the
[BlastCast Source-Available Licence 1.0](LICENSE). This is **not** an open-source
licence: it does not grant permission to redistribute BlastCast, publish
competing builds, or bypass activation. Official builds require a valid
activation key.

Please do not include recordings, invitation links, relay credentials,
activation keys, or other private data in public issues or pull requests.

## Project status

BlastCast is under active development. The macOS package is signed and
notarized and the Linux package and checksums are GPG-signed; Windows publisher
signing and additional architectures are still in progress.

---

Built by [BlastworksAI](https://www.blastworks.ai/) — the studio is yours, and so
are the files.
