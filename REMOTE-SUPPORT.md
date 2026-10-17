# Remote support

Do not commit passwords, IDs, or Tailscale keys.

## RustDesk

RustDesk is the default. On a Beelink that already has Pinball Land, the same one-time command registers automatic updates and installs RustDesk:

```powershell
cd C:\pinball-land
git pull
npm.cmd ci
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\enable-autoupdate.ps1 -RustDeskPassword "choose-a-long-password"
shutdown /r /t 0
```

That downloads the latest GitHub x86_64 build, installs it as a Windows service that starts with Windows, sets the permanent password, and prints the RustDesk ID. Write the ID down in the venue password manager, not in git. The password is not stored in the repo.

To install RustDesk without touching the update tasks:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-remote-support.ps1 -Tool rustdesk -RustDeskPassword "choose-a-long-password"
```

`RUSTDESK_PASSWORD` in the environment still works for that script. Pass `-RustDesk` to `enable-autoupdate.ps1` with no password if you want a hidden prompt instead of the command line.

## AnyDesk

```powershell
$env:ANYDESK_PASSWORD = "choose-a-long-password"
powershell -File scripts\install-remote-support.ps1 -Tool anydesk
```

Install AnyDesk from anydesk.com and turn on Unattended Access with that password.

## Tailscale

```powershell
powershell -File scripts\install-remote-support.ps1 -Tool tailscale
```

After `tailscale up`, the admin app is `https://<tailscale-ip>:3443/admin`. SSH and RDP can stay on the tailnet. The kiosk treats Tailscale’s 100.64.0.0/10 addresses as local.
