# Testing

Core behavior needs a test. If a test fails, fix the feature or remove it. Do not leave a broken path in the product.

`npm test` is the unit and API suite. `npm run e2e` is the Playwright essential-flows gate: PIN unlock, display settings, rotation, leaderboard edit, theme switch, present, guest photo upload and approve, mock plug toggle, and a video card. Visual snapshots cover the wall and the admin login. The mobile viewport test uses a 390×844 screen.

GitHub Actions runs that suite on Ubuntu for every push and pull request. The Windows job checks the PowerShell installers and launches Electron.

`npm run lint` syntax-checks the project JavaScript.
