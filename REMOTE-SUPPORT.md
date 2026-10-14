# Remote support

Do not commit passwords, IDs, or Tailscale keys.

## RustDesk

RustDesk is the default. It is free and can use a self-hosted rendezvous server.

```powershell
$env:RUSTDESK_PASSWORD = "choose-a-long-password"
powershell -File scripts\install-remote-support.ps1 -Tool rustdesk
```

The script downloads the official installer, installs silently, and sets the unattended password from the environment. Write the RustDesk ID down in the venue password manager, not in git.

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
