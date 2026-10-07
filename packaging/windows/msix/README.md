# BlastCast MSIX (Microsoft Store) — CP5b task 5b-1

```
node packaging/windows/msix/msix.mjs --payload <staged app dir from package.mjs> --version <x.y.z> --output <new dir> \
  [--identity-name N --publisher "CN=..." --publisher-display-name P] [--arch x64|arm64] [--makeappx <path\to\makeappx.exe>] [--makepri <path\to\makepri.exe>]
```

Writes `<output>/layout/` (payload + `AppxManifest.xml` + generated `msix-assets/` PNGs from `assets/brand/icons/blastcast-256.png`). Includes `targetsize-N`, `_altform-unplated` and `scale-N` variants so the taskbar icon is not a blank plate (no `resources.pri`).
With `--makepri` it first writes `<output>/priconfig.xml` (outside the layout) and `layout/resources.pri`. With `--makeappx` it also runs `makeappx pack /d <layout> /p <output>/BlastCast_<version>.msix /o`; without it only the layout is prepared (tests run on Linux).

- Identity version is `x.y.z.0` (the Store reserves the fourth part).
- Without a real identity (all three flags) the manifest uses `BlastworksAI.BlastCast.Test` / `CN=BlastCast Test` and the display name reads `BlastCast (TEST)`. The real identity comes from Partner Center's name reservation.
- Full-trust desktop app: `EntryPoint="Windows.FullTrustApplication"`, `Executable="BlastCast.exe"`, MinVersion 10.0.17763.0 (Windows 10 1809; `uap10:RuntimeBehavior` needs 2004, so EntryPoint is used).
- Capabilities: `internetClient`, `privateNetworkClientServer`, `rescap:runFullTrust`, device `webcam`, `microphone`. No bundled updater (Store delivers updates).
- Output is unsigned; sideload tests need a test-signed package (5b-2). makeappx is proprietary, build-time only, never shipped (`docs/dependency-license-gate.md`).
- Recording folder: user-chosen, outside the package. Audit of `desktop/`: no writes into the install dir; all writes go to `app.getPath('userData')` (virtualized per package under MSIX — measure in 5b-2); `__dirname` uses are reads only.

Sources (learn.microsoft.com):
- https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-manual-conversion
- https://learn.microsoft.com/en-us/windows/msix/package/create-app-package-with-makeappx-tool
- https://learn.microsoft.com/en-us/windows/uwp/packaging/app-capability-declarations
